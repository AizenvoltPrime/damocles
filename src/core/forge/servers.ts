import * as path from 'node:path';
import type { ForgeRouteAvailability, ForgeRoutes, ForgeServerFormField } from '../../shared/forge/accounts';
import type { LocalizedText } from '../../shared/localized-text';
import { l } from '../l10n';
import type { TokenStore } from './accounts/token-store';
import { createForgeFile, type ForgeFile } from './forge-file';
import { gitLabVersionAtLeast, MIN_GITLAB_DEVICE_VERSION } from './providers/gitlab/user';
import { flavorOf, parseGitHost, parseServerUrl, serverUrlProblemText } from './server-url';
import {
  GITHUB_COM,
  GITLAB_COM,
  type ForgeBuildOAuth,
  type ForgeKind,
  type ForgeServer,
  type ForgeServerOverride,
  type OAuthClient,
  type ServerRecord,
} from './types';

// The server registry: the built-in github.com and gitlab.com, and the servers the user added (servers.json).

export interface ServersFile {
  readonly version: 1;
  readonly servers: readonly ServerRecord[];
}

const BUILT_IN_RECORDS: readonly ServerRecord[] = [
  { id: GITHUB_COM, kind: 'github', flavor: 'github.com', gitHosts: ['github.com', 'ssh.github.com'], addedAt: 0 },
  { id: GITLAB_COM, kind: 'gitlab', flavor: 'gitlab', gitHosts: ['gitlab.com', 'altssh.gitlab.com'], addedAt: 0 },
];
const CLIENT_ID = /^[A-Za-z0-9._-]{1,200}$/;
const CLIENT_SECRET = /^[\x21-\x7e]{1,256}$/;
const MAX_GIT_HOSTS = 16;
const MAX_DISMISSED_GIT_HOSTS = 64;

function isHostList(raw: unknown, max: number): raw is string[] {
  return Array.isArray(raw) && raw.length <= max && raw.every((host) => typeof host === 'string' && parseGitHost(host) === host);
}

function parseRecord(raw: unknown): ServerRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const { id, kind, flavor, gitHosts, pendingGitHosts, dismissedGitHosts, addedAt } = record;
  if (typeof id !== 'string' || (kind !== 'github' && kind !== 'gitlab') || typeof addedAt !== 'number') return undefined;
  const url = parseServerUrl(`https://${id}`);
  if (!url.ok || url.url.id !== id) return undefined;
  const expected = flavorOf(kind, url.url);
  if (!expected.ok || expected.flavor !== flavor) return undefined;
  if (!isHostList(gitHosts, MAX_GIT_HOSTS)) return undefined;
  if (pendingGitHosts !== undefined && !isHostList(pendingGitHosts, MAX_GIT_HOSTS)) return undefined;
  if (dismissedGitHosts !== undefined && !isHostList(dismissedGitHosts, MAX_DISMISSED_GIT_HOSTS)) return undefined;
  const oauth = record['oauth'];
  const clientId = typeof oauth === 'object' && oauth !== null ? (oauth as Record<string, unknown>)['clientId'] : undefined;
  if (oauth !== undefined && (typeof clientId !== 'string' || !CLIENT_ID.test(clientId))) return undefined;
  const text = (key: string): Record<string, string> => (typeof record[key] === 'string' && (record[key] as string).length <= 256 ? { [key]: record[key] as string } : {});
  return {
    id,
    kind,
    flavor: expected.flavor,
    ...text('name'),
    gitHosts,
    ...(pendingGitHosts !== undefined ? { pendingGitHosts } : {}),
    ...(dismissedGitHosts !== undefined ? { dismissedGitHosts } : {}),
    ...(typeof clientId === 'string' ? { oauth: { clientId } } : {}),
    ...text('version'),
    ...(typeof record['versionCheckedAt'] === 'number' ? { versionCheckedAt: record['versionCheckedAt'] } : {}),
    ...text('apiVersion'),
    addedAt,
  };
}

export function parseServersFile(raw: unknown): ServersFile | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { version, servers } = raw as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(servers)) return undefined;
  const parsed = servers.map(parseRecord);
  if (!parsed.every((server): server is ServerRecord => server !== undefined)) return undefined;
  const ids = new Set<string>([GITHUB_COM, GITLAB_COM]);
  for (const server of parsed) {
    if (ids.has(server.id)) return undefined;
    ids.add(server.id);
  }
  return { version: 1, servers: parsed };
}

