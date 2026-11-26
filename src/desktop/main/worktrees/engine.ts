import type { FinishCall, WorktreeCall, WorktreeCalls } from '../../core-protocol';
import type { RemoteConnection } from '../remote/connection';

/**
 * The worktree git and registry work core does for main's WorktreeController (core-host/worktrees.ts), records named by id,
 * but the finish actions, which run under a FinishHold. Each call runs on the running core, so it waits through a restart.
 */
export type WorktreeEngine = Omit<WorktreeCalls, FinishCall>;

/**
 * A finish action's hold of its worktree, and the finish actions, which run on the core that gave the hold and on no other.
 * release never rejects. It settles once that core let go of the worktree's chats, so an outcome told after it finds them
 * free to send to, or once the connection to a remote core dropped, after which a send waits in main behind the release.
 */
export type FinishHold = { readonly release: () => Promise<void> } & {
  readonly [M in FinishCall]: WorktreeCalls[M] extends (worktreeId: string, hold: string, ...rest: infer A) => infer R ? (...rest: A) => R : never;
};

/** The core that gave a hold stopped before its finish action answered; the action may not have run, or not finished. */
export class EngineStoppedError extends Error {
  constructor() {
    super('The Damocles engine stopped during the worktree action');
    this.name = 'EngineStoppedError';
  }
}

type Call = (method: WorktreeCall, args: readonly unknown[]) => Promise<unknown>;

/** The engine over one call, which sends a method of WORKTREE_CALLS with its arguments to the running core. */
export function worktreeEngine(call: Call): WorktreeEngine {
  // each result is what core's handler of that name returns
  const as = <M extends keyof WorktreeEngine>(method: M): WorktreeEngine[M] => ((...args: unknown[]) => call(method, args)) as WorktreeEngine[M];
  return {
    options: as('options'),
    continueRows: as('continueRows'),
    targetBranch: as('targetBranch'),
    isRewritten: as('isRewritten'),
    uncommittedFiles: as('uncommittedFiles'),
    folderState: as('folderState'),
    deleteFacts: as('deleteFacts'),
    scanLeftovers: as('scanLeftovers'),
    prune: as('prune'),
    markUsed: as('markUsed'),
    upsertAdopted: as('upsertAdopted'),
    markAdoptedRemoved: as('markAdoptedRemoved'),
    adoptOpenWorktrees: as('adoptOpenWorktrees'),
  };
}

export interface FinishHoldDeps {
  // worktrees.call on the core that gave the hold
  readonly call: Call;
  // that core's process ended or main stopped serving it
  readonly stopped: () => boolean;
  readonly worktreeId: string;
  readonly hold: string;
  // worktree.endFinish on that core
  readonly release: () => Promise<void>;
  // the connection a remote core answers over; its drop holds every later message of this device until the release went
  readonly connection?: DroppingConnection;
}

export type DroppingConnection = Pick<RemoteConnection, 'onLost' | 'onClose' | 'lost'>;

// A drop can last the daemon's 3-hour hold, which must not keep the action's outcome from the user.
function untilDropped(released: Promise<void>, connection: DroppingConnection | undefined): Promise<void> {
  if (!connection) return released;
  return new Promise((resolve) => {
    const settle = (): void => {
      for (const subscription of subscriptions) subscription.dispose();
      resolve();
    };
    const subscriptions = [connection.onLost(settle), connection.onClose(settle)];
    if (connection.lost()) settle();
    void released.then(settle);
  });
}

export function finishHold(deps: FinishHoldDeps): FinishHold {
  const { call, stopped, worktreeId, hold } = deps;
  const held = <T>(method: FinishCall, rest: readonly unknown[]): Promise<T> => call(method, [worktreeId, hold, ...rest]).then(
    (result) => result as T,
    (err: unknown) => {
      throw stopped() ? new EngineStoppedError() : err;
    },
  );
  return {
    apply: () => held('apply', []),
    mergeInto: (message) => held('mergeInto', message !== undefined ? [message] : []),
    rebaseOnto: () => held('rebaseOnto', []),
    updateFrom: () => held('updateFrom', []),
    removeWorktree: (options) => held('removeWorktree', [options]),
    // a core that stopped, or whose connection closed, let go of its holds as it went
    release: () => untilDropped(deps.release().catch(() => undefined), deps.connection),
  };
}
