import * as crypto from 'crypto';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { AgentRunConfig, AgentResult } from './types';
import type { TeamAgentContentBlock } from '../../shared/types/team';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import { LIVE_OUTPUT_TOOLS } from '../../shared/tool-names';
import { addUsage, type LifetimeUsage } from '../pi-session/subagents/usage';
import { joinResultText } from '../pi-session/tool-result-text';
import { mapPiToolName, normalizeToolInput, normalizeToolDetails } from '../pi-session/tool-normalization';
import { ToolOutputCoalescer } from '../pi-session/tool-output-coalescer';

/**
 * Pi-native team agent runner (US-024b). Each team agent is a nested `createSubagentSession` driven
 * here. The SDK `query()`/`inputStream()`/keep-alive-timer engine is gone: the runner subscribes to the
 * MessageBus and, on a delivered message, calls `session.prompt(msg, { streamingBehavior: 'steer' })`
 * if the session is streaming, else `session.prompt(msg)` — pi's native steering queue. There are NO
 * keep-alive timers or periodic status pings; a pi idle session waits at zero cost. When a turn ends and
 * `keepAlive()` is false (the agent has nothing left to wait for, e.g. the team synthesized), the loop
 * exits and the session ends. Abort (the team or specialist controller) breaks the wait and ends.
 *
 * Webview streaming + persistence are emitted from the same session subscription so the existing
 * `team*` contract is preserved verbatim (no contract change). The runner returns an `AgentResult` with
 * the final usage totals, mirroring the SDK runner's return shape.
 */
export class AgentRunner {
  async startAgent(config: AgentRunConfig): Promise<AgentResult> {
    const startTime = Date.now();
    const empty = (status: 'cancelled' | 'failed', finalResponse: string | null): AgentResult => ({
      agentId: config.agentId,
      status,
      finalResponse,
      toolCallCount: 0,
      durationMs: Date.now() - startTime,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
    });

    if (config.abortSignal.aborted) return empty('cancelled', null);

    let session: AgentSession;
    try {
      session = await config.createSession();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      config.messageBus.broadcast('system', `Agent "${config.name}" failed to start: ${errMsg}`);
      return empty('failed', `Failed to start: ${errMsg}`);
    }
    // The signal can already be aborted by the time createSession resolves — check up-front before wiring.
    if (config.abortSignal.aborted) {
      config.forgetSession(session);
      return empty('cancelled', null);
    }

    return this.runAgent(config, session, startTime);
  }

  private async runAgent(config: AgentRunConfig, session: AgentSession, startTime: number): Promise<AgentResult> {
    let toolCallCount = 0;
    let finalResponse: string | null = null;
    let status: 'completed' | 'failed' | 'cancelled' = 'completed';
    // Lifetime consumption across all of this agent's turns (mirrors the subagent model): input/output/
    // cacheWrite ACCUMULATE per `message_end`. cacheRead is NOT summed — each turn's cacheRead re-reads
    // the whole cached prefix, so summing counts it N times; we keep the latest snapshot instead.
    const lifetime: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0 };
    let cacheReadTokens = 0;
    let costUsd = 0;
    let lastRolledCost = 0;

    /**
     * Text waiting to be prompted, flushed as one combined prompt at the next turn. `echoed` records
     * whether the overlay has already seen it: a user note is echoed the moment it is accepted (that
     * echo is what the delivery caller is told about), a bus message is echoed at flush.
     */
    const pendingMessages: Array<{ text: string; echoed: boolean }> = [];
    /** Wakes the idle-wait when a message arrives or the agent must terminate (abort). */
    let waitResolve: ((reason: 'message' | 'abort') => void) | null = null;

    const wake = (reason: 'message' | 'abort'): void => {
      if (waitResolve) {
        const r = waitResolve;
        waitResolve = null;
        r(reason);
      }
    };

    // Per-run so a torn-down agent's pending frames can never fire into the next run's cards.
    const outputCoalescer = new ToolOutputCoalescer<ExtensionToWebviewMessage>((msg) => config.onMessage(msg));

