// The folder each project's views show (D31): its selected chat's working folder, or the project folder after Show project
// folder until another chat is selected. Files, Search, Quick Open, source control, the Repositories section and new
// terminals read it; slice 13's Graph reads the selected repository of its root's source control view.
import type { Disposable } from '../../../platform/disposable';
import type { WorktreeStateData } from '../../../shared/types/messages';
import { rootKey } from '../../preload/folder-root';
import type { ChatWorktreeRecord } from '../../../core/worktrees/registry';
import type { NewChatInWorktreeRequest, ShownFolder, ShownWorktree, WorktreeFinishState } from '../../preload/shell-channels';
import type { RootProject, WorktreeRoots } from './roots';

// A project's selected chat as core last reported it.
export interface SelectedChatPlace {
  readonly chatId: string;
  // the chat's worktree, live or not; absent for a chat that has none
  readonly worktreeId?: string;
  readonly state?: WorktreeStateData;
}

export interface ShownFolderDeps {
  readonly roots: WorktreeRoots;
  readonly selectedChat: (projectKey: string) => SelectedChatPlace | undefined;
  readonly finish: (worktree: RootProject) => WorktreeFinishState;
  // New Chat in This Worktree's target, by the rule the Chats rows follow; undefined while it is unavailable
  readonly newChatIn: (record: ChatWorktreeRecord) => NewChatInWorktreeRequest | undefined;
}

type Show = 'project' | 'worktree';

export class ShownFolderState {
  private readonly deps: ShownFolderDeps;
  // Show project folder or Show worktree, for the chat that was selected then
  private readonly overrides = new Map<string, { readonly chatId: string; readonly show: Show }>();
  private readonly published = new Map<string, { readonly text: string; readonly rootKey: string }>();
  private readonly listeners = new Set<(shown: ShownFolder, rootChanged: boolean) => void>();

  constructor(deps: ShownFolderDeps) {
    this.deps = deps;
  }

  get(projectKey: string): ShownFolder | undefined {
    const project = this.deps.roots.resolve(projectKey);
    if (!project || project.root.worktreeId !== undefined) return undefined;
    const selected = this.deps.selectedChat(projectKey);
    const worktree = selected?.worktreeId !== undefined ? this.deps.roots.resolve(rootKey({ projectKey, worktreeId: selected.worktreeId })) : undefined;
    if (!selected || !worktree?.worktree) return shownRoot(project);
    const place = selected.state?.place ?? 'worktree';
    const override = this.overrides.get(projectKey);
    const show = override?.chatId === selected.chatId ? override.show : place;
    const state = selected.state;
    const newChatIn = this.deps.newChatIn(worktree.worktree);
    const info: ShownWorktree = {
      worktreeId: worktree.worktree.id,
      chatId: selected.chatId,
      branch: state?.branch ?? worktree.worktree.branch,
      ...(state?.baseBranch !== undefined ? { baseBranch: state.baseBranch } : {}),
      behind: state?.behind ?? 0,
      targetRewritten: state?.targetRewritten === true,
      place,
      finish: this.deps.finish(worktree),
      ...(newChatIn ? { newChatIn } : {}),
    };
    return { ...shownRoot(show === 'worktree' ? worktree : project), projectKey, worktree: info, canShowWorktree: true };
  }

  /** Every open project's, by project key. */
  all(): Record<string, ShownFolder> {
    const result: Record<string, ShownFolder> = {};
    for (const root of this.deps.roots.projectRoots()) {
      const shown = this.get(root.key);
      if (shown) result[root.key] = shown;
    }
    return result;
  }

  /** The root key of the project's shown folder; the project's own key when it is not open. */
  rootKeyOf(projectKey: string): string {
    return this.get(projectKey)?.rootKey ?? projectKey;
  }

  /** Show project folder or Show worktree; false when the project's selected chat has no live worktree to switch with. */
  show(projectKey: string, show: Show): boolean {
    const shown = this.get(projectKey);
    if (!shown?.worktree) return false;
    this.overrides.set(projectKey, { chatId: shown.worktree.chatId, show });
    this.refresh();
    return true;
  }

  /**
   * Recomputes every project's shown folder and announces those that changed; rootChanged only when the folder shown did,
   * not when only its worktree's facts (its chats working, the branch behind) did.
   */
  refresh(): void {
    for (const [key, override] of [...this.overrides]) if (this.deps.selectedChat(key)?.chatId !== override.chatId) this.overrides.delete(key);
    const current = this.all();
    for (const key of [...this.published.keys()]) if (!(key in current)) this.published.delete(key);
    for (const [key, shown] of Object.entries(current)) {
      const text = JSON.stringify(shown);
      const previous = this.published.get(key);
      if (previous?.text === text) continue;
      this.published.set(key, { text, rootKey: shown.rootKey });
      const rootChanged = previous?.rootKey !== shown.rootKey;
      for (const listener of [...this.listeners]) listener(shown, rootChanged);
    }
  }

  onDidChange(listener: (shown: ShownFolder, rootChanged: boolean) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
}

function shownRoot(root: RootProject): Omit<ShownFolder, 'worktree'> {
  return { projectKey: root.root.projectKey, root: root.root, rootKey: root.key, fsPath: root.fsPath, canShowWorktree: false };
}
