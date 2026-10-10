import type { Disposable } from './disposable';

export type SettingsScope = 'user' | 'project' | 'local';

export interface SettingInspection<T> {
  readonly defaultValue?: T;
  readonly userValue?: T;
  readonly projectValue?: T;
  // reported only where update(key, value, 'local') can write it, so a settings toggle may write where it reads
  readonly localValue?: T;
}

export interface SettingsChange {
  affects(key: string): boolean;
}

/** The folder a chat reads its settings for (docs/invariants.md "Desktop settings come from three files"). */
export interface SettingsFolder {
  // the chat's working folder; its .damocles/settings.json is the project layer
  readonly path: string;
  // the folder whose .damocles/settings.local.json is the local layer and whose trust gates both layers: a worktree
  // chat's project folder (D34); path when absent
  readonly personalPath?: string;
}

// Keys are full dotted keys ('damocles.explore.model'). A read or write for one chat passes that chat's folder; one
// with no folder is window-level and uses the selected project (desktop) or the workspace (VS Code).
export interface SettingsStore {
  // an object value is merged key by key across the default, user, project and local layers, as VS Code does
  get<T>(key: string, defaultValue?: undefined, folder?: SettingsFolder): T | undefined;
  get<T>(key: string, defaultValue: T, folder?: SettingsFolder): T;
  inspect<T>(key: string, folder?: SettingsFolder): SettingInspection<T>;
  // value undefined removes the setting at that scope
  update(key: string, value: unknown, scope: SettingsScope, folder?: SettingsFolder): Promise<void>;
  // fires for a change in the user file or in any folder the store has loaded
  onDidChange(section: string, cb: (change: SettingsChange) => void): Disposable;
  // absolute path of the file a scope reads; undefined when the host keeps no such file or the scope has no folder
  scopeFile(scope: SettingsScope, folder?: SettingsFolder): string | undefined;
}
