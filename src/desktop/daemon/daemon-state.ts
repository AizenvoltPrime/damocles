// The daemon core's key-value state (the `state` mirror and state.update), in the run folder's state/ (one writer per machine on
// a shared home). CLIENT_STATE_KEYS are the client's: core never writes them here, and their values come only
// from the clients, in memory.
import { CLIENT_STATE_KEYS, type StateScope } from '../core-protocol/messages';
import { createDesktopKeyValueState } from '../local-services/key-value-state';

export interface DaemonState {
  // the store's values with the clients' latest CLIENT_STATE_KEYS values over them
  snapshot(scope: StateScope): Readonly<Record<string, unknown>>;
  // core's state.update; rejects a CLIENT_STATE_KEYS key
  update(scope: StateScope, key: string, value: unknown): Promise<void>;
  // a client's value; false (nothing applied) for a key outside CLIENT_STATE_KEYS
  applyClient(scope: StateScope, key: string, value: unknown): boolean;
  flush(): Promise<void>;
}

export function isClientStateKey(key: string): boolean {
  return CLIENT_STATE_KEYS.includes(key);
}

export function createDaemonState(runDir: string, log: (line: string) => void): DaemonState {
  const store = createDesktopKeyValueState(runDir, log);
  const client: Record<StateScope, Map<string, unknown>> = { global: new Map(), workspace: new Map() };
  return {
    snapshot: (scope) => {
      const values: Record<string, unknown> = { ...store.snapshot(scope) };
      for (const key of CLIENT_STATE_KEYS) delete values[key];
      for (const [key, value] of client[scope]) values[key] = value;
      return values;
    },
    update: async (scope, key, value) => {
      if (isClientStateKey(key)) {
        log(`[core-host] refused core's write of ${scope} state ${key}, which is the client's`);
        throw new Error(`${key} is set on the client, not on this host`);
      }
      await store[scope].update(key, value);
    },
    applyClient: (scope, key, value) => {
      if (!isClientStateKey(key)) return false;
      if (value === undefined) client[scope].delete(key);
      else client[scope].set(key, value);
      return true;
    },
    flush: () => store.flush(),
  };
}
