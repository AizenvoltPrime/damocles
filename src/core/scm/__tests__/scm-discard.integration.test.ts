import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitRunner, type GitCloner, type GitRunner } from '../git-runner';
import { parseGitVersion } from '../git-version';
import { GitError } from '../errors';
import { folder, freshStatus, git, GIT_PATH, harness, HAS_GIT, makeRepo, ready, sandbox, statusOf, useGitSandbox, waitFor, write, type Harness } from './git-harness';

/**
 * Discarding a tracked change saves its working copy to the OS trash before git writes the index version, against real git: a
 * file whose trash step fails keeps its changes, an edit that lands after the confirmation is saved too, and git never writes
 * over a file that came back after its trash step.
 */
useGitSandbox();

const BIN = process.platform === 'win32' ? 'Recycle Bin' : 'Trash';
const read = (file: string): string => fs.readFileSync(file, 'utf8');

async function open(project: string, opts: Parameters<typeof harness>[0] = {}): Promise<{ h: Harness; repoId: string }> {
  const h = harness({ trusted: [project], ...opts });
  h.service.setProjects([{ key: 'p', path: project }]);
  const repoId = (await ready(h)).repos[0]!.repoId;
  await waitFor(() => statusOf(h, repoId), 'a first status');
  return { h, repoId };
}

// the working-tree changes once a status that ran after the edits landed
async function listed(h: Harness, repoId: string): Promise<string[]> {
  return (await freshStatus(h, repoId)).groups.workingTree.map((change) => `${change.status} ${change.path}`);
}

function plainRunner(): GitRunner & GitCloner {
  return createGitRunner({ git: { path: GIT_PATH!, version: parseGitVersion(git(['--version'], sandbox))! }, log: { appendLine: () => undefined }, isTrusted: () => true });
}

