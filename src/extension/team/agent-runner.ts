import * as crypto from 'crypto';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { AgentRunConfig, AgentResult, UndeliveredMessage } from './types';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { ImageBlock } from '../../shared/types/content';
import { LIVE_OUTPUT_TOOLS } from '../../shared/tool-names';
import { STEER_INSTRUCTION_PREFIX } from '../../shared/steer';
import { installTurnDecider, TEAM_TERMINAL_HOOK } from '../pi-session/finish-turn';
import { addUsage, type LifetimeUsage } from '../pi-session/subagents/usage';
import { joinResultText } from '../pi-session/tool-result-text';
import { mapPiToolName } from '../pi-session/tool-normalization';
import { extractImages } from '../pi-session/branch-text';
import { ToolOutputCoalescer } from '../pi-session/tool-output-coalescer';
import { assistantContentBlocks, toolResultBlock, type PiAssistantBlock } from './content-blocks';

/** Messages queued for one run. `onArrival` is a no-op until the session is open to deliver them. */
interface RunInbox {
  pending: UndeliveredMessage[];
  /**
   * Every message steered into pi and not yet started, in order. pi's own steering queue keeps only
   * the text, so this is where a queued message's images survive a cancel.
   */
  steeredIntoPi: Array<{ text: string; images?: ImageBlock[] }>;
  onArrival: () => void;
}

/** A user message's text as pi matches it against its steering queue: text parts joined with no separator. */
function queueMatchText(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text ?? '' : '')).join('');
}

/**
 * Pairs texts pi hands back from its queues with the images they were steered with. Duplicate texts pair
 * in order, the same order pi keeps them in.
 */
function withSteeredImages(texts: readonly string[], steered: RunInbox['steeredIntoPi']): UndeliveredMessage[] {
  const unclaimed = [...steered];
  return texts.map((text) => {
    const index = unclaimed.findIndex((s) => s.text === text);
    const images = index === -1 ? undefined : unclaimed.splice(index, 1)[0]!.images;
    return { text, echoed: true, ...(images ? { images } : {}) };
  });
}

/** Tools whose whole point is that the agent stops here, so the engine ends the turn on their result. */
const TURN_ENDING_TOOLS = new Set(['team_standby', 'team_report_complete']);

