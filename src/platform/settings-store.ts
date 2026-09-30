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

// Keys are full dotted keys ('damocles.explore.provider'); no folder argument.
export interface SettingsStore {
  // an object value is merged key by key across the default, user, project and local layers, as VS Code does
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  inspect<T>(key: string): SettingInspection<T>;
  // value undefined removes the setting at that scope
  update(key: string, value: unknown, scope: SettingsScope): Promise<void>;
  onDidChange(section: string, cb: (change: SettingsChange) => void): Disposable;
  // absolute path of the file a scope reads for window-level values; undefined when the host keeps no such file or the scope has no folder
  scopeFile(scope: SettingsScope): string | undefined;
}
