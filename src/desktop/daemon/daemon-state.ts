// The daemon core's key-value state (the `state` mirror and state.update), in the run folder's state/ (one writer per machine on
// a shared home).
import type { StateScope } from '../core-protocol/messages';
import { createDesktopKeyValueState } from '../local-services/key-value-state';

export interface DaemonState {
  snapshot(scope: StateScope): Readonly<Record<string, unknown>>;
  // core's state.update
  update(scope: StateScope, key: string, value: unknown): Promise<void>;
  flush(): Promise<void>;
}

export function createDaemonState(runDir: string, log: (line: string) => void): DaemonState {
  const store = createDesktopKeyValueState(runDir, log);
  return {
    snapshot: (scope) => store.snapshot(scope),
    update: (scope, key, value) => store[scope].update(key, value),
    flush: () => store.flush(),
  };
}
