// The relocation journal, ~/.damocles/project-relocations.json (docs/invariants.md "Project relocation"): one record per
// relocation, written before anything moves, whose folder moves readers map recorded paths through. Reads come from a cache;
// writes go through writeJsonConfig, whose lock spans processes, and the file is watched so another process's write reaches this
// one.
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../platform/disposable';
import type { FileWatcher, FileWatcherFactory } from '../../platform/file-watcher';
import { isSafeAgentPathId } from '../../shared/agent-path-id';
import { writeJsonConfig } from '../config/json-config-write';
import { checkConfigPathSync } from '../config/local-config-path';
import { isFolderId } from '../pi-session/checkpoints/resolver';
import { currentHostPathOf, foldAliases, type AliasSource, type HostAlias } from './aliases';
import { RELOCATION_STEPS, type Coded, type RelocationFolder, type RelocationRecord, type RelocationStepName, type RelocationStepState, type WorktreeRepairFailure } from './types';

const JOURNAL_VERSION = 1;
// The journal holds secrets of no kind, but names every moved project's path.
const JOURNAL_FILE_MODE = 0o600;
const MAX_ID_LENGTH = 128;
const MAX_PATH_LENGTH = 32_767;

export interface RelocationStoreOptions {
  readonly file: string;
  readonly watcherFactory: FileWatcherFactory;
  readonly log: (line: string) => void;
}

interface ParsedJournal {
  /** Written with the file, so a journal written anew after its file was deleted, whose seqs restart, is told apart. */
  readonly id?: string;
  readonly records: RelocationRecord[];
  /** Entries this version cannot run (another version's shape), written back unchanged. */
  readonly foreign: unknown[];
  /** Every host alias entry as written, those this version cannot read included, so each is written back unchanged. */
  readonly hostAliases: unknown[];
}

export class RelocationStore implements Disposable {
  readonly file: string;
  private cache: ParsedJournal = { records: [], foreign: [], hostAliases: [] };
  private readonly listeners = new Set<() => void>();
  private readonly watcher: FileWatcher;
  private readonly subscriptions: Disposable[] = [];
  private readonly log: (line: string) => void;
  private readError: string | undefined;
  private disposed = false;

  constructor(options: RelocationStoreOptions) {
    this.file = path.resolve(options.file);
    this.log = options.log;
    // eslint-disable-next-line damocles/no-sync -- once at construction, so the alias map is there before any reader asks
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.cache = this.readJournal() ?? this.cache;
    this.watcher = options.watcherFactory.watch(path.dirname(this.file), path.basename(this.file));
    const reload = (): void => this.reload();
    this.subscriptions.push(this.watcher.onDidCreate(reload), this.watcher.onDidChange(reload), this.watcher.onDidDelete(reload));
  }

  records(): readonly RelocationRecord[] {
    return this.cache.records;
  }

  /** The journal's id; undefined while there is no file. */
  journalId(): string | undefined {
    return this.cache.id;
  }

  get(id: string): RelocationRecord | undefined {
    return this.cache.records.find((record) => record.id === id);
  }

  /** The host aliases this version reads: a remote host's project moved on that host, its paths as the host spells them. */
  hostAliases(): readonly HostAlias[] {
    return this.cache.hostAliases.flatMap((raw) => hostAliasOf(raw) ?? []);
  }

  /**
   * Appends a host alias with the next host alias seq, unless it repeats a recorded one (the host part ran again): the same move
   * with the same startedAt, or, from a host core that sends none, the same move while its old folder is still moved away.
   */
  async addHostAlias(alias: Omit<HostAlias, 'seq'>): Promise<void> {
    if (!isSafeAgentPathId(alias.hostId) || alias.hostId.length > MAX_ID_LENGTH || !isHostPath(alias.from) || !isHostPath(alias.to)) throw new Error('A host alias names a host id or a path this journal does not hold');
    if (alias.startedAt !== undefined && !isCount(alias.startedAt)) throw new Error('A host alias names a start time this journal does not hold');
    await this.mutate((journal) => {
      const held = journal.hostAliases.flatMap((raw) => hostAliasOf(raw) ?? []);
      const recorded = held.some((entry) => entry.hostId === alias.hostId && entry.from === alias.from && entry.to === alias.to && entry.startedAt === alias.startedAt);
      const movedAway = alias.startedAt !== undefined || currentHostPathOf(foldAliases([], held), alias.hostId, alias.from) !== alias.from;
      if (recorded && movedAway) return journal;
      const seq = Math.max(0, ...held.map((entry) => entry.seq)) + 1;
      const entry = { hostId: alias.hostId, from: alias.from, to: alias.to, seq, ...(alias.startedAt !== undefined ? { startedAt: alias.startedAt } : {}) };
      return { ...journal, hostAliases: [...journal.hostAliases, entry] };
    });
  }

