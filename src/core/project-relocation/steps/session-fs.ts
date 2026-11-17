// The sessions step's filesystem, on Node's fs; tests replace it to stop the step at any call.
import * as fs from 'node:fs';
import { renameWithRetry } from '../../config/json-config-write';
import { agentFilesOwnedUnder } from '../../pi-session/agent-file-owner';
import { moveLegacyCheckpointRepo, repointSessionRegistrations } from '../../pi-session/checkpoints';
import type { SessionMetaIndex } from '../../pi-session/session-store/meta-index/client';
import { writeUnderSessionLease } from '../../pi-session/session-store/session-lease';
import { isTeamRunningUnder } from '../../team';
import { readLatestWorktreeEntry } from '../../worktrees/hand-off';
import { entryTimeOf } from '../../worktrees/worktree-entry';
import type { RecordedPath, SessionsStepDeps } from './sessions';

// A pi header line is a few hundred bytes; a first line longer than this is no header.
const HEADER_READ_BYTES = 64 * 1024;

function ignoring(...codes: string[]): (err: NodeJS.ErrnoException) => void {
  return (err) => {
    if (err.code === undefined || !codes.includes(err.code)) throw err;
  };
}

export async function readHeader(file: string): Promise<RecordedPath | undefined> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const end = text.indexOf('\n');
    let header: unknown;
    try {
      header = JSON.parse(end === -1 ? text : text.slice(0, end));
    } catch {
      return undefined;
    }
    const record = header as { type?: unknown; cwd?: unknown } | null;
    return record?.type === 'session' && typeof record.cwd === 'string' ? { path: record.cwd, recordedAt: entryTimeOf(record) } : undefined;
  } finally {
    await handle.close();
  }
}

/** Whether a run of this process holds agent data under `dir` (SessionsStepDeps.agentRunsUnder). */
export function agentRunsUnder(dir: string): boolean {
  return agentFilesOwnedUnder(dir) || isTeamRunningUnder(dir);
}

export function defaultSessionsStepDeps(index: Pick<SessionMetaIndex, 'move'>): SessionsStepDeps {
  return {
    readdir: (dir) => fs.promises.readdir(dir),
    lstat: (p) => fs.promises.lstat(p, { bigint: true }).then(
      // Some network and FUSE volumes report inode 0 for every file, which identifies nothing.
      (stat) => ({ isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory(), id: stat.ino === 0n ? undefined : `${stat.dev}:${stat.ino}` }),
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined;
        throw err;
      },
    ),
    readHeader,
    readWorktreeProject: async (file) => {
      const latest = await readLatestWorktreeEntry(file);
      return latest && { path: latest.data.projectPath, recordedAt: latest.recordedAt };
    },
    readFile: (file) => fs.promises.readFile(file),
    mkdir: async (dir) => {
      await fs.promises.mkdir(dir, { recursive: true });
    },
    rename: (from, to) => renameWithRetry(from, to),
    copyFile: async (from, to) => {
      await fs.promises.copyFile(from, to);
      const stat = await fs.promises.stat(from);
      await fs.promises.utimes(to, stat.atime, stat.mtime);
    },
    fsync: async (file) => {
      const handle = await fs.promises.open(file, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    fsyncDir: async (dir) => {
      if (process.platform === 'win32') return;
      const handle = await fs.promises.open(dir, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    rm: (file) => fs.promises.unlink(file).catch(ignoring('ENOENT')),
    rmdir: (dir) => fs.promises.rmdir(dir).catch(ignoring('ENOENT', 'ENOTEMPTY', 'EEXIST')),
    moveLegacyRepo: (fromDir, toDir) => moveLegacyCheckpointRepo(fromDir, toDir, renameWithRetry),
    moveMetaRow: async (fromFile, toFile) => index.move(fromFile, toFile),
    repointRegistrations: repointSessionRegistrations,
    writeUnderLease: (sessionId, work) => writeUnderSessionLease(sessionId, work),
    agentRunsUnder: async (dir) => agentRunsUnder(dir),
  };
}
