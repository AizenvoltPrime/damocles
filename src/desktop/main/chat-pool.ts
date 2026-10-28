import { holdsWorktreeSetup } from '../../shared/chat-retention';
import type { WorktreePhase } from '../../shared/types/messages';

// Which loaded chats stay loaded (plan AD8): the selected chat, every active or restoring chat and the most recently viewed idle chats
// that hold a stored session. Everything here is pure except ChatWorkQueue.

export const RETAINED_IDLE_CHATS = 3;

export interface PooledChat {
  readonly id: string;
  readonly selected: boolean;
  // streaming, waiting on the user, running subagents or a team, or holding open browser pages
  readonly active: boolean;
  // its saved state names a stored session core has not bound yet
  readonly restoring: boolean;
  // the chat is bound to a session file, so it resumes from disk once unloaded
  readonly hasSession: boolean;
  // the chat has no conversation at all (a new chat the user never wrote in)
  readonly empty: boolean;
  // higher = viewed more recently
  readonly lastViewed: number;
  // the chat's worktree phase as core last reported it; undefined for a chat with none
  readonly worktreePhase?: WorktreePhase;
  // a remote chat's messages held while its host was away, or not sent: an unload would drop the page that shows them
  readonly holdsMessages?: boolean;
}

/** The ids of the chats to unload, given every loaded chat. */
export function chatsToUnload(chats: readonly PooledChat[], retainedIdle: number = RETAINED_IDLE_CHATS): string[] {
  const unload: string[] = [];
  const idleWithSession: PooledChat[] = [];
  for (const chat of chats) {
    if (chat.selected || chat.active || chat.restoring || chat.holdsMessages === true || holdsWorktreeSetup(chat.worktreePhase)) continue;
    if (chat.empty) unload.push(chat.id);
    else if (chat.hasSession) idleWithSession.push(chat);
  }
  idleWithSession.sort((a, b) => b.lastViewed - a.lastViewed);
  for (const chat of idleWithSession.slice(retainedIdle)) unload.push(chat.id);
  return unload;
}

/**
 * The chats core was asked to unload and has not answered for. Core may close such a chat's page whenever its answer comes
 * (a drop holds it until the resume), so none is shown meanwhile: a show waits for the answer and is dropped when another
 * chat was shown since.
 */
export class ChatUnloads<C> {
  private readonly asked = new Map<C, Promise<void>>();
  // the show that waits, until another show replaces it
  private waiting: object | undefined;

  /** Asks core to unload the chat; until the answer settles, the chat counts as unloading. */
  unload<T>(chat: C, ask: () => Promise<T>): Promise<T> {
    const answer = ask();
    const settled = answer.then(() => undefined, () => undefined);
    this.asked.set(chat, settled);
    void settled.then(() => {
      if (this.asked.get(chat) === settled) this.asked.delete(chat);
    });
    return answer;
  }

  /** A show of the chat: false when nothing is unloading it, so it shows now; else then runs once core answered. */
  defer(chat: C, then: () => void): boolean {
    const settled = this.asked.get(chat);
    const show = {};
    this.waiting = settled ? show : undefined;
    if (!settled) return false;
    void settled.then(() => {
      if (this.waiting !== show) return;
      this.waiting = undefined;
      then();
    });
    return true;
  }
}

/** Runs work for one chat after the work queued for it before has settled; chats do not wait on each other. */
export class ChatWorkQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(chatId) ?? Promise.resolve();
    const result = previous.then(work);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(chatId, tail);
    void tail.then(() => {
      if (this.tails.get(chatId) === tail) this.tails.delete(chatId);
    });
    return result;
  }
}
