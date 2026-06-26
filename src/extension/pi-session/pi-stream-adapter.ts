import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantMessageEvent, Usage } from '@earendil-works/pi-ai';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { ResultMessage } from '../../shared/types/session';
import type { ContentBlock } from '../../shared/types/content';
import type { ModelInfo, AccountInfo } from '../../shared/types/settings';
import { TOOL_READ, TOOL_GREP, TOOL_GLOB, TOOL_LS } from '../../shared/tool-names';
import { mapPiToolName, normalizeToolInput, normalizeToolDetails } from './tool-normalization';

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
  /** The hard dollar budget to enforce, or `null` when no dollar enforcement applies (US-008). */
  budgetLimit: () => number | null;
  /** The parent session's current cumulative cost (USD) — used to combine with subagent cost (Phase 5). */
  sessionCost: () => number;
  /** Abort the in-flight turn when the hard budget is crossed mid-turn (US-008). */
  onBudgetStop: () => void;
  /** A user message was delivered mid-run (a steer/follow-up delivery) — flush the queued-input buffer.
   *  Returns true when the delivery collapsed a real queued batch (so its mid-stream marker is owed),
   *  false for a plain follow-up or an empty buffer. */
  onUserMessageDelivered: () => boolean;
  /** A delivered queued batch's pi user entry id is now committed to the tree (resolved at the next
   *  assistant message_start). Persist the mid-stream marker keyed to it. */
  onMidStreamBatchCommitted: (userEntryId: string) => void;
  onAssistantTextFinal?: (text: string) => void;
}

interface ToolRecord {
  startedAt: number;
  streamed: boolean;
  /** The pi tool name, kept so a still-running tool can be abandoned (with its webview name) on abort. */
  name: string;
}

/** Detect auth-shaped error text so the webview can show the renewal banner rather than a raw error. */
function isAuthError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('401') || m.includes('unauthorized') || m.includes('authentication') || m.includes('invalid api key') || m.includes('oauth');
}

/**
 * pi refuses compaction on a session with no summarizable messages by throwing
 * "Nothing to compact (session too small)" (or "Already compacted"). That is a benign no-op, not a
 * failure, so it must surface as a friendly notice rather than a red error. `PiSession.compact()` owns
 * the user-facing notice; the adapter only suppresses the duplicate red error pi attaches to its
 * `compaction_end` event.
 */
export function isNothingToCompact(message: string): boolean {
  return message.includes('Nothing to compact') || message.includes('Already compacted');
}

/** The id of the last user-role message entry on the active branch — the turn's stable user entry id. */
function lastUserEntryId(session: AgentSession): string | null {
  const sm = session.sessionManager;
  const branch = sm.getBranch(sm.getLeafId() ?? undefined);
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry && entry.type === 'message' && (entry as { message?: { role?: string } }).message?.role === 'user') {
      return entry.id;
    }
  }
  return null;
}

/**
 * The id of the latest `compaction` entry on the active branch — the tree node the boundary card
 * branches at (its parent is the last pre-compaction message) for rewind-to-before-compaction. Mirrors
 * pi's `getLatestCompactionEntry`, scanned locally so this module never statically loads the ESM-only
 * pi package (it is `external` and reached via the dynamic loader; a static value import crashes tests).
 */