export interface ServerRegistryDeps {
  readonly forgeDir: string;
  readonly tokens: TokenStore;
  readonly buildOAuth: ForgeBuildOAuth;
  /** Development builds' DAMOCLES_E2E_FORGE_SERVERS: built-in servers pointed at a stub. */
  readonly overrides?: Readonly<Partial<Record<typeof GITHUB_COM | typeof GITLAB_COM, ForgeServerOverride>>>;
  readonly log: (line: string) => void;
}

export interface ServerInput {
  readonly url: string;
  readonly kind: ForgeKind;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly gitHosts: readonly string[];
}

/** An edit: clientSecret absent keeps the stored one, "" removes it; a removed or changed client id without a new secret removes it too. */
export interface ServerEdit {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly gitHosts: readonly string[];
}

export type ServerFormOutcome = { readonly ok: true; readonly server: ForgeServer } | { readonly ok: false; readonly field: ForgeServerFormField; readonly message: LocalizedText };

export interface ServerRegistry {
  readonly file: ForgeFile<ServersFile>;
  load(): Promise<void>;
  /** Built-ins first, then added servers in addedAt order. */
  list(): readonly ForgeServer[];
  get(id: string): ForgeServer | undefined;
  routes(server: ForgeServer): ForgeRoutes;
  add(input: ServerInput, now: number): Promise<ServerFormOutcome>;
  edit(id: string, edit: ServerEdit): Promise<ServerFormOutcome>;
  remove(id: string): Promise<void>;
  recordVersion(id: string, version: { readonly version?: string; readonly apiVersion?: string }, at: number): Promise<void>;
  /** Records hosts of the server's clone URLs as pending: no host is managed until the user confirms it. */
  learnGitHosts(id: string, hosts: readonly string[]): Promise<void>;
  /** Moves a pending host into the server's git hosts, refused when another server claims it. */
  confirmGitHost(id: string, host: string): Promise<ServerFormOutcome>;
  /** Drops a pending host and remembers it, so the clone URLs do not propose it again. */
  dismissGitHost(id: string, host: string): Promise<ServerFormOutcome>;
}

function originsOf(webUrl: string, apiUrl: string): ReadonlySet<string> {
  return new Set([new URL(webUrl).origin, new URL(apiUrl).origin]);
}

function apiUrlOf(record: ServerRecord, webUrl: string): string {
  switch (record.flavor) {
    case 'github.com': return 'https://api.github.com';
    case 'ghe.com': return `https://api.${record.id}`;
    case 'ghes': return `${webUrl}/api/v3`;
    case 'gitlab': return `${webUrl}/api/v4`;
  }
}

