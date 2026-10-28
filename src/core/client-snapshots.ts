// The acting client of a daemon's core and what a turn pins of it: a turn reads the client user
// rules, policy and token cache of the client that acted when it started, whoever acts later.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Disposable } from '../platform/disposable';
import type { Platform } from '../platform/platform';
import type { RemoteHost } from '../platform/remote-host';
import type { ClientPolicy, ClientUser } from '../shared/remote-user';
import type { PermissionMode } from '../shared/types/settings';

/** The chat a turn runs in, as the token broker raises its Sign-in needed prompt there; continueWith re-pins the turn to the device that clicked. */
export interface SignInPrompts {
  raise(provider: string, actions: { readonly continueWith: (clientId: string) => void; readonly cancel: () => void }): Disposable;
}

/** turn: a chat turn's run; subcall: a structured sub-call or classification, which never waits for a client. */
export interface ClientPin {
  readonly kind: 'turn' | 'subcall';
  // undefined: no client was attached; a turn's changes only by repin
  readonly clientId: string | undefined;
  readonly user: ClientUser | undefined;
  readonly policy: ClientPolicy | undefined;
  // the run whose broker reads are recorded under this label (a chat's panel id)
  readonly run?: string;
  // a turn's: where the broker raises Sign-in needed while its device is away
  readonly signIn?: SignInPrompts;
}

const pins = new AsyncLocalStorage<ClientPin>();
// the turn pins a run is still running under, each with how many runs hold it
const held = new Map<ClientPin, number>();
const releaseListeners = new Set<(pin: ClientPin) => void>();

function actingPin(remote: RemoteHost, kind: ClientPin['kind']): ClientPin {
  const clientId = remote.clients.acting();
  return {
    kind,
    clientId,
    user: clientId === undefined ? undefined : remote.clients.user(clientId),
    policy: clientId === undefined ? undefined : remote.clients.policy(clientId),
  };
}

function release(pin: ClientPin): void {
  const count = (held.get(pin) ?? 0) - 1;
  if (count > 0) {
    held.set(pin, count);
    return;
  }
  held.delete(pin);
  for (const listener of [...releaseListeners]) listener(pin);
}

/** Runs body under a turn pin, which counts as held until body (or the promise it returns) settles. */
function holdPin<T>(pin: ClientPin, body: () => T): T {
  held.set(pin, (held.get(pin) ?? 0) + 1);
  let result: T;
  try {
    result = pins.run(pin, body);
  } catch (err) {
    release(pin);
    throw err;
  }
  const pending = result as { then?: unknown } | undefined;
  if (typeof pending?.then === 'function') (result as PromiseLike<unknown>).then(() => release(pin), () => release(pin));
  else release(pin);
  return result;
}

/** Runs a turn pinned to the client acting now, its broker reads recorded under `run`; a local core runs it as is. */
export function runPinnedTurn<T>(remote: RemoteHost | undefined, run: string, body: () => T, signIn?: SignInPrompts): T {
  return remote ? holdPin({ ...actingPin(remote, 'turn'), run, ...(signIn ? { signIn } : {}) }, body) : body();
}

/** Runs a run started inside a turn (a subagent's) under that turn's pin, held until it settles; outside a turn, as runPinnedTurn. */
export function runInTurnPin<T>(remote: RemoteHost, run: string, body: () => T, signIn?: SignInPrompts): T {
  const pin = pins.getStore();
  if (pin === undefined) return runPinnedTurn(remote, run, body, signIn);
  return pin.kind === 'turn' ? holdPin(pin, body) : body();
}

/** The clients a running turn is pinned to. */
export function pinnedClients(): ReadonlySet<string> {
  return new Set([...held.keys()].flatMap((pin) => (pin.clientId === undefined ? [] : [pin.clientId])));
}

/** Hears each turn pin whose last run settled. */
export function onPinReleased(listener: (pin: ClientPin) => void): Disposable {
  releaseListeners.add(listener);
  return { dispose: () => { releaseListeners.delete(listener); } };
}

/** Moves a turn to another device: its credentials, billing and account state follow clientId; its user rules and policy stay as pinned at its start. */
export function repin(pin: ClientPin, clientId: string): void {
  (pin as { clientId: string | undefined }).clientId = clientId;
}

