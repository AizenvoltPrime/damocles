import { folderKey } from '../../../core/workspace-folders/folder-key';
import { liveWorkingFolders } from '../../../core/worktrees/records';
import type { WorktreeRegistry } from '../../../core/worktrees/registry';
import { isEmptyTrustChange, mergeTrustChanges, workingFolderTrust } from '../../local-services/working-folder-trust';
import type { Disposable } from '../../../platform/disposable';
import type { KeyValueState, Memento } from '../../../platform/key-value-state';
import type { TrustChange, TrustService } from '../../../platform/trust-service';
import type { OpenFolder, WorkspaceFolders } from '../../../platform/workspace-folders';
import type { CoreEndpoint, CoreInit, StateScope } from '../../core-protocol';
import { Listeners } from './listeners';

// Mirrored services: synchronous reads of the copy main pushes, writes by RPC.

export type TrustRegistry = Pick<WorktreeRegistry, 'records' | 'liveChatRecordAt' | 'onDidChange'>;

export interface TrustMirror extends TrustService, Disposable {
  // the worktree registry, once core built it; its working folders' answers follow it from then on
  followRegistry(registry: TrustRegistry): void;
}

/**
 * A live chat worktree's working folder answers with its project's trust, as main's TrustStore does (AD12), and a change of
 * that answer fires onDidChangeTrust naming the folder, whether main's patch or a registry change made it.
 */
export function createTrustMirror(endpoint: CoreEndpoint, init: CoreInit): TrustMirror {
  let keys = new Set(init.mirrors.trust.keys);
  let registry: TrustRegistry | undefined;
  let registrySubscription: Disposable | undefined;
  const changed = new Listeners<[TrustChange]>('trust change');
  const direct = (folderPath: string): boolean => keys.has(folderKey(folderPath));
  const isTrusted = (folderPath: string): boolean => {
    if (direct(folderPath)) return true;
    const project = registry?.liveChatRecordAt(folderPath)?.projectPath;
    return project !== undefined && direct(project);
  };
  const workingFolders = workingFolderTrust(() => liveWorkingFolders(registry?.records() ?? []), isTrusted, direct);
  const fireWorkingFolders = (): void => {
    const change = workingFolders();
    if (!isEmptyTrustChange(change)) changed.fire(change);
  };
  const subscription = endpoint.onMirror('trust', (patch) => {
    keys = new Set(patch.keys);
    changed.fire(mergeTrustChanges({ granted: patch.granted, revoked: patch.revoked ?? [] }, workingFolders()));
  });
  return {
    isTrusted,
    onDidChangeTrust: (cb) => changed.add(cb),
    requestTrust: (folderPath) => endpoint.request('trust.request', { folderPath }),
    followRegistry: (next) => {
      registrySubscription?.dispose();
      registry = next;
      registrySubscription = next.onDidChange(fireWorkingFolders);
      fireWorkingFolders();
    },
    dispose: () => {
      subscription.dispose();
      registrySubscription?.dispose();
      changed.clear();
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