describe.skipIf(!HAS_GIT)('discarding tracked changes to the trash', { timeout: 120_000 }, () => {
  it('moves the working copy to the trash, then writes the index version, after a question that says where it goes', async () => {
    const project = makeRepo(folder('tracked'));
    write(path.join(project, 'a.txt'), 'changed\n');
    const { h, repoId } = await open(project);
    expect(await listed(h, repoId)).toEqual(['MODIFIED a.txt']);
    h.answers = [0];
    expect(await h.service.discard(repoId, ['a.txt'])).toBe(true);
    expect(h.questions[0]).toMatchObject({ severity: 'danger', message: 'Are you sure you want to discard changes in \'a.txt\'?', detail: `You can restore the changed file from the ${BIN}.`, cancelLabel: 'Cancel' });
    expect(h.questions[0]!.defaultAction).toBeUndefined();
    expect(h.trashed).toEqual([path.join(project, 'a.txt')]);
    expect(read(h.bin[0]!)).toBe('changed\n');
    expect(read(path.join(project, 'a.txt'))).toBe('one\n');
    expect(git(['status', '--porcelain'], project)).toBe('');
    h.service.dispose();
  });

  it('saves an edit that lands after the fresh status re-check, rather than writing over it', async () => {
    const project = makeRepo(folder('late-edit'));
    write(path.join(project, 'a.txt'), 'changed\n');
    const plain = plainRunner();
    let edited = false;
    const runner: GitRunner & GitCloner = {
      ...plain,
      run: async (call) => {
        const result = await plain.run(call);
        // the discard's re-check is the one status that names paths
        if (call.kind === 'status' && call.args.includes('--') && !edited) {
          edited = true;
          write(path.join(project, 'a.txt'), 'outside edit\n');
        }
        return result;
      },
    };
    const { h, repoId } = await open(project, { runner });
    await listed(h, repoId);
    h.answers = [0];
    expect(await h.service.discard(repoId, ['a.txt'])).toBe(true);
    expect(edited).toBe(true);
    expect(read(h.bin[0]!)).toBe('outside edit\n');
    expect(read(path.join(project, 'a.txt'))).toBe('one\n');
    h.service.dispose();
  });

  it('keeps the changes of a file whose trash step fails, discards the others, and names it', async () => {
    const project = makeRepo(folder('trash-fails'));
    write(path.join(project, 'b.txt'), 'b\n');
    git(['add', 'b.txt'], project);
    git(['commit', '--quiet', '-m', 'b'], project);
    write(path.join(project, 'a.txt'), 'kept\n');
    write(path.join(project, 'b.txt'), 'discarded\n');
    const { h, repoId } = await open(project, {
      trash: async (absolute) => {
        if (path.basename(absolute) === 'a.txt') throw new Error('the bin is full');
        fs.rmSync(absolute);
      },
    });
    expect(await listed(h, repoId)).toEqual(['MODIFIED a.txt', 'MODIFIED b.txt']);
    h.answers = [0];
    await expect(h.service.discardAll(repoId, 'tracked')).rejects.toThrow(`'a.txt' could not be moved to the ${BIN}, so its changes were not discarded: the bin is full`);
    expect(h.questions[0]).toMatchObject({ message: 'Are you sure you want to discard ALL changes in 2 files?', detail: `You can restore the changed files from the ${BIN}.` });
    expect(read(path.join(project, 'a.txt'))).toBe('kept\n');
    expect(read(path.join(project, 'b.txt'))).toBe('b\n');
    expect(h.log.filter((line) => line.startsWith('> git checkout-index'))).toEqual([expect.stringMatching(/^> git checkout-index -u -- b\.txt \[/)]);
    h.service.dispose();
  });

  it('never writes over a file that came back after its trash step', async () => {
    const project = makeRepo(folder('came-back'));
    write(path.join(project, 'a.txt'), 'changed\n');
    const { h, repoId } = await open(project, {
      trash: async (absolute) => {
        fs.rmSync(absolute);
        write(absolute, 'written by someone else\n');
      },
    });
    await listed(h, repoId);
    h.answers = [0];
    await expect(h.service.discard(repoId, ['a.txt'])).rejects.toBeInstanceOf(GitError);
    expect(read(path.join(project, 'a.txt'))).toBe('written by someone else\n');
    h.service.dispose();
  });

  it('trashes a folder that took a deleted file\'s place, ignored files and all, before writing the file back', async () => {
    const project = makeRepo(folder('folder-in-place'));
    write(path.join(project, '.gitignore'), '*.log\n');
    git(['add', '.gitignore'], project);
    git(['commit', '--quiet', '-m', 'ignore'], project);
    fs.rmSync(path.join(project, 'a.txt'));
    write(path.join(project, 'a.txt', 'kept.log'), 'ignored work\n');
    const { h, repoId } = await open(project);
    expect(await listed(h, repoId)).toEqual(['DELETED a.txt']);
    h.answers = [0];
    expect(await h.service.discard(repoId, ['a.txt'])).toBe(true);
    expect(h.questions[0]).toMatchObject({ message: 'Are you sure you want to restore \'a.txt\'?' });
    expect(h.questions[0]!.detail).toBeUndefined();
    expect(read(path.join(h.bin[0]!, 'kept.log'))).toBe('ignored work\n');
    expect(read(path.join(project, 'a.txt'))).toBe('one\n');
    h.service.dispose();
  });

  it('restores a deleted file with no trash step', async () => {
    const project = makeRepo(folder('deleted'));
    fs.rmSync(path.join(project, 'a.txt'));
    const { h, repoId } = await open(project);
    expect(await listed(h, repoId)).toEqual(['DELETED a.txt']);
    h.answers = [0];
    expect(await h.service.discard(repoId, ['a.txt'])).toBe(true);
    expect(h.trashed).toEqual([]);
    expect(read(path.join(project, 'a.txt'))).toBe('one\n');
    h.service.dispose();
  });

  it('refuses a tracked file behind a folder link, which git never writes through, and leaves the link\'s target alone', async () => {
    const project = makeRepo(folder('behind-link'));
    write(path.join(project, 'd', 'x.txt'), 'tracked\n');
    git(['add', 'd/x.txt'], project);
    git(['commit', '--quiet', '-m', 'd'], project);
    write(path.join(project, 'e', 'x.txt'), 'elsewhere\n');
    fs.rmSync(path.join(project, 'd'), { recursive: true });
    fs.symlinkSync(path.join(project, 'e'), path.join(project, 'd'), 'junction');
    const { h, repoId } = await open(project);
    // git for Windows reads through a junction (modified); git elsewhere stops at a symlink (deleted)
    expect(await listed(h, repoId)).toContain(process.platform === 'win32' ? 'MODIFIED d/x.txt' : 'DELETED d/x.txt');
    h.answers = [0];
    await expect(h.service.discard(repoId, ['d/x.txt'])).rejects.toThrow(`'x.txt' could not be moved to the ${BIN}, so its changes were not discarded: Refused a path outside the repository`);
    expect(h.trashed).toEqual([]);
    expect(read(path.join(project, 'e', 'x.txt'))).toBe('elsewhere\n');
    h.service.dispose();
  });

  it('trashes an intent-to-add file and writes back its empty placeholder, as git restore does', async () => {
    const project = makeRepo(folder('intent-to-add'));
    write(path.join(project, 'n.txt'), 'new work\n');
    git(['add', '-N', 'n.txt'], project);
    const { h, repoId } = await open(project);
    expect(await listed(h, repoId)).toEqual(['INTENT_TO_ADD n.txt']);
    h.answers = [0];
    expect(await h.service.discard(repoId, ['n.txt'])).toBe(true);
    expect(read(h.bin[0]!)).toBe('new work\n');
    expect(read(path.join(project, 'n.txt'))).toBe('');
    expect(git(['status', '--porcelain'], project)).toBe(' A n.txt\n');
    h.service.dispose();
  });

  it('puts back both sides of an intent-to-rename: the source from the index, the destination trashed and left as its placeholder', async () => {
    const project = makeRepo(folder('intent-to-rename'));
    // unedited, so git pairs the two sides as a rename
    fs.renameSync(path.join(project, 'a.txt'), path.join(project, 'c.txt'));
    git(['add', '-N', 'c.txt'], project);
    const { h, repoId } = await open(project);
    const status = await freshStatus(h, repoId);
    expect(status.groups.workingTree).toEqual([expect.objectContaining({ status: 'INTENT_TO_RENAME', path: 'c.txt', originalPath: 'a.txt' })]);
    h.answers = [0];
    expect(await h.service.discard(repoId, ['c.txt'])).toBe(true);
    expect(h.trashed).toEqual([path.join(project, 'c.txt')]);
    expect(read(h.bin[0]!)).toBe('one\n');
    expect(read(path.join(project, 'a.txt'))).toBe('one\n');
    expect(read(path.join(project, 'c.txt'))).toBe('');
    h.service.dispose();
  });

  it('writes only the destination of a staged rename edited again, whose source the index no longer has', async () => {
    const project = makeRepo(folder('staged-rename'));
    git(['mv', 'a.txt', 'b.txt'], project);
    write(path.join(project, 'b.txt'), 'edited after the rename\n');
    const { h, repoId } = await open(project);
    const status = await freshStatus(h, repoId);
    expect(status.groups.workingTree).toEqual([expect.objectContaining({ status: 'MODIFIED', path: 'b.txt', originalPath: 'a.txt' })]);
    h.answers = [0];
    expect(await h.service.discard(repoId, ['b.txt'])).toBe(true);
    expect(read(h.bin[0]!)).toBe('edited after the rename\n');
    expect(read(path.join(project, 'b.txt'))).toBe('one\n');
    expect(fs.existsSync(path.join(project, 'a.txt'))).toBe(false);
    h.service.dispose();
  });

  it('discards on an unborn branch from the index', async () => {
    const project = folder('unborn');
    git(['init', '--quiet', '-b', 'main'], project);
    write(path.join(project, 'a.txt'), 'staged\n');
    git(['add', 'a.txt'], project);
    write(path.join(project, 'a.txt'), 'edited\n');
    const { h, repoId } = await open(project);
    expect((await freshStatus(h, repoId)).head).toEqual({ type: 'unborn', name: 'main' });
    h.answers = [0];
    expect(await h.service.discard(repoId, ['a.txt'])).toBe(true);
    expect(read(h.bin[0]!)).toBe('edited\n');
    expect(read(path.join(project, 'a.txt'))).toBe('staged\n');
    h.service.dispose();
  });

  it('never trashes an embedded repository that .gitmodules does not list, which is a gitlink in the index', async () => {
    const project = makeRepo(folder('embedded'));
    const embedded = makeRepo(path.join(project, 'emb'));
    git(['add', 'emb'], project);
    git(['commit', '--quiet', '-m', 'emb'], project);
    write(path.join(embedded, 'a.txt'), 'moved on\n');
    git(['commit', '--quiet', '-am', 'moved on'], embedded);
    const { h, repoId } = await open(project);
    await waitFor(() => statusOf(h, repoId)?.groups.workingTree.some((change) => change.path === 'emb') || (h.service.refresh(repoId), false), 'the gitlink change');
    h.answers = [0];
    await h.service.discard(repoId, ['emb']);
    expect(h.trashed).toEqual([]);
    expect(read(path.join(embedded, 'a.txt'))).toBe('moved on\n');
    expect(h.log.some((line) => line.startsWith('> git submodule update --no-fetch -- emb ['))).toBe(true);
    h.service.dispose();
  });
});
