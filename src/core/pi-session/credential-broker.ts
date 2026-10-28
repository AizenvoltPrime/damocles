// The token broker: sign-ins are the client's, so a daemon's core gives pi this CredentialStore, which asks the turn's
// pinned client for a credential and keeps it in memory only. A refresh token never reaches it.
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { Disposable } from '../../platform/disposable';
import type { RemoteHost } from '../../platform/remote-host';
import { CREDENTIAL_CLIENT_ABSENT, MAX_BROKER_EXPIRES_IN_MS, planModelIdsOf, type BrokerAnswer, type HeldAuth } from '../../shared/remote-user';
import { clientCredentialProviders, currentPin, onPinReleased, pinnedClients, repin, runInTurnPin, runPin, type ClientPin, type SignInPrompts } from '../client-snapshots';
import { DAMOCLES_CREDENTIAL_SOURCE_ENTRY } from './session-store/constants';
import { t } from '../l10n';
import { log } from '../logger';

// pi's minimum OAuth validity (pi-ai auth/resolve.js DEFAULT_OAUTH_MINIMUM_VALIDITY_MS)
export const MIN_VALIDITY_MS: number = 5 * 60 * 1000;
// the key of a status-only API key credential: says a key is stored, and a provider refuses it if it is ever sent
export const STATUS_ONLY_KEY = 'damocles-status-only';

interface Cached {
  // undefined: the client has no credential for the provider, so pi falls back to the target's own
  readonly credential: Credential | undefined;
}

export interface BrokerDeps {
  readonly remote: RemoteHost;
  // a client's clientAuth changed a provider's entry, called after the broker dropped what it cached for that provider
  readonly credentialsChanged: () => void;
  readonly now?: () => number;
}

const cacheKey = (clientId: string, provider: string): string => `${clientId}\n${provider}`;

/** An answer as the credential pi reads; expires is set after the extras, on this host's clock. */
export function credentialOf(answer: BrokerAnswer, now: number): Credential | undefined {
  if (answer.type === 'none') return undefined;
  if (answer.type === 'api_key') return { type: 'api_key', key: answer.key };
  const { type: _type, expiresIn, ...extras } = answer;
  return { ...extras, type: 'oauth', refresh: '', access: answer.access, expires: now + expiresIn };
}

/**
 * Pins each run the session starts outside every pin (a cancel note or an extension's triggerTurn on an idle session) as a
 * turn of the client acting at its start, and holds the turn's pin while a run started inside it (a subagent's) runs: pi
 * starts every run in prompt or sendCustomMessage, and a run outside a pin would read the status-only placeholder as its
 * credential.
 */
export function pinRunStarts(session: AgentSession, remote: RemoteHost, run: string, signIn: SignInPrompts): void {
  const prompt = session.prompt.bind(session);
  const sendCustomMessage = session.sendCustomMessage.bind(session);
  const pinned = (start: () => Promise<void>): Promise<void> => runInTurnPin(remote, run, start, signIn);
  session.prompt = (text, options) => pinned(() => prompt(text, options));
  session.sendCustomMessage = (message, options) => pinned(() => sendCustomMessage(message, options));
}

/**
 * Records at each run's start and each reply's, inside its pin, the providers its client holds a credential for, whenever
 * that set differs from the one this session last recorded: spend on any other provider used the host's own credential. A
 * reply follows its request's credential read, so a turn Continue with my sign-in moved to another device records that
 * device's set before the reply it billed.
 */
