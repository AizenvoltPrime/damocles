// The `sessions` step (docs/invariants.md "Project relocation"): moves the old folder's session files and their data from
// piSessionDir(from) to piSessionDir(to). Every filesystem call goes through `deps`, and every item's progress is read from
// disk, so a run stopped at any call and run again ends as an uninterrupted run does.
import * as path from 'node:path';
import { isSafeAgentPathId } from '../../../shared/agent-path-id';
import { getRepoDir } from '../../pi-session/checkpoints/resolver';
import { piSessionIdFromFile } from '../../pi-session/session-store/meta-index/protocol';
import { legacySubagentTranscriptDir } from '../../pi-session/session-store/mutations';
import { piSessionDir } from '../../pi-session/session-store/session-dir';
import { piSessionFileId } from '../../pi-session/session-store/session-file-path';
import type { SessionWriteRefusal } from '../../pi-session/session-store/session-lease';
import { folderKey } from '../../workspace-folders/folder-key';
import { pausedBy, RelocationPause, STEP_DONE, type StepOutcome } from './outcome';

export interface SessionsStepStat {
  isFile(): boolean;
  isDirectory(): boolean;
  /** The file's identity on its volume (device and inode): two spellings of one file share it; undefined where the volume has none. */
  readonly id: string | undefined;
}

/** A path a session file recorded, and when (epoch ms; undefined when the entry's timestamp does not parse). */
export interface RecordedPath {
  readonly path: string;
  readonly recordedAt: number | undefined;
}

