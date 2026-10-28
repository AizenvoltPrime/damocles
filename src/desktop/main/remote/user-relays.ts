// This computer's user scope as a remote core reaches it (docs/invariants.md "Remote daemon and wire"): the broker's
// credentials, which the local core resolves and main checks, and the clientAuth, clientUser and clientPolicy mirrors each
// attach publishes. Nothing here ever carries a refresh token, env, apiKeyHelper, hooks or a stored secret.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parseSettingsText, type SettingsObject } from '../../../core/config/settings-file';
import type { Disposable } from '../../../platform/disposable';
import { PROVIDER_ID_PATTERN } from '../../../shared/types/messages';
import { MAX_BROKER_EXPIRES_IN_MS, planModelIdsOf, sentClientAuth, type BrokerAnswer, type ClientAuth, type ClientPolicy, type ClientUser, type HeldAuth, type HeldAuthEntry, type PermissionRuleLists, type UserRulesDir } from '../../../shared/remote-user';

// an access token or API key; pi's JWTs are a few KB
export const MAX_SECRET_CHARS: number = 64 * 1024;
// one non-secret extra string (an OAuth client id, an enterprise URL, a scope, a model id)
export const MAX_EXTRA_CHARS: number = 2048;
export const MAX_EXTRA_ITEMS: number = 512;
// one permission rule, and the rules one list carries
export const MAX_RULE_CHARS: number = 4096;
export const MAX_RULES: number = 2000;
// how often an unknown provider id may re-read this computer's snapshot
export const AUTH_REREAD_MS: number = 5000;

/** A user settings file read for its permission rules, and the folder it is in. */
export interface UserRulesFile {
  readonly dir: UserRulesDir;
  readonly settings: SettingsObject;
}

/** The four user files whose permission rules a remote core layers under its host's own, most specific first (permission-settings.ts). */
export function userPermissionFiles(homedir: string): ReadonlyArray<{ readonly dir: UserRulesDir; readonly file: string }> {
  return ([['.damocles', 'settings.local.json'], ['.claude', 'settings.local.json'], ['.damocles', 'settings.json'], ['.claude', 'settings.json']] as const)
    .map(([dir, name]) => ({ dir, file: path.join(homedir, dir, name) }));
}

const boundedString = (value: unknown, max: number, what: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`The credential answer's ${what} is not a bounded string`);
  return value;
};

const boundedStrings = (value: unknown, what: string): readonly string[] => {
  if (!Array.isArray(value) || value.length > MAX_EXTRA_ITEMS) throw new Error(`The credential answer's ${what} is not a bounded list`);
  return value.map((item) => boundedString(item, MAX_EXTRA_CHARS, what));
};

/** A provider id the broker may ask for: one this computer's pi lists in its clientAuth snapshot. */
export function checkProvider(provider: string, known: HeldAuth): void {
  if (!PROVIDER_ID_PATTERN.test(provider) || !Object.hasOwn(known.providers, provider)) throw new Error(`${JSON.stringify(provider.slice(0, 64))} is not a provider this computer knows`);
}

/**
 * The answer main sends a daemon, built field by field from the local core's: one of the three types, bounded strings, a
 * bounded non-negative expiresIn (clamped to MAX_BROKER_EXPIRES_IN_MS), and an empty refresh; anything else throws.
 */
export function brokerAnswerOf(raw: unknown): BrokerAnswer {
  const answer = raw as Record<string, unknown> | null;
  if (typeof answer !== 'object' || answer === null) throw new Error('The credential answer is not an object');
  switch (answer['type']) {
    case 'none':
      return { type: 'none' };
    case 'api_key':
      return { type: 'api_key', key: boundedString(answer['key'], MAX_SECRET_CHARS, 'key') };
    case 'oauth': {
      if (answer['refresh'] !== '') throw new Error('The credential answer carries a refresh token');
      const expiresIn = answer['expiresIn'];
      if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn < 0) throw new Error('The credential answer has no valid expiresIn');
      const optional = <T>(name: string, read: (value: unknown) => T): Record<string, T> => (answer[name] === undefined ? {} : { [name]: read(answer[name]) });
      return {
        type: 'oauth',
        access: boundedString(answer['access'], MAX_SECRET_CHARS, 'access token'),
        expiresIn: Math.min(Math.floor(expiresIn), MAX_BROKER_EXPIRES_IN_MS),
        refresh: '',
        ...optional('clientId', (value) => boundedString(value, MAX_EXTRA_CHARS, 'clientId')),
        ...optional('scopes', (value) => boundedStrings(value, 'scopes')),
        ...optional('enterpriseUrl', (value) => boundedString(value, MAX_EXTRA_CHARS, 'enterpriseUrl')),
        ...optional('accountId', (value) => boundedString(value, MAX_EXTRA_CHARS, 'accountId')),
        ...optional('availableModelIds', (value) => {
          const ids = planModelIdsOf(value);
          if (!ids) throw new Error("The credential answer's availableModelIds is not a plan list");
          return ids;
        }),
      };
    }
    default:
      throw new Error('The credential answer has an unknown type');
  }
}

