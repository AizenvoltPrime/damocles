import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Disposable } from '../../../platform/disposable';
import type { FileWatcher, FileWatcherFactory } from '../../../platform/file-watcher';
import { checkoutArgs } from '../branches';
import { gitAtLeast } from '../git-runner';
import { parseGitVersion } from '../git-version';
import { GitUntrustedError } from '../errors';
import { PathRefusedError } from '../repository';
import { type ScmEvent } from '../scm-service';
import { folder, freshStatus, git, harness, HAS_GIT, makeRepo, ready, sandbox, statusOf, useGitSandbox, waitFor, write, type Harness } from './git-harness';

/** Branches, stash, tags and worktrees (slice 11b) against real and bare repositories, with real git. */
useGitSandbox();

function bare(name: string): string {
  const dir = path.join(folder(`${name}-root`), `${name}.git`);
  git(['init', '--quiet', '--bare', '-b', 'main', dir], sandbox);
  return dir;
}

function commit(repo: string, file: string, text: string, message: string): string {
  write(path.join(repo, file), text);
  git(['add', '.'], repo);
  git(['commit', '--quiet', '-m', message], repo);
  return git(['rev-parse', 'HEAD'], repo).trim();
}

// A work tree whose main tracks origin/main of a fresh bare repository.
function tracked(name: string): { work: string; origin: string } {
  const origin = bare(name);
  const work = makeRepo(folder(name));
  git(['remote', 'add', 'origin', origin], work);
  git(['push', '--quiet', '-u', 'origin', 'main'], work);
  return { work, origin };
}

async function open(project: string, opts: Parameters<typeof harness>[0] = {}): Promise<{ h: Harness; repoId: string; events: ScmEvent[] }> {
  const h = harness({ trusted: [project], ...opts });
  const events: ScmEvent[] = [];
  h.service.onDidChange((event) => void events.push(event));
  h.service.setProjects([{ key: 'p', path: project }]);
  const repoId = (await ready(h)).repos[0]!.repoId;
  await waitFor(() => statusOf(h, repoId), 'a first status');
  return { h, repoId, events };
}

const head = (repo: string): string => git(['symbolic-ref', '-q', '--short', 'HEAD'], repo).trim();
const refExists = (repo: string, ref: string): boolean => git(['for-each-ref', '--format=%(refname)', ref], repo).trim() === ref;

async function rows<G extends Parameters<Harness['service']['artifacts']>[1]>(h: Harness, repoId: string, group: G) {
  const artifacts = await h.service.artifacts(repoId, group);
  if (artifacts.group !== group) throw new Error('wrong group');
  return artifacts.rows as Extract<typeof artifacts, { group: G }>['rows'];
}

// The desktop watcher's contract without its platform code: every entry under a watched folder whose identity changed
// across an action (lstat size and mtime, objects/ skipped as the desktop watcher skips it) is reported, as
// startFsWatchTree settles events against its snapshot.
function snapshotWatchers(): FileWatcherFactory & { around(action: () => void): void } {
  const watched: Array<{ readonly base: string; readonly listeners: Set<(fsPath: string) => void> }> = [];
  const snapshot = (base: string): Map<string, string> => {
    const entries = new Map<string, string>();
    for (const relative of fs.readdirSync(base, { recursive: true, encoding: 'utf8' }) as string[]) {
      if (relative.split(path.sep).includes('objects')) continue;
      const stat = fs.lstatSync(path.join(base, relative));
      entries.set(relative, `${stat.size}:${stat.mtimeMs}`);
    }
    return entries;
  };
  return {
    watch: (base: string): FileWatcher => {
      const entry = { base, listeners: new Set<(fsPath: string) => void>() };
      watched.push(entry);
      const on = (cb: (fsPath: string) => void): Disposable => {
        entry.listeners.add(cb);
        return { dispose: () => entry.listeners.delete(cb) };
      };
      return { ready: Promise.resolve(), onDidCreate: on, onDidChange: on, onDidDelete: on, dispose: () => void watched.splice(watched.indexOf(entry), 1) };
    },
    watchWorkspace: () => ({ ready: Promise.resolve(), onDidCreate: () => ({ dispose: () => undefined }), onDidChange: () => ({ dispose: () => undefined }), onDidDelete: () => ({ dispose: () => undefined }), dispose: () => undefined }),
    onDidRenameFiles: () => ({ dispose: () => undefined }),
    around: (action) => {
      const before = watched.map((entry) => snapshot(entry.base));
      action();
      watched.forEach((entry, index) => {
        const after = snapshot(entry.base);
        const changed = [...new Set([...before[index]!.keys(), ...after.keys()])].filter((relative) => before[index]!.get(relative) !== after.get(relative));
        for (const relative of changed) for (const listener of entry.listeners) listener(path.join(entry.base, relative));
      });
    },
  };
}

const version = (): ReturnType<typeof parseGitVersion> => parseGitVersion(git(['--version'], sandbox));

