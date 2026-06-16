import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantMessageEvent, Usage } from '@earendil-works/pi-ai';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { ResultMessage } from '../../shared/types/session';
import type { ContentBlock } from '../../shared/types/content';
import type { ModelInfo, AccountInfo } from '../../shared/types/settings';
import { TOOL_READ, TOOL_GREP, TOOL_GLOB, TOOL_LS } from '../../shared/tool-names';
import { log } from '../logger';
import { mapPiToolName } from './pi-models';

export interface PiStreamAdapterDeps {
  onMessage: (m: ExtensionToWebviewMessage) => void;
  cwd: string;
  sessionId: () => string;
  modelValue: () => string;
  contextWindow: () => number;
  supportedModels: () => ModelInfo[];
  accountInfo: () => AccountInfo;
  permissionMode: () => string;
  apiKeySource: () => string;
  onAssistantTextFinal?: (text: string) => void;
}

interface ToolRecord {
  startedAt: number;
  streamed: boolean;
}

/** Detect auth-shaped error text so the webview can show the renewal banner rather than a raw error. */
function isAuthError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('401') || m.includes('unauthorized') || m.includes('authentication') || m.includes('invalid api key') || m.includes('oauth');
}

/** pi `read` uses `path`; Damocles `Read` uses `file_path`. pi `grep` uses `ignoreCase`; Damocles `Grep` uses `-i`. */
function normalizeToolInput(piName: string, args: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { ...args };
  if (piName === 'read' && 'path' in input) {
    input['file_path'] = input['path'];
    delete input['path'];
  }
  if (piName === 'grep' && 'ignoreCase' in input) {
    input['-i'] = input['ignoreCase'];
    delete input['ignoreCase'];
  }
  return input;
}

/** Join the text blocks of a pi tool result into the single string the webview tool card renders. */
function joinResultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');
}

/**
 * Translates a pi `AgentSession` event stream into the exact existing `ExtensionToWebviewMessage`
 * sequence the webview already renders (the SDK path's producer is swapped, not the contract). One
 * adapter instance serves a PiSession across session replacements: `subscribe(session)` is re-called
 * on rebind; per-turn state is reset in `beginTurn`.
 */
export class PiStreamAdapter {
  private _initEmitted = false;
  private _turnSeq = 0;
  private _assistantSeq = 0;
  private _aborted = false;
  private _currentAssistantId: string | null = null;
  private _streamingText = '';
  private _streamingThinking = '';
  private _thinkingStart: number | null = null;
  private _thinkingDuration: number | null = null;
  private _lastCumulativeCost = 0;
  private _accumulatedCost = 0;
  private readonly _tools = new Map<string, ToolRecord>();

  private readonly deps: PiStreamAdapterDeps;

  constructor(deps: PiStreamAdapterDeps) {
    this.deps = deps;
  }

  /** Total per-turn cost summed across the session (host-side reader for `getAccumulatedCost`). */
  get accumulatedCost(): number {
    return this._accumulatedCost;
  }

  /** Subscribe the adapter to a pi session; returns the unsubscribe function. */
  subscribe(session: AgentSession): () => void {
    return session.subscribe((event) => this.handle(session, event));
  }

  /**
   * Mark the start of a user turn: reset streaming state, arm processing/running, emit the
   * once-per-session init payloads, and correlate the user message.
   */
  beginTurn(correlationId?: string): void {
    this._turnSeq += 1;
    this._assistantSeq = 0;
    this._aborted = false;
    this._streamingText = '';
    this._streamingThinking = '';
    this._thinkingStart = null;
    this._thinkingDuration = null;
    this._tools.clear();
    const sid = this.deps.sessionId();
    this._currentAssistantId = `${sid}:a:${this._turnSeq}:0`;

    this.emit({ type: 'processing', isProcessing: true });
    this.emit({ type: 'sessionStateChanged', state: 'running', sessionId: sid });
    this.emitSessionStartOnce();

    if (correlationId) {
      this.emit({ type: 'userMessageIdAssigned', sdkMessageId: `${sid}:u:${this._turnSeq}`, correlationId });
    }
  }

  /** A `sendMessage` arriving while a turn is active (mirrors the SDK in-flight guard). */
  emitAlreadyInProgress(): void {
    this.emit({ type: 'error', message: 'A request is already in progress' });
  }

  /**
   * Mark the in-flight turn as user-aborted. The host emits `sessionCancelled` itself; this flag tells
   * `onAgentEnd` to skip the `done`/`stopInfo` it would otherwise emit when pi's aborted run finishes,
   * so the webview never sees a "completed" result stacked on top of a cancelled turn.
   */
  markAborted(): void {
    this._aborted = true;
  }

  private emit(m: ExtensionToWebviewMessage): void {
    this.deps.onMessage(m);
  }