/** The non-secret snapshot a daemon gets: per provider its type, OAuth expiry, whether pi holds a key, whether a key is saved, whether the applied key bills flat, whether an OAuth sign-in bills the allowance and the models it lists, whether the saved key is preferred over a sign-in, nothing else. */
export function clientAuthOf(raw: HeldAuth): HeldAuth {
  const providers: Record<string, HeldAuthEntry> = {};
  for (const [provider, entry] of Object.entries(raw.providers)) {
    if (!PROVIDER_ID_PATTERN.test(provider)) continue;
    const plan = entry.type === 'oauth' ? planModelIdsOf(entry.availableModelIds) : undefined;
    providers[provider] = {
      type: entry.type,
      ...(entry.type === 'oauth' && typeof entry.expires === 'number' && Number.isFinite(entry.expires) ? { expires: entry.expires } : {}),
      hasKey: entry.hasKey === true,
      ...(typeof entry.keySaved === 'boolean' ? { keySaved: entry.keySaved } : {}),
      flatFee: entry.flatFee === true,
      ...(entry.type === 'oauth' && entry.allowance === true ? { allowance: true } : {}),
      ...(plan ? { availableModelIds: plan } : {}),
      ...(entry.preferApiKey === true ? { preferApiKey: true } : {}),
    };
  }
  return { providers };
}

const ruleList = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((rule): rule is string => typeof rule === 'string' && rule.length > 0 && rule.length <= MAX_RULE_CHARS) : [];

/**
 * The clientUser allowlist: per user file, in loadPermissionsByPriority's order, only its allow, ask
 * and deny rules and its folder, so a `!` carve-out stays inside its file; and only the given contributed keys' user values.
 * Built up from those fields, so env, apiKeyHelper, hooks or anything else never cross.
 */
export function clientUserOf(files: readonly UserRulesFile[], userValues: ReadonlyMap<string, unknown>): ClientUser {
  const permissionRules: PermissionRuleLists[] = [];
  for (const { dir, settings: file } of files) {
    const permissions = file['permissions'];
    if (typeof permissions !== 'object' || permissions === null) continue;
    const lists = permissions as Record<string, unknown>;
    const rules = { allow: ruleList(lists['allow']).slice(0, MAX_RULES), ask: ruleList(lists['ask']).slice(0, MAX_RULES), deny: ruleList(lists['deny']).slice(0, MAX_RULES), dir };
    if (rules.allow.length + rules.ask.length + rules.deny.length > 0) permissionRules.push(rules);
  }
  const settings: Record<string, unknown> = {};
  for (const [key, value] of userValues) if (value !== undefined) settings[key] = value;
  return { settings, permissionRules };
}

/** The three mirrors a remote core attaches with, as values. */
export interface ClientMirrorValues {
  readonly clientAuth: ClientAuth;
  readonly clientUser: ClientUser;
  readonly clientPolicy: ClientPolicy;
}

export interface UserRelaysDeps {
  // the local core's requests, run on the running core (they wait through its restart)
  readonly resolveCredential: (provider: string) => Promise<BrokerAnswer>;
  readonly clientAuth: () => Promise<HeldAuth>;
  // this computer's voice capability (HostCapabilities.voice)
  readonly voice: boolean;
  readonly homedir: string;
  // the contributed keys core reads from the user layer, and their values in this computer's user settings
  readonly userSettingKeys: () => readonly string[];
  readonly userValue: (key: string) => unknown;
  // the authority's configured policy from this computer's host store: YOLO, the default mode and agent forwarding
  readonly hostPolicy: (authorityKey: string) => Pick<ClientPolicy, 'allowBypass' | 'defaultPermissionMode' | 'agentForwarding'>;
  readonly log: (line: string) => void;
}

type Publish = <K extends keyof ClientMirrorValues>(topic: K, value: ClientMirrorValues[K]) => void;

/**
 * Serves a remote core's user.credentials and keeps each attach's client mirrors current: a sign-in or out in the User tab
 * (the local core's user.clientAuthChanged) and a change of the user files publish a delta to every attached authority.
 */
export class UserRelays implements Disposable {
  private readonly deps: UserRelaysDeps;
  // expiries on this computer's clock; each send turns them into the ms left
  private auth: HeldAuth = { providers: {} };
  private user: ClientUser = { settings: {}, permissionRules: [] };
  // each attach's publish, by the authority it attached
  private readonly attached = new Map<Publish, { readonly authorityKey: string; readonly sharedLoopback: boolean; policy: string }>();
  private lastAuthRead = Number.NEGATIVE_INFINITY;
  // one refresh of each mirror at a time, so the last to publish read after every earlier one
  private authRefresh: Promise<void> = Promise.resolve();
  private userRefresh: Promise<void> = Promise.resolve();

