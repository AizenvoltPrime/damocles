import { stripBidiControls } from '../untrusted-text';

/** Newlines are meaningful in the note box and must survive, so only bidi controls are stripped. */
export function sanitizeCancelNote(note: string): string {
  return stripBidiControls(note).trim();
}

/** A user cancellation of one shell call. `note` is absent when the user sent none. */
export interface ShellCancellation {
  note?: string;
}

interface ShellCancelEntry {
  controller: AbortController;
  /** The delivery of the context that opened this entry, so a note reaches the agent that ran the call. */
  deliverUserNote: (text: string) => void;
  /** `admitted` from gate entry until execute adopts the entry, then `executing`. */
  phase: 'admitted' | 'executing';
  /** Present only once `cancel()` ran for this call, which is how a user cancel is told from a run abort. */
  cancellation?: ShellCancellation;
  /** Removes the run-abort listener an admitted entry holds. */
  detachRunAbort?: () => void;
}

/**
 * One build context's handle on the shared store. It can only be obtained by naming a note delivery,
 * so no context can open a cancellable call that cannot receive the user's note.
 */
export interface ShellCancelRegistry {
  /**
   * Open the call's cancel entry at gate entry. Returns the signal a Stop aborts, or `undefined` when
   * the run is already aborted. The entry is dropped if `runSignal` aborts before `adopt`, because pi
   * never executes a call of an aborted run.
   */
  admit(toolCallId: string, runSignal: AbortSignal | undefined): AbortSignal | undefined;
  /** Drop the entry only while it is still admitted: the gate blocked the call, or it ended unexecuted. */
  releaseAdmitted(toolCallId: string): void;
  /** Take over the call's admitted entry for execution, or open one when the call was never admitted. */
  adopt(toolCallId: string): AbortController;
  release(toolCallId: string): void;
  /** The cancellation record when this call was cancelled by the user, else `undefined`. Reads once. */
  takeCancellation(toolCallId: string): ShellCancellation | undefined;
}

/**
 * The per-call abort controllers of the shell calls the UI can stop, keyed by pi `toolCallId`.
 *
 * One instance per `PiSession` serves the main session, subagents and team agents, because all three
 * run in one panel and all three carry the pi `toolCallId` as their webview `ToolCall.id`. An entry
 * lives from gate entry (`admit`) to the end of execute, most of the time the card shows Stop (a Stop
 * outside it is rejected), so two agents cannot collide on an id and one `cancel()` finds a call
 * whichever agent is running it.
 * Each context takes its own `forContext` handle, so the entry remembers where that agent's note has
 * to be delivered. The gate's handle and the tools' handle for one context may be different objects:
 * an adopted entry keeps the delivery it was admitted with, so the two need only equivalent deliveries.
 *
 * Cancelling here can never reach the run-level abort: the wrapper links the two signals with
 * `AbortSignal.any`, which propagates one way only.
 */
export class ShellCancelStore {
  private readonly entries = new Map<string, ShellCancelEntry>();

  /** The handle for one build context, bound to the agent that context's calls run in. */
  forContext(deliverUserNote: (text: string) => void): ShellCancelRegistry {
    return {
      admit: (toolCallId, runSignal) => {
        if (runSignal?.aborted) return undefined;
        const entry: ShellCancelEntry = { controller: new AbortController(), deliverUserNote, phase: 'admitted' };
        if (runSignal) {
          const onRunAbort = (): void => this.dropAdmitted(toolCallId, entry);
          runSignal.addEventListener('abort', onRunAbort, { once: true });
          entry.detachRunAbort = () => runSignal.removeEventListener('abort', onRunAbort);
        }
        this.entries.set(toolCallId, entry);
        return entry.controller.signal;
      },
      releaseAdmitted: (toolCallId) => {
        const entry = this.entries.get(toolCallId);
        if (entry) this.dropAdmitted(toolCallId, entry);
      },
      adopt: (toolCallId) => {
        const admitted = this.entries.get(toolCallId);
        if (admitted?.phase === 'admitted') {
          admitted.detachRunAbort?.();
          delete admitted.detachRunAbort;
          admitted.phase = 'executing';
          return admitted.controller;
        }
        const entry: ShellCancelEntry = { controller: new AbortController(), deliverUserNote, phase: 'executing' };
        this.entries.set(toolCallId, entry);
        return entry.controller;
      },
      release: (toolCallId) => {
        this.entries.get(toolCallId)?.detachRunAbort?.();
        this.entries.delete(toolCallId);
      },
      takeCancellation: (toolCallId) => {
        const entry = this.entries.get(toolCallId);
        const cancellation = entry?.cancellation;
        if (!entry || !cancellation) return undefined;
        delete entry.cancellation;
        return cancellation;
      },
    };
  }

  /** `false` when the id is unknown or already cancelled, so a repeat Stop click queues no second user turn. */
  cancel(toolCallId: string, note?: string): boolean {
    const entry = this.entries.get(toolCallId);
    if (!entry || entry.cancellation) return false;
    const sanitized = note === undefined ? '' : sanitizeCancelNote(note);
    entry.cancellation = sanitized ? { note: sanitized } : {};
    entry.controller.abort();
    // Delivery runs after the abort so it can never sit between the user's click and the process dying.
    if (sanitized) entry.deliverUserNote(sanitized);
    return true;
  }

  /** Drop every entry. Each one closes over its build context, so a call whose promise never settles
   *  would otherwise keep a disposed session, subagent manager and message bus reachable for good. */
  clear(): void {
    for (const entry of this.entries.values()) entry.detachRunAbort?.();
    this.entries.clear();
  }

  private dropAdmitted(toolCallId: string, entry: ShellCancelEntry): void {
    if (entry.phase !== 'admitted' || this.entries.get(toolCallId) !== entry) return;
    entry.detachRunAbort?.();
    this.entries.delete(toolCallId);
  }
}
