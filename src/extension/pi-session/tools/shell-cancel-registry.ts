import { stripBidiControls } from '../untrusted-text';

/** Mirrored by `maxlength` on the webview note textarea; this one is the cap that actually holds. */
export const MAX_CANCEL_NOTE_CHARS = 500;

/** Newlines are meaningful in the note box and must survive; only bidi controls are stripped, and the cap is applied last so it counts what survives. */
export function sanitizeCancelNote(note: string): string {
  const stripped = stripBidiControls(note).trim();
  return stripped.length > MAX_CANCEL_NOTE_CHARS ? `${stripped.slice(0, MAX_CANCEL_NOTE_CHARS)}…` : stripped;
}

/** A user cancellation of one shell call. `note` is absent when the user sent none. */
export interface ShellCancellation {
  note?: string;
}

interface ShellCancelEntry {
  controller: AbortController;
  /** The delivery of the context that registered this call, so a note reaches the agent that ran it. */
  deliverUserNote: (text: string) => void;
  /** Present only once `cancel()` ran for this call, which is how a user cancel is told from a run abort. */
  cancellation?: ShellCancellation;
}

/** One build context's handle for its shell tools' per-call abort controllers; it can only be obtained by naming a note delivery, so a shell tool cannot be built in a context that cannot receive the user's note. */
export interface ShellCancelRegistry {
  register(toolCallId: string, controller: AbortController): void;
  release(toolCallId: string): void;
  /** The cancellation record when this call was cancelled by the user, else `undefined`. Reads once. */
  takeCancellation(toolCallId: string): ShellCancellation | undefined;
}

/**
 * The per-call abort controllers of the shell tools currently executing, keyed by pi `toolCallId`.
 *
 * One instance per `PiSession` serves the main session, subagents and team agents, because all three
 * run in one panel and all three carry the pi `toolCallId` as their webview `ToolCall.id`. Entries
 * exist only while a call executes, so two agents cannot collide on an id, and one `cancel()` finds a
 * call whichever agent is running it. Each context takes its own `forContext` handle, so the entry
 * remembers where that agent's note has to be delivered.
 *
 * Cancelling here can never reach the run-level abort: the wrapper links the two signals with
 * `AbortSignal.any`, which propagates one way only.
 */
export class ShellCancelStore {
  private readonly entries = new Map<string, ShellCancelEntry>();

  /** The handle for one `buildCustomTools` context, bound to the agent that context's tools run in. */
  forContext(deliverUserNote: (text: string) => void): ShellCancelRegistry {
    return {
      register: (toolCallId, controller) => {
        this.entries.set(toolCallId, { controller, deliverUserNote });
      },
      release: (toolCallId) => {
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
    this.entries.clear();
  }
}
