// The worktree registry (AD12): one record per worktree a chat created (`chat`) or the user opened as a project (`adopted`),
// kept in <rootDir>/registry.json. Reads are synchronous from a cache; writes go through writeJsonConfig, whose lock spans
// processes, and the file is watched so another process's write reaches this one (slice 12a rule 22).
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../platform/disposable';
import type { FileWatcher, FileWatcherFactory } from '../../platform/file-watcher';
import { writeJsonConfig } from '../config/json-config-write';
import { folderKey } from '../workspace-folders/folder-key';
import { isWorktreeId } from '../../shared/worktree-id';

export type WorktreeId = string;
export const REGISTRY_FILE = 'registry.json';
const REGISTRY_VERSION = 1;
// AD12 Names: the folder name cut to 24 characters keeps worktree paths short on Windows.
const PROJECT_DIR_NAME_LENGTH = 24;

interface RecordBase {
  id: WorktreeId;
  repositoryRoot: string;
  worktreeRoot: string;
  /** The worktree's copy of the project folder: worktreeRoot itself, or the same subfolder when the project is one (D30). */
  workingFolder: string;
  createdAt: number;
  deletedAt?: number;
}

export interface ChatWorktreeRecord extends RecordBase {
  kind: 'chat';
  projectPath: string;
  branch: string;
  index: number;
  baseCommit: string;
  lastAppliedTree?: string;
  /** A conflicted Merge, Update or Rebase's base, which replaces baseCommit only once git finished that operation with it. */
  pendingBase?: PendingBase;
  /** When a chat first worked in it, or the user chose to keep it without one; a worktree with neither is a leftover. */
  usedAt?: number;
}

/** `side` is the folder whose HEAD must contain `commit`: the project folder for Merge into, the worktree for Update and Rebase. */
export interface PendingBase {
  commit: string;
  side: 'project' | 'worktree';
}

export interface AdoptedWorktreeRecord extends RecordBase {
  kind: 'adopted';
  /** The open project holding the main worktree; none while that project is not open (slice 12a rule 16). */
  projectPath?: string;
  branch?: string;
}

export type WorktreeRecord = ChatWorktreeRecord | AdoptedWorktreeRecord;

/** `lastAppliedTree: undefined` and `pendingBase: undefined` clear them. */
export interface ChatRecordPatch {
  baseCommit?: string;
  branch?: string;
  lastAppliedTree?: string | undefined;
  pendingBase?: PendingBase | undefined;
}

export interface AdoptInput {
  worktreeRoot: string;
  workingFolder: string;
  repositoryRoot: string;
  projectPath?: string;
  branch?: string;
}

export interface WorktreeRegistryOptions {
  rootDir: string;
  watcherFactory: FileWatcherFactory;
  log: (line: string) => void;
}

// 252 is the largest multiple of 36 a byte holds, so drawing again above it keeps every character equally likely.
const UNBIASED_BYTE_LIMIT = 252;

export function newWorktreeId(): WorktreeId {
  let id = '';
  while (id.length < 8) {
    for (const byte of crypto.randomBytes(8 - id.length)) if (byte < UNBIASED_BYTE_LIMIT) id += (byte % 36).toString(36);
  }
  return id;
}

/** `<rootDir>/<project>/<chat>`: the project folder's name cut to 24 characters plus 6 hex of its path hash (AD12 Names). */
export function worktreeFolderFor(rootDir: string, projectPath: string, id: WorktreeId): string {
  return path.join(projectWorktreesFolder(rootDir, projectPath), id);
}

/** `<rootDir>/<project>`, the folder holding every chat worktree of the project. */
export function projectWorktreesFolder(rootDir: string, projectPath: string): string {
  const name = path.basename(path.resolve(projectPath)).slice(0, PROJECT_DIR_NAME_LENGTH).replace(/[^A-Za-z0-9._-]/g, '_');
  const hash = crypto.createHash('sha256').update(folderKey(projectPath)).digest('hex').slice(0, 6);
  return path.join(rootDir, `${name || 'project'}-${hash}`);
}

/** True when `child` is `parent` or lies inside it, compared with folderKey. */
export function folderContains(parent: string, child: string): boolean {
  const p = folderKey(parent);
  const c = folderKey(child);
  if (c === p) return true;
  const withSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(withSep);
}

