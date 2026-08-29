/**
 * subagent-stream-bridge.ts — Map a nested subagent session's events to the existing webview contract.
 *
 * New for the Damocles port (US-018.4). The webview already renders subagent cards from the
 * `subagent*` messages + the `parentToolUseId` field on tool messages (no contract change). This bridge
 * subscribes to a nested `AgentSession` and emits, all via the PARENT panel's `postMessage`:
 *   - `subagentStart` + `subagentModelUpdate` once at spawn,
 *   - per nested tool: `toolPending` → `toolProgress` → `toolCompleted`/`toolFailed`, stamped with
 *     `parentToolUseId = <Agent tool-call id>` so they land on the subagent card,
 *   - at completion: a final (sealing) `subagentMessagesUpdate` built by `piMessagesToHistoryAgentMessages`,
 *     and `subagentStop`.
 *
 * Card completion: `finish` always emits the `toolCompleted{toolName:'Agent'}` (or `toolFailed`) that
 * flips the card to completed/failed and sets its result — for BOTH foreground and background spawns. A
 * foreground call also yields a real `toolCompleted{Agent}` from the parent stream, but that event does
 * not reliably land while the card is still showing (it doesn't survive a non-YOLO approval gap), and the
 * webview completion is idempotent (acts only while the card is `running`). Self-synthesizing here makes
 * the card's resolution independent of the parent stream; the later real event is a harmless no-op.
 */

import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { ContentBlock } from '../../../shared/types/content';
import { TOOL_AGENT, LIVE_OUTPUT_TOOLS } from '../../../shared/tool-names';
import { mapPiToolName, normalizeToolInput, normalizeToolDetails } from '../tool-normalization';
import { joinResultText } from '../tool-result-text';
import { ToolOutputCoalescer } from '../tool-output-coalescer';
import { piMessagesToHistoryAgentMessages } from './message-mapper';

export interface SubagentStreamBridgeDeps {
  /** The spawning `Agent` tool-call id — the webview key for this subagent card. */
  parentToolUseId: string;
  /** The manager-assigned subagent id. */
  agentId: string;
  /** The agent type name (e.g. "Explore"). */
  agentType: string;
  /** The resolved background flag (param-or-frontmatter) — corrects the card's param-derived badge. */
  isBackground: boolean;
  /** The parent panel's session id — stamped on emitted `assistant`/`partial` (`setCurrentSession`). */
  getSessionId: () => string;
  postMessage: (message: ExtensionToWebviewMessage) => void;
}

/** Build the JSON result string the webview's Agent-completion path parses (mirrors the SDK shape). */
export function buildAgentResultJson(opts: {
  responseText: string;
  agentId: string;
  totalDurationMs: number;
  totalTokens: number;
  totalToolUseCount: number;
}): string {
  return JSON.stringify({
    content: [{ type: 'text', text: opts.responseText }],
    totalDurationMs: opts.totalDurationMs,
    totalTokens: opts.totalTokens,
    totalToolUseCount: opts.totalToolUseCount,
    agentId: opts.agentId,
  });
}

export class SubagentStreamBridge {
  private readonly deps: SubagentStreamBridgeDeps;
  private readonly toolStarts = new Map<string, number>();
  /** Live shell output frames only. Elapsed-only progress stays uncoalesced so its cadence is unchanged. */
  private readonly outputCoalescer = new ToolOutputCoalescer<ExtensionToWebviewMessage>((m) => this.emit(m));
  private modelEmitted = false;
  private templateEmitted = false;
  /** Per-assistant-message streaming state — mirrors PiStreamAdapter so the card streams text/thinking. */
  private assistantSeq = 0;
  private currentMsgId = '';
  private streamingText = '';
  private streamingThinking = '';
  private thinkingStart: number | null = null;

  constructor(deps: SubagentStreamBridgeDeps) {
    this.deps = deps;
  }

  private emit(m: ExtensionToWebviewMessage): void {
    this.deps.postMessage(m);
  }