function parseGitHosts(raw: readonly string[]): { readonly ok: true; readonly hosts: string[] } | { readonly ok: false; readonly message: LocalizedText } {
  const hosts: string[] = [];
  for (const item of raw) {
    if (item.trim() === '') continue;
    const host = parseGitHost(item);
    if (host === undefined) return { ok: false, message: l('"{0}" is not a host name. Enter host names such as git.example.com.', item.trim().slice(0, 100)) };
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts.length > MAX_GIT_HOSTS ? { ok: false, message: l('Enter at most {0} git hosts.', MAX_GIT_HOSTS) } : { ok: true, hosts };
}

export function createServerRegistry(deps: ServerRegistryDeps): ServerRegistry {
  const file = createForgeFile<ServersFile>({ filePath: path.join(deps.forgeDir, 'servers.json'), parse: parseServersFile, empty: { version: 1, servers: [] }, log: deps.log });
  // GHES client secrets, read once at load and kept with the registry
  const clientSecrets = new Map<string, string>();

  function resolve(record: ServerRecord, builtIn: boolean): ForgeServer {
    const override = builtIn ? deps.overrides?.[record.id as typeof GITHUB_COM] : undefined;
    const webUrl = override?.webUrl ?? `https://${record.id}`;
    const apiUrl = override ? override.apiUrl ?? `${webUrl}${record.kind === 'github' ? '/api/v3' : '/api/v4'}` : apiUrlOf(record, webUrl);
    let oauth: OAuthClient | undefined;
    if (override) {
      if (override.oauth) oauth = { clientId: override.oauth.clientId, ...(override.oauth.clientSecret !== undefined ? { clientSecret: override.oauth.clientSecret } : {}) };
    } else if (builtIn) {
      const built: OAuthClient | undefined = record.kind === 'github' ? deps.buildOAuth.github : deps.buildOAuth.gitlab;
      if (built) oauth = { clientId: built.clientId, ...(built.clientSecret !== undefined ? { clientSecret: built.clientSecret } : {}) };
    } else if (record.oauth) {
      const secret = clientSecrets.get(record.id);
      oauth = { clientId: record.oauth.clientId, ...(secret !== undefined ? { clientSecret: secret } : {}) };
    }
    return {
      record,
      id: record.id,
      kind: record.kind,
      flavor: record.flavor,
      builtIn,
      webUrl,
      apiUrl,
      origins: originsOf(webUrl, apiUrl),
      ...(oauth ? { oauth } : {}),
    };
  }

  function list(): readonly ForgeServer[] {
    const added = [...file.value().servers].sort((a, b) => a.addedAt - b.addedAt);
    return [...BUILT_IN_RECORDS.map((record) => resolve(record, true)), ...added.map((record) => resolve(record, false))];
  }

  // A git host of S that another server also names would draw that server's credential asks to S. The one shared host allowed
  // is a web host of GitLab servers under disjoint path prefixes, which useHttpPath tells apart (webHostShareable).
  function claimedHosts(exceptId: string | undefined): ReadonlySet<string> {
    const hosts = new Set<string>();
    for (const server of list()) {
      if (server.id === exceptId) continue;
      hosts.add(new URL(server.webUrl).host);
      for (const host of server.record.gitHosts) hosts.add(host);
    }
    return hosts;
  }

  /** Whether a new server of kind at url may share its web host with every other server that has it. */
  function webHostShareable(kind: ForgeKind, host: string, path: string): boolean {
    const segments = (value: string): string[] => value.split('/').filter((segment) => segment !== '');
    const prefixOf = (a: string[], b: string[]): boolean => a.every((segment, index) => b[index] === segment);
    const mine = segments(path);
    for (const server of list()) {
      const other = new URL(server.webUrl);
      if (server.record.gitHosts.includes(host) && other.host !== host) return false;
      if (other.host !== host) continue;
      const theirs = segments(server.id.slice(other.host.length));
      if (kind !== 'gitlab' || server.kind !== 'gitlab' || server.builtIn || mine.length === 0 || theirs.length === 0) return false;
      if (prefixOf(mine, theirs) || prefixOf(theirs, mine)) return false;
    }
    return true;
  }

  function claimedError(host: string): { field: ForgeServerFormField; message: LocalizedText } {
    return { field: 'gitHosts', message: l('{0} belongs to another server in the list. Remove it from Other git hosts.', host) };
  }

  function checkClient(kind: ForgeKind, clientId: string | undefined, clientSecret: string | undefined): { field: ForgeServerFormField; message: LocalizedText } | undefined {
    if (clientId !== undefined && clientId.trim() !== '' && !CLIENT_ID.test(clientId.trim())) return { field: 'clientId', message: l('Paste the client id exactly as the server shows it.') };
    if (clientSecret === undefined || clientSecret === '') return undefined;
    if (kind !== 'github') return { field: 'clientSecret', message: l('A GitLab application needs no client secret. Leave Confidential off and remove the secret.') };
    if (!CLIENT_SECRET.test(clientSecret.trim())) return { field: 'clientSecret', message: l('Paste the client secret exactly as the server shows it.') };
    if (clientId === undefined || clientId.trim() === '') return { field: 'clientId', message: l('Enter the client id that goes with this secret.') };
    return undefined;
  }

  return {
    file,
    async load() {
      await file.load();
      for (const record of file.value().servers) {
        if (record.kind !== 'github' || !record.oauth) continue;
        const secret = await deps.tokens.getClientSecret(record.id);
        if (secret !== undefined) clientSecrets.set(record.id, secret);
      }
    },
    list,
    get: (id) => list().find((server) => server.id === id),

    routes(server) {
      const token: ForgeRouteAvailability = {};
      if (!server.oauth) {
        const reason = server.builtIn
          ? l('This build of Damocles has no OAuth app for {0}. Sign in with a token.', server.id)
          : l("Add this server's OAuth app client id in Edit server to use this.");
        return { browser: { reason }, device: { reason }, token };
      }
      const browser: ForgeRouteAvailability = server.kind === 'github' && server.oauth.clientSecret === undefined
        ? { reason: server.builtIn ? l('This build of Damocles has no client secret for {0}, so it cannot sign in with the browser. Use a device code or a token.', server.id) : l("Add the OAuth app's client secret in Edit server to sign in with the browser.") }
        : {};
      // an unknown version keeps the route, and the server's refusal says it has no device code sign-in
      const version = server.record.version;
      const device: ForgeRouteAvailability = server.kind === 'gitlab' && version !== undefined && !gitLabVersionAtLeast(version, MIN_GITLAB_DEVICE_VERSION)
        ? { reason: l('Device code sign-in needs GitLab 17.1 or later. This server runs GitLab {0}.', version) }
        : {};
      return { browser, device, token };
    },

    async add(input, now) {
      const parsed = parseServerUrl(input.url);
      if (!parsed.ok) return { ok: false, field: 'url', message: serverUrlProblemText(parsed.problem) };
      const flavor = flavorOf(input.kind, parsed.url);
      if (!flavor.ok) return { ok: false, field: 'url', message: serverUrlProblemText(flavor.problem) };
      if (list().some((server) => server.id === parsed.url.id)) return { ok: false, field: 'url', message: serverUrlProblemText('builtIn') };
      const client = checkClient(input.kind, input.clientId, input.clientSecret);
      if (client) return { ok: false, ...client };
      const gitHosts = parseGitHosts(input.gitHosts);
      if (!gitHosts.ok) return { ok: false, field: 'gitHosts', message: gitHosts.message };
      if (!webHostShareable(input.kind, parsed.url.host, parsed.url.path)) return { ok: false, field: 'url', message: l('{0} is already a host of another server in the list.', parsed.url.host) };
      const claimed = claimedHosts(undefined);
      const taken = gitHosts.hosts.find((host) => host !== parsed.url.host && claimed.has(host));
      if (taken !== undefined) return { ok: false, ...claimedError(taken) };
      const clientId = input.clientId?.trim();
      const record: ServerRecord = {
        id: parsed.url.id,
        kind: input.kind,
        flavor: flavor.flavor,
        gitHosts: [...new Set([parsed.url.host, ...gitHosts.hosts])],
        ...(clientId ? { oauth: { clientId } } : {}),
        addedAt: now,
      };
      const secret = input.clientSecret?.trim();
      // clears a secret an earlier remove left behind, which load() would otherwise revive
      await deps.tokens.setClientSecret(record.id, secret || undefined);
      try {
        await file.update((current) => ({ version: 1, servers: [...current.servers.filter((server) => server.id !== record.id), record] }));
      } catch (err) {
        if (secret) await deps.tokens.setClientSecret(record.id, undefined);
        throw err;
      }
      if (secret) clientSecrets.set(record.id, secret);
      return { ok: true, server: resolve(record, false) };
    },

    async edit(id, edit) {
      const existing = file.value().servers.find((server) => server.id === id);
      if (!existing) return { ok: false, field: 'url', message: l('This server is no longer in the list.') };
      const clientId = edit.clientId?.trim() || undefined;
      const client = checkClient(existing.kind, clientId, edit.clientSecret);
      if (client) return { ok: false, ...client };
      const gitHosts = parseGitHosts(edit.gitHosts);
      if (!gitHosts.ok) return { ok: false, field: 'gitHosts', message: gitHosts.message };
      const webHost = new URL(`https://${existing.id}`).host;
      const claimed = claimedHosts(id);
      const taken = gitHosts.hosts.find((host) => host !== webHost && claimed.has(host));
      if (taken !== undefined) return { ok: false, ...claimedError(taken) };
      const typed = [...new Set([webHost, ...gitHosts.hosts])];
      const updated = await file.update((current) => ({
        version: 1,
        servers: current.servers.map((server) => {
          if (server.id !== id) return server;
          const { oauth: _oauth, ...rest } = server;
          return { ...withPending({ ...rest, gitHosts: typed }, (server.pendingGitHosts ?? []).filter((host) => !typed.includes(host))), ...(clientId ? { oauth: { clientId } } : {}) };
        }),
      }));
      const secret = edit.clientSecret?.trim();
      // another app's secret would make every browser sign-in fail
      const otherApp = clientId !== existing.oauth?.clientId;
      if (!clientId || edit.clientSecret === '' || (otherApp && !secret)) {
        await deps.tokens.setClientSecret(id, undefined);
        clientSecrets.delete(id);
      } else if (secret) {
        await deps.tokens.setClientSecret(id, secret);
        clientSecrets.set(id, secret);
      }
      return { ok: true, server: resolve(updated.servers.find((server) => server.id === id)!, false) };
    },

    async remove(id) {
      // the secret goes first: a failure leaves the server listed, so the remove can be tried again
      await deps.tokens.setClientSecret(id, undefined);
      clientSecrets.delete(id);
      await file.update((current) => ({ version: 1, servers: current.servers.filter((server) => server.id !== id) }));
    },

    async recordVersion(id, version, at) {
      if (!file.value().servers.some((server) => server.id === id)) return;
      await file.update((current) => ({
        version: 1,
        servers: current.servers.map((server) => (server.id === id ? { ...server, ...version, versionCheckedAt: at } : server)),
      }));
    },

    async learnGitHosts(id, hosts) {
      const record = file.value().servers.find((server) => server.id === id);
      if (!record) return;
      const claimed = claimedHosts(id);
      const known = new Set([...record.gitHosts, ...(record.pendingGitHosts ?? []), ...(record.dismissedGitHosts ?? [])]);
      const learned = [...new Set(hosts)].filter((host) => parseGitHost(host) === host && !known.has(host) && !claimed.has(host));
      if (learned.length === 0) return;
      await file.update((current) => ({
        version: 1,
        servers: current.servers.map((server) => (server.id === id ? { ...server, pendingGitHosts: [...(server.pendingGitHosts ?? []), ...learned].slice(0, MAX_GIT_HOSTS) } : server)),
      }));
    },

    async confirmGitHost(id, host) {
      const record = file.value().servers.find((server) => server.id === id);
      if (!record) return { ok: false, field: 'gitHosts', message: l('This server is no longer in the list.') };
      if (record.gitHosts.includes(host)) return { ok: true, server: resolve(record, false) };
      if (!record.pendingGitHosts?.includes(host)) return { ok: false, field: 'gitHosts', message: l('{0} is no longer waiting for confirmation.', host) };
      if (claimedHosts(id).has(host)) return { ok: false, field: 'gitHosts', message: l('{0} belongs to another server in the list, so it cannot be a git host of this one.', host) };
      if (record.gitHosts.length >= MAX_GIT_HOSTS) return { ok: false, field: 'gitHosts', message: l('This server has {0} git hosts already. Remove one in Edit server first.', MAX_GIT_HOSTS) };
      const updated = await file.update((current) => ({
        version: 1,
        servers: current.servers.map((server) => (server.id === id ? withPending({ ...server, gitHosts: [...server.gitHosts, host] }, (server.pendingGitHosts ?? []).filter((item) => item !== host)) : server)),
      }));
      return { ok: true, server: resolve(updated.servers.find((server) => server.id === id)!, false) };
    },

    async dismissGitHost(id, host) {
      const record = file.value().servers.find((server) => server.id === id);
      if (!record) return { ok: false, field: 'gitHosts', message: l('This server is no longer in the list.') };
      if (!record.pendingGitHosts?.includes(host)) return { ok: true, server: resolve(record, false) };
      const updated = await file.update((current) => ({
        version: 1,
        servers: current.servers.map((server) => {
          if (server.id !== id) return server;
          const dismissed = [...(server.dismissedGitHosts ?? []).filter((item) => item !== host), host].slice(-MAX_DISMISSED_GIT_HOSTS);
          return withPending({ ...server, dismissedGitHosts: dismissed }, (server.pendingGitHosts ?? []).filter((item) => item !== host));
        }),
      }));
      return { ok: true, server: resolve(updated.servers.find((server) => server.id === id)!, false) };
    },
  };
}

/** The record with these pending hosts; an empty list leaves the field out. */
function withPending(record: ServerRecord, pending: readonly string[]): ServerRecord {
  const { pendingGitHosts: _pending, ...rest } = record;
  return pending.length > 0 ? { ...rest, pendingGitHosts: pending } : rest;
}