export class WorktreeRegistry implements Disposable {
  readonly rootDir: string;
  readonly file: string;
  private cache: WorktreeRecord[] = [];
  private foreign: readonly unknown[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly unreadableListeners = new Set<(error: string) => void>();
  private readonly watcher: FileWatcher;
  private readonly subscriptions: Disposable[] = [];
  private readonly log: (line: string) => void;
  private disposed = false;
  // Why registry.json last failed to parse; the cache keeps the records it last parsed meanwhile.
  private readError: string | undefined;

  constructor(options: WorktreeRegistryOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.file = path.join(this.rootDir, REGISTRY_FILE);
    this.log = options.log;
    fs.mkdirSync(this.rootDir, { recursive: true });
    const read = this.readSync();
    if (read) {
      this.cache = read.records;
      this.foreign = read.foreign;
    }
    this.watcher = options.watcherFactory.watch(this.rootDir, REGISTRY_FILE);
    const reload = (): void => this.reload();
    this.subscriptions.push(this.watcher.onDidCreate(reload), this.watcher.onDidChange(reload), this.watcher.onDidDelete(reload));
  }

  records(): readonly WorktreeRecord[] {
    return this.cache;
  }

  /** The `worktreeRoot` of each record this version cannot read, as written; another app version may still use those folders. */
  foreignWorktreeRoots(): string[] {
    return this.foreign.flatMap((raw) => {
      const root = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['worktreeRoot'] : undefined;
      return isAbsolutePath(root) ? [root] : [];
    });
  }

  get(id: WorktreeId): WorktreeRecord | undefined {
    return this.cache.find((r) => r.id === id);
  }

  /** The chat record, live or deleted, whose working folder or worktree root holds `folder`. */
  chatRecordFor(folder: string): ChatWorktreeRecord | undefined {
    for (const record of this.cache) {
      if (record.kind !== 'chat') continue;
      if (folderContains(record.workingFolder, folder) || folderContains(record.worktreeRoot, folder)) return record;
    }
    return undefined;
  }

  /** The live chat record whose working folder is exactly `folder`. */
  liveChatRecordAt(folder: string): ChatWorktreeRecord | undefined {
    const key = folderKey(folder);
    return this.cache.find((r): r is ChatWorktreeRecord => r.kind === 'chat' && r.deletedAt === undefined && folderKey(r.workingFolder) === key);
  }

  /** The project of the chat worktree holding `folder`; never derived from path text, and adopted records have none here (AD12). */
  projectOf(folder: string): string | undefined {
    return this.chatRecordFor(folder)?.projectPath;
  }

  /** AD12 Listing: every chat record of the project, live or deleted, and every adopted record of it whose folder is gone. */
  recordsOfProject(projectPath: string): readonly WorktreeRecord[] {
    const key = folderKey(projectPath);
    return this.cache.filter((r) => {
      if (r.projectPath === undefined || folderKey(r.projectPath) !== key) return false;
      return r.kind === 'chat' || r.deletedAt !== undefined || !fs.existsSync(r.workingFolder);
    });
  }

  /** Live chat records of the project. */
  liveChatRecords(projectPath: string): readonly ChatWorktreeRecord[] {
    const key = folderKey(projectPath);
    return this.cache.filter((r): r is ChatWorktreeRecord => r.kind === 'chat' && r.deletedAt === undefined && folderKey(r.projectPath) === key);
  }

  /** Adds a chat record, re-checking its index against the file under the lock; resolves the record as written. */
  async addChat(record: Omit<ChatWorktreeRecord, 'index'>): Promise<ChatWorktreeRecord> {
    let written: ChatWorktreeRecord | undefined;
    await this.mutate((records, foreign) => {
      if (records.some((r) => r.id === record.id)) throw new Error(`A worktree record ${record.id} already exists`);
      const key = folderKey(record.projectPath);
      const live = records.filter((r): r is ChatWorktreeRecord => r.kind === 'chat' && r.deletedAt === undefined && folderKey(r.projectPath) === key);
      written = { ...record, index: smallestFreeIndex([...live.map((r) => r.index), ...foreignIndexes(foreign, key)]) };
      return [...records, written];
    });
    return written!;
  }

  async update(id: WorktreeId, patch: ChatRecordPatch): Promise<void> {
    await this.mutate((records) => records.map((r) => {
      if (r.id !== id) return r;
      if (r.kind !== 'chat') throw new Error(`Worktree ${id} is not a chat worktree`);
      const { lastAppliedTree, pendingBase, ...rest } = r;
      const next: ChatWorktreeRecord = { ...rest, ...(patch.baseCommit !== undefined ? { baseCommit: patch.baseCommit } : {}), ...(patch.branch !== undefined ? { branch: patch.branch } : {}) };
      const tree = 'lastAppliedTree' in patch ? patch.lastAppliedTree : lastAppliedTree;
      const pending = 'pendingBase' in patch ? patch.pendingBase : pendingBase;
      return { ...next, ...(tree !== undefined ? { lastAppliedTree: tree } : {}), ...(pending !== undefined ? { pendingBase: pending } : {}) };
    }));
  }

  /** Ends the pending base `commit` if it is still the record's: taken in, it becomes baseCommit and lastAppliedTree clears. */
  async settlePendingBase(id: WorktreeId, commit: string, taken: boolean): Promise<void> {
    await this.mutate((records) => records.map((r) => {
      if (r.id !== id || r.kind !== 'chat' || r.pendingBase?.commit !== commit) return r;
      const { pendingBase: _settled, lastAppliedTree, ...rest } = r;
      return taken ? { ...rest, baseCommit: commit } : { ...rest, ...(lastAppliedTree !== undefined ? { lastAppliedTree } : {}) };
    }));
  }

  /** Records that a chat works in the chat worktree, or that the user keeps it with none; written once. */
  async markUsed(id: WorktreeId, at: number = Date.now()): Promise<void> {
    const current = this.get(id);
    if (current?.kind !== 'chat' || current.usedAt !== undefined) return;
    await this.mutate((records) => records.map((r) => (r.id === id && r.kind === 'chat' && r.usedAt === undefined ? { ...r, usedAt: at } : r)));
  }

  /** Keeps the record's paths, so its chats stay listed read-only (AD12 Listing). */
  async markDeleted(id: WorktreeId, at: number = Date.now()): Promise<void> {
    await this.mutate((records) => records.map((r) => (r.id === id && r.deletedAt === undefined ? { ...r, deletedAt: at } : r)));
  }

  /** Only for a creation that never produced a folder. */
  async remove(id: WorktreeId): Promise<void> {
    await this.mutate((records) => records.filter((r) => r.id !== id));
  }

  /** Drops the deleted records among `ids` once no chat lists from or names them (AD12 Listing); a live one stays. */
  async removeDeleted(ids: readonly WorktreeId[]): Promise<void> {
    const named = new Set(ids);
    await this.mutate((records) => records.filter((r) => !(named.has(r.id) && r.deletedAt !== undefined)));
  }

  /**
   * Removes the project's folder under rootDir once it is empty. Taken under the registry's lock, where a creation writes its
   * record before `git worktree add` makes a folder there, so a folder another process is about to fill is never removed.
   */
  async removeEmptyProjectFolder(projectPath: string): Promise<void> {
    const folder = projectWorktreesFolder(this.rootDir, projectPath);
    await this.mutate((records) => {
      if (records.some((r) => r.kind === 'chat' && r.deletedAt === undefined && folderContains(folder, r.worktreeRoot))) return records;
      try {
        fs.rmdirSync(folder);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw err;
      }
      return records;
    });
  }

  /** Records a worktree opened as a project; an existing record for the same root is updated, and a deleted one revived. */
  async upsertAdopted(input: AdoptInput): Promise<AdoptedWorktreeRecord> {
    let result: AdoptedWorktreeRecord | undefined;
    await this.mutate((records) => {
      const key = folderKey(input.worktreeRoot);
      const existing = records.find((r) => folderKey(r.worktreeRoot) === key && r.deletedAt === undefined)
        ?? records.find((r) => r.kind === 'adopted' && folderKey(r.worktreeRoot) === key);
      if (existing?.kind === 'chat') throw new Error(`${input.worktreeRoot} is a chat worktree`);
      const base: AdoptedWorktreeRecord = existing?.kind === 'adopted'
        ? { ...existing }
        : { id: freshId(records), kind: 'adopted', repositoryRoot: input.repositoryRoot, worktreeRoot: input.worktreeRoot, workingFolder: input.workingFolder, createdAt: Date.now() };
      delete base.deletedAt;
      base.repositoryRoot = input.repositoryRoot;
      base.workingFolder = input.workingFolder;
      if (input.projectPath !== undefined) base.projectPath = input.projectPath;
      if (input.branch !== undefined) base.branch = input.branch;
      result = base;
      return existing ? records.map((r) => (r === existing ? base : r)) : [...records, base];
    });
    return result!;
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.subscriptions) s.dispose();
    this.watcher.dispose();
    this.listeners.clear();
    this.unreadableListeners.clear();
  }

