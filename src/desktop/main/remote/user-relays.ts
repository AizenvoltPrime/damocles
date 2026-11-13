// This computer's user scope as a remote core reaches it (docs/invariants.md "Remote daemon and wire"): the broker's
// credentials, which the local core resolves and main checks, and the clientAuth, clientUser, clientPolicy, clientMcp and
// clientForges mirrors each attach publishes. Nothing here ever carries a refresh token, this computer's environment, a
// settings file's env, apiKeyHelper, hooks or a stored secret.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ContributedConfiguration } from '../../../core/config/contributed-configuration';
import { parseSettingsText, type SettingsObject } from '../../../core/config/settings-file';
import { PREFER_API_KEY_SETTINGS } from '../../../core/pi-session/provider-auth';
import type { Disposable } from '../../../platform/disposable';
import { PROVIDER_ID_PATTERN } from '../../../shared/types/messages';
import { CLIENT_FORGES_FEATURE, GIT_HOST, type ClientForges, type ClientForgeServer } from '../../../shared/git-credential';
import { brokerEnvOf, carriesAnyTag, GLOBAL_MEMORY_APPLY_TIMEOUT_MS, GLOBAL_MEMORY_READ_TIMEOUT_MS, listedAfter, listedMemoryBytes, MAX_BROKER_EXPIRES_IN_MS, MAX_GLOBAL_MEMORY_LIST_BYTES, MAX_RELAYED_MEMORIES, MAX_STANDING_GLOBALS, planModelIdsOf, sentClientAuth, type BrokerAnswer, type ClientAuth, type ClientGlobalProfile, type ClientMcp, type ClientPending, type ClientPolicy, type ClientUser, type GlobalMemoryListPage, type GlobalMemoryListRequest, type GlobalMemoryResolution, type GlobalMemorySearchFilters, type GlobalMemoryWrite, type HeldAuth, type HeldAuthEntry, type PermissionRuleLists, type RelayedMcpServer, type SearchedGlobalMemory, type UserRulesDir } from '../../../shared/remote-user';

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
// a daemon whose welcome does not list it closes the connection on a clientMcp mirror as a violation
export const CLIENT_MCP_FEATURE = 'clientMcp';
// a daemon whose welcome does not list it parses no env in an API key answer
export const BROKER_ENV_FEATURE = 'user.credentials.env';
// a daemon whose welcome does not list it drops `pending` and reads the empty values as none, so its attach waits for the reads
export const CLIENT_PENDING_FEATURE = 'client.pending';

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

