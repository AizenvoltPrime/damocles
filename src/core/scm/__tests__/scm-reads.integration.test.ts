import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitError, GitQueueDisposedError } from '../git-runner';
import { MAX_MESSAGE_CHARS, PLAIN_COMMIT } from '../repository';
import type { ScmEvent } from '../scm-service';
import { folder, freshStatus, git, harness, HAS_GIT, makeRepo, ready, statusOf, useGitSandbox, viewOf, waitFor, write, type Harness } from './git-harness';

/**
 * Reads against real git: diffs that never write the index, bounded reads of HEAD, MERGE_MSG and the commit template, git's
 * refusals in check-ignore, and the events a closed or removed repository sends.
 */
useGitSandbox();

async function open(name: string): Promise<{ project: string; h: Harness; repoId: string }> {
  const project = makeRepo(folder(name));
  const h = harness({ trusted: [project] });
  h.service.setProjects([{ key: 'p', path: project }]);
  const repoId = (await ready(h)).repos[0]!.repoId;
  await waitFor(() => statusOf(h, repoId), 'a first status');
  return { project, h, repoId };
}

const commitAll = (dir: string, message: string): void => {
  git(['add', '-A'], dir);
  git(['commit', '--quiet', '-m', message], dir);
};

describe.skipIf(!HAS_GIT)('reads against real git', { timeout: 120_000 }, () => {
  it('never rewrites the index from a working-tree diff, the fallback diff against HEAD included', async () => {
    const { project, h, repoId } = await open('diff-index');
    write(path.join(project, 'b.txt'), 'b\n');
    commitAll(project, 'add b');
    write(path.join(project, 'a.txt'), 'changed\n');
    // b.txt is stat-dirty only: a diff that refreshed the index would rewrite its entry
    const past = new Date(Date.now() - 100_000);
    fs.utimesSync(path.join(project, 'b.txt'), past, past);
    await freshStatus(h, repoId);
    const index = path.join(project, '.git', 'index');
    const before = fs.readFileSync(index);
    const repo = h.service.repository(repoId)!.repo;
    expect(await repo.diff('workingTree', 'a.txt')).toMatchObject({ kind: 'patch', patch: expect.stringContaining('+changed') });
    expect((await repo.diffForMessage(30_000)).diff).toContain('+changed');
    expect(fs.readFileSync(index).equals(before)).toBe(true);
    expect(h.log.filter((line) => / diff /.test(line)).every((line) => line.startsWith('> git -c diff.autoRefreshIndex=false diff '))).toBe(true);
    // the probe: git's own diff refreshes it
    git(['diff', '--stat'], project);
    expect(fs.readFileSync(index).equals(before)).toBe(false);
    h.service.dispose();
  });

  it('answers each diff kind: untracked against the null device, binary, renamed in the index, and a merge conflict against HEAD', async () => {
    const { project, h, repoId } = await open('diff-kinds');
    write(path.join(project, 'new.txt'), 'brand new\n');
    fs.writeFileSync(path.join(project, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]));
    git(['add', 'blob.bin'], project);
    git(['mv', 'a.txt', 'moved.txt'], project);
    const status = await freshStatus(h, repoId);
    const repo = h.service.repository(repoId)!.repo;
    expect(await repo.diff('workingTree', 'new.txt')).toMatchObject({ kind: 'patch', patch: expect.stringContaining('+brand new') });
    expect(await repo.diff('index', 'blob.bin')).toEqual({ kind: 'binary' });
    expect(status.groups.index.find((change) => change.path === 'moved.txt')).toMatchObject({ originalPath: 'a.txt', letter: 'R' });
    expect(await repo.diff('index', 'moved.txt')).toMatchObject({ kind: 'patch', patch: expect.stringContaining('rename from a.txt') });
    expect(await repo.diff('workingTree', 'not-listed.txt')).toEqual({ kind: 'missing' });
    h.service.dispose();

    const merge = await open('diff-merge');
    git(['checkout', '--quiet', '-b', 'feature'], merge.project);
    write(path.join(merge.project, 'a.txt'), 'feature\n');
    commitAll(merge.project, 'feature');
    git(['checkout', '--quiet', 'main'], merge.project);
    write(path.join(merge.project, 'a.txt'), 'main\n');
    commitAll(merge.project, 'main');
    expect(() => git(['merge', 'feature'], merge.project)).toThrow();
    await freshStatus(merge.h, merge.repoId);
    const conflict = await merge.h.service.repository(merge.repoId)!.repo.diff('merge', 'a.txt');
    expect(conflict).toMatchObject({ kind: 'patch', patch: expect.stringContaining('+>>>>>>> feature') });
    merge.h.service.dispose();
  });

  it('feeds the diff of every tracked change against HEAD when nothing is staged, and the whole tree on an unborn branch', async () => {
    const { project, h, repoId } = await open('message-fallback');
    write(path.join(project, 'a.txt'), 'unstaged\n');
    await freshStatus(h, repoId);
    expect((await h.service.repository(repoId)!.repo.diffForMessage(30_000)).diff).toContain('+unstaged');
    h.service.dispose();

    const unborn = folder('message-unborn');
    git(['init', '--quiet', '-b', 'main'], unborn);
    write(path.join(unborn, 'first.txt'), 'first\n');
    git(['add', 'first.txt'], unborn);
    const u = harness({ trusted: [unborn] });
    u.service.setProjects([{ key: 'p', path: unborn }]);
    const unbornId = (await ready(u)).repos[0]!.repoId;
    await freshStatus(u, unbornId);
    const repo = u.service.repository(unbornId)!.repo;
    expect((await repo.diffForMessage(30_000)).diff).toContain('+first');
    expect(await repo.subjects(10)).toEqual([]);
    u.service.dispose();
  });

  it('cuts the message diff, HEAD\'s message and MERGE_MSG on a character, never inside a surrogate pair or a UTF-8 sequence', async () => {
    const { project, h, repoId } = await open('cut-chars');
    write(path.join(project, 'a.txt'), `${'x'.repeat(50)}😀 tail\n`);
    git(['add', 'a.txt'], project);
    const repo = h.service.repository(repoId)!.repo;
    const full = (await repo.diffForMessage(1_000_000)).diff;
    const high = full.indexOf('😀');
    const cut = await repo.diffForMessage(high + 1);
    expect(cut).toEqual({ diff: full.slice(0, high), truncated: true });

    git(['reset', '-q'], project);
    fs.writeFileSync(path.join(project, '.git', 'MERGE_HEAD'), `${git(['rev-parse', 'HEAD'], project).trim()}\n`);
    fs.writeFileSync(path.join(project, '.git', 'MERGE_MSG'), `${'m'.repeat(64 * 1024 - 1)}é and more\n`);
    const status = await freshStatus(h, repoId);
    expect(status.operation).toBe('merge');
    expect(status.mergeMessage).toBe('m'.repeat(64 * 1024 - 1));
    h.service.dispose();
  });

  it('keeps status working on a HEAD commit whose message is over a mebibyte, and reads the message up to the box\'s bound', async () => {
    const { project, h, repoId } = await open('huge-head');
    const message = path.join(project, '..', `huge-${Date.now()}.txt`);
    fs.writeFileSync(message, `Huge\n\n${'body line\n'.repeat(150_000)}`);
    write(path.join(project, 'a.txt'), 'huge\n');
    git(['add', 'a.txt'], project);
    git(['commit', '--quiet', '-F', message], project);
    const status = await freshStatus(h, repoId);
    expect(status.commit).toEqual({ hash: git(['rev-parse', 'HEAD'], project).trim(), subject: 'Huge' });
    const head = (await h.service.repository(repoId)!.repo.headCommit())!;
    expect(head.message.length).toBe(MAX_MESSAGE_CHARS);
    expect(head.message.startsWith('Huge\n\nbody line\n')).toBe(true);
    h.service.dispose();
  });

  it('answers what git ignores with a path behind a link, one inside a submodule and a name git cannot take in the list', async (ctx) => {
    const project = makeRepo(folder('ignore-refused'));
    const upstream = makeRepo(folder('ignore-upstream'));
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', upstream, 'sub'], project);
    git(['-c', 'user.name=Seed', '-c', 'user.email=seed@damocles.invalid', 'commit', '--quiet', '-m', 'add sub'], project);
    write(path.join(project, '.gitignore'), '*.log\n');
    fs.mkdirSync(path.join(project, 'real'));
    try {
      fs.symlinkSync(path.join(project, 'real'), path.join(project, 'link'), 'dir');
    } catch (err) {
      // Windows needs Developer Mode or the privilege for a symlink; git takes a junction for a folder
      if ((err as NodeJS.ErrnoException).code === 'EPERM') ctx.skip();
      throw err;
    }
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const root = (await ready(h, 2)).repos.find((repo) => repo.root === project)!;
    await waitFor(() => statusOf(h, root.repoId), 'the status');
    const repo = h.service.repository(root.repoId)!.repo;
    expect(await repo.checkIgnore(['link/a.log', 'b.log', 'sub/x.log', 'bad\\name.log', 'c.txt'])).toEqual(new Set(['b.log']));
    expect(h.log.some((line) => line.includes('check-ignore') && line.endsWith('exit 128'))).toBe(true);
    h.service.dispose();
  });

  it('reads an unreadable commit template as none, logs why, and still answers the history and HEAD\'s message', async () => {
    const { project, h, repoId } = await open('template-unreadable');
    // a link loop: stat fails with ELOOP, which is neither missing nor a file
    fs.symlinkSync(path.join(project, 'loop-b'), path.join(project, 'loop-a'), 'junction');
    fs.symlinkSync(path.join(project, 'loop-a'), path.join(project, 'loop-b'), 'junction');
    git(['config', 'commit.template', 'loop-a'], project);
    write(path.join(project, 'a.txt'), 'edit\n');
    git(['add', 'a.txt'], project);
    expect(await h.service.commit(repoId, 'Kept')).toEqual({ ok: true });
    expect(await h.service.commitInput(repoId)).toEqual({ template: null, history: ['Kept'], headMessage: 'Kept' });
    expect(h.serviceLog.some((line) => line.startsWith('[scm] the commit template could not be read: '))).toBe(true);
    h.service.dispose();
  });

  it.runIf(process.platform !== 'win32')('never opens a commit template that is a FIFO', async () => {
    const { project, h, repoId } = await open('template-fifo');
    execFileSync('mkfifo', [path.join(project, 'fifo')]);
    git(['config', 'commit.template', 'fifo'], project);
    expect((await h.service.commitInput(repoId)).template).toBeNull();
    h.service.dispose();
  });

  it('says there is nothing to commit from git\'s answer, names the subject log\'s argv, and keeps signatures out of the subjects', async () => {
    const { h, repoId } = await open('nothing');
    const repo = h.service.repository(repoId)!.repo;
    expect(await repo.commit('Nothing', PLAIN_COMMIT)).toMatchObject({ ok: false, reason: 'nothingToCommit' });
    expect(await repo.subjects(5)).toEqual(['first']);
    expect(h.log.some((line) => line.startsWith('> git log -n5 --no-color --no-show-signature --format=%s ['))).toBe(true);
    h.service.dispose();
  });

  it('sends a repository event once a repository closes or its project is removed, when the repository is already gone', async () => {
    const project = makeRepo(folder('events'));
    const nested = makeRepo(path.join(project, 'nested'));
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const view = await ready(h, 2);
    const nestedId = view.repos.find((repo) => repo.root === nested)!.repoId;
    const rootId = view.repos.find((repo) => repo.root === project)!.repoId;
    const gone: string[] = [];
    h.service.onDidChange((event: ScmEvent) => {
      if (event.kind === 'repository' && h.service.repository(event.repoId) === undefined) gone.push(event.repoId);
    });
    await h.service.close([nestedId]);
    expect(gone).toEqual([nestedId]);
    h.service.setProjects([]);
    expect(gone).toEqual([nestedId, rootId]);
    h.service.dispose();
  });

  it('closes a repository whose folder was removed under it, and its read rejects as one of a closed repository', async () => {
    const main = makeRepo(folder('removed-main'));
    const worktree = path.join(folder('removed-worktree'), 'wt');
    git(['worktree', 'add', '--quiet', '-b', 'removed', worktree], main);
    const h = harness({ trusted: [worktree] });
    h.service.setProjects([{ key: 'w', path: worktree }]);
    const repoId = (await ready(h, 1, 'w')).repos[0]!.repoId;
    await waitFor(() => statusOf(h, repoId), 'a first status');
    const repo = h.service.repository(repoId)!.repo;
    // a failure in a folder that still exists is git's, and the repository stays open
    await expect(repo.read(['rev-parse', '--verify', 'refs/heads/no-such-branch'])).rejects.toBeInstanceOf(GitError);
    expect(h.service.repository(repoId)).toBeDefined();
    const gone: string[] = [];
    h.service.onDidChange((event: ScmEvent) => {
      if (event.kind === 'repository' && h.service.repository(event.repoId) === undefined) gone.push(event.repoId);
    });
    git(['worktree', 'remove', '--force', worktree], main);
    await expect(h.service.commitInput(repoId)).rejects.toBeInstanceOf(GitQueueDisposedError);
    expect(h.service.repository(repoId)).toBeUndefined();
    expect(gone).toEqual([repoId]);
    expect(viewOf(h, 'w')).toMatchObject({ state: 'noRepository', repos: [] });
    h.service.dispose();
  });
});
