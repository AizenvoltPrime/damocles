// The token broker: sign-ins are the client's, so a daemon's core gives pi this CredentialStore, which asks the turn's
// pinned client for a credential and keeps it in memory only. A refresh token never reaches it.
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { Disposable } from '../../platform/disposable';
import type { RemoteHost } from '../../platform/remote-host';
import { CREDENTIAL_CLIENT_ABSENT, MAX_BROKER_EXPIRES_IN_MS, type BrokerAnswer, type HeldAuth } from '../../shared/remote-user';
import { currentPin, runPin, runPinnedTurn } from '../client-snapshots';
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
 * turn of the client acting at its start: pi starts every run in prompt or sendCustomMessage, and a run outside a pin
 * would read the status-only placeholder as its credential.
 */
export function pinRunStarts(session: AgentSession, remote: RemoteHost, run: string): void {
  const prompt = session.prompt.bind(session);
  const sendCustomMessage = session.sendCustomMessage.bind(session);
  const pinned = (start: () => Promise<void>): Promise<void> => (runPin() ? start() : runPinnedTurn(remote, run, start));
  session.prompt = (text, options) => pinned(() => prompt(text, options));
  session.sendCustomMessage = (message, options) => pinned(() => sendCustomMessage(message, options));
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * This computer's stored OAuth credential as a broker answer: the access token, its validity as expiresIn (clamped to
 * MAX_BROKER_EXPIRES_IN_MS, since OpenRouter's never expires), and only the named non-secret extras; never the refresh token.
 */
export function oauthAnswerOf(stored: Record<string, unknown>, now: number): BrokerAnswer {
  const { access, expires } = stored;
  if (typeof access !== 'string' || access === '' || typeof expires !== 'number') throw new Error('The stored OAuth credential has no access token or expiry');
  return {
    type: 'oauth',
    access,
    expiresIn: Math.min(Math.max(Math.floor(expires - now), 0), MAX_BROKER_EXPIRES_IN_MS),
    refresh: '',
    ...(typeof stored['clientId'] === 'string' ? { clientId: stored['clientId'] } : {}),
    ...(isStrings(stored['scopes']) ? { scopes: stored['scopes'] } : {}),
    ...(typeof stored['enterpriseUrl'] === 'string' ? { enterpriseUrl: stored['enterpriseUrl'] } : {}),
    ...(typeof stored['accountId'] === 'string' ? { accountId: stored['accountId'] } : {}),
    ...(isStrings(stored['availableModelIds']) ? { availableModelIds: stored['availableModelIds'] } : {}),
  };
}

// an OAuth entry's expiry is stamped as its snapshot arrives, so a delta may count an unchanged one as changed
function changedProviders(before: HeldAuth | undefined, after: HeldAuth | undefined): string[] {
  const names = new Set([...Object.keys(before?.providers ?? {}), ...Object.keys(after?.providers ?? {})]);
  return [...names].filter((name) => JSON.stringify(before?.providers[name]) !== JSON.stringify(after?.providers[name]));
}

export class BrokeredCredentialStore implements CredentialStore, Disposable {
  private readonly cache = new Map<string, Cached>();
  private readonly asking = new Map<string, Promise<Cached>>();
  // bumped by each clientAuth delta that changes the provider, so an answer asked for before it is never cached
  private readonly generations = new Map<string, number>();
  // each client's clientAuth as last seen with a value, which a detach does not clear
  private readonly lastAuth = new Map<string, HeldAuth>();
  // the providers each turn's or sub-call's run read through the cache, by run label
  private readonly used = new Map<string, Set<string>>();
  private readonly subscription: Disposable;
  private readonly now: () => number;
  private readonly deps: BrokerDeps;
  // an answer that arrives after dispose is returned to its asker but never held
  private disposed = false;

  constructor(deps: BrokerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.subscription = deps.remote.clients.onDidChange((change) => {
      if (change.topic !== 'clientAuth' || change.clientId === undefined) return;
      const clientId = change.clientId;
      const after = deps.remote.clients.auth(clientId);
      // a detached client's turns keep its cached credentials (plan "Several clients"), and its reattach changes nothing
      if (after === undefined) return;
      const providers = changedProviders(this.lastAuth.get(clientId) ?? (change.before as HeldAuth | undefined), after);
      this.lastAuth.set(clientId, after);
      if (providers.length === 0) return;
      for (const provider of providers) {
        const key = cacheKey(clientId, provider);
        this.cache.delete(key);
        this.asking.delete(key);
        this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
      }
      deps.credentialsChanged();
    });
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.serve(providerId, false)).credential;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const clientId = currentPin(this.deps.remote).clientId;
    const auth = clientId === undefined ? undefined : this.deps.remote.clients.auth(clientId);
    return Object.entries(auth?.providers ?? {}).flatMap(([providerId, entry]) => (entry.type === 'none' ? [] : [{ providerId, type: entry.type }]));
  }

  // pi's refresh path: fn would refresh with the empty refresh token, so the broker asks the client instead and never calls it
  async modify(providerId: string, _fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return (await this.serve(providerId, true)).credential;
  }

  delete(providerId: string): Promise<void> {
    log('[credential-broker] refused pi\'s delete of %s: sign-ins change only on the client', providerId);
    return Promise.reject(new Error(t('Sign-ins change only in the User tab on your computer, so {0} was not signed out on this host.', providerId)));
  }

  dispose(): void {
    this.disposed = true;
    this.subscription.dispose();
    for (const held of [this.cache, this.asking, this.generations, this.lastAuth, this.used]) held.clear();
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
    if (entry?.type === 'oauth') return { credential: { type: 'oauth', access: '', refresh: '', expires: entry.expires ?? 0 } };
    if (entry?.hasKey) return { credential: { type: 'api_key', key: STATUS_ONLY_KEY } };
    return { credential: undefined };
  }

  private async serve(providerId: string, refresh: boolean): Promise<Cached> {
    const pin = runPin();
    if (pin === undefined) return this.statusOnly(providerId);
    if (pin.run !== undefined && !this.used.get(pin.run)?.has(providerId)) {
      const used = this.used.get(pin.run) ?? new Set<string>();
      used.add(providerId);
      this.used.set(pin.run, used);
      this.deps.remote.runProviders(pin.run, [...used]);
    }
    if (pin.clientId === undefined) throw this.absent(providerId, pin.kind);
    const key = cacheKey(pin.clientId, providerId);
    const cached = this.cache.get(key);
    if (!refresh && this.valid(cached)) return cached;
    const pending = this.asking.get(key);
    if (pending) return pending;
    const asked: Promise<Cached> = this.ask(pin.clientId, providerId, pin.kind, this.generations.get(key) ?? 0).finally(() => {
      if (this.asking.get(key) === asked) this.asking.delete(key);
    });
    this.asking.set(key, asked);
    return asked;
  }

  private async ask(clientId: string, providerId: string, kind: 'turn' | 'subcall', generation: number): Promise<Cached> {
    let answer: BrokerAnswer;
    try {
      answer = await this.deps.remote.credentials(providerId, clientId);
    } catch (err) {
      if (err instanceof Error && err.message === CREDENTIAL_CLIENT_ABSENT) throw this.absent(providerId, kind);
      throw err;
    }
    const cached: Cached = { credential: credentialOf(answer, this.now()) };
    const key = cacheKey(clientId, providerId);
    if (!this.disposed && (this.generations.get(key) ?? 0) === generation) this.cache.set(key, cached);
    log('[credential-broker] %s: %s answered %s', providerId, clientId, answer.type);
    return cached;
  }

  // a turn and a sub-call both fail at once, with the cause pi reads as a credential failure
  private absent(providerId: string, kind: 'turn' | 'subcall'): Error {
    log('[credential-broker] %s: the %s\'s client is not attached', providerId, kind);
    return new Error(t('The computer that started this chat is not connected, so this host has no sign-in for {0}. Reconnect from that computer to continue.', providerId), { cause: 'credential' });
  }
}
