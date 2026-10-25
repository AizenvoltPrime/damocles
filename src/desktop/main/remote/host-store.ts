import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../../platform/disposable';
import { jsonConfigWritesSettled, writeJsonConfig } from '../../../core/config/json-config-write';
import type { ShellPlatform } from '../../preload/shell-channels';

const SCHEMA_VERSION = 1;
export const HOST_STORE_FILE = 'remote-hosts.json';

// A project on another authority: its folder as the target names it, the folder key the target computed for it, and the
// target's OS, whose path flavor main joins its paths in (pathFor)
export interface RemoteProjectRecord {
  readonly path: string;
  readonly folderKey: string;
  readonly os: ShellPlatform;
}

const TARGET_OSES: readonly unknown[] = ['win32', 'darwin', 'linux'] satisfies readonly ShellPlatform[];

interface AuthorityRecord {
  readonly projects: readonly RemoteProjectRecord[];
  // target folder keys whose authors the user trusts, matched exactly as trusted-folders.json is
  readonly trusted: readonly string[];
}

interface HostFile {
  // by authority key (project-location.ts); local projects stay in projects.json and trusted-folders.json
  readonly authorities: ReadonlyMap<string, AuthorityRecord>;
  // the sidebar's project keys, local and remote, as last written; read back through order()
  readonly order: readonly string[];
}

const EMPTY: HostFile = { authorities: new Map(), order: [] };

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0');

function parseProject(value: unknown): RemoteProjectRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const os = record['os'];
  if (!isText(record['path']) || !isText(record['folderKey']) || !TARGET_OSES.includes(os)) return undefined;
  return { path: record['path'], folderKey: record['folderKey'], os: os as ShellPlatform };
}

function parseAuthority(value: unknown): AuthorityRecord {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const projects = Array.isArray(record['projects']) ? record['projects'].flatMap((entry) => parseProject(entry) ?? []) : [];
  const unique = projects.filter((project, index) => projects.findIndex((other) => other.folderKey === project.folderKey) === index);
  const trusted = Array.isArray(record['trusted']) ? [...new Set(record['trusted'].filter(isText))] : [];
  return { projects: unique, trusted };
}

function parseHostFile(text: string): HostFile {
  const parsed = JSON.parse(text) as { version?: unknown; authorities?: unknown; order?: unknown } | null;
  if (parsed?.version !== SCHEMA_VERSION || typeof parsed.authorities !== 'object' || parsed.authorities === null || Array.isArray(parsed.authorities)) {
    throw new Error('unknown schema');
  }
  const authorities = new Map<string, AuthorityRecord>();
  for (const [key, value] of Object.entries(parsed.authorities)) {
    if (isText(key) && key !== 'local') authorities.set(key, parseAuthority(value));
  }
  const order = Array.isArray(parsed.order) ? [...new Set(parsed.order.filter(isText))] : [];
  return { authorities, order };
}

/**
 * Remote projects, their trust and the sidebar order, in remote-hosts.json, so projects.json and trusted-folders.json keep the
 * shape an older app version reads after a downgrade.
 */
export class HostStore {
  private readonly filePath: string;
  private file: HostFile;
  private readonly listeners = new Set<() => void>();

  private constructor(filePath: string, file: HostFile) {
    this.filePath = filePath;
    this.file = file;
  }

  /** Reads the file; a missing one is empty, an unreadable one is logged and replaced at the next change. */
  static async open(userDataDir: string, log: (line: string) => void): Promise<HostStore> {
    const filePath = path.join(userDataDir, HOST_STORE_FILE);
    let text: string | undefined;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text === undefined) return new HostStore(filePath, EMPTY);
    try {
      return new HostStore(filePath, parseHostFile(text));
    } catch (err) {
      log(`[hosts] ignoring ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      return new HostStore(filePath, EMPTY);
    }
  }

  /** Each authority's projects, in the order they were added. */
  projects(): ReadonlyArray<{ readonly authorityKey: string; readonly project: RemoteProjectRecord }> {
    return [...this.file.authorities].flatMap(([authorityKey, record]) => record.projects.map((project) => ({ authorityKey, project })));
  }

  isTrusted(authorityKey: string, folderKey: string): boolean {
    return this.file.authorities.get(authorityKey)?.trusted.includes(folderKey) === true;
  }

  /** The sidebar's keys: the stored order without keys no longer listed, then every listed key it lacks, in list order. */
  order(listed: readonly string[]): string[] {
    const known = new Set(listed);
    const kept = this.file.order.filter((key) => known.has(key));
    const placed = new Set(kept);
    return [...kept, ...listed.filter((key) => !placed.has(key))];
  }

  /**
   * Adds the project at the end of the sidebar, writing the order reconciled with listed (every project key shown now);
   * resolves false when the authority already lists the folder.
   */
  addProject(authorityKey: string, project: RemoteProjectRecord, projectKey: string, listed: readonly string[]): Promise<boolean> {
    return this.change((file) => {
      const record = file.authorities.get(authorityKey) ?? { projects: [], trusted: [] };
      if (record.projects.some((candidate) => candidate.folderKey === project.folderKey)) return file;
      return {
        authorities: new Map(file.authorities).set(authorityKey, { ...record, projects: [...record.projects, project] }),
        order: [...this.order(listed.filter((key) => key !== projectKey)), projectKey],
      };
    });
  }

  async removeProject(authorityKey: string, folderKey: string, projectKey: string): Promise<void> {
    await this.change((file) => {
      const record = file.authorities.get(authorityKey);
      if (!record?.projects.some((project) => project.folderKey === folderKey)) return file;
      return {
        authorities: new Map(file.authorities).set(authorityKey, { ...record, projects: record.projects.filter((project) => project.folderKey !== folderKey) }),
        order: file.order.filter((key) => key !== projectKey),
      };
    });
  }

  async grantTrust(authorityKey: string, folderKey: string): Promise<void> {
    await this.change((file) => {
      const record = file.authorities.get(authorityKey) ?? { projects: [], trusted: [] };
      if (record.trusted.includes(folderKey)) return file;
      return { ...file, authorities: new Map(file.authorities).set(authorityKey, { ...record, trusted: [...record.trusted, folderKey] }) };
    });
  }

  /** Settles once every write to the file, one queued meanwhile included, has landed or failed; a quit awaits it. */
  flush(): Promise<void> {
    return jsonConfigWritesSettled(this.filePath);
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  // Applied inside the serialised write and kept only once it has landed; resolves whether the file changed.
  private async change(apply: (file: HostFile) => HostFile): Promise<boolean> {
    let next: HostFile = this.file;
    await writeJsonConfig(this.filePath, () => {
      next = apply(this.file);
      return `${JSON.stringify({ version: SCHEMA_VERSION, authorities: Object.fromEntries(next.authorities), order: next.order }, null, 2)}\n`;
    });
    if (next === this.file) return false;
    this.file = next;
    for (const listener of [...this.listeners]) listener();
    return true;
  }
}
