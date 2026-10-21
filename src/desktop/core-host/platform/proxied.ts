import type { ClipboardService } from '../../../platform/clipboard-service';
import type { DialogService } from '../../../platform/dialog-service';
import type { Disposable } from '../../../platform/disposable';
import type { HostLifecycle } from '../../../platform/host-lifecycle';
import type { NotificationOptions, NotificationService } from '../../../platform/notification-service';
import type { SecretsStore } from '../../../platform/secrets-store';
import type { ShellService } from '../../../platform/shell-service';
import type { CoreEndpoint, CoreInit } from '../../core-protocol';
import { Listeners } from './listeners';

// Proxied services: every call is an RPC that main serves.

export function createSecretsProxy(endpoint: CoreEndpoint, init: CoreInit): SecretsStore & Disposable {
  const changed = new Listeners<[string]>('secrets');
  const subscription = endpoint.onEvent('secrets.changed', ({ key }) => changed.fire(key));
  return {
    get: (key) => endpoint.request('secrets.get', { key }),
    store: (key, value) => endpoint.request('secrets.store', { key, value }),
    delete: (key) => endpoint.request('secrets.delete', { key }),
    keys: () => endpoint.request('secrets.keys', {}),
    onDidChange: (listener) => changed.add(listener),
    isPersistent: init.secretsPersistent,
    dispose: () => {
      subscription.dispose();
      changed.clear();
    },
  };
}

export function createNotificationsProxy(endpoint: CoreEndpoint): NotificationService {
  const show = (severity: 'info' | 'warn' | 'error') => (message: string, ...rest: Array<NotificationOptions | string>): Promise<string | undefined> => {
    const [first, ...others] = rest;
    const options = typeof first === 'object' ? first : undefined;
    const actions = (options ? others : rest) as string[];
    return endpoint.request('notifications.show', { severity, message, ...(options?.modal !== undefined ? { modal: options.modal } : {}), actions });
  };
  return { info: show('info'), warn: show('warn'), error: show('error') };
}

export type ChatPrompts = Pick<DialogService, 'inputBox' | 'quickPick'>;

// Pickers are main's native dialogs; text input and quick picks render in a chat's webview, which core owns.
export function createDialogsProxy(endpoint: CoreEndpoint, prompts: () => ChatPrompts | undefined): DialogService {
  const requirePrompts = (): ChatPrompts => {
    const current = prompts();
    if (!current) throw new Error('A prompt was requested while the core services were not running');
    return current;
  };
  return {
    pickFolder: (opts) => endpoint.request('dialogs.pickFolder', opts),
    pickFile: (opts) => endpoint.request('dialogs.pickFile', opts),
    inputBox: async (opts, signal) => requirePrompts().inputBox(opts, signal),
    quickPick: async (items, options, signal) => requirePrompts().quickPick(items, options, signal),
  };
}

export function createClipboardProxy(endpoint: CoreEndpoint): ClipboardService {
  return { writeText: (text) => endpoint.request('clipboard.writeText', { text }) };
}

export function createShellProxy(endpoint: CoreEndpoint): ShellService {
  return {
    openExternal: (url) => endpoint.request('shell.openExternal', { url }),
    openFolder: (absolutePath) => endpoint.request('shell.openFolder', { path: absolutePath }),
    revealPath: (absolutePath) => endpoint.request('shell.revealPath', { path: absolutePath }),
  };
}

export function createLifecycleProxy(endpoint: CoreEndpoint): HostLifecycle {
  return { reload: () => endpoint.request('lifecycle.reload', {}) };
}
