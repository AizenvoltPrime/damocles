import * as fs from 'fs';
import * as path from 'path';
import { execSafe } from './exec';
import { checkpointGitAvailability } from './git-availability';
import { withRepoLock } from './lock';
import { getCheckpointsBaseDir, getFolderReposBaseDir, getGitDir, getIndexPath, isFolderId } from './resolver';
import { SESSION_REFS_ROOT, dropSessionRefsLocked, readSessionRegistration, reconcilePendingCopiesLocked, sessionIdOfRef } from './folder-repo';
import { RepoManager } from './repo-manager';
import { forceRemoveDir } from '../fs-remove';
import { log } from '../../logger';

/**
 * Tuning inputs for a maintenance sweep. Tests inject an explicit `baseDir`, a zero `throttleMs` to
 * force a sweep, and a deterministic `now`. `retentionDays` is present now but unused in Slice 1;
 * Slice 2 adds the age eviction that consumes it.
 */
export interface CheckpointMaintenanceOptions {
  baseDir?: string;
  foldersBaseDir?: string;
  retentionDays?: number;
  throttleMs?: number;
  now?: () => number;
}

/** Tally of what one sweep did. `skippedByThrottle` and the `repos*` counts describe the per-session repos. */
export interface CheckpointMaintenanceSummary {
  skippedByThrottle: boolean;
  reposRepacked: number;
  reposEvicted: number;
  failures: number;
  folderReposCollected: number;
  sessionRefsEvicted: number;
  orphanSessionsPruned: number;
}

/** A registration or fork copy can precede its session file, so missing-file refs are an orphan only once the newest ref or registration is past this age. */
export const ORPHAN_SESSION_GRACE_MS: number = 24 * 3_600_000;

/** Default throttle window: a sweep that ran under 20 hours ago is skipped, so the 24h interval fires cleanly. */
const DEFAULT_THROTTLE_MS = 20 * 3_600_000;

/** Marker file whose mtime records when the last sweep claimed the base directory. */
const MARKER_NAME = '.last-maintenance';

/** Entry names in the base directory that are our own state, never a repo to maintain. */
const RESERVED_ENTRIES = new Set([MARKER_NAME, '.checkpoint-lock']);

function zeroSummary(): CheckpointMaintenanceSummary {
  return {
    skippedByThrottle: false,
    reposRepacked: 0,
    reposEvicted: 0,
    failures: 0,
    folderReposCollected: 0,
    sessionRefsEvicted: 0,
    orphanSessionsPruned: 0,
  };
}

/**
 * Best-effort timestamp of a per-session repo's last write activity. The reflog `logs/HEAD` was appended
 * on every checkpoint commit such a repo received, so its mtime tracks its last checkpoint write. Falls back to the `.git` directory mtime for
 * a repo that has a `.git` but never committed, and returns null when nothing is statable.
 *
 * The fallback stats the `.git` directory rather than the repo directory on purpose: eviction runs
 * inside `withRepoLock`, and acquiring that lock creates the `.checkpoint-lock` subdirectory inside
 * the repo directory, which bumps the repo directory's mtime to now. The `.git` directory is a sibling
 * of the lock directory, so the lock never pollutes its mtime, and it is where every real checkpoint
 * write lands.
 */
async function lastActivityMs(repoDir: string): Promise<number | null> {
  const gitDir = getGitDir(repoDir);
  try {
    return (await fs.promises.stat(path.join(gitDir, 'logs', 'HEAD'))).mtimeMs;
  } catch {
    try {
      return (await fs.promises.stat(gitDir)).mtimeMs;
    } catch {
      return null;
    }
  }
}

/**
 * Non-destructively repack every per-session checkpoint repo under the sessions base, throttled so it
 * runs at most once per window. Mirrors `pruneOrphanCheckpointRepos`: it NEVER throws, a missing or
 * empty base directory is a side-effect-free no-op (nothing is created), and a single repo's failure
 * is counted and stepped over rather than aborting the sweep.
 *
 * Flow: probe that git exists, check the throttle, read the base for repos and bail if there is none,
 * claim the throttle marker, then repack (and, when enabled, age evict) each repo under its repo lock.
 */
