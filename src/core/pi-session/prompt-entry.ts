import type { ImageContent } from '@earendil-works/pi-ai';
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
  const entry = (): PromptEntry | null => (prompt === undefined ? null : committedEntry(session, prompt));
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (!armed || prompt !== undefined || event.type !== 'message_end' || event.message.role !== 'user') return;
    prompt = event.message;
    if (onCommitted) whenCommitted(session, event.message, onCommitted);
  });
  return {
    preflightResult: (disposition) => {
      armed = disposition === 'started';
    },
    entry,
    dispose: unsubscribe,
  };
}

/** The entry pi committed for `message`, found by identity, since pi persists the delivered object itself. */
function committedEntry(session: AgentSession, message: unknown): PromptEntry | null {
  const sm = session.sessionManager;
  const found = sm.getBranch(sm.getLeafId() ?? undefined).find((e) => e.type === 'message' && e.message === message);
  return found ? { id: found.id, text: piMessageText((message as { content?: unknown }).content) } : null;
}

/** Call from a `message_end` listener: pi appends the message right after notifying listeners, so a microtask later its entry exists. */
function whenCommitted(session: AgentSession, message: unknown, onCommitted: (entry: PromptEntry) => void): void {
  queueMicrotask(() => {
    const committed = committedEntry(session, message);
    if (committed) onCommitted(committed);
  });
}

export interface QueuedPromptHandlers {
  onCommitted: (entry: PromptEntry) => void;
  /** pi's queue was dropped before pi delivered the prompt, so it never commits. */
  onWithdrawn: () => void;
}

/** A follow-up to put back after `clearQueue()`, with the content it was queued with. */
export interface RequeuedFollowUp {
  text: string;
  images: readonly ImageContent[];
  /** True once the prompt it puts back was withdrawn, so pi must not deliver it. */
  withdrawn: () => boolean;
}

/** One prompt `add` recorded, as pi queued it. */
export interface QueuedPrompt {
  readonly text: string;
}

export interface QueuedPromptEntries {
  /** Call from `preflightResult('queued')` with the images `prompt()` was given. */
  add: (session: AgentSession, images: readonly ImageContent[], handlers: QueuedPromptHandlers) => QueuedPrompt | undefined;
  /** Call for each user message pi delivers on `session`, from its `message_end`; true when it was a queued prompt, whose `onCommitted` then runs. */
  claim: (session: AgentSession, deliveredText: string, message: unknown) => boolean;
  /** The follow-ups `clearQueue()` returned on `session`, each with the images of the prompt it matches; a text no prompt matches goes back as text. */
  requeue: (session: AgentSession, followUp: readonly string[]) => RequeuedFollowUp[];
  /** Call when pi's queue is dropped rather than delivered: each prompt pending on `session`, or on any session, is withdrawn oldest first. */
  withdraw: (session?: AgentSession) => void;
  /** Withdraws `queued` alone, once, however many prompts share its text. */
  withdrawOne: (queued: QueuedPrompt) => void;
}

/**
 * Prompts pi queued as follow-ups of a running run, each waiting for the entry pi commits when it delivers it.
 * pi hands back only the text of a queued message, and a re-steer re-queues a follow-up as a new message with the same text,
 * so a delivery and a re-queue are matched by text, oldest first, as pi itself matches deliveries against its queue.
 */
export function queuedPromptEntries(): QueuedPromptEntries {
  interface Pending extends QueuedPromptHandlers {
    session: AgentSession;
    text: string;
    images: readonly ImageContent[];
  }
  let pending: Pending[] = [];
  return {
    add: (session, images, handlers) => {
      // pi pushes the prompt's expanded text onto its follow-up list right before it reports `queued`.
      const text = session.getFollowUpMessages().at(-1);
      if (text === undefined) return undefined;
      const queued: Pending = { session, text, images, ...handlers };
      pending.push(queued);
      return queued;
    },
    claim: (session, deliveredText, message) => {
      // A replaced session delivers nothing more to this panel.
      pending = pending.filter((queued) => queued.session === session);
      const index = pending.findIndex((queued) => queued.text === deliveredText);
      const claimed = index === -1 ? undefined : pending.splice(index, 1)[0];
      if (claimed) whenCommitted(session, message, claimed.onCommitted);
      return claimed !== undefined;
    },
    requeue: (session, followUp) => {
      const unmatched = pending.filter((queued) => queued.session === session);
      return followUp.map((text) => {
        const index = unmatched.findIndex((queued) => queued.text === text);
        const queued = index === -1 ? undefined : unmatched.splice(index, 1)[0];
        return queued
          ? { text, images: queued.images, withdrawn: () => !pending.includes(queued) }
          : { text, images: [], withdrawn: () => false };
      });
    },
    withdraw: (session) => {
      const withdrawn = pending.filter((queued) => session === undefined || queued.session === session);
      pending = pending.filter((queued) => !withdrawn.includes(queued));
      for (const queued of withdrawn) queued.onWithdrawn();
    },
    withdrawOne: (queued) => {
      const entry = pending.find((candidate) => candidate === queued);
      if (!entry) return;
      pending = pending.filter((candidate) => candidate !== entry);
      entry.onWithdrawn();
    },
  };
}