/**
 * Pi-native team agent runner (US-024b). Each team agent is a nested `createSubagentSession` driven
 * here. The SDK `query()`/`inputStream()`/keep-alive-timer engine is gone: the runner subscribes to the
 * MessageBus and, on a delivered message, calls `session.prompt(msg, { streamingBehavior: 'steer' })`
 * if the session is streaming, else `session.prompt(msg)` — pi's native steering queue. There are NO
 * keep-alive timers or periodic status pings; a pi idle session waits at zero cost. When a turn ends and
 * `keepAlive()` is false (the agent has nothing left to wait for, e.g. the team synthesized), the loop
 * exits and the session ends. Abort (the team or specialist controller) breaks the wait and ends.
 *
 * Webview streaming is emitted from the session subscription, while the member's messages persist in
 * its own pi session file. The runner returns an `AgentResult` with the final usage totals.
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

    // Subscribed before the session opens, so a message sent while it opens is queued, not lost.
    const inbox: RunInbox = { pending: [...(config.redeliver ?? [])], steeredIntoPi: [], onArrival: () => undefined };
    const accept = (message: UndeliveredMessage): void => {
      inbox.pending.push(message);
      inbox.onArrival();
    };
    const unsubscribeBus = config.messageBus.subscribe((msg) => {
      if (msg.from === config.name) return;
      if (msg.to !== config.name && msg.to !== null) return;
      if (config.shouldDeliverMessage && !config.shouldDeliverMessage({ from: msg.from, to: msg.to, ...(msg.kind ? { kind: msg.kind } : {}) })) return;
      accept({ text: `[Message from ${msg.from}]: ${msg.content}`, echoed: false });
    });
    // A user note reaches the run here rather than through the bus, so no delivery filter, no self-name
    // filter and no post-teardown subscription can drop it without the caller finding out.
    const unbindNote = config.bindNoteDelivery((text, images) => {
      if (config.abortSignal.aborted) return false;
      const withImages = images?.length ? { images } : {};
      this.emitUserMessage(config, text, images);
      accept({ text, echoed: true, ...withImages });
      return true;
    });
    let opened: AgentSession | null = null;
    const unbindTakeUndelivered = config.bindTakeUndelivered(() => {
      // Taken, not read: an aborted tool call lets pi deliver its queue on the way out, and the caller then owns these.
      const queued = opened?.clearQueue();
      const fromPi = queued ? withSteeredImages([...queued.steering, ...queued.followUp], inbox.steeredIntoPi) : [];
      inbox.steeredIntoPi.length = 0;
      // pi's queues hold text the runner already flushed and echoed, and it was queued before the pending list.
      return [...fromPi, ...inbox.pending.map((m) => ({ ...m }))];
    });
    const release = (): void => {
      unsubscribeBus();
      unbindNote();
      unbindTakeUndelivered();
    };

    let session: AgentSession;
    try {
      session = await config.createSession();
    } catch (err) {
      release();
      const errMsg = err instanceof Error ? err.message : String(err);
      config.messageBus.broadcast('system', `Agent "${config.name}" failed to start: ${errMsg}`);
      return empty('failed', `Failed to start: ${errMsg}`);
    }
    // The signal can already be aborted by the time createSession resolves — check up-front before wiring.
    if (config.abortSignal.aborted) {
      release();
      config.forgetSession(session);
      return empty('cancelled', null);
    }
    opened = session;

    // A terminal tool only takes effect if the turn ends, and the model keeps working after calling one
    // unless the engine ends the turn.
    installTurnDecider(session.agent, TEAM_TERMINAL_HOOK, (turn) => {
      // Reads the agent's own queue, not `session.pendingMessageCount`: that counts a mirror which
      // `sendCustomMessage` bypasses, so a queued follow-up reads as zero there. Ending on a stale count
      // costs an extra continuation request, since pi continues on `hasQueuedMessages()` regardless.
      if (session.agent.peekQueuedMessages().length > 0) return undefined;
      // Keyed on the result, not the call: both tools throw for a lead and for a non-running specialist,
      // and the agent needs that same turn to react to the error.
      const terminalCallIds = new Set(
        turn.message.content.flatMap((b) => (b.type === 'toolCall' && TURN_ENDING_TOOLS.has(b.name) ? [b.id] : [])),
      );
      const parked = turn.toolResults.some((r) => terminalCallIds.has(r.toolCallId) && !r.isError);
      return parked ? { action: 'end' } : undefined;
    });

    return this.runAgent(config, session, startTime, inbox, release);
  }

  private async runAgent(
    config: AgentRunConfig,
    session: AgentSession,
    startTime: number,
    inbox: RunInbox,
    release: () => void,
  ): Promise<AgentResult> {
    let toolCallCount = 0;
    let finalResponse: string | null = null;
    let status: 'completed' | 'failed' | 'cancelled' = 'completed';
    // Lifetime consumption across all of this agent's turns (mirrors the subagent model): every
    // component accumulates per `message_end`. cacheRead re-reads the whole prefix on every request and
    // is paid on every request, so the running total is what the cost reflects, not the last snapshot.
    const lifetime: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0 };
    let cacheReadTokens = 0;
    let costUsd = 0;
    let lastRolledCost = 0;
    // A reopened session's stats include the spend of its earlier runs, which were already charged.
    const costBaseline = session.getSessionStats().cost;

    /**
     * Messages waiting to be delivered, each as its own prompt. `echoed` records whether the overlay has
     * already seen one: a user note is echoed the moment it is accepted (that echo is what the delivery
     * caller is told about), a bus message is echoed when it is handed to pi.
     */
    const pendingMessages = inbox.pending;
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
      // Messages queued before the run was streaming (redelivered, sent while the session opened or
      // while pi prepared the prompt) join the run here instead of waiting for it to end.
      if (event.type === 'agent_start') inbox.onArrival();
      // pi drops a started message from its steering queue by the same first-equal-text rule (agent-session.js, `_handleAgentEvent`).
      if (event.type === 'message_start' && event.message.role === 'user') {
        const text = queueMatchText(event.message.content);
        const index = inbox.steeredIntoPi.findIndex((s) => s.text === text);
        if (text && index !== -1) inbox.steeredIntoPi.splice(index, 1);
      }
      this.handleSessionEvent(event, config, outputCoalescer, {
        onToolUse: (name) => {
          toolCallCount++;
          config.onToolCall?.(name, toolCallCount);
        },
        onAssistantText: (text) => { finalResponse = text; },
        getCost: () => session.getSessionStats().cost - costBaseline,
        onUsage: (u) => {
          // u is the per-message usage from this `message_end`, one request, so adding it here counts
          // each request's cached prefix exactly once.
          addUsage(lifetime, { input: u.input, output: u.output, cacheWrite: u.cacheWrite });
          cacheReadTokens += u.cacheRead;
          // u.cost is pi's cumulative session cost past the baseline. Safe to take as-is (not summed) because team agent
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

    inbox.onArrival = () => {
      // Mid-stream, each message joins pi's steering queue in delivery order; otherwise wake the
      // idle-wait to re-prompt. 0.80.5 fixes a latent race here: `isStreaming` now stays true across
      // retry windows, so a bus message arriving during a retry — which previously saw
      // `isStreaming === false` and re-prompted a still-active session — now correctly steers instead.
      if (session.isStreaming) {
        for (let next = takeNext(); next !== undefined; next = takeNext()) {
          inbox.steeredIntoPi.push({ text: next.text, ...(next.images ? { images: next.images } : {}) });
          void promptQueued(next, { streamingBehavior: 'steer' }).catch(() => {});
        }
      } else {
        wake('message');
      }
    };

    const onAbort = (): void => { wake('abort'); void session.abort().catch(() => {}); };
    config.abortSignal.addEventListener('abort', onAbort, { once: true });

    /**
     * Every prompt of queued content goes through here. `expandPromptTemplates: false` is the
     * leading-slash guard: a user note is the one queued string that reaches pi without the
     * `[Message from X]:` prefix, and pi would otherwise dispatch a note beginning with `/` as an
     * extension command and return without ever prompting the agent.
     */
    const promptQueued = (message: UndeliveredMessage, options?: { streamingBehavior: 'steer' }): Promise<void> =>
      session.prompt(message.text, {
        ...options,
        ...(message.images?.length ? { images: extractImages(message.images) } : {}),
        expandPromptTemplates: false,
      });

    /**
     * Removes the next message to deliver, steers first, echoing it if the overlay has not seen it.
     * Never merge messages: a steer's authority covers its whole user message, so peer text must not share one.
     */
    const takeNext = (): UndeliveredMessage | undefined => {
      const index = Math.max(0, pendingMessages.findIndex((m) => m.text.startsWith(STEER_INSTRUCTION_PREFIX)));
      const [next] = pendingMessages.splice(index, 1);
      if (!next) return undefined;
      if (!next.echoed) this.emitUserMessage(config, next.text, next.images);
      return next;
    };

    try {
      // A parked run starts where a turn-end leaves one: waiting, with no prompt and no `running` status.
      let parked = config.initial.kind === 'park';
      if (config.initial.kind === 'prompt') {
        this.emitStatus(config, 'running');
        // The opening task — emitted to the webview + persisted as the first user message.
        this.emitUserMessage(config, config.initial.text);
        await session.prompt(config.initial.text);
      }

      // Event-driven wait/re-prompt loop — no timers. After each turn: re-prompt with the next pending
      // message; else, if the agent must keep waiting, idle until a message arrives or it must abort.
      while (!config.abortSignal.aborted) {
        if (!parked) {
          // Reclaims a message pi never delivered because the run ended on an abort or a provider error,
          // the one path where pi discards the turn decision. It is already echoed, hence `echoed: true`.
          if (session.pendingMessageCount > 0) {
            const queued = session.clearQueue();
            pendingMessages.push(...withSteeredImages([...queued.steering, ...queued.followUp], inbox.steeredIntoPi));
          }
          inbox.steeredIntoPi.length = 0;
          // One message opens the run; the rest of the queue joins it as steers on its `agent_start`.
          const next = takeNext();
          if (next !== undefined) {
            await promptQueued(next);
            continue;
          }
          if (!config.keepAlive?.()) {
            config.onReconcileBeforeEnd?.();   // specialist-only: may arm a grace hold
            if (!config.keepAlive?.()) break;  // still nothing to wait for → genuinely done
          }
          config.onTurnEnd?.();
        }
        // A parked run's first message goes through the wake below, so onKeepAliveResume sees it.
        parked = false;
        // Something queued before the wait is armed would never resolve it, so it skips the wait.
        if (pendingMessages.length === 0) {
          const reason = await new Promise<'message' | 'abort'>((resolve) => { waitResolve = resolve; });
          if (reason === 'abort' || config.abortSignal.aborted) break;
        }
        // Re-check keepAlive after the wake: a message may have arrived together with a state change
        // (e.g. revision delivered) — but if keepAlive flipped false meanwhile, end rather than re-prompt.
        if (!config.keepAlive?.() && pendingMessages.length === 0) break;
        config.onKeepAliveResume?.();
        const woken = takeNext();
        if (woken !== undefined) await promptQueued(woken);
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
      release();
      unsubscribeSession();
      outputCoalescer.dispose();
      config.abortSignal.removeEventListener('abort', onAbort);
      config.forgetSession(session);
    }

    // The reported summary is the agent's own sign-off, so it outranks trailing assistant text, which
    // the turn-ending hook means the agent no longer produces.
    const reportedSummary = config.getReportedSummary?.() ?? null;
    if (reportedSummary !== null) {
      finalResponse = reportedSummary;
    } else if (finalResponse === null) {
      const last = session.getLastAssistantText();
      if (last) finalResponse = last;
    }

    const durationMs = Date.now() - startTime;
    this.emitStatus(config, status, status === 'completed'
      ? { progressSummary: `Completed (${toolCallCount} tools, ${Math.round(durationMs / 1000)}s)` }
      : undefined);

    return { agentId: config.agentId, status, finalResponse, toolCallCount, durationMs, totalInputTokens: lifetime.input, totalOutputTokens: lifetime.output, cacheReadTokens, cacheCreationTokens: lifetime.cacheWrite, costUsd };
  }

  /** Map one pi session event to the existing `team*` webview messages (no contract change). */
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
        // The team path has no `toolMetadata` message, so the result's details ride on this one or reach the card never.
        const block = toolResultBlock(event.toolCallId, event.result, event.isError === true);
        config.onMessage({
          type: 'teamAgentToolResult', teamId: config.teamId,
          agentId: config.agentId,
          toolUseId: event.toolCallId,
          result: block.content,
          isError: block.is_error === true,
          ...(block.metadata ? { metadata: block.metadata } : {}),
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

  /** Seal one completed assistant message: emit `teamAgentAssistant` and count tool uses. */
  private emitAssistant(
    content: ReadonlyArray<PiAssistantBlock> | undefined,
    config: AgentRunConfig,
    cb: {
      onToolUse: (name: string) => void;
      onAssistantText: (text: string) => void;
    },
  ): void {
    if (!content) return;

    const blocks = assistantContentBlocks(content);
    for (const b of blocks) {
      if (b.type === 'text') {
        cb.onAssistantText(b.text);
      } else if (b.type === 'tool_use') {
        cb.onToolUse(b.name);
        config.onMessage({ type: 'teamAgentToolCall', teamId: config.teamId, agentId: config.agentId, toolName: b.name, toolInput: b.input as Record<string, unknown> });
      }
    }
    if (blocks.length === 0) return;

    config.onMessage({
      type: 'teamAgentAssistant', teamId: config.teamId, agentId: config.agentId,
      messageId: crypto.randomUUID(),
      content: blocks,
      timestamp: Date.now(),
    });
  }

  private emitUserMessage(config: AgentRunConfig, content: string, images?: ImageBlock[]): void {
    config.onMessage({
      type: 'teamAgentUserMessage', teamId: config.teamId, agentId: config.agentId, content,
      ...(images?.length ? { images } : {}),
      timestamp: Date.now(),
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
