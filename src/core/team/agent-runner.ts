import * as crypto from 'crypto';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { AgentRunConfig, AgentResult, UndeliveredMessage } from './types';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { ImageBlock } from '../../shared/types/content';
import type { ToolAbandonReason } from '../../shared/types/session';
import { LIVE_OUTPUT_TOOLS } from '../../shared/tool-names';
import { STEER_INSTRUCTION_PREFIX } from '../../shared/steer';
import { installTurnDecider, TEAM_TERMINAL_HOOK } from '../pi-session/finish-turn';
import { runUsageMeter, sameAgentUsage } from '../pi-session/session-usage';
import { emptyAgentUsage } from '../../shared/usage-accounting';
import { joinResultText } from '../pi-session/tool-result-text';
import { mapPiToolName, normalizeToolInput } from '../pi-session/tool-normalization';
import { extractImages } from '../pi-session/branch-text';
import { ToolOutputCoalescer } from '../pi-session/tool-output-coalescer';
import { NestedCallFailures, failedCallError } from '../pi-session/nested-call-failures';
import { abandonReasonOf } from '../pi-session/abandoned-tool-calls';
import { turnStoppedToolCallIds, windDownRecorded } from '../pi-session/session-store/turn-stopped';
import { failureOutcomeText } from '../pi-session/subagents/status-note';
import { assistantContentBlocks, skippedCallIds, toolResultBlock, type PiAssistantBlock } from './content-blocks';

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

/** The assistant message streaming now: its card id, and whether any of it reached the card. */
interface CurrentCall {
  id: string;
  rendered: boolean;
  /** The latest sealed assistant message, the ids of its calls pi reported a result for, and those an abort settled before they ran. */
  batch: { messageId: string; content: ReadonlyArray<PiAssistantBlock>; answered: Set<string>; unexecuted: Set<string> } | null;
  /** The calls this session's turn-stopped entries name. */
  stopped: Set<string>;
  /** An error stop, sealed at its `turn_end` once the wind-down record decides it. */
  undecidedError: AssistantMessage | null;
}

