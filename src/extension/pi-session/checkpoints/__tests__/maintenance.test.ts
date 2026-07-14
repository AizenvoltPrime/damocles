import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepoManager } from '../repo-manager';
import { getGitDir, getIndexPath } from '../resolver';
import { withRepoLock } from '../lock';
import { runCheckpointMaintenance } from '../maintenance';

/** Roots created by tests, cleaned up in afterEach. */
const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cp-maint-'));
  roots.push(root);
  return root;
}

/**
 * Build a checkpoint repo at `<base>/<ws>/<repo>` with a real bare git repo whose work tree is a
 * sibling directory, mirroring the production `<base>/<encoded-cwd>/<sessionBasename>` layout.
 */
async function makeRepo(base: string, ws: string, repoName: string): Promise<{ repoDir: string; workTree: string; repo: RepoManager }> {
  const repoDir = path.join(base, ws, repoName);
  const workTree = path.join(base, `${ws}__work`, repoName);
  await fs.promises.mkdir(repoDir, { recursive: true });
  await fs.promises.mkdir(workTree, { recursive: true });
  const repo = new RepoManager(getGitDir(repoDir), getIndexPath(repoDir), workTree);
  await repo.ensureReady(['.git']);
  return { repoDir, workTree, repo };
}

function writeWork(workTree: string, rel: string, content: string): void {
  const full = path.join(workTree, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

/** Count loose objects: files under `<gitDir>/objects/<2-hex>/`, excluding `pack` and `info`. */
function countLooseObjects(gitDir: string): number {
  const objectsDir = path.join(gitDir, 'objects');
  let count = 0;
  for (const name of fs.readdirSync(objectsDir)) {
    if (name === 'pack' || name === 'info') continue;
    if (!/^[0-9a-f]{2}$/.test(name)) continue;
    count += fs.readdirSync(path.join(objectsDir, name)).length;
  }
  return count;
}

function packFiles(gitDir: string): string[] {
  const packDir = path.join(gitDir, 'objects', 'pack');
  if (!fs.existsSync(packDir)) return [];
  return fs.readdirSync(packDir).filter((n) => n.endsWith('.pack'));
}

/** True when `git cat-file -e <hash>` exits 0 (object resolvable), false when it throws. */
function objectResolves(gitDir: string, hash: string): boolean {
  try {
    execFileSync('git', [`--git-dir=${gitDir}`, 'cat-file', '-e', hash], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('runCheckpointMaintenance (real git)', () => {
  // Case 1: repack produces a pack and collapses reachable loose objects.
  it('repacks a repo into a pack and shrinks loose objects', async () => {
    const base = await makeRoot();
    const { repoDir, workTree, repo } = await makeRepo(base, 'wsA', 'repo1');
    const gitDir = getGitDir(repoDir);

    for (let i = 0; i < 5; i++) {
      writeWork(workTree, 'file.txt', `revision ${i}\n`);
      await repo.checkpoint(`u${i}`);
    }

    expect(packFiles(gitDir)).toHaveLength(0);
    const looseBefore = countLooseObjects(gitDir);
    expect(looseBefore).toBeGreaterThan(0);

    const summary = await runCheckpointMaintenance({ baseDir: base, throttleMs: 0 });

    expect(summary.reposRepacked).toBeGreaterThanOrEqual(1);
    expect(summary.failures).toBe(0);
    expect(summary.reposEvicted).toBe(0);
    expect(packFiles(gitDir).length).toBeGreaterThanOrEqual(1);
    expect(countLooseObjects(gitDir)).toBeLessThan(looseBefore);
  });

  // Case 2: the capital-A guarantee. An object made unreachable by a rewind (reset --hard) must
  // survive repeated repacks. Lowercase `-a` would DELETE it and break rewind diff and restore; `-A`
  // converts it to a loose object that persists until Slice 2 age eviction.
  it('preserves unreachable objects across repeated sweeps (the -A guarantee)', async () => {
    const base = await makeRoot();
    const { repoDir, workTree, repo } = await makeRepo(base, 'wsB', 'repo1');
    const gitDir = getGitDir(repoDir);

    writeWork(workTree, 'file.txt', 'first\n');
    const firstCommit = await repo.checkpoint('u0');
    writeWork(workTree, 'file.txt', 'second\n');
    const orphanCommit = await repo.checkpoint('u1');

    // First sweep while the orphan is still REACHABLE, so it lands INSIDE a pack. This is what gives
    // the test teeth: the `-A` vs `-a` fork only fires for an object that was reachable-and-packed and
    // is then made unreachable. If we rewound before any pack existed the orphan would be
    // unreachable-and-loose, which `git repack` never packs and `-d` never deletes, so lowercase `-a`
    // would pass too and the assertion would be a tautology.
    await runCheckpointMaintenance({ baseDir: base, throttleMs: 0 });

    // Rewind: move HEAD's branch back to the first commit so the second commit is unreachable from
    // any ref, then drop the reflogs so it is unreachable full stop (a plain reset leaves a reflog
    // entry that would keep it reachable, masking whether the repack actually preserved it). Dropping
    // reflogs here is TEST setup, never something the sweep itself does.
    execFileSync('git', [`--git-dir=${gitDir}`, 'update-ref', 'HEAD', firstCommit], { stdio: 'ignore' });
    fs.rmSync(path.join(gitDir, 'logs'), { recursive: true, force: true });

    // Sweep again now that the orphan is packed-but-unreachable. With `-A` (capital) the repack moves
    // it out to a LOOSE object and preserves it; with the forbidden lowercase `-a` it would be DELETED
    // here, breaking rewind diff and restore. Run twice so the second pass rebuilds an existing pack,
    // the realistic steady state.
    await runCheckpointMaintenance({ baseDir: base, throttleMs: 0 });
    await runCheckpointMaintenance({ baseDir: base, throttleMs: 0 });

    expect(objectResolves(gitDir, orphanCommit)).toBe(true);
    const shown = execFileSync('git', [`--git-dir=${gitDir}`, 'show', `${orphanCommit}:file.txt`]).toString();
    expect(shown).toBe('second\n');
  });

  // Case 3: the -l guarantee. Objects borrowed through objects/info/alternates must never be copied
  // into our pack, yet must remain resolvable.
  it('does not copy borrowed alternate objects into the pack yet keeps them resolvable', async () => {
    const base = await makeRoot();
    const repoDir = path.join(base, 'wsC', 'repo1');
    const workTree = path.join(base, 'wsC__work', 'repo1');
    await fs.promises.mkdir(repoDir, { recursive: true });
    await fs.promises.mkdir(workTree, { recursive: true });

    // Work tree is a real git repo with a committed blob, so ensureReady seeds alternates at it.
    execFileSync('git', ['init', '-q'], { cwd: workTree });
    execFileSync('git', ['config', 'user.email', 'seed@test'], { cwd: workTree });
    execFileSync('git', ['config', 'user.name', 'seed'], { cwd: workTree });
    writeWork(workTree, 'tracked.txt', 'borrowed content\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: workTree });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: workTree });
    const borrowedSha = execFileSync('git', ['rev-parse', 'HEAD:tracked.txt'], { cwd: workTree }).toString().trim();

    const repo = new RepoManager(getGitDir(repoDir), getIndexPath(repoDir), workTree);
    await repo.ensureReady(['.git']);
    const gitDir = getGitDir(repoDir);

    // A checkpoint of our own content so the repack has objects to pack.
    writeWork(workTree, 'mine.txt', 'my own file\n');
    await repo.checkpoint('u0');

    const summary = await runCheckpointMaintenance({ baseDir: base, throttleMs: 0 });
    expect(summary.reposRepacked).toBeGreaterThanOrEqual(1);

    // Borrowed blob still resolves via the alternates chain.
    expect(objectResolves(gitDir, borrowedSha)).toBe(true);

    // But it is absent from our own pack: verify-pack lists only objects physically in the pack.
    const packs = packFiles(gitDir);
    expect(packs.length).toBeGreaterThanOrEqual(1);
    let listedShas = '';
    for (const pack of packs) {
      const idx = path.join(gitDir, 'objects', 'pack', pack.replace(/\.pack$/, '.idx'));
      listedShas += execFileSync('git', [`--git-dir=${gitDir}`, 'verify-pack', '-v', idx]).toString();
    }
    expect(listedShas).not.toContain(borrowedSha);
  });

  // Case 4: the sweep takes the repo lock, so it never interleaves with a live session's commit.
  it('waits for the repo lock before repacking', async () => {
    const base = await makeRoot();
    const { repoDir, workTree, repo } = await makeRepo(base, 'wsD', 'repo1');
    const gitDir = getGitDir(repoDir);
    writeWork(workTree, 'file.txt', 'v0\n');
    await repo.checkpoint('u0');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let lockHeld = false;

    const holder = withRepoLock(repoDir, async () => {
      lockHeld = true;
      await gate;
    });

    // Wait until the lock is actually held before starting the sweep.
    while (!lockHeld) await new Promise((r) => setTimeout(r, 5));

    const sweep = runCheckpointMaintenance({ baseDir: base, throttleMs: 0 });

    // Give the sweep time to try (and block on) the lock. No pack should appear while held.
    await new Promise((r) => setTimeout(r, 200));
    expect(packFiles(gitDir)).toHaveLength(0);

    release();
    await holder;
    const summary = await sweep;

    expect(summary.reposRepacked).toBeGreaterThanOrEqual(1);
    expect(packFiles(gitDir).length).toBeGreaterThanOrEqual(1);
  });

  // Case 5a: a fresh marker throttles the sweep, leaving the repo untouched.
  it('skips the sweep when the throttle marker is fresh', async () => {
    const base = await makeRoot();
    const { repoDir, workTree, repo } = await makeRepo(base, 'wsE', 'repo1');
    const gitDir = getGitDir(repoDir);
    for (let i = 0; i < 3; i++) {
      writeWork(workTree, 'file.txt', `r${i}\n`);
      await repo.checkpoint(`u${i}`);
    }
    const looseBefore = countLooseObjects(gitDir);

    // Fresh marker with mtime now.
    await fs.promises.writeFile(path.join(base, '.last-maintenance'), String(Date.now()));

    const summary = await runCheckpointMaintenance({ baseDir: base, throttleMs: 24 * 3_600_000 });

    expect(summary.skippedByThrottle).toBe(true);
    expect(summary.reposRepacked).toBe(0);
    expect(packFiles(gitDir)).toHaveLength(0);
    expect(countLooseObjects(gitDir)).toBe(looseBefore);
  });

  // Case 5b: an absent marker sweeps and writes a marker; a stale marker sweeps and rewrites it.
  it('sweeps and rewrites the marker when it is absent or stale', async () => {
    const base = await makeRoot();
    const { repoDir, workTree, repo } = await makeRepo(base, 'wsF', 'repo1');
    const gitDir = getGitDir(repoDir);
    writeWork(workTree, 'file.txt', 'v0\n');
    await repo.checkpoint('u0');

    const marker = path.join(base, '.last-maintenance');
    expect(fs.existsSync(marker)).toBe(false);

    const first = await runCheckpointMaintenance({ baseDir: base, throttleMs: 0 });
    expect(first.skippedByThrottle).toBe(false);
    expect(first.reposRepacked).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(marker)).toBe(true);
    const firstMtime = fs.statSync(marker).mtimeMs;

    // A throttleMs of 0 makes any existing marker stale, so a second sweep runs and rewrites it.
    await new Promise((r) => setTimeout(r, 20));
    const second = await runCheckpointMaintenance({ baseDir: base, throttleMs: 0 });
    expect(second.skippedByThrottle).toBe(false);
    expect(fs.statSync(marker).mtimeMs).toBeGreaterThanOrEqual(firstMtime);
    expect(packFiles(gitDir).length).toBeGreaterThanOrEqual(1);
  });

  // Case 6a: a non-existent base directory returns a zero summary without throwing AND without
  // materializing the directory or a marker (an install with no checkpoint history stays untouched).
  it('returns a zero summary for a non-existent base directory without creating it', async () => {
    const base = path.join(os.tmpdir(), `cp-maint-missing-${Date.now()}`);
    const summary = await runCheckpointMaintenance({ baseDir: base, throttleMs: 0 });
    expect(summary).toEqual({ skippedByThrottle: false, reposRepacked: 0, reposEvicted: 0, failures: 0 });
    expect(fs.existsSync(base)).toBe(false);
  });

  // Case 6a2: an existing but empty base directory is a no-op and no marker is written, so a
  // checkpointing-disabled install with an empty tree does no periodic work.
  it('returns a zero summary for an empty base directory without writing a marker', async () => {
    const base = await makeRoot();
    const summary = await runCheckpointMaintenance({ baseDir: base, throttleMs: 0 });
    expect(summary).toEqual({ skippedByThrottle: false, reposRepacked: 0, reposEvicted: 0, failures: 0 });
    expect(fs.existsSync(path.join(base, '.last-maintenance'))).toBe(false);
  });

  // Case 6b: a container directory with no `.git` is skipped without counting a failure.
  it('skips a directory that is not a repo without counting a failure', async () => {
    const base = await makeRoot();
    await fs.promises.mkdir(path.join(base, 'not-a-repo', 'still-not'), { recursive: true });
    writeWork(path.join(base, 'not-a-repo', 'still-not'), 'plain.txt', 'hi\n');

    const summary = await runCheckpointMaintenance({ baseDir: base, throttleMs: 0 });
    expect(summary.failures).toBe(0);
    expect(summary.reposRepacked).toBe(0);
  });

  // Case 6c: a corrupt repo increments failures while a healthy sibling still gets repacked.
  it('counts a failing repo while still repacking a healthy sibling', async () => {
    const base = await makeRoot();

    // Healthy sibling.
    const good = await makeRepo(base, 'wsG', 'good');
    writeWork(good.workTree, 'file.txt', 'v0\n');
    await good.repo.checkpoint('u0');
    writeWork(good.workTree, 'file.txt', 'v1\n');
    await good.repo.checkpoint('u1');
    const goodGitDir = getGitDir(good.repoDir);

    // Corrupt repo under the SAME workspace container: a `.git/HEAD` exists (so it is treated as a
    // repo) but the objects directory is missing, so repack fails.
    const badRepoDir = path.join(base, 'wsG', 'bad');
    const badGitDir = getGitDir(badRepoDir);
    await fs.promises.mkdir(badGitDir, { recursive: true });
    await fs.promises.writeFile(path.join(badGitDir, 'HEAD'), 'ref: refs/heads/main\n');

    const summary = await runCheckpointMaintenance({ baseDir: base, throttleMs: 0 });

    expect(summary.failures).toBeGreaterThanOrEqual(1);
    expect(summary.reposRepacked).toBeGreaterThanOrEqual(1);
    expect(packFiles(goodGitDir).length).toBeGreaterThanOrEqual(1);
  });

  // Case 6d: a repo one level deep (a base-level entry that itself holds a `.git`, e.g. the
  // `ephemeral` slot or a legacy flat repo) is maintained directly, not treated as a workspace
  // container.
  it('repacks a direct base-level repo (ephemeral / legacy flat layout)', async () => {
    const base = await makeRoot();
    // makeRepo nests one level under a workspace dir; place a repo directly at <base>/<name> instead.
    const repoDir = path.join(base, 'ephemeral');
    const workTree = path.join(base, 'ephemeral__work');
    await fs.promises.mkdir(repoDir, { recursive: true });
    await fs.promises.mkdir(workTree, { recursive: true });
    const repo = new RepoManager(getGitDir(repoDir), getIndexPath(repoDir), workTree);
    await repo.ensureReady(['.git']);
    const gitDir = getGitDir(repoDir);
    for (let i = 0; i < 3; i++) {
      writeWork(workTree, 'file.txt', `r${i}\n`);
      await repo.checkpoint(`u${i}`);
    }
    expect(packFiles(gitDir)).toHaveLength(0);

    const summary = await runCheckpointMaintenance({ baseDir: base, throttleMs: 0 });

    expect(summary.reposRepacked).toBeGreaterThanOrEqual(1);
    expect(summary.failures).toBe(0);
    expect(packFiles(gitDir).length).toBeGreaterThanOrEqual(1);
  });

  // Case 6e: the base-level `.checkpoint-lock` directory (a live repo lock owned by another process)
  // is skipped as a reserved name, never walked as a workspace container or counted as a failure.
  it('skips the base-level .checkpoint-lock directory without counting a failure', async () => {
    const base = await makeRoot();
    const { repoDir, workTree, repo } = await makeRepo(base, 'wsM', 'repo1');
    writeWork(workTree, 'file.txt', 'v0\n');
    await repo.checkpoint('u0');

    // A stray lock directory sitting at the base level, as if a sweep or commit were mid-flight.
    await fs.promises.mkdir(path.join(base, '.checkpoint-lock'), { recursive: true });

    const summary = await runCheckpointMaintenance({ baseDir: base, throttleMs: 0 });

    expect(summary.failures).toBe(0);
    expect(summary.reposRepacked).toBeGreaterThanOrEqual(1);
    expect(packFiles(getGitDir(repoDir)).length).toBeGreaterThanOrEqual(1);
    // The reserved lock directory is left untouched.
    expect(fs.existsSync(path.join(base, '.checkpoint-lock'))).toBe(true);
  });
});

/** Timestamp 40 days in the past, used to back-date activity signals well beyond a 30 day retention. */
const FORTY_DAYS_AGO = new Date(Date.now() - 40 * 86_400 * 1000);

/** Back-date a path's atime and mtime so its activity signal reads as long idle. */
async function backDate(target: string): Promise<void> {
  await fs.promises.utimes(target, FORTY_DAYS_AGO, FORTY_DAYS_AGO);
}

/** Remove the throttle marker so the next sweep is not skipped, mirroring a fresh daily run. */
function clearThrottle(base: string): void {
  fs.rmSync(path.join(base, '.last-maintenance'), { force: true });
}

describe('runCheckpointMaintenance age eviction (real git)', () => {
  // Case 7: an idle repo past retention is deleted whole while a recently active sibling is repacked.
  it('evicts an idle repo and repacks a surviving sibling', async () => {
    const base = await makeRoot();

    const idle = await makeRepo(base, 'wsH', 'idle');
    writeWork(idle.workTree, 'file.txt', 'v0\n');
    await idle.repo.checkpoint('u0');
    await backDate(path.join(getGitDir(idle.repoDir), 'logs', 'HEAD'));

    const active = await makeRepo(base, 'wsH', 'active');
    for (let i = 0; i < 3; i++) {
      writeWork(active.workTree, 'file.txt', `r${i}\n`);
      await active.repo.checkpoint(`u${i}`);
    }
    const activeGitDir = getGitDir(active.repoDir);

    const summary = await runCheckpointMaintenance({ baseDir: base, retentionDays: 30, throttleMs: 0 });

    expect(fs.existsSync(idle.repoDir)).toBe(false);
    expect(summary.reposEvicted).toBe(1);
    expect(fs.existsSync(active.repoDir)).toBe(true);
    expect(packFiles(activeGitDir).length).toBeGreaterThanOrEqual(1);
    expect(summary.reposRepacked).toBeGreaterThanOrEqual(1);
  });

  // Case 8: Windows safety. `git repack` leaves pack files read-only; forceRemoveDir chmods them so
  // eviction succeeds where a plain fs.rm would EPERM. First sweep with eviction disabled creates the
  // read-only pack, second sweep evicts the now back-dated repo.
  it('evicts a repo whose pack files are read-only after a prior repack', async () => {
    const base = await makeRoot();
    const { repoDir, workTree, repo } = await makeRepo(base, 'wsI', 'repo1');
    for (let i = 0; i < 3; i++) {
      writeWork(workTree, 'file.txt', `r${i}\n`);
      await repo.checkpoint(`u${i}`);
    }
    const gitDir = getGitDir(repoDir);

    // First sweep with eviction disabled: builds a pack whose files become read-only on Windows.
    await runCheckpointMaintenance({ baseDir: base, retentionDays: 0, throttleMs: 0 });
    expect(packFiles(gitDir).length).toBeGreaterThanOrEqual(1);

    // Second sweep: defeat the throttle, back-date activity, and evict. The repo dir vanishing proves
    // forceRemoveDir cleared the read-only pack files.
    clearThrottle(base);
    await backDate(path.join(gitDir, 'logs', 'HEAD'));
    const summary = await runCheckpointMaintenance({ baseDir: base, retentionDays: 30, throttleMs: 0 });

    expect(fs.existsSync(repoDir)).toBe(false);
    expect(summary.reposEvicted).toBe(1);
  });

  // Case 9: fail-safe. A non positive, negative, or NaN retentionDays disables eviction, so an idle
  // repo is kept and still repacked.
  it('keeps and repacks an idle repo when retention is 0, negative, or NaN', async () => {
    const base = await makeRoot();
    const { repoDir, workTree, repo } = await makeRepo(base, 'wsJ', 'repo1');
    for (let i = 0; i < 3; i++) {
      writeWork(workTree, 'file.txt', `r${i}\n`);
      await repo.checkpoint(`u${i}`);
    }
    const gitDir = getGitDir(repoDir);

    for (const retentionDays of [0, -5, NaN]) {
      clearThrottle(base);
      await backDate(path.join(gitDir, 'logs', 'HEAD'));
      const summary = await runCheckpointMaintenance({ baseDir: base, retentionDays, throttleMs: 0 });

      expect(fs.existsSync(repoDir)).toBe(true);
      expect(summary.reposEvicted).toBe(0);
      expect(summary.reposRepacked).toBeGreaterThanOrEqual(1);
    }
  });

  // Case 10: activity-signal fallback. With no `logs/HEAD`, lastActivityMs falls back to the `.git`
  // directory mtime, so a back-dated `.git` mtime still drives eviction. The fallback stats `.git`
  // rather than the repo directory because acquiring the repo lock bumps the repo directory's mtime.
  it('evicts via the .git dir mtime fallback when logs/HEAD is absent', async () => {
    const base = await makeRoot();
    const { repoDir, workTree, repo } = await makeRepo(base, 'wsK', 'repo1');
    writeWork(workTree, 'file.txt', 'v0\n');
    await repo.checkpoint('u0');
    const gitDir = getGitDir(repoDir);

    // Drop the reflog so the primary activity signal is gone, forcing the `.git` dir mtime fallback.
    // Back-date `.git` AFTER removing logs, since removing a child would otherwise bump its mtime.
    fs.rmSync(path.join(gitDir, 'logs'), { recursive: true, force: true });
    await backDate(gitDir);

    const summary = await runCheckpointMaintenance({ baseDir: base, retentionDays: 30, throttleMs: 0 });

    expect(fs.existsSync(repoDir)).toBe(false);
    expect(summary.reposEvicted).toBe(1);
  });

  // Case 11: eviction happens before the repack, so a doomed repo is deleted and never repacked. With
  // a single doomed repo the sweep evicts it and repacks nothing.
  it('evicts a doomed repo before repacking so it is never repacked', async () => {
    const base = await makeRoot();
    const { repoDir, workTree, repo } = await makeRepo(base, 'wsL', 'repo1');
    writeWork(workTree, 'file.txt', 'v0\n');
    await repo.checkpoint('u0');
    await backDate(path.join(getGitDir(repoDir), 'logs', 'HEAD'));

    const summary = await runCheckpointMaintenance({ baseDir: base, retentionDays: 30, throttleMs: 0 });

    expect(fs.existsSync(repoDir)).toBe(false);
    expect(summary.reposEvicted).toBe(1);
    expect(summary.reposRepacked).toBe(0);
  });
});