/** The contributed keys a remote core reads from this computer's user layer: no machine scoped key, and no Prefer API key flag, whose one copy there is clientAuth's. */
export function relayedUserSettingKeys(contributed: Pick<ContributedConfiguration, 'keys' | 'clientMachineKeys' | 'hostKeys'>): string[] {
  const prefer = new Set(PREFER_API_KEY_SETTINGS);
  return contributed.keys.filter((key) => !contributed.clientMachineKeys.has(key) && !contributed.hostKeys.has(key) && !prefer.has(key));
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
 * bounded non-negative expiresIn (clamped to MAX_BROKER_EXPIRES_IN_MS), and an empty refresh; anything else throws. An API
 * key's env (`brokerEnvOf`) goes only with withEnv, the daemon listing BROKER_ENV_FEATURE.
 */
export function brokerAnswerOf(raw: unknown, withEnv = false): BrokerAnswer {
  const answer = raw as Record<string, unknown> | null;
  if (typeof answer !== 'object' || answer === null) throw new Error('The credential answer is not an object');
  switch (answer['type']) {
    case 'none':
      return { type: 'none' };
    case 'api_key': {
      const key = boundedString(answer['key'], MAX_SECRET_CHARS, 'key');
      if (answer['env'] === undefined) return { type: 'api_key', key };
      const env = brokerEnvOf(answer['env']);
      if (!env) throw new Error("The credential answer's env is not a bounded set of variables");
      return withEnv ? { type: 'api_key', key, env } : { type: 'api_key', key };
    }
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

/** The mirrors an attach publishes: the three it starts from, then the relayed MCP servers and the managed git servers right after it. */
export interface PublishedMirrors extends ClientMirrorValues {
  readonly clientMcp: ClientMcp;
  readonly clientForges: ClientForges;
}

/**
 * The clientForges a daemon gets, rebuilt field by field: each server's id, URL, the git hosts the takeover can name and whether
 * an account exists. The daemon's parser refuses any other git host, which would close the connection.
 */
export function clientForgesOf(servers: readonly ClientForgeServer[]): ClientForges {
  return { servers: servers.map(({ id, webUrl, gitHosts, hasAccount }) => ({ id, webUrl, gitHosts: gitHosts.filter((host) => GIT_HOST.test(host)), hasAccount })) };
}

/** The local core's global memory and personal MCP servers, which a remote core reaches only through these checks. */
export interface LocalUserScope {
  readonly memorySearch: (query: string, k: number, tiers: readonly ('global' | 'note')[], injection: boolean, filters: GlobalMemorySearchFilters) => Promise<readonly SearchedGlobalMemory[]>;
  readonly memoryProfile: () => Promise<ClientGlobalProfile>;
  readonly memoryResolve: (ids: readonly string[]) => Promise<readonly GlobalMemoryResolution[]>;
  readonly memoryApply: (writes: readonly GlobalMemoryWrite[]) => Promise<{ readonly applied: number; readonly ids?: readonly string[] }>;
  readonly memoryList: (request: GlobalMemoryListRequest) => Promise<GlobalMemoryListPage>;
  readonly mcpServers: () => Promise<readonly RelayedMcpServer[]>;
  readonly mcpCall: (server: string, tool: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<unknown>;
  readonly mcpResources: (server: string, kind: 'resources' | 'templates', cursor: string | undefined, signal: AbortSignal) => Promise<unknown>;
  readonly mcpReadResource: (server: string, uri: string, signal: AbortSignal) => Promise<unknown>;
}

/**
 * The servers a remote host learns of, rebuilt field by field from the local core's answer: names, descriptions, timeouts,
 * tool schemas and exposures and the resources flag, so nothing else a server's config holds (env, headers, a command or
 * url) can cross.
 */
export function relayedServersOf(raw: readonly RelayedMcpServer[]): RelayedMcpServer[] {
  return raw.map((server) => ({
    name: server.name,
    ...(server.description !== undefined ? { description: server.description } : {}),
    tools: server.tools.map((tool) => ({
      name: tool.name,
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      ...(tool.exposure !== undefined ? { exposure: tool.exposure } : {}),
    })),
    resources: server.resources,
    ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
  }));
}

/**
 * Refuses a user.memory.list page that is not what was asked: more rows than the bound, a row that is not a note or lacks every
 * tag asked for, more bytes than the budget unless it is one row, a row not strictly after the cursor and the row before it, or a
 * next that is not the last row's key, so the remote core's paging always advances.
 */
export function checkListPage(request: GlobalMemoryListRequest, page: GlobalMemoryListPage): void {
  const { rows, next } = page;
  if (rows.length > MAX_RELAYED_MEMORIES) throw new Error(`The global memory list answered ${rows.length} rows, over its bound`);
  let bytes = 0;
  let previous = request.cursor;
  for (const row of rows) {
    if (row.kind !== 'note') throw new Error('The global memory list answered a row that is not a note');
    if (request.tags !== undefined && request.tags.length > 0 && !carriesAnyTag(row.tags, request.tags)) throw new Error('The global memory list answered a row without a tag it was asked for');
    if (previous !== undefined && !listedAfter(row, previous)) throw new Error('The global memory list answered a row out of order');
    bytes += listedMemoryBytes(row);
    previous = row;
  }
  if (rows.length > 1 && bytes > MAX_GLOBAL_MEMORY_LIST_BYTES) throw new Error(`The global memory list answered ${bytes} bytes, over its budget`);
  const last = rows.at(-1);
  if (next !== undefined && (last === undefined || next.createdAt !== last.createdAt || next.id !== last.id)) throw new Error("The global memory list's next is not its last row");
}

/** What `answer` settles to, or a rejection once ms pass first; the remote core treats that as a failure of its call. */
async function withinTimeout<T>(what: string, ms: number, answer: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`This computer's core did not answer ${what} within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([answer, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** An MCP result a personal server answered: an object, as every MCP result is. */
function mcpResultOf(raw: unknown, what: string): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`The answer of ${what} is not an MCP result`);
  return raw;
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
  // the host store has a record for the authority; the git relay answers nothing to one without
  readonly savedHost: (authorityKey: string) => boolean;
  readonly local: LocalUserScope;
  // the local core's managed servers once it read its forge files or failed to: never a login or a token
  readonly forges: () => Promise<readonly ClientForgeServer[]>;
  // this computer's engine is halted, so no read of its sign-ins lands before Restart Engine
  readonly engineHalted: () => boolean;
  readonly log: (line: string) => void;
}

type Publish = <K extends keyof PublishedMirrors>(topic: K, value: PublishedMirrors[K]) => void;

/**
 * Serves a remote core's user.credentials and keeps each attach's client mirrors current: a sign-in or out in the User tab
 * (the local core's user.clientAuthChanged) and a change of the user files publish a delta to every attached authority.
 */
export class UserRelays implements Disposable {
  private readonly deps: UserRelaysDeps;
  // expiries on this computer's clock; each send turns them into the ms left
  private auth: HeldAuth = { providers: {} };
  private user: ClientUser = { settings: {}, permissionRules: [] };
  // why each is not known yet; undefined once a read of it landed
  private authPending: ClientPending | undefined = 'reading';
  private userPending: ClientPending | undefined = 'reading';
  // each attach's publish, by the authority it attached; pending: its daemon lists CLIENT_PENDING_FEATURE; mcp: its daemon
  // lists CLIENT_MCP_FEATURE; forges: its daemon lists CLIENT_FORGES_FEATURE and the authority is a saved host
  private readonly attached = new Map<Publish, { readonly authorityKey: string; readonly sharedLoopback: boolean; readonly pending: boolean; readonly mcp: boolean; readonly forges: boolean; policy: string }>();
  // the managed servers as last published, and whether a read of them landed
  private forges: ClientForges = { servers: [] };
  private forgesKnown = false;
  private forgesRefresh: Promise<void> = Promise.resolve();
  private lastAuthRead = Number.NEGATIVE_INFINITY;
  // the personal MCP servers marked available on remote hosts, as last published; each relayed request is checked against them
  private mcp: readonly RelayedMcpServer[] = [];
  // why they are not known yet; undefined once a read of them landed
  private mcpPending: ClientPending | undefined = 'reading';
  private mcpRefresh: Promise<void> = Promise.resolve();
  // settles once the first read of them landed or failed, which a relayed request waits for
  private readonly mcpRead: Promise<void>;
  private mcpReadSettled!: () => void;
  // one refresh of each mirror at a time, so the last to publish read after every earlier one
  private authRefresh: Promise<void> = Promise.resolve();
  private userRefresh: Promise<void> = Promise.resolve();
  // settle once the first read of each landed or failed, which an older daemon's attach waits for
  private readonly authRead: Promise<void>;
  private authReadSettled!: () => void;
  private readonly userRead: Promise<void>;
  private userReadSettled!: () => void;
  private readonly forgesRead: Promise<void>;
  private forgesReadSettled!: () => void;

  constructor(deps: UserRelaysDeps) {
    this.deps = deps;
    this.forgesRead = new Promise((resolve) => (this.forgesReadSettled = resolve));
    this.mcpRead = new Promise((resolve) => (this.mcpReadSettled = resolve));
    this.authRead = new Promise((resolve) => (this.authReadSettled = resolve));
    this.userRead = new Promise((resolve) => (this.userReadSettled = resolve));
  }

  /**
   * The values an attach of authorityKey starts from; its publish hears every later change until disposed. A daemon listing
   * CLIENT_PENDING_FEATURE starts at once, with the sign-ins and user files marked pending until read, and hears the personal
   * MCP servers and managed servers marked pending, then once read. Any other daemon would read those empty values as none, so its attach waits
   * until the first read of each of the four settled. sharedLoopback: ClientPolicy's. features: the daemon's
   * welcome.features, which decide the topics it hears.
   */
  attach(publish: Publish, authorityKey: string, sharedLoopback: boolean, features: readonly string[]): { readonly mirrors: Promise<ClientMirrorValues>; readonly subscription: Disposable } {
    let disposed = false;
    const subscription = {
      dispose: () => {
        disposed = true;
        this.attached.delete(publish);
      },
    };
    if (features.includes(CLIENT_PENDING_FEATURE)) return { mirrors: Promise.resolve(this.register(publish, authorityKey, sharedLoopback, features, true)), subscription };
    const mirrors = Promise.all([this.authRead, this.userRead, this.mcpRead, this.forgesRead])
      .then(() => (disposed ? this.valuesOf(authorityKey, sharedLoopback, false) : this.register(publish, authorityKey, sharedLoopback, features, false)));
    return { mirrors, subscription };
  }

  /** The engine halted or started: sign-ins whose last read failed are pending for the reason that holds now; a read under way stays reading. */
  engineHaltedChanged(): void {
    if (this.authPending === undefined || this.authPending === 'reading') return;
    this.authPendingBecause(this.deps.engineHalted() ? 'engineStopped' : 'readFailed');
  }

  private valuesOf(authorityKey: string, sharedLoopback: boolean, pending: boolean): ClientMirrorValues {
    return {
      clientAuth: pending && this.authPending !== undefined ? { providers: {}, pending: this.authPending } : sentClientAuth(this.auth, Date.now()),
      clientUser: pending && this.userPending !== undefined ? { settings: {}, permissionRules: [], pending: this.userPending } : this.user,
      clientPolicy: this.policyOf(authorityKey, sharedLoopback),
    };
  }

  // registered with the values it starts from, so no delta reaches it before them
  private register(publish: Publish, authorityKey: string, sharedLoopback: boolean, features: readonly string[], pending: boolean): ClientMirrorValues {
    const values = this.valuesOf(authorityKey, sharedLoopback, pending);
    const mcp = features.includes(CLIENT_MCP_FEATURE);
    // a takeover there could never be answered, so its git keeps the user's own helpers
    const forges = features.includes(CLIENT_FORGES_FEATURE) && this.deps.savedHost(authorityKey);
    this.attached.set(publish, { authorityKey, sharedLoopback, pending, mcp, forges, policy: JSON.stringify(values.clientPolicy) });
    // an empty list included: a core keeps a detached client's last list, which a reattach must replace; each is marked
    // pending until its first read lands
    if (mcp) publish('clientMcp', pending && this.mcpPending !== undefined ? { servers: [], pending: this.mcpPending } : { servers: this.mcp });
    if (forges) publish('clientForges', !pending || this.forgesKnown ? this.forges : { servers: [], pending: true });
    return values;
  }

  // a pending value reaches only the attaches whose daemon reads it
  private authPendingBecause(reason: ClientPending): void {
    if (this.authPending === undefined || this.authPending === reason) return;
    this.authPending = reason;
    for (const [publish, attach] of this.attached) if (attach.pending) publish('clientAuth', { providers: {}, pending: reason });
  }

  private userPendingBecause(reason: ClientPending): void {
    if (this.userPending === undefined || this.userPending === reason) return;
    this.userPending = reason;
    for (const [publish, attach] of this.attached) if (attach.pending) publish('clientUser', { settings: {}, permissionRules: [], pending: reason });
  }

  private mcpPendingBecause(reason: ClientPending): void {
    if (this.mcpPending === undefined || this.mcpPending === reason) return;
    this.mcpPending = reason;
    for (const [publish, attach] of this.attached) if (attach.pending && attach.mcp) publish('clientMcp', { servers: [], pending: reason });
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
    const refresh = this.authRefresh.then(() => this.refreshAuth()).finally(() => this.authReadSettled());
    this.authRefresh = refresh.catch(() => undefined);
    return refresh;
  }

  /** The user files or settings changed: re-reads the allowlist and publishes it where it differs. */
  userChanged(): Promise<void> {
    const refresh = this.userRefresh.then(() => this.refreshUser()).finally(() => this.userReadSettled());
    this.userRefresh = refresh.catch(() => undefined);
    return refresh;
  }

  /** The marked personal servers or their tools changed (or the local core started): re-reads and publishes them where they differ. */
  mcpChanged(): Promise<void> {
    const refresh = this.mcpRefresh.then(async () => {
      this.mcpPendingBecause('reading');
      let next: RelayedMcpServer[];
      try {
        next = relayedServersOf(await this.deps.local.mcpServers());
      } catch (err) {
        this.mcpPendingBecause('readFailed');
        throw err;
      }
      const first = this.mcpPending !== undefined;
      this.mcpPending = undefined;
      if (!first && JSON.stringify(next) === JSON.stringify(this.mcp)) return;
      this.mcp = next;
      for (const [publish, attach] of this.attached) if (attach.mcp) publish('clientMcp', { servers: next });
    }).finally(() => this.mcpReadSettled());
    this.mcpRefresh = refresh.catch(() => undefined);
    return refresh;
  }

  /** The local core's forge mirror changed (or it started): re-reads the servers, and each attach whose daemon lists clientForges hears them where they differ. */
  forgesChanged(): Promise<void> {
    const refresh = this.forgesRefresh.then(async () => {
      const next = clientForgesOf(await this.deps.forges());
      const first = !this.forgesKnown;
      this.forgesKnown = true;
      if (!first && JSON.stringify(next) === JSON.stringify(this.forges)) return;
      this.forges = next;
      for (const [publish, attach] of this.attached) if (attach.forges) publish('clientForges', next);
    }).finally(() => this.forgesReadSettled());
    this.forgesRefresh = refresh.catch(() => undefined);
    return refresh;
  }

  /** A remote core's search of this computer's global memory (injection: its injection's gate): at most k rows, each of a tier it asked for. */
  async memorySearch(authority: string, query: string, k: number, tiers: readonly ('global' | 'note')[], injection = false, filters: GlobalMemorySearchFilters = {}): Promise<readonly SearchedGlobalMemory[]> {
    const found = await withinTimeout('user.memory.search', GLOBAL_MEMORY_READ_TIMEOUT_MS, this.deps.local.memorySearch(query, k, tiers, injection, filters));
    if (found.length > k) throw new Error(`The global memory search answered ${found.length} rows for ${k}`);
    for (const memory of found) {
      if (!tiers.includes(memory.kind === 'note' ? 'note' : 'global')) throw new Error('The global memory search answered a row of a tier it was not asked for');
    }
    this.deps.log(`[remote] user.memory.search for ${authority}: ${found.length} rows`);
    return found;
  }

  /** This computer's global profile, pinned globals and global preferences: at most the bound each, each of its own kind. */
  async memoryProfile(): Promise<ClientGlobalProfile> {
    const answer = await withinTimeout('user.memory.profile', GLOBAL_MEMORY_READ_TIMEOUT_MS, this.deps.local.memoryProfile());
    if (answer.pinned.length > MAX_STANDING_GLOBALS || answer.preferences.length > MAX_STANDING_GLOBALS) throw new Error('The global profile answer lists more memories than its bound');
    if (answer.pinned.some((memory) => memory.kind === 'note') || answer.preferences.some((memory) => memory.kind !== 'preference')) throw new Error('The global profile answer lists a memory of the wrong kind');
    return answer;
  }

  /** The current version of global memories a remote core named by id: one answer per id it asked about, no other. */
  async memoryResolve(ids: readonly string[]): Promise<readonly GlobalMemoryResolution[]> {
    const answers = await withinTimeout('user.memory.resolve', GLOBAL_MEMORY_READ_TIMEOUT_MS, this.deps.local.memoryResolve(ids));
    if (answers.length > ids.length || answers.some((answer) => !ids.includes(answer.id))) throw new Error('The global memory answer names an id it was not asked about');
    return answers;
  }

  /** Applies a remote core's writes in order and acknowledges the byte offset after the last one applied, and the row of each. */
  async memoryApply(authority: string, entries: readonly { readonly end: number; readonly write: GlobalMemoryWrite }[]): Promise<{ readonly through: number; readonly ids?: readonly string[] }> {
    const { applied, ids } = await withinTimeout('user.memory.apply', GLOBAL_MEMORY_APPLY_TIMEOUT_MS, this.deps.local.memoryApply(entries.map((entry) => entry.write)));
    if (!Number.isInteger(applied) || applied < 0 || applied > entries.length) throw new Error(`The global memory apply answered ${applied} for ${entries.length} writes`);
    if (ids !== undefined && ids.length !== applied) throw new Error(`The global memory apply answered ${ids.length} rows for ${applied} writes`);
    this.deps.log(`[remote] user.memory.apply for ${authority}: ${applied} of ${entries.length} writes`);
    return { through: applied === 0 ? 0 : entries[applied - 1]!.end, ...(ids !== undefined ? { ids } : {}) };
  }

  /** One page of this computer's latest global rows a remote core lists, checked before it leaves (checkListPage). */
  async memoryList(authority: string, request: GlobalMemoryListRequest): Promise<GlobalMemoryListPage> {
    const page = await withinTimeout('user.memory.list', GLOBAL_MEMORY_READ_TIMEOUT_MS, this.deps.local.memoryList(request));
    checkListPage(request, page);
    this.deps.log(`[remote] user.memory.list for ${authority}: ${page.rows.length} rows${page.next !== undefined ? ', more to come' : ''}`);
    return page;
  }

  /** A server published now; a request that arrives before the first read waits for it, as a credential ask waits for its snapshot. */
  private async relayedServer(server: string): Promise<RelayedMcpServer> {
    await this.mcpRead;
    const found = this.mcp.find((candidate) => candidate.name === server);
    if (!found) throw new Error(`MCP server ${JSON.stringify(server.slice(0, 64))} is not available on remote hosts`);
    return found;
  }

  /** A remote core's call of a personal server: only a server marked available, and only a tool it lists; its caller's abort ends it. */
  async mcpCall(authority: string, server: string, tool: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown> {
    if (!(await this.relayedServer(server)).tools.some((candidate) => candidate.name === tool)) throw new Error(`MCP server ${JSON.stringify(server.slice(0, 64))} has no tool ${JSON.stringify(tool.slice(0, 64))}`);
    this.deps.log(`[remote] user.mcp.call for ${authority}: ${server}`);
    return mcpResultOf(await this.deps.local.mcpCall(server, tool, args, signal), `MCP server ${server}`);
  }

  /** A remote core's resource listing of a personal server: only a server marked available that offers resources. */
  async mcpResources(authority: string, server: string, kind: 'resources' | 'templates', cursor: string | undefined, signal: AbortSignal): Promise<unknown> {
    if (!(await this.relayedServer(server)).resources) throw new Error(`MCP server ${JSON.stringify(server.slice(0, 64))} offers no resources`);
    this.deps.log(`[remote] user.mcp.resources for ${authority}: ${server}`);
    return mcpResultOf(await this.deps.local.mcpResources(server, kind, cursor, signal), `MCP server ${server}`);
  }

  async mcpReadResource(authority: string, server: string, uri: string, signal: AbortSignal): Promise<unknown> {
    if (!(await this.relayedServer(server)).resources) throw new Error(`MCP server ${JSON.stringify(server.slice(0, 64))} offers no resources`);
    this.deps.log(`[remote] user.mcp.readResource for ${authority}: ${server}`);
    return mcpResultOf(await this.deps.local.mcpReadResource(server, uri, signal), `MCP server ${server}`);
  }

  // a failed read keeps a pending value pending, with why, until a read lands; a known value stays as last read
  private async refreshAuth(): Promise<void> {
    this.lastAuthRead = Date.now();
    this.authPendingBecause('reading');
    let next: HeldAuth;
    try {
      next = clientAuthOf(await this.deps.clientAuth());
    } catch (err) {
      this.authPendingBecause(this.deps.engineHalted() ? 'engineStopped' : 'readFailed');
      throw err;
    }
    const wasPending = this.authPending !== undefined;
    this.authPending = undefined;
    const changed = JSON.stringify(next) !== JSON.stringify(this.auth);
    if (!changed && !wasPending) return;
    this.auth = next;
    const sent = sentClientAuth(next, Date.now());
    for (const [publish, attach] of this.attached) if (changed || attach.pending) publish('clientAuth', sent);
  }

  private async refreshUser(): Promise<void> {
    this.userPendingBecause('reading');
    let next: ClientUser;
    try {
      const files = await Promise.all(userPermissionFiles(this.deps.homedir).map(async ({ dir, file }) => {
        const settings = await this.readSettingsFile(file);
        return settings ? [{ dir, settings }] : [];
      }));
      const values = new Map(this.deps.userSettingKeys().map((key) => [key, this.deps.userValue(key)] as const));
      next = clientUserOf(files.flat(), values);
    } catch (err) {
      this.userPendingBecause('readFailed');
      throw err;
    }
    const wasPending = this.userPending !== undefined;
    this.userPending = undefined;
    const changed = JSON.stringify(next) !== JSON.stringify(this.user);
    if (!changed && !wasPending) return;
    this.user = next;
    for (const [publish, attach] of this.attached) if (changed || attach.pending) publish('clientUser', next);
  }

  /** A remote core's broker asks for a provider's credential: always this computer's, checked before it leaves. features: the daemon's welcome.features. */
  async credentials(authority: string, provider: string, features: readonly string[] = []): Promise<BrokerAnswer> {
    // a read under way (the one each local core start makes) lands before an ask is judged against the snapshot
    await this.authRefresh;
    // a provider signed in since the last snapshot is listed once it is re-read; an id that cannot be one never asks
    if (PROVIDER_ID_PATTERN.test(provider) && !Object.hasOwn(this.auth.providers, provider) && Date.now() - this.lastAuthRead >= AUTH_REREAD_MS) await this.authChanged();
    checkProvider(provider, this.auth);
    this.deps.log(`[remote] user.credentials ${provider} for ${authority}`);
    return brokerAnswerOf(await this.deps.resolveCredential(provider), features.includes(BROKER_ENV_FEATURE));
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
