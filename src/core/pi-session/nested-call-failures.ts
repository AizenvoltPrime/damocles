import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

/** A failed call's error as every transcript names it, live and reloaded. */
export function failedCallError(errorMessage: unknown): string {
  return typeof errorMessage === 'string' && errorMessage ? errorMessage : 'Unknown error';
}

/**
 * An error stop that ended while its run's signal was aborted: the abort's wind-down, which every transcript treats as
 * an aborted stop, with no error card. `runSignal` is the extension context's signal at the stop's `turn_end`, the
 * run's own (`agent.js:214-216` in pi-agent-core 1.1.0). Only `registerWindDownErrorRecord` reads it; transcripts read
 * the record it writes, so live and reload decide from one observation.
 */
export function isWindDownError(stopReason: unknown, runSignal: AbortSignal | undefined): boolean {
  return stopReason === 'error' && runSignal?.aborted === true;
}

/** Where a nested agent's transcript receives the decisions of `NestedCallFailures`. */
export interface NestedFailureSink {
  /** A failed model call pi will not re-run. */
  show: (message: string) => void;
  /** pi re-runs the failed call, so what the transcript rendered for it under `shownId` goes. */
  withdraw: (shownId: string) => void;
  retrying: (attempt: number, maxAttempts: number) => void;
  retryEnded: () => void;
}

/**
 * The failed-call rule of a subagent or team agent transcript (see "Engine and message contract" in
 * `docs/invariants.md`). A call's error shows only while pi keeps the call in model context: a call pi
 * re-runs, by auto-retry or overflow recovery, is withdrawn with what it rendered whatever the recovery's
 * outcome, because pi omits it from context and a reload (`parseAgentEntries`) drops it.
 */
export class NestedCallFailures {
  private pending: { message: string; shownId: string | undefined } | null = null;
  private waitingOnRetry = false;
  private readonly sink: NestedFailureSink;

  constructor(sink: NestedFailureSink) {
    this.sink = sink;
  }

  /** Every session event, before the caller renders it. */
  observe(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'message_start':
        this.show();
        // pi sends nothing when a retry backoff ends, so the retried call's start ends the wait.
        if (event.message.role === 'assistant') this.endRetryWait();
        break;
      case 'agent_end':
        if (event.willRetry) this.withdraw();
        break;
      case 'auto_retry_start':
        this.waitingOnRetry = true;
        this.sink.retrying(event.attempt, event.maxAttempts);
        break;
      case 'auto_retry_end':
        this.endRetryWait();
        break;
      case 'compaction_start':
        if (event.reason === 'overflow') this.withdraw();
        else this.show();
        break;
      case 'compaction_end':
      case 'agent_settled':
        this.show();
        break;
      default:
        break;
    }
  }

  /** A call that ended on an error stop, rendered under `shownId`, or undefined when it rendered nothing. */
  hold(message: string, shownId: string | undefined): void {
    this.pending = { message, shownId };
  }

  private show(): void {
    const failure = this.pending;
    if (!failure) return;
    this.pending = null;
    this.sink.show(failure.message);
  }

  private withdraw(): void {
    const shownId = this.pending?.shownId;
    this.pending = null;
    if (shownId) this.sink.withdraw(shownId);
  }

  private endRetryWait(): void {
    if (!this.waitingOnRetry) return;
    this.waitingOnRetry = false;
    this.sink.retryEnded();
  }
}