  /** Why registry.json does not parse now; while set, the records are the ones last parsed and every write is refused. */
  unreadable(): string | undefined {
    return this.readError;
  }

  /** Fires once each time registry.json goes from parsing to not parsing. */
  onDidBecomeUnreadable(listener: (error: string) => void): Disposable {
    this.unreadableListeners.add(listener);
    return { dispose: () => { this.unreadableListeners.delete(listener); } };
  }

  /** Re-reads the file; a watcher event and tests call it. */
  reload(): void {
    if (this.disposed) return;
    const next = this.readSync();
    if (next === undefined) return;
    this.foreign = next.foreign;
    if (JSON.stringify(next.records) === JSON.stringify(this.cache)) return;
    this.cache = next.records;
    this.emit();
  }

  // Records this version cannot read are written back unchanged, so another app version's records survive its writes. The
  // cache is then read back from the file, so it holds only validated records and never an older state than the file's.
  private async mutate(change: (records: WorktreeRecord[], foreign: readonly unknown[]) => WorktreeRecord[]): Promise<void> {
    await writeJsonConfig(this.file, (current) => {
      const parsed = current === undefined ? { records: [], foreign: [] } : parseRegistry(current, this.rootDir, this.log);
      const written = change(parsed.records, parsed.foreign);
      return `${JSON.stringify({ version: REGISTRY_VERSION, records: [...written, ...parsed.foreign] }, null, 2)}\n`;
    });
    this.reload();
  }

