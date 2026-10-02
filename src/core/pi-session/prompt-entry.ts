import type { AgentSession, AgentSessionEvent, PromptOptions } from '@earendil-works/pi-coding-agent';
import { piMessageText } from './branch-text';

/** How pi dispatched an accepted `prompt()`: `started` opens a run, `queued` joined the running one, `handled` ran nothing. */
export type PromptDisposition = Parameters<NonNullable<PromptOptions['preflightResult']>>[0];

/** The user entry one `prompt()` call committed. */
export interface PromptEntry {
  id: string;
  text: string;
}

export interface PromptEntryWatch {
  /** Pass as `prompt()`'s `preflightResult`. */
  preflightResult: (disposition: PromptDisposition) => void;
  /** Null when the call committed no user entry of its own: pi queued it into a running run, or ran it as a command. */
  entry: () => PromptEntry | null;
  dispose: () => void;
}

/**
 * Finds the user entry a `prompt()` call commits by message identity, since a batch or cancel note
 * steered into the same run commits after it. Relies on pi calling `preflightResult('started')` right before
 * starting the run for an unqueued prompt, that run emitting the prompt as its first user message, and
 * pi persisting that same object as the entry's `message`.
 *
 * `onCommitted` runs once the entry is on the branch: pi appends a message synchronously after notifying
 * listeners of its `message_end`, so one microtask later the entry exists and no model request has gone out.
 */
export function watchPromptEntry(session: AgentSession, onCommitted?: (entry: PromptEntry) => void): PromptEntryWatch {
  let armed = false;
  let prompt: unknown;
  const entry = (): PromptEntry | null => {
    if (prompt === undefined) return null;
    const sm = session.sessionManager;
    const found = sm.getBranch(sm.getLeafId() ?? undefined).find((e) => e.type === 'message' && e.message === prompt);
    return found ? { id: found.id, text: piMessageText((prompt as { content?: unknown }).content) } : null;
  };
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (!armed || prompt !== undefined || event.type !== 'message_end' || event.message.role !== 'user') return;
    prompt = event.message;
    if (!onCommitted) return;
    queueMicrotask(() => {
      const committed = entry();
      if (committed) onCommitted(committed);
    });
  });
  return {
    preflightResult: (disposition) => {
      armed = disposition === 'started';
    },
    entry,
    dispose: unsubscribe,
  };
}