/** Runs a sub-call with its turn's pin, else the acting client's, marked as a sub-call. */
export function runPinnedSubcall<T>(remote: RemoteHost | undefined, run: () => T): T {
  if (!remote) return run();
  const current = pins.getStore();
  return pins.run(current ? { ...current, kind: 'subcall' } : actingPin(remote, 'subcall'), run);
}

/** Reads state as one client sees it (a view's account state and model list), from that client's snapshots. */
export function asClient<T>(remote: RemoteHost, clientId: string | undefined, read: () => T): T {
  return pins.run({
    kind: 'subcall',
    clientId,
    user: clientId === undefined ? undefined : remote.clients.user(clientId),
    policy: clientId === undefined ? undefined : remote.clients.policy(clientId),
  }, read);
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

/** Whether the pinned (else acting) client prefers its key saved in Damocles over a sign-in for OpenAI or a key provider. */
export function clientPrefersApiKey(remote: RemoteHost, providerId: string): boolean {
  const clientId = currentPin(remote).clientId;
  return clientId !== undefined && remote.clients.auth(clientId)?.providers[providerId]?.preferApiKey === true;
}

/** Whether the pinned (else acting) client saved a key provider's key in Damocles, even one its sign-in outranks; never reads a key. */
export function clientKeySaved(remote: RemoteHost, providerId: string): boolean {
  const clientId = currentPin(remote).clientId;
  const entry = clientId === undefined ? undefined : remote.clients.auth(clientId)?.providers[providerId];
  // a client that has not synced its keys yet sends no keySaved; until then hasKey is the best it said
  return (entry?.keySaved ?? entry?.hasKey) === true;
}

/** Whether a client, by default the pinned (else acting) one, holds any credential for a provider, from its clientAuth; never reads one. */
export function clientHasAuth(remote: RemoteHost, providerId: string, clientId: string | undefined = currentPin(remote).clientId): boolean {
  const entry = clientId === undefined ? undefined : remote.clients.auth(clientId)?.providers[providerId];
  return entry !== undefined && (entry.type !== 'none' || entry.hasKey);
}

/** The providers the pinned (else acting) client holds a credential for, from its clientAuth; never reads one. */
export function clientCredentialProviders(remote: RemoteHost): string[] {
  const clientId = currentPin(remote).clientId;
  const providers = clientId === undefined ? {} : remote.clients.auth(clientId)?.providers ?? {};
  return Object.keys(providers).filter((id) => providers[id]?.type === 'oauth' || providers[id]?.hasKey === true).sort();
}

/** Whether the pinned (else acting) client holds a credential for a provider; without one the broker answers none and pi uses the host's own. */
export function clientHasCredential(remote: RemoteHost, providerId: string): boolean {
  return clientCredentialProviders(remote).includes(providerId);
}

/** Who paid for a provider's billed call: a daemon's core whose pinned (else acting) client holds no credential for it used the host's own. */
export function credentialSourceOf(remote: RemoteHost | undefined, providerId: string): 'host' | undefined {
  return remote !== undefined && !clientHasCredential(remote, providerId) ? 'host' : undefined;
}

/**
 * The SSH agent socket a process spawned now gets as SSH_AUTH_SOCK: the daemon's proxy socket of the pinned (else acting)
 * client, which reaches only that client's agent, while that client forwards its agent to this host, else undefined; a local
 * core never has one.
 */
export function agentSocketPath(platform: Pick<Platform, 'remote'>): string | undefined {
  const remote = platform.remote;
  if (remote === undefined) return undefined;
  const pin = currentPin(remote);
  return pin.clientId !== undefined && pin.policy?.agentForwarding === true ? remote.agentSocket(pin.clientId) : undefined;
}

/** The host's default mode as the pinned (else acting) client configured it; undefined on a local core or when unset. */
export function hostDefaultMode(platform: Pick<Platform, 'remote'>): PermissionMode | undefined {
  return platform.remote === undefined ? undefined : currentPin(platform.remote).policy?.defaultPermissionMode;
}

/** Whether YOLO may apply: always on a local core, on a daemon's only while the pinned client's policy allows it. */
export function bypassAllowed(platform: Pick<Platform, 'remote'>): boolean {
  return platform.remote === undefined || currentPin(platform.remote).policy?.allowBypass === true;
}