function latestCompactionEntryId(session: AgentSession): string | null {
  const sm = session.sessionManager;
  const branch = sm.getBranch(sm.getLeafId() ?? undefined);
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry && entry.type === 'compaction') return entry.id;
  }
  return null;
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
  /** Ordered content blocks (text + tool_use) committed for the current assistant message, so the
   * webview renders text-before-tool in source order while streaming instead of tool-first. */
  private _streamingBlocks: ContentBlock[] = [];
  /** Length of `_streamingText` already flushed into a `_streamingBlocks` text block. */
  private _committedTextLength = 0;
  private _streamingThinking = '';
  private _thinkingStart: number | null = null;
  private _thinkingDuration: number | null = null;
  private _lastCumulativeCost = 0;
  private _accumulatedCost = 0;
  /** Subagent cost (USD) rolled in from nested sessions — counts toward budget + accumulated cost (Phase 5). */
  private _externalCost = 0;
  /** Whether `budgetExceeded` was already emitted for the current over-limit state (re-armed below limit). */
  private _budgetExceededEmitted = false;
  /** The current turn's correlation id, held until the real pi user entry id is known (FR-3). */
  private _pendingCorrelationId: string | undefined;
  /** Whether this turn's `userMessageIdAssigned` (with the pi entry id) has been emitted yet. */
  private _userIdEmitted = false;
  /** Set when a queued batch is delivered (user message_end) but pi hasn't yet committed its user entry
   *  to the tree. Resolved one-shot at the next assistant message_start, where the entry is committed —
   *  the same boundary `emitUserMessageIdOnce` and the checkpoint engine use to key the turn's entry. */
  private _midStreamMarkerPending = false;
  /** Set by the keep-alive hold so the next `agent_end` does not emit idle/done (the turn continues). */
  private _holdNextAgentEnd = false;
  /** Whether a real agent run (LLM turn) was observed since `beginTurn`. An extension command handled
   *  inside `prompt()` runs synchronously and starts no run, so it emits no terminal event to settle the
   *  turn — the host uses this to release the spinner itself (see `endTurnWithoutAgentRun`). */
  private _agentRunObserved = false;
  private readonly _tools = new Map<string, ToolRecord>();

  private readonly deps: PiStreamAdapterDeps;

  constructor(deps: PiStreamAdapterDeps) {
    this.deps = deps;
  }

  /** Total per-turn cost summed across the session (host-side reader for `getAccumulatedCost`). */
  get accumulatedCost(): number {
    return this._accumulatedCost;
  }

  /** Cumulative subagent cost rolled in this session (Phase 5), added to the parent session cost for budget. */
  get externalCost(): number {
    return this._externalCost;
  }

  /**
   * Roll a nested subagent's cost delta (USD) into the panel meter (Phase 5). It adds to the accumulated
   * cost and, mid-turn, can trip the hard budget just like the parent's own spend.
   */
  addExternalCost(deltaUsd: number): void {
    if (!(deltaUsd > 0)) return;
    this._externalCost += deltaUsd;
    this._accumulatedCost += deltaUsd;
    const limit = this.deps.budgetLimit();
    if (limit === null || limit <= 0) return;
    const spend = this.deps.sessionCost() + this._externalCost;
    if (spend >= limit && !this._budgetExceededEmitted) {
      this._budgetExceededEmitted = true;
      this.emit({ type: 'budgetExceeded', finalSpend: spend, limit });
      this.deps.onBudgetStop();
    }
  }

  /**
   * Seed the cost baseline from a resumed session's loaded total (US-010b) so the budget meter and
   * `getAccumulatedCost` continue from there, and the first post-resume turn's delta (computed in
   * `onAgentEnd` as `stats.cost - _lastCumulativeCost`) stays correct.
   */
  seedResumedUsage(loadedCost: number): void {
    this._lastCumulativeCost = loadedCost;
    this._accumulatedCost = loadedCost;
  }

  /**
   * Reset every cost baseline when the underlying pi session is replaced (reset/clear → newSession).
   * The fresh session reports cost from zero, so the parent baseline (`_lastCumulativeCost`), the
   * rolled-in subagent cost (`_externalCost`), and the accumulated total must all return to zero — and
   * the budget-exceeded latch re-arm — or the meter mixes stale subagent dollars with a fresh-zero
   * parent and the first new turn's delta is under-counted.
   */
  resetCostBaseline(): void {
    this._lastCumulativeCost = 0;
    this._accumulatedCost = 0;
    this._externalCost = 0;
    this._budgetExceededEmitted = false;
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
    this._streamingBlocks = [];
    this._committedTextLength = 0;
    this._streamingThinking = '';
    this._thinkingStart = null;
    this._thinkingDuration = null;
    this._tools.clear();
    const sid = this.deps.sessionId();
    this._currentAssistantId = `${sid}:a:${this._turnSeq}:0`;

    this._agentRunObserved = false;
    this.emit({ type: 'processing', isProcessing: true });
    this.emit({ type: 'sessionStateChanged', state: 'running', sessionId: sid });
    this.emitSessionStartOnce();

    // Defer userMessageIdAssigned until the real pi user entry id is known (resolved on the first
    // assistant message_start). The webview links by correlationId, so timing is decoupled (FR-3); the
    // pi entry id is the single stable key shared by live and replayed turns for checkpoint/rewind.
    this._pendingCorrelationId = correlationId;
    this._userIdEmitted = false;
    // A queued delivery from a prior turn that aborted before its resolving assistant message_start must
    // not leak its pending marker into this turn (it would mis-key to this turn's entry).
    this._midStreamMarkerPending = false;
  }

  /** Emit `userMessageIdAssigned` once per turn with the pi user entry id, for every turn (FR-3). */
  private emitUserMessageIdOnce(session: AgentSession): void {
    if (this._userIdEmitted || !this._pendingCorrelationId) return;
    const userEntryId = lastUserEntryId(session);
    if (!userEntryId) return;
    this._userIdEmitted = true;
    this.emit({ type: 'userMessageIdAssigned', sdkMessageId: userEntryId, correlationId: this._pendingCorrelationId });
  }

  /**
   * Persist a delivered queued batch's mid-stream marker once its pi user entry is committed. The
   * delivery event (user message_end) fires before pi commits that entry to the tree, so reading the
   * leaf there mis-keys it to the previous turn's entry. The next assistant message_start is the first
   * point the steered entry is committed (where the checkpoint engine also keys its entries), so the
   * marker is resolved here. One-shot per delivered batch.
   */
  private resolveMidStreamMarker(session: AgentSession, role: string): void {
    if (!this._midStreamMarkerPending || role !== 'assistant') return;
    const userEntryId = lastUserEntryId(session);
    if (!userEntryId) return;
    this._midStreamMarkerPending = false;
    this.deps.onMidStreamBatchCommitted(userEntryId);
  }

  /** Whether a real agent run (LLM turn) was observed since the last `beginTurn`. False when `prompt()`
   *  only executed an extension command (handled synchronously, no run). */
  observedAgentRun(): boolean {
    return this._agentRunObserved;
  }

  /** Settle a turn that produced no agent run — e.g. an extension slash command (`/todos`) handled
   *  inside `prompt()`, which emits no terminal event. Releases the spinner and returns the session to
   *  idle without a phantom result card. */
  endTurnWithoutAgentRun(): void {
    this.emit({ type: 'processing', isProcessing: false });
    this.emit({ type: 'sessionStateChanged', state: 'idle', sessionId: this.deps.sessionId() });
  }

  /** Mark that the next `agent_end` is a keep-alive hold continuation — suppress its idle/done so the
   *  turn's "processing" state persists while the parent does another (synthesis) round. */
  holdNextAgentEnd(): void {
    this._holdNextAgentEnd = true;
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
  /**
   * Mark the turn aborted and give every still-running tool card a terminal state. pi's `abort()` stops
   * the agent but a long in-flight tool (e.g. BrowserOpen) may not emit `tool_execution_end` promptly —
   * without this its card would spin forever. We emit `toolAbandoned` for each running tool; the
   * `_aborted` guard in `onToolEnd` then suppresses any late completion so it cannot resurrect the card.
   */
  markAborted(): void {
    this._aborted = true;
    for (const [toolCallId, rec] of this._tools) {
      this.emit({ type: 'toolAbandoned', toolUseId: toolCallId, toolName: mapPiToolName(rec.name), parentToolUseId: null });
    }
    this._tools.clear();
  }

  private emit(m: ExtensionToWebviewMessage): void {
    this.deps.onMessage(m);
  }

  /** Begin a new assistant message: assign its own webview id and reset per-message streaming buffers. */
  private startAssistantMessage(): void {
    this._assistantSeq += 1;
    this._currentAssistantId = `${this.deps.sessionId()}:a:${this._turnSeq}:${this._assistantSeq}`;
    this._streamingText = '';
    this._streamingBlocks = [];
    this._committedTextLength = 0;
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
        // tool result) gets its own webview message id and fresh streaming buffers. Non-assistant
        // messages — notably the `before_agent_start` context-injection custom message
        // (CONTEXT_INJECTION_CUSTOM_TYPE, US-005) — are intentionally not rendered: they are model
        // context, not a visible chat bubble.
        // Resolve the turn's user entry id as early as the user message lands in the tree (its own
        // message_start), falling through to the first assistant message_start. Emits once per turn.
        this.emitUserMessageIdOnce(session);
        // A delivered queued batch's user entry isn't committed to the tree at its own message_end (pi
        // persists it after), so the mid-stream marker is keyed here at the next assistant message_start
        // — where the entry is committed (same boundary the checkpoint engine keys its entries).
        this.resolveMidStreamMarker(session, event.message.role);
        if (event.message.role === 'assistant') this.startAssistantMessage();
        break;
      case 'message_update':
        this.handleAssistantEvent(event.assistantMessageEvent);
        break;
      case 'message_end':
        if (event.message.role === 'assistant') {
          this.emitAssistantMessage(event.message.content);
          this.emitUsage(event.message.usage);
          this.enforceBudgetInFlight(session);
        } else if (event.message.role === 'user' && !this._aborted) {
          // A user message delivered mid-run is a queued (steer) injection — the initial prompt lives
          // in the run's initial context and never emits this. Collapse the queued chips now, and if a
          // real batch was delivered, arm the mid-stream marker for the next assistant message_start.
          if (this.deps.onUserMessageDelivered()) this._midStreamMarkerPending = true;
        }
        break;
      case 'tool_execution_start': {
        const args = (event.args ?? {}) as Record<string, unknown>;
        this.ensureToolStreaming(event.toolCallId, event.toolName, args);
        this._tools.set(event.toolCallId, { startedAt: Date.now(), streamed: true, name: event.toolName });
        // The gate (canUseTool) ran in `tool_call`; once pi begins executing, transition the card
        // from awaiting-approval/streaming to running. Mirrors the SDK path's PreToolUse `toolPending`.
        this.emit({
          type: 'toolPending',
          toolUseId: event.toolCallId,
          toolName: mapPiToolName(event.toolName),
          input: normalizeToolInput(event.toolName, args),
          parentToolUseId: null,
        });
        break;
      }
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
        // A keep-alive hold (background subagents) injected a follow-up in the awaited agent_end hook, so
        // the same turn continues with another round — suppress the idle/done that would settle it here.
        if (this._holdNextAgentEnd) {
          this._holdNextAgentEnd = false;
        } else if (!event.willRetry) {
          this.onAgentEnd(session);
        }
        break;
      case 'compaction_start': {
        const trigger = event.reason === 'manual' ? 'manual' : 'auto';
        this.emit({ type: 'preCompact', trigger });
        this.emit({ type: 'statusUpdate', status: 'compacting' });
        if (trigger === 'auto') {
          this.emit({ type: 'autoCompactTriggering', percentUsed: session.getContextUsage()?.percent ?? 0 });
        }
        break;
      }
      case 'compaction_end': {
        const trigger = event.reason === 'manual' ? 'manual' : 'auto';
        if (!event.aborted && event.errorMessage && !event.result) {
          if (!isNothingToCompact(event.errorMessage)) {
            this.emit({ type: 'error', message: event.errorMessage });
          }
        } else if (!event.aborted && event.result) {
          const result = event.result;
          // Resolve the just-appended compaction entry id so the boundary card can branch the tree at
          // its parent (rewind-to-before-compaction). Conditionally included — never fabricated.
          const compactionEntryId = latestCompactionEntryId(session);
          this.emit({
            type: 'compactBoundary',
            preTokens: result.tokensBefore,
            ...(result.estimatedTokensAfter ? { postTokens: result.estimatedTokensAfter } : {}),
            trigger,
            ...(result.summary ? { summary: result.summary } : {}),
            timestamp: Date.now(),
            ...(compactionEntryId ? { entryId: compactionEntryId } : {}),
          });
          if (result.summary) this.emit({ type: 'compactSummary', summary: result.summary });
        }
        this.emit({ type: 'statusUpdate', status: 'ready' });
        if (trigger === 'auto') this.emit({ type: 'autoCompactComplete' });
        break;
      }
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
    this._tools.set(toolCallId, { startedAt: existing?.startedAt ?? Date.now(), streamed: true, name: piName });

    // Commit the streamed text that precedes this tool call as an ordered text block, then the tool_use
    // block, and ship the full ordered `contentBlocks`. Without this the message has no contentBlocks
    // mid-stream, so the webview falls back to a tool-first layout (`flattenFallback`) and the answer
    // text renders below the card until the final assistant message reorders it. Mirrors the SDK
    // assistant-processor so text-before-tool keeps its source order throughout the stream.
    const toolName = mapPiToolName(piName);
    const input = normalizeToolInput(piName, args);
    const uncommitted = this._streamingText.slice(this._committedTextLength);
    if (uncommitted.trim()) {
      this._streamingBlocks.push({ type: 'text', text: uncommitted });
    }
    this._committedTextLength = this._streamingText.length;
    this._streamingBlocks.push({ type: 'tool_use', id: toolCallId, name: toolName, input });

    this.emit({
      type: 'toolStreaming',
      messageId: this._currentAssistantId ?? '',
      tool: { id: toolCallId, name: toolName, input },
      contentBlocks: [...this._streamingBlocks],
    });
  }

  private onToolEnd(toolCallId: string, piName: string, result: unknown, isError: boolean): void {
    // After an abort the tool was already abandoned in `markAborted`; a late completion would override
    // that terminal state (abandoned/completed share merge priority), so drop it.
    if (this._aborted) {
      this._tools.delete(toolCallId);
      return;
    }
    const durationMs = this.elapsed(toolCallId) * 1000;
    const toolName = mapPiToolName(piName);
    this._tools.delete(toolCallId);
    if (isError) {
      this.emit({ type: 'toolFailed', toolUseId: toolCallId, toolName, error: joinResultText(result) || 'Tool failed', durationMs });
      return;
    }
    this.emit({ type: 'toolCompleted', toolUseId: toolCallId, toolName, result: joinResultText(result), durationMs });
    const details = (result as { details?: unknown } | undefined)?.details;
    if (details && typeof details === 'object') {
      this.emit({ type: 'toolMetadata', toolUseId: toolCallId, metadata: normalizeToolDetails(details as Record<string, unknown>) });
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
    this._agentRunObserved = true;
    // Keep cost accounting accurate even for an aborted turn, but stop before the user-facing
    // completion signals — a user abort already emitted sessionCancelled + idle.
    const stats = session.getSessionStats();
    const turnCost = Math.max(0, stats.cost - this._lastCumulativeCost);
    this._lastCumulativeCost = stats.cost;
    this._accumulatedCost += turnCost;
    if (this._aborted) return;

    this.checkBudgetAtTurnEnd(stats.cost + this._externalCost);

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

  /**
   * In-flight budget enforcement (US-008): a single agentic turn can chain many model/tool calls, so
   * the moment the session's cumulative cost crosses the hard limit mid-turn we emit `budgetExceeded`
   * and abort the turn (via `onBudgetStop`). Emitted once per over-limit state. No-op when no dollar
   * limit applies (subscription/allowance).
   */
  private enforceBudgetInFlight(session: AgentSession): void {
    const limit = this.deps.budgetLimit();
    if (limit === null || limit <= 0) return;
    const spend = session.getSessionStats().cost + this._externalCost;
    if (spend >= limit && !this._budgetExceededEmitted) {
      this._budgetExceededEmitted = true;
      this.emit({ type: 'budgetExceeded', finalSpend: spend, limit });
      this.deps.onBudgetStop();
    }
  }

  /**
   * Between-turns budget check (US-008): after a turn completes naturally, warn at ≥80% and signal
   * exceeded at ≥100% of the hard limit, reusing the exact SDK message contract. Re-arms the
   * exceeded flag once spend is back below the limit (e.g. after a fresh session).
   */
  private checkBudgetAtTurnEnd(spend: number): void {
    const limit = this.deps.budgetLimit();
    if (limit === null || limit <= 0) return;
    if (spend >= limit) {
      if (!this._budgetExceededEmitted) {
        this._budgetExceededEmitted = true;
        this.emit({ type: 'budgetExceeded', finalSpend: spend, limit });
      }
      return;
    }
    this._budgetExceededEmitted = false;
    const percentUsed = (spend / limit) * 100;
    if (percentUsed >= 80) {
      this.emit({ type: 'budgetWarning', currentSpend: spend, limit, percentUsed });
    }
  }

  /**
   * Terminal assistant error. Model refusals arrive here too: pi collapses an Anthropic
   * `stop_reason:'refusal'` into `stopReason:'error'` + `errorMessage`, so a refusal is just an
   * `error` reason whose message is the refusal explanation. It surfaces through the unified `error`
   * path as a calm inline notice (no refusal-specific card, no text-matching) — US-023. The only edge
   * is a refusal whose text trips the auth heuristic (e.g. mentions "oauth"); that is the documented
   * low-risk corner of the pre-existing `isAuthError` heuristic, not a refusal-specific behavior.
   */
  private onAssistantError(reason: 'aborted' | 'error', message: string): void {
    this._agentRunObserved = true;
    if (reason === 'aborted') {
      if (!this._aborted) {
        this._aborted = true;
        this.emit({ type: 'sessionCancelled' });
      }
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
