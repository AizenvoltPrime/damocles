import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { StoredSession } from '@shared/types/session';
import { installWorkerLogRelay, log } from '../../../logger';
import { readFile } from '../../../resource-fs';
import { isCorruption } from '../../../usage-stats/database';
import { PI_PROMPT_HISTORY_CAP } from '../metadata';
import { createInlineParser, createThreadParser, isParseWorkerData, serveParser, type SessionFileParser } from './parser';
import {
  SESSION_META_INDEX_WORKER_MARKER,
  metaCacheKey,
  piSessionIdFromFile,
  type MetaIndexEvent,
  type MetaIndexRequest,
  type SessionMetaEntry,
  type SessionMetaIndexWorkerData,
} from './protocol';
import { indexFileName, openMetaStore, type IndexRow, type MetaStore } from './store';

// The worker owns its index connection and parses through its parser; it never imports host services (docs/invariants.md "Session store").

/** Puts reach the file at most this long after they arrive; until then they are served from memory. */
export const PUT_COMMIT_MS = 2000;
export const LIST_BATCH_SIZE = 16;
/** A list sends what it parsed at least this often, so a slow batch still shows progress and restarts the client's request timeout. */
export const LIST_BATCH_MS = 250;
const STAT_BATCH = 16;
/** Another app may still write its index or legacy cache; a file unwritten this long is not in use. */
export const PRUNE_AFTER_MS: number = 30 * 24 * 60 * 60 * 1000;
const LEGACY_CACHE_FILE = /\.json$|\.json\.\d+\.[0-9a-f-]+\.tmp$/;
const INDEX_FILE = /^index\..*\.db(?:-wal|-shm|-journal)?$/;

export interface MetaIndexRuntimeOptions {
  cacheDir: string;
  piPackageDir: string;
  putCommitMs?: number;
  listBatchSize?: number;
  listBatchMs?: number;
  /** Closed with the runtime; parses on this thread unless the caller gives one. */
  parser?: SessionFileParser;
}

