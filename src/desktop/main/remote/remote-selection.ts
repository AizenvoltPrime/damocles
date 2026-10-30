// Selecting a remote project: Files, Search and terminals move there at once, while the chat view keeps the chat it showed
// until the project's core runs and opens the project's own (docs/invariants.md "Desktop host", chat retention).
import { authorityKeyOfProject } from '../../../shared/project-location';

interface AuthorityChat {
  readonly authority: string;
}

interface SelectionHost<C> {
  // the core while it serves, else undefined
  current(): C | undefined;
  run<T>(label: string, work: (core: C) => T | Promise<T>): Promise<T>;
}

export interface RemoteSelectionDeps<C extends AuthorityChat, V extends AuthorityChat> {
  readonly selectedProject: () => string | undefined;
  readonly selectedChat: () => V | undefined;
  readonly host: (authority: string) => SelectionHost<C> | undefined;
  // moves Files, Search, Quick Open and new terminals to the project and connects its authority; opens no chat
  readonly showProject: (key: string) => void;
  // the project's last viewed chat while it exists, once it is gone the top of its Chats list, else a new chat; never viewed: a new chat
  readonly selectChatOf: (core: C, key: string) => Promise<void>;
}

/** The selected chat unless it is another authority's than the selected project's: the only chat a title may pair with it. */
export function chatOfSelectedProject<V extends AuthorityChat>(projectKey: string | undefined, chat: V | undefined): V | undefined {
  return chat !== undefined && projectKey !== undefined && authorityKeyOfProject(projectKey) !== chat.authority ? undefined : chat;
}

export function remoteSelection<C extends AuthorityChat, V extends AuthorityChat>(deps: RemoteSelectionDeps<C, V>) {
  return {
    /** Selects the remote project, and its chat now when its core runs, else once that core opened its chats. */
    async select(key: string): Promise<void> {
      deps.showProject(key);
      const host = deps.host(authorityKeyOfProject(key));
      if (host?.current()) await host.run('Select Project', (core) => deps.selectChatOf(core, key));
    },

    /** The core reopened its chats: the selected project of its authority gets its chat unless one of that authority shows. */
    async coreOpened(core: C): Promise<void> {
      const key = deps.selectedProject();
      if (key === undefined || authorityKeyOfProject(key) !== core.authority || deps.selectedChat()?.authority === core.authority) return;
      await deps.selectChatOf(core, key);
    },
  };
}