  /** Emit `subagentStart` (registers the card's sdkAgentId) and, if known, the model + template path. */
  start(model?: string, templatePath?: string): void {
    this.emit({ type: 'subagentStart', agentId: this.deps.agentId, agentType: this.deps.agentType, toolUseId: this.deps.parentToolUseId, isBackground: this.deps.isBackground });
    if (model) this.emitModel(model);
    if (templatePath) this.emitTemplate(templatePath);
  }

  /** Emit `subagentModelUpdate` once for the resolved model. */
  emitModel(model: string): void {
    if (this.modelEmitted || !model) return;
    this.modelEmitted = true;
    this.emit({ type: 'subagentModelUpdate', agentToolId: this.deps.parentToolUseId, model });
  }

  /** Emit `subagentTemplateUpdate` once for the agent's markdown template file path. */
  emitTemplate(templatePath: string): void {
    if (this.templateEmitted || !templatePath) return;
    this.templateEmitted = true;
    this.emit({ type: 'subagentTemplateUpdate', agentToolId: this.deps.parentToolUseId, templatePath });
  }

  /** Subscribe to the nested session and stream per-tool events to the card. Returns unsubscribe. */
  attach(session: AgentSession): () => void {
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => this.handle(event));
    return () => {
      unsubscribe();
      // The bridge dies with its subagent, so its pending timers must die here or they fire into a dead card.
      this.outputCoalescer.dispose();
    };
  }

  private handle(event: AgentSessionEvent): void {
    const parentToolUseId = this.deps.parentToolUseId;
    switch (event.type) {
      case 'message_start':
        if (event.message.role === 'assistant') this.startAssistantMessage();
        break;
      case 'message_update':
        this.handleAssistantEvent(event.assistantMessageEvent);
        break;
      case 'message_end':
        if (event.message.role === 'assistant') this.emitAssistantMessage(event.message.content);
        break;
      case 'tool_execution_start': {
        this.toolStarts.set(event.toolCallId, Date.now());
        this.emit({
          type: 'toolPending',
          toolUseId: event.toolCallId,
          toolName: mapPiToolName(event.toolName),
          input: normalizeToolInput(event.toolName, (event.args ?? {}) as Record<string, unknown>),
          parentToolUseId,
        });
        break;
      }
      case 'tool_execution_update': {
        const toolName = mapPiToolName(event.toolName);
        if (!LIVE_OUTPUT_TOOLS.has(toolName)) {
          this.emit({ type: 'toolProgress', toolUseId: event.toolCallId, toolName, parentToolUseId, elapsedTimeSeconds: this.elapsed(event.toolCallId) });
          break;
        }
        // pi omits `truncation` entirely on an untruncated partial frame, so the boolean is derived, not read.
        const details = (event.partialResult as { details?: { truncation?: { truncated?: boolean } } } | undefined)?.details;
        // Built at emit time so a frame held for the whole window reports the elapsed time the card is
        // showing, not the one it had when the frame was pushed.
        this.outputCoalescer.push(event.toolCallId, () => ({
          type: 'toolProgress',
          toolUseId: event.toolCallId,
          toolName,
          parentToolUseId,
          elapsedTimeSeconds: this.elapsed(event.toolCallId),
          output: joinResultText(event.partialResult),
          outputTruncated: Boolean(details?.truncation?.truncated),
        }));
        break;
      }
      case 'tool_execution_end': {
        // Cancel before anything else: a pending partial landing after toolCompleted would resurrect stale output.
        this.outputCoalescer.cancel(event.toolCallId);
        const durationMs = this.elapsed(event.toolCallId) * 1000;
        const toolName = mapPiToolName(event.toolName);
        this.toolStarts.delete(event.toolCallId);
        const resultText = joinResultText(event.result);
        if (event.isError) {
          this.emit({ type: 'toolFailed', toolUseId: event.toolCallId, toolName, error: resultText || 'Tool failed', parentToolUseId, durationMs });
        } else {
          this.emit({ type: 'toolCompleted', toolUseId: event.toolCallId, toolName, result: resultText, parentToolUseId, durationMs });
          const details = (event.result as { details?: unknown } | undefined)?.details;
          if (details && typeof details === 'object') {
            this.emit({ type: 'toolMetadata', toolUseId: event.toolCallId, metadata: normalizeToolDetails(details as Record<string, unknown>) });
          }
        }
        break;
      }
      default:
        break;
    }
  }

  /** Begin a new nested assistant message: assign its own webview id and reset streaming buffers. */
  private startAssistantMessage(): void {
    this.assistantSeq += 1;
    this.currentMsgId = `${this.deps.agentId}:a:${this.assistantSeq}`;
    this.streamingText = '';
    this.streamingThinking = '';
    this.thinkingStart = null;
  }

  /** Stream text/thinking deltas into the card as `partial` messages (stamped with parentToolUseId). */
  private handleAssistantEvent(ame: AssistantMessageEvent): void {
    if (!this.currentMsgId) this.startAssistantMessage();
    switch (ame.type) {
      case 'text_delta':
        this.streamingText += ame.delta;
        this.emitPartial({ streamingText: this.streamingText, isThinking: false });
        break;
      case 'thinking_start':
        if (this.thinkingStart === null) this.thinkingStart = Date.now();
        break;
      case 'thinking_delta':
        if (this.thinkingStart === null) this.thinkingStart = Date.now();
        this.streamingThinking += ame.delta;
        this.emitPartial({ streamingThinking: this.streamingThinking, isThinking: true });
        break;
      case 'thinking_end': {
        const thinkingDuration = this.thinkingStart !== null ? Math.round((Date.now() - this.thinkingStart) / 1000) : undefined;
        this.emitPartial({ streamingThinking: this.streamingThinking, isThinking: false, ...(thinkingDuration !== undefined ? { thinkingDuration } : {}) });
        break;
      }
      default:
        break;
    }
  }

  private emitPartial(extra: { streamingText?: string; streamingThinking?: string; isThinking?: boolean; thinkingDuration?: number }): void {
    this.emit({
      type: 'partial',
      data: { type: 'partial', content: [], session_id: this.deps.getSessionId(), messageId: this.currentMsgId, ...extra },
      parentToolUseId: this.deps.parentToolUseId,
    });
  }

  /** Seal one completed nested assistant message into the card (clears the live streaming buffer). */
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
        message: { id: this.currentMsgId || `${this.deps.agentId}:a:${this.assistantSeq}`, role: 'assistant', content: blocks, model: '', stop_reason: null },
        session_id: this.deps.getSessionId(),
      },
      parentToolUseId: this.deps.parentToolUseId,
    });
    this.currentMsgId = '';
  }

  /** Emit the final (sealing) message snapshot for the card. */
  emitMessages(session: AgentSession): void {
    this.emit({
      type: 'subagentMessagesUpdate',
      agentToolId: this.deps.parentToolUseId,
      messages: piMessagesToHistoryAgentMessages(session.messages),
    });
  }

  /**
   * Resolve the card at completion: emit the final messages snapshot, then the
   * `toolCompleted{toolName:'Agent'}` / `toolFailed` that flips the card to completed/failed and sets its
   * result, then `subagentStop`. The completion is synthesized for BOTH foreground and background spawns
   * (see the file header) so the card never depends on the parent stream's `tool_execution_end{Agent}`.
   */
  finish(opts: {
    session?: AgentSession;
    responseText: string;
    resultJson: string;
    isError: boolean;
    durationMs: number;
  }): void {
    if (opts.session) this.emitMessages(opts.session);
    if (opts.isError) {
      this.emit({ type: 'toolFailed', toolUseId: this.deps.parentToolUseId, toolName: TOOL_AGENT, error: opts.responseText || 'Subagent failed', durationMs: opts.durationMs });
    } else {
      this.emit({ type: 'toolCompleted', toolUseId: this.deps.parentToolUseId, toolName: TOOL_AGENT, result: opts.resultJson, durationMs: opts.durationMs });
    }
    this.emit({
      type: 'subagentStop',
      agentId: this.deps.agentId,
      toolUseId: this.deps.parentToolUseId,
      ...(opts.responseText ? { lastAssistantMessage: opts.responseText } : {}),
    });
  }

  private elapsed(toolCallId: string): number {
    const started = this.toolStarts.get(toolCallId);
    if (started === undefined) return 0;
    return Math.max(0, (Date.now() - started) / 1000);
  }
}
