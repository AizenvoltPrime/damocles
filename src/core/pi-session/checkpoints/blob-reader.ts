// Checkpoint blobs as the chat review and the rewind diff read them: one `git show`, or one `git cat-file --batch` per repo.
import { createHash } from 'node:crypto';
import { EDITOR_MAX_DOCUMENT_BYTES } from '../../../shared/types/messages';
import { gitExecutable } from '../../git-executable';
import { log } from '../../logger';
import { processLauncher, type LaunchedProcess, type Launcher } from '../../process-launcher';
import { childEnv, exec, ExecOutputTooLargeError } from './exec';
import { PORTABLE_CONFIG } from './repo-manager';
import { getGitDir } from './resolver';
import { isHexCommit } from './types';

/**
 * A file in a checkpoint commit: its text, absent from the commit, binary (a NUL among its first 8000 bytes; digest: sha1 of
 * its bytes), past EDITOR_MAX_DOCUMENT_BYTES, which neither the review nor the rewind diff shows, or unavailable (the commit
 * is gone or git failed).
 */
export type CheckpointFileRead = { kind: 'text'; text: string } | { kind: 'absent' } | { kind: 'binary'; digest: string } | { kind: 'tooLarge' } | { kind: 'unavailable' };

// git's binary test (`buffer_is_binary`): a NUL among the first 8000 bytes.
const BINARY_PROBE_LENGTH = 8000;

/** Bytes within EDITOR_MAX_DOCUMENT_BYTES as the review compares them, from a checkpoint or from disk. */
export function classifyFileBytes(bytes: Buffer): { kind: 'text'; text: string } | { kind: 'binary'; digest: string } {
  if (bytes.subarray(0, BINARY_PROBE_LENGTH).includes(0)) return { kind: 'binary', digest: createHash('sha1').update(bytes).digest('hex') };
  return { kind: 'text', text: bytes.toString('utf8') };
}

/** `git show <commit>:<path>` failure messages that mean the path is absent from the commit (the file was created that turn). */
const GIT_PATH_ABSENT = /does not exist in|exists on disk, but not in/i;

const UNAVAILABLE: CheckpointFileRead = { kind: 'unavailable' };

/**
 * `git show <commit>:<relativePath>` from a checkpoint repo; relativePath is '/' separated, relative to the folder the repo
 * snapshots. absent only when git says the path is not in the commit (the file did not exist then).
 */
export async function checkpointCommitFile(repoDir: string, commit: string, relativePath: string): Promise<CheckpointFileRead> {
  if (!isHexCommit(commit)) return UNAVAILABLE;
  try {
    const { bytes } = await exec(gitExecutable, [...PORTABLE_CONFIG, `--git-dir=${getGitDir(repoDir)}`, 'show', `${commit}:${relativePath}`], undefined, undefined, undefined, undefined, undefined, EDITOR_MAX_DOCUMENT_BYTES);
    return classifyFileBytes(bytes);
  } catch (err) {
    if (err instanceof ExecOutputTooLargeError) return { kind: 'tooLarge' };
    const message = err instanceof Error ? err.message : String(err);
    if (GIT_PATH_ABSENT.test(message)) return { kind: 'absent' };
    log('[session-store] reading %s from checkpoint %s failed: %s', relativePath, commit, message);
    return UNAVAILABLE;
  }
}

/**
 * One answer of `cat-file --batch`: `<spec> missing`, `<spec> ambiguous` (a short commit id naming several objects), or an
 * object whose bytes are dropped past the review's bound.
 */
type BatchAnswer = { readonly kind: 'missing' } | { readonly kind: 'ambiguous' } | { readonly kind: 'object'; readonly type: string; readonly bytes: Buffer | undefined };

const OBJECT_HEADER = /^[0-9a-f]{40,64} (\S+) (\d+)$/;

interface Batch {
  readonly process: LaunchedProcess;
  // one per request written, in order; undefined when the reader failed first
  readonly waiting: Array<(answer: BatchAnswer | undefined) => void>;
  // `<commit>^{commit}` per commit: true when the commit is in the repo
  readonly commits: Map<string, Promise<boolean | undefined>>;
  header: Buffer[];
  body: { readonly type: string; readonly size: number; remaining: number; readonly kept: Buffer[] | undefined } | undefined;
}

export interface BlobReader {
  read(commit: string, relativePath: string): Promise<CheckpointFileRead>;
  // ends git and settles once it has exited, so the repo's files are free again
  close(): Promise<void>;
}

/**
 * One `git cat-file --batch` for a checkpoint repo, started on the first read. An exit or a parse error fails the reads
 * waiting on it and discards it; the next read starts another. Keep it no longer than one recompute: on Windows a running
 * git holds the repo's pack files open, which a checkpoint repack or prune, possibly in another Damocles process, deletes.
 */
