import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as lockfile from 'proper-lockfile';
import { settlePending } from '../../shared/settle-pending';
import { log } from '../logger';
import { folderKey } from '../workspace-folders/folder-key';

// A lock whose heartbeat stopped this long ago belongs to a dead process and is taken over. The takeover is not
// exclusive: two waiters can both remove a stale lock, and a holder stalled past this threshold is superseded; the
// loser learns so only at its next heartbeat, and a rename before then overwrites the other writer's file.
// See docs/invariants.md "Platform boundary and shared stores".
export const JSON_CONFIG_LOCK_STALE_MS = 20_000;
const LOCK_UPDATE_MS = 2_000;
// Retries span well past the stale threshold, so a crashed holder delays a write rather than failing it.
const LOCK_RETRIES = { retries: 150, factor: 1.3, minTimeout: 5, maxTimeout: 250, randomize: true };
const RENAME_RETRY_BUDGET_MS = 10_000;
const RETRYABLE_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
// The kernel's own symlink hop limit on Linux.
const MAX_LINK_HOPS = 40;

export type JsonConfigWriteStage = 'lock' | 'read' | 'write';

/** A failure of the write machinery itself; errors thrown by the mutation propagate unchanged. */
export class JsonConfigWriteError extends Error {
  readonly stage: JsonConfigWriteStage;
  readonly code: string | undefined;

  constructor(stage: JsonConfigWriteStage, filePath: string, cause: unknown) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    super(`${stage} failed for ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'JsonConfigWriteError';
    this.stage = stage;
    this.code = code;
  }
}

export interface JsonConfigWriteOptions {
  /** Mode the file gets on every write, existing or new; without it a new file gets the default and an existing one keeps its mode. */
  readonly fileMode?: number;
  /** Mode of parent directories created for a first write. */
  readonly dirMode?: number;
  /** The directory the file must resolve directly inside, that directory itself not being a symlink; for a file a repository owns. */
  readonly confineTo?: string;
}

/** Receives the current file text (undefined when the file does not exist) and returns the new text. */
export type JsonConfigMutation = (current: string | undefined) => string | Promise<string>;

const writeQueue = new Map<string, Promise<void>>();

/**
 * Read-modify-write a Damocles-owned config file, serialised per path within this process and across
 * processes by a lock file, and replaced atomically so lock-free readers never see a partial file.
 */
export function writeJsonConfig(
  filePath: string,
  mutate: JsonConfigMutation,
  options: JsonConfigWriteOptions = {},
): Promise<void> {
  const key = path.resolve(filePath);
  const run = (): Promise<void> => lockedWrite(key, mutate, options);
  const pending = writeQueue.get(key) ?? Promise.resolve();
  const next = pending.then(run, run);
  writeQueue.set(key, next);
  void next
    .catch(() => undefined)
    .finally(() => {
      if (writeQueue.get(key) === next) writeQueue.delete(key);
    });
  return next;
}

/**
 * Settles once no write to the files is queued or running in this process, one queued meanwhile included; never rejects.
 * A function is asked again after each round, so a file it starts listing meanwhile is waited for too.
 */
export function jsonConfigWritesSettled(files: string | (() => Iterable<string>)): Promise<void> {
  const list = typeof files === 'string' ? (): Iterable<string> => [files] : files;
  return settlePending(() => [...list()].flatMap((file) => writeQueue.get(path.resolve(file)) ?? []));
}

/** Settles once no write to any file is queued or running in this process, one queued meanwhile included; never rejects. */
export function allJsonConfigWritesSettled(): Promise<void> {
  return settlePending(() => writeQueue.values());
}

async function lockedWrite(filePath: string, mutate: JsonConfigMutation, options: JsonConfigWriteOptions): Promise<void> {
  // Writes go through a symlinked config file, dangling or not, to its target instead of replacing the link.
  const target = await resolveTarget(filePath);
  if (options.confineTo !== undefined) await assertConfined(target, options.confineTo);
  await fs.mkdir(path.dirname(target), { recursive: true, ...(options.dirMode !== undefined ? { mode: options.dirMode } : {}) });

  let compromised: Error | undefined;
  let release: () => Promise<void>;
  try {
    // realpath false: the target may not exist yet; the lock is the sibling directory `<target>.lock`.
    release = await lockfile.lock(target, {
      realpath: false,
      stale: JSON_CONFIG_LOCK_STALE_MS,
      update: LOCK_UPDATE_MS,
      retries: LOCK_RETRIES,
      onCompromised: (err) => {
        compromised = err;
      },
    });
  } catch (err) {
    throw new JsonConfigWriteError('lock', target, err);
  }

  try {
    const current = await readCurrent(target);
    const text = await mutate(current);
    await replaceFile(target, current, text, options, () => compromised);
  } finally {
    if (!compromised) await releaseLock(release, target);
  }
}

// The write has landed or failed on its own merits by now; an unreleased lock only goes stale.
async function releaseLock(release: () => Promise<void>, target: string): Promise<void> {
  try {
    await release();
  } catch (err) {
    log(`[JsonConfigWrite] Could not release the lock on ${target}; it goes stale in ${JSON_CONFIG_LOCK_STALE_MS / 1000} s: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function resolveTarget(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new JsonConfigWriteError('read', filePath, err);
  }
  let link = filePath;
  for (let hops = 0; ; hops++) {
    let destination: string;
    try {
      destination = await fs.readlink(link);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // EINVAL: an existing path that is not a link; ENOENT: nothing there yet.
      if (code === 'EINVAL' || code === 'ENOENT') break;
      throw new JsonConfigWriteError('read', filePath, err);
    }
    if (hops === MAX_LINK_HOPS) throw new JsonConfigWriteError('read', filePath, Object.assign(new Error('too many symbolic links'), { code: 'ELOOP' }));
    link = path.resolve(path.dirname(link), destination);
  }
  return path.join(await realDirectory(path.dirname(link)), path.basename(link));
}

// realpath of a directory that may not exist yet: its nearest existing ancestor resolved, the rest appended.
async function realDirectory(dir: string): Promise<string> {
  try {
    return await fs.realpath(dir);
  } catch (err) {
    const parent = path.dirname(dir);
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === dir) throw new JsonConfigWriteError('read', dir, err);
    return path.join(await realDirectory(parent), path.basename(dir));
  }
}

