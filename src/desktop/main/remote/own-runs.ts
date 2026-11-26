// This device's own chat runs on a daemon (control.listOwnRuns: the runs whose turn this client started), asked again after
// each runs event, so a control.handingOver can say how many of them the switch stopped.
import type { Disposable } from '../../../platform/disposable';
import type { RemoteConnection } from './connection';

export interface OwnRuns {
  // the count as the latest answer gave it; 0 before the first
  count(): number;
  dispose(): void;
}

/** Asks listOwnRuns after each runs event, one request at a time; an event during a request asks once more after it. */
export function followOwnRuns(connection: Pick<RemoteConnection, 'onRuns' | 'control'>, log: (line: string) => void): OwnRuns {
  let count = 0;
  let asking = false;
  let again = false;
  let disposed = false;
  const ask = (): void => {
    if (asking) {
      again = true;
      return;
    }
    asking = true;
    connection.control.request('listOwnRuns', {}).then(({ runs }) => {
      if (!disposed) count = runs.filter((run) => run.kind === 'chat').length;
    }, (err: unknown) => {
      log(`[remote] listing this device's runs failed: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => {
      asking = false;
      if (!again || disposed) return;
      again = false;
      ask();
    });
  };
  const subscription: Disposable = connection.onRuns(() => ask());
  return {
    count: () => count,
    dispose: () => {
      disposed = true;
      subscription.dispose();
    },
  };
}
