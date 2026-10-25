// The daemon side of control.mirror.sync: the project's session, agent and team files under its pi
// session folder, newest first within the client's budget. The daemon opens only files it listed itself; a name the
// client sends is only compared with that listing, never joined to a path.
import { createHash } from 'node:crypto';
import { promises as fs, type Dirent } from 'node:fs';
import * as path from 'node:path';
import { piSessionDir } from '../../core/pi-session/session-store/session-dir';
import type { MirrorChange, MirrorFile } from './control-messages';

// the head hash covers the first 4 KiB, the tail hash the 4 KiB before the client's size
export const HASH_SPAN_BYTES = 4096;
const READ_CHUNK_BYTES = 256 * 1024;

export interface ListedFile {
  // relative to the session folder, '/'-separated
  readonly file: string;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface MirrorStream {
  readonly id: number;
  // the connection is gone; closing fires onDrain
  readonly closed: boolean;
  write(bytes: Uint8Array): boolean;
  end(): void;
  onDrain(listener: () => void): void;
}

export interface MirrorServerDeps {
  // the pi agent folder whose sessions/ holds every project's session folder
  readonly agentDir: string;
  // a stream id for the answer, and the stream under it once its bytes go out
  readonly reserveStream: () => number;
  readonly openStream: (reserved: number) => MirrorStream;
  // settles once every frame queued before the call went out (Mux.drained)
  readonly drained: () => Promise<void>;
  readonly log: (line: string) => void;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Every regular file under the folder, links never followed.
async function listFiles(root: string): Promise<ListedFile[]> {
  const out: ListedFile[] = [];
  const walk = async (folder: string, relative: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(folder, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const file = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full, file);
      else if (entry.isFile()) {
        const stat = await fs.lstat(full);
        out.push({ file, path: full, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  await walk(root, '');
  return out;
}

async function readRange(filePath: string, offset: number, length: number): Promise<Uint8Array> {
  const handle = await fs.open(filePath, 'r');
  try {
    const bytes = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(bytes, filled, length - filled, offset + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return bytes.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

/** The project's session folder; on Windows a folder key is case-folded, so the folder whose name matches it ignoring case. */
export async function sessionFolder(agentDir: string, projectKey: string): Promise<string> {
  const exact = piSessionDir(projectKey, agentDir);
  if (process.platform !== 'win32') return exact;
  const parent = path.dirname(exact);
  const wanted = path.basename(exact).toLowerCase();
  let names: string[];
  try {
    names = await fs.readdir(parent);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return exact;
    throw err;
  }
  const found = names.find((name) => name.toLowerCase() === wanted);
  return found === undefined ? exact : path.join(parent, found);
}

// append when the client's head and tail still match the file, else the whole file
async function changeFor(listed: ListedFile, held: MirrorFile | undefined): Promise<{ kind: 'append' | 'full'; offset: number } | undefined> {
  if (!held || held.size > listed.size) return { kind: 'full', offset: 0 };
  const head = await readRange(listed.path, 0, Math.min(HASH_SPAN_BYTES, held.size));
  const tailStart = Math.max(0, held.size - HASH_SPAN_BYTES);
  const tail = await readRange(listed.path, tailStart, held.size - tailStart);
  if (sha256(head) !== held.headHash || sha256(tail) !== held.tailHash) return { kind: 'full', offset: 0 };
  return held.size === listed.size ? undefined : { kind: 'append', offset: held.size };
}

// A file that shrank meanwhile ends its stream short of length; the client then holds an incomplete copy and resyncs it.
async function pump(stream: MirrorStream, filePath: string, offset: number, length: number): Promise<void> {
  try {
    for (let at = 0; at < length; at += READ_CHUNK_BYTES) {
      const bytes = await readRange(filePath, offset + at, Math.min(READ_CHUNK_BYTES, length - at));
      if (bytes.length === 0) break;
      if (stream.write(bytes)) continue;
      if (stream.closed) return;
      await new Promise<void>((resolve) => stream.onDrain(resolve));
    }
  } finally {
    stream.end();
  }
}

export async function syncMirror(deps: MirrorServerDeps, request: { readonly projectKey: string; readonly budgetBytes: number; readonly files: readonly MirrorFile[] }): Promise<{ changes: MirrorChange[] }> {
  const root = await sessionFolder(deps.agentDir, request.projectKey);
  const listed = (await listFiles(root)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const kept: ListedFile[] = [];
  let used = 0;
  for (const file of listed) {
    if (used + file.size > request.budgetBytes) continue;
    kept.push(file);
    used += file.size;
  }
  const held = new Map(request.files.map((file) => [file.file, file]));
  const keptNames = new Set(kept.map((file) => file.file));
  const changes: MirrorChange[] = [];
  const sends: Array<() => Promise<void>> = [];
  for (const file of kept) {
    const change = await changeFor(file, held.get(file.file));
    if (!change) continue;
    const length = file.size - change.offset;
    const id = deps.reserveStream();
    changes.push({ file: file.file, kind: change.kind, offset: change.offset, length, stream: id });
    // one stream open at a time, however many files change
    sends.push(async () => pump(deps.openStream(id), file.path, change.offset, length));
  }
  for (const file of request.files) if (!keptNames.has(file.file)) changes.push({ file: file.file, kind: 'deleted', offset: 0, length: 0, stream: 0 });
  const failed = (err: unknown): void => deps.log(`[mirror] sending a file failed: ${err instanceof Error ? err.message : String(err)}`);
  const sendAll = (): Promise<void> => sends.reduce((chain, send) => chain.then(() => send().catch(failed)), Promise.resolve());
  // the endpoint queues the answer in the microtasks after this resolves, so the streams open once it went out
  setImmediate(() => void deps.drained().then(sendAll));
  return { changes };
}