async function assertConfined(target: string, dir: string): Promise<void> {
  const resolved = path.resolve(dir);
  const allowed = path.join(await realDirectory(path.dirname(resolved)), path.basename(resolved));
  if (folderKey(path.dirname(target)) !== folderKey(allowed)) {
    throw new JsonConfigWriteError('write', target, new Error(`it resolves outside ${resolved}, so it was not written`));
  }
}

async function readCurrent(target: string): Promise<string | undefined> {
  try {
    return await fs.readFile(target, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new JsonConfigWriteError('read', target, err);
  }
}

async function existingMode(target: string): Promise<number | undefined> {
  try {
    return (await fs.stat(target)).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new JsonConfigWriteError('write', target, err);
  }
}

// Only a lock holder writes a temp file, so one found while holding the lock was left by a crashed writer.
async function removeOrphanedTempFiles(target: string): Promise<void> {
  const dir = path.dirname(target);
  const base = path.basename(target);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    throw new JsonConfigWriteError('write', target, err);
  }
  for (const entry of entries) {
    if (!entry.startsWith(`${base}.`) || !/^\.\d+\.tmp$/.test(entry.slice(base.length))) continue;
    await fs.rm(path.join(dir, entry), { force: true }).catch((err: unknown) => {
      log(`[JsonConfigWrite] Could not remove ${entry} beside ${target}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

async function replaceFile(
  target: string,
  current: string | undefined,
  text: string,
  options: JsonConfigWriteOptions,
  compromised: () => Error | undefined,
): Promise<void> {
  const mode = await existingMode(target);
  const nextMode = options.fileMode ?? mode;
  // Rewriting identical text would only wake every watcher of the file.
  if (text === current && nextMode === mode) return;
  await removeOrphanedTempFiles(target);
  const tempPath = `${target}.${process.pid}.tmp`;
  try {
    const handle = await fs.open(tempPath, 'w', nextMode ?? 0o666);
    try {
      await handle.writeFile(text, 'utf-8');
      // Flushed before the rename, so a crash cannot leave the renamed target empty.
      await handle.sync();
    } finally {
      await handle.close();
    }
    // open's mode is masked by umask; the kept or required mode is applied exactly.
    if (nextMode !== undefined) await fs.chmod(tempPath, nextMode);
    const lost = compromised();
    if (lost) throw lost;
    await renameWithRetry(tempPath, target);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch((rmErr: unknown) => {
      log(`[JsonConfigWrite] Could not remove ${tempPath}: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`);
    });
    throw new JsonConfigWriteError('write', target, err);
  }
}

/** A rename retried for a bounded time while Windows refuses it because another process (an editor, an indexer, antivirus) has the target open. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  const deadline = Date.now() + RENAME_RETRY_BUDGET_MS;
  let delay = 10;
  for (;;) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || code === undefined || !RETRYABLE_RENAME_CODES.has(code) || Date.now() >= deadline) {
        throw err;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay + 10, 100);
    }
  }
}