    const unsubscribeSession = session.subscribe((event: AgentSessionEvent) => {
      this.handleSessionEvent(event, config, outputCoalescer, {
        onToolUse: (name) => {
          toolCallCount++;
          config.onToolCall?.(name, toolCallCount);
        },
        onAssistantText: (text) => { finalResponse = text; },
        getCost: () => session.getSessionStats().cost,
        onUsage: (u) => {
          // u is the per-message usage from this `message_end`. Accumulate input/output/cacheWrite;
          // cacheRead is a per-call snapshot of the cached prefix, so take the latest rather than sum.
          addUsage(lifetime, { input: u.input, output: u.output, cacheWrite: u.cacheWrite });
          cacheReadTokens = u.cacheRead;
          // u.cost is pi's cumulative session cost. Safe to take as-is (not summed) because team agent
          // sessions force-disable auto-compaction (pi-runtime.createSubagentSession), so the cost never
          // resets mid-run — it stays monotonic for the agent's whole lifetime.
          costUsd = u.cost;
          config.onUsageUpdate?.({ inputTokens: lifetime.input, outputTokens: lifetime.output, cacheReadTokens, cacheCreationTokens: lifetime.cacheWrite, costUsd: u.cost });
          const delta = Math.max(0, u.cost - lastRolledCost);
          if (delta > 0) {
            lastRolledCost = u.cost;
            config.onCost?.(delta);
          }
        },
      });
    });

    const unsubscribeBus = config.messageBus.subscribe((msg) => {
      if (msg.from === config.name) return;
      if (msg.to !== config.name && msg.to !== null) return;
      if (config.shouldDeliverMessage && !config.shouldDeliverMessage({ from: msg.from, to: msg.to, ...(msg.kind ? { kind: msg.kind } : {}) })) return;
      pendingMessages.push({ text: `[Message from ${msg.from}]: ${msg.content}`, echoed: false });
      // Deliver immediately as a steer if mid-stream; otherwise wake the idle-wait to flush + re-prompt.
      // 0.80.5 fixes a latent race here: `isStreaming` now stays true across retry windows, so a bus
      // message arriving during a retry — which previously saw `isStreaming === false` and re-prompted a
      // still-active session — now correctly steers instead.
      if (session.isStreaming) {
        void promptQueued(flushPending(), { streamingBehavior: 'steer' }).catch(() => {});
      } else {
        wake('message');
      }
    });

    // A user note reaches the run here rather than through the bus, so no delivery filter, no self-name
    // filter and no post-teardown subscription can drop it without the caller finding out.
    const unbindNote = config.bindNoteDelivery((text: string): boolean => {
      if (config.abortSignal.aborted) return false;
      this.emitUserMessage(config, text);
      pendingMessages.push({ text, echoed: true });
      if (session.isStreaming) {
        void promptQueued(flushPending(), { streamingBehavior: 'steer' }).catch(() => {});
      } else {
        wake('message');
      }
      return true;
    });

    const onAbort = (): void => { wake('abort'); void session.abort().catch(() => {}); };
    config.abortSignal.addEventListener('abort', onAbort, { once: true });

    /**
     * Every prompt of queued content goes through here. `expandPromptTemplates: false` is the
     * leading-slash guard: a user note is the one queued string that reaches pi without the
     * `[Message from X]:` prefix, and pi would otherwise dispatch a note beginning with `/` as an
     * extension command and return without ever prompting the agent.
     */
    const promptQueued = (text: string, options?: { streamingBehavior: 'steer' }): Promise<void> =>
      session.prompt(text, { ...options, expandPromptTemplates: false });

    /** Combines the queue into one prompt, echoing only the parts the overlay has not already seen. */
    const flushPending = (): string => {
      const unechoed = pendingMessages.filter((m) => !m.echoed).map((m) => m.text).join('\n\n');
      if (unechoed) this.emitUserMessage(config, unechoed);
      const combined = pendingMessages.map((m) => m.text).join('\n\n');
      pendingMessages.length = 0;
      return combined;
    };