export async function runCheckpointMaintenance(
  options?: CheckpointMaintenanceOptions,
): Promise<CheckpointMaintenanceSummary> {
  // Git absent: nothing to maintain and no way to repack, so surface a clean zero summary.
  if (!(await checkpointGitAvailability()).available) return zeroSummary();
  const sessions = await sweepSessionRepos(options);
  const folders = await sweepFolderRepos(options).catch((err: unknown): FolderSweepSummary => {
    log('[Checkpoints] folder maintenance sweep failed: %O', err);
    return { folderReposCollected: 0, sessionRefsEvicted: 0, orphanSessionsPruned: 0, failures: 1 };
  });
  return { ...sessions, ...folders, failures: sessions.failures + folders.failures };
}

type FolderSweepSummary = Pick<CheckpointMaintenanceSummary, 'folderReposCollected' | 'sessionRefsEvicted' | 'orphanSessionsPruned' | 'failures'>;

/**
 * The shared folder repos, throttled by their own marker: per repo, under its lock, delete each
 * conversation's refs once its newest checkpoint is older than `retentionDays` or it is an orphan
 * (registered session file gone, past `ORPHAN_SESSION_GRACE_MS`) and pack the refs; then repack
 * without the lock, and prune under it again. A pre-rewind snapshot's refs sit in the same namespace,
 * so they age out with the conversation's checkpoints. A folder repo is never
 * removed as a whole, and a conversation is only ever judged by its own refs and registration.
 */
