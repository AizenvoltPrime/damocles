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
}

/** The ids of the chats to unload, given every loaded chat. */
export function chatsToUnload(chats: readonly PooledChat[], retainedIdle: number = RETAINED_IDLE_CHATS): string[] {
  const unload: string[] = [];
  const idleWithSession: PooledChat[] = [];
  for (const chat of chats) {
    if (chat.selected || chat.active || chat.restoring) continue;
    if (chat.empty) unload.push(chat.id);
    else if (chat.hasSession) idleWithSession.push(chat);
  }
  idleWithSession.sort((a, b) => b.lastViewed - a.lastViewed);
  for (const chat of idleWithSession.slice(retainedIdle)) unload.push(chat.id);
  return unload;
}

/** Whether a chat's last reported activity keeps it loaded; `background` stays true until a later event clears it. */
export function isActiveActivity(activity: { readonly state: 'idle' | 'running' | 'requires_action'; readonly background: boolean } | undefined): boolean {
  return activity !== undefined && (activity.state !== 'idle' || activity.background);
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
