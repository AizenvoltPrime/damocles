import type { ClipboardService } from '../../../platform/clipboard-service';
import type { DialogService } from '../../../platform/dialog-service';
import type { Disposable } from '../../../platform/disposable';
import type { HostLifecycle } from '../../../platform/host-lifecycle';
import type { NotificationOptions, NotificationService } from '../../../platform/notification-service';
import type { SecretsStore } from '../../../platform/secrets-store';
import type { LocalizedText } from '../../../shared/localized-text';
import type { ShellService } from '../../../platform/shell-service';
import type { AskQuestion, CoreEndpoint, CoreInit } from '../../core-protocol';
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

// An index past the actions offered, which a stale or faulty client of a daemon could send, answers as dismissed.
const offered = (index: number | undefined, actions: readonly unknown[]): number | undefined => (index !== undefined && index < actions.length ? index : undefined);

export function createNotificationsProxy(endpoint: CoreEndpoint): NotificationService {
  const show = (severity: 'info' | 'warn' | 'error') => async (message: LocalizedText, actions: readonly LocalizedText[] = [], options?: NotificationOptions): Promise<number | undefined> =>
    offered(await endpoint.request('notifications.show', { severity, message, ...(options?.modal !== undefined ? { modal: options.modal } : {}), actions }), actions);
  return { info: show('info'), warn: show('warn'), error: show('error') };
}

/** A modal question main asks (dialogs.ask), answered with the chosen action's index. */
export function createAskProxy(endpoint: CoreEndpoint): (question: AskQuestion) => Promise<number | undefined> {
  return async (question) => offered(await endpoint.request('dialogs.ask', question), question.actions);
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
