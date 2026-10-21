import { folderKey } from '../../../core/workspace-folders/folder-key';
import type { WorktreeHostServices } from '../../../core/worktrees/host';
import type { Disposable } from '../../../platform/disposable';
import type { KeyValueState, Memento } from '../../../platform/key-value-state';
import type { TrustService } from '../../../platform/trust-service';
import type { OpenFolder, WorkspaceFolders } from '../../../platform/workspace-folders';
import type { CoreEndpoint, CoreInit, StateScope } from '../../core-protocol';
import { Listeners } from './listeners';

// Mirrored services: synchronous reads of the copy main pushes, writes by RPC.

/** A live chat worktree's working folder answers with its project's trust, as main's TrustStore does (AD12). */
export function createTrustMirror(endpoint: CoreEndpoint, init: CoreInit, worktrees: () => WorktreeHostServices | undefined): TrustService & Disposable {
  let keys = new Set(init.mirrors.trust.keys);
  const granted = new Listeners<[readonly string[]]>('trust grant');
  const subscription = endpoint.onMirror('trust', (patch) => {
    keys = new Set(patch.keys);
    granted.fire(patch.granted);
  });
  return {
    isTrusted: (folderPath) => {
      if (keys.has(folderKey(folderPath))) return true;
      const project = worktrees()?.registry.liveChatRecordAt(folderPath)?.projectPath;
      return project !== undefined && keys.has(folderKey(project));
    },
    onDidGrantTrust: (cb) => granted.add(cb),
    requestTrust: (folderPath) => endpoint.request('trust.request', { folderPath }),
    dispose: () => {
      subscription.dispose();
      granted.clear();
    },
  };
}

// A key's updates in flight, and its value as main holds it: the value before the first, then each delta main published.
interface Flight {
  count: number;
  failed: boolean;
  main: unknown;
}

/**
 * VS Code's extension host memento: an update changes the copy at once, then goes to main. A delta for a key with an update
 * of its own in flight is not applied, since that update lands after it and its delta precedes its reply; once the last
 * update in flight settles, a key any of them failed for goes back to main's value.
 */
function createMemento(endpoint: CoreEndpoint, scope: StateScope, initial: Readonly<Record<string, unknown>>, changed: (key: string) => void): Memento & { apply(key: string, value: unknown): void } {
  const values = new Map(Object.entries(initial));
  const inFlight = new Map<string, Flight>();
  const set = (key: string, value: unknown): void => {
    if (value === undefined) values.delete(key);
    else values.set(key, value);
    changed(key);
  };
  function get<T>(key: string): T | undefined;
  function get<T>(key: string, defaultValue: T): T;
  function get<T>(key: string, defaultValue?: T): T | undefined {
    return values.has(key) ? (values.get(key) as T) : defaultValue;
  }
  return {
    get,
    update: async (key, value) => {
      const flight = inFlight.get(key) ?? { count: 0, failed: false, main: values.get(key) };
      inFlight.set(key, flight);
      flight.count++;
      set(key, value);
      try {
        await endpoint.request('state.update', { scope, key, value });
      } catch (err) {
        flight.failed = true;
        throw err;
      } finally {
        flight.count--;
        if (flight.count === 0) {
          inFlight.delete(key);
          if (flight.failed) set(key, flight.main);
        }
      }
    },
    apply: (key, value) => {
      const flight = inFlight.get(key);
      if (flight) flight.main = value;
      else set(key, value);
    },
  };
}

export interface StateMirror extends KeyValueState, Disposable {
  // a key's value changed here, by core's own update or main's delta
  onDidChange(scope: StateScope, key: string, listener: () => void): Disposable;
}

export function createStateMirror(endpoint: CoreEndpoint, init: CoreInit): StateMirror {
  const changed = new Listeners<[StateScope, string]>('state');
  const mementos = {
    global: createMemento(endpoint, 'global', init.mirrors.state.global, (key) => changed.fire('global', key)),
    workspace: createMemento(endpoint, 'workspace', init.mirrors.state.workspace, (key) => changed.fire('workspace', key)),
  };
  const subscription = endpoint.onMirror('state', (patch) => mementos[patch.scope].apply(patch.key, patch.value));
  return {
    ...mementos,
    onDidChange: (scope, key, listener) => changed.add((changedScope, changedKey) => {
      if (changedScope === scope && changedKey === key) listener();
    }),
    dispose: () => {
      subscription.dispose();
      changed.clear();
    },
  };
}

export function createFoldersMirror(endpoint: CoreEndpoint, init: CoreInit): WorkspaceFolders & Disposable {
  let folders: readonly OpenFolder[] = init.mirrors.folders.folders;
  const changed = new Listeners<[]>('workspace folders');
  const subscription = endpoint.onMirror('folders', (patch) => {
    folders = patch.folders;
    changed.fire();
  });
  return {
    folders: () => folders,
    onDidChange: (cb) => changed.add(cb),
    dispose: () => {
      subscription.dispose();
      changed.clear();
    },
  };
}
