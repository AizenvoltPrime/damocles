import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitUntrustedError } from '../git-runner';
import { PLAIN_COMMIT } from '../repository';
import { SCM_SETTING_KEYS } from '../settings-keys';
import { armFsmonitor, freshStatus, git, harness, HAS_GIT, makeRepo, ready, sandbox, statusOf, useGitSandbox, viewOf, waitFor, write } from './git-harness';

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
