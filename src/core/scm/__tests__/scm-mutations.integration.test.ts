import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMIT_HISTORY_KEY } from '../commit-history';
import { createGitRunner, GitError, parseGitVersion, type GitCloner, type GitRunner } from '../git-runner';
import { SCM_SETTING_KEYS } from '../settings-keys';
import { folder, freshStatus, git, GIT_PATH, harness, HAS_GIT, makeRepo, MapMemento, ready, sandbox, statusOf, useGitSandbox, waitFor, write, type Harness } from './git-harness';

/**
 * Index and ref writes against real git that must act on what the user confirmed: Undo Last Commit and Discard refuse when
 * the repository changed after the question, a submodule is discarded with submodule update, and Continue Rebase stages first.
 */
useGitSandbox();

const commitAll = (dir: string, message: string): void => {
  git(['add', '-A'], dir);
  git(['commit', '--quiet', '-m', message], dir);
};
const headOf = (dir: string): string => git(['rev-parse', 'HEAD'], dir).trim();

// The next question is answered with answer once before has run, as when the repository changes while a dialog is open.
function answerAfter(h: Harness, before: () => Promise<void>, answer: number): void {
  (h as { answers: unknown }).answers = { shift: () => before().then(() => answer) };
}

async function open(name: string, state?: MapMemento): Promise<{ project: string; h: Harness; repoId: string }> {
  const project = makeRepo(folder(name));
  const h = harness({ trusted: [project], ...(state ? { state } : {}) });
  h.service.setProjects([{ key: 'p', path: project }]);
  const repoId = (await ready(h)).repos[0]!.repoId;
  await waitFor(() => statusOf(h, repoId), 'a first status');
  return { project, h, repoId };
}

