/**
 * The local chat a remote chat's settings User tab attaches to opens hidden, so the selection stays on the remote chat.
 * Only a local chat core opens while that opening is awaited is held back, and only the one the opening answers stays
 * hidden: any other (a fork, another host's chat) shows as it would have.
 */
export class HiddenOpening<Chat> {
  private held: Chat[] | undefined;
  // the id the opening answers a chat by, which may differ from the chat's own (a core's panel id for a view)
  private readonly idOf: (chat: Chat) => string | undefined;

  constructor(idOf: (chat: Chat) => string | undefined) {
    this.idOf = idOf;
  }

  /** Whether the chat core just opened stays hidden for now; false while no opening runs or for another host's chat. */
  hold(chat: Chat, local: boolean): boolean {
    if (this.held === undefined || !local) return false;
    this.held.push(chat);
    return true;
  }

  /** Whether the chat is held by the opening that runs now. */
  holds(chat: Chat): boolean {
    return this.held?.includes(chat) === true;
  }

  /** Runs the opening; resolves with the panel id it answered and that chat, once every other chat it held is shown. */
  async run(open: () => Promise<string | undefined>, show: (chat: Chat) => void): Promise<{ readonly panelId: string | undefined; readonly chat: Chat | undefined }> {
    const held: Chat[] = [];
    this.held = held;
    let panelId: string | undefined;
    let chat: Chat | undefined;
    try {
      panelId = await open();
    } finally {
      if (this.held === held) this.held = undefined;
      chat = panelId === undefined ? undefined : held.find((candidate) => this.idOf(candidate) === panelId);
      for (const other of held) if (other !== chat) show(other);
    }
    return { panelId, chat };
  }
}
