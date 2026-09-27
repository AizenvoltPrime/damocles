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
 */
export function watchPromptEntry(session: AgentSession): PromptEntryWatch {
  let armed = false;
  let prompt: unknown;
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (armed && prompt === undefined && event.type === 'message_end' && event.message.role === 'user') prompt = event.message;
  });
  return {
    preflightResult: (accepted) => {
      armed = accepted && !session.isStreaming;
    },
    entry: () => {
      if (prompt === undefined) return null;
      const sm = session.sessionManager;
      const found = sm.getBranch(sm.getLeafId() ?? undefined).find((e) => e.type === 'message' && e.message === prompt);
      return found ? { id: found.id, text: piMessageText((prompt as { content?: unknown }).content) } : null;
    },
    dispose: unsubscribe,
  };
}