async function sweepFolderRepos(options: CheckpointMaintenanceOptions | undefined): Promise<FolderSweepSummary> {
  const summary: FolderSweepSummary = { folderReposCollected: 0, sessionRefsEvicted: 0, orphanSessionsPruned: 0, failures: 0 };
  const baseDir = options?.foldersBaseDir ?? getFolderReposBaseDir();
  const now = options?.now ?? Date.now;
  const throttleMs = options?.throttleMs ?? DEFAULT_THROTTLE_MS;
  const marker = path.join(baseDir, MARKER_NAME);
  try {
    if (now() - (await fs.promises.stat(marker)).mtimeMs < throttleMs) return summary;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  let names: string[];
  try {
    names = (await fs.promises.readdir(baseDir, { withFileTypes: true })).filter((d) => d.isDirectory() && isFolderId(d.name)).map((d) => d.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return summary;
    throw err;
  }
  if (names.length === 0) return summary;
  await fs.promises.writeFile(marker, new Date(now()).toISOString());

  const retentionDays = options?.retentionDays;
  const retentionMs =
    typeof retentionDays === 'number' && Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays * 86_400_000 : null;
  for (const folderId of names) {
    const repoDir = path.join(baseDir, folderId);
    if (!fs.existsSync(path.join(getGitDir(repoDir), 'HEAD'))) continue;
    // The work tree is never read here, and the folder it names may be gone.
    const handle = { folderId, repoDir, repo: new RepoManager(getGitDir(repoDir), getIndexPath(repoDir), repoDir) };
    try {
      await handle.repo.withLock(async () => {
        await reconcilePendingCopiesLocked(handle);
        const newestBySession = new Map<string, number>();
        for (const { ref, committedAt } of await handle.repo.listRefs(SESSION_REFS_ROOT)) {
          const sessionId = sessionIdOfRef(ref);
          if (sessionId) newestBySession.set(sessionId, Math.max(newestBySession.get(sessionId) ?? 0, committedAt * 1000));
        }
        for (const [sessionId, newestMs] of newestBySession) {
          const registration = await readSessionRegistration(repoDir, sessionId);
          // A fork's inherited refs carry the parent's commit dates, so its registration dates it too.
          const age = now() - Math.max(newestMs, registration?.registeredAtMs ?? 0);
          if (retentionMs !== null && age > retentionMs) {
            await dropSessionRefsLocked(handle, sessionId);
            summary.sessionRefsEvicted++;
            continue;
          }
          if (registration !== null && age > ORPHAN_SESSION_GRACE_MS && !fs.existsSync(registration.sessionFile)) {
            await dropSessionRefsLocked(handle, sessionId);
            summary.orphanSessionsPruned++;
          }
        }
        await handle.repo.prepareCollection();
      });
      // Only the prune deletes objects, and it runs under the lock (docs/invariants.md, "Checkpoints").
      await handle.repo.repackAll();
      await handle.repo.withLock(async () => {
        await reconcilePendingCopiesLocked(handle);
        await handle.repo.pruneUnreachable();
      });
      summary.folderReposCollected++;
    } catch (err) {
      summary.failures++;
      log('[Checkpoints] maintenance of folder repo %s failed: %O', folderId, err);
    }
  }
  log(
    `[Checkpoints] folder maintenance: collected=${summary.folderReposCollected} sessionsEvicted=${summary.sessionRefsEvicted} orphansPruned=${summary.orphanSessionsPruned} failures=${summary.failures}`,
  );
  return summary;
}

/** The per-session repos: repack, and evict a whole repo by age. Never prunes an object. */
async function sweepSessionRepos(
  options: CheckpointMaintenanceOptions | undefined,
): Promise<CheckpointMaintenanceSummary> {
  const baseDir = options?.baseDir ?? getCheckpointsBaseDir();
  const now = options?.now ?? Date.now;
  const throttleMs = options?.throttleMs ?? DEFAULT_THROTTLE_MS;
  const marker = path.join(baseDir, MARKER_NAME);

  // Throttle at the start: if a recent sweep already ran, skip. We compare the marker's mtimeMs rather
  // than its contents, so a marker touched by any means still throttles. A stat failure means the
  // marker is absent, so we proceed and (once we confirm there is work) write the marker before
  // walking, so a later trigger in THIS process (the 24h timer firing during a slow sweep) short
  // circuits. This is a throttle, not a cross-process mutex: two windows starting within the window
  // can both pass it. Concurrent double work is bounded elsewhere, by the per-repo lock (each repo is
  // maintained by one process at a time) and by repack idempotence.
  try {
    const stat = await fs.promises.stat(marker);
    if (now() - stat.mtimeMs < throttleMs) {
      return { ...zeroSummary(), skippedByThrottle: true };
    }
  } catch {
    // Marker absent (or unreadable): fall through and sweep.
  }

  const summary = zeroSummary();

  // Read the base BEFORE writing anything. A base directory that does not exist means no session has
  // ever checkpointed (or checkpointing is off with nothing left behind), and an empty one means every
  // repo was already reclaimed: in both cases return without creating the directory or a marker, so an
  // install with no checkpoint history stays untouched. Only once we know there is something to walk do
  // we claim the throttle marker.
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
  } catch {
    return summary;
  }
  if (entries.length === 0) return summary;

  // Claim the throttle marker now that the base exists and has entries. The readdir succeeded, so the
  // base is already present and no mkdir is needed. The content is a human readable ISO timestamp for
  // diagnostics only; the file's mtime remains the throttle's source of truth.
  await fs.promises.writeFile(marker, new Date(now()).toISOString()).catch(() => undefined);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (RESERVED_ENTRIES.has(entry.name)) continue;
    const entryPath = path.join(baseDir, entry.name);

    // A directory that itself holds a `.git` is a repo directly (the `ephemeral` slot and legacy flat
    // repos). Otherwise it is a per-workspace container whose immediate children are the repos.
    if (fs.existsSync(getGitDir(entryPath))) {
      await maintainRepo(entryPath, options, summary, now);
      continue;
    }

    let subEntries: fs.Dirent[];
    try {
      subEntries = await fs.promises.readdir(entryPath, { withFileTypes: true });
    } catch {
      // Unreadable container: skip it. A readdir failure is not a repo op, so it is not a failure.
      continue;
    }
    for (const sub of subEntries) {
      if (!sub.isDirectory()) continue;
      if (RESERVED_ENTRIES.has(sub.name)) continue;
      const repoDir = path.join(entryPath, sub.name);
      if (fs.existsSync(getGitDir(repoDir))) {
        await maintainRepo(repoDir, options, summary, now);
      }
    }
  }

  log(
    `[Checkpoints] maintenance sweep: repacked=${summary.reposRepacked} evicted=${summary.reposEvicted} failures=${summary.failures}`,
  );
  return summary;
}

