import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitRunner, GitUntrustedError } from '../git-runner';
import { PLAIN_COMMIT } from '../repository';
import { SCM_SETTING_KEYS } from '../settings-keys';
import { armFsmonitor, freshStatus, git, GIT_PATH, harness, HAS_GIT, makeRepo, ready, sandbox, statusOf, useGitSandbox, viewOf, waitFor, write } from './git-harness';

/**
 * The nearest registered project above a folder decides whether git runs there, against real git: a repository inside a
 * registered project the user left untrusted never runs its configuration, whichever project found it and whenever it was
 * registered, and a project the user trusted by name runs although a project above it is not trusted.
 */
useGitSandbox();

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));
// the exclusion of the declined project as the Git log quotes it; case-folded on win32 and darwin
const EXCLUDED = /":\(exclude,literal(,icase)?\)declined"/;

function markerIn(name: string): string {
  return path.join(sandbox, `${name}-${Math.random().toString(36).slice(2)}.txt`);
}

describe.skipIf(!HAS_GIT)('the trust of the nearest registered project', { timeout: 120_000 }, () => {
  it('opens no repository inside a registered untrusted project from a trusted outer one, a folder named ..x included', async () => {
    const outer = makeRepo(path.join(sandbox, 'outer-a'));
    const inner = makeRepo(path.join(outer, 'inner'));
    const dotted = makeRepo(path.join(inner, '..x'));
    const innerMarker = markerIn('inner');
    const dottedMarker = markerIn('dotted');
    armFsmonitor(inner, innerMarker);
    armFsmonitor(dotted, dottedMarker);
    const h = harness({ trusted: [outer] });
    h.settings.values.set(SCM_SETTING_KEYS.repositoryScanMaxDepth, 3);
    h.service.setProjects([{ key: 'o', path: outer }, { key: 'i', path: inner }]);
    const view = await ready(h, 1, 'o');
    await waitFor(() => statusOf(h, view.repos[0]!.repoId), 'the outer status');
    await settle();
    expect(viewOf(h, 'o').repos.map((repo) => repo.root)).toEqual([outer]);
    expect(viewOf(h, 'i').state).toBe('untrusted');
    expect(fs.existsSync(innerMarker)).toBe(false);
    expect(fs.existsSync(dottedMarker)).toBe(false);
    expect(await h.service.openFolder('o', dotted).catch((err: Error) => err.message)).toBe('That folder belongs to a project you have not trusted, so source control runs no git there.');
    h.service.dispose();

    // the hooks fire where git does run them
    git(['status'], inner);
    git(['status'], dotted);
    expect(fs.existsSync(innerMarker) && fs.existsSync(dottedMarker)).toBe(true);
  });

  it('stops a nested repository at its next git call once a project registered later, or untrusted, holds it', async () => {
    const outer = makeRepo(path.join(sandbox, 'outer-b'));
    const inner = makeRepo(path.join(outer, 'inner'));
    const marker = markerIn('later');
    armFsmonitor(inner, marker);
    const h = harness({ trusted: [outer] });
    h.service.setProjects([{ key: 'o', path: outer }]);
    const nested = (await ready(h, 2, 'o')).repos.find((repo) => repo.root === inner)!;
    await waitFor(() => statusOf(h, nested.repoId) && fs.existsSync(marker), 'the nested status, which runs the hook');
    fs.rmSync(marker);
    const repo = h.service.repository(nested.repoId)!.repo;

    h.service.setProjects([{ key: 'o', path: outer }, { key: 'i', path: inner }]);
    await expect(repo.status('mixed')).rejects.toBeInstanceOf(GitUntrustedError);
    await waitFor(() => viewOf(h, 'o').repos.length === 1, 'the nested repository leaves the outer view');
    await settle();
    expect(fs.existsSync(marker)).toBe(false);
    h.service.dispose();

    // trusted when found, untrusted afterwards with no event: the gate alone refuses
    const t = harness({ trusted: [outer, inner] });
    t.service.setProjects([{ key: 'o', path: outer }, { key: 'i', path: inner }]);
    const kept = (await ready(t, 2, 'o')).repos.find((candidate) => candidate.root === inner)!;
    await waitFor(() => statusOf(t, kept.repoId), 'the nested status');
    t.trust.revoke(inner);
    if (fs.existsSync(marker)) fs.rmSync(marker);
    await expect(t.service.repository(kept.repoId)!.repo.status('mixed')).rejects.toBeInstanceOf(GitUntrustedError);
    await expect(t.service.repository(kept.repoId)!.repo.headCommit()).rejects.toBeInstanceOf(GitUntrustedError);
    expect(fs.existsSync(marker)).toBe(false);
    t.service.dispose();
  });

  it.runIf(process.platform === 'win32')('matches a project registered through a junction by its realpath (win32)', async () => {
    const outer = makeRepo(path.join(sandbox, 'outer-junction'));
    const inner = makeRepo(path.join(outer, 'inner'));
    const marker = markerIn('junction');
    armFsmonitor(inner, marker);
    const link = path.join(sandbox, 'inner-junction');
    fs.symlinkSync(inner, link, 'junction');
    const h = harness({ trusted: [outer] });
    h.service.setProjects([{ key: 'o', path: outer }, { key: 'i', path: link }]);
    const view = await ready(h, 1, 'o');
    await waitFor(() => statusOf(h, view.repos[0]!.repoId), 'the outer status');
    await settle();
    expect(viewOf(h, 'o').repos.map((repo) => repo.root)).toEqual([outer]);
    expect(fs.existsSync(marker)).toBe(false);
    h.service.dispose();
  });

  it('opens no parent repository whose root is a registered untrusted project, and git does not search up into it', async () => {
    const declined = makeRepo(path.join(sandbox, 'declined-parent'));
    const marker = markerIn('parent');
    armFsmonitor(declined, marker);
    const child = path.join(declined, 'x', 'child');
    write(path.join(child, 'c.txt'), 'c\n');
    const h = harness({ trusted: [child] });
    h.settings.values.set(SCM_SETTING_KEYS.openRepositoryInParentFolders, 'always');
    h.service.setProjects([{ key: 'd', path: declined }, { key: 'c', path: child }]);
    await waitFor(() => viewOf(h, 'c').state === 'noRepository', 'no repository');
    await settle();
    expect(viewOf(h, 'c').parents).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
    // the top-level lookup from the child stops below the untrusted project instead of finding its repository
    const lookup = h.log.find((line) => line.startsWith('> git rev-parse --show-toplevel'));
    expect(lookup).toMatch(/ exit 128$/);
    h.service.dispose();
  });

  it('opens a project the user trusted by name inside a project left untrusted', async () => {
    const declined = makeRepo(path.join(sandbox, 'declined-above'));
    const child = makeRepo(path.join(declined, 'trusted-child'));
    const h = harness({ trusted: [child] });
    h.service.setProjects([{ key: 'd', path: declined }, { key: 'c', path: child }]);
    const view = await ready(h, 1, 'c');
    expect(view.repos.map((repo) => repo.root)).toEqual([child]);
    expect((await freshStatus(h, view.repos[0]!.repoId)).head).toEqual({ type: 'branch', name: 'main' });
    expect(viewOf(h, 'd').state).toBe('untrusted');
    h.service.dispose();
  });

  it('opens no repository whose git dir lies inside a registered untrusted project', async () => {
    const outer = makeRepo(path.join(sandbox, 'outer-gitfile'));
    const declined = path.join(sandbox, 'declined-gitdir');
    fs.mkdirSync(declined);
    const separate = path.join(outer, 'separate');
    fs.mkdirSync(separate);
    git(['init', '--quiet', '-b', 'main', `--separate-git-dir=${path.join(declined, 'sep.git')}`], separate);
    write(path.join(separate, 's.txt'), 's\n');
    const marker = markerIn('gitfile');
    armFsmonitor(separate, marker);
    const h = harness({ trusted: [outer] });
    h.service.setProjects([{ key: 'o', path: outer }, { key: 'd', path: declined }]);
    const view = await ready(h, 1, 'o');
    await waitFor(() => statusOf(h, view.repos[0]!.repoId), 'the outer status');
    await settle();
    expect(viewOf(h, 'o').repos.map((repo) => repo.root)).toEqual([outer]);
    expect(fs.existsSync(marker)).toBe(false);
    h.service.dispose();

    // with nothing registered over its git dir, the same repository opens and runs its hook
    const open = harness({ trusted: [outer] });
    open.service.setProjects([{ key: 'o', path: outer }]);
    const both = await ready(open, 2, 'o');
    await waitFor(() => statusOf(open, both.repos.find((repo) => repo.root === separate)!.repoId), 'the separate status');
    expect(fs.existsSync(marker)).toBe(true);
    open.service.dispose();
  });

  it('enters no embedded repository of a registered untrusted project from a trusted repository\'s status or diff', async () => {
    const outer = makeRepo(path.join(sandbox, 'outer-gitlink'));
    const declined = path.join(outer, 'declined');
    const embedded = makeRepo(path.join(declined, 'embedded'));
    git(['add', 'declined/embedded'], outer);
    git(['-c', 'user.name=Seed', '-c', 'user.email=seed@damocles.invalid', 'commit', '--quiet', '-m', 'gitlink'], outer);
    write(path.join(embedded, 'a.txt'), 'dirty\n');
    write(path.join(outer, 'a.txt'), 'outer change\n');
    const marker = markerIn('gitlink');
    armFsmonitor(embedded, marker);
    const h = harness({ trusted: [outer] });
    h.service.setProjects([{ key: 'o', path: outer }, { key: 'd', path: declined }]);
    const repoId = (await ready(h, 1, 'o')).repos[0]!.repoId;
    const status = await freshStatus(h, repoId);
    expect(status.groups.workingTree.map((change) => change.path)).toEqual(['a.txt']);
    const repo = h.service.repository(repoId)!.repo;
    await repo.diff('workingTree', 'a.txt');
    expect((await repo.diffForMessage(30_000)).diff).toContain('outer change');
    expect(fs.existsSync(marker)).toBe(false);
    const entering = h.log.filter((line) => / (status|diff) --/.test(line));
    expect(entering.length).toBeGreaterThan(0);
    expect(entering.every((line) => line.startsWith('> git -c submodule.recurse=false ') && EXCLUDED.test(line) && !line.includes('ignore-submodules=all'))).toBe(true);
    // whole-tree index writes exclude the untrusted project, which a pathspec of their own would otherwise enter
    await h.service.stageAll(repoId, 'all');
    await h.service.stageAll(repoId, 'tracked');
    await h.service.unstage(repoId, 'all');
    expect(await repo.commit('Nothing staged')).toMatchObject({ ok: false });
    h.settings.values.set(SCM_SETTING_KEYS.enableSmartCommit, true);
    await freshStatus(h, repoId);
    expect(await h.service.commit(repoId, 'Smart')).toEqual({ ok: true });
    expect(git(['show', '--name-only', '--format=', 'HEAD'], outer).trim()).toBe('a.txt');
    await expect(h.service.stage(repoId, ['declined/embedded'])).rejects.toBeInstanceOf(GitUntrustedError);
    await expect(h.service.stage(repoId, ['declined'])).rejects.toBeInstanceOf(GitUntrustedError);
    expect(fs.existsSync(marker)).toBe(false);
    h.service.dispose();

    // an unborn repository with the embedded one staged: unstaging everything leaves it alone
    const unborn = path.join(sandbox, 'unborn-gitlink');
    fs.mkdirSync(unborn);
    git(['init', '--quiet', '-b', 'main'], unborn);
    const unbornDeclined = path.join(unborn, 'declined');
    const unbornEmbedded = makeRepo(path.join(unbornDeclined, 'embedded'));
    write(path.join(unbornEmbedded, 'a.txt'), 'dirty\n');
    git(['add', 'declined/embedded'], unborn);
    armFsmonitor(unbornEmbedded, marker);
    const u = harness({ trusted: [unborn] });
    u.service.setProjects([{ key: 'u', path: unborn }, { key: 'd', path: unbornDeclined }]);
    const unbornId = (await ready(u, 1, 'u')).repos[0]!.repoId;
    expect((await freshStatus(u, unbornId)).head).toEqual({ type: 'unborn', name: 'main' });
    await u.service.unstage(unbornId, 'all');
    expect(git(['ls-files', '--stage'], unborn)).toContain('declined/embedded');
    expect(fs.existsSync(marker)).toBe(false);
    u.service.dispose();

    // the probes: the same status outside the engine enters the embedded repository and runs its hook, and so does a commit
    // with nothing to commit and only the exclusion's fence, which is why commit alone keeps diff.ignoreSubmodules=all
    git(['status', '--porcelain'], outer);
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);
    expect(() => git(['-c', 'submodule.recurse=false', '-c', 'user.useConfigOnly=true', 'commit', '--quiet', '--allow-empty-message', '-m', ''], outer)).toThrow();
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('keeps the exclusions working when the app inherits GIT_LITERAL_PATHSPECS=1, which would switch pathspec magic off', async () => {
    const outer = makeRepo(path.join(sandbox, 'outer-literal-env'));
    const declined = path.join(outer, 'declined');
    const embedded = makeRepo(path.join(declined, 'embedded'));
    git(['add', 'declined/embedded'], outer);
    git(['-c', 'user.name=Seed', '-c', 'user.email=seed@damocles.invalid', 'commit', '--quiet', '-m', 'gitlink'], outer);
    write(path.join(embedded, 'a.txt'), 'dirty\n');
    write(path.join(outer, 'a.txt'), 'outer change\n');
    const marker = markerIn('literal-env');
    armFsmonitor(embedded, marker);
    process.env['GIT_LITERAL_PATHSPECS'] = '1';
    try {
      const h = harness({ trusted: [outer] });
      h.service.setProjects([{ key: 'o', path: outer }, { key: 'd', path: declined }]);
      const repoId = (await ready(h, 1, 'o')).repos[0]!.repoId;
      await waitFor(() => statusOf(h, repoId), 'a first status');
      // a whole-tree add whose exclusion git read as a file name would enter the declined repository
      await h.service.stageAll(repoId, 'all');
      await h.service.unstage(repoId, 'all');
      expect(fs.existsSync(marker)).toBe(false);
      expect((await freshStatus(h, repoId)).groups.workingTree.map((change) => change.path)).toEqual(['a.txt']);
      expect((await h.service.repository(repoId)!.repo.diffForMessage(30_000)).diff).toContain('outer change');
      expect(fs.existsSync(marker)).toBe(false);
      h.service.dispose();
    } finally {
      delete process.env['GIT_LITERAL_PATHSPECS'];
    }
  });

  it('keeps every other submodule\'s changes in a fenced repository, while no fenced call enters the declined one, under submodule.recurse=true', async () => {
    const outer = makeRepo(path.join(sandbox, 'outer-fence'));
    const seed = ['-c', 'user.name=Seed', '-c', 'user.email=seed@damocles.invalid'];
    for (const name of ['declined', 'other']) git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', makeRepo(path.join(sandbox, `up-${name}`)), name], outer);
    write(path.join(outer, 'r.txt'), 'r\n');
    git(['add', 'r.txt'], outer);
    git([...seed, 'commit', '--quiet', '-m', 'submodules'], outer);
    // a user's setting that makes checkout, reset and restore recurse into every submodule
    git(['config', 'submodule.recurse', 'true'], outer);
    const declined = path.join(outer, 'declined');
    write(path.join(declined, 'a.txt'), 'dirty\n');
    write(path.join(outer, 'other', 'a.txt'), 'dirty\n');
    write(path.join(outer, 'a.txt'), 'outer change\n');
    write(path.join(outer, 'b.txt'), 'untracked\n');
    const marker = markerIn('fence');
    armFsmonitor(declined, marker);
    const h = harness({ trusted: [outer] });
    h.service.setProjects([{ key: 'o', path: outer }, { key: 'd', path: declined }]);
    const repoId = (await ready(h, 2, 'o')).repos.find((repo) => repo.root === outer)!.repoId;
    const repo = h.service.repository(repoId)!.repo;
    const listed = async (): Promise<string[]> => (await freshStatus(h, repoId)).groups.workingTree.map((change) => `${change.status} ${change.path}${change.submodule ? ' S' : ''}`);
    expect(await listed()).toEqual(['MODIFIED a.txt', 'MODIFIED other S', 'UNTRACKED b.txt']);

    // reads
    expect(await repo.diff('workingTree', 'a.txt')).toMatchObject({ kind: 'patch' });
    expect(await repo.diff('workingTree', 'other')).toMatchObject({ kind: 'patch' });
    expect(await repo.diff('workingTree', 'b.txt')).toMatchObject({ kind: 'patch' });
    expect((await repo.diffForMessage(30_000)).diff).toContain('outer change');
    expect(await repo.show('HEAD', 'a.txt')).toEqual(Buffer.from('one\n'));
    expect(await repo.checkIgnore(['b.txt', 'declined/a.txt'])).toEqual(new Set());
    expect(await repo.isValidBranchName('fenced')).toBe(true);
    expect(await repo.subjects(1)).toEqual(['submodules']);
    expect(await repo.commitTemplate()).toBeNull();
    // index writes
    await freshStatus(h, repoId, () => h.service.stage(repoId, ['a.txt']));
    expect(await repo.diff('index', 'a.txt')).toMatchObject({ kind: 'patch' });
    await h.service.unstage(repoId, ['a.txt']);
    for (const scope of ['all', 'tracked', 'untracked'] as const) {
      await h.service.stageAll(repoId, scope);
      await h.service.unstage(repoId, 'all');
    }
    await h.service.move(repoId, 'a.txt', 'm.txt');
    await h.service.move(repoId, 'm.txt', 'a.txt');
    // a commit and its failure probes, on a new branch
    expect(await repo.commit('Nothing', PLAIN_COMMIT)).toMatchObject({ ok: false, reason: 'nothingToCommit' });
    expect(await repo.commit('Outer', { ...PLAIN_COMMIT, all: 'tracked', branch: 'fenced' })).toEqual({ ok: true });
    expect(git(['show', '--name-only', '--format=', 'HEAD'], outer).trim()).toBe('a.txt');
    expect(await h.service.undoLastCommit(repoId)).toMatchObject({ kind: 'undone' });
    await h.service.unstage(repoId, 'all');
    // a staged submodule commit is still recorded: the coarse setting only quiets the status commit prints
    git([...seed, 'commit', '--quiet', '--allow-empty', '-m', 'bump'], path.join(outer, 'other'));
    await freshStatus(h, repoId, () => h.service.stage(repoId, ['other']));
    expect(await repo.commit('Bump other', PLAIN_COMMIT)).toEqual({ ok: true });
    expect(git(['show', '--name-only', '--format=', 'HEAD'], outer).trim()).toBe('other');
    expect(await h.service.undoLastCommit(repoId)).toMatchObject({ kind: 'undone' });
    await h.service.unstage(repoId, 'all');
    await h.service.remove(repoId, ['r.txt']);
    await h.service.unstage(repoId, ['r.txt']);
    // discard of every kind: a modified and a deleted file, the other submodule and two untracked files
    write(path.join(outer, 'u.txt'), 'untracked\n');
    expect(await listed()).toEqual(['MODIFIED a.txt', 'MODIFIED other S', 'DELETED r.txt', 'UNTRACKED b.txt', 'UNTRACKED u.txt']);
    h.answers = [1];
    expect(await h.service.discardAll(repoId, 'all')).toBe(true);
    expect(fs.readFileSync(path.join(outer, 'a.txt'), 'utf8')).toBe('one\n');
    expect(fs.readFileSync(path.join(outer, 'r.txt'), 'utf8')).toBe('r\n');
    expect(fs.existsSync(marker)).toBe(false);
    expect(h.log.some((line) => / submodule update --no-fetch -- other \[/.test(line))).toBe(true);
    // merge and cherry-pick aborts, which reset the work tree with no pathspec; the test's own git may enter, the engine's never
    git(['checkout', '--quiet', '-b', 'side'], outer);
    write(path.join(outer, 'a.txt'), 'side\n');
    git([...seed, 'commit', '--quiet', '-am', 'side'], outer);
    git(['checkout', '--quiet', 'fenced'], outer);
    write(path.join(outer, 'a.txt'), 'main\n');
    git([...seed, 'commit', '--quiet', '-am', 'main'], outer);
    if (fs.existsSync(marker)) fs.rmSync(marker);
    for (const start of [['merge', 'side'], ['cherry-pick', 'side']]) {
      expect(() => git([...seed, ...start], outer)).toThrow();
      if (fs.existsSync(marker)) fs.rmSync(marker);
      expect((await freshStatus(h, repoId)).operation).toBe(start[0] === 'merge' ? 'merge' : 'cherryPick');
      await h.service.abortOperation(repoId);
      expect(fs.existsSync(marker)).toBe(false);
      expect((await freshStatus(h, repoId)).operation).toBeNull();
    }
    // rebase --continue, which commits and checks out with no pathspec
    const editor = path.join(sandbox, 'fence-sequence-editor.js');
    fs.writeFileSync(editor, "const fs = require('fs'); const f = process.argv[2]; fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^pick/m, 'edit'));\n", 'utf8');
    git(['-c', `sequence.editor="${process.execPath.replace(/\\/g, '/')}" "${editor.replace(/\\/g, '/')}"`, 'rebase', '--quiet', '-i', 'HEAD~1'], outer);
    // a staged change at the stop makes the sequencer run a child git commit with an editor
    write(path.join(outer, 'a.txt'), 'edited during the rebase\n');
    git(['add', 'a.txt'], outer);
    if (fs.existsSync(marker)) fs.rmSync(marker);
    expect((await freshStatus(h, repoId)).operation).toBe('rebase');
    expect(await repo.commit('', PLAIN_COMMIT)).toEqual({ ok: true });
    expect(git(['show', 'HEAD:a.txt'], outer)).toBe('edited during the rebase\n');
    expect((await freshStatus(h, repoId)).operation).toBeNull();
    expect(fs.existsSync(marker)).toBe(false);
    const pathspecCalls = h.log.filter((line) => / (status|diff|add|reset|rm|restore|ls-files) /.test(line) && !line.includes('--no-index') && line.includes(' -c submodule.recurse=false '));
    expect(pathspecCalls.length).toBeGreaterThan(10);
    expect(pathspecCalls.every((line) => EXCLUDED.test(line))).toBe(true);
    expect(h.log.some((line) => line.includes('--ignore-submodules=all'))).toBe(false);
    h.service.dispose();

    // the probe: the same abort without the fence recurses into the declined submodule and runs its hook
    expect(() => git([...seed, 'merge', 'side'], outer)).toThrow();
    if (fs.existsSync(marker)) fs.rmSync(marker);
    git(['merge', '--abort'], outer);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('enters no declined submodule from the engine\'s stash, checkout, branch, merge, tag and worktree calls', async () => {
    const outer = makeRepo(path.join(sandbox, 'outer-refs'));
    const seed = ['-c', 'user.name=Seed', '-c', 'user.email=seed@damocles.invalid'];
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', makeRepo(path.join(sandbox, 'up-refs-declined')), 'declined'], outer);
    git([...seed, 'commit', '--quiet', '-m', 'submodule'], outer);
    git(['config', 'submodule.recurse', 'true'], outer);
    git(['branch', 'side'], outer);
    const declined = path.join(outer, 'declined');
    write(path.join(declined, 'a.txt'), 'dirty\n');
    const marker = markerIn('refs-fence');
    armFsmonitor(declined, marker);
    const h = harness({ trusted: [outer] });
    h.service.setProjects([{ key: 'o', path: outer }, { key: 'd', path: declined }]);
    const repoId = (await ready(h, 1, 'o')).repos.find((repo) => repo.root === outer)!.repoId;
    await waitFor(() => statusOf(h, repoId), 'a first status');
    const check = (step: string): void => expect(fs.existsSync(marker), step).toBe(false);
    const stashed = async () => {
      const artifacts = await h.service.artifacts(repoId, 'stashes');
      return artifacts.group === 'stashes' ? artifacts.rows : [];
    };
    check('before');
    write(path.join(outer, 'a.txt'), 'stashed\n');
    expect(await h.service.stash(repoId, 'default', 'one')).toBe('ok');
    check('push');
    write(path.join(outer, 'u.txt'), 'untracked\n');
    expect(await h.service.stash(repoId, 'includeUntracked', 'two')).toBe('ok');
    check('push -u');
    const [two, one] = await stashed();
    expect(await h.service.stashApply(repoId, { index: 1, hash: one!.hash }, false)).toBe('ok');
    check('apply');
    git(['checkout', '--quiet', '--', 'a.txt'], outer);
    expect(await h.service.stashApply(repoId, { index: 0, hash: two!.hash }, true)).toBe('ok');
    check('pop');
    expect((await h.service.diffStash(repoId, one!.hash)).entries.map((entry) => entry.change.path)).toEqual(['a.txt']);
    expect(await h.service.stashDrop(repoId, { index: 0, hash: one!.hash })).toBe('ok');
    check('drop');
    fs.rmSync(path.join(outer, 'u.txt'));
    expect(await h.service.checkout(repoId, { kind: 'branch', name: 'side' })).toBe('ok');
    check('checkout');
    await h.service.createBranch(repoId, 'made', 'HEAD');
    check('branch');
    expect(await h.service.integrate(repoId, 'merge', 'side')).toBe('ok');
    check('merge');
    await h.service.createTag(repoId, 'v1', 'annotated');
    check('tag');
    for (const group of ['branches', 'remoteBranches', 'tags', 'worktrees'] as const) await h.service.artifacts(repoId, group);
    check('artifacts');
    const worktree = path.join(sandbox, 'refs-fence-worktree');
    await h.service.addWorktree(repoId, worktree, 'HEAD', 'wt');
    check('worktree add');
    expect(await h.service.removeWorktree(repoId, worktree, false)).toBe('ok');
    expect(fs.existsSync(marker)).toBe(false);
    h.service.dispose();

    // the probes: a stash push without the exclusion, and an apply without --quiet, run a status inside the declined
    // submodule, which runs its hook
    write(path.join(outer, 'a.txt'), 'probe\n');
    if (fs.existsSync(marker)) fs.rmSync(marker);
    git(['-c', 'submodule.recurse=false', 'stash', 'push', '--quiet'], outer);
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);
    git(['-c', 'submodule.recurse=false', 'stash', 'apply'], outer);
    expect(fs.existsSync(marker)).toBe(true);
  });

  const nestings = [
    ['submodule', 'a submodule of the trusted submodule sub'],
    ['plain', 'a plain repository inside the trusted submodule sub'],
    ['two levels', 'a submodule of inner, a submodule of the trusted submodule sub'],
  ] as const;
  for (const [nesting, label] of nestings) {
    it(`enters no declined project that is ${label} from status, diff, add, commit, stash push or the engine's fenced stash`, async () => {
      const seed = ['-c', 'user.name=Seed', '-c', 'user.email=seed@damocles.invalid'];
      const tag = nesting.replace(' ', '-');
      const addSubmodule = (parent: string, relative: string): string => {
        git(['submodule', 'add', '--quiet', makeRepo(path.join(sandbox, `up-nested-${tag}-${relative}`)), relative], parent);
        git([...seed, 'commit', '--quiet', '-m', `add ${relative}`], parent);
        return path.join(parent, relative);
      };
      const outer = makeRepo(path.join(sandbox, `outer-nested-${tag}`));
      const sub = addSubmodule(outer, 'sub');
      let declined: string;
      if (nesting === 'submodule') declined = addSubmodule(sub, 'declined');
      else if (nesting === 'plain') declined = makeRepo(path.join(sub, 'declined'));
      else {
        const inner = addSubmodule(sub, 'inner');
        declined = addSubmodule(inner, 'declined');
        git(['add', 'inner'], sub);
        git([...seed, 'commit', '--quiet', '-m', 'bump inner'], sub);
      }
      if (nesting !== 'plain') {
        git(['add', 'sub'], outer);
        git([...seed, 'commit', '--quiet', '-m', 'bump sub'], outer);
      }
      git(['checkout', '--quiet', '-b', 'side'], outer);
      write(path.join(outer, 's.txt'), 's\n');
      git(['add', 's.txt'], outer);
      git([...seed, 'commit', '--quiet', '-m', 'side'], outer);
      git(['checkout', '--quiet', 'main'], outer);
      // main moves on, so the merge is a real one, whose stash create checks every gitlink
      write(path.join(outer, 'm.txt'), 'm\n');
      git(['add', 'm.txt'], outer);
      git([...seed, 'commit', '--quiet', '-m', 'main'], outer);
      git(['config', 'submodule.recurse', 'true'], outer);
      // a per-name setting that git applies over diff.ignoreSubmodules=all, so commit's printed status would enter sub
      git(['config', 'submodule.sub.ignore', 'none'], outer);
      write(path.join(declined, 'a.txt'), 'dirty\n');
      write(path.join(sub, 'a.txt'), 'dirty\n');
      write(path.join(outer, 'a.txt'), 'outer change\n');
      const marker = markerIn(`nested-${tag}`);
      armFsmonitor(declined, marker);
      const h = harness({ trusted: [outer] });
      h.service.setProjects([{ key: 'o', path: outer }, { key: 'd', path: declined }]);
      const repoId = (await ready(h, 1, 'o')).repos.find((repo) => repo.root === outer)!.repoId;
      const repo = h.service.repository(repoId)!.repo;
      const check = (step: string): void => expect(fs.existsSync(marker), step).toBe(false);
      const listed = (await freshStatus(h, repoId)).groups.workingTree.map((change) => change.path);
      await waitFor(() => viewOf(h, 'o').repos.every((found) => statusOf(h, found.repoId)), 'every status');
      check('status');
      // sub's changes show in sub's own repository, never as a change of the outer one
      expect(listed).toEqual(['a.txt']);
      expect((await repo.diffForMessage(30_000)).diff).toContain('outer change');
      check('diff');
      await h.service.stageAll(repoId, 'all');
      await h.service.unstage(repoId, 'all');
      check('add');
      expect(await repo.commit('Nothing', PLAIN_COMMIT)).toMatchObject({ ok: false, reason: 'nothingToCommit' });
      check('commit with nothing staged');
      expect(await h.service.stash(repoId, 'default', 'one')).toBe('ok');
      check('stash push');
      const artifacts = await h.service.artifacts(repoId, 'stashes');
      const [one] = artifacts.group === 'stashes' ? artifacts.rows : [];
      expect(await h.service.stashApply(repoId, { index: 0, hash: one!.hash }, true)).toBe('ok');
      check('stash pop');
      expect(await h.service.integrate(repoId, 'merge', 'side')).toBe('ok');
      check('merge after the fenced stash');
      expect(fs.readFileSync(path.join(outer, 'a.txt'), 'utf8')).toBe('outer change\n');
      expect(await repo.commit('Outer', { ...PLAIN_COMMIT, all: 'tracked' })).toEqual({ ok: true });
      check('commit');
      expect(git(['show', '--name-only', '--format=', 'HEAD'], outer).trim()).toBe('a.txt');
      await expect(h.service.stage(repoId, ['sub'])).rejects.toBeInstanceOf(GitUntrustedError);
      check('refused stage');
      h.service.dispose();
    });
  }
});

describe.skipIf(!HAS_GIT)('a registered project whose realpath is still pending', { timeout: 120_000 }, () => {
  // link is never created: the injected realpath alone says where it leads, once the test resolves it
  function pendingAt(link: string): { realpath: (folder: string) => Promise<string>; resolve: (real: string) => void } {
    let resolve: (real: string) => void = () => undefined;
    const pending = new Promise<string>((done) => (resolve = done));
    return { realpath: (folder) => (folder === link ? pending : fs.promises.realpath(folder)), resolve: (real) => resolve(real) };
  }

  it('discovers nothing until it settles, then leaves out the repository it resolved to', async () => {
    const outer = makeRepo(path.join(sandbox, 'outer-pending-discovery'));
    const inner = makeRepo(path.join(outer, 'inner'));
    const marker = markerIn('pending-discovery');
    armFsmonitor(inner, marker);
    const link = path.join(sandbox, 'pending-discovery-link');
    const pending = pendingAt(link);
    const h = harness({ trusted: [outer], realpath: pending.realpath });
    h.service.setProjects([{ key: 'o', path: outer }, { key: 'l', path: link }]);
    await settle();
    expect(viewOf(h, 'o').state).toBe('loading');
    expect(h.log).toEqual([]);
    pending.resolve(inner);
    const view = await ready(h, 1, 'o');
    await waitFor(() => statusOf(h, view.repos[0]!.repoId), 'the outer status');
    await settle();
    expect(viewOf(h, 'o').repos.map((repo) => repo.root)).toEqual([outer]);
    expect(fs.existsSync(marker)).toBe(false);
    h.service.dispose();
  });

  it('holds a git call until it settles, then refuses the call inside the untrusted project it resolved to', async () => {
    const outer = makeRepo(path.join(sandbox, 'outer-pending-call'));
    const inner = makeRepo(path.join(outer, 'inner'));
    const marker = markerIn('pending-call');
    armFsmonitor(inner, marker);
    const link = path.join(sandbox, 'pending-call-link');
    const pending = pendingAt(link);
    const h = harness({ trusted: [outer], realpath: pending.realpath });
    h.service.setProjects([{ key: 'o', path: outer }]);
    const view = await ready(h, 2, 'o');
    for (const repo of view.repos) await waitFor(() => statusOf(h, repo.repoId), 'each status');
    await waitFor(() => fs.existsSync(marker), 'the nested status, which runs the hook');
    await settle();
    fs.rmSync(marker);
    const repo = h.service.repository(view.repos.find((candidate) => candidate.root === inner)!.repoId)!.repo;

    h.service.setProjects([{ key: 'o', path: outer }, { key: 'l', path: link }]);
    const spawned = h.log.length;
    let outcome: unknown;
    const call = repo.status('mixed').then(() => 'ran', (err: unknown) => err);
    void call.then((value) => (outcome = value));
    await settle();
    expect(outcome).toBeUndefined();
    expect(h.log.length).toBe(spawned);
    pending.resolve(inner);
    expect(await call).toBeInstanceOf(GitUntrustedError);
    await waitFor(() => viewOf(h, 'o').repos.length === 1, 'the nested repository leaves the outer view');
    await settle();
    expect(fs.existsSync(marker)).toBe(false);
    h.service.dispose();
  });

  it('releases the calls waiting on it when its project is removed', async () => {
    const project = makeRepo(path.join(sandbox, 'pending-removed'));
    const never = path.join(sandbox, 'pending-removed-link');
    const h = harness({ trusted: [project], realpath: pendingAt(never).realpath });
    h.service.setProjects([{ key: 'p', path: project }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    await waitFor(() => statusOf(h, repoId), 'a first status');
    h.service.setProjects([{ key: 'p', path: project }, { key: 'n', path: never }]);
    let done = false;
    const head = h.service.repository(repoId)!.repo.headCommit().finally(() => (done = true));
    await settle();
    expect(done).toBe(false);
    h.service.setProjects([{ key: 'p', path: project }]);
    expect((await head)?.message).toBe('first');
    h.service.dispose();
  });
});

describe.skipIf(!HAS_GIT)('the trust fence around merges, rebases and every autostash', { timeout: 180_000 }, () => {
  const seed = ['-c', 'user.name=Seed', '-c', 'user.email=seed@damocles.invalid'];
  let count = 0;

  // A dirty tree around the armed, dirty, declined submodule; local: main has its own commit, so merges are real merges.
  function fencedClone(local: boolean): { outer: string; declined: string; marker: string } {
    const name = `fenced-${++count}`;
    const upDeclined = makeRepo(path.join(sandbox, `${name}-up-declined`));
    const origin = path.join(sandbox, `${name}-origin.git`);
    git(['init', '--quiet', '--bare', '-b', 'main', origin], sandbox);
    const author = makeRepo(path.join(sandbox, `${name}-author`));
    write(path.join(author, 'b.txt'), 'b\n');
    git(['add', 'b.txt'], author);
    git(['submodule', 'add', '--quiet', upDeclined, 'declined'], author);
    git([...seed, 'commit', '--quiet', '-m', 'base'], author);
    git(['push', '--quiet', origin, 'main'], author);
    const outer = path.join(sandbox, `${name}-outer`);
    git(['clone', '--quiet', '--recurse-submodules', origin, outer], sandbox);
    git(['config', 'user.email', 'tests@damocles.invalid'], outer);
    git(['config', 'user.name', 'Damocles Tests'], outer);
    // git 2.33 and later refuse to pull divergent branches until this is set
    git(['config', 'pull.rebase', 'false'], outer);
    write(path.join(author, 'z.txt'), 'z\n');
    git(['add', 'z.txt'], author);
    git([...seed, 'commit', '--quiet', '-m', 'upstream z'], author);
    git(['push', '--quiet', origin, 'main'], author);
    git(['checkout', '--quiet', '-b', 'side'], outer);
    write(path.join(outer, 's.txt'), 's\n');
    git(['add', 's.txt'], outer);
    git([...seed, 'commit', '--quiet', '-m', 'side s'], outer);
    git(['checkout', '--quiet', 'main'], outer);
    if (local) {
      write(path.join(outer, 'c.txt'), 'c\n');
      git(['add', 'c.txt'], outer);
      git([...seed, 'commit', '--quiet', '-m', 'local c'], outer);
    }
    write(path.join(outer, 'a.txt'), 'dirty\n');
    const declined = path.join(outer, 'declined');
    write(path.join(declined, 'a.txt'), 'dirty\n');
    const marker = markerIn(name);
    armFsmonitor(declined, marker);
    return { outer: fs.realpathSync.native(outer), declined: fs.realpathSync.native(declined), marker };
  }

  async function openFenced(outer: string, declined: string): Promise<{ h: ReturnType<typeof harness>; repoId: string }> {
    const h = harness({ trusted: [outer] });
    h.settings.values.set(SCM_SETTING_KEYS.confirmSync, false);
    h.service.setProjects([{ key: 'o', path: outer }, { key: 'd', path: declined }]);
    const repoId = (await ready(h, 1, 'o')).repos.find((repo) => repo.root === outer)!.repoId;
    await waitFor(() => statusOf(h, repoId), 'a first status');
    return { h, repoId };
  }

  type Operation = 'pull merge' | 'pull merge ff' | 'pull rebase' | 'pull with pull.rebase' | 'sync merge' | 'sync rebase' | 'merge' | 'rebase';
  const operations: ReadonlyArray<readonly [Operation, boolean]> = [
    ['pull merge', true],
    ['pull merge ff', false],
    ['pull rebase', true],
    ['pull with pull.rebase', true],
    ['sync merge', true],
    ['sync rebase', true],
    ['merge', true],
    ['rebase', true],
  ];

  async function run(h: ReturnType<typeof harness>, repoId: string, operation: Operation): Promise<unknown> {
    switch (operation) {
      case 'pull merge':
      case 'pull merge ff':
      case 'pull with pull.rebase':
        return h.service.pull(repoId, { rebase: false });
      case 'pull rebase':
        return h.service.pull(repoId, { rebase: true });
      case 'sync merge':
        return h.service.sync(repoId, false);
      case 'sync rebase':
        return h.service.sync(repoId, true);
      case 'merge':
        return h.service.integrate(repoId, 'merge', 'side');
      case 'rebase':
        return h.service.integrate(repoId, 'rebase', 'side');
    }
  }

  for (const [operation, local] of operations) {
    for (const autostash of ['every autostash setting on', 'no autostash'] as const) {
      it(`enters no declined submodule from ${operation} on a dirty tree with ${autostash}, and keeps the changes`, async () => {
        const { outer, declined, marker } = fencedClone(local);
        if (operation === 'pull with pull.rebase') git(['config', 'pull.rebase', 'true'], outer);
        // a per-name setting that a real merge's stash create applies over diff.ignoreSubmodules, so it would check declined
        git(['config', 'submodule.declined.ignore', 'none'], outer);
        if (autostash === 'every autostash setting on') for (const key of ['rebase.autoStash', 'merge.autoStash', 'pull.autoStash']) git(['config', key, 'true'], outer);
        const { h, repoId } = await openFenced(outer, declined);
        h.settings.values.set(SCM_SETTING_KEYS.autoStash, autostash === 'every autostash setting on');
        if (fs.existsSync(marker)) fs.rmSync(marker);
        await run(h, repoId, operation);
        expect(fs.existsSync(marker)).toBe(false);
        expect(fs.readFileSync(path.join(outer, 'a.txt'), 'utf8')).toBe('dirty\n');
        expect(fs.existsSync(path.join(outer, operation === 'merge' || operation === 'rebase' ? 's.txt' : 'z.txt'))).toBe(true);
        expect(git(['stash', 'list'], outer)).toBe('');
        expect(h.log.some((line) => line.includes('--autostash'))).toBe(false);
        const started = h.log.filter((line) => /^> git (-c \S+ )*(pull|merge|rebase) /.test(line));
        expect(started.length).toBeGreaterThan(0);
        expect(started.every((line) => [' -c rebase.autoStash=false ', ' -c merge.autoStash=false ', ' -c pull.autoStash=false '].every((setting) => line.includes(setting)))).toBe(true);
        expect(h.log.some((line) => / stash push -- ":\(exclude,literal(,icase)?\)declined" \[/.test(line))).toBe(true);
        h.service.dispose();
      });
    }
  }

  it('probes: on the same dirty tree git itself enters the declined submodule for a real merge, a pull with pull.autoStash and a rebase with rebase.autoStash', () => {
    const fence = ['-c', 'submodule.recurse=false'];
    const probes: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['a real merge, which stashes with stash create', [...fence, '-c', 'merge.autoStash=false', 'merge', 'side']],
      ['a real merge pull', [...fence, '-c', 'merge.autoStash=false', 'pull', '--no-rebase', 'origin', 'main']],
      ['pull.autoStash over rebase.autoStash=false', [...fence, '-c', 'pull.autoStash=true', '-c', 'rebase.autoStash=false', '-c', 'merge.autoStash=false', 'pull', '-r', 'origin', 'main']],
      ['rebase.autoStash', [...fence, '-c', 'rebase.autoStash=true', 'rebase', 'side']],
    ];
    for (const [label, args] of probes) {
      const { outer, marker } = fencedClone(true);
      if (fs.existsSync(marker)) fs.rmSync(marker);
      git(args as string[], outer);
      expect(fs.existsSync(marker), label).toBe(true);
    }
  });

  it('refuses a merge, rebase or pull that starts without the engine\'s fenced stash, and any --autostash, but never an abort', async () => {
    const { outer, declined, marker } = fencedClone(true);
    const { h, repoId } = await openFenced(outer, declined);
    const repo = h.service.repository(repoId)!.repo;
    for (const args of [['merge', 'side'], ['rebase', 'side'], ['pull'], ['merge', '--no-ff', 'side']]) await expect(repo.write(args), args.join(' ')).rejects.toBeInstanceOf(GitUntrustedError);
    const marked = repo.withStash(() => 'fenced', async (git, slot) => {
      await slot.stash();
      return git(['merge', '--autostash', 'side']);
    });
    expect((await marked).result).toMatchObject({ ok: false, error: expect.any(GitUntrustedError) });
    // no merge is in progress, so git itself refuses the abort
    await expect(repo.write(['merge', '--abort'])).rejects.not.toBeInstanceOf(GitUntrustedError);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(path.join(outer, 'a.txt'), 'utf8')).toBe('dirty\n');
    h.service.dispose();
  });

  it('applies a pending MERGE_AUTOSTASH on Abort and on the merge commit without entering the declined submodule', async () => {
    for (const end of ['abort', 'commit'] as const) {
      const { outer, declined, marker } = fencedClone(true);
      write(path.join(outer, 's.txt'), 'clash\n');
      git(['add', 's.txt'], outer);
      git([...seed, 'commit', '--quiet', '-m', 'clash'], outer);
      // the terminal's own merge stashes and enters the submodule, which is no engine call
      expect(() => git(['merge', '--autostash', 'side'], outer)).toThrow();
      expect(fs.existsSync(path.join(outer, '.git', 'MERGE_AUTOSTASH'))).toBe(true);
      if (fs.existsSync(marker)) fs.rmSync(marker);
      const { h, repoId } = await openFenced(outer, declined);
      expect((await freshStatus(h, repoId)).operation).toBe('merge');
      if (end === 'abort') await h.service.abortOperation(repoId);
      else {
        write(path.join(outer, 's.txt'), 'resolved\n');
        git(['add', 's.txt'], outer);
        await freshStatus(h, repoId);
        expect(await h.service.repository(repoId)!.repo.commit('Merge side')).toEqual({ ok: true });
      }
      expect(fs.existsSync(marker), end).toBe(false);
      expect(fs.readFileSync(path.join(outer, 'a.txt'), 'utf8'), end).toBe('dirty\n');
      h.service.dispose();
    }
  });

  it('applies a pending rebase autostash on Abort and on Continue Rebase without entering the declined submodule', async () => {
    for (const end of ['abort', 'continue'] as const) {
      const { outer, declined, marker } = fencedClone(true);
      write(path.join(outer, 's.txt'), 'clash\n');
      git(['add', 's.txt'], outer);
      git([...seed, 'commit', '--quiet', '-m', 'clash'], outer);
      expect(() => git(['rebase', '--autostash', 'side'], outer)).toThrow();
      expect(fs.existsSync(path.join(outer, '.git', 'rebase-merge', 'autostash'))).toBe(true);
      if (fs.existsSync(marker)) fs.rmSync(marker);
      const { h, repoId } = await openFenced(outer, declined);
      expect((await freshStatus(h, repoId)).operation).toBe('rebase');
      if (end === 'abort') await h.service.abortOperation(repoId);
      else {
        write(path.join(outer, 's.txt'), 'resolved\n');
        git(['add', 's.txt'], outer);
        await freshStatus(h, repoId);
        expect(await h.service.repository(repoId)!.repo.commit('', PLAIN_COMMIT)).toEqual({ ok: true });
      }
      expect(fs.existsSync(marker), end).toBe(false);
      expect(fs.readFileSync(path.join(outer, 'a.txt'), 'utf8'), end).toBe('dirty\n');
      expect((await freshStatus(h, repoId)).operation).toBeNull();
      h.service.dispose();
    }
  });

  // the GIT_TRACE lines of each process git started inside a folder named declined
  function enteredDeclined(trace: string): string[] {
    return fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split('\n').filter((line) => /run_command: cd (\S*\/)?declined[;/ ]/.test(line)) : [];
  }

  async function traced<T>(trace: string, action: () => Promise<T>): Promise<T> {
    process.env['GIT_TRACE'] = trace;
    try {
      return await action();
    } finally {
      delete process.env['GIT_TRACE'];
    }
  }

  const statusSettings: ReadonlyArray<readonly [string, (outer: string) => void]> = [
    ['status.submoduleSummary=true', (outer) => git(['config', 'status.submoduleSummary', 'true'], outer)],
    ['submodule.declined.ignore=none in .git/config', (outer) => git(['config', 'submodule.declined.ignore', 'none'], outer)],
    ['submodule.declined.ignore=untracked in .gitmodules', (outer) => git(['config', '-f', '.gitmodules', 'submodule.declined.ignore', 'untracked'], outer)],
  ];
  for (const [setting, configure] of statusSettings) {
    it(`commits with nothing staged and applies a pending MERGE_AUTOSTASH without entering the declined submodule under ${setting}`, async () => {
      const { outer, declined, marker } = fencedClone(true);
      // the declined submodule's HEAD moves past the recorded commit, so a submodule summary has a log to show
      git([...seed, 'commit', '--quiet', '--allow-empty', '-m', 'moved'], declined);
      configure(outer);
      if (fs.existsSync(marker)) fs.rmSync(marker);
      const { h, repoId } = await openFenced(outer, declined);
      const committing = path.join(sandbox, `${path.basename(outer)}-commit.trace`);
      expect(await traced(committing, () => h.service.repository(repoId)!.repo.commit('Nothing', PLAIN_COMMIT))).toMatchObject({ ok: false, reason: 'nothingToCommit' });
      expect(enteredDeclined(committing), 'commit').toEqual([]);
      expect(fs.existsSync(marker), 'commit').toBe(false);
      write(path.join(outer, 's.txt'), 'clash\n');
      git(['add', 's.txt'], outer);
      git([...seed, 'commit', '--quiet', '-m', 'clash'], outer);
      // the terminal's own merge stashes and enters the submodule, which is no engine call
      expect(() => git(['merge', '--autostash', 'side'], outer)).toThrow();
      if (fs.existsSync(marker)) fs.rmSync(marker);
      expect((await freshStatus(h, repoId)).operation).toBe('merge');
      const aborting = path.join(sandbox, `${path.basename(outer)}-abort.trace`);
      await traced(aborting, () => h.service.abortOperation(repoId));
      expect(enteredDeclined(aborting), 'abort').toEqual([]);
      expect(fs.existsSync(marker), 'abort').toBe(false);
      expect(fs.readFileSync(path.join(outer, 'a.txt'), 'utf8')).toBe('dirty\n');
      h.service.dispose();
    });
  }

  it('aborts a merge that conflicts in .gitmodules and applies its pending autostash without entering the declined submodule', async () => {
    const { outer, declined, marker } = fencedClone(true);
    git(['checkout', '--quiet', 'side'], outer);
    git(['config', '-f', '.gitmodules', 'submodule.declined.branch', 'side'], outer);
    git(['add', '.gitmodules'], outer);
    git([...seed, 'commit', '--quiet', '-m', 'side branch'], outer);
    git(['checkout', '--quiet', 'main'], outer);
    git(['config', '-f', '.gitmodules', 'submodule.declined.branch', 'main'], outer);
    git(['add', '.gitmodules'], outer);
    git([...seed, 'commit', '--quiet', '-m', 'main branch'], outer);
    git(['config', 'submodule.declined.ignore', 'none'], outer);
    // the terminal's merge leaves conflict markers in .gitmodules, which git config cannot parse
    expect(() => git(['merge', '--autostash', 'side'], outer)).toThrow();
    expect(fs.readFileSync(path.join(outer, '.gitmodules'), 'utf8')).toContain('<<<<<<<');
    if (fs.existsSync(marker)) fs.rmSync(marker);
    const { h, repoId } = await openFenced(outer, declined);
    expect((await freshStatus(h, repoId)).operation).toBe('merge');
    const aborting = path.join(sandbox, `${path.basename(outer)}-abort.trace`);
    await traced(aborting, () => h.service.abortOperation(repoId));
    expect(enteredDeclined(aborting)).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
    expect((await freshStatus(h, repoId)).operation).toBeNull();
    expect(fs.readFileSync(path.join(outer, 'a.txt'), 'utf8')).toBe('dirty\n');
    h.service.dispose();
  });

  it('sets the ignore of a submodule whose name holds = through GIT_CONFIG_COUNT, and refuses the call on a git older than 2.31', async () => {
    const outer = makeRepo(path.join(sandbox, 'outer-split-name'));
    git(['submodule', 'add', '--quiet', '--name', 'de=clined', makeRepo(path.join(sandbox, 'up-split-name')), 'declined'], outer);
    git(['config', '-f', '.gitmodules', 'submodule.de=clined.ignore', 'none'], outer);
    git(['add', '.gitmodules'], outer);
    git([...seed, 'commit', '--quiet', '-m', 'submodule'], outer);
    const declined = path.join(outer, 'declined');
    write(path.join(declined, 'a.txt'), 'dirty\n');
    const marker = markerIn('split-name');
    armFsmonitor(declined, marker);
    const open = async (h: ReturnType<typeof harness>) => {
      h.service.setProjects([{ key: 'o', path: outer }, { key: 'd', path: declined }]);
      const repoId = (await ready(h, 1, 'o')).repos[0]!.repoId;
      await waitFor(() => statusOf(h, repoId), 'a first status');
      return h.service.repository(repoId)!.repo;
    };
    const current = harness({ trusted: [outer] });
    expect(await (await open(current)).commit('Nothing', PLAIN_COMMIT)).toMatchObject({ ok: false, reason: 'nothingToCommit' });
    expect(fs.existsSync(marker)).toBe(false);
    current.service.dispose();

    const runner = createGitRunner({ git: { path: GIT_PATH!, version: { major: 2, minor: 30, patch: 0 } }, log: { appendLine: () => undefined }, isTrusted: () => true });
    const old = harness({ trusted: [outer], runner });
    expect(await (await open(old)).commit('Nothing', PLAIN_COMMIT)).toMatchObject({ ok: false, error: expect.any(GitUntrustedError) });
    expect(fs.existsSync(marker)).toBe(false);
    old.service.dispose();

    // the probe: the same commit with only diff.ignoreSubmodules=all enters the declined submodule
    expect(() => git(['-c', 'submodule.recurse=false', '-c', 'diff.ignoreSubmodules=all', '-c', 'user.useConfigOnly=true', 'commit', '--quiet', '--allow-empty-message', '-m', ''], outer)).toThrow();
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('fetches, pulls and pushes without entering the declined submodule under every recursion setting', async () => {
    const { outer, declined, marker } = fencedClone(false);
    for (const [key, value] of [['fetch.recurseSubmodules', 'true'], ['submodule.declined.fetchRecurseSubmodules', 'true'], ['push.recurseSubmodules', 'on-demand']] as const) git(['config', key, value], outer);
    // a recorded declined commit that no remote has, which push's recursion would push or check first
    git([...seed, 'commit', '--quiet', '--allow-empty', '-m', 'local'], declined);
    git(['add', 'declined'], outer);
    git([...seed, 'commit', '--quiet', '-m', 'record local'], outer);
    if (fs.existsSync(marker)) fs.rmSync(marker);
    const { h, repoId } = await openFenced(outer, declined);
    const trace = path.join(sandbox, `${path.basename(outer)}-remote.trace`);
    await traced(trace, async () => {
      await h.service.fetch(repoId, { remote: 'origin' });
      await h.service.pull(repoId, { rebase: false });
      expect(await h.service.push(repoId, { remote: 'origin', branch: 'main', setUpstream: false, followTags: false, force: false })).toBe(true);
    });
    expect(enteredDeclined(trace)).toEqual([]);
    expect(fs.existsSync(path.join(outer, 'z.txt'))).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    h.service.dispose();

    // the probe: the same fetch without submodule.recurse=false fetches inside the declined submodule
    const probe = path.join(sandbox, `${path.basename(outer)}-probe.trace`);
    process.env['GIT_TRACE'] = probe;
    try {
      git(['fetch', 'origin'], outer);
    } finally {
      delete process.env['GIT_TRACE'];
    }
    expect(enteredDeclined(probe).length).toBeGreaterThan(0);
  });

  it('probes: git itself enters the declined submodule applying a pending autostash on merge --abort and rebase --abort', () => {
    for (const command of ['merge', 'rebase'] as const) {
      const { outer, marker } = fencedClone(true);
      write(path.join(outer, 's.txt'), 'clash\n');
      git(['add', 's.txt'], outer);
      git([...seed, 'commit', '--quiet', '-m', 'clash'], outer);
      expect(() => git([command, '--autostash', 'side'], outer)).toThrow();
      if (fs.existsSync(marker)) fs.rmSync(marker);
      git(['-c', 'submodule.recurse=false', '-c', 'commit.status=false', command, '--abort'], outer);
      expect(fs.existsSync(marker), command).toBe(true);
    }
  });

  it('adds and removes a remote whose name is the path of a declined project', async () => {
    const outer = makeRepo(path.join(sandbox, 'outer-remote-name'));
    const declined = makeRepo(path.join(outer, 'upstream'));
    const origin = path.join(sandbox, 'remote-name-origin.git');
    git(['init', '--quiet', '--bare', origin], sandbox);
    const h = harness({ trusted: [outer] });
    h.service.setProjects([{ key: 'o', path: outer }, { key: 'd', path: declined }]);
    const repoId = (await ready(h, 1, 'o')).repos[0]!.repoId;
    await waitFor(() => statusOf(h, repoId), 'a first status');
    await h.service.addRemote(repoId, 'upstream', origin);
    expect(statusOf(h, repoId)!.remotes).toEqual(['upstream']);
    await h.service.removeRemote(repoId, 'upstream');
    expect(statusOf(h, repoId)!.remotes).toEqual([]);
    await expect(h.service.stage(repoId, ['upstream/a.txt'])).rejects.toBeInstanceOf(GitUntrustedError);
    h.service.dispose();
  });
});