export interface MetaIndexRuntime {
  handle(msg: Exclude<MetaIndexRequest, { type: 'close' }>): void;
  /** Commits pending puts and closes the index; requests still running stop at their next step. */
  close(): Promise<void>;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';
const matches = <T extends Pick<SessionMetaEntry, 'size' | 'mtimeMs'>>(entry: T | undefined, size: number, mtimeMs: number): entry is T =>
  entry !== undefined && entry.size === size && entry.mtimeMs === mtimeMs;
// pi only appends, so a later state of a file has a later mtime, or the same mtime and more bytes.
const isNewer = (a: Pick<SessionMetaEntry, 'size' | 'mtimeMs'>, b: Pick<SessionMetaEntry, 'size' | 'mtimeMs'>): boolean =>
  a.mtimeMs > b.mtimeMs || (a.mtimeMs === b.mtimeMs && a.size > b.size);

/** Delete legacy JSON caches and other apps' index files in `cacheDir` unwritten for `PRUNE_AFTER_MS`. */
export async function pruneCacheDir(cacheDir: string, keep: string): Promise<void> {
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  let names: string[];
  try {
    names = await fsp.readdir(cacheDir);
  } catch (err) {
    log('[session-meta-index] pruning %s failed: %s', cacheDir, messageOf(err));
    return;
  }
  // An index and its WAL siblings go together, judged by the newest of them.
  const groups = new Map<string, string[]>();
  for (const name of names) {
    let group: string;
    if (LEGACY_CACHE_FILE.test(name)) group = name;
    else if (INDEX_FILE.test(name)) group = name.replace(/-(?:wal|shm|journal)$/, '');
    else continue;
    if (group === keep) continue;
    groups.set(group, [...(groups.get(group) ?? []), name]);
  }
  for (const members of groups.values()) {
    const stats = await Promise.all(members.map((name) => fsp.stat(path.join(cacheDir, name)).catch(() => null)));
    if (stats.some((s) => s === null || s.mtimeMs >= cutoff)) continue;
    for (const name of members) {
      await fsp.rm(path.join(cacheDir, name), { force: true }).catch((err: unknown) => log('[session-meta-index] removing %s failed: %s', name, messageOf(err)));
    }
  }
}

export function createMetaIndexRuntime(send: (event: MetaIndexEvent) => void, options: MetaIndexRuntimeOptions): MetaIndexRuntime {
  const putCommitMs = options.putCommitMs ?? PUT_COMMIT_MS;
  const listBatchSize = options.listBatchSize ?? LIST_BATCH_SIZE;
  const listBatchMs = options.listBatchMs ?? LIST_BATCH_MS;
  const parser = options.parser ?? createInlineParser(options.piPackageDir);
  const pending = new Map<string, IndexRow>();
  const parsing = new Map<string, Promise<IndexRow | undefined>>();
  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  let piVersion = '';
  let store: MetaStore | null = null;
  let closing = false;

  // pi's package.json is read, never pi itself: a warm list never loads pi.
  const ready: Promise<void> = (async () => {
    const pkg = JSON.parse(await readFile(path.join(options.piPackageDir, 'package.json'), 'utf8')) as { version: string };
    piVersion = pkg.version;
    store = openMetaStore(options.cacheDir, piVersion);
    void pruneCacheDir(options.cacheDir, indexFileName(piVersion));
  })();
  // Logged here, as it can fail before any request awaits it; every request still fails with it.
  ready.catch((err: unknown) => log('[session-meta-index] opening the index failed: %O', err));

  /** Runs `fn` on the index; one that turns out corrupt is deleted, rebuilt and `fn` runs again. */
  async function useStore<T>(fn: (s: MetaStore) => T): Promise<T> {
    await ready;
    try {
      return fn(store!);
    } catch (err) {
      if (!isCorruption(err)) throw err;
      log('[session-meta-index] %s is corrupt (%s); rebuilding it', store!.file, messageOf(err));
      store!.close();
      store = openMetaStore(options.cacheDir, piVersion, { discard: true });
      return fn(store);
    }
  }

  /** The entry for `key` read from the file as it is now. A pending put is newer than any row this process stored, so it decides alone. */
  function validEntry(s: MetaStore, key: string, size: number, mtimeMs: number): SessionMetaEntry | undefined {
    const entry = pending.get(key) ?? s.entry(key);
    return matches(entry, size, mtimeMs) ? entry : undefined;
  }

  /** The index is a cache: a write that fails (a full disk, a lock held past the busy timeout) costs re-parses later, never the answer it belongs to. */
  async function writeCache(what: string, fn: (s: MetaStore) => void): Promise<boolean> {
    try {
      await useStore(fn);
      return true;
    } catch (err) {
      log('[session-meta-index] %s failed; the rows stay unindexed: %s', what, messageOf(err));
      return false;
    }
  }

  /** A pending put older than a fresh parse would make every lookup miss until it commits, so it goes; a newer one stays. */
  async function storeParsed(rows: readonly IndexRow[]): Promise<void> {
    for (const row of rows) {
      const put = pending.get(row.key);
      if (put && isNewer(row, put)) pending.delete(row.key);
    }
    await writeCache('storing parsed rows', (s) => s.write(rows));
  }

  /** pi's own full parse, one per file state at a time; undefined when the parser could not parse at all. */
  function parse(file: string, key: string, size: number, mtimeMs: number): Promise<IndexRow | undefined> {
    const job = `${key}\0${size}\0${mtimeMs}`;
    let run = parsing.get(job);
    if (!run) {
      run = parser
        .parse(file, mtimeMs)
        .then((meta) => (meta ? { key, dirKey: path.dirname(key), size, mtimeMs, ...meta } : undefined))
        .finally(() => parsing.delete(job));
      parsing.set(job, run);
    }
    return run;
  }

  async function list(id: number, dir: string): Promise<void> {
    let names: string[];
    try {
      names = (await fsp.readdir(dir)).filter((name) => name.endsWith('.jsonl'));
    } catch (err) {
      // A missing dir holds no sessions; one that cannot be read holds sessions this list cannot name.
      const missing = isMissing(err);
      if (!missing) log('[session-meta-index] listing %s failed: %s', dir, messageOf(err));
      send({ type: 'listed', id, sessions: [], files: [], parsing: 0 });
      send({ type: 'listDone', id, complete: missing });
      return;
    }
    // Stat every file at once: awaiting them one by one queues each behind the parses of other requests.
    const stats = await Promise.all(names.map((name) => fsp.stat(path.join(dir, name)).catch(() => null)));
    const dirKey = metaCacheKey(dir);
    const misses: Array<{ file: string; key: string; size: number; mtimeMs: number }> = [];
    const sessions: StoredSession[] = [];
    const files: string[] = [];
    const gone = await useStore((s) => {
      const known = new Map(s.dirRows(dirKey).map((row) => [row.key, row]));
      const seen = new Set<string>();
      for (const [i, name] of names.entries()) {
        const stat = stats[i];
        if (!stat) continue; // vanished between readdir and stat
        const file = path.join(dir, name);
        const key = metaCacheKey(file);
        const { size, mtimeMs } = stat;
        seen.add(key);
        files.push(file);
        const entry = pending.get(key) ?? known.get(key);
        const hit = matches(entry, size, mtimeMs) ? entry : undefined;
        if (!hit) misses.push({ file, key, size, mtimeMs });
        else if (hit.stored) sessions.push(hit.stored);
      }
      return [...known.keys()].filter((key) => !seen.has(key));
    });
    if (gone.length > 0) await writeCache(`evicting the rows of files gone from ${dir}`, (s) => s.delete(gone));
    send({ type: 'listed', id, sessions, files, parsing: misses.length });
    let rows: IndexRow[] = [];
    let complete = true;
    // Taken synchronously, so a flush on the timer and one on a full batch never send a row twice.
    const flush = async (): Promise<void> => {
      const batch = rows;
      rows = [];
      await storeParsed(batch);
      if (!closing) send({ type: 'listBatch', id, sessions: batch.flatMap((row) => (row.stored ? [row.stored] : [])) });
    };
    // Sent with no rows too, a parse still running included: each batch restarts the client's request and stall timers.
    const ticker = setInterval(() => void flush(), listBatchMs);
    try {
      for (const miss of misses) {
        const row = await parse(miss.file, miss.key, miss.size, miss.mtimeMs);
        if (closing) return;
        if (row) rows.push(row);
        else complete = false;
        if (rows.length >= listBatchSize) await flush();
      }
    } finally {
      clearInterval(ticker);
    }
    if (rows.length > 0) await flush();
    if (!closing) send({ type: 'listDone', id, complete });
  }

  async function meta(id: number, file: string): Promise<void> {
    let size: number;
    let mtimeMs: number;
    try {
      ({ size, mtimeMs } = await fsp.stat(file));
    } catch (err) {
      // pi's `SessionManager.open` of a missing path starts a new session there.
      if (isMissing(err)) forget(file);
      else log('[session-meta-index] stat of %s failed: %s', file, messageOf(err));
      send({ type: 'meta', id, stored: null });
      return;
    }
    const key = metaCacheKey(file);
    const hit = await useStore((s) => validEntry(s, key, size, mtimeMs));
    if (hit) {
      send({ type: 'meta', id, stored: hit.stored });
      return;
    }
    const row = await parse(file, key, size, mtimeMs);
    if (row) await storeParsed([row]);
    send({ type: 'meta', id, stored: row?.stored ?? null });
  }

  /** Stats the file and never reads it: on Windows a read updates the access time, which `fs.watch` reports. */
  async function cachedRow(id: number, file: string): Promise<void> {
    let size: number;
    let mtimeMs: number;
    try {
      ({ size, mtimeMs } = await fsp.stat(file));
    } catch {
      send({ type: 'cachedRow', id, found: false, stored: null });
      return;
    }
    const hit = await useStore((s) => validEntry(s, metaCacheKey(file), size, mtimeMs));
    send({ type: 'cachedRow', id, found: hit !== undefined, stored: hit?.stored ?? null });
  }

  async function promptHistory(id: number, dirs: readonly string[], sessionIds: readonly string[]): Promise<void> {
    // One readdir per dir into an id map, so each session resolves in O(1).
    const files = new Map<string, string>();
    for (const dir of dirs) {
      let names: string[];
      try {
        names = await fsp.readdir(dir);
      } catch (err) {
        if (!isMissing(err)) log('[session-meta-index] listing %s failed: %s', dir, messageOf(err));
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const sessionId = piSessionIdFromFile(name);
        if (!files.has(sessionId)) files.set(sessionId, path.join(dir, name));
      }
    }
    const seen = new Set<string>();
    const prompts: string[] = [];
    let opened = 0;
    // Only as many stat batches as it takes to reach the cap.
    for (let start = 0; start < sessionIds.length && prompts.length < PI_PROMPT_HISTORY_CAP && !closing; start += STAT_BATCH) {
      const batch = sessionIds.slice(start, start + STAT_BATCH).map((sessionId) => files.get(sessionId));
      const stats = await Promise.all(batch.map((file) => (file ? fsp.stat(file).catch(() => null) : null)));
      const parsed: IndexRow[] = [];
      for (const [i, file] of batch.entries()) {
        const stat = stats[i];
        if (!file || !stat || prompts.length >= PI_PROMPT_HISTORY_CAP) continue;
        const key = metaCacheKey(file);
        let entry = await useStore((s) => validEntry(s, key, stat.size, stat.mtimeMs));
        if (!entry) {
          const row = await parse(file, key, stat.size, stat.mtimeMs);
          if (!row) continue;
          opened++;
          parsed.push(row);
          entry = row;
        }
        for (const prompt of entry.prompts) {
          if (seen.has(prompt)) continue;
          seen.add(prompt);
          prompts.push(prompt);
          if (prompts.length >= PI_PROMPT_HISTORY_CAP) break;
        }
      }
      await storeParsed(parsed);
    }
    send({ type: 'promptHistory', id, prompts, opened });
  }

  /** A put stays served from memory until its write succeeded, and a newer put for its file is kept. */
  async function commitPending(): Promise<void> {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = null;
    const rows = [...pending.values()];
    if (!(await writeCache('committing live snapshots', (s) => s.write(rows)))) return;
    for (const row of rows) if (pending.get(row.key) === row) pending.delete(row.key);
  }

  function put(file: string, entry: SessionMetaEntry): void {
    const key = metaCacheKey(file);
    pending.set(key, { key, dirKey: path.dirname(key), ...entry });
    commitTimer ??= setTimeout(() => {
      commitTimer = null;
      void commitPending();
    }, putCommitMs);
  }

  function forget(file: string): void {
    const key = metaCacheKey(file);
    pending.delete(key);
    void writeCache(`forgetting ${file}`, (s) => s.delete([key]));
  }

  function answer(id: number, run: Promise<void>): void {
    run.catch((err: unknown) => {
      if (!closing) send({ type: 'error', id, message: messageOf(err) });
    });
  }

  return {
    handle(msg) {
      // Synchronous on arrival, so a request that arrives after a put or forget sees it.
      switch (msg.type) {
        case 'put': put(msg.file, msg.entry); return;
        case 'forget': forget(msg.file); return;
        case 'list': answer(msg.id, list(msg.id, msg.dir)); return;
        case 'meta': answer(msg.id, meta(msg.id, msg.file)); return;
        case 'cachedRow': answer(msg.id, cachedRow(msg.id, msg.file)); return;
        case 'promptHistory': answer(msg.id, promptHistory(msg.id, msg.dirs, msg.sessionIds)); return;
      }
    },
    async close() {
      closing = true;
      await parser.close();
      await commitPending();
      store!.close();
    },
  };
}

// The marker keeps a test runner's own worker thread from wiring its port here on import.
const data = workerData as Partial<SessionMetaIndexWorkerData> | null | undefined;
if (!isMainThread && parentPort && data?.marker === SESSION_META_INDEX_WORKER_MARKER) {
  const port = parentPort;
  const { cacheDir, piPackageDir } = data as SessionMetaIndexWorkerData;
  const post = (event: MetaIndexEvent): void => port.postMessage(event);
  installWorkerLogRelay((message) => post({ type: 'log', message }));
  // The parse thread runs this bundle in its parse role.
  const runtime = createMetaIndexRuntime(post, { cacheDir, piPackageDir, parser: createThreadParser(__filename, piPackageDir) });
  port.on('message', (msg: MetaIndexRequest) => {
    if (msg.type !== 'close') {
      runtime.handle(msg);
      return;
    }
    runtime.close().catch((err: unknown) => log('[session-meta-index] closing failed: %O', err)).finally(() => port.close());
  });
} else if (!isMainThread && parentPort && isParseWorkerData(workerData)) {
  const port = parentPort;
  installWorkerLogRelay((message) => port.postMessage({ type: 'log', message }));
  serveParser(port, workerData.piPackageDir);
}
