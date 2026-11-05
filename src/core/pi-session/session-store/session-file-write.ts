import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalPath } from '../../canonical-path';
import { folderKey } from '../../workspace-folders/folder-key';
import { agentFileHeldElsewhere, takeAgentFile } from '../agent-file-owner';
import { piSessionsRoot } from './session-dir';
import { sessionFileAt, type SessionFileKind } from './session-file-path';
import { writeUnderSessionLease } from './session-lease';

/** A file of this engine's session store, by its canonical path. */
export interface SessionFile extends SessionFileKind {
  readonly canonicalPath: string;
}

/** Why the engine did not write: a chat, a run or a write of this process holds the file, or another process holds its lease. */
export type SessionFileRefusal = 'held' | 'otherProcess';

export type SessionFileWrite =
  | { readonly kind: 'written'; readonly mtimeMs: number }
  // the file's bytes no longer hash to the ones the caller last read
  | { readonly kind: 'changed' }
  // the path no longer is its own canonical path, or no longer names a session file
  | { readonly kind: 'outside' }
  | { readonly kind: 'refused'; readonly reason: SessionFileRefusal };

/** The session file `filePath` names, classified by its canonical path against this engine's canonical sessions root. */
export function sessionFileOf(filePath: string): SessionFile | undefined {
  if (!path.isAbsolute(filePath)) return undefined;
  const canonical = canonicalPath(filePath);
  const found = sessionFileAt(canonical, canonicalPath(piSessionsRoot()));
  return found && { ...found, canonicalPath: canonical };
}

/**
 * Writes `bytes` over the session file at `filePath` only while its bytes hash to `expectedSha256` (null: only while it does not
 * exist): a chat's under its session lease, an agent's under its run ownership, so no live writer appends beside it.
 */
export async function writeSessionFile(filePath: string, bytes: Uint8Array, expectedSha256: string | null): Promise<SessionFileWrite> {
  const file = sessionFileOf(filePath);
  // the caller names the file by its canonical path; another answer means the path leads elsewhere now
  if (!file || folderKey(file.canonicalPath) !== folderKey(filePath)) return { kind: 'outside' };
  if (file.kind === 'agent') return writeAgentFile(file, bytes, expectedSha256);
  let written: SessionFileWrite = { kind: 'outside' };
  const refusal = await writeUnderSessionLease(file.sessionId, async () => {
    written = await writeIfUnchanged(file.canonicalPath, bytes, expectedSha256);
  });
  if (refusal) return { kind: 'refused', reason: refusal.kind === 'other-process' ? 'otherProcess' : 'held' };
  return written;
}

async function writeAgentFile(file: SessionFile, bytes: Uint8Array, expectedSha256: string | null): Promise<SessionFileWrite> {
  const store = { kind: 'file', dir: path.dirname(file.canonicalPath), id: file.sessionId } as const;
  if (agentFileHeldElsewhere(store)) return { kind: 'refused', reason: 'otherProcess' };
  // null while the run that opened the file has not settled; a run that resumes meanwhile waits for this write
  const owner = takeAgentFile(store);
  if (!owner) return { kind: 'refused', reason: 'held' };
  try {
    return await writeIfUnchanged(file.canonicalPath, bytes, expectedSha256);
  } finally {
    owner.release();
  }
}

// In place, so the file keeps its identity, and every byte lands before the truncate.
async function writeIfUnchanged(file: string, bytes: Uint8Array, expectedSha256: string | null): Promise<SessionFileWrite> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, expectedSha256 === null ? 'wx' : 'r+');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || (code === 'ENOENT' && expectedSha256 !== null)) return { kind: 'changed' };
    throw err;
  }
  try {
    if (expectedSha256 !== null && createHash('sha256').update(await handle.readFile()).digest('hex') !== expectedSha256) return { kind: 'changed' };
    for (let offset = 0; offset < bytes.length;) offset += (await handle.write(bytes, offset, bytes.length - offset, offset)).bytesWritten;
    await handle.truncate(bytes.length);
    await handle.sync();
    return { kind: 'written', mtimeMs: (await handle.stat()).mtimeMs };
  } finally {
    await handle.close();
  }
}