    try {
      this.emitStatus(config, 'running');
      // The opening task — emitted to the webview + persisted as the first user message.
      this.emitUserMessage(config, config.specialization);

      await session.prompt(config.specialization);

      // Event-driven wait/re-prompt loop — no timers. After each turn: flush any pending messages and
      // re-prompt; else, if the agent must keep waiting, idle until a message arrives or it must abort.
      while (!config.abortSignal.aborted) {
        if (pendingMessages.length > 0) {
          await promptQueued(flushPending());
          continue;
        }
        if (!config.keepAlive?.()) {
          config.onReconcileBeforeEnd?.();   // specialist-only: may arm a grace hold
          if (!config.keepAlive?.()) break;  // still nothing to wait for → genuinely done
        }
        config.onTurnEnd?.();
        const reason = await new Promise<'message' | 'abort'>((resolve) => { waitResolve = resolve; });
        if (reason === 'abort' || config.abortSignal.aborted) break;
        // Re-check keepAlive after the wake: a message may have arrived together with a state change
        // (e.g. revision delivered) — but if keepAlive flipped false meanwhile, end rather than re-prompt.
        if (!config.keepAlive?.() && pendingMessages.length === 0) break;
        config.onKeepAliveResume?.();
        const combined = flushPending();
        if (combined) await promptQueued(combined);
      }
      if (config.abortSignal.aborted) status = 'cancelled';
    } catch (err) {
      if (config.abortSignal.aborted) {
        status = 'cancelled';
      } else {
        status = 'failed';
        const errMsg = err instanceof Error ? err.message : String(err);
        config.messageBus.broadcast('system', `Agent "${config.name}" failed: ${errMsg}`);
      }
    } finally {
      waitResolve = null;
      unbindNote();
      unsubscribeBus();
      unsubscribeSession();
      outputCoalescer.dispose();
      config.abortSignal.removeEventListener('abort', onAbort);
      config.forgetSession(session);
    }

    if (finalResponse === null) {
      const last = session.getLastAssistantText();
      if (last) finalResponse = last;
    }

    const durationMs = Date.now() - startTime;
    this.emitStatus(config, status, status === 'completed'
      ? { progressSummary: `Completed (${toolCallCount} tools, ${Math.round(durationMs / 1000)}s)` }
      : undefined);