  /** Begin a new assistant message: assign its own webview id and reset per-message streaming buffers. */
  private startAssistantMessage(): void {
    this._assistantSeq += 1;
    this._currentAssistantId = `${this.deps.sessionId()}:a:${this._turnSeq}:${this._assistantSeq}`;
    this._streamingText = '';
    this._streamingThinking = '';
    this._thinkingStart = null;
    this._thinkingDuration = null;
  }

  private emitSessionStartOnce(): void {
    if (this._initEmitted) return;
    this._initEmitted = true;
    const model = this.deps.modelValue();
    this.emit({
      type: 'systemInit',
      data: {
        model,
        tools: [TOOL_READ, TOOL_GREP, TOOL_GLOB, TOOL_LS],
        mcpServers: [],
        plugins: [],
        permissionMode: this.deps.permissionMode(),
        slashCommands: [],
        apiKeySource: this.deps.apiKeySource(),
        cwd: this.deps.cwd,
      },
    });
    this.emit({ type: 'accountInfo', data: this.deps.accountInfo() });
    const models = this.deps.supportedModels();
    this.emit({ type: 'availableModels', models });
    this.emit({ type: 'modelUpdate', activeModel: model, defaultModel: model, contextWindowSize: this.deps.contextWindow() });
  }

  private handle(session: AgentSession, event: AgentSessionEvent): void {
    switch (event.type) {
      case 'message_start':
        // Each assistant message in a turn (e.g. tool-call message, then the answer message after the
        // tool result) gets its own webview message id and fresh streaming buffers.
        if (event.message.role === 'assistant') this.startAssistantMessage();
        break;
      case 'message_update':
        this.handleAssistantEvent(event.assistantMessageEvent);
        break;
      case 'message_end':
        if (event.message.role === 'assistant') {
          this.emitAssistantMessage(event.message.content);
          this.emitUsage(event.message.usage);
        }
        break;
      case 'tool_execution_start':
        this.ensureToolStreaming(event.toolCallId, event.toolName, (event.args ?? {}) as Record<string, unknown>);
        this._tools.set(event.toolCallId, { startedAt: Date.now(), streamed: true });
        break;
      case 'tool_execution_update':
        this.emit({
          type: 'toolProgress',
          toolUseId: event.toolCallId,
          toolName: mapPiToolName(event.toolName),
          parentToolUseId: null,
          elapsedTimeSeconds: this.elapsed(event.toolCallId),
        });
        break;
      case 'tool_execution_end':
        this.onToolEnd(event.toolCallId, event.toolName, event.result, event.isError);
        break;
      case 'agent_end':
        if (!event.willRetry) this.onAgentEnd(session);
        break;
      case 'compaction_start':
        log('[PiStreamAdapter] compaction_start fired (reason=%s) — B3 invariant violated', event.reason);
        break;
      default:
        break;
    }
  }

  private handleAssistantEvent(ame: AssistantMessageEvent): void {
    switch (ame.type) {
      case 'text_delta':
        this._streamingText += ame.delta;
        this.emitPartial({ streamingText: this._streamingText, isThinking: false });
        break;
      case 'thinking_start':
        if (this._thinkingStart === null) this._thinkingStart = Date.now();
        break;
      case 'thinking_delta':
        if (this._thinkingStart === null) this._thinkingStart = Date.now();
        this._streamingThinking += ame.delta;
        this.emitPartial({ streamingThinking: this._streamingThinking, isThinking: true });
        break;
      case 'thinking_end':
        // Seconds, matching the SDK path (the webview renders `thinkingDuration` as seconds).
        if (this._thinkingStart !== null) this._thinkingDuration = Math.round((Date.now() - this._thinkingStart) / 1000);
        this.emitPartial({
          streamingThinking: this._streamingThinking,
          isThinking: false,
          ...(this._thinkingDuration !== null ? { thinkingDuration: this._thinkingDuration } : {}),
        });
        break;
      case 'toolcall_end':
        this.ensureToolStreaming(ame.toolCall.id, ame.toolCall.name, ame.toolCall.arguments);
        break;
      case 'error':
        this.onAssistantError(ame.reason, ame.error.errorMessage ?? 'Unknown error');
        break;
      default:
        break;
    }
  }

  private emitPartial(extra: { streamingText?: string; streamingThinking?: string; isThinking?: boolean; thinkingDuration?: number }): void {
    this.emit({
      type: 'partial',
      data: {
        type: 'partial',
        content: [],
        session_id: this.deps.sessionId(),
        messageId: this._currentAssistantId,
        ...extra,
      },
    });
  }

  private ensureToolStreaming(toolCallId: string, piName: string, args: Record<string, unknown>): void {
    const existing = this._tools.get(toolCallId);
    if (existing?.streamed) return;
    this._tools.set(toolCallId, { startedAt: existing?.startedAt ?? Date.now(), streamed: true });
    this.emit({
      type: 'toolStreaming',
      messageId: this._currentAssistantId ?? '',
      tool: { id: toolCallId, name: mapPiToolName(piName), input: normalizeToolInput(piName, args) },
      contentBlocks: [],
    });
  }