  constructor(deps: UserRelaysDeps) {
    this.deps = deps;
  }

  /** The values an attach of authorityKey starts from; its publish hears every later change until disposed. sharedLoopback: ClientPolicy's. */
  attach(publish: Publish, authorityKey: string, sharedLoopback: boolean): { readonly mirrors: ClientMirrorValues; readonly subscription: Disposable } {
    const clientPolicy = this.policyOf(authorityKey, sharedLoopback);
    this.attached.set(publish, { authorityKey, sharedLoopback, policy: JSON.stringify(clientPolicy) });
    return { mirrors: { clientAuth: sentClientAuth(this.auth, Date.now()), clientUser: this.user, clientPolicy }, subscription: { dispose: () => this.attached.delete(publish) } };
  }

  /** The authority's host settings changed: each attach of it whose clientPolicy differs hears the new one. */
  policyChanged(authorityKey: string): void {
    for (const [publish, attach] of this.attached) {
      if (attach.authorityKey !== authorityKey) continue;
      const next = this.policyOf(authorityKey, attach.sharedLoopback);
      const text = JSON.stringify(next);
      if (text === attach.policy) continue;
      attach.policy = text;
      publish('clientPolicy', next);
    }
  }

  private policyOf(authorityKey: string, sharedLoopback: boolean): ClientPolicy {
    const { allowBypass, defaultPermissionMode, agentForwarding } = this.deps.hostPolicy(authorityKey);
    return {
      voice: this.deps.voice,
      allowBypass,
      ...(defaultPermissionMode !== undefined ? { defaultPermissionMode } : {}),
      ...(agentForwarding === true ? { agentForwarding } : {}),
      ...(sharedLoopback ? { sharedLoopback } : {}),
    };
  }

  /** The local core's credentials changed (or it started): re-reads its snapshot and publishes it where it differs. */
  authChanged(): Promise<void> {
    const refresh = this.authRefresh.then(() => this.refreshAuth());
    this.authRefresh = refresh.catch(() => undefined);
    return refresh;
  }

  /** The user files or settings changed: re-reads the allowlist and publishes it where it differs. */
  userChanged(): Promise<void> {
    const refresh = this.userRefresh.then(() => this.refreshUser());
    this.userRefresh = refresh.catch(() => undefined);
    return refresh;
  }

  private async refreshAuth(): Promise<void> {
    this.lastAuthRead = Date.now();
    const next = clientAuthOf(await this.deps.clientAuth());
    if (JSON.stringify(next) === JSON.stringify(this.auth)) return;
    this.auth = next;
    const sent = sentClientAuth(next, Date.now());
    for (const publish of this.attached.keys()) publish('clientAuth', sent);
  }

  private async refreshUser(): Promise<void> {
    const files = await Promise.all(userPermissionFiles(this.deps.homedir).map(async ({ dir, file }) => {
      const settings = await this.readSettingsFile(file);
      return settings ? [{ dir, settings }] : [];
    }));
    const values = new Map(this.deps.userSettingKeys().map((key) => [key, this.deps.userValue(key)] as const));
    const next = clientUserOf(files.flat(), values);
    if (JSON.stringify(next) === JSON.stringify(this.user)) return;
    this.user = next;
    for (const publish of this.attached.keys()) publish('clientUser', next);
  }

  /** A remote core's broker asks for a provider's credential: always this computer's, checked before it leaves. */
  async credentials(authority: string, provider: string): Promise<BrokerAnswer> {
    // a read under way (the one each local core start makes) lands before an ask is judged against the snapshot
    await this.authRefresh;
    // a provider signed in since the last snapshot is listed once it is re-read; an id that cannot be one never asks
    if (PROVIDER_ID_PATTERN.test(provider) && !Object.hasOwn(this.auth.providers, provider) && Date.now() - this.lastAuthRead >= AUTH_REREAD_MS) await this.authChanged();
    checkProvider(provider, this.auth);
    this.deps.log(`[remote] user.credentials ${provider} for ${authority}`);
    return brokerAnswerOf(await this.deps.resolveCredential(provider));
  }

  dispose(): void {
    this.attached.clear();
  }

  private async readSettingsFile(file: string): Promise<SettingsObject | undefined> {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.deps.log(`[remote] reading ${file} for remote chats failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    try {
      return parseSettingsText(text, file);
    } catch (err) {
      this.deps.log(`[remote] ${file} is not a settings object, so remote chats get none of its rules: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }
}