export function openBlobReader(repoDir: string, launcher?: Launcher): BlobReader {
  let batch: Batch | undefined;
  let closed = false;

  const fail = (failed: Batch, reason: string): void => {
    if (batch === failed) batch = undefined;
    failed.process.kill();
    const waiting = failed.waiting.splice(0);
    if (waiting.length > 0) log('[Checkpoints] the blob reader of %s stopped with %d reads waiting: %s', repoDir, waiting.length, reason);
    for (const resolve of waiting) resolve(undefined);
  };

  const answer = (current: Batch, value: BatchAnswer): void => {
    const resolve = current.waiting.shift();
    if (resolve) resolve(value);
    else fail(current, 'git answered a read nobody made');
  };

  const onOutput = (current: Batch, chunk: Buffer): void => {
    let offset = 0;
    while (offset < chunk.length && batch === current) {
      const body = current.body;
      if (body === undefined) {
        const end = chunk.indexOf(0x0a, offset);
        if (end < 0) {
          current.header.push(chunk.subarray(offset));
          return;
        }
        current.header.push(chunk.subarray(offset, end));
        offset = end + 1;
        const line = Buffer.concat(current.header).toString('utf8');
        current.header = [];
        if (line.endsWith(' missing')) {
          answer(current, { kind: 'missing' });
          continue;
        }
        if (line.endsWith(' ambiguous')) {
          answer(current, { kind: 'ambiguous' });
          continue;
        }
        const match = OBJECT_HEADER.exec(line);
        if (!match) {
          fail(current, `unexpected answer ${JSON.stringify(line.slice(0, 200))}`);
          return;
        }
        const size = Number(match[2]);
        // content past the bound is read through and dropped, so the next answer still lines up
        current.body = { type: match[1]!, size, remaining: size + 1, kept: size <= EDITOR_MAX_DOCUMENT_BYTES ? [] : undefined };
        continue;
      }
      const take = Math.min(body.remaining, chunk.length - offset);
      body.kept?.push(chunk.subarray(offset, offset + take));
      body.remaining -= take;
      offset += take;
      if (body.remaining > 0) continue;
      current.body = undefined;
      const bytes = body.kept ? Buffer.concat(body.kept) : undefined;
      if (bytes !== undefined && bytes[body.size] !== 0x0a) {
        fail(current, 'an object without its closing line feed');
        return;
      }
      answer(current, { kind: 'object', type: body.type, bytes: bytes?.subarray(0, body.size) });
    }
  };

  const start = (): Batch | undefined => {
    let child: LaunchedProcess;
    try {
      child = (launcher ?? processLauncher()).launch({
        file: gitExecutable(),
        args: [...PORTABLE_CONFIG, `--git-dir=${getGitDir(repoDir)}`, 'cat-file', '--batch'],
        env: childEnv(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (err) {
      log('[Checkpoints] the blob reader of %s could not start: %s', repoDir, err instanceof Error ? err.message : String(err));
      return undefined;
    }
    const current: Batch = { process: child, waiting: [], commits: new Map(), header: [], body: undefined };
    child.onData('stdout', (chunk) => onOutput(current, chunk));
    Promise.all([child.exited, child.closed]).then(
      ([{ code, signal }]) => fail(current, `git exited with ${signal ?? code}`),
      (err: unknown) => fail(current, err instanceof Error ? err.message : String(err)),
    );
    return current;
  };

  const request = (current: Batch, spec: string): Promise<BatchAnswer | undefined> =>
    new Promise((resolve) => {
      current.waiting.push(resolve);
      current.process.write(`${spec}\n`);
    });

  return {
    async read(commit, relativePath) {
      if (closed || !isHexCommit(commit)) return UNAVAILABLE;
      // the batch protocol is one request per line
      if (/[\r\n]/.test(relativePath)) return checkpointCommitFile(repoDir, commit, relativePath);
      const current = (batch ??= start());
      if (!current) return UNAVAILABLE;
      // `<commit>:<path> missing` also answers an unknown commit, so each commit is checked once for `absent` to mean the path
      let present = current.commits.get(commit);
      if (!present) {
        present = request(current, `${commit}^{commit}`).then((found) => {
          if (found?.kind !== 'ambiguous') return found === undefined ? undefined : found.kind === 'object';
          log('[session-store] checkpoint %s names several objects in %s', commit, repoDir);
          return undefined;
        });
        current.commits.set(commit, present);
      }
      const [inRepo, blob] = await Promise.all([present, request(current, `${commit}:${relativePath}`)]);
      if (inRepo === undefined || blob === undefined || blob.kind === 'ambiguous') return UNAVAILABLE;
      if (!inRepo) {
        log('[session-store] checkpoint %s is not in %s', commit, repoDir);
        return UNAVAILABLE;
      }
      if (blob.kind === 'missing') return { kind: 'absent' };
      if (blob.type !== 'blob') return UNAVAILABLE;
      return blob.bytes === undefined ? { kind: 'tooLarge' } : classifyFileBytes(blob.bytes);
    },
    async close() {
      closed = true;
      const current = batch;
      if (!current) return;
      // git answers what it was asked, then exits at the end of its input
      current.process.end();
      await current.process.closed.catch(() => undefined);
    },
  };
}

/** The blob readers of one recompute, one per checkpoint repo it reads, each started on its first read. */
export interface BlobReaders {
  read(repoDir: string, commit: string, relativePath: string): Promise<CheckpointFileRead>;
  close(): Promise<void>;
}

export function createBlobReaders(launcher?: Launcher): BlobReaders {
  const readers = new Map<string, BlobReader>();
  let closed = false;
  return {
    read(repoDir, commit, relativePath) {
      if (closed) return Promise.resolve(UNAVAILABLE);
      let reader = readers.get(repoDir);
      if (!reader) {
        reader = openBlobReader(repoDir, launcher);
        readers.set(repoDir, reader);
      }
      return reader.read(commit, relativePath);
    },
    async close() {
      closed = true;
      await Promise.all([...readers.values()].map((reader) => reader.close()));
    },
  };
}