describe.skipIf(!HAS_GIT)('writes that act on what the user confirmed', { timeout: 120_000 }, () => {
  it('refuses Undo Last Commit when HEAD moved while the merge question was open', async () => {
    const { project, h, repoId } = await open('undo-moved');
    git(['checkout', '--quiet', '-b', 'side'], project);
    write(path.join(project, 'side.txt'), 'side\n');
    commitAll(project, 'side');
    git(['checkout', '--quiet', 'main'], project);
    write(path.join(project, 'main.txt'), 'main\n');
    commitAll(project, 'main');
    git(['merge', '--quiet', '--no-ff', '-m', 'Merge side', 'side'], project);
    let newer = '';
    answerAfter(h, async () => {
      write(path.join(project, 'later.txt'), 'later\n');
      commitAll(project, 'Later');
      newer = headOf(project);
    }, 0);
    await expect(h.service.undoLastCommit(repoId)).rejects.toThrow('The last commit changed after you asked to undo it, so nothing was undone.');
    expect(h.questions[0]!.message).toBe('The last commit was a merge commit. Are you sure you want to undo it?');
    expect(headOf(project)).toBe(newer);
    h.service.dispose();
  });

  it('refuses Undo Last Commit when a commit lands between its read of HEAD and the ref update', async () => {
    const project = makeRepo(folder('undo-race'));
    write(path.join(project, 'a.txt'), 'two\n');
    commitAll(project, 'second');
    const plain = createGitRunner({ git: { path: GIT_PATH!, version: parseGitVersion(git(['--version'], sandbox))! }, log: { appendLine: () => undefined }, isTrusted: () => true });
    let raced = '';
    const runner: GitRunner & GitCloner = {
      ...plain,
      run: (call) => {
        if (call.args.includes('update-ref') && raced === '') {
          write(path.join(project, 'race.txt'), 'race\n');
          commitAll(project, 'Raced');
          raced = headOf(project);
        }
        return plain.run(call);
      },
    };
    const h = harness({ trusted: [project], runner });
    h.service.setProjects([{ key: 'p', path: project }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    await waitFor(() => statusOf(h, repoId), 'a first status');
    await expect(h.service.undoLastCommit(repoId)).rejects.toThrow('The last commit changed after you asked to undo it, so nothing was undone.');
    expect(raced).not.toBe('');
    expect(headOf(project)).toBe(raced);
    expect(git(['log', '--format=%s'], project).trim().split('\n')).toEqual(['Raced', 'second', 'first']);
    expect(git(['status', '--porcelain'], project)).toBe('');
    h.service.dispose();
  });

  it('refuses Undo Last Commit in the middle of a merge, as reset --soft does', async () => {
    const { project, h, repoId } = await open('undo-merging');
    git(['checkout', '--quiet', '-b', 'side'], project);
    write(path.join(project, 'a.txt'), 'side\n');
    commitAll(project, 'side');
    git(['checkout', '--quiet', 'main'], project);
    write(path.join(project, 'a.txt'), 'main\n');
    commitAll(project, 'main');
    expect(() => git(['merge', '--quiet', 'side'], project)).toThrow();
    const head = headOf(project);
    await expect(h.service.undoLastCommit(repoId)).rejects.toThrow('Can\'t undo the last commit while a merge is in progress or files have merge conflicts.');
    expect(headOf(project)).toBe(head);
    h.service.dispose();
  });

  it('never deletes the branch when a first commit it was asked to undo is no longer HEAD', async () => {
    const { project, h, repoId } = await open('undo-first');
    const repo = h.service.repository(repoId)!.repo;
    const first = (await repo.headCommit())!;
    expect(first.parents).toEqual([]);
    write(path.join(project, 'b.txt'), 'b\n');
    commitAll(project, 'second');
    const second = headOf(project);
    expect(await repo.undoCommit(first)).toBe('moved');
    expect(git(['rev-parse', 'main'], project).trim()).toBe(second);
    // the commit it was asked about is still undone while it is HEAD
    expect(await repo.undoCommit((await repo.headCommit())!)).toBe('undone');
    expect(headOf(project)).toBe(first.hash);
    h.service.dispose();
  });

  it('refuses a discard when an untracked file it confirmed became tracked and modified before the answer', async () => {
    const { project, h, repoId } = await open('discard-moved');
    write(path.join(project, 'u.txt'), 'new\n');
    await freshStatus(h, repoId);
    answerAfter(h, async () => {
      commitAll(project, 'track u');
      write(path.join(project, 'u.txt'), 'edited after the question\n');
    }, 0);
    await expect(h.service.discard(repoId, ['u.txt'])).rejects.toThrow('The files changed after you confirmed, so nothing was discarded. Review the changes and try again.');
    expect(fs.readFileSync(path.join(project, 'u.txt'), 'utf8')).toBe('edited after the question\n');
    expect(h.trashed).toEqual([]);
    h.service.dispose();
  });

  it('refuses a discard when a status that ran during the question reclassified the file, and never restores it', async () => {
    const { project, h, repoId } = await open('discard-status');
    write(path.join(project, 'u.txt'), 'new\n');
    await freshStatus(h, repoId);
    answerAfter(h, async () => {
      commitAll(project, 'track u');
      write(path.join(project, 'u.txt'), 'edited after the question\n');
      await h.service.currentStatus(repoId);
    }, 0);
    await expect(h.service.discard(repoId, ['u.txt'])).rejects.toThrow('nothing was discarded');
    expect(fs.readFileSync(path.join(project, 'u.txt'), 'utf8')).toBe('edited after the question\n');
    expect(h.log.some((line) => line.startsWith('> git restore'))).toBe(false);
    h.service.dispose();
  });

  it('refuses a discard of a tracked change that was committed before the answer', async () => {
    const { project, h, repoId } = await open('discard-committed');
    write(path.join(project, 'a.txt'), 'changed\n');
    await freshStatus(h, repoId);
    answerAfter(h, async () => commitAll(project, 'commit a'), 0);
    await expect(h.service.discard(repoId, ['a.txt'])).rejects.toThrow('nothing was discarded');
    expect(h.log.some((line) => line.startsWith('> git restore'))).toBe(false);
    h.service.dispose();
  });

  it('discards tracked files only at the first answer of the mixed question, and every file at the second', async () => {
    const { project, h, repoId } = await open('discard-mixed');
    write(path.join(project, 'a.txt'), 'changed\n');
    write(path.join(project, 'n.txt'), 'new\n');
    await waitFor(() => statusOf(h, repoId)?.groups.workingTree.length === 2 || (h.service.refresh(repoId), false), 'two changes');
    h.answers = [0];
    await freshStatus(h, repoId, () => h.service.discardAll(repoId, 'all'));
    expect(h.questions.at(-1)!.actions).toEqual(['Discard 1 Tracked File', 'Discard All 2 Files']);
    expect(fs.readFileSync(path.join(project, 'a.txt'), 'utf8')).toBe('one\n');
    expect(fs.existsSync(path.join(project, 'n.txt'))).toBe(true);

    write(path.join(project, 'a.txt'), 'changed again\n');
    await freshStatus(h, repoId);
    h.answers = [1];
    await freshStatus(h, repoId, () => h.service.discardAll(repoId, 'all'));
    expect(fs.readFileSync(path.join(project, 'a.txt'), 'utf8')).toBe('one\n');
    expect(fs.existsSync(path.join(project, 'n.txt'))).toBe(false);
    expect(h.trashed).toEqual([path.join(project, 'a.txt'), path.join(project, 'a.txt'), path.join(project, 'n.txt')]);
    expect(h.bin.map((kept) => fs.readFileSync(kept, 'utf8'))).toEqual(['changed\n', 'changed again\n', 'new\n']);
    h.service.dispose();
  });

  it('discards a submodule change with submodule update, back to the commit the superproject records', async () => {
    const project = makeRepo(folder('discard-sub'));
    const upstream = makeRepo(folder('discard-sub-upstream'));
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', upstream, 'sub'], project);
    git(['-c', 'user.name=Seed', '-c', 'user.email=seed@damocles.invalid', 'commit', '--quiet', '-m', 'add sub'], project);
    const recorded = headOf(path.join(project, 'sub'));
    write(path.join(project, 'sub', 'a.txt'), 'moved on\n');
    git(['-c', 'user.name=Seed', '-c', 'user.email=seed@damocles.invalid', 'commit', '--quiet', '-am', 'moved on'], path.join(project, 'sub'));
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const root = (await ready(h, 2)).repos.find((repo) => repo.root === project)!;
    const status = await waitFor(() => (statusOf(h, root.repoId)?.groups.workingTree.length ? statusOf(h, root.repoId) : undefined), 'the submodule change');
    expect(status.groups.workingTree).toEqual([expect.objectContaining({ path: 'sub', status: 'MODIFIED', submodule: true })]);
    h.answers = [0];
    expect(await h.service.discard(root.repoId, ['sub'])).toBe(true);
    expect(headOf(path.join(project, 'sub'))).toBe(recorded);
    expect(h.log.some((line) => line.startsWith('> git submodule update --no-fetch -- sub ['))).toBe(true);
    expect(h.trashed).toEqual([]);
    h.service.dispose();
  });

  it('surfaces git\'s error as the discard\'s when the recorded submodule commit is not there, and fetches nothing', async () => {
    const project = makeRepo(folder('discard-sub-missing'));
    const upstream = makeRepo(folder('discard-sub-missing-upstream'));
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', upstream, 'sub'], project);
    git(['-c', 'user.name=Seed', '-c', 'user.email=seed@damocles.invalid', 'commit', '--quiet', '-m', 'add sub'], project);
    const sub = path.join(project, 'sub');
    // a commit the superproject records that exists upstream only: the submodule's clone never had it
    write(path.join(upstream, 'a.txt'), 'upstream only\n');
    git(['-c', 'user.name=Seed', '-c', 'user.email=seed@damocles.invalid', 'commit', '--quiet', '-am', 'upstream only'], upstream);
    const missing = headOf(upstream);
    git(['update-index', '--cacheinfo', `160000,${missing},sub`], project);
    git(['-c', 'user.name=Seed', '-c', 'user.email=seed@damocles.invalid', 'commit', '--quiet', '-m', 'record missing'], project);
    const before = headOf(sub);
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const root = (await ready(h, 2)).repos.find((repo) => repo.root === project)!;
    await waitFor(() => statusOf(h, root.repoId)?.groups.workingTree.some((change) => change.path === 'sub') || (h.service.refresh(root.repoId), false), 'the submodule change');
    h.answers = [0];
    const error = await h.service.discard(root.repoId, ['sub']).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).stderr).toContain(missing);
    expect(headOf(sub)).toBe(before);
    expect(() => git(['cat-file', '-e', missing], sub)).toThrow();
    h.service.dispose();
  });

  it('clones nothing when a deleted submodule\'s git dir is gone too, and surfaces git\'s refusal', async () => {
    const project = makeRepo(folder('discard-sub-gone'));
    const upstream = makeRepo(folder('discard-sub-gone-upstream'));
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', upstream, 'sub'], project);
    git(['-c', 'user.name=Seed', '-c', 'user.email=seed@damocles.invalid', 'commit', '--quiet', '-m', 'add sub'], project);
    fs.rmSync(path.join(project, 'sub'), { recursive: true, force: true });
    fs.rmSync(path.join(project, '.git', 'modules', 'sub'), { recursive: true, force: true });
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    // no folder, so .gitmodules no longer flags it; the index still records the gitlink
    expect((await freshStatus(h, repoId)).groups.workingTree).toEqual([expect.objectContaining({ path: 'sub', status: 'DELETED' })]);
    h.answers = [0];
    const error = await h.service.discard(repoId, ['sub']).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).stderr).toContain('not allowed');
    expect(fs.existsSync(path.join(project, '.git', 'modules', 'sub'))).toBe(false);
    h.service.dispose();
  });

  it('stages the smart commit inside the mutation before rebase --continue, as VS Code does', async () => {
    const { project, h, repoId } = await open('rebase-smart');
    write(path.join(project, 'a.txt'), 'second\n');
    commitAll(project, 'second');
    const editor = path.join(sandbox, 'sequence-editor.js');
    fs.writeFileSync(editor, "const fs = require('fs'); const f = process.argv[2]; fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^pick/m, 'edit'));\n", 'utf8');
    git(['-c', `sequence.editor="${process.execPath.replace(/\\/g, '/')}" "${editor.replace(/\\/g, '/')}"`, 'rebase', '--quiet', '-i', 'HEAD~1'], project);
    write(path.join(project, 'a.txt'), 'edited during the rebase\n');
    const status = await freshStatus(h, repoId);
    expect(status.operation).toBe('rebase');
    h.settings.values.set(SCM_SETTING_KEYS.enableSmartCommit, true);
    expect(await h.service.commit(repoId, '')).toEqual({ ok: true });
    expect((await freshStatus(h, repoId)).operation).toBeNull();
    expect(git(['show', 'HEAD:a.txt'], project)).toBe('edited during the rebase\n');
    expect(git(['status', '--porcelain'], project).trim()).toBe('');
    h.service.dispose();
  });

  it('remembers every repository closed at once, although each write lands only later', async () => {
    class SlowMemento extends MapMemento {
      override async update(key: string, value: unknown): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await super.update(key, value);
      }
    }
    const project = makeRepo(folder('close-at-once'));
    const first = makeRepo(path.join(project, 'first'));
    const second = makeRepo(path.join(project, 'second'));
    const state = new SlowMemento();
    const h = harness({ trusted: [project], state });
    h.service.setProjects([{ key: 'p', path: project }]);
    const view = await ready(h, 3);
    const idOf = (root: string): string => view.repos.find((repo) => repo.root === root)!.repoId;
    await Promise.all([h.service.close([idOf(first)]), h.service.close([idOf(second)])]);
    const stored = Object.values(state.get<Record<string, string[]>>('damocles.scm.closedRepositories', {}));
    expect(stored).toEqual([[first, second]]);
    h.service.dispose();
  });

  it('reports a commit that landed although its message history could not be written, and logs why', async () => {
    class FailingHistory extends MapMemento {
      override async update(key: string, value: unknown): Promise<void> {
        if (key === COMMIT_HISTORY_KEY) throw new Error('disk full');
        await super.update(key, value);
      }
    }
    const { project, h, repoId } = await open('history-fails', new FailingHistory());
    write(path.join(project, 'a.txt'), 'edit\n');
    git(['add', 'a.txt'], project);
    expect(await h.service.commit(repoId, 'Landed')).toEqual({ ok: true });
    expect(git(['log', '-1', '--format=%s'], project).trim()).toBe('Landed');
    expect(h.serviceLog).toContain('[scm] the commit message history was not saved: disk full');
    h.service.dispose();
  });
});
