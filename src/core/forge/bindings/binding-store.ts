import * as path from 'node:path';
import { authorityKeyOfProject } from '../../../shared/project-location';
import { createForgeFile, type ForgeFile } from '../forge-file';

// bindings.json: the account each (project, server) uses and each remote host's default accounts, on this computer only.
// account null means "Use Git's own credentials".

export interface ProjectBinding {
  readonly account: string | null;
  readonly at: number;
}

export interface BindingsFile {
  readonly version: 1;
  /** projectKey -> serverId -> binding */
  readonly projects: Readonly<Record<string, Readonly<Record<string, ProjectBinding>>>>;
  /** authorityKey -> serverId -> accountId */
  readonly hostDefaults: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseBindingsFile(raw: unknown): BindingsFile | undefined {
  if (!isRecord(raw) || raw['version'] !== 1 || !isRecord(raw['projects']) || !isRecord(raw['hostDefaults'])) return undefined;
  // built with Object.fromEntries, so a key such as __proto__ from the file is an own key, never a prototype
  const projects: Array<[string, Record<string, ProjectBinding>]> = [];
  for (const [projectKey, servers] of Object.entries(raw['projects'])) {
    if (!isRecord(servers)) return undefined;
    const bindings: Array<[string, ProjectBinding]> = [];
    for (const [serverId, binding] of Object.entries(servers)) {
      if (!isRecord(binding) || typeof binding['at'] !== 'number' || (binding['account'] !== null && typeof binding['account'] !== 'string')) return undefined;
      bindings.push([serverId, { account: binding['account'], at: binding['at'] }]);
    }
    projects.push([projectKey, Object.fromEntries(bindings)]);
  }
  const hostDefaults: Array<[string, Record<string, string>]> = [];
  for (const [authority, servers] of Object.entries(raw['hostDefaults'])) {
    if (!isRecord(servers) || !Object.values(servers).every((account) => typeof account === 'string')) return undefined;
    hostDefaults.push([authority, Object.fromEntries(Object.entries(servers as Record<string, string>))]);
  }
  return { version: 1, projects: Object.fromEntries(projects), hostDefaults: Object.fromEntries(hostDefaults) };
}

export interface BindingStore {
  readonly file: ForgeFile<BindingsFile>;
  /** The project's binding on the server; a chat worktree uses its project's key. */
  binding(projectKey: string, serverId: string): ProjectBinding | undefined;
  /** The authority's default accounts by server id. */
  hostDefaults(authorityKey: string): Readonly<Record<string, string>>;
  /** Binds the project on the server; account null is "Use Git's own credentials". */
  bind(projectKey: string, serverId: string, account: string | null, at: number): Promise<void>;
  /** accountId null removes the authority's default for the server. */
  setHostDefault(authorityKey: string, serverId: string, accountId: string | null): Promise<void>;
  /** Drops the project's bindings (Remove Project). */
  forgetProject(projectKey: string): Promise<void>;
  /** Drops the authority's host defaults and the bindings of its projects (Forget host). */
  forgetHost(authorityKey: string): Promise<void>;
  /** Drops the host defaults and project bindings of every authority but 'local' outside kept; answers the authorities dropped. */
  keepHosts(kept: ReadonlySet<string>): Promise<readonly string[]>;
  /** The projects bound to the account and the authorities whose host default it is. */
  count(accountId: string): { readonly projects: number; readonly hosts: number };
  /** Drops every project binding and host default that names the account. */
  removeAccount(accountId: string): Promise<void>;
}

export function createBindingStore(forgeDir: string, log: (line: string) => void): BindingStore {
  const file = createForgeFile<BindingsFile>({ filePath: path.join(forgeDir, 'bindings.json'), parse: parseBindingsFile, empty: { version: 1, projects: {}, hostDefaults: {} }, log });
  // an account belongs to one server, so a project or an authority names it at most once
  const countIn = (bindings: BindingsFile, accountId: string): { readonly projects: number; readonly hosts: number } => ({
    projects: Object.values(bindings.projects).filter((servers) => Object.values(servers).some((binding) => binding.account === accountId)).length,
    hosts: Object.values(bindings.hostDefaults).filter((servers) => Object.values(servers).includes(accountId)).length,
  });
  const withoutKeys = <T>(entries: Readonly<Record<string, T>>, drop: (key: string) => boolean): Record<string, T> =>
    Object.fromEntries(Object.entries(entries).filter(([key]) => !drop(key)));
  return {
    file,
    binding: (projectKey, serverId) => file.value().projects[projectKey]?.[serverId],
    hostDefaults: (authorityKey) => file.value().hostDefaults[authorityKey] ?? {},
    async bind(projectKey, serverId, account, at) {
      await file.update((current) => ({
        ...current,
        projects: { ...current.projects, [projectKey]: { ...current.projects[projectKey], [serverId]: { account, at } } },
      }));
    },
    async setHostDefault(authorityKey, serverId, accountId) {
      await file.update((current) => {
        const servers = withoutKeys(current.hostDefaults[authorityKey] ?? {}, (key) => key === serverId);
        if (accountId !== null) servers[serverId] = accountId;
        const hostDefaults = withoutKeys(current.hostDefaults, (key) => key === authorityKey);
        return { ...current, hostDefaults: Object.keys(servers).length > 0 ? { ...hostDefaults, [authorityKey]: servers } : hostDefaults };
      });
    },
    async forgetProject(projectKey) {
      if (file.value().projects[projectKey] === undefined) return;
      await file.update((current) => ({ ...current, projects: withoutKeys(current.projects, (key) => key === projectKey) }));
    },
    async forgetHost(authorityKey) {
      const held = file.value();
      if (held.hostDefaults[authorityKey] === undefined && !Object.keys(held.projects).some((key) => authorityKeyOfProject(key) === authorityKey)) return;
      await file.update((current) => ({
        version: 1,
        projects: withoutKeys(current.projects, (key) => authorityKeyOfProject(key) === authorityKey),
        hostDefaults: withoutKeys(current.hostDefaults, (key) => key === authorityKey),
      }));
    },
    async keepHosts(kept) {
      const gone = (authorityKey: string): boolean => authorityKey !== 'local' && !kept.has(authorityKey);
      const held = file.value();
      const dropped = [...new Set([...Object.keys(held.hostDefaults), ...Object.keys(held.projects).map(authorityKeyOfProject)])].filter(gone);
      if (dropped.length === 0) return [];
      await file.update((current) => ({
        version: 1,
        projects: withoutKeys(current.projects, (key) => gone(authorityKeyOfProject(key))),
        hostDefaults: withoutKeys(current.hostDefaults, gone),
      }));
      return dropped;
    },
    count: (accountId) => countIn(file.value(), accountId),
    async removeAccount(accountId) {
      const named = countIn(file.value(), accountId);
      if (named.projects === 0 && named.hosts === 0) return;
      await file.update((current) => {
        const keep = <T>(entries: Readonly<Record<string, T>>, drop: (value: T) => boolean): Record<string, T> =>
          Object.fromEntries(Object.entries(entries).filter(([, value]) => !drop(value)));
        const projects = Object.fromEntries(
          Object.entries(current.projects).map(([projectKey, servers]) => [projectKey, keep(servers, (binding) => binding.account === accountId)] as const).filter(([, servers]) => Object.keys(servers).length > 0),
        );
        const hostDefaults = Object.fromEntries(
          Object.entries(current.hostDefaults).map(([authority, servers]) => [authority, keep(servers, (account) => account === accountId)] as const).filter(([, servers]) => Object.keys(servers).length > 0),
        );
        return { version: 1, projects, hostDefaults };
      });
    },
  };
}
