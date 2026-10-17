// Rule 6: a chat holding its first prompt for its worktree keeps it in panels.json across a window close, a quit and a host
// reload, as its composer draft on the next start.
import type { UserContentBlock } from '../../shared/types/content';

export interface HeldPromptsDeps {
  // the loaded chats, each with its core panel id once core registered it
  readonly chats: () => ReadonlyArray<{ readonly panelId: string; readonly corePanelId: string | undefined }>;
  // the prompt core holds for the chat's worktree
  readonly held: (corePanelId: string) => readonly UserContentBlock[] | undefined;
  readonly store: { setHeldPrompt(panelId: string, heldPrompt: readonly UserContentBlock[] | undefined): void };
}

export class HeldPrompts {
  private readonly deps: HeldPromptsDeps;
  // chats whose kept prompt is not back in their composer yet; core holds nothing for them meanwhile
  private readonly pending = new Set<string>();

  constructor(deps: HeldPromptsDeps) {
    this.deps = deps;
  }

  /** Before the chats close: what core holds is kept, and a chat that holds nothing drops a kept prompt it already put back. */
  keep(): void {
    for (const chat of this.deps.chats()) {
      const held = chat.corePanelId === undefined ? undefined : this.deps.held(chat.corePanelId);
      if (held === undefined && this.pending.has(chat.panelId)) continue;
      this.deps.store.setHeldPrompt(chat.panelId, held);
    }
  }

  /** A start is putting the chat's kept prompt back; until restored, keep leaves it stored. */
  restoring(panelId: string): void {
    this.pending.add(panelId);
  }

  /** The kept prompt is in the chat's composer, so the store forgets it. */
  restored(panelId: string): void {
    this.pending.delete(panelId);
    this.deps.store.setHeldPrompt(panelId, undefined);
  }
}