/** What `handleSessionEvent` reports a member session's events to. */
interface SessionEventCallbacks {
  onToolUse: (name: string) => void;
  onAssistantText: (text: string) => void;
  /** Called on each assistant `message_end` and `compaction_end`: the points pi's session totals change. */
  onUsage: () => void;
  call: CurrentCall;
  /** The session's branch, whose turn-stopped record tells an abort's wind-down error from a failure (`windDownRecorded`). */
  branch: () => ReturnType<AgentSession['sessionManager']['getBranch']>;
  /** Each model call's end: its error, if it failed, the card id of what it rendered, and whether it was an abort's wind-down. */
  onCallEnd: (error: string | undefined, shownId: string | undefined, windDown: boolean) => void;
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
    const empty = (status: 'cancelled' | 'failed', finalResponse: string | null): AgentResult => ({
      agentId: config.agentId,
      status,
      finalResponse,
      toolCallCount: 0,
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

    return this.runAgent(config, session, inbox, release);
  }

  private async runAgent(
    config: AgentRunConfig,
    session: AgentSession,
    inbox: RunInbox,
    release: () => void,
  ): Promise<AgentResult> {
    let toolCallCount = 0;
    let finalResponse: string | null = null;
    let status: 'completed' | 'failed' | 'cancelled' = 'completed';
    /** The error the latest model call ended on; a call pi retries is answered by a later one, which clears it. */
    let callError: string | undefined;
    let failure: string | null = null;
    const call: CurrentCall = { id: '', rendered: false, batch: null, stopped: new Set(), undecidedError: null };
    const failures = new NestedCallFailures({
      show: (message) => config.onMessage({ type: 'error', message, parentToolUseId: config.agentId }),
      withdraw: (messageId) => config.onMessage({ type: 'assistantRetracted', messageId, parentToolUseId: config.agentId }),
      retrying: (attempt, maxAttempts) => config.onMessage({ type: 'statusUpdate', status: 'retrying', attempt, maxAttempts, parentToolUseId: config.agentId }),
      retryEnded: () => config.onMessage({ type: 'statusUpdate', status: 'ready', parentToolUseId: config.agentId }),
    });
    // pi retries a failed call inside `prompt()`, so once it resolves the latest call's error is final.
    const endedOnFailure = (): boolean => {
      if (callError === undefined || config.abortSignal.aborted) return false;
      failure = callError;
      return true;
    };
    // A reopened session's stats include the spend of its earlier runs, which were already counted.
    const runUsage = runUsageMeter(session);
    let usage = emptyAgentUsage();
    let lastRolledCost = 0;
    const publishUsage = (): void => {
      const next = runUsage();
      if (sameAgentUsage(next, usage)) return;
      usage = next;
      config.onUsageUpdate?.({
        inputTokens: usage.totalInputTokens,
        outputTokens: usage.totalOutputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        costUsd: usage.costUsd,
      });
      const delta = usage.costUsd - lastRolledCost;
      if (delta > 0) {
        lastRolledCost = usage.costUsd;
        config.onCost?.(delta);
      }
    };

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
      failures.observe(event);
      this.handleSessionEvent(event, config, outputCoalescer, {
        onToolUse: (name) => {
          toolCallCount++;
          config.onToolCall?.(name, toolCallCount);
        },
        onAssistantText: (text) => { finalResponse = text; },
        onUsage: publishUsage,
        call,
        branch: () => session.sessionManager.getBranch(),
        onCallEnd: (error, shownId, windDown) => {
          callError = error;
          if (error !== undefined && !windDown) failures.hold(error, shownId);
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
        this.emitRunning(config);
        // The opening task — emitted to the webview + persisted as the first user message.
        this.emitUserMessage(config, config.initial.text);
        await session.prompt(config.initial.text);
      }

      // Event-driven wait/re-prompt loop — no timers. After each turn: re-prompt with the next pending
      // message; else, if the agent must keep waiting, idle until a message arrives or it must abort.
      while (!config.abortSignal.aborted && !endedOnFailure()) {
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
      if (config.abortSignal.aborted) status = 'cancelled';
      else failure = err instanceof Error ? err.message : String(err);
    } finally {
      waitResolve = null;
      release();
      unsubscribeSession();
      outputCoalescer.dispose();
      config.abortSignal.removeEventListener('abort', onAbort);
      config.forgetSession(session);
    }
    // Settle: picks up spend that raised no event, such as a cache warm between turns.
    publishUsage();
    if (failure !== null) {
      status = 'failed';
      config.messageBus.broadcast('system', `Agent "${config.name}" failed: ${failure}`);
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

    if (failure !== null) {
      return { agentId: config.agentId, status, finalResponse: failureOutcomeText(failure, finalResponse), error: failure, toolCallCount, ...usage };
    }
    return { agentId: config.agentId, status, finalResponse, toolCallCount, ...usage };
  }

  /** Map one pi session event to the existing `team*` webview messages (no contract change). */
  private handleSessionEvent(
    event: AgentSessionEvent,
    config: AgentRunConfig,
    outputCoalescer: ToolOutputCoalescer<ExtensionToWebviewMessage>,
    cb: SessionEventCallbacks,
  ): void {
    switch (event.type) {
      case 'message_start':
        if (event.message.role === 'assistant') {
          cb.call.id = crypto.randomUUID();
          cb.call.rendered = false;
        }
        break;
      case 'message_update':
        if (this.handleAssistantDelta(event.assistantMessageEvent, config)) cb.call.rendered = true;
        break;
      case 'message_end':
        if (event.message.role === 'assistant') {
          // pi reports a failed call only here; whether it was an abort's wind-down is known at its turn_end.
          if (event.message.stopReason === 'error') cb.call.undecidedError = event.message;
          else this.endCall(event.message, config, cb, false);
          // pi persists the message after notifying listeners, so its stats include it only from the next microtask.
          queueMicrotask(cb.onUsage);
        }
        break;
      // pi emits it after every error stop (`agent-loop.js:141-152`, `agent.js:375-378` in pi-agent-core 1.1.0), once it
      // committed the record `registerWindDownErrorRecord` returns at that boundary (`agent-session.js:515`, `:636-641`).
      case 'turn_end': {
        const failed = cb.call.undecidedError;
        if (!failed) break;
        cb.call.undecidedError = null;
        this.endCall(failed, config, cb, windDownRecorded(cb.branch(), failed));
        break;
      }
      case 'compaction_end':
        cb.onUsage();
        break;
      // `registerAbortSettledCallRecord` appends it before listeners get the call's `tool_execution_end`.
      case 'entry_appended':
        for (const id of turnStoppedToolCallIds(event.entry)) cb.call.stopped.add(id);
        break;
      // A call counts when pi starts it: a blocked call is started, a call of a failed, aborted or cut-short batch is not.
      case 'tool_execution_start': {
        const toolName = mapPiToolName(event.toolName);
        cb.onToolUse(toolName);
        // normalizeToolInput switches on the raw pi name.
        const toolInput = normalizeToolInput(event.toolName, (event.args ?? {}) as Record<string, unknown>);
        config.onMessage({ type: 'teamAgentToolCall', teamId: config.teamId, agentId: config.agentId, toolName, toolInput });
        break;
      }
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
        cb.call.batch?.answered.add(event.toolCallId);
        if (cb.call.stopped.has(event.toolCallId) && event.durationMs === undefined && cb.call.batch) {
          cb.call.batch.unexecuted.add(event.toolCallId);
          this.resealStopped(cb.call.batch, cb.call.batch.unexecuted, config);
          break;
        }
        // The team path has no `toolMetadata` message, so the result's details ride on this one or reach the card never.
        const block = toolResultBlock(event.toolCallId, event.result, event.isError === true);
        config.onMessage({
          type: 'teamAgentToolResult', teamId: config.teamId,
          agentId: config.agentId,
          toolUseId: event.toolCallId,
          result: block.content,
          isError: block.is_error === true,
          ...(block.imageCount !== undefined ? { imageCount: block.imageCount } : {}),
          ...(block.metadata ? { metadata: block.metadata } : {}),
        });
        break;
      }
      default:
        break;
    }
  }

  /**
   * Seal one model call's message and report its end. pi ends its turn before running any tool a failed or aborted call
   * named; `windDown` marks an error stop the turn-stopped record names, handled as an aborted stop.
   */
  private endCall(
    message: AssistantMessage,
    config: AgentRunConfig,
    cb: SessionEventCallbacks,
    windDown: boolean,
  ): void {
    const messageId = cb.call.id || crypto.randomUUID();
    cb.call.id = '';
    const failed = message.stopReason === 'error';
    const abandoned = windDown ? 'stopped' : abandonReasonOf(message.stopReason);
    if (abandoned === 'stopped' && cb.call.batch) this.resealSkipped(cb.call.batch, config);
    const sealed = this.emitAssistant(message.content, config, cb, messageId, failed, abandoned);
    cb.call.batch = sealed ? { messageId, content: message.content, answered: new Set(), unexecuted: new Set() } : null;
    cb.onCallEnd(failed ? failedCallError(message.errorMessage) : undefined, sealed || cb.call.rendered ? messageId : undefined, windDown);
  }

  /** Stream text/thinking deltas into the agent card via the existing `teamAgentStreamDelta` message. */
  private handleAssistantDelta(
    ame: AssistantMessageEvent,
    config: AgentRunConfig,
  ): boolean {
    if (ame.type === 'text_delta') {
      config.onMessage({ type: 'teamAgentStreamDelta', teamId: config.teamId, agentId: config.agentId, deltaType: 'text', text: ame.delta });
      return true;
    }
    if (ame.type === 'thinking_delta') {
      config.onMessage({ type: 'teamAgentStreamDelta', teamId: config.teamId, agentId: config.agentId, deltaType: 'thinking', text: ame.delta });
      return true;
    }
    return false;
  }

  /**
   * Seal one completed assistant message: emit `teamAgentAssistant`. A failed call's text is not the agent's
   * response; the tool calls of a failed or aborted call never ran, so they show on the card marked not executed.
   */
  private emitAssistant(
    content: ReadonlyArray<PiAssistantBlock> | undefined,
    config: AgentRunConfig,
    cb: { onAssistantText: (text: string) => void },
    messageId: string,
    failed: boolean,
    abandoned: ToolAbandonReason | undefined,
  ): boolean {
    if (!content) return false;

    const blocks = assistantContentBlocks(content, abandoned);
    for (const b of failed ? [] : blocks) {
      if (b.type === 'text') cb.onAssistantText(b.text);
    }
    if (blocks.length === 0) return false;

    config.onMessage({
      type: 'teamAgentAssistant', teamId: config.teamId, agentId: config.agentId,
      messageId,
      content: blocks,
      timestamp: Date.now(),
    });
    return true;
  }

  /** Re-seal a batch the following aborted call cut short, once its skipped calls are known. */
  private resealSkipped(batch: NonNullable<CurrentCall['batch']>, config: AgentRunConfig): void {
    const skipped = skippedCallIds(batch.content, (toolCallId) => batch.answered.has(toolCallId));
    if (skipped.size === 0) return;
    this.resealStopped(batch, new Set([...skipped, ...batch.unexecuted]), config);
  }

  /**
   * Re-send a sealed message under its id with the calls an abort cut short `stopped`: the blocks
   * `memberHistoryMessages` builds for it, so the store's merge matches the live copy.
   */
  private resealStopped(batch: NonNullable<CurrentCall['batch']>, stopped: ReadonlySet<string>, config: AgentRunConfig): void {
    config.onMessage({
      type: 'teamAgentAssistant', teamId: config.teamId, agentId: config.agentId,
      messageId: batch.messageId,
      content: assistantContentBlocks(batch.content, undefined, stopped),
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

  // The team runner emits the settled status, with the attempt's stopwatch.
  private emitRunning(config: AgentRunConfig): void {
    config.onMessage({ type: 'teamAgentStatusUpdate', teamId: config.teamId, agentId: config.agentId, status: 'running' });
  }
}