export interface SessionsStepDeps {
  /** Entry names; rejects with ENOENT for a missing dir. */
  readdir(dir: string): Promise<string[]>;
  /** undefined when nothing is at the path. */
  lstat(p: string): Promise<SessionsStepStat | undefined>;
  /** The header's cwd and time. */
  readHeader(file: string): Promise<RecordedPath | undefined>;
  /** The project the session's latest `damocles.worktree` entry names, and that entry's time. */
  readWorktreeProject(file: string): Promise<RecordedPath | undefined>;
  readFile(file: string): Promise<Buffer>;
  /** Recursive. */
  mkdir(dir: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Keeps the source's times, so the moved file's index row still matches it. */
  copyFile(from: string, to: string): Promise<void>;
  fsync(file: string): Promise<void>;
  /** Makes a rename into `dir` durable; a no-op where directories cannot be synced (Windows). */
  fsyncDir(dir: string): Promise<void>;
  /** One file; nothing there is fine. */
  rm(file: string): Promise<void>;
  /** An empty dir only; a missing or non-empty one is left as it is. */
  rmdir(dir: string): Promise<void>;
  moveLegacyRepo(fromDir: string, toDir: string): Promise<void>;
  moveMetaRow(fromFile: string, toFile: string): Promise<void>;
  /** The session's registrations in the folder checkpoint repos its file names, each under that repo's lock. */
  repointRegistrations(sessionId: string, fromFile: string, toFile: string): Promise<void>;
  writeUnderLease(sessionId: string, work: () => Promise<void>): Promise<SessionWriteRefusal | undefined>;
  /** Whether a run of this process holds agent data under `dir`: an agent file it owns, one pi has not written yet included, or a team it has not settled. */
  agentRunsUnder(dir: string): Promise<boolean>;
}

export interface SessionsStepInput {
  readonly from: string;
  readonly to: string;
  /** The relocation's projects by their old paths: a session moves only when one of them owns it (ownedSessions). */
  readonly owners: readonly string[];
  /** Where a folder recorded then is now by the relocations before this one: a header naming A owns a file A→B left in B's dir. */
  readonly currentPathOf: (folder: string, recordedAt: number | undefined) => string;
  /** pi's agent dir, whose sessions folder holds every session dir. */
  readonly agentDir?: string;
  /** After each session's commit; `remaining` counts the old folder's sessions this run found. May throw RelocationPause. */
  readonly onCommitted?: (moved: number, remaining: number) => Promise<void> | void;
  readonly log: (line: string) => void;
}

export const SESSION_FILE: RegExp = /^[^.].*_[^_]+\.jsonl$/;

export async function runSessionsStep(input: SessionsStepInput, deps: SessionsStepDeps): Promise<StepOutcome> {
  const oldDir = input.agentDir === undefined ? piSessionDir(input.from) : piSessionDir(input.from, input.agentDir);
  const newDir = input.agentDir === undefined ? piSessionDir(input.to) : piSessionDir(input.to, input.agentDir);
  if (folderKey(oldDir) === folderKey(newDir)) return STEP_DONE;
  try {
    const owned = await ownedSessions(input.owners, input.currentPathOf, deps, oldDir);
    let moved = 0;
    for (const name of owned) {
      const sessionId = piSessionIdFromFile(name);
      const refusal = await deps.writeUnderLease(sessionId, () => moveSession(input, deps, oldDir, newDir, name, sessionId));
      if (refusal) return { kind: 'paused', failure: { code: 'locked', params: { sessionId } } };
      moved++;
      await input.onCommitted?.(moved, owned.length);
    }
    await deps.rmdir(oldDir);
    return STEP_DONE;
  } catch (err) {
    if (!(err instanceof RelocationPause)) input.log(`[ProjectRelocations] sessions step stopped: ${err instanceof Error ? err.message : String(err)}`);
    return pausedBy(err);
  }
}

// The session file names in oldDir that one of `owners` owns. A session is the project's its latest worktree entry names, else
// the folder's its header names (docs/invariants.md "Worktree chats", Ownership), each mapped as of that entry's time, so a chat
// worktree's dir keeps the chats of any other project, and a colliding folder's (C:\a-b\c and C:\a\b-c share one encoded dir)
// stay too.
export async function ownedSessions(
  owners: readonly string[],
  currentPathOf: (folder: string, recordedAt: number | undefined) => string,
  deps: Pick<SessionsStepDeps, 'readdir' | 'lstat' | 'readHeader' | 'readWorktreeProject'>,
  oldDir: string,
): Promise<string[]> {
  let names: string[];
  try {
    names = await deps.readdir(oldDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const ownerKeys = new Set(owners.map(folderKey));
  const owned: string[] = [];
  for (const name of names.filter((n) => SESSION_FILE.test(n)).sort()) {
    if (!isSafeAgentPathId(piSessionIdFromFile(name))) continue;
    const file = path.join(oldDir, name);
    if (!(await deps.lstat(file))?.isFile()) continue;
    const owner = (await deps.readWorktreeProject(file)) ?? (await deps.readHeader(file));
    if (owner !== undefined && ownerKeys.has(folderKey(currentPathOf(owner.path, owner.recordedAt)))) owned.push(name);
  }
  return owned;
}

// The session file goes last: it is the commit point, and once it is in the new dir nothing of it is left in the old one.
async function moveSession(input: SessionsStepInput, deps: SessionsStepDeps, oldDir: string, newDir: string, name: string, sessionId: string): Promise<void> {
  const oldFile = path.join(oldDir, name);
  const newFile = path.join(newDir, name);
  await moveAgentData(deps, path.join(oldDir, sessionId), path.join(newDir, sessionId), sessionId);
  // The legacy encoding drops the drive, so C:\p and D:\p share one legacy dir, which then stays where it is.
  const oldLegacy = legacySubagentTranscriptDir(input.from, sessionId);
  const newLegacy = legacySubagentTranscriptDir(input.to, sessionId);
  if (folderKey(oldLegacy) !== folderKey(newLegacy)) {
    await mergeTree(deps, oldLegacy, newLegacy);
    await deps.rmdir(path.dirname(oldLegacy));
  }
  const oldRepo = getRepoDir(oldFile);
  const newRepo = getRepoDir(newFile);
  if (await deps.lstat(oldRepo)) {
    if (await deps.lstat(newRepo)) throw new RelocationPause({ code: 'conflict', params: { path: newRepo } });
    await deps.moveLegacyRepo(oldRepo, newRepo);
  }
  await deps.rmdir(path.dirname(oldRepo));
  // Carried before the commit, since a rerun no longer finds a committed file in the old dir.
  await moveFile(deps, oldFile, newFile, async () => {
    await deps.repointRegistrations(sessionId, oldFile, newFile);
    await deps.moveMetaRow(oldFile, newFile);
  });
}

/**
 * The pi session ids of the agent files in a chat's agent data at `root` (agent-records.ts): its subagents' and its team
 * members'. Each keys the file's own lease.
 */
export async function agentSessionIds(deps: Pick<SessionsStepDeps, 'readdir' | 'lstat'>, root: string): Promise<string[]> {
  const names = async (dir: string): Promise<string[]> => deps.readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  });
  const dirs = [path.join(root, 'subagents')];
  const teams = path.join(root, 'teams');
  for (const team of await names(teams)) {
    if ((await deps.lstat(path.join(teams, team)))?.isDirectory()) dirs.push(path.join(teams, team, 'members'));
  }
  const ids = new Set<string>();
  for (const dir of dirs) {
    for (const name of await names(dir)) {
      const id = piSessionFileId(name);
      if (id !== undefined) ids.add(id);
    }
  }
  return [...ids].sort();
}

// An agent file belongs to its run until the run settles, a stopped run that outlived its panel included, and a team run
// appends its event log by path (docs/invariants.md "Teams and subagents"). So the tree moves only while no run holds a part
// of it, under the lease of every agent file in it, which keeps a run from opening one until the move is done.
async function moveAgentData(deps: SessionsStepDeps, srcDir: string, dstDir: string, sessionId: string): Promise<void> {
  const running = (): RelocationPause => new RelocationPause({ code: 'agentRunning', params: { sessionId } });
  const underLeases = async (ids: readonly string[]): Promise<void> => {
    const [id, ...rest] = ids;
    if (id === undefined) {
      if (await deps.agentRunsUnder(srcDir)) throw running();
      await mergeTree(deps, srcDir, dstDir);
      return;
    }
    if (await deps.writeUnderLease(id, () => underLeases(rest))) throw running();
  };
  await underLeases(await agentSessionIds(deps, srcDir));
}

/**
 * Moves `src` to `dst`, nothing when `src` is already gone. A source is removed only once `dst` holds its bytes.
 * `beforeCommit` runs once the move is decided, before the step that makes it.
 */
async function moveFile(deps: SessionsStepDeps, src: string, dst: string, beforeCommit?: () => Promise<void>): Promise<void> {
  const temp = path.join(path.dirname(dst), `.${path.basename(dst)}.relocating`);
  const source = await deps.lstat(src);
  if (!source) {
    await deps.rm(temp);
    return;
  }
  const target = await deps.lstat(dst);
  if (target) {
    // One file under two spellings: there is nothing to move, and removing the source would remove it.
    if (target.id !== undefined && target.id === source.id) return;
    if (!(await identical(deps, src, dst))) throw new RelocationPause({ code: 'conflict', params: { path: dst } });
    await beforeCommit?.();
    await deps.rm(src);
    return;
  }
  await deps.mkdir(path.dirname(dst));
  await beforeCommit?.();
  try {
    await deps.rename(src, dst);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  await deps.copyFile(src, temp);
  await deps.fsync(temp);
  await deps.rename(temp, dst);
  await deps.fsyncDir(path.dirname(dst));
  await deps.rm(src);
}

async function identical(deps: SessionsStepDeps, a: string, b: string): Promise<boolean> {
  return (await deps.readFile(a)).equals(await deps.readFile(b));
}

/** Moves the tree at `srcDir` into `dstDir`: whole when `dstDir` is new, else file by file, an identical file dropped. */
async function mergeTree(deps: SessionsStepDeps, srcDir: string, dstDir: string): Promise<void> {
  const src = await deps.lstat(srcDir);
  if (!src) return;
  if (!src.isDirectory()) throw new RelocationPause({ code: 'conflict', params: { path: srcDir } });
  const dst = await deps.lstat(dstDir);
  if (dst?.id !== undefined && dst.id === src.id) return;
  if (!dst) {
    await deps.mkdir(path.dirname(dstDir));
    try {
      await deps.rename(srcDir, dstDir);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    }
  }
  for (const name of await deps.readdir(srcDir)) {
    const from = path.join(srcDir, name);
    const to = path.join(dstDir, name);
    const stat = await deps.lstat(from);
    if (!stat) continue;
    if (stat.isDirectory()) await mergeTree(deps, from, to);
    else if (stat.isFile()) await moveFile(deps, from, to);
    else throw new RelocationPause({ code: 'conflict', params: { path: from } });
  }
  await deps.rmdir(srcDir);
}