/**
 * Maintain one repo under its lock. The WHOLE body, including lock acquisition, is wrapped so any
 * failure increments `summary.failures` and the sweep moves on; one broken repo never aborts the run.
 * Taking the lock means a sweep never interleaves with a live session's in-flight commit on the same
 * repo (both go through `withRepoLock`).
 */
async function maintainRepo(
  repoDir: string,
  options: CheckpointMaintenanceOptions | undefined,
  summary: CheckpointMaintenanceSummary,
  now: () => number,
): Promise<void> {
  try {
    await withRepoLock(repoDir, async () => {
      const gitDir = getGitDir(repoDir);
      // Not an initialized repo (no HEAD): nothing to repack.
      if (!fs.existsSync(path.join(gitDir, 'HEAD'))) return;

      // Age eviction runs here, before the repack and still inside the lock, because an evicted repo's
      // whole directory is deleted so repacking it first would be wasted work.
      //
      // The signal is checkpoint WRITE activity (reflog mtime, see lastActivityMs), not session
      // liveness. No code writes a per-session repo any more, so a repo is evicted once its last
      // checkpoint is past the cutoff, even while its conversation is open; the rewind read paths fail
      // soft to the live file, so the worst case is a degraded (never corrupt) diff for that session.
      //
      // Fail-safe (decision 9): a non positive, NaN, or non finite retentionDays disables eviction, so
      // everything is kept and still repacked.
      const retentionDays = options?.retentionDays;
      const evictionEnabled =
        typeof retentionDays === 'number' && Number.isFinite(retentionDays) && retentionDays > 0;
      if (evictionEnabled) {
        const last = await lastActivityMs(repoDir);
        if (last !== null && now() - last > retentionDays * 86_400_000) {
          await forceRemoveDir(repoDir); // handles read-only pack files git repack leaves on Windows
          summary.reposEvicted++;
          return; // doomed: never repack a repo we are about to delete
        }
      }

      // `git repack -A -d -l` is the ONLY object DB operation this sweep performs. The flags are load
      // bearing:
      //   -A (capital): fold all reachable objects into one pack AND turn objects that a previous pack
      //      held but are now unreachable into LOOSE objects rather than deleting them. Rewind
      //      addresses commits by hash, including commits made unreachable by a prior `reset --hard`,
      //      and reads them directly via `git show <hash>:<path>`. Lowercase `-a` would DELETE those
      //      unreachable objects and silently break rewind diff and restore, so it is forbidden.
      //   -d: drop the loose and pack files made redundant by the new pack.
      //   -l (--local): pack only our own objects and ignore those borrowed through
      //      objects/info/alternates, so a repack never copies the user's real repo object database
      //      into our pack. Without it, `-A` would pull the entire borrowed store in.
      // No gc, no prune, no reflog expiry anywhere: preservation of unreachable objects is the point.
      const result = await execSafe('git', [`--git-dir=${gitDir}`, 'repack', '-A', '-d', '-l']);
      if (result.ok) {
        summary.reposRepacked++;
      } else {
        summary.failures++;
      }
    });
  } catch {
    summary.failures++;
  }
}