  /**
   * Every relocation's folders, another version's records included, for the alias fold. An abandoned relocation moves its folders
   * only once its worktrees step is done; before that its seq alone counts.
   */
  aliasSources(): readonly AliasSource[] {
    return [...this.cache.records.map(recordAliasSource), ...this.cache.foreign.flatMap((raw) => aliasSourceOf(raw) ?? [])];
  }

  /** Another version's relocations that are neither finished nor abandoned, a state this version does not know included. */
  foreignPending(): readonly AliasSource[] {
    return foreignPendingOf(this.cache.foreign);
  }

  /** Why the journal does not parse now; while set, the records are the ones last parsed and every write is refused. */
  unreadable(): string | undefined {
    return this.readError;
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /**
   * Writes a new record with the next seq, under the journal's lock, unless `refuse` answers a refusal for the records the file
   * holds then (another process may have written one since this one read it), and another version's pending ones; resolves the
   * record as written.
   */
  async add(build: (seq: number) => RelocationRecord, refuse?: (records: readonly RelocationRecord[], foreignPending: readonly AliasSource[]) => Coded | undefined): Promise<RelocationRecord | { readonly refusal: Coded }> {
    let written: RelocationRecord | undefined;
    let refusal: Coded | undefined;
    await this.mutate((journal) => {
      refusal = refuse?.(journal.records, foreignPendingOf(journal.foreign));
      if (refusal) return journal;
      const seq = Math.max(0, ...journal.records.map((r) => r.seq), ...journal.foreign.flatMap((raw) => aliasSourceOf(raw)?.seq ?? [])) + 1;
      written = build(seq);
      if (journal.records.some((r) => r.id === written!.id)) throw new Error(`A relocation ${written.id} already exists`);
      return { ...journal, records: [...journal.records, written] };
    });
    return refusal ? { refusal } : written!;
  }

  /** Replaces record `id` with `change(record)` as the file holds it; a record that is gone stays gone. */
  async update(id: string, change: (record: RelocationRecord) => RelocationRecord): Promise<RelocationRecord | undefined> {
    let updated: RelocationRecord | undefined;
    await this.mutate((journal) => ({
      ...journal,
      records: journal.records.map((record) => {
        if (record.id !== id) return record;
        updated = change(record);
        return updated;
      }),
    }));
    return updated;
  }

  /** Re-reads the file; a watcher event and tests call it. */
  reload(): void {
    if (this.disposed) return;
    const next = this.readJournal();
    if (next === undefined) return;
    const changed = next.id !== this.cache.id || JSON.stringify(next.records) !== JSON.stringify(this.cache.records) || JSON.stringify(next.foreign) !== JSON.stringify(this.cache.foreign) || JSON.stringify(next.hostAliases) !== JSON.stringify(this.cache.hostAliases);
    this.cache = next;
    if (changed) this.emit();
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.watcher.dispose();
    this.listeners.clear();
  }

  // A journal that does not parse is never written over: its records may be another process's relocations in flight.
  private async mutate(change: (journal: ParsedJournal) => ParsedJournal): Promise<void> {
    await writeJsonConfig(this.file, (current) => {
      const journal = change(current === undefined ? { records: [], foreign: [], hostAliases: [] } : parseJournal(current, this.log));
      return `${JSON.stringify({ version: JOURNAL_VERSION, id: journal.id ?? randomUUID(), relocations: [...journal.records, ...journal.foreign], hostAliases: journal.hostAliases }, null, 2)}\n`;
    }, { fileMode: JOURNAL_FILE_MODE, baseFolder: path.dirname(this.file) });
    this.reload();
  }

  private readJournal(): ParsedJournal | undefined {
    let text: string;
    try {
      // eslint-disable-next-line damocles/no-sync -- right before the synchronous read below, judged from the store's own folder
      if (checkConfigPathSync(path.dirname(this.file), this.file) !== 'ok') {
        this.log(`[ProjectRelocations] ${this.file} links to a network share or WSL path, so it is not read`);
        return undefined;
      }
      // eslint-disable-next-line damocles/no-sync -- a few KB, read so records() and the alias map are never older than the file
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.readError = undefined;
        return { records: [], foreign: [], hostAliases: [] };
      }
      this.log(`[ProjectRelocations] Could not read ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    try {
      const parsed = parseJournal(text, this.log);
      this.readError = undefined;
      return parsed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.readError === undefined) this.log(`[ProjectRelocations] ${message}; keeping the records last read and refusing writes`);
      this.readError = message;
      return undefined;
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        this.log(`[ProjectRelocations] change listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/** The records this version runs, and the entries it does not (`foreign`). Throws when the text is not a journal at all. */
export function parseJournal(text: string, log: (line: string) => void): ParsedJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`project-relocations.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObject(parsed) || !Array.isArray(parsed['relocations'])) throw new Error('project-relocations.json holds no relocations list');
  if (parsed['version'] !== JOURNAL_VERSION) throw new Error(`project-relocations.json has version ${String(parsed['version'])}, which this version does not read`);
  const records: RelocationRecord[] = [];
  const foreign: unknown[] = [];
  for (const raw of parsed['relocations'] as unknown[]) {
    const record = recordOf(raw);
    if (record) records.push(record);
    else {
      log(`[ProjectRelocations] a relocation entry this version does not read is kept as written: ${JSON.stringify(raw).slice(0, 200)}`);
      foreign.push(raw);
    }
  }
  const hostAliases = Array.isArray(parsed['hostAliases']) ? parsed['hostAliases'] as unknown[] : [];
  for (const raw of hostAliases) if (!hostAliasOf(raw)) log(`[ProjectRelocations] a host alias this version does not read is kept as written: ${JSON.stringify(raw).slice(0, 200)}`);
  return { ...(isId(parsed['id']) ? { id: parsed['id'] } : {}), records, foreign, hostAliases };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && /^[A-Za-z0-9_-]+$/.test(value);
}

function isAbsolute(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && path.isAbsolute(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function codedOf(raw: unknown): Coded | undefined {
  if (!isObject(raw) || !isId(raw['code'])) return undefined;
  const params = raw['params'];
  if (params === undefined) return { code: raw['code'] };
  if (!isObject(params) || !Object.values(params).every((v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))) return undefined;
  return { code: raw['code'], params: params as Record<string, string | number> };
}

function folderOf(raw: unknown): RelocationFolder | undefined {
  if (!isObject(raw)) return undefined;
  const { kind, from, to, worktreeId, checkpointRepo } = raw;
  if ((kind !== 'project' && kind !== 'worktree') || !isAbsolute(from) || !isAbsolute(to)) return undefined;
  if (worktreeId !== undefined && !isId(worktreeId)) return undefined;
  if (checkpointRepo !== undefined && !(typeof checkpointRepo === 'string' && isFolderId(checkpointRepo))) return undefined;
  return { kind, from, to, ...(worktreeId !== undefined ? { worktreeId } : {}), ...(checkpointRepo !== undefined ? { checkpointRepo } : {}) };
}

function stepOf(raw: unknown): RelocationStepState | undefined {
  if (!isObject(raw)) return undefined;
  const { state, failure } = raw;
  if (state !== 'pending' && state !== 'done' && state !== 'waiting') return undefined;
  if (failure === undefined) return { state };
  const coded = codedOf(failure);
  return coded ? { state, failure: coded } : undefined;
}

// A record naming a step this version does not know is another version's: running it here would skip that step.
function recordOf(raw: unknown): RelocationRecord | undefined {
  if (!isObject(raw)) return undefined;
  const { id, seq, requestedBy, mode, folders, repository, chats, state, steps, startedAt, finishedAt, repairFailures } = raw;
  if (!isId(id) || !isCount(seq) || seq === 0 || !isCount(chats) || !isCount(startedAt)) return undefined;
  if (requestedBy !== 'desktop' && requestedBy !== 'vscode' && requestedBy !== 'daemon') return undefined;
  if (mode !== 'locate' && mode !== 'merge') return undefined;
  if (state !== 'running' && state !== 'paused' && state !== 'coreDone' && state !== 'abandoned') return undefined;
  if (repository !== undefined && !isAbsolute(repository)) return undefined;
  if (finishedAt !== undefined && !isCount(finishedAt)) return undefined;
  const parsedFailures = repairFailures === undefined ? [] : Array.isArray(repairFailures) ? repairFailures.map(repairFailureOf) : [undefined];
  if (parsedFailures.some((failure) => failure === undefined)) return undefined;
  if (!Array.isArray(folders) || folders.length === 0) return undefined;
  const parsedFolders = folders.map(folderOf);
  if (parsedFolders.some((folder) => folder === undefined)) return undefined;
  // readers take the first folder for the project
  if (parsedFolders[0]!.kind !== 'project' || parsedFolders.filter((folder) => folder!.kind === 'project').length !== 1) return undefined;
  if (!isObject(steps) || Object.keys(steps).some((name) => !(RELOCATION_STEPS as readonly string[]).includes(name))) return undefined;
  const parsedSteps = {} as Record<RelocationStepName, RelocationStepState>;
  for (const name of RELOCATION_STEPS) {
    const step = stepOf(steps[name]);
    if (!step) return undefined;
    parsedSteps[name] = step;
  }
  return {
    id, seq, requestedBy, mode, chats, state, startedAt,
    folders: parsedFolders as RelocationFolder[],
    steps: parsedSteps,
    ...(repository !== undefined ? { repository } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(parsedFailures.length > 0 ? { repairFailures: parsedFailures as WorktreeRepairFailure[] } : {}),
  };
}

function repairFailureOf(raw: unknown): WorktreeRepairFailure | undefined {
  if (!isObject(raw) || !isId(raw['worktreeId'])) return undefined;
  const failure = codedOf(raw['failure']);
  return failure ? { worktreeId: raw['worktreeId'], failure } : undefined;
}

// A host's path is spelled by the host's rules, which need not be this computer's.
function isHostPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH && !value.includes('\0');
}

function hostAliasOf(raw: unknown): HostAlias | undefined {
  if (!isObject(raw)) return undefined;
  const { hostId, from, to, seq, startedAt } = raw;
  if (typeof hostId !== 'string' || !isSafeAgentPathId(hostId) || hostId.length > MAX_ID_LENGTH) return undefined;
  if (!isHostPath(from) || !isHostPath(to) || !isCount(seq) || seq === 0) return undefined;
  if (startedAt !== undefined && !isCount(startedAt)) return undefined;
  return { hostId, from, to, seq, ...(startedAt !== undefined ? { startedAt } : {}) };
}

// An entry with no readable startedAt still moves its folders, for every recorded time.
function aliasSourceOf(raw: unknown): AliasSource | undefined {
  if (!isObject(raw) || !isCount(raw['seq']) || !Array.isArray(raw['folders'])) return undefined;
  const steps = raw['steps'];
  const worktreesDone = isObject(steps) && isObject(steps['worktrees']) && steps['worktrees']['state'] === 'done';
  const folders = raw['state'] === 'abandoned' && !worktreesDone ? [] : foldersOf(raw);
  return { seq: raw['seq'], ...(isCount(raw['startedAt']) ? { startedAt: raw['startedAt'] } : {}), folders };
}

function foldersOf(raw: Record<string, unknown>): Array<{ from: string; to: string }> {
  const folders = Array.isArray(raw['folders']) ? raw['folders'] as unknown[] : [];
  return folders.flatMap((f) => (isObject(f) && isAbsolute(f['from']) && isAbsolute(f['to']) ? [{ from: f['from'], to: f['to'] }] : []));
}

// docs/invariants.md "Project relocation": an abandoned relocation's moves count once its worktrees step re-pointed the records.
function recordAliasSource(record: RelocationRecord): AliasSource {
  return record.state === 'abandoned' && record.steps.worktrees.state !== 'done' ? { seq: record.seq, startedAt: record.startedAt, folders: [] } : record;
}

function foreignPendingOf(foreign: readonly unknown[]): AliasSource[] {
  return foreign.flatMap((raw) => (isObject(raw) && raw['state'] !== 'coreDone' && raw['state'] !== 'abandoned' ? [{ seq: isCount(raw['seq']) ? raw['seq'] : 0, folders: foldersOf(raw) }] : []));
}
