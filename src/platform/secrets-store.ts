import type { Disposable } from './disposable';

export interface SecretsStore {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  // every stored key, those this run cannot decrypt included, so a delete by prefix reaches them
  keys(): Promise<readonly string[]>;
  // Fires for a change made by any process sharing the store: every VS Code window shares one.
  onDidChange(listener: (key: string) => void): Disposable;
  readonly isPersistent: boolean;
}