describe.skipIf(!HAS_GIT)('branches, checkout, merge and rebase', { timeout: 120_000 }, () => {
  it('pins checkout\'s argv: no --end-of-options (git 2.43 reads it as a path), the name before --, a remote branch in full', () => {
    expect(checkoutArgs({ kind: 'branch', name: 'feat/a' })).toEqual(['checkout', '-q', 'feat/a', '--']);
    expect(checkoutArgs({ kind: 'track', ref: 'refs/remotes/origin/feat' })).toEqual(['checkout', '-q', '--track', 'refs/remotes/origin/feat', '--']);
    expect(checkoutArgs({ kind: 'detached', revision: 'refs/tags/v1' })).toEqual(['checkout', '-q', '--detach', 'refs/tags/v1', '--']);
    expect(() => checkoutArgs({ kind: 'branch', name: '-x' })).toThrow();
    expect(() => checkoutArgs({ kind: 'track', ref: 'refs/heads/main' })).toThrow();
  });

  it('lists local branches newest first with their commit, HEAD and upstream, and remote branches without HEAD', async () => {
    const { work } = tracked('rows');
    git(['remote', 'set-head', 'origin', 'main'], work);
    git(['branch', 'older'], work);
    const second = commit(work, 'b.txt', 'b\n', 'second subject');
    git(['branch', 'newer'], work);
    const { h, repoId } = await open(work);
    const branches = await rows(h, repoId, 'branches');
    expect(branches.map((row) => row.name).sort()).toEqual(['main', 'newer', 'older']);
    const main = branches.find((row) => row.name === 'main')!;
    expect(main).toMatchObject({ ref: 'refs/heads/main', current: true, upstream: { remote: 'origin', branch: 'main', ahead: 1, behind: 0 } });
    expect(main.commit).toMatchObject({ hash: second, subject: 'second subject', author: 'Damocles Tests' });
    expect(branches.find((row) => row.name === 'older')).toMatchObject({ current: false, upstream: null });
    expect(await rows(h, repoId, 'remoteBranches')).toEqual([expect.objectContaining({ ref: 'refs/remotes/origin/main', name: 'origin/main', remote: 'origin' })]);
    h.service.dispose();
  });

  it('checks out a local branch, a remote branch as a new tracking branch, a tag and a commit detached', async () => {
    const { work, origin } = tracked('checkout');
    git(['push', '--quiet', 'origin', 'main:feat'], work);
    git(['fetch', '--quiet', 'origin'], work);
    git(['branch', 'local'], work);
    git(['tag', 'v1'], work);
    const { h, repoId } = await open(work);
    expect(await h.service.checkout(repoId, { kind: 'branch', name: 'local' })).toBe('ok');
    expect(head(work)).toBe('local');
    expect(await h.service.checkout(repoId, { kind: 'track', ref: 'refs/remotes/origin/feat' })).toBe('ok');
    expect(head(work)).toBe('feat');
    expect(git(['for-each-ref', '--format=%(upstream:short)', 'refs/heads/feat'], work).trim()).toBe('origin/feat');
    expect(await h.service.checkout(repoId, { kind: 'detached', revision: 'refs/tags/v1' })).toBe('ok');
    expect((await freshStatus(h, repoId)).head?.type).toBe('detached');
    const tags = await rows(h, repoId, 'tags');
    expect(tags).toEqual([expect.objectContaining({ name: 'v1', annotated: false, current: true })]);
    expect(fs.existsSync(origin)).toBe(true);
    h.service.dispose();
  });

  it('answers dirty when a checkout would overwrite local changes, and changes nothing', async () => {
    const work = makeRepo(folder('dirty-checkout'));
    git(['checkout', '-q', '-b', 'other'], work);
    commit(work, 'a.txt', 'other\n', 'other');
    git(['checkout', '-q', 'main'], work);
    write(path.join(work, 'a.txt'), 'local edit\n');
    const { h, repoId } = await open(work);
    expect(await h.service.checkout(repoId, { kind: 'branch', name: 'other' })).toBe('dirty');
    expect(head(work)).toBe('main');
    expect(fs.readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe('local edit\n');
    h.service.dispose();
  });

  it('creates a branch at HEAD and from a ref, renames it, and refuses a name that is an option', async () => {
    const work = makeRepo(folder('create'));
    const first = git(['rev-parse', 'HEAD'], work).trim();
    commit(work, 'b.txt', 'b\n', 'second');
    git(['tag', 'v0', first], work);
    const { h, repoId } = await open(work);
    await h.service.createBranch(repoId, 'feat/one', 'HEAD');
    expect(head(work)).toBe('feat/one');
    await h.service.createBranch(repoId, 'from-tag', 'refs/tags/v0');
    expect(head(work)).toBe('from-tag');
    expect(git(['rev-parse', 'HEAD'], work).trim()).toBe(first);
    // --no-track: the new branch has no upstream
    expect(() => git(['config', '--get', 'branch.from-tag.merge'], work)).toThrow();
    await h.service.renameBranch(repoId, 'renamed');
    expect(head(work)).toBe('renamed');
    await expect(h.service.createBranch(repoId, '--orphan', 'HEAD')).rejects.toThrow();
    await expect(h.service.renameBranch(repoId, '-D')).rejects.toThrow();
    h.service.dispose();
  }, 60_000);

  it('deletes a merged branch, answers unmerged for one that is not, and forces it', async () => {
    const work = makeRepo(folder('delete'));
    git(['branch', 'merged'], work);
    git(['checkout', '-q', '-b', 'unmerged'], work);
    commit(work, 'u.txt', 'u\n', 'unmerged work');
    git(['checkout', '-q', 'main'], work);
    const { h, repoId } = await open(work);
    expect(await h.service.deleteBranch(repoId, 'merged', false)).toBe('ok');
    expect(refExists(work, 'refs/heads/merged')).toBe(false);
    expect(await h.service.deleteBranch(repoId, 'unmerged', false)).toBe('unmerged');
    expect(refExists(work, 'refs/heads/unmerged')).toBe(true);
    expect(await h.service.deleteBranch(repoId, 'unmerged', true)).toBe('ok');
    expect(refExists(work, 'refs/heads/unmerged')).toBe(false);
    h.service.dispose();
  });

  it('deletes a branch on a bare remote', async () => {
    const { work, origin } = tracked('remote-branch');
    git(['push', '--quiet', 'origin', 'main:gone'], work);
    const { h, repoId } = await open(work);
    await h.service.deleteRemoteRef(repoId, 'origin', 'refs/heads/gone');
    expect(git(['for-each-ref', '--format=%(refname)', 'refs/heads/'], origin).trim()).toBe('refs/heads/main');
    await expect(h.service.deleteRemoteRef(repoId, '-x', 'refs/heads/gone')).rejects.toThrow();
    h.service.dispose();
  });

  it('merges and rebases onto a branch, and answers conflict with the merge left in progress', async () => {
    const work = makeRepo(folder('integrate'));
    git(['checkout', '-q', '-b', 'side'], work);
    commit(work, 's.txt', 's\n', 'side');
    git(['checkout', '-q', 'main'], work);
    commit(work, 'm.txt', 'm\n', 'main');
    const { h, repoId } = await open(work);
    expect(await h.service.integrate(repoId, 'merge', 'side')).toBe('ok');
    expect(fs.existsSync(path.join(work, 's.txt'))).toBe(true);
    git(['checkout', '-q', '-b', 'topic', 'side'], work);
    commit(work, 't.txt', 't\n', 'topic');
    expect(await h.service.integrate(repoId, 'rebase', 'main')).toBe('ok');
    expect(git(['merge-base', '--is-ancestor', 'main', 'topic'], work)).toBe('');
    git(['checkout', '-q', '-b', 'clash', 'main'], work);
    commit(work, 'a.txt', 'clash\n', 'clash');
    git(['checkout', '-q', 'main'], work);
    commit(work, 'a.txt', 'main side\n', 'main side');
    expect(await h.service.integrate(repoId, 'merge', 'clash')).toBe('conflict');
    expect((await freshStatus(h, repoId)).operation).toBe('merge');
    h.service.dispose();
  }, 60_000);

  it('fast-forwards a branch that is behind its upstream, and answers rejected, recording no failure, for one with outgoing commits or checked out elsewhere', async () => {
    const { work, origin } = tracked('ff');
    git(['branch', '--track', 'behind', 'origin/main'], work);
    git(['branch', '--track', 'ahead', 'origin/main'], work);
    git(['checkout', '-q', 'ahead'], work);
    const local = commit(work, 'l.txt', 'l\n', 'local');
    git(['checkout', '-q', 'main'], work);
    const other = folder('ff-other');
    git(['clone', '--quiet', origin, other], sandbox);
    git(['config', 'user.email', 'o@damocles.invalid'], other);
    git(['config', 'user.name', 'Other'], other);
    const upstream = commit(other, 'up.txt', 'up\n', 'upstream');
    git(['push', '--quiet', 'origin', 'HEAD:main'], other);
    const { h, repoId } = await open(work);
    expect(await h.service.fastForward(repoId, 'behind', { remote: 'origin', branch: 'main' })).toBe('ok');
    expect(git(['rev-parse', 'refs/heads/behind'], work).trim()).toBe(upstream);
    expect(await h.service.fastForward(repoId, 'ahead', { remote: 'origin', branch: 'main' })).toBe('rejected');
    expect(git(['rev-parse', 'refs/heads/ahead'], work).trim()).toBe(local);
    expect(h.service.snapshot(repoId)?.lastRemote).toMatchObject({ op: 'pull', outcome: 'ok' });
    // main is checked out in this work tree, which git refuses to fetch into
    expect(await h.service.fastForward(repoId, 'main', { remote: 'origin', branch: 'main' })).toBe('rejected');
    expect(h.service.snapshot(repoId)?.lastRemote).toMatchObject({ op: 'pull', outcome: 'ok' });
    h.service.dispose();
  }, 60_000);

  it('answers rejected for a fast-forward of a branch checked out in another worktree', async () => {
    const { work, origin } = tracked('ff-worktree');
    git(['branch', '--track', 'elsewhere', 'origin/main'], work);
    const before = git(['rev-parse', 'refs/heads/elsewhere'], work).trim();
    git(['worktree', 'add', '--quiet', path.join(folder('ff-worktree-linked'), 'wt'), 'elsewhere'], work);
    const other = folder('ff-worktree-other');
    git(['clone', '--quiet', origin, other], sandbox);
    git(['config', 'user.email', 'o@damocles.invalid'], other);
    git(['config', 'user.name', 'Other'], other);
    commit(other, 'up.txt', 'up\n', 'upstream');
    git(['push', '--quiet', 'origin', 'HEAD:main'], other);
    const { h, repoId } = await open(work);
    expect(await h.service.fastForward(repoId, 'elsewhere', { remote: 'origin', branch: 'main' })).toBe(gitAtLeast(version()!, 2, 35) ? 'rejected' : 'ok');
    if (gitAtLeast(version()!, 2, 35)) expect(git(['rev-parse', 'refs/heads/elsewhere'], work).trim()).toBe(before);
    h.service.dispose();
  }, 60_000);

  it('reports a fast-forward that succeeded although its repository closed as it ended', async () => {
    const { work, origin } = tracked('ff-closed');
    git(['branch', '--track', 'behind', 'origin/main'], work);
    const other = folder('ff-closed-other');
    git(['clone', '--quiet', origin, other], sandbox);
    git(['config', 'user.email', 'o@damocles.invalid'], other);
    git(['config', 'user.name', 'Other'], other);
    const upstream = commit(other, 'up.txt', 'up\n', 'upstream');
    git(['push', '--quiet', 'origin', 'HEAD:main'], other);
    const { h, repoId } = await open(work);
    h.service.onDidChange((event) => {
      const snapshot = h.service.snapshot(repoId);
      if (event.kind === 'repository' && event.repoId === repoId && snapshot?.running === null && snapshot.lastRemote !== null) h.service.setProjects([]);
    });
    expect(await h.service.fastForward(repoId, 'behind', { remote: 'origin', branch: 'main' })).toBe('ok');
    expect(git(['rev-parse', 'refs/heads/behind'], work).trim()).toBe(upstream);
    expect(h.service.snapshot(repoId)).toBeUndefined();
    h.service.dispose();
  }, 60_000);

  it('lists the worktrees of a repository with no commits, and an orphan worktree, with no commit', async () => {
    const empty = folder('worktrees-unborn');
    git(['init', '--quiet', '-b', 'main'], empty);
    const { h, repoId } = await open(fs.realpathSync.native(empty));
    expect(await rows(h, repoId, 'worktrees')).toEqual([expect.objectContaining({ path: fs.realpathSync.native(empty), branch: 'main', commit: null, main: true })]);
    h.service.dispose();
    if (!gitAtLeast(version()!, 2, 42)) return;
    const work = makeRepo(folder('worktrees-orphan'));
    const orphan = path.join(folder('worktrees-orphan-linked'), 'orphan');
    git(['worktree', 'add', '--quiet', '--orphan', '-b', 'orphan', orphan], work);
    const opened = await open(work);
    const listed = await rows(opened.h, opened.repoId, 'worktrees');
    expect(listed.map((row) => [row.branch, row.commit === null])).toEqual([['main', false], ['orphan', true]]);
    opened.h.service.dispose();
  }, 60_000);

  it('lists the files that differ between two commits with renames, and each file\'s patch', async () => {
    const work = makeRepo(folder('diff-refs'));
    const left = git(['rev-parse', 'HEAD'], work).trim();
    write(path.join(work, 'keep.txt'), 'line one\nline two\nline three\nline four\n');
    git(['add', '.'], work);
    git(['commit', '--quiet', '-m', 'keep'], work);
    const middle = git(['rev-parse', 'HEAD'], work).trim();
    git(['mv', 'keep.txt', 'moved.txt'], work);
    write(path.join(work, 'a.txt'), 'two\n');
    write(path.join(work, 'new.txt'), 'new\n');
    git(['add', '.'], work);
    git(['commit', '--quiet', '-m', 'changes'], work);
    const right = git(['rev-parse', 'HEAD'], work).trim();
    const { h, repoId } = await open(work);
    const diff = await h.service.diffRefs(repoId, middle, right);
    expect(diff.entries.map((entry) => [entry.change.status, entry.change.path, entry.change.originalPath])).toEqual([
      ['MODIFIED', 'a.txt', undefined],
      ['INDEX_RENAMED', 'moved.txt', 'keep.txt'],
      ['INDEX_ADDED', 'new.txt', undefined],
    ]);
    const patch = await h.service.entryPatch(repoId, diff.left, diff.entries[0]!);
    expect(patch.kind === 'patch' && patch.patch).toContain('+two');
    expect((await h.service.diffRefs(repoId, left, left)).entries).toEqual([]);
    await expect(h.service.diffRefs(repoId, 'HEAD', right)).rejects.toThrow();
    h.service.dispose();
  });
});

describe.skipIf(!HAS_GIT)('stash', { timeout: 120_000 }, () => {
  it('stashes, with untracked files, and staged changes only (git 2.35 or later)', async (context) => {
    const work = makeRepo(folder('stash'));
    const { h, repoId } = await open(work);
    write(path.join(work, 'a.txt'), 'edited\n');
    write(path.join(work, 'untracked.txt'), 'new\n');
    expect(await h.service.stash(repoId, 'default', 'tracked only')).toBe('ok');
    expect(fs.existsSync(path.join(work, 'untracked.txt'))).toBe(true);
    expect(await h.service.stash(repoId, 'includeUntracked', '')).toBe('ok');
    expect(fs.existsSync(path.join(work, 'untracked.txt'))).toBe(false);
    const stashes = await rows(h, repoId, 'stashes');
    expect(stashes.map((stash) => [stash.index, stash.description, stash.branch])).toEqual([
      [0, expect.stringMatching(/^WIP \(/), 'main'],
      [1, 'tracked only', 'main'],
    ]);
    expect(stashes[0]!.date).toBeGreaterThan(0);
    // a message that is the pathspec separator stays a message
    write(path.join(work, 'a.txt'), 'dashes\n');
    expect(await h.service.stash(repoId, 'default', '--')).toBe('ok');
    expect((await rows(h, repoId, 'stashes'))[0]!.description).toBe('--');
    expect(await h.service.stash(repoId, 'default', '')).toBe('noChanges');
    if (!gitAtLeast(version()!, 2, 35)) {
      context.skip('Stash Staged needs git 2.35');
      return;
    }
    write(path.join(work, 'a.txt'), 'staged\n');
    git(['add', 'a.txt'], work);
    write(path.join(work, 'b.txt'), 'left alone\n');
    expect(await h.service.stash(repoId, 'staged', 'staged only')).toBe('ok');
    expect(fs.readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe('one\n');
    expect(fs.existsSync(path.join(work, 'b.txt'))).toBe(true);
    h.service.dispose();
  });

  it('stashes only the named files, with --, and says so when there are no commits yet', async () => {
    const work = makeRepo(folder('stash-paths'));
    write(path.join(work, 'b.txt'), 'b\n');
    git(['add', '.'], work);
    git(['commit', '--quiet', '-m', 'b'], work);
    write(path.join(work, 'a.txt'), 'edited\n');
    write(path.join(work, 'b.txt'), 'edited b\n');
    const { h, repoId } = await open(work);
    expect(await h.service.stash(repoId, 'default', 'a only', ['a.txt'])).toBe('ok');
    expect(fs.readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe('one\n');
    expect(fs.readFileSync(path.join(work, 'b.txt'), 'utf8')).toBe('edited b\n');
    // core checks each path again, and refuses more paths than one command line holds before git runs
    const stashes = git(['stash', 'list'], work);
    await expect(h.service.stash(repoId, 'default', '', ['../outside.txt'])).rejects.toBeInstanceOf(PathRefusedError);
    await expect(h.service.stash(repoId, 'default', '', Array.from({ length: 1000 }, (_, index) => `folder/file-${index}-${'x'.repeat(30)}.txt`))).rejects.toThrow('Too many files to stash at once. Stash fewer files, or stash all changes.');
    expect(git(['stash', 'list'], work)).toBe(stashes);
    h.service.dispose();
    const empty = folder('stash-empty');
    git(['init', '--quiet', '-b', 'main'], empty);
    write(path.join(empty, 'x.txt'), 'x\n');
    git(['add', '.'], empty);
    const unborn = await open(empty);
    expect(await unborn.h.service.stash(unborn.repoId, 'default', '')).toBe('noCommits');
    unborn.h.service.dispose();
  });

  it('applies, pops and drops a stash by its commit, refuses a stash@{n} that moved, and drops them all', async () => {
    const work = makeRepo(folder('stash-ops'));
    const { h, repoId } = await open(work);
    write(path.join(work, 'a.txt'), 'first\n');
    await h.service.stash(repoId, 'default', 'first');
    write(path.join(work, 'a.txt'), 'second\n');
    await h.service.stash(repoId, 'default', 'second');
    const listed = await rows(h, repoId, 'stashes');
    const second = listed[0];
    let first = listed[1];
    expect(await h.service.stashApply(repoId, { index: 1, hash: first!.hash }, false)).toBe('ok');
    expect(fs.readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe('first\n');
    expect(await rows(h, repoId, 'stashes')).toHaveLength(2);
    git(['checkout', '-q', '--', 'a.txt'], work);
    // index 0 holds "second", so a pop of "first" by index 0 is refused
    expect(await h.service.stashApply(repoId, { index: 0, hash: first!.hash }, true)).toBe('moved');
    expect(await h.service.stashApply(repoId, { index: 0, hash: second!.hash }, true)).toBe('ok');
    expect(fs.readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe('second\n');
    [first] = await rows(h, repoId, 'stashes');
    expect(first!.description).toBe('first');
    git(['checkout', '-q', '--', 'a.txt'], work);
    expect(await h.service.stashDrop(repoId, { index: 0, hash: second!.hash })).toBe('moved');
    expect(await h.service.stashDrop(repoId, { index: 0, hash: first!.hash })).toBe('ok');
    expect(await rows(h, repoId, 'stashes')).toEqual([]);
    write(path.join(work, 'a.txt'), 'third\n');
    await h.service.stash(repoId, 'default', 'third');
    write(path.join(work, 'a.txt'), 'fourth\n');
    await h.service.stash(repoId, 'default', 'fourth');
    await h.service.stashClear(repoId);
    expect(await rows(h, repoId, 'stashes')).toEqual([]);
    h.service.dispose();
  }, 60_000);

  it('answers conflict when an applied stash clashes, and keeps the stash', async () => {
    const work = makeRepo(folder('stash-conflict'));
    const { h, repoId } = await open(work);
    write(path.join(work, 'a.txt'), 'stashed\n');
    await h.service.stash(repoId, 'default', 'clash');
    commit(work, 'a.txt', 'committed\n', 'meanwhile');
    const [stash] = await rows(h, repoId, 'stashes');
    expect(await h.service.stashApply(repoId, { index: 0, hash: stash!.hash }, true)).toBe('conflict');
    expect(await rows(h, repoId, 'stashes')).toHaveLength(1);
    h.service.dispose();
  });

  it('refuses to apply or pop a stash while files have merge conflicts, before git runs, and leaves the stash and the merge as they were', async () => {
    const work = makeRepo(folder('stash-during-merge'));
    git(['checkout', '-q', '-b', 'side'], work);
    commit(work, 'a.txt', 'side\n', 'side');
    git(['checkout', '-q', 'main'], work);
    const { h, repoId } = await open(work);
    write(path.join(work, 's.txt'), 'stashed\n');
    await h.service.stash(repoId, 'includeUntracked', 'mine');
    commit(work, 'a.txt', 'main\n', 'main');
    expect(await h.service.integrate(repoId, 'merge', 'side')).toBe('conflict');
    const [stash] = await rows(h, repoId, 'stashes');
    const conflicted = fs.readFileSync(path.join(work, 'a.txt'), 'utf8');
    for (const pop of [false, true]) {
      await expect(h.service.stashApply(repoId, { index: 0, hash: stash!.hash }, pop)).rejects.toThrow('Resolve the merge conflicts before applying a stash.');
    }
    expect(h.log.some((line) => line.startsWith('> git stash apply') || line.startsWith('> git stash pop'))).toBe(false);
    expect(await rows(h, repoId, 'stashes')).toHaveLength(1);
    expect(fs.existsSync(path.join(work, 's.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe(conflicted);
    expect((await freshStatus(h, repoId)).operation).toBe('merge');
    h.service.dispose();
  }, 60_000);

  it('refuses to merge or rebase a branch while files have merge conflicts, before git runs', async () => {
    const work = makeRepo(folder('integrate-during-merge'));
    git(['checkout', '-q', '-b', 'side'], work);
    commit(work, 'a.txt', 'side\n', 'side');
    git(['checkout', '-q', '-b', 'other', 'main'], work);
    commit(work, 'o.txt', 'other\n', 'other');
    git(['checkout', '-q', 'main'], work);
    commit(work, 'a.txt', 'main\n', 'main');
    const { h, repoId } = await open(work);
    expect(await h.service.integrate(repoId, 'merge', 'side')).toBe('conflict');
    const head = git(['rev-parse', 'HEAD'], work).trim();
    for (const command of ['merge', 'rebase'] as const) {
      const before = h.log.length;
      await expect(h.service.integrate(repoId, command, 'other')).rejects.toThrow('Resolve the merge conflicts before merging or rebasing a branch.');
      expect(h.log.slice(before).some((line) => line.startsWith(`> git ${command}`) || line.includes(' merge ') || line.includes(' rebase '))).toBe(false);
    }
    expect(git(['rev-parse', 'HEAD'], work).trim()).toBe(head);
    expect(git(['rev-parse', 'MERGE_HEAD'], work).trim()).toBe(git(['rev-parse', 'side'], work).trim());
    h.service.dispose();
  }, 60_000);

  it('lists a stash\'s files against its base, its untracked files included, with each file\'s patch', async () => {
    const work = makeRepo(folder('stash-view'));
    const { h, repoId } = await open(work);
    write(path.join(work, 'a.txt'), 'changed\n');
    write(path.join(work, 'fresh.txt'), 'fresh\n');
    await h.service.stash(repoId, 'includeUntracked', 'view');
    const [stash] = await rows(h, repoId, 'stashes');
    const diff = await h.service.diffStash(repoId, stash!.hash);
    expect(diff.entries.map((entry) => [entry.change.status, entry.change.path])).toEqual([['MODIFIED', 'a.txt'], ['INDEX_ADDED', 'fresh.txt']]);
    const untracked = await h.service.entryPatch(repoId, diff.left, diff.entries[1]!);
    expect(untracked.kind === 'patch' && untracked.patch).toContain('+fresh');
    const tracked = await h.service.entryPatch(repoId, diff.left, diff.entries[0]!);
    expect(tracked.kind === 'patch' && tracked.patch).toContain('+changed');
    h.service.dispose();
  });

  it('raises artifacts-changed for stashes after the debounce when a terminal stashes or drops, from the paths the watcher reports', async () => {
    const work = makeRepo(folder('stash-watch'));
    const factory = snapshotWatchers();
    const h = harness({ trusted: [work], watchers: factory });
    const events: ScmEvent[] = [];
    h.service.onDidChange((event) => void events.push(event));
    h.service.setProjects([{ key: 'p', path: work }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    await waitFor(() => statusOf(h, repoId), 'a first status');
    const stashed = (): boolean => events.some((event) => event.kind === 'artifacts' && event.repoId === repoId && event.groups.includes('stashes'));
    write(path.join(work, 'a.txt'), 'terminal\n');
    factory.around(() => git(['stash', 'push', '-m', 'terminal'], work));
    await waitFor(stashed, 'artifacts-changed after a terminal stash');
    expect((await rows(h, repoId, 'stashes')).map((stash) => stash.description)).toEqual(['terminal']);
    events.length = 0;
    write(path.join(work, 'a.txt'), 'again\n');
    factory.around(() => git(['stash', 'push', '-m', 'again'], work));
    await waitFor(stashed, 'a second stash');
    events.length = 0;
    // dropping stash@{1} rewrites only logs/refs/stash
    factory.around(() => git(['stash', 'drop', 'stash@{1}'], work));
    await waitFor(stashed, 'artifacts-changed after a terminal drop of stash@{1}');
    expect((await rows(h, repoId, 'stashes')).map((stash) => stash.description)).toEqual(['again']);
    h.service.dispose();
  }, 60_000);

  it('tells the Graph a ref change by the engine from one outside it, and reports none for the watcher\'s echo of refs it already reported', async () => {
    const work = makeRepo(folder('refs-change'));
    const factory = snapshotWatchers();
    const h = harness({ trusted: [work], watchers: factory });
    const events: ScmEvent[] = [];
    h.service.onDidChange((event) => void events.push(event));
    h.service.setProjects([{ key: 'p', path: work }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    await waitFor(() => statusOf(h, repoId), 'a first status');
    const tagsEvent = () => events.find((event) => event.kind === 'artifacts' && event.groups.includes('tags'));
    const branchesEvent = () => events.find((event) => event.kind === 'artifacts' && event.groups.includes('branches'));
    // the first watcher event after the repository opened compares with the refs read when it opened: an echo moves nothing
    const main = path.join(work, '.git', 'refs', 'heads', 'main');
    factory.around(() => fs.writeFileSync(main, fs.readFileSync(main)));
    const first = await waitFor(branchesEvent, 'the first echo');
    expect(first && 'refs' in first ? first.refs : undefined).toBeUndefined();
    events.length = 0;
    // a terminal adds a tag: background
    factory.around(() => git(['tag', 'terminal'], work));
    expect(await waitFor(tagsEvent, 'the terminal\'s tag')).toMatchObject({ refs: 'background' });
    events.length = 0;
    // the engine adds one: engine, and the watcher's echo of it reports no ref change
    await h.service.createTag(repoId, 'engine', '');
    expect(tagsEvent()).toMatchObject({ refs: 'engine' });
    events.length = 0;
    const loose = path.join(work, '.git', 'refs', 'tags', 'engine');
    factory.around(() => fs.writeFileSync(loose, fs.readFileSync(loose)));
    const echo = await waitFor(tagsEvent, 'the echo');
    expect(echo && 'refs' in echo ? echo.refs : undefined).toBeUndefined();
    h.service.dispose();
  }, 60_000);
});

describe.skipIf(!HAS_GIT)('tags', { timeout: 120_000 }, () => {
  it('creates an annotated tag with a message and a lightweight one without, and deletes a tag', async () => {
    const work = makeRepo(folder('tags'));
    const headHash = git(['rev-parse', 'HEAD'], work).trim();
    const { h, repoId, events } = await open(work);
    await h.service.createTag(repoId, 'v1.0', 'Release one\n\nbody');
    await h.service.createTag(repoId, 'light', '');
    expect(git(['cat-file', '-t', 'refs/tags/v1.0'], work).trim()).toBe('tag');
    expect(git(['tag', '-l', '--format=%(contents:subject)', 'v1.0'], work).trim()).toBe('Release one');
    expect(git(['cat-file', '-t', 'refs/tags/light'], work).trim()).toBe('commit');
    const tags = await rows(h, repoId, 'tags');
    expect(tags.find((tag) => tag.name === 'v1.0')).toMatchObject({ annotated: true, commit: { hash: headHash, subject: 'first' } });
    expect(events.some((event) => event.kind === 'artifacts' && event.groups.includes('tags'))).toBe(true);
    await h.service.deleteTag(repoId, 'light');
    expect(refExists(work, 'refs/tags/light')).toBe(false);
    await expect(h.service.createTag(repoId, '-d', '')).rejects.toThrow();
    h.service.dispose();
  });

  it('pushes every tag, lists a bare remote\'s tags once each, and deletes one there', async () => {
    const { work, origin } = tracked('remote-tags');
    git(['tag', 'light'], work);
    git(['tag', '-a', '-m', 'annotated', 'annotated'], work);
    const { h, repoId } = await open(work);
    await h.service.pushTags(repoId);
    expect(git(['tag', '-l'], origin).split('\n').filter(Boolean).sort()).toEqual(['annotated', 'light']);
    const remoteTags = await h.service.remoteTags(repoId, 'origin');
    expect(remoteTags.map((tag) => tag.name).sort()).toEqual(['annotated', 'light']);
    await h.service.deleteRemoteRef(repoId, 'origin', 'refs/tags/annotated');
    expect(git(['tag', '-l'], origin).split('\n').filter(Boolean)).toEqual(['light']);
    expect(refExists(work, 'refs/tags/annotated')).toBe(true);
    h.service.dispose();
  }, 60_000);
});

describe.skipIf(!HAS_GIT)('worktrees', { timeout: 120_000 }, () => {
  it('adds a linked worktree on a new branch and on an existing one, lists them, and removes a dirty one only with force', async () => {
    const work = makeRepo(folder('worktrees'));
    git(['branch', 'existing'], work);
    const { h, repoId } = await open(work);
    const parent = folder('worktree-parent');
    const fresh = path.join(parent, 'fresh');
    const other = path.join(parent, 'other');
    expect(h.service.worktreeFolder(repoId)).toBeUndefined();
    await h.service.addWorktree(repoId, fresh, 'HEAD', 'wt-branch');
    // the first creation is remembered, which VS Code's createWorktree skips
    expect(h.service.worktreeFolder(repoId)).toBe(parent);
    await h.service.addWorktree(repoId, other, 'existing', undefined);
    const worktrees = await rows(h, repoId, 'worktrees');
    expect(worktrees.map((row) => [row.name, row.branch, row.main, row.current])).toEqual([
      [path.basename(work), 'main', true, true],
      ['fresh', 'wt-branch', false, false],
      ['other', 'existing', false, false],
    ]);
    expect(worktrees[1]!.path).toBe(path.normalize(fresh));
    expect(worktrees[1]!.commit?.subject).toBe('first');
    // Delete Worktree's check runs a status in the worktree itself, as git worktree remove checks it
    expect(await h.service.worktreeDirty(repoId, fresh)).toBe(false);
    write(path.join(fresh, 'dirty.txt'), 'dirty\n');
    expect(await h.service.worktreeDirty(repoId, fresh)).toBe(true);
    expect(h.log.filter((line) => line.includes(' status ')).some((line) => line.includes(' -C '))).toBe(false);
    expect(await h.service.removeWorktree(repoId, fresh, false)).toBe('dirty');
    expect(fs.existsSync(fresh)).toBe(true);
    expect(await h.service.removeWorktree(repoId, fresh, true)).toBe('ok');
    expect(fs.existsSync(fresh)).toBe(false);
    expect(await h.service.removeWorktree(repoId, other, false)).toBe('ok');
    expect((await rows(h, repoId, 'worktrees')).map((row) => row.name)).toEqual([path.basename(work)]);
    await expect(h.service.addWorktree(repoId, 'relative/path', 'HEAD', undefined)).rejects.toThrow();
    expect(h.service.worktreeFolder(repoId)).toBe(parent);
    h.service.dispose();
  }, 60_000);

  it('runs no dirty check in a worktree that lies in a project the user has not trusted, which decides as for any folder', async () => {
    const work = makeRepo(folder('worktree-trust'));
    const stranger = folder('worktree-stranger');
    const inside = path.join(stranger, 'wt');
    git(['worktree', 'add', '--quiet', '-b', 'wt', inside], work);
    write(path.join(inside, 'dirty.txt'), 'dirty\n');
    const h = harness({ trusted: [work] });
    h.service.setProjects([{ key: 'p', path: work }, { key: 'q', path: stranger }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    await waitFor(() => statusOf(h, repoId), 'a first status');
    const before = h.log.length;
    await expect(h.service.worktreeDirty(repoId, inside)).rejects.toBeInstanceOf(GitUntrustedError);
    expect(h.log.slice(before)).toEqual([]);
    h.service.dispose();
  }, 60_000);
});
