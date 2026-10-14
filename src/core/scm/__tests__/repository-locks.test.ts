import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { GitRunner } from '../git-runner';
import { Repository, type LockScope } from '../repository';
import { unremovable } from './git-harness';

const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-scm-locks-')));

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// The cleanup runs no git; a call would be a bug.
const noGit: GitRunner = {
  git: { path: '/usr/bin/git', version: { major: 2, minor: 45, patch: 0 } },
  run: () => Promise.reject(new Error('This test runs no git')),
  envFor: () => ({}),
};

const REMOTE: LockScope = { branches: [], workTree: false };
let count = 0;

function layout(): { root: string; gitDir: string; touch: (relative: string, ageMs?: number) => string } {
  const root = path.join(sandbox, `repo-${++count}`);
  const gitDir = path.join(root, '.git');
  for (const folder of ['refs/heads', 'refs/remotes/origin', 'refs/tags', 'logs/refs/heads']) fs.mkdirSync(path.join(gitDir, folder), { recursive: true });
  const touch = (relative: string, ageMs = 0): string => {
    const file = path.join(gitDir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    if (ageMs > 0) fs.utimesSync(file, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
    return file;
  };
  return { root, gitDir, touch };
}

const repository = (root: string, gitDir: string, commonDir = gitDir): Repository => new Repository({ root, gitDir, commonDir, kind: 'root', project: root }, noGit);
const exists = (gitDir: string, relative: string): boolean => fs.existsSync(path.join(gitDir, ...relative.split('/')));

describe('lock files a killed remote operation left', () => {
  it('removes only a new lock of its own kinds: never one there before, an old one, a folder, the index, HEAD or a branch it did not write', async () => {
    const { root, gitDir, touch } = layout();
    const repo = repository(root, gitDir);
    touch('packed-refs.lock');
    const before = await repo.lockFiles(REMOTE);
    const since = Date.now() - 1000;
    touch('refs/remotes/origin/old.lock', 60_000);
    fs.mkdirSync(path.join(gitDir, 'refs', 'remotes', 'origin', 'dir.lock'));
    for (const relative of ['refs/remotes/origin/main.lock', 'refs/remotes/origin/feat/x.lock', 'refs/tags/v1.lock', 'config.lock', 'shallow.lock', 'FETCH_HEAD.lock', 'index.lock', 'HEAD.lock', 'refs/heads/main.lock', 'logs/refs/heads/main.lock', 'ORIG_HEAD.lock']) touch(relative);
    const { removed, failed } = await repo.removeLocksSince(REMOTE, since, before);
    expect([...removed].sort()).toEqual(['FETCH_HEAD.lock', 'config.lock', 'refs/remotes/origin/feat/x.lock', 'refs/remotes/origin/main.lock', 'refs/tags/v1.lock', 'shallow.lock']);
    expect(failed).toEqual([]);
    for (const kept of ['packed-refs.lock', 'refs/remotes/origin/old.lock', 'refs/remotes/origin/dir.lock', 'index.lock', 'HEAD.lock', 'refs/heads/main.lock', 'logs/refs/heads/main.lock', 'ORIG_HEAD.lock']) expect(exists(gitDir, kept), kept).toBe(true);
    // a fast-forward writes the branch it names
    expect((await repo.removeLocksSince({ branches: ['main'], workTree: false }, since, before)).removed).toEqual(['refs/heads/main.lock']);
  });

  it('follows no link or junction, under refs/ or as refs/ itself', async () => {
    const outside = path.join(sandbox, `outside-${++count}`);
    fs.mkdirSync(path.join(outside, 'remotes', 'origin'), { recursive: true });
    const { root, gitDir, touch } = layout();
    fs.symlinkSync(outside, path.join(gitDir, 'refs', 'remotes', 'j'), 'junction');
    const linked = layout();
    fs.rmSync(path.join(linked.gitDir, 'refs'), { recursive: true });
    fs.symlinkSync(outside, path.join(linked.gitDir, 'refs'), 'junction');
    const since = Date.now() - 1000;
    fs.writeFileSync(path.join(outside, 'y.lock'), '');
    fs.writeFileSync(path.join(outside, 'remotes', 'origin', 'z.lock'), '');
    touch('refs/remotes/origin/main.lock');
    expect((await repository(root, gitDir).removeLocksSince(REMOTE, since, new Set())).removed).toEqual(['refs/remotes/origin/main.lock']);
    expect((await repository(linked.root, linked.gitDir).removeLocksSince(REMOTE, since, new Set())).removed).toEqual([]);
    expect(fs.existsSync(path.join(outside, 'y.lock')) && fs.existsSync(path.join(outside, 'remotes', 'origin', 'z.lock'))).toBe(true);
  });

  it('takes a pull\'s work-tree locks from its own git dir only, never the main worktree\'s index in a linked worktree', async () => {
    const { root, gitDir: commonDir, touch } = layout();
    const gitDir = path.join(commonDir, 'worktrees', 'wt');
    fs.mkdirSync(gitDir, { recursive: true });
    const repo = repository(path.join(root, 'wt'), gitDir, commonDir);
    const since = Date.now() - 1000;
    touch('index.lock');
    touch('worktrees/wt/index.lock');
    touch('worktrees/wt/HEAD.lock');
    touch('worktrees/wt/rebase-merge/done.lock');
    touch('refs/heads/wt.lock');
    touch('refs/heads/main.lock');
    const { removed } = await repo.removeLocksSince({ branches: ['wt'], workTree: true }, since, new Set());
    expect([...removed].sort()).toEqual(['HEAD.lock', 'index.lock', 'rebase-merge/done.lock', 'refs/heads/wt.lock']);
    expect(exists(commonDir, 'index.lock') && exists(commonDir, 'refs/heads/main.lock')).toBe(true);
  });

  it('reports a lock it cannot remove instead of throwing, and removes the others', async () => {
    const { root, gitDir, touch } = layout();
    const repo = repository(root, gitDir);
    const since = Date.now() - 1000;
    const held = touch('refs/remotes/origin/held.lock');
    touch('refs/tags/v2.lock');
    const release = await unremovable(held);
    try {
      const { removed, failed } = await repo.removeLocksSince(REMOTE, since, new Set());
      expect(failed.map((failure) => failure.path)).toEqual(['refs/remotes/origin/held.lock']);
      expect(removed).toEqual(['refs/tags/v2.lock']);
    } finally {
      await release();
    }
    expect(fs.existsSync(held)).toBe(true);
  });
});
