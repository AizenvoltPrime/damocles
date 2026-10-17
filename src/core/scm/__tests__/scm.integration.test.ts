import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLAIN_VARIANT, type CommitVariant } from '../scm-service';
import { SCM_SETTING_KEYS } from '../settings-keys';
import { generateCommitMessage } from '../commit-message';
import { FakeSettings, folder, freshStatus, git, harness, HAS_GIT, makeRepo, MapMemento, ready, sandbox, statusOf, useGitSandbox, viewOf, waitFor, write, type Harness } from './git-harness';

/**
 * The source control engine against real git in temp folders: discovery, status modes, the index writes, operations in
 * progress and trust gating, with no git double in the way.
 */
useGitSandbox();

describe.skipIf(!HAS_GIT)('source control engine against real git', { timeout: 120_000 }, () => {
  it('finds the root repository, a nested one and a submodule, and decorates the submodule folder S', async () => {
    const project = makeRepo(folder('discovery'));
    makeRepo(path.join(project, 'nested'));
    const upstream = makeRepo(folder('upstream'));
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', upstream, 'sub'], project);
    git(['-c', 'user.name=Seed', '-c', 'user.email=seed@damocles.invalid', 'commit', '--quiet', '-m', 'add sub'], project);
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const view = await ready(h, 3);
    expect(view.repos.map((repo) => [path.relative(project, repo.root), repo.kind]).sort()).toEqual([['', 'root'], ['nested', 'nested'], ['sub', 'submodule']]);
    const root = view.repos.find((repo) => repo.kind === 'root')!;
    await waitFor(() => statusOf(h, root.repoId), 'root status');
    expect(h.service.decorations('p')['sub']).toMatchObject({ letter: 'S', tone: 'submodule' });
    h.service.dispose();
  });

  it('leaves a linked worktree found while scanning unopened, and opens a project folder that is itself a linked worktree', async () => {
    const project = makeRepo(folder('worktree'));
    git(['worktree', 'add', '--quiet', '-b', 'side', path.join(project, 'wt')], project);
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const view = await ready(h);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(viewOf(h).repos.map((repo) => repo.kind)).toEqual(['root']);
    expect(view.repos).toHaveLength(1);
    h.service.dispose();

    const linked = path.join(folder('linked-parent'), 'linked');
    git(['worktree', 'add', '--quiet', '-b', 'linked', linked], project);
    const realLinked = fs.realpathSync.native(linked);
    const w = harness({ trusted: [realLinked] });
    w.service.setProjects([{ key: 'p', path: realLinked }]);
    const own = await ready(w);
    expect(own.repos.map((repo) => [repo.root, repo.kind])).toEqual([[realLinked, 'root']]);
    w.service.dispose();
  });

  it('asks before opening a parent repository and runs nothing there beyond the top-level lookup', async () => {
    const parent = makeRepo(folder('parent'));
    const project = path.join(parent, 'inner');
    write(path.join(project, 'x.txt'), 'x\n');
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    await waitFor(() => h.notices.length > 0 && h.notices, 'the parent notice');
    expect(h.notices[0]).toContain('parent folders');
    expect(h.notices[0]).toContain(parent);
    expect(h.questions).toEqual([]);
    expect(h.log.every((line) => line.startsWith('> git rev-parse'))).toBe(true);
    expect(viewOf(h).repos).toEqual([]);
    expect(viewOf(h).parents).toEqual([parent]);
    h.service.dispose();

    const yes = harness({ trusted: [project] });
    yes.noticeAnswers = ['Yes'];
    yes.service.setProjects([{ key: 'p', path: project }]);
    const view = await ready(yes);
    expect(view.repos.map((repo) => [repo.root, repo.kind])).toEqual([[parent, 'parent']]);
    yes.service.dispose();

    const never = harness({ trusted: [project] });
    never.noticeAnswers = ['Never'];
    never.service.setProjects([{ key: 'p', path: project }]);
    await waitFor(() => never.settings.values.get(SCM_SETTING_KEYS.openRepositoryInParentFolders) === 'never', 'Never written');
    await waitFor(() => viewOf(never).state === 'noRepository' && viewOf(never).parents.length === 0, 'parents dropped');
    never.service.dispose();
  });

  it('initializes a repository in a project folder that has none', async () => {
    const project = folder('init');
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    await waitFor(() => viewOf(h).state === 'noRepository', 'no repository');
    await h.service.init('p');
    const view = await ready(h);
    expect(view.repos[0]!.root).toBe(project);
    expect(fs.existsSync(path.join(project, '.git'))).toBe(true);
    h.service.dispose();
  });

  it('closes a nested repository, keeps it closed across a restart, and reopens it; Open Repository opens below the scan depth and refuses outside', async () => {
    const project = makeRepo(folder('close'));
    const nested = makeRepo(path.join(project, 'nested'));
    const deep = makeRepo(path.join(project, 'a', 'b', 'deep'));
    const state = new MapMemento();
    const h = harness({ trusted: [project], state });
    h.service.setProjects([{ key: 'p', path: project }]);
    const view = await ready(h, 2);
    expect(view.repos.map((repo) => repo.root)).not.toContain(deep);
    await h.service.close([view.repos.find((repo) => repo.root === nested)!.repoId]);
    expect(viewOf(h).repos.map((repo) => repo.root)).toEqual([project]);
    h.service.dispose();

    const restarted = harness({ trusted: [project], state });
    restarted.service.setProjects([{ key: 'p', path: project }]);
    await ready(restarted);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(viewOf(restarted).repos.map((repo) => repo.root)).toEqual([project]);
    expect(viewOf(restarted).closedRoots).toEqual([nested]);
    await restarted.service.reopen('p', [nested]);
    await ready(restarted, 2);
    expect(viewOf(restarted).closedRoots).toEqual([]);

    expect(await restarted.service.openFolder('p', deep)).toBe('opened');
    expect(viewOf(restarted).repos.map((repo) => repo.root)).toContain(deep);
    expect(await restarted.service.openFolder('p', makeRepo(folder('elsewhere')))).toBe('outside');
    restarted.service.dispose();
  });

  it('groups untracked files per untrackedChanges, stages only untracked at separate, discards only tracked, and runs -uno at hidden', async () => {
    const project = makeRepo(folder('modes'));
    write(path.join(project, 'a.txt'), 'two\n');
    write(path.join(project, 'new.txt'), 'new\n');
    const settings = new FakeSettings();
    const h = harness({ trusted: [project], settings });
    h.service.setProjects([{ key: 'p', path: project }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    let status = await waitFor(() => statusOf(h, repoId), 'status');
    expect(status.groups.workingTree.map((change) => [change.path, change.letter])).toEqual([['a.txt', 'M'], ['new.txt', 'U']]);
    expect(status.groups.untracked).toEqual([]);

    await settings.update(SCM_SETTING_KEYS.untrackedChanges, 'separate');
    status = await freshStatus(h, repoId);
    expect(status.groups.workingTree.map((change) => change.path)).toEqual(['a.txt']);
    expect(status.groups.untracked.map((change) => change.path)).toEqual(['new.txt']);

    status = await freshStatus(h, repoId, () => h.service.stageAll(repoId, 'untracked'));
    expect(status.groups.index.map((change) => [change.path, change.status])).toEqual([['new.txt', 'INDEX_ADDED']]);
    expect(status.groups.workingTree.map((change) => change.path)).toEqual(['a.txt']);
    await freshStatus(h, repoId, () => h.service.unstage(repoId, 'all'));
    // git 2.43 refuses --end-of-options on reset, so unstaging there fails whatever this machine's git accepts.
    expect(h.log.filter((line) => line.startsWith('> git reset '))).toEqual([expect.stringMatching(/^> git reset -q HEAD -- \. \[/)]);

    h.answers = [0];
    status = await freshStatus(h, repoId, () => h.service.discardAll(repoId, 'tracked'));
    expect(h.questions.at(-1)!.message).toBe("Are you sure you want to discard changes in 'a.txt'?");
    expect(fs.readFileSync(path.join(project, 'a.txt'), 'utf8')).toBe('one\n');
    expect(fs.existsSync(path.join(project, 'new.txt'))).toBe(true);
    expect(status.groups.untracked.map((change) => change.path)).toEqual(['new.txt']);

    await settings.update(SCM_SETTING_KEYS.untrackedChanges, 'hidden');
    h.log.length = 0;
    status = await freshStatus(h, repoId);
    expect(h.log.some((line) => line.startsWith('> git status --porcelain=v1 -z -uno'))).toBe(true);
    expect([...status.groups.workingTree, ...status.groups.untracked, ...status.groups.index]).toEqual([]);
    h.service.dispose();
  });

  it('moves a discarded untracked file to the injected trash after VS Code\'s confirmation', async () => {
    const project = makeRepo(folder('trash'));
    write(path.join(project, 'junk.txt'), 'junk\n');
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    await waitFor(() => statusOf(h, repoId)?.groups.workingTree.length, 'untracked listed');
    h.answers = [0];
    expect(await h.service.discard(repoId, ['junk.txt'])).toBe(true);
    expect(h.questions[0]!.message).toBe("Are you sure you want to DELETE the following untracked file: 'junk.txt'?");
    expect(h.questions[0]!.actions).toEqual([process.platform === 'win32' ? 'Move to Recycle Bin' : 'Move to Trash']);
    expect(h.trashed).toEqual([path.join(project, 'junk.txt')]);
    h.service.dispose();
  });

  it('shows the control and bidi characters of file names in the discard and stage questions as escapes', async () => {
    const project = makeRepo(folder('bidi-names'));
    const [tracked, gone, conflicted, loose] = ['t\u202Ext.gnp', 'd\u202Eel.txt', 'c\u202Eon.txt', 'u\u202Ent.txt'];
    for (const name of [tracked, gone, conflicted]) write(path.join(project, name), 'base\n');
    git(['add', '.'], project);
    git(['commit', '--quiet', '-m', 'names'], project);
    git(['checkout', '--quiet', '-b', 'side'], project);
    write(path.join(project, conflicted), 'side\n');
    git(['commit', '--quiet', '-am', 'side'], project);
    git(['checkout', '--quiet', 'main'], project);
    write(path.join(project, conflicted), 'main\n');
    git(['commit', '--quiet', '-am', 'main'], project);
    expect(() => git(['merge', '--quiet', 'side'], project)).toThrow();
    write(path.join(project, tracked), 'changed\n');
    fs.rmSync(path.join(project, gone));
    write(path.join(project, loose), 'loose\n');
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    await freshStatus(h, repoId);
    const asked = async (act: () => Promise<boolean>): Promise<string> => {
      h.answers = [undefined];
      expect(await act()).toBe(false);
      return h.questions.at(-1)!.message;
    };
    const messages = [
      await asked(() => h.service.discard(repoId, [tracked])),
      await asked(() => h.service.discard(repoId, [gone])),
      await asked(() => h.service.discard(repoId, [loose])),
      await asked(() => h.service.discard(repoId, [tracked, loose])),
      await asked(() => h.service.stage(repoId, [conflicted])),
    ];
    expect(h.questions).toHaveLength(messages.length);
    for (const message of messages) {
      expect(message).toContain('\\u{202E}');
      expect(message).not.toContain('\u202E');
    }
    h.service.dispose();
  });

  it('shows the control and bidi characters of a parent repository\'s path in the parent notice and question as escapes', async () => {
    const parent = makeRepo(folder('par\u202Eent'));
    const project = path.join(parent, 'inner');
    write(path.join(project, 'x.txt'), 'x\n');
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    await waitFor(() => h.notices.length > 0, 'the parent notice');
    expect(await h.service.openFolder('p', project)).toBe('parent');
    for (const text of [h.notices[0]!, ...h.questions[0]!.preview!]) {
      expect(text).toContain('par\\u{202E}ent');
      expect(text).not.toContain('\u202E');
    }
    h.service.dispose();
  });

  it('commits staged changes; refuses an empty message, nothing staged and a missing user.name', async () => {
    const project = makeRepo(folder('commit'));
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    await waitFor(() => statusOf(h, repoId), 'status');
    expect(await h.service.commit(repoId, 'nothing')).toEqual({ ok: false, reason: 'nothingToCommit' });
    write(path.join(project, 'a.txt'), 'edited\n');
    let status = await freshStatus(h, repoId, () => h.service.stage(repoId, ['a.txt']));
    expect(status.groups.index.map((change) => change.letter)).toEqual(['M']);
    expect(await h.service.commit(repoId, '   ')).toEqual({ ok: false, reason: 'emptyMessage' });
    expect(await h.service.commit(repoId, 'Edit a')).toEqual({ ok: true });
    status = await freshStatus(h, repoId);
    expect(status.groups.index).toEqual([]);
    expect(git(['log', '-1', '--format=%s'], project).trim()).toBe('Edit a');
    h.service.dispose();

    const anonymous = makeRepo(folder('anonymous'), false);
    const a = harness({ trusted: [anonymous] });
    a.service.setProjects([{ key: 'p', path: anonymous }]);
    const anonId = (await ready(a)).repos[0]!.repoId;
    write(path.join(anonymous, 'a.txt'), 'edited\n');
    await freshStatus(a, anonId, () => a.service.stage(anonId, ['a.txt']));
    const outcome = await a.service.commit(anonId, 'Edit a');
    expect(outcome.ok === false && outcome.reason).toBe('missingUserConfig');
    a.service.dispose();
  });

  it('shows a merge in progress, refuses to commit unresolved conflicts, and commits the merge once staged', async () => {
    const project = makeRepo(folder('merge'));
    git(['checkout', '--quiet', '-b', 'feature'], project);
    write(path.join(project, 'a.txt'), 'feature\n');
    git(['commit', '--quiet', '-am', 'feature change'], project);
    git(['checkout', '--quiet', 'main'], project);
    write(path.join(project, 'a.txt'), 'main\n');
    git(['commit', '--quiet', '-am', 'main change'], project);
    expect(() => git(['merge', 'feature'], project)).toThrow();
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    let status = await waitFor(() => statusOf(h, repoId), 'status');
    expect(status.operation).toBe('merge');
    expect(status.mergeMessage).toBe("Merge branch 'feature'");
    expect(status.groups.merge.map((change) => [change.path, change.status, change.letter])).toEqual([['a.txt', 'BOTH_MODIFIED', '!']]);
    expect(await h.service.commit(repoId, status.mergeMessage!)).toEqual({ ok: false, reason: 'unresolvedConflicts' });
    write(path.join(project, 'a.txt'), 'resolved\n');
    status = await freshStatus(h, repoId, () => h.service.stage(repoId, ['a.txt']));
    expect(status.groups.merge).toEqual([]);
    expect(await h.service.commit(repoId, status.mergeMessage!)).toEqual({ ok: true });
    status = await freshStatus(h, repoId);
    expect(status.operation).toBeNull();
    h.service.dispose();
  });

  it('stages with Stage All and smart commit exactly the changes the list shows, never an untracked nested repository as a gitlink', async () => {
    const project = makeRepo(folder('stage-nested'));
    makeRepo(path.join(project, 'nested'));
    write(path.join(project, 'a.txt'), 'changed\n');
    write(path.join(project, 'u.txt'), 'untracked\n');
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const view = await ready(h);
    // the nested repository is its own repository, as VS Code's scan opens it, and no change of the outer one
    expect(view.repos.map((repo) => path.relative(project, repo.root)).sort()).toEqual(['', 'nested']);
    const repoId = view.repos.find((repo) => repo.root === project)!.repoId;
    let status = await freshStatus(h, repoId);
    const listed = [...status.groups.workingTree, ...status.groups.untracked].map((change) => change.path).sort();
    expect(listed).toEqual(['a.txt', 'u.txt']);
    status = await freshStatus(h, repoId, () => h.service.stageAll(repoId, 'all'));
    expect(status.groups.index.map((change) => change.path).sort()).toEqual(listed);
    expect(git(['ls-files', '-s', '--', 'nested'], project)).toBe('');
    await freshStatus(h, repoId, () => h.service.unstage(repoId, 'all'));
    h.answers.push(0);
    expect(await h.service.commit(repoId, 'smart')).toEqual({ ok: true });
    expect(h.questions.at(-1)?.message).toBe('There are no staged changes to commit.');
    expect(git(['show', '--name-only', '--format=', 'HEAD'], project).trim().split('\n').sort()).toEqual(listed);
    expect(git(['ls-tree', 'HEAD', '--', 'nested'], project)).toBe('');
    h.service.dispose();
  });

  it('reads the input template VS Code reads: MERGE_MSG whenever git left one, a revert\'s included, else SQUASH_MSG', async () => {
    const project = makeRepo(folder('templates'));
    git(['checkout', '--quiet', '-b', 'feature'], project);
    write(path.join(project, 'b.txt'), 'feature\n');
    git(['add', 'b.txt'], project);
    git(['commit', '--quiet', '-m', 'feature change'], project);
    git(['checkout', '--quiet', 'main'], project);
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    git(['merge', '--squash', '--quiet', 'feature'], project);
    let status = await freshStatus(h, repoId);
    expect(status.operation).toBeNull();
    expect(status.mergeMessage).toContain('Squashed commit of the following:');
    git(['commit', '--quiet', '--no-edit'], project);
    status = await freshStatus(h, repoId);
    expect(status.mergeMessage).toBeUndefined();
    write(path.join(project, 'a.txt'), 'changed\n');
    git(['commit', '--quiet', '-am', 'change a'], project);
    write(path.join(project, 'a.txt'), 'changed again\n');
    git(['commit', '--quiet', '-am', 'change a again'], project);
    expect(() => git(['revert', '--no-edit', 'HEAD~1'], project)).toThrow();
    status = await freshStatus(h, repoId);
    expect(status.mergeMessage).toMatch(/^Revert "change a"/);
    h.service.dispose();
  });

  it('continues a rebase without waiting on an editor, and aborts a cherry-pick', async () => {
    const project = makeRepo(folder('rebase'));
    // an editor that never returns: the engine must not start it
    git(['config', 'core.editor', `"${process.execPath.replace(/\\/g, '/')}" -e "setTimeout(() => {}, 1e9)"`], project);
    git(['checkout', '--quiet', '-b', 'feature'], project);
    write(path.join(project, 'a.txt'), 'feature\n');
    git(['commit', '--quiet', '-am', 'feature change'], project);
    git(['checkout', '--quiet', 'main'], project);
    write(path.join(project, 'a.txt'), 'main\n');
    git(['commit', '--quiet', '-am', 'main change'], project);
    git(['checkout', '--quiet', 'feature'], project);
    expect(() => git(['rebase', 'main'], project)).toThrow();
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    let status = await waitFor(() => statusOf(h, repoId), 'status');
    expect(status.operation).toBe('rebase');
    write(path.join(project, 'a.txt'), 'resolved\n');
    await freshStatus(h, repoId, () => h.service.stage(repoId, ['a.txt']));
    const started = Date.now();
    expect(await h.service.commit(repoId, '')).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(15_000);
    status = await freshStatus(h, repoId);
    expect(status.operation).toBeNull();
    expect(git(['log', '-1', '--format=%s'], project).trim()).toBe('feature change');

    git(['checkout', '--quiet', 'main'], project);
    git(['checkout', '--quiet', '-b', 'pick'], project);
    write(path.join(project, 'a.txt'), 'pick\n');
    git(['commit', '--quiet', '-am', 'pick change'], project);
    git(['checkout', '--quiet', 'main'], project);
    write(path.join(project, 'a.txt'), 'main again\n');
    git(['commit', '--quiet', '-am', 'main again'], project);
    expect(() => git(['cherry-pick', 'pick'], project)).toThrow();
    status = await freshStatus(h, repoId);
    expect(status.operation).toBe('cherryPick');
    status = await freshStatus(h, repoId, () => h.service.abortOperation(repoId));
    expect(status.operation).toBeNull();
    h.service.dispose();
  });

  it('runs no git command in an untrusted project, and activates nested repositories and submodules on the grant without a reload', async () => {
    const project = makeRepo(folder('trust'));
    makeRepo(path.join(project, 'nested'));
    const marker = path.join(sandbox, 'fsmonitor-ran.txt');
    const hook = path.join(sandbox, 'fsmonitor.js');
    fs.writeFileSync(hook, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`, 'utf8');
    git(['config', 'core.fsmonitor', `"${process.execPath.replace(/\\/g, '/')}" "${hook.replace(/\\/g, '/')}"`], project);
    const h = harness();
    h.service.setProjects([{ key: 'p', path: project }]);
    await waitFor(() => viewOf(h).state === 'untrusted', 'untrusted');
    expect(await h.service.ignoredIn('p', '', [{ name: 'a.txt', dir: false }])).toEqual(new Set());
    expect(h.service.decorations('p')).toEqual({});
    expect(h.log).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);

    const ignores: string[] = [];
    h.service.onDidChange((event) => {
      if (event.kind === 'ignores') ignores.push(event.projectKey);
    });
    h.trust.grant(project);
    const view = await ready(h, 2);
    expect(view.repos.map((repo) => repo.kind).sort()).toEqual(['nested', 'root']);
    // the Files tree lists again once git can answer what it ignores
    expect(ignores).toContain('p');
    h.service.dispose();
  });

  it('lists the first 10,000 changes and says there were more', async () => {
    const project = makeRepo(folder('limit'));
    const dir = path.join(project, 'many');
    fs.mkdirSync(dir);
    for (let index = 0; index < 10_050; index++) fs.writeFileSync(path.join(dir, `f${index}.txt`), '');
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    const status = await waitFor(() => statusOf(h, repoId), 'status');
    expect(status.tooManyChanges).toBe(true);
    expect(status.groups.workingTree).toHaveLength(10_000);
    // Commit All and smart commit would stage only the listed changes, so they refuse before staging anything
    const head = git(['rev-parse', 'HEAD'], project).trim();
    const refused = 'The change list shows only the first 10000 changes, so nothing was committed. Stage the changes to commit, or commit from a terminal.';
    const all = await h.service.commit(repoId, 'all of it', { ...PLAIN_VARIANT, scope: 'all' });
    expect(all.ok === false && all.reason === 'failed' && (all.error as Error).message).toBe(refused);
    h.answers.push(0);
    const smart = await h.service.commit(repoId, 'smart');
    expect(smart.ok === false && (smart.error as Error).message).toBe(refused);
    expect(git(['rev-parse', 'HEAD'], project).trim()).toBe(head);
    expect(git(['diff', '--cached', '--name-only'], project)).toBe('');
    h.service.dispose();
  });

  it('answers which listed entries git ignores, and appends escaped lines to .gitignore', async () => {
    const project = makeRepo(folder('ignore'));
    write(path.join(project, '.gitignore'), 'dist/\n*.log\n');
    write(path.join(project, 'src', 'debug.log'), '');
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    expect(await h.service.ignoredIn('p', '', [{ name: 'dist', dir: true }, { name: 'a.log', dir: false }, { name: 'src', dir: true }])).toEqual(new Set(['dist', 'a.log']));
    expect(await h.service.ignoredIn('p', 'src', [{ name: 'debug.log', dir: false }, { name: 'main.ts', dir: false }])).toEqual(new Set(['debug.log']));
    await h.service.addToGitignore(repoId, ['notes[1].txt', '#hash.txt']);
    expect(fs.readFileSync(path.join(project, '.gitignore'), 'utf8')).toBe('dist/\n*.log\nnotes\\[1\\].txt\n\\#hash.txt\n');
    await expect(h.service.addToGitignore(repoId, ['../outside.txt'])).rejects.toThrow();
    h.service.dispose();
  });

  it('feeds the staged diff and recent subjects to the commit-message model, attributed to the project folder', async () => {
    const project = makeRepo(folder('message'));
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    write(path.join(project, 'a.txt'), 'staged change\n');
    await freshStatus(h, repoId, () => h.service.stage(repoId, ['a.txt']));
    const requests: Array<{ userMessage: string; attribution?: { cwd?: string }; purpose: string }> = [];
    const result = await generateCommitMessage(h.service.repository(repoId)!.repo, async (request) => {
      requests.push(request);
      return { kind: 'answered', value: { message: 'Change a' } };
    }, project);
    expect(result).toEqual({ ok: true, message: 'Change a' });
    expect(requests[0]!.purpose).toBe('commit-message');
    expect(requests[0]!.attribution).toEqual({ cwd: project });
    expect(requests[0]!.userMessage).toContain('+staged change');
    expect(requests[0]!.userMessage).toContain('first');
    h.service.dispose();
  });
  it('discards only the file a glob-like name names, since paths reach git as literal pathspecs', async () => {
    const project = folder('literal');
    makeRepo(project);
    write(path.join(project, '[ab].txt'), 'one\n');
    git(['add', '.'], project);
    git(['commit', '--quiet', '-m', 'glob name'], project);
    write(path.join(project, '[ab].txt'), 'changed\n');
    write(path.join(project, 'a.txt'), 'changed\n');
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    await waitFor(() => statusOf(h, repoId)?.groups.workingTree.length === 2, 'two changes');
    h.answers = [0];
    const status = await freshStatus(h, repoId, () => h.service.discard(repoId, ['[ab].txt']));
    expect(fs.readFileSync(path.join(project, '[ab].txt'), 'utf8')).toBe('one\n');
    expect(fs.readFileSync(path.join(project, 'a.txt'), 'utf8')).toBe('changed\n');
    expect(status.groups.workingTree.map((change) => change.path)).toEqual(['a.txt']);
    h.service.dispose();
  });

  it('opens no submodule whose .gitmodules path leaves the repository', async () => {
    const project = makeRepo(folder('escape'));
    makeRepo(path.join(path.dirname(project), 'outside-sub'));
    write(path.join(project, '.gitmodules'), '[submodule "x"]\n\tpath = ../outside-sub\n\turl = https://example.invalid/x.git\n');
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    await ready(h);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(viewOf(h).repos.map((repo) => repo.root)).toEqual([project]);
    h.service.dispose();
  });

  it('refuses to append to a .gitignore that is a link', async (ctx) => {
    const project = makeRepo(folder('gitignore-link'));
    const target = path.join(folder('gitignore-target'), 'elsewhere');
    fs.writeFileSync(target, '');
    try {
      fs.symlinkSync(target, path.join(project, '.gitignore'));
    } catch {
      ctx.skip();
    }
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    await expect(h.service.addToGitignore(repoId, ['a.txt'])).rejects.toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('');
    h.service.dispose();
  });

  it('asks about a parent repository with Cancel focused when the user opens it through Open Repository', async () => {
    const parent = makeRepo(folder('parent-open'));
    const project = path.join(parent, 'inner');
    write(path.join(project, 'x.txt'), 'x\n');
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    await waitFor(() => h.notices.length > 0, 'the parent notice');
    expect(await h.service.openFolder('p', project)).toBe('parent');
    expect(h.questions).toHaveLength(1);
    expect(h.questions[0]!.defaultAction).toBeUndefined();
    expect(h.questions[0]!.preview).toEqual([parent]);
    h.service.dispose();
  });
});

describe.skipIf(!HAS_GIT)('commit variants and commit behaviour against real git', { timeout: 120_000 }, () => {
  const variant = (flags: Partial<CommitVariant> = {}): CommitVariant => ({ scope: 'auto', amend: false, signoff: false, noVerify: false, empty: false, ...flags });
  const headOf = (dir: string): string => git(['rev-parse', 'HEAD'], dir).trim();
  const messageOf = (dir: string, ref = 'HEAD'): string => git(['log', '-1', '--format=%B', ref], dir).trim();
  const countOf = (dir: string): number => Number(git(['rev-list', '--count', 'HEAD'], dir).trim());
  const stagedOf = (dir: string): string => git(['diff', '--cached', '--name-status'], dir).trim();
  const filesOf = (dir: string): string => git(['show', '--name-only', '--format=', 'HEAD'], dir).trim();

  async function open(name: string): Promise<{ project: string; h: Harness; repoId: string }> {
    const project = makeRepo(folder(name));
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    await waitFor(() => statusOf(h, repoId), 'a first status');
    return { project, h, repoId };
  }

  it('commits staged only, all, amend (rewriting HEAD, or keeping its message when the box is empty) and signed off, alone and combined', async () => {
    const { project, h, repoId } = await open('variants');
    write(path.join(project, 'a.txt'), 'staged\n');
    write(path.join(project, 'b.txt'), 'untracked\n');
    git(['add', 'a.txt'], project);
    expect(await h.service.commit(repoId, 'Staged only', variant({ scope: 'staged' }))).toEqual({ ok: true });
    expect(filesOf(project)).toBe('a.txt');
    expect(git(['status', '--porcelain'], project).trim()).toBe('?? b.txt');

    expect(await h.service.commit(repoId, 'All of it', variant({ scope: 'all' }))).toEqual({ ok: true });
    expect(filesOf(project)).toBe('b.txt');

    const before = headOf(project);
    const commits = countOf(project);
    expect(await h.service.commit(repoId, 'All of it, reworded', variant({ amend: true }))).toEqual({ ok: true });
    expect(headOf(project)).not.toBe(before);
    expect(countOf(project)).toBe(commits);
    expect(messageOf(project)).toBe('All of it, reworded');

    write(path.join(project, 'a.txt'), 'amended in\n');
    expect(await h.service.commit(repoId, '', variant({ scope: 'all', amend: true }))).toEqual({ ok: true });
    expect(messageOf(project)).toBe('All of it, reworded');
    expect(git(['show', 'HEAD:a.txt'], project)).toBe('amended in\n');
    expect(countOf(project)).toBe(commits);

    write(path.join(project, 'a.txt'), 'signed\n');
    expect(await h.service.commit(repoId, 'Signed', variant({ scope: 'all', signoff: true }))).toEqual({ ok: true });
    expect(messageOf(project)).toBe('Signed\n\nSigned-off-by: Damocles Tests <tests@damocles.invalid>');
    expect(await h.service.commit(repoId, 'Signed, amended', variant({ scope: 'staged', amend: true, signoff: true }))).toEqual({ ok: true });
    expect(messageOf(project)).toMatch(/^Signed, amended\n\nSigned-off-by: Damocles Tests/);
    expect(h.questions).toEqual([]);
    h.service.dispose();
  });

  it('adds --signoff and -S from alwaysSignOff and enableCommitSigning to the commit command the Git log shows', async () => {
    const { project, h, repoId } = await open('signing');
    // a signing program that does not exist fails at once; only the command line is under test
    git(['config', 'gpg.program', path.join(project, 'no-such-gpg')], project);
    h.settings.values.set(SCM_SETTING_KEYS.alwaysSignOff, true);
    h.settings.values.set(SCM_SETTING_KEYS.enableCommitSigning, true);
    write(path.join(project, 'a.txt'), 'edit\n');
    git(['add', 'a.txt'], project);
    await h.service.commit(repoId, 'Signed', variant());
    const line = h.log.find((entry) => / commit --quiet /.test(entry));
    expect(line).toMatch(/^> git -c user\.useConfigOnly=true commit --quiet --allow-empty-message --file - --signoff -S \[/);
    expect(line).not.toContain('--no-verify');
    h.service.dispose();
  });

  it('commits past a failing pre-commit hook only through No Verify, which allowNoVerifyCommit gates and confirmNoVerifyCommit confirms', async () => {
    const { project, h, repoId } = await open('no-verify');
    const hook = path.join(project, '.git', 'hooks', 'pre-commit');
    write(hook, '#!/bin/sh\necho refused by the hook >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    write(path.join(project, 'a.txt'), 'edit\n');
    git(['add', 'a.txt'], project);
    const commits = countOf(project);
    const plain = await h.service.commit(repoId, 'Blocked', variant());
    expect(plain.ok === false && plain.reason).toBe('failed');

    const refused = await h.service.commit(repoId, 'No verify', variant({ noVerify: true }));
    expect(refused.ok === false && refused.reason).toBe('failed');
    expect(h.questions).toEqual([]);

    h.settings.values.set(SCM_SETTING_KEYS.allowNoVerifyCommit, true);
    h.answers.push(undefined);
    expect(await h.service.commit(repoId, 'No verify', variant({ noVerify: true }))).toEqual({ ok: false, reason: 'cancelled' });
    expect(h.questions[0]).toMatchObject({ severity: 'warning', actions: ['OK', 'OK, Don\'t Ask Again'], defaultAction: 0 });
    expect(countOf(project)).toBe(commits);

    h.answers.push(1);
    expect(await h.service.commit(repoId, 'No verify', variant({ noVerify: true }))).toEqual({ ok: true });
    expect(countOf(project)).toBe(commits + 1);
    expect(h.settings.values.get(SCM_SETTING_KEYS.confirmNoVerifyCommit)).toBe(false);
    expect(h.log.some((entry) => / commit --quiet .*--no-verify/.test(entry))).toBe(true);
    h.service.dispose();
  });

  it('asks before Commit Empty and creates a commit with no changes', async () => {
    const { project, h, repoId } = await open('empty');
    const commits = countOf(project);
    h.answers.push(undefined);
    expect(await h.service.commit(repoId, 'Nothing', variant({ empty: true }))).toEqual({ ok: false, reason: 'cancelled' });
    expect(h.questions[0]).toMatchObject({ severity: 'warning', message: 'Are you sure you want to create an empty commit?', actions: ['Yes', 'Yes, Don\'t Show Again'] });
    h.answers.push(0);
    expect(await h.service.commit(repoId, 'Nothing', variant({ empty: true }))).toEqual({ ok: true });
    expect(countOf(project)).toBe(commits + 1);
    expect(git(['diff', '--stat', 'HEAD~', 'HEAD'], project).trim()).toBe('');
    h.answers.push(1);
    expect(await h.service.commit(repoId, 'Nothing again', variant({ empty: true }))).toEqual({ ok: true });
    expect(h.settings.values.get(SCM_SETTING_KEYS.confirmEmptyCommits)).toBe(false);
    expect(await h.service.commit(repoId, 'Unasked', variant({ empty: true }))).toEqual({ ok: true });
    expect(h.questions).toHaveLength(3);
    h.service.dispose();
  });

  it('suggests smart commit with nothing staged: Cancel and Never commit nothing, Yes stages all, Always also turns it on', async () => {
    const { project, h, repoId } = await open('smart');
    write(path.join(project, 'a.txt'), 'edit\n');
    write(path.join(project, 'new.txt'), 'new\n');
    const commits = countOf(project);

    h.answers.push(undefined);
    expect(await h.service.commit(repoId, 'Smart', variant())).toEqual({ ok: false, reason: 'cancelled' });
    expect(h.questions[0]).toMatchObject({
      severity: 'warning',
      message: 'There are no staged changes to commit.',
      detail: 'Would you like to stage all your changes and commit them directly?',
      actions: ['Yes', 'Always', 'Never'],
    });
    expect(stagedOf(project)).toBe('');

    h.answers.push(2);
    expect(await h.service.commit(repoId, 'Smart', variant())).toEqual({ ok: false, reason: 'cancelled' });
    expect(h.settings.values.get(SCM_SETTING_KEYS.suggestSmartCommit)).toBe(false);
    expect(stagedOf(project)).toBe('');
    expect(await h.service.commit(repoId, 'Smart', variant())).toEqual({ ok: false, reason: 'nothingToCommit' });
    expect(h.questions).toHaveLength(2);
    h.settings.values.delete(SCM_SETTING_KEYS.suggestSmartCommit);

    h.answers.push(0);
    expect(await h.service.commit(repoId, 'Smart yes', variant())).toEqual({ ok: true });
    expect(countOf(project)).toBe(commits + 1);
    expect(git(['status', '--porcelain'], project).trim()).toBe('');
    expect(h.settings.values.has(SCM_SETTING_KEYS.enableSmartCommit)).toBe(false);

    write(path.join(project, 'a.txt'), 'again\n');
    h.answers.push(1);
    expect(await h.service.commit(repoId, 'Smart always', variant())).toEqual({ ok: true });
    expect(h.settings.values.get(SCM_SETTING_KEYS.enableSmartCommit)).toBe(true);
    write(path.join(project, 'a.txt'), 'third\n');
    expect(await h.service.commit(repoId, 'Smart, unasked', variant())).toEqual({ ok: true });
    expect(h.questions).toHaveLength(4);
    h.service.dispose();
  });

  it('stages tracked changes only at smartCommitChanges tracked, and finds nothing to commit when only untracked files changed', async () => {
    const { project, h, repoId } = await open('smart-tracked');
    h.settings.values.set(SCM_SETTING_KEYS.enableSmartCommit, true);
    h.settings.values.set(SCM_SETTING_KEYS.smartCommitChanges, 'tracked');
    write(path.join(project, 'new.txt'), 'new\n');
    expect(await h.service.commit(repoId, 'Only untracked', variant())).toEqual({ ok: false, reason: 'nothingToCommit' });
    write(path.join(project, 'a.txt'), 'edit\n');
    expect(await h.service.commit(repoId, 'Tracked', variant())).toEqual({ ok: true });
    expect(filesOf(project)).toBe('a.txt');
    expect(git(['status', '--porcelain'], project).trim()).toBe('?? new.txt');
    h.service.dispose();
  });

  it('adds a staged file saved before the commit again, so its saved text is what is committed', async () => {
    const { project, h, repoId } = await open('restage');
    write(path.join(project, 'a.txt'), 'staged text\n');
    git(['add', 'a.txt'], project);
    write(path.join(project, 'a.txt'), 'saved text\n');
    expect(await h.service.commit(repoId, 'Saved', variant(), { saved: [path.join(project, 'a.txt')] })).toEqual({ ok: true });
    expect(git(['show', 'HEAD:a.txt'], project)).toBe('saved text\n');
    h.service.dispose();
  });

  it('undoes the last commit as reset --soft does, staging its files again and returning its full message; a first commit unstages all', async () => {
    const { project, h, repoId } = await open('undo');
    write(path.join(project, 'a.txt'), 'edit\n');
    write(path.join(project, 'w.txt'), 'untracked\n');
    git(['add', 'a.txt'], project);
    git(['commit', '--quiet', '-m', 'Subject line', '-m', 'Body paragraph.'], project);
    const undone = headOf(project);
    const parent = git(['rev-parse', 'HEAD~'], project).trim();
    expect(await h.service.undoLastCommit(repoId)).toEqual({ kind: 'undone', message: 'Subject line\n\nBody paragraph.' });
    expect(headOf(project)).toBe(parent);
    expect(stagedOf(project)).toBe('M\ta.txt');
    expect(fs.readFileSync(path.join(project, 'a.txt'), 'utf8')).toBe('edit\n');
    expect(git(['status', '--porcelain'], project)).toBe('M  a.txt\n?? w.txt\n');
    expect(h.log.some((entry) => entry.startsWith('> git update-ref ') && entry.includes(` HEAD ${parent} ${undone} [`))).toBe(true);
    // both reflogs record the move as reset --soft would
    expect(git(['reflog', '-1', '--format=%gs', 'HEAD'], project).trim()).toBe(`reset: moving to ${parent}`);
    expect(git(['reflog', '-1', '--format=%gs', 'main'], project).trim()).toBe(`reset: moving to ${parent}`);
    fs.rmSync(path.join(project, 'w.txt'));
    const status = await freshStatus(h, repoId);
    expect(status.groups.index.map((change) => change.path)).toEqual(['a.txt']);

    expect(await h.service.undoLastCommit(repoId)).toEqual({ kind: 'undone', message: 'first' });
    expect(() => git(['rev-parse', '--verify', '-q', 'HEAD'], project)).toThrow();
    expect(git(['status', '--porcelain'], project).trim()).toBe('?? a.txt');
    expect(await h.service.undoLastCommit(repoId)).toEqual({ kind: 'noCommit' });
    h.service.dispose();
  });

  it('asks before undoing a merge commit', async () => {
    const { project, h, repoId } = await open('undo-merge');
    git(['checkout', '--quiet', '-b', 'side'], project);
    write(path.join(project, 'side.txt'), 'side\n');
    git(['add', '.'], project);
    git(['commit', '--quiet', '-m', 'side'], project);
    git(['checkout', '--quiet', 'main'], project);
    write(path.join(project, 'main.txt'), 'main\n');
    git(['add', '.'], project);
    git(['commit', '--quiet', '-m', 'main'], project);
    git(['merge', '--quiet', '--no-ff', '-m', 'Merge side', 'side'], project);
    const merge = headOf(project);
    h.answers.push(undefined);
    expect(await h.service.undoLastCommit(repoId)).toEqual({ kind: 'cancelled' });
    expect(h.questions[0]).toMatchObject({ message: 'The last commit was a merge commit. Are you sure you want to undo it?', actions: ['Undo merge commit'] });
    expect(headOf(project)).toBe(merge);
    h.answers.push(0);
    expect(await h.service.undoLastCommit(repoId)).toEqual({ kind: 'undone', message: 'Merge side' });
    expect(headOf(project)).not.toBe(merge);
    h.service.dispose();
  });

  it('renames with git mv, which shows as renamed under Staged, and deletes with git rm', async () => {
    const { project, h, repoId } = await open('mv-rm');
    write(path.join(project, 'b.txt'), 'b\n');
    git(['add', 'b.txt'], project);
    git(['commit', '--quiet', '-m', 'add b'], project);
    await h.service.move(repoId, 'a.txt', 'renamed.txt');
    let status = await freshStatus(h, repoId);
    expect(status.groups.index.map((change) => [change.letter, change.path, change.originalPath])).toEqual([['R', 'renamed.txt', 'a.txt']]);
    await h.service.remove(repoId, ['b.txt']);
    status = await freshStatus(h, repoId);
    expect(status.groups.index.map((change) => [change.letter, change.path]).sort()).toEqual([['D', 'b.txt'], ['R', 'renamed.txt']]);
    expect(fs.existsSync(path.join(project, 'b.txt'))).toBe(false);
    await expect(h.service.move(repoId, 'renamed.txt', '../outside.txt')).rejects.toThrow();
    h.service.dispose();
  });

  it('asks on a protected branch: Commit Anyway commits there, Commit to a New Branch creates the named branch and commits on it', async () => {
    const { project, h, repoId } = await open('protected');
    h.settings.values.set(SCM_SETTING_KEYS.branchProtection, ['main']);
    const names: Array<string | undefined> = [];
    const hooks = { branchName: async () => names.shift() };
    write(path.join(project, 'a.txt'), 'one\nedit\n');
    git(['add', 'a.txt'], project);

    h.answers.push(undefined);
    expect(await h.service.commit(repoId, 'Protected', variant(), hooks)).toEqual({ ok: false, reason: 'cancelled' });
    expect(h.questions[0]).toMatchObject({
      severity: 'warning',
      message: 'You are trying to commit to a protected branch. How would you like to proceed?',
      actions: ['Commit to a New Branch', 'Commit Anyway'],
      cancelLabel: 'Cancel',
    });

    h.answers.push(0);
    names.push('bad..name');
    const invalid = await h.service.commit(repoId, 'Protected', variant(), hooks);
    expect(invalid.ok === false && invalid.reason).toBe('failed');
    expect(invalid.ok === false && (invalid.error as Error).message).toBe('Invalid branch name');
    expect(h.log.some((entry) => /^> git check-ref-format --branch "?bad\.\.name"? \[/.test(entry))).toBe(true);
    expect(git(['branch', '--list'], project).trim()).toBe('* main');

    h.answers.push(0);
    names.push('feature/x');
    const mainBefore = headOf(project);
    expect(await h.service.commit(repoId, 'On a new branch', variant(), hooks)).toEqual({ ok: true });
    expect(git(['symbolic-ref', '--short', 'HEAD'], project).trim()).toBe('feature/x');
    expect(messageOf(project)).toBe('On a new branch');
    expect(git(['rev-parse', 'main'], project).trim()).toBe(mainBefore);

    git(['checkout', '--quiet', 'main'], project);
    write(path.join(project, 'a.txt'), 'anyway\n');
    git(['add', 'a.txt'], project);
    h.answers.push(1);
    expect(await h.service.commit(repoId, 'Anyway', variant(), hooks)).toEqual({ ok: true });
    expect(messageOf(project, 'main')).toBe('Anyway');
    h.service.dispose();
  });

  it('skips the protected-branch question at alwaysCommit and alwaysCommitToNewBranch, and matches globs', async () => {
    const { project, h, repoId } = await open('protected-modes');
    h.settings.values.set(SCM_SETTING_KEYS.branchProtection, [' ma* ', '']);
    h.settings.values.set(SCM_SETTING_KEYS.branchProtectionPrompt, 'alwaysCommit');
    const names: Array<string | undefined> = [];
    const hooks = { branchName: async () => names.shift() };
    write(path.join(project, 'a.txt'), 'commit\n');
    git(['add', 'a.txt'], project);
    expect(await h.service.commit(repoId, 'Always commit', variant(), hooks)).toEqual({ ok: true });
    expect(messageOf(project, 'main')).toBe('Always commit');

    h.settings.values.set(SCM_SETTING_KEYS.branchProtectionPrompt, 'alwaysCommitToNewBranch');
    write(path.join(project, 'a.txt'), 'branch\n');
    git(['add', 'a.txt'], project);
    names.push(undefined);
    expect(await h.service.commit(repoId, 'Escaped', variant(), hooks)).toEqual({ ok: false, reason: 'cancelled' });
    expect(stagedOf(project)).toBe('M\ta.txt');
    names.push('topic');
    expect(await h.service.commit(repoId, 'To a new branch', variant(), hooks)).toEqual({ ok: true });
    expect(git(['symbolic-ref', '--short', 'HEAD'], project).trim()).toBe('topic');
    expect(h.questions).toEqual([]);
    h.service.dispose();
  });

  it('reads commit.template relative to the work tree and from ~, without comment lines, and keeps the history newest first', async () => {
    const { project, h, repoId } = await open('template');
    write(path.join(project, '.gitmessage'), '# a comment\nfeat: \n\nWhy:\n');
    git(['config', 'commit.template', '.gitmessage'], project);
    expect(await h.service.commitInput(repoId)).toEqual({ template: 'feat: \n\nWhy:', history: [], headMessage: 'first' });

    const home = folder('home');
    write(path.join(home, 'tmpl.txt'), 'from home\n');
    const homeVar = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const savedHome = process.env[homeVar];
    process.env[homeVar] = home;
    try {
      git(['config', 'commit.template', '~/tmpl.txt'], project);
      expect((await h.service.commitInput(repoId)).template).toBe('from home');
    } finally {
      if (savedHome === undefined) delete process.env[homeVar];
      else process.env[homeVar] = savedHome;
    }
    git(['config', 'commit.template', 'missing.txt'], project);
    expect((await h.service.commitInput(repoId)).template).toBeNull();

    for (const [index, message] of ['one', 'two', 'one'].entries()) {
      write(path.join(project, 'a.txt'), `${message} ${index}\n`);
      git(['add', 'a.txt'], project);
      expect(await h.service.commit(repoId, message, variant())).toEqual({ ok: true });
    }
    expect((await h.service.commitInput(repoId)).history).toEqual(['one', 'two']);
    expect((await h.service.commitInput(repoId)).headMessage).toBe('one');
    expect((await freshStatus(h, repoId)).commit).toEqual({ hash: headOf(project), subject: 'one' });
    h.service.dispose();
  });
});
