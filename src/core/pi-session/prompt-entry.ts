import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { piMessageText } from './branch-text';

/** The user entry one `prompt()` call committed. */
export interface PromptEntry {
  id: string;
  text: string;
}

export interface PromptEntryWatch {
  /** Pass as `prompt()`'s `preflightResult`. */
  preflightResult: (accepted: boolean) => void;
  /** Null when the call committed no user entry of its own: pi queued it into a running run, or ran it as a command. */
  entry: () => PromptEntry | null;
  dispose: () => void;
}

/**
 * Finds the user entry a `prompt()` call commits by message identity, since a batch or cancel note
 * steered into the same run commits after it. Relies on pi calling `preflightResult(true)` right before
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
    preflightResult: (accepted) => {
      armed = accepted && !session.isStreaming;
    },
    entry,
    dispose: unsubscribe,
  };
}
