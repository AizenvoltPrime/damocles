// The acting client of a daemon's core and what a turn pins of it: a turn reads the client user
// rules, policy and token cache of the client that acted when it started, whoever acts later.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Platform } from '../platform/platform';
import type { RemoteHost } from '../platform/remote-host';
import type { ClientPolicy, ClientUser } from '../shared/remote-user';

/** turn: a chat turn's run; subcall: a structured sub-call or classification, which never waits for a client. */
export interface ClientPin {
  readonly kind: 'turn' | 'subcall';
  // undefined: no client was attached
  readonly clientId: string | undefined;
  readonly user: ClientUser | undefined;
  readonly policy: ClientPolicy | undefined;
  // the run whose broker reads are recorded under this label (a chat's panel id)
  readonly run?: string;
}

const pins = new AsyncLocalStorage<ClientPin>();

function actingPin(remote: RemoteHost, kind: ClientPin['kind']): ClientPin {
  const clientId = remote.clients.acting();
  return {
    kind,
    clientId,
    user: clientId === undefined ? undefined : remote.clients.user(clientId),
    policy: clientId === undefined ? undefined : remote.clients.policy(clientId),
  };
}

/** Runs a turn pinned to the client acting now, its broker reads recorded under `run`; a local core runs it as is. */
export function runPinnedTurn<T>(remote: RemoteHost | undefined, run: string, body: () => T): T {
  return remote ? pins.run({ ...actingPin(remote, 'turn'), run }, body) : body();
}

/** Runs a sub-call with its turn's pin, else the acting client's, marked as a sub-call. */
export function runPinnedSubcall<T>(remote: RemoteHost | undefined, run: () => T): T {
  if (!remote) return run();
  const current = pins.getStore();
  return pins.run(current ? { ...current, kind: 'subcall' } : actingPin(remote, 'subcall'), run);
}

/** The pin of the running turn or sub-call; undefined outside every run. */
export function runPin(): ClientPin | undefined {
  return pins.getStore();
}

/** Runs outside every pin, so pi's status work started there (availability refreshes) never asks a client. */
export function outsidePins<T>(run: () => T): T {
  return pins.exit(run);
}

/** The pin of the running turn or sub-call, else the acting client's. */
export function currentPin(remote: RemoteHost): ClientPin {
  return pins.getStore() ?? actingPin(remote, 'subcall');
}

/** Whether pi on the pinned (else acting) client holds an API key for a provider (`ClientAuthEntry.hasKey`); never reads a key. */
export function clientHasKey(remote: RemoteHost, providerId: string): boolean {
  const clientId = currentPin(remote).clientId;
  return clientId !== undefined && remote.clients.auth(clientId)?.providers[providerId]?.hasKey === true;
}

/** Whether the pinned (else acting) client saved a key provider's key in Damocles, even one its sign-in outranks; never reads a key. */
export function clientKeySaved(remote: RemoteHost, providerId: string): boolean {
  const clientId = currentPin(remote).clientId;
  const entry = clientId === undefined ? undefined : remote.clients.auth(clientId)?.providers[providerId];
  // a client that has not synced its keys yet sends no keySaved; until then hasKey is the best it said
  return (entry?.keySaved ?? entry?.hasKey) === true;
}

/** Whether the pinned (else acting) client holds any credential for a provider, from its clientAuth; never reads one. */
export function clientHasAuth(remote: RemoteHost, providerId: string): boolean {
  const clientId = currentPin(remote).clientId;
  const entry = clientId === undefined ? undefined : remote.clients.auth(clientId)?.providers[providerId];
  return entry !== undefined && (entry.type !== 'none' || entry.hasKey);
}

/** Whether YOLO may apply: always on a local core, on a daemon's only while the pinned client's policy allows it. */
export function bypassAllowed(platform: Pick<Platform, 'remote'>): boolean {
  return platform.remote === undefined || currentPin(platform.remote).policy?.allowBypass === true;
}
