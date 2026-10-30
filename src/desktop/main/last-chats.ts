import { authorityKeyOfProject } from '../../shared/project-location';
import { NEW_CHAT_ID_PREFIX } from '../preload/shell-channels';
import type { PersistedSelection } from './panel-state-store';
import type { RemoteSelection } from './remote/remote-state';

export interface LastChatsStores {
  // panels.json, which names a local new chat by its saved panel
  readonly writeLocal: (entries: readonly PersistedSelection[]) => void;
  // remote-state.json, which names only stored chats: a remote panel id does not survive a relaunch
  readonly writeRemote: (authorityKey: string, entries: readonly RemoteSelection[]) => void;
}

/**
 * The chat last viewed in each project, by chat id (a session id, or NEW_CHAT_ID_PREFIX and the panel id), written through to
 * panels.json for a local project and remote-state.json for a remote one, so a relaunch selects it again. null: the project's
 * last viewed chat is gone (deleted, moved to another project, or a new chat that closed or did not survive a relaunch), which
 * an entry naming no chat records on disk; a project with no entry was never viewed.
 */
export class LastChats {
  private readonly byProject = new Map<string, string | null>();
  private readonly stores: LastChatsStores;

  constructor(stores: LastChatsStores) {
    this.stores = stores;
  }

  /** The launch's entries of both files, for projects still listed; writes nothing. */
  seed(entries: readonly PersistedSelection[]): void {
    for (const { projectKey, sessionId, panelId } of entries) {
      const chatId = sessionId ?? (panelId !== undefined ? `${NEW_CHAT_ID_PREFIX}${panelId}` : null);
      if (!this.byProject.has(projectKey)) this.byProject.set(projectKey, chatId);
    }
  }

  /** The project's last viewed chat while it is still one of its chats. */
  get(projectKey: string): string | undefined {
    return this.byProject.get(projectKey) ?? undefined;
  }

  /** undefined: the project was never viewed; null: its last viewed chat is gone. */
  remembered(projectKey: string): string | null | undefined {
    return this.byProject.get(projectKey);
  }

  projects(): string[] {
    return [...this.byProject.keys()];
  }

  remember(projectKey: string, chatId: string): void {
    if (this.byProject.get(projectKey) === chatId) return;
    this.byProject.set(projectKey, chatId);
    this.write([projectKey]);
  }

  /** A new chat's first write gave it its stored id. */
  renamed(from: string, to: string): void {
    this.change((_, chatId) => (chatId === from ? to : chatId));
  }

  /** The chat was deleted, or a new one closed for good. */
  forgetChat(chatId: string): void {
    this.change((_, remembered) => (remembered === chatId ? null : remembered));
  }

  /** The chat works in projectKey now: every other project that remembered it has lost it. */
  chatMoved(chatId: string, projectKey: string): void {
    this.change((key, remembered) => (remembered === chatId && key !== projectKey ? null : remembered));
  }

  forgetProject(projectKey: string): void {
    this.change((key, remembered) => (key === projectKey ? undefined : remembered));
  }

  /** Forget host: remote-state.json drops the authority's entries itself, so only memory changes. */
  forgetAuthority(authorityKey: string): void {
    for (const key of this.projects()) if (authorityKeyOfProject(key) === authorityKey) this.byProject.delete(key);
  }

  // undefined drops the project's entry
  private change(next: (projectKey: string, chatId: string | null) => string | null | undefined): void {
    const changed: string[] = [];
    for (const [projectKey, chatId] of [...this.byProject]) {
      const value = next(projectKey, chatId);
      if (value === chatId) continue;
      if (value === undefined) this.byProject.delete(projectKey);
      else this.byProject.set(projectKey, value);
      changed.push(projectKey);
    }
    this.write(changed);
  }

  private write(projectKeys: readonly string[]): void {
    for (const authority of new Set(projectKeys.map((projectKey) => authorityKeyOfProject(projectKey)))) {
      const entries = [...this.byProject].filter(([projectKey]) => authorityKeyOfProject(projectKey) === authority);
      if (authority === 'local') {
        this.stores.writeLocal(entries.map(([projectKey, chatId]) => {
          if (chatId === null) return { projectKey };
          return chatId.startsWith(NEW_CHAT_ID_PREFIX) ? { projectKey, panelId: chatId.slice(NEW_CHAT_ID_PREFIX.length) } : { projectKey, sessionId: chatId };
        }));
      } else {
        this.stores.writeRemote(authority, entries.map(([projectKey, chatId]) => (chatId === null || chatId.startsWith(NEW_CHAT_ID_PREFIX) ? { projectKey } : { projectKey, sessionId: chatId })));
      }
    }
  }
}

export interface ProjectChat {
  // LastChats.remembered
  readonly remembered: string | null | undefined;
  // shows the chat when it is still a chat of the project, else false
  readonly open: (chatId: string) => Promise<boolean>;
  // the first chat the project's Chats list shows
  readonly topOfList: () => Promise<string | undefined>;
  readonly newChat: () => Promise<void>;
}

/**
 * Selecting a project: its last viewed chat while it exists; once that chat is gone, the top of its Chats list, else a new
 * chat; and a new chat in a project never viewed here.
 */
export async function openProjectChat(project: ProjectChat): Promise<void> {
  const { remembered } = project;
  if (remembered === undefined) return project.newChat();
  if (remembered !== null && (await project.open(remembered))) return;
  const top = await project.topOfList();
  if (top !== undefined && top !== remembered && (await project.open(top))) return;
  await project.newChat();
}
