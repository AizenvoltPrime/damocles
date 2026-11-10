// What a device's own work makes for that device (a request, an acting-client event, a new panel) waits here while the device
// is away, so it surfaces on that device or nowhere (docs/invariants.md "Remote daemon and wire").
import type { Disposable } from '../../platform/disposable';

export const ACTOR_INTENT_EXPIRY_MS = 60_000;

export type HoldOutcome = 'delivered' | 'expired' | 'aborted';

export interface ActorIntent<S> {
  // names it in the log, such as "core's notifications.show"
  readonly what: string;
  // runs synchronously once the device is present, in the order its intents were held
  readonly deliver: (session: S) => void;
  readonly signal?: AbortSignal;
}

export interface OutboxTimers {
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: never) => void;
}

export interface ActorOutbox<S> extends Disposable {
  // settles once the intent was delivered, its expiry passed, or its signal or the outbox's dispose ended it
  hold(clientId: string, intent: ActorIntent<S>): Promise<HoldOutcome>;
  // the device is present on `session`, a resumed connection or a fresh attach of the same install alike; once `live` turns
  // false (a delivery closed the session) the rest stay held on their own clocks for the device's next session
  present(clientId: string, session: S, live: () => boolean): void;
}

interface Held<S> {
  readonly intent: ActorIntent<S>;
  readonly settle: (outcome: HoldOutcome) => void;
}

export function createActorOutbox<S>({ expiryMs, timers, log }: { readonly expiryMs: number; readonly timers: OutboxTimers; readonly log: (line: string) => void }): ActorOutbox<S> {
  // by the hello's stable client id
  const queues = new Map<string, Array<Held<S>>>();
  let disposed = false;

  const remove = (clientId: string, entry: Held<S>): boolean => {
    const queue = queues.get(clientId);
    const index = queue?.indexOf(entry) ?? -1;
    if (index < 0) return false;
    queue!.splice(index, 1);
    if (queue!.length === 0) queues.delete(clientId);
    return true;
  };

  return {
    hold: (clientId, intent) => {
      if (disposed || intent.signal?.aborted === true) return Promise.resolve('aborted');
      return new Promise<HoldOutcome>((resolve) => {
        const timer = timers.setTimeout(() => {
          if (!remove(clientId, entry)) return;
          log(`[core-host] dropped ${intent.what} for client ${clientId}, which did not return within ${expiryMs} ms`);
          entry.settle('expired');
        }, expiryMs);
        const onAbort = (): void => {
          if (remove(clientId, entry)) entry.settle('aborted');
        };
        const entry: Held<S> = {
          intent,
          settle: (outcome) => {
            timers.clearTimeout(timer as never);
            intent.signal?.removeEventListener('abort', onAbort);
            resolve(outcome);
          },
        };
        intent.signal?.addEventListener('abort', onAbort, { once: true });
        const queue = queues.get(clientId) ?? [];
        queue.push(entry);
        queues.set(clientId, queue);
        log(`[core-host] holding ${intent.what} for client ${clientId}, which is away`);
      });
    },
    present: (clientId, session, live) => {
      const queue = queues.get(clientId);
      if (queue === undefined) return;
      queues.delete(clientId);
      log(`[core-host] client ${clientId} is back: delivering ${queue.length} held ${queue.length === 1 ? 'intent' : 'intents'}`);
      for (const [index, entry] of queue.entries()) {
        if (!live()) {
          const rest = queue.slice(index);
          queues.set(clientId, [...rest, ...(queues.get(clientId) ?? [])]);
          log(`[core-host] client ${clientId} went away again: holding ${rest.length} ${rest.length === 1 ? 'intent' : 'intents'} still`);
          return;
        }
        try {
          entry.intent.deliver(session);
          entry.settle('delivered');
        } catch (err) {
          log(`[core-host] delivering ${entry.intent.what} to client ${clientId} failed: ${err instanceof Error ? err.message : String(err)}`);
          entry.settle('aborted');
        }
      }
    },
    dispose: () => {
      disposed = true;
      const held = [...queues.values()].flat();
      queues.clear();
      for (const entry of held) entry.settle('aborted');
    },
  };
}