export function recordCredentialSources(session: AgentSession, remote: RemoteHost): void {
  let recorded: string | undefined;
  session.subscribe((event) => {
    if (event.type !== 'agent_start' && !(event.type === 'message_start' && event.message.role === 'assistant')) return;
    const clientProviders = clientCredentialProviders(remote);
    const key = clientProviders.join('\n');
    if (key === recorded) return;
    session.sessionManager.appendCustomEntry(DAMOCLES_CREDENTIAL_SOURCE_ENTRY, { clientProviders });
    recorded = key;
  });
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * This computer's stored OAuth credential as a broker answer: the access token, its validity as expiresIn (clamped to
 * MAX_BROKER_EXPIRES_IN_MS, since OpenRouter's never expires), and only the named non-secret extras; never the refresh token.
 */
export function oauthAnswerOf(stored: Record<string, unknown>, now: number): BrokerAnswer {
  const { access, expires } = stored;
  if (typeof access !== 'string' || access === '' || typeof expires !== 'number') throw new Error('The stored OAuth credential has no access token or expiry');
  const plan = planModelIdsOf(stored['availableModelIds']);
  return {
    type: 'oauth',
    access,
    expiresIn: Math.min(Math.max(Math.floor(expires - now), 0), MAX_BROKER_EXPIRES_IN_MS),
    refresh: '',
    ...(typeof stored['clientId'] === 'string' ? { clientId: stored['clientId'] } : {}),
    ...(isStrings(stored['scopes']) ? { scopes: stored['scopes'] } : {}),
    ...(typeof stored['enterpriseUrl'] === 'string' ? { enterpriseUrl: stored['enterpriseUrl'] } : {}),
    ...(typeof stored['accountId'] === 'string' ? { accountId: stored['accountId'] } : {}),
    ...(plan ? { availableModelIds: plan } : {}),
  };
}

// an OAuth entry's expiry is stamped as its snapshot arrives, so a delta may count an unchanged one as changed
function changedProviders(before: HeldAuth | undefined, after: HeldAuth | undefined): string[] {
  const names = new Set([...Object.keys(before?.providers ?? {}), ...Object.keys(after?.providers ?? {})]);
  return [...names].filter((name) => JSON.stringify(before?.providers[name]) !== JSON.stringify(after?.providers[name]));
}

// the daemon's answer for a client with no live connection
class ClientAbsent extends Error {}

interface Waiter {
  readonly resolve: (cached: Cached) => void;
  readonly reject: (err: unknown) => void;
  // removes its listener from the run's signal
  readonly unlisten: () => void;
}

/** The runs of one turn pin waiting for one provider's credential, behind one Sign-in needed prompt. */
interface SignInWait {
  readonly pin: ClientPin;
  readonly provider: string;
  readonly waiters: Set<Waiter>;
  prompt: Disposable | undefined;
  asking: boolean;
  again: boolean;
}

export class BrokeredCredentialStore implements CredentialStore, Disposable {
  private readonly cache = new Map<string, Cached>();
  private readonly asking = new Map<string, Promise<Cached>>();
  // bumped by each clientAuth delta that changes the provider, each push and each eviction, so an answer asked for before it is never cached
  private readonly generations = new Map<string, number>();
  // each client's clientAuth as last seen with a value
  private readonly lastAuth = new Map<string, HeldAuth>();
  // the providers each turn's or sub-call's run read through the cache, by run label
  private readonly used = new Map<string, Set<string>>();
  // the clients a clientAuth delta marked detached, until one marks them attached again
  private readonly away = new Set<string>();
  private readonly waits = new Set<SignInWait>();
  private readonly subscriptions: Disposable[];
  private readonly now: () => number;
  private readonly deps: BrokerDeps;
  // an answer that arrives after dispose is returned to its asker but never held
  private disposed = false;

  constructor(deps: BrokerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    const clients = deps.remote.clients;
    this.subscriptions = [
      clients.onDidChange((change) => {
        if (change.topic !== 'clientAuth' || change.clientId === undefined) return;
        const clientId = change.clientId;
        if (!clients.attached(clientId)) {
          this.away.add(clientId);
          this.evictUnpinned(clientId);
          return;
        }
        // an ask made while the device was away answers absent, so the re-asks below never join one
        if (this.away.delete(clientId)) this.forgetAsks(clientId);
        const after = clients.auth(clientId);
        const providers = changedProviders(this.lastAuth.get(clientId) ?? (change.before as HeldAuth | undefined), after);
        if (after !== undefined) this.lastAuth.set(clientId, after);
        for (const provider of providers) this.forget(cacheKey(clientId, provider));
        if (providers.length > 0) deps.credentialsChanged();
        // the device a waiting turn is pinned to is back
        for (const wait of this.waits) if (wait.pin.clientId === clientId) this.askAgain(wait);
      }),
      onPinReleased((pin) => {
        if (pin.clientId !== undefined) this.evictUnpinned(pin.clientId);
      }),
    ];
  }

  async read(providerId: string, options?: { readonly signal?: AbortSignal }): Promise<Credential | undefined> {
    return (await this.serve(providerId, false, options?.signal)).credential;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const clientId = currentPin(this.deps.remote).clientId;
    const auth = clientId === undefined ? undefined : this.deps.remote.clients.auth(clientId);
    return Object.entries(auth?.providers ?? {}).flatMap(([providerId, entry]) => (entry.type === 'none' ? [] : [{ providerId, type: entry.type }]));
  }

  // pi's refresh path: fn would refresh with the empty refresh token, so the broker asks the client instead and never calls it
  async modify(providerId: string, _fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: { readonly signal?: AbortSignal }): Promise<Credential | undefined> {
    return (await this.serve(providerId, true, options?.signal)).credential;
  }

  delete(providerId: string): Promise<void> {
    log('[credential-broker] refused pi\'s delete of %s: sign-ins change only on the client', providerId);
    return Promise.reject(new Error(t('Sign-ins change only in the User tab on your computer, so {0} was not signed out on this host.', providerId)));
  }

  /** An access token a client pushed for itself (Keep running): lands only in that client's entry and resumes only its own turns' waits. */
  push(clientId: string, providerId: string, answer: BrokerAnswer & { readonly type: 'oauth' }): void {
    if (this.disposed) throw new Error('The token broker has stopped');
    const key = cacheKey(clientId, providerId);
    this.forget(key);
    this.cache.set(key, { credential: credentialOf(answer, this.now()) });
    log('[credential-broker] %s: %s pushed an access token', providerId, clientId);
    for (const wait of this.waits) if (wait.pin.clientId === clientId && wait.provider === providerId) this.askAgain(wait);
    // a detached device's token stays only while a turn is pinned to it
    this.evictUnpinned(clientId);
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const wait of [...this.waits]) this.settle(wait, (waiter) => waiter.reject(new Error('The token broker stopped', { cause: 'credential' })));
    for (const held of [this.cache, this.asking, this.generations, this.lastAuth, this.used, this.away]) held.clear();
  }

  private valid(cached: Cached | undefined): cached is Cached {
    if (cached === undefined) return false;
    const credential = cached.credential;
    return credential?.type !== 'oauth' || credential.expires > this.now() + MIN_VALIDITY_MS;
  }

  // pi's status reads (availability checks of every provider) run outside a run: they get the client's clientAuth entry
  // without a secret, never cached, and only a turn or sub-call asks the client
  private statusOnly(providerId: string): Cached {
    const clientId = currentPin(this.deps.remote).clientId;
    const entry = clientId === undefined ? undefined : this.deps.remote.clients.auth(clientId)?.providers[providerId];
    if (entry?.type === 'oauth') {
      const plan = entry.availableModelIds ? { availableModelIds: [...entry.availableModelIds] } : {};
      return { credential: { type: 'oauth', access: '', refresh: '', expires: entry.expires ?? 0, ...plan } };
    }
    if (entry?.hasKey) return { credential: { type: 'api_key', key: STATUS_ONLY_KEY } };
    return { credential: undefined };
  }

  private async serve(providerId: string, refresh: boolean, signal: AbortSignal | undefined): Promise<Cached> {
    const pin = runPin();
    if (pin === undefined) return this.statusOnly(providerId);
    if (pin.run !== undefined && !this.used.get(pin.run)?.has(providerId)) {
      const used = this.used.get(pin.run) ?? new Set<string>();
      used.add(providerId);
      this.used.set(pin.run, used);
      this.deps.remote.runProviders(pin.run, [...used]);
    }
    if (pin.clientId === undefined) throw this.absent(providerId, pin.kind);
    try {
      return await this.fetch(pin.clientId, providerId, refresh);
    } catch (err) {
      if (!(err instanceof ClientAbsent)) throw err;
      // the device's last clientAuth holds nothing for the provider, so pi uses the target's own, as it would with the device attached
      if (!this.holdsCredential(pin.clientId, providerId)) return { credential: undefined };
      if (pin.kind !== 'turn' || pin.signIn === undefined) throw this.absent(providerId, pin.kind);
      return this.waitForSignIn(pin, pin.signIn, providerId, signal);
    }
  }

  private holdsCredential(clientId: string, providerId: string): boolean {
    const entry = this.deps.remote.clients.auth(clientId)?.providers[providerId];
    return entry?.type === 'oauth' || entry?.hasKey === true;
  }

  // the cached credential while valid, else the one answer in flight for this client and provider, else a new ask
  private fetch(clientId: string, providerId: string, refresh: boolean): Promise<Cached> {
    const key = cacheKey(clientId, providerId);
    const cached = this.cache.get(key);
    if (!refresh && this.valid(cached)) return Promise.resolve(cached);
    const pending = this.asking.get(key);
    if (pending) return pending;
    const asked: Promise<Cached> = this.ask(clientId, providerId, this.generations.get(key) ?? 0).finally(() => {
      if (this.asking.get(key) === asked) this.asking.delete(key);
    });
    this.asking.set(key, asked);
    return asked;
  }

  private async ask(clientId: string, providerId: string, generation: number): Promise<Cached> {
    let answer: BrokerAnswer;
    try {
      answer = await this.deps.remote.credentials(providerId, clientId);
    } catch (err) {
      if (err instanceof Error && err.message === CREDENTIAL_CLIENT_ABSENT) throw new ClientAbsent(clientId);
      log('[credential-broker] %s: %s did not answer: %s', providerId, clientId, err instanceof Error ? err.message : String(err));
      throw err;
    }
    const cached: Cached = { credential: credentialOf(answer, this.now()) };
    const key = cacheKey(clientId, providerId);
    if (!this.disposed && (this.generations.get(key) ?? 0) === generation) this.cache.set(key, cached);
    log('[credential-broker] %s: %s answered %s', providerId, clientId, answer.type);
    return cached;
  }

  // a turn whose device is away waits, behind one Sign-in needed prompt per pin and provider, until that device answers
  private waitForSignIn(pin: ClientPin, signIn: SignInPrompts, provider: string, signal: AbortSignal | undefined): Promise<Cached> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<Cached>((resolve, reject) => {
      const joined = [...this.waits].find((candidate) => candidate.pin === pin && candidate.provider === provider);
      const wait: SignInWait = joined ?? { pin, provider, waiters: new Set(), prompt: undefined, asking: false, again: false };
      const aborted = (): void => {
        if (!wait.waiters.delete(waiter)) return;
        if (wait.waiters.size === 0) this.settle(wait, () => undefined);
        reject(signal?.reason);
      };
      const waiter: Waiter = { resolve, reject, unlisten: () => signal?.removeEventListener('abort', aborted) };
      wait.waiters.add(waiter);
      signal?.addEventListener('abort', aborted, { once: true });
      if (joined) return;
      this.waits.add(wait);
      log('[credential-broker] %s: the turn\'s device %s is not attached; waiting for its sign-in', provider, pin.clientId);
      wait.prompt = signIn.raise(provider, {
        continueWith: (clientId) => this.continueWith(wait, clientId),
        cancel: () => this.settle(wait, (each) => each.reject(new Error(t('The chat closed before a sign-in for {0} arrived.', provider), { cause: 'credential' }))),
      });
      // the device may have come back between the absent answer and this wait
      if (pin.clientId !== undefined && this.deps.remote.clients.attached(pin.clientId)) this.askAgain(wait);
    });
  }

  // "Continue with my sign-in": only an explicit click on an attached device moves a turn to it
  private continueWith(wait: SignInWait, clientId: string): void {
    if (!this.waits.has(wait) || !this.deps.remote.clients.attached(clientId)) return;
    const previous = wait.pin.clientId;
    repin(wait.pin, clientId);
    log('[credential-broker] %s: the turn moved from %s to %s at that device\'s request', wait.provider, previous, clientId);
    for (const each of this.waits) if (each.pin === wait.pin) this.askAgain(each);
    if (previous !== undefined) this.evictUnpinned(previous);
  }

  private askAgain(wait: SignInWait): void {
    const clientId = wait.pin.clientId;
    if (clientId === undefined) return;
    if (wait.asking) {
      wait.again = true;
      return;
    }
    wait.asking = true;
    wait.again = false;
    this.fetch(clientId, wait.provider, false).then(
      (cached) => this.settle(wait, (waiter) => waiter.resolve(cached)),
      (err: unknown) => {
        wait.asking = false;
        if (!(err instanceof ClientAbsent)) this.settle(wait, (waiter) => waiter.reject(err));
        else if (wait.again) this.askAgain(wait);
      },
    );
  }

  private settle(wait: SignInWait, each: (waiter: Waiter) => void): void {
    if (!this.waits.delete(wait)) return;
    wait.prompt?.dispose();
    for (const waiter of wait.waiters) {
      waiter.unlisten();
      each(waiter);
    }
    wait.waiters.clear();
  }

  // nothing cached for the key is served again, and no answer in flight for it is cached
  private forget(key: string): void {
    this.cache.delete(key);
    this.asking.delete(key);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  // a detached device's credentials stay only while a turn is pinned to it
  private evictUnpinned(clientId: string): void {
    if (this.deps.remote.clients.attached(clientId) || pinnedClients().has(clientId)) return;
    const prefix = cacheKey(clientId, '');
    for (const key of new Set([...this.cache.keys(), ...this.asking.keys()])) if (key.startsWith(prefix)) this.forget(key);
    this.lastAuth.delete(clientId);
  }

  private forgetAsks(clientId: string): void {
    const prefix = cacheKey(clientId, '');
    for (const key of [...this.asking.keys()]) if (key.startsWith(prefix)) this.asking.delete(key);
  }

  // a turn and a sub-call both fail at once, with the cause pi reads as a credential failure
  private absent(providerId: string, kind: 'turn' | 'subcall'): Error {
    log('[credential-broker] %s: the %s\'s client is not attached', providerId, kind);
    return new Error(t('The computer that started this chat is not connected, so this host has no sign-in for {0}. Reconnect from that computer to continue.', providerId), { cause: 'credential' });
  }
}
