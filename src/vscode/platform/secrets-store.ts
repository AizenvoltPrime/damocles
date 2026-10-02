import type * as vscode from 'vscode';
import type { SecretsStore } from '../../platform/secrets-store';

export function createVsCodeSecretsStore(secrets: vscode.SecretStorage): SecretsStore {
  return {
    get: async (key) => secrets.get(key),
    store: async (key, value) => { await secrets.store(key, value); },
    delete: async (key) => { await secrets.delete(key); },
    keys: async () => secrets.keys(),
    onDidChange: (listener) => secrets.onDidChange((event) => listener(event.key)),
    isPersistent: true,
  };
}
