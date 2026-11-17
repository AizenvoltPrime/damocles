// ~/.damocles/folder-identities.json (docs/invariants.md "Project relocation"): the last identity read of each project folder,
// keyed by folderKey, so a folder that is gone can still be matched with a clone of its repository, and its POSIX mount point,
// so a volume that is gone is told from a folder that is gone (folder-presence-probe.ts). Read from disk at each use,
// since every Damocles process records into it; written through writeJsonConfig and capped, the folders seen longest ago dropped.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeJsonConfig } from '../config/json-config-write';
import { folderKey } from '../workspace-folders/folder-key';
import { isStoredRemote, MAX_REMOTES, MAX_ROOTS, MAX_SUBPATH_CHARS, type FolderIdentity } from './identity';

const STORE_VERSION = 1;
// It names project paths and their repositories' hosts, so it is the user's alone.
const STORE_FILE_MODE = 0o600;
export const MAX_RECORDED_FOLDERS: number = 500;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_PATH_CHARS = 4096;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface RecordedIdentity extends FolderIdentity {
  readonly path: string;
  readonly seenAt: number;
  /** The POSIX mount point the folder lay on when last seen (mountPointOf), when not the system root. */
  readonly mount?: string;
}

/** A folder's identity as read now, and its POSIX mount point when not the system root. */
export interface IdentityRead {
  readonly folder: string;
  readonly identity: FolderIdentity | undefined;
  readonly mount?: string;
}

export class FolderIdentityStore {
  readonly file: string;
  private readonly log: (line: string) => void;

  constructor(options: { readonly file: string; readonly log: (line: string) => void }) {
    this.file = path.resolve(options.file);
    this.log = options.log;
  }

  async entries(): Promise<RecordedIdentity[]> {
    const handle = await fs.open(this.file, 'r').catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? undefined : Promise.reject(err)));
    if (!handle) return [];
    try {
      const { size } = await handle.stat();
      if (size > MAX_STORE_BYTES) {
        this.log(`[FolderIdentities] ${this.file} is ${size} bytes, over the ${MAX_STORE_BYTES} read`);
        return [];
      }
      return parseStore(await handle.readFile('utf8'), this.log);
    } finally {
      await handle.close();
    }
  }

  async get(folder: string): Promise<RecordedIdentity | undefined> {
    const key = folderKey(folder);
    return (await this.entries()).find((entry) => folderKey(entry.path) === key);
  }

  /** The mount point recorded for the folder; undefined when none is, or the file cannot be read. */
  async mountOf(folder: string): Promise<string | undefined> {
    const recorded = await this.get(folder).catch((err: unknown) => {
      this.log(`[FolderIdentities] reading ${this.file} for the mount point of ${folder} failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    });
    return recorded?.mount;
  }

  /**
   * Records each folder's identity and mount point as read now, seen at `now`; a folder read with no root commits keeps those
   * recorded for it, and an undefined identity (no repository there) drops its entry.
   */
  async record(reads: readonly IdentityRead[], now: number): Promise<void> {
    if (reads.length === 0) return;
    await writeJsonConfig(this.file, (current) => {
      const byKey = new Map((current === undefined ? [] : parseStore(current, this.log)).map((entry) => [folderKey(entry.path), entry]));
      for (const { folder, identity, mount } of reads) {
        const key = folderKey(folder);
        if (!identity) {
          byKey.delete(key);
          continue;
        }
        const roots = identity.roots.length > 0 ? identity.roots : byKey.get(key)?.roots ?? [];
        byKey.set(key, { path: folder, subpath: identity.subpath, remotes: identity.remotes, roots, seenAt: now, ...(mount !== undefined ? { mount } : {}) });
      }
      const kept = [...byKey.entries()].sort(([, a], [, b]) => b.seenAt - a.seenAt).slice(0, MAX_RECORDED_FOLDERS);
      const folders = Object.fromEntries(kept.map(([key, { path: folderPath, subpath, remotes, roots, seenAt, mount }]) => [key, { path: folderPath, subpath, remotes, roots, seenAt, ...(mount !== undefined ? { mount } : {}) }]));
      return `${JSON.stringify({ version: STORE_VERSION, folders }, null, 2)}\n`;
    }, { fileMode: STORE_FILE_MODE });
  }
}

/** The valid entries of the file's text; another version's or a broken file reads as none, and is replaced at the next write. */
export function parseStore(text: string, log: (line: string) => void): RecordedIdentity[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    log(`[FolderIdentities] folder-identities.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  if (!isObject(parsed) || parsed['version'] !== STORE_VERSION || !isObject(parsed['folders'])) return [];
  return Object.values(parsed['folders']).flatMap((raw) => entryOf(raw) ?? []);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringsOf(raw: unknown, max: number, valid: (value: string) => boolean): string[] | undefined {
  if (!Array.isArray(raw) || raw.length > max) return undefined;
  return raw.every((value) => typeof value === 'string' && valid(value)) ? raw as string[] : undefined;
}

function entryOf(raw: unknown): RecordedIdentity | undefined {
  if (!isObject(raw)) return undefined;
  const { path: folderPath, subpath, seenAt } = raw;
  if (typeof folderPath !== 'string' || folderPath.length > MAX_PATH_CHARS || !path.isAbsolute(folderPath)) return undefined;
  if (typeof subpath !== 'string' || subpath.length > MAX_SUBPATH_CHARS) return undefined;
  if (typeof seenAt !== 'number' || !Number.isSafeInteger(seenAt) || seenAt < 0) return undefined;
  const remotes = stringsOf(raw['remotes'], MAX_REMOTES, isStoredRemote);
  const roots = stringsOf(raw['roots'], MAX_ROOTS, (value) => OBJECT_ID.test(value));
  if (!remotes || !roots) return undefined;
  const mount = raw['mount'];
  if (mount === undefined) return { path: folderPath, subpath, remotes, roots, seenAt };
  // a mount point is a POSIX folder at or above the path, never the system root
  if (typeof mount !== 'string' || !path.posix.isAbsolute(mount) || path.posix.dirname(mount) === mount || (folderPath !== mount && !folderPath.startsWith(`${mount}/`))) return undefined;
  return { path: folderPath, subpath, remotes, roots, seenAt, mount };
}
