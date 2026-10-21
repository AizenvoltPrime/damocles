import { posix, win32 } from 'node:path';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { extract, type ReadEntry } from 'tar';
import { VOICE_EXTRACT_WORKER_MARKER, type ExtractEvent, type ExtractWorkerData } from './extract-protocol';

/**
 * A path that stays inside the extraction folder on every platform: relative under both path flavours, with no drive
 * letter (`C:x` is relative to that drive's current folder) and no `..` segment, either separator counted.
 */
export function isSafeEntryPath(path: string): boolean {
  if (path.length === 0) return false;
  const slashed = path.replace(/\\/g, '/');
  if (posix.isAbsolute(slashed) || win32.isAbsolute(path) || /^[A-Za-z]:/.test(slashed)) return false;
  return !slashed.split('/').includes('..');
}

/**
 * The extraction filter: an entry is written only when its path, and a link's target, stay inside the extraction folder.
 * A hard link's target is relative to that folder, a symbolic link's to the link's own folder. node-tar's defaults refuse
 * the unsafe entry paths too; the filter keeps them refused if those defaults change.
 */
export function isSafeEntry(path: string, entry: { readonly type: ReadEntry['type']; readonly linkpath?: string | undefined }): boolean {
  if (!isSafeEntryPath(path)) return false;
  if (entry.type !== 'Link' && entry.type !== 'SymbolicLink') return true;
  if (entry.linkpath === undefined) return false;
  if (entry.type === 'Link') return isSafeEntryPath(entry.linkpath);
  const target = entry.linkpath.replace(/\\/g, '/');
  if (posix.isAbsolute(target) || win32.isAbsolute(entry.linkpath) || /^[A-Za-z]:/.test(target)) return false;
  return isSafeEntryPath(posix.normalize(posix.join(posix.dirname(path.replace(/\\/g, '/')), target)));
}

/** Extracts on the calling thread; the worker entry below is its only production caller. */
export function extractArchive(file: string, cwd: string): Promise<void> {
  return extract({ file, cwd, strict: true, filter: (path, entry) => isSafeEntry(path, entry as ReadEntry) });
}

// The marker keeps a test runner's own worker thread from extracting on import.
const data = workerData as Partial<ExtractWorkerData> | null | undefined;
if (!isMainThread && parentPort && data?.marker === VOICE_EXTRACT_WORKER_MARKER && data.file && data.cwd) {
  const port = parentPort;
  const post = (event: ExtractEvent): void => port.postMessage(event);
  extractArchive(data.file, data.cwd).then(
    () => post({ type: 'done' }),
    (err: unknown) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
  );
}