  // undefined keeps the cache: the file could not be read or does not parse (the settings store's rule for a broken file).
  private readSync(): { records: WorktreeRecord[]; foreign: unknown[] } | undefined {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.readError = undefined;
        return { records: [], foreign: [] };
      }
      this.log(`[WorktreeRegistry] Could not read ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    try {
      const parsed = parseRegistry(text, this.rootDir, this.log);
      this.readError = undefined;
      return parsed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[WorktreeRegistry] ${message}; keeping the records last read and refusing writes`);
      const first = this.readError === undefined;
      this.readError = message;
      if (first) this.emitUnreadable(message);
      return undefined;
    }
  }

  private emitUnreadable(error: string): void {
    for (const listener of [...this.unreadableListeners]) {
      try {
        listener(error);
      } catch (err) {
        this.log(`[WorktreeRegistry] unreadable listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        this.log(`[WorktreeRegistry] change listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

function smallestFreeIndex(takenIndexes: readonly number[]): number {
  const taken = new Set(takenIndexes);
  let index = 1;
  while (taken.has(index)) index++;
  return index;
}

// A record another app version wrote may still hold an index of the project's live worktrees, so none is reused.
function foreignIndexes(foreign: readonly unknown[], projectKey: string): number[] {
  const out: number[] = [];
  for (const raw of foreign) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (r['deletedAt'] !== undefined || typeof r['projectPath'] !== 'string' || folderKey(r['projectPath']) !== projectKey) continue;
    if (typeof r['index'] === 'number' && Number.isInteger(r['index']) && r['index'] >= 1) out.push(r['index']);
  }
  return out;
}

function freshId(records: readonly WorktreeRecord[]): WorktreeId {
  for (;;) {
    const id = newWorktreeId();
    if (!records.some((r) => r.id === id)) return id;
  }
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0');
const isAbsolutePath = (v: unknown): v is string => isString(v) && path.isAbsolute(v);
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isObjectId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v);

/**
 * The records this version reads, and the raw ones it does not (`foreign`). The file lives in the user's home, but any process
 * can write it, so a chat record is valid only at the one folder its project and id name under `rootDir`; an invalid or
 * unknown record is never used, only carried through writes. Throws when the file is not a registry at all.
 */
export function parseRegistry(text: string, rootDir: string, log: (line: string) => void): { records: WorktreeRecord[]; foreign: unknown[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`registry.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const list = (parsed as { records?: unknown } | null)?.records;
  if (!Array.isArray(list)) throw new Error('registry.json holds no records list');
  const records: WorktreeRecord[] = [];
  const foreign: unknown[] = [];
  const ids = new Set<string>();
  for (const raw of list) {
    const record = validRecord(raw, rootDir);
    if (!record || ids.has(record.id)) {
      log(`[WorktreeRegistry] Not using a record this version cannot read: ${JSON.stringify(raw)?.slice(0, 300)}`);
      foreign.push(raw);
      continue;
    }
    ids.add(record.id);
    records.push(record);
  }
  return { records, foreign };
}

function validPendingBase(raw: unknown): PendingBase | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Record<string, unknown>;
  if (!isObjectId(p['commit']) || (p['side'] !== 'project' && p['side'] !== 'worktree')) return undefined;
  return { commit: p['commit'], side: p['side'] };
}

const depth = (relative: string): number => (relative === '' ? 0 : relative.split(path.sep).length);

function validRecord(raw: unknown, rootDir: string): WorktreeRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (!isWorktreeId(r['id'])) return undefined;
  if (!isAbsolutePath(r['repositoryRoot']) || !isAbsolutePath(r['worktreeRoot']) || !isAbsolutePath(r['workingFolder']) || !isTime(r['createdAt'])) return undefined;
  if (!folderContains(r['worktreeRoot'], r['workingFolder'])) return undefined;
  if (r['deletedAt'] !== undefined && !isTime(r['deletedAt'])) return undefined;
  const base = {
    id: r['id'],
    repositoryRoot: r['repositoryRoot'],
    worktreeRoot: r['worktreeRoot'],
    workingFolder: r['workingFolder'],
    createdAt: r['createdAt'],
    ...(r['deletedAt'] !== undefined ? { deletedAt: r['deletedAt'] as number } : {}),
  };
  if (r['kind'] === 'chat') {
    if (!isAbsolutePath(r['projectPath']) || !isString(r['branch']) || !isObjectId(r['baseCommit'])) return undefined;
    if (typeof r['index'] !== 'number' || !Number.isInteger(r['index']) || r['index'] < 1) return undefined;
    if (r['lastAppliedTree'] !== undefined && !isObjectId(r['lastAppliedTree'])) return undefined;
    const pendingBase = r['pendingBase'] === undefined ? undefined : validPendingBase(r['pendingBase']);
    if (r['pendingBase'] !== undefined && pendingBase === undefined) return undefined;
    if (r['usedAt'] !== undefined && !isTime(r['usedAt'])) return undefined;
    if (folderKey(r['worktreeRoot']) !== folderKey(worktreeFolderFor(rootDir, r['projectPath'], r['id']))) return undefined;
    if (folderContains(rootDir, r['projectPath']) || folderContains(rootDir, r['repositoryRoot'])) return undefined;
    // Apply writes into repositoryRoot, so it must hold the project, and the working folder the same subfolder of the worktree:
    // as deep, since the project keeps its own spelling (an 8.3 alias) and the working folder has git's names.
    if (!folderContains(r['repositoryRoot'], r['projectPath'])) return undefined;
    if (depth(path.relative(r['worktreeRoot'], r['workingFolder'])) !== depth(path.relative(r['repositoryRoot'], r['projectPath']))) return undefined;
    return {
      ...base,
      kind: 'chat',
      projectPath: r['projectPath'],
      branch: r['branch'],
      index: r['index'],
      baseCommit: r['baseCommit'],
      ...(r['lastAppliedTree'] !== undefined ? { lastAppliedTree: r['lastAppliedTree'] as string } : {}),
      ...(pendingBase !== undefined ? { pendingBase } : {}),
      ...(r['usedAt'] !== undefined ? { usedAt: r['usedAt'] as number } : {}),
    };
  }
  if (r['kind'] === 'adopted') {
    if (r['projectPath'] !== undefined && !isAbsolutePath(r['projectPath'])) return undefined;
    if (r['branch'] !== undefined && !isString(r['branch'])) return undefined;
    return {
      ...base,
      kind: 'adopted',
      ...(r['projectPath'] !== undefined ? { projectPath: r['projectPath'] as string } : {}),
      ...(r['branch'] !== undefined ? { branch: r['branch'] as string } : {}),
    };
  }
  return undefined;
}