  private onToolEnd(toolCallId: string, piName: string, result: unknown, isError: boolean): void {
    const durationMs = this.elapsed(toolCallId) * 1000;
    const toolName = mapPiToolName(piName);
    if (isError) {
      this.emit({ type: 'toolFailed', toolUseId: toolCallId, toolName, error: joinResultText(result) || 'Tool failed', durationMs });
      return;
    }
    this.emit({ type: 'toolCompleted', toolUseId: toolCallId, toolName, result: joinResultText(result), durationMs });
    const details = (result as { details?: unknown } | undefined)?.details;
    if (details && typeof details === 'object') {
      this.emit({ type: 'toolMetadata', toolUseId: toolCallId, metadata: details as Record<string, unknown> });
    }
  }

  /**
   * Emit the authoritative final `assistant` message (text + thinking + tool_use blocks), exactly as
   * the SDK path does. This routes the completed turn through the webview's primary
   * `contentBlocks`/`flattenContentBlocks` render path instead of the partial-only fallback — which
   * is why a streamed answer (notably from thinking-heavy models) now renders its text reliably. The
   * webview filters thinking out of `contentBlocks` and reads it via the streamed `thinking` buffer.
   */
  private emitAssistantMessage(
    content: ReadonlyArray<{ type: string; text?: string; thinking?: string; thinkingSignature?: string; id?: string; name?: string; arguments?: Record<string, unknown> }> | undefined,
  ): void {
    if (!content) return;
    const blocks: ContentBlock[] = [];
    for (const c of content) {
      if (c.type === 'text' && c.text) {
        blocks.push({ type: 'text', text: c.text });
      } else if (c.type === 'thinking') {
        blocks.push({ type: 'thinking', thinking: c.thinking ?? '', ...(c.thinkingSignature ? { signature: c.thinkingSignature } : {}) });
      } else if (c.type === 'toolCall' && c.id && c.name) {
        blocks.push({ type: 'tool_use', id: c.id, name: mapPiToolName(c.name), input: normalizeToolInput(c.name, c.arguments ?? {}) });
      }
    }
    if (blocks.length === 0) return;
    this.emit({
      type: 'assistant',
      data: {
        type: 'assistant',
        message: {
          id: this._currentAssistantId ?? `${this.deps.sessionId()}:a:${this._turnSeq}`,
          role: 'assistant',
          content: blocks,
          model: this.deps.modelValue(),
          stop_reason: null,
        },
        session_id: this.deps.sessionId(),
      },
    });
  }

  private emitUsage(usage: Usage): void {
    // pi's Usage is per-message; emitting per-message `outputTokens` here would snap the webview's
    // running total to the last message of a multi-message turn. Output tokens are reported once,
    // cumulatively, via onAgentEnd's `done` result — matching the SDK path, which omits them here too.
    this.emit({
      type: 'tokenUsageUpdate',
      inputTokens: usage.input,
      cacheReadTokens: usage.cacheRead,
      cacheCreationTokens: usage.cacheWrite,
    });
  }

  private onAgentEnd(session: AgentSession): void {
    // Keep cost accounting accurate even for an aborted turn, but stop before the user-facing
    // completion signals — a user abort already emitted sessionCancelled + idle.
    const stats = session.getSessionStats();
    const turnCost = Math.max(0, stats.cost - this._lastCumulativeCost);
    this._lastCumulativeCost = stats.cost;
    this._accumulatedCost += turnCost;
    if (this._aborted) return;

    const finalText = session.getLastAssistantText();
    this.deps.onAssistantTextFinal?.(finalText ?? '');

    const sid = this.deps.sessionId();
    const result: ResultMessage = {
      type: 'result',
      session_id: sid,
      is_done: true,
      total_cost_usd: turnCost,
      total_output_tokens: stats.tokens.output,
      num_turns: 1,
      stop_reason: null,
    };
    this.emit({ type: 'done', data: result });
    this.emit({ type: 'processing', isProcessing: false });
    this.emit({ type: 'sessionStateChanged', state: 'idle', sessionId: sid });
    this.emit({ type: 'stopInfo', ...(finalText ? { lastAssistantMessage: finalText } : {}) });
  }

  private onAssistantError(reason: 'aborted' | 'error', message: string): void {
    if (reason === 'aborted') {
      this._aborted = true;
      this.emit({ type: 'sessionCancelled' });
    } else if (isAuthError(message)) {
      this.emit({ type: 'authFailure', message });
    } else {
      this.emit({ type: 'error', message });
    }
    this.emit({ type: 'processing', isProcessing: false });
    this.emit({ type: 'sessionStateChanged', state: 'idle', sessionId: this.deps.sessionId() });
  }

  private elapsed(toolCallId: string): number {
    const rec = this._tools.get(toolCallId);
    if (!rec) return 0;
    return Math.max(0, (Date.now() - rec.startedAt) / 1000);
  }
}
