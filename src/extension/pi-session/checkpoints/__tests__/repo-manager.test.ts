import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepoManager } from '../repo-manager';
import { getGitDir, getIndexPath } from '../resolver';
import { parseDiffStats } from '../diff-parser';

interface Harness {
  root: string;
  repoDir: string;
  workTree: string;
  repo: RepoManager;
}

async function makeHarness(): Promise<Harness> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cp-repo-'));
  const repoDir = path.join(root, 'repo');
  const workTree = path.join(root, 'work');
  await fs.promises.mkdir(repoDir, { recursive: true });
  await fs.promises.mkdir(workTree, { recursive: true });
  const repo = new RepoManager(getGitDir(repoDir), getIndexPath(repoDir), workTree);
  return { root, repoDir, workTree, repo };
}

function writeFile(workTree: string, rel: string, content: string): Promise<void> {
  const full = path.join(workTree, rel);
  return fs.promises.mkdir(path.dirname(full), { recursive: true }).then(() => fs.promises.writeFile(full, content, 'utf8'));
}

describe('RepoManager (real git)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    await fs.promises.rm(h.root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('ensureReady creates a bare repo and writes the exclude file (idempotently)', async () => {
    await h.repo.ensureReady(['.git', 'node_modules/']);
    const gitDir = getGitDir(h.repoDir);
    expect(fs.existsSync(path.join(gitDir, 'HEAD'))).toBe(true);
    const exclude = await fs.promises.readFile(path.join(gitDir, 'info', 'exclude'), 'utf8');
    expect(exclude).toBe('.git\nnode_modules/\n');

    await h.repo.ensureReady(['.git']);
    const exclude2 = await fs.promises.readFile(path.join(gitDir, 'info', 'exclude'), 'utf8');
    expect(exclude2).toBe('.git\n');
  });

  it('checkpoint commits and returns a 40-char HEAD hash', async () => {
    await h.repo.ensureReady(['.git']);
    await writeFile(h.workTree, 'a.txt', 'hello\n');
    const hash = await h.repo.checkpoint('u1');
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('honours the exclude file (excluded paths are not snapshotted)', async () => {
    await h.repo.ensureReady(['.git', 'secret/']);
    await writeFile(h.workTree, 'kept.txt', 'k\n');
    await writeFile(h.workTree, 'secret/key.txt', 'shh\n');
    const before = await h.repo.checkpoint('u1');
    await h.repo.stageAll();
    const changes = parseDiffStats(await h.repo.diffAgainst(before));
    expect(changes).toEqual([]);

    await writeFile(h.workTree, 'secret/key2.txt', 'shh2\n');
    await h.repo.stageAll();
    expect(parseDiffStats(await h.repo.diffAgainst(before))).toEqual([]);
  });

  it('diffAgainst reports staged changes since a commit', async () => {
    await h.repo.ensureReady(['.git']);
    await writeFile(h.workTree, 'a.txt', 'one\n');
    const base = await h.repo.checkpoint('u1');

    await writeFile(h.workTree, 'a.txt', 'one\ntwo\n');
    await writeFile(h.workTree, 'b.txt', 'new\n');
    await h.repo.stageAll();
    const changes = parseDiffStats(await h.repo.diffAgainst(base));
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
    expect(byPath['a.txt']).toEqual({ path: 'a.txt', added: 1, removed: 0 });
    expect(byPath['b.txt']).toEqual({ path: 'b.txt', added: 1, removed: 0 });
  });

  it('safeCheckout restores the work tree to an earlier commit and cleans new files', async () => {
    await h.repo.ensureReady(['.git']);
    await writeFile(h.workTree, 'a.txt', 'original\n');
    const target = await h.repo.checkpoint('u1');

    await writeFile(h.workTree, 'a.txt', 'modified\n');
    await writeFile(h.workTree, 'b.txt', 'created later\n');
    await h.repo.checkpoint('u2');

    const result = await h.repo.safeCheckout(target);
    expect(result.ok).toBe(true);
    expect(await fs.promises.readFile(path.join(h.workTree, 'a.txt'), 'utf8')).toBe('original\n');
    expect(fs.existsSync(path.join(h.workTree, 'b.txt'))).toBe(false);
  });

  it('safeCheckout recreates a file deleted from the work tree (rewind semantics)', async () => {
    await h.repo.ensureReady(['.git']);
    await writeFile(h.workTree, 'keep.txt', 'v1\n');
    const target = await h.repo.checkpoint('u1');

    // The user deletes the file manually after the checkpoint, then rewinds to it.
    await fs.promises.rm(path.join(h.workTree, 'keep.txt'));
    expect(fs.existsSync(path.join(h.workTree, 'keep.txt'))).toBe(false);

    const result = await h.repo.safeCheckout(target);
    expect(result.ok).toBe(true);
    expect(await fs.promises.readFile(path.join(h.workTree, 'keep.txt'), 'utf8')).toBe('v1\n');
  });

  it('seeds object-DB alternates from a git work tree so source blobs resolve without re-hashing', async () => {
    // Turn the work tree into a real git repo with a committed blob.
    execFileSync('git', ['init', '-q'], { cwd: h.workTree });
    execFileSync('git', ['config', 'user.email', 'seed@test'], { cwd: h.workTree });
    execFileSync('git', ['config', 'user.name', 'seed'], { cwd: h.workTree });
    await writeFile(h.workTree, 'tracked.txt', 'committed content\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: h.workTree });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: h.workTree });

    await h.repo.ensureReady(['.git']);

    // The bare repo points its object store at the source's via alternates.
    const altPath = path.join(getGitDir(h.repoDir), 'objects', 'info', 'alternates');
    expect(fs.existsSync(altPath)).toBe(true);
    expect((await fs.promises.readFile(altPath, 'utf8')).trim().toLowerCase()).toContain('objects');

    // The source's committed blob resolves from the bare repo purely via the shared alternates
    // (throws if the object is missing — i.e. would have to be re-hashed).
    const blobSha = execFileSync('git', ['rev-parse', 'HEAD:tracked.txt'], { cwd: h.workTree }).toString().trim();
    execFileSync('git', [`--git-dir=${getGitDir(h.repoDir)}`, 'cat-file', '-e', blobSha], { cwd: h.workTree });

    // A checkpoint still completes end-to-end on the seeded repo.
    expect(await h.repo.checkpoint('u1')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('safeCheckout reports checkout-failed for a non-existent target commit', async () => {
    await h.repo.ensureReady(['.git']);
    await writeFile(h.workTree, 'a.txt', 'v1\n');
    await h.repo.checkpoint('u1');
    const result = await h.repo.safeCheckout('0000000000000000000000000000000000000000');
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'checkout-failed') {
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    } else {
      throw new Error('expected checkout-failed');
    }
  });

  it('cloneFrom produces an independent bare repo sharing history', async () => {
    await h.repo.ensureReady(['.git']);
    await writeFile(h.workTree, 'a.txt', 'shared\n');
    const head = await h.repo.checkpoint('u1');

    const dstGitDir = path.join(h.root, 'clone', '.git');
    await RepoManager.cloneFrom(getGitDir(h.repoDir), dstGitDir);
    expect(fs.existsSync(path.join(dstGitDir, 'HEAD'))).toBe(true);

    const clone = new RepoManager(dstGitDir, path.join(h.root, 'clone', 'index'), h.workTree);
    const cloneHead = await clone.diffAgainst(head);
    expect(parseDiffStats(cloneHead)).toBeDefined();
  });

  it('withLock serializes overlapping operations on the same repo (no interleaving)', async () => {
    await h.repo.ensureReady(['.git']);
    const order: string[] = [];
    const section = (tag: string): Promise<void> =>
      h.repo.withLock(async () => {
        order.push(`${tag}-start`);
        await new Promise((r) => setTimeout(r, 30));
        order.push(`${tag}-end`);
      });
    await Promise.all([section('a'), section('b')]);
    // Whichever section acquires first, the critical sections must not interleave: each start is
    // immediately followed by its own end.
    expect(order).toHaveLength(4);
    expect(order[1]).toBe(`${order[0]?.split('-')[0]}-end`);
    expect(order[3]).toBe(`${order[2]?.split('-')[0]}-end`);
    expect(order[0]).not.toBe(order[2]);
  });
});