    return { agentId: config.agentId, status, finalResponse, toolCallCount, durationMs, totalInputTokens: lifetime.input, totalOutputTokens: lifetime.output, cacheReadTokens, cacheCreationTokens: lifetime.cacheWrite, costUsd };
  }

  /** Map one pi session event to the existing `team*` webview messages + persistence (no contract change). */
  private handleSessionEvent(
    event: AgentSessionEvent,
    config: AgentRunConfig,
    outputCoalescer: ToolOutputCoalescer<ExtensionToWebviewMessage>,
    cb: {
      onToolUse: (name: string) => void;
      onAssistantText: (text: string) => void;
      getCost: () => number;
      onUsage: (u: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }) => void;
    },
  ): void {
    switch (event.type) {
      case 'message_update':
        this.handleAssistantDelta(event.assistantMessageEvent, config);
        break;
      case 'message_end':
        if (event.message.role === 'assistant') {
          this.emitAssistant(event.message.content, config, cb);
          const usage = (event.message as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
          if (usage) {
            cb.onUsage({
              input: usage.input ?? 0,
              output: usage.output ?? 0,
              cacheRead: usage.cacheRead ?? 0,
              cacheWrite: usage.cacheWrite ?? 0,
              cost: cb.getCost(),
            });
          }
        }
        break;
      case 'tool_execution_update': {
        // The team path has no elapsed-time progress message, so a non-live tool emits nothing at all.
        if (!LIVE_OUTPUT_TOOLS.has(mapPiToolName(event.toolName))) break;
        // A thunk, so a frame the coalescer holds is rendered from the newest partial rather than the
        // one that happened to open the window.
        outputCoalescer.push(event.toolCallId, () => {
          // pi omits `truncation` entirely on an untruncated partial frame, so the boolean is derived, not read.
          const details = (event.partialResult as { details?: { truncation?: { truncated?: boolean } } } | undefined)?.details;
          return {
            type: 'teamAgentToolProgress',
            teamId: config.teamId,
            agentId: config.agentId,
            toolUseId: event.toolCallId,
            output: joinResultText(event.partialResult),
            outputTruncated: Boolean(details?.truncation?.truncated),
          };
        });
        break;
      }
      case 'tool_execution_end': {
        // Cancel before anything else: a pending partial landing after the result would resurrect stale output.
        outputCoalescer.cancel(event.toolCallId);
        const resultText = joinResultText(event.result);
        // The team path has no `toolMetadata` message, so the result's details ride on this one or reach the card never.
        const details = (event.result as { details?: unknown } | undefined)?.details;
        const metadata = details && typeof details === 'object'
          ? normalizeToolDetails(details as Record<string, unknown>)
          : undefined;
        config.onMessage({
          type: 'teamAgentToolResult', teamId: config.teamId,
          agentId: config.agentId,
          toolUseId: event.toolCallId,
          result: resultText,
          isError: event.isError === true,
          ...(metadata ? { metadata } : {}),
        });
        // Persisted alongside the live message: a reopened team derives each card's terminal status
        // from this entry, and the cancelled marker travels in `metadata` or nowhere.
        const block: TeamAgentContentBlock = {
          type: 'tool_result',
          tool_use_id: event.toolCallId,
          content: resultText,
          is_error: event.isError === true,
          ...(metadata ? { metadata } : {}),
        };
        config.persistence.appendAgentEntry(config.teamId, config.agentId, {
          type: 'tool_result', agentId: config.agentId, content: [block], timestamp: new Date().toISOString(),
        });
        break;
      }
      case 'turn_end': {
        config.onMessage({ type: 'teamAgentTurnComplete', teamId: config.teamId, agentId: config.agentId });
        break;
      }
      default:
        break;
    }
  }

  /** Stream text/thinking deltas into the agent card via the existing `teamAgentStreamDelta` message. */
  private handleAssistantDelta(
    ame: AssistantMessageEvent,
    config: AgentRunConfig,
  ): void {
    if (ame.type === 'text_delta') {
      config.onMessage({ type: 'teamAgentStreamDelta', teamId: config.teamId, agentId: config.agentId, deltaType: 'text', text: ame.delta });
    } else if (ame.type === 'thinking_delta') {
      config.onMessage({ type: 'teamAgentStreamDelta', teamId: config.teamId, agentId: config.agentId, deltaType: 'thinking', text: ame.delta });
    }
  }

  /** Seal one completed assistant message: emit `teamAgentAssistant` + persist, and count tool uses. */
  private emitAssistant(
    content: ReadonlyArray<{ type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> }> | undefined,
    config: AgentRunConfig,
    cb: {
      onToolUse: (name: string) => void;
      onAssistantText: (text: string) => void;
    },
  ): void {
    if (!content) return;

    const blocks: TeamAgentContentBlock[] = [];
    for (const b of content) {
      if (b.type === 'text' && b.text) {
        blocks.push({ type: 'text', text: b.text });
        cb.onAssistantText(b.text);
      } else if (b.type === 'thinking') {
        blocks.push({ type: 'thinking', thinking: b.thinking ?? '' });
      } else if (b.type === 'toolCall' && b.id && b.name) {
        const toolName = mapPiToolName(b.name);
        // normalizeToolInput switches on the raw pi name, so it takes b.name and never the mapped one.
        const toolInput = normalizeToolInput(b.name, (b.arguments ?? {}) as Record<string, unknown>);
        cb.onToolUse(toolName);
        config.onMessage({ type: 'teamAgentToolCall', teamId: config.teamId, agentId: config.agentId, toolName, toolInput });
        blocks.push({ type: 'tool_use', id: b.id, name: toolName, input: toolInput });
      }
    }
    if (blocks.length === 0) return;

    config.onMessage({
      type: 'teamAgentAssistant', teamId: config.teamId, agentId: config.agentId,
      messageId: crypto.randomUUID(),
      content: blocks,
      timestamp: Date.now(),
    });
    config.persistence.appendAgentEntry(config.teamId, config.agentId, {
      type: 'assistant', agentId: config.agentId, content: blocks, timestamp: new Date().toISOString(),
    });
  }

  private emitUserMessage(config: AgentRunConfig, content: string): void {
    config.onMessage({ type: 'teamAgentUserMessage', teamId: config.teamId, agentId: config.agentId, content, timestamp: Date.now() });
    config.persistence.appendAgentEntry(config.teamId, config.agentId, {
      type: 'user', agentId: config.agentId, content, timestamp: new Date().toISOString(),
    });
  }

  private emitStatus(
    config: AgentRunConfig,
    status: 'running' | 'completed' | 'failed' | 'cancelled',
    extra?: { progressSummary?: string },
  ): void {
    config.onMessage({
      type: 'teamAgentStatusUpdate',
      teamId: config.teamId,
      agentId: config.agentId,
      status,
      ...(extra?.progressSummary ? { progressSummary: extra.progressSummary } : {}),
    });
  }
}
