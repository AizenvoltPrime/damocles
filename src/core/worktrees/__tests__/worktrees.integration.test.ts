import { execSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitRunner, type GitRunner } from '../../scm/git-runner';
import { GitError } from '../../scm/errors';
import { folder, git, GIT_PATH, HAS_GIT, MapMemento, makeRepo, useGitSandbox, watchers, write } from '../../scm/__tests__/git-harness';
import { approveSetup, createChatWorktree, discardChatWorktree, isSetupApproved, readSetupCommands, worktreeOptions, WorktreeCreateError } from '../create';
import { apply, applyPlan, branchContained, isRewritten, aheadBehind, mergeInto, rebaseOnto, removeWorktree, settlePendingBase, unmergedCommits, updateFrom, worktreeFolderState } from '../integrate';
import { WorktreeRegistry, type ChatWorktreeRecord } from '../registry';
import { folderInRepository, linkedWorktreeOf, scanLeftovers } from '../leftovers';
import { filesToMove, HandOffMoveError, moveFilesToWorktree, WORKTREE_ENTRY, worktreeGitOf } from '../hand-off';
import { EDITOR_MAX_DOCUMENT_BYTES } from '../../../shared/types/messages';
import { piSessionDir } from '../../pi-session/session-store/session-dir';

/** Worktree creation and D33's finish actions against real git; every repository and worktree lives in a temp sandbox. */
useGitSandbox();

let registries: WorktreeRegistry[] = [];
afterEach(() => {
  for (const r of registries) r.dispose();
  registries = [];
});

function runner(maxOutputBytes?: number): GitRunner {
  const version = git(['version'], process.cwd()).trim().match(/(\d+)\.(\d+)\.(\d+)/)!;
  return createGitRunner({ git: { path: GIT_PATH!, version: { major: +version[1]!, minor: +version[2]!, patch: +version[3]! } }, log: { appendLine: () => undefined }, isTrusted: () => true, ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}) });
}

function loggingRunner(lines: string[]): GitRunner {
  const version = git(['version'], process.cwd()).trim().match(/(\d+)\.(\d+)\.(\d+)/)!;
  return createGitRunner({ git: { path: GIT_PATH!, version: { major: +version[1]!, minor: +version[2]!, patch: +version[3]! } }, log: { appendLine: (line) => lines.push(line) }, isTrusted: () => true });
}

function setup(name: string): { project: string; registry: WorktreeRegistry; run: GitRunner } {
  const project = makeRepo(folder(name));
  const registry = new WorktreeRegistry({ rootDir: folder(`${name}-wt`), watcherFactory: watchers, log: () => undefined });
  registries.push(registry);
  return { project, registry, run: runner() };
}

const commitAll = (dir: string, message: string): void => {
  git(['add', '-A'], dir);
  git(['commit', '--quiet', '-m', message], dir);
};

async function create(project: string, registry: WorktreeRegistry, run: GitRunner, overrides: Partial<Parameters<typeof createChatWorktree>[0]> = {}): Promise<ChatWorktreeRecord> {
  return (await createChatWorktree({ git: run, registry, projectPath: project, startRef: 'refs/heads/main', bringChanges: false, slugSource: 'Fix the login page now please', branchPrefix: '', ...overrides })).record;
}

describe.skipIf(!HAS_GIT)('worktree chats against real git', { timeout: 120_000 }, () => {
  it('creates the worktree under the registry root on damocles/<slug> from the current HEAD, with a registered index', async () => {
    const { project, registry, run } = setup('create');
    const record = await create(project, registry, run);
    expect(record.branch).toBe('damocles/fix-the-login-page-now');
    expect(record.index).toBe(1);
    expect(record.worktreeRoot.startsWith(registry.rootDir)).toBe(true);
    expect(fs.existsSync(path.join(record.workingFolder, 'a.txt'))).toBe(true);
    expect(git(['rev-parse', 'HEAD'], record.worktreeRoot).trim()).toBe(git(['rev-parse', 'main'], project).trim());
    expect(registry.projectOf(record.workingFolder)).toBe(project);
    const second = await create(project, registry, run);
    expect(second.branch).toBe('damocles/fix-the-login-page-now-2');
    expect(second.index).toBe(2);
  });

  it('uses branchPrefix, starts from another branch and reports remote branches that are newer', async () => {
    const { project, registry, run } = setup('start');
    git(['branch', 'feat/a'], project);
    write(path.join(project, 'b.txt'), 'b\n');
    commitAll(project, 'on main');
    const record = await create(project, registry, run, { startRef: 'refs/heads/feat/a', branchPrefix: 'ax/' });
    expect(record.branch).toBe('ax/fix-the-login-page-now');
    expect(fs.existsSync(path.join(record.workingFolder, 'b.txt'))).toBe(false);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], project);
    git(['update-ref', 'refs/heads/main', 'HEAD~1'], project);
    git(['checkout', '--quiet', '-f', 'main'], project);
    const options = await worktreeOptions(run, project);
    expect(options.available && options.branches.find((b) => b.name === 'origin/main')?.newer).toBe(1);
  });

  it('reports a folder outside git and a repository with no commit', async () => {
    const run = runner();
    expect(await worktreeOptions(run, folder('nogit'))).toEqual({ available: false, reason: 'notGit' });
    const empty = folder('empty');
    git(['init', '--quiet'], empty);
    expect(await worktreeOptions(run, empty)).toEqual({ available: false, reason: 'noCommits' });
  });

  it('brings two modified files and an untracked one, and the project folder keeps them', async () => {
    const { project, registry, run } = setup('bring');
    write(path.join(project, 'b.txt'), 'b\n');
    commitAll(project, 'b');
    write(path.join(project, 'a.txt'), 'changed a\n');
    write(path.join(project, 'b.txt'), 'changed b\n');
    write(path.join(project, 'new.txt'), 'new\n');
    const options = await worktreeOptions(run, project);
    expect(options.available && options.uncommittedCount).toBe(3);
    const record = await create(project, registry, run, { bringChanges: true });
    for (const [file, text] of [['a.txt', 'changed a\n'], ['b.txt', 'changed b\n'], ['new.txt', 'new\n']] as const) {
      expect(fs.readFileSync(path.join(record.workingFolder, file), 'utf8')).toBe(text);
      expect(fs.readFileSync(path.join(project, file), 'utf8')).toBe(text);
    }
  });

  it('copies only gitignored .worktreeinclude matches and never a tracked file', async () => {
    const { project, registry, run } = setup('include');
    write(path.join(project, '.gitignore'), '.env\nlocal/\n');
    write(path.join(project, 'tracked.env'), 'tracked\n');
    commitAll(project, 'ignore');
    write(path.join(project, '.env'), 'SECRET=1\n');
    write(path.join(project, 'local', 'cache.bin'), 'cache\n');
    write(path.join(project, '.worktreeinclude'), '.env\n*.env\n../outside\n');
    const record = await create(project, registry, run);
    expect(fs.readFileSync(path.join(record.workingFolder, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(fs.existsSync(path.join(record.workingFolder, 'local', 'cache.bin'))).toBe(false);
    expect(fs.readFileSync(path.join(record.workingFolder, 'tracked.env'), 'utf8')).toBe('tracked\n');
  });

  it.skipIf(process.platform === 'win32')('copies an ignored symlink as a link, never its target', async () => {
    const { project, registry, run } = setup('link');
    write(path.join(project, '.gitignore'), 'link.env\n');
    commitAll(project, 'ignore');
    fs.symlinkSync('/etc/hostname', path.join(project, 'link.env'));
    write(path.join(project, '.worktreeinclude'), 'link.env\n');
    const record = await create(project, registry, run);
    expect(fs.lstatSync(path.join(record.workingFolder, 'link.env')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(record.workingFolder, 'link.env'))).toBe('/etc/hostname');
  });

  it('keeps nothing behind when git refuses the branch name', async () => {
    const { project, registry, run } = setup('refuse');
    await expect(create(project, registry, run, { branchPrefix: 'bad..prefix/' })).rejects.toBeInstanceOf(WorktreeCreateError);
    expect(registry.records()).toEqual([]);
  });

  it('applies committed and uncommitted changes, a binary file and a rename, then only the new edits, with the real index untouched', async () => {
    const { project, registry, run } = setup('apply');
    write(path.join(project, 'old-name.txt'), 'rename me\n'.repeat(20));
    commitAll(project, 'seed');
    let record = await create(project, registry, run);
    const wt = record.worktreeRoot;
    git(['mv', 'old-name.txt', 'new-name.txt'], wt);
    fs.writeFileSync(path.join(wt, 'image.bin'), Buffer.from([0, 1, 2, 255, 0, 7]));
    commitAll(wt, 'agent commit');
    write(path.join(wt, 'a.txt'), 'agent edit\n');
    const indexBefore = git(['ls-files', '-s'], wt);
    const first = await apply(record, run, registry);
    expect(first.kind).toBe('ok');
    expect(git(['ls-files', '-s'], wt)).toBe(indexBefore);
    expect(fs.readFileSync(path.join(project, 'a.txt'), 'utf8')).toBe('agent edit\n');
    expect(fs.existsSync(path.join(project, 'new-name.txt'))).toBe(true);
    expect(fs.existsSync(path.join(project, 'old-name.txt'))).toBe(false);
    expect([...fs.readFileSync(path.join(project, 'image.bin'))]).toEqual([0, 1, 2, 255, 0, 7]);
    expect(git(['diff', '--cached', '--name-only'], project)).toBe('');
    record = registry.get(record.id) as ChatWorktreeRecord;
    expect(record.lastAppliedTree).toMatch(/^[0-9a-f]{40}$/);
    commitAll(project, 'user commits the applied work');
    write(path.join(wt, 'c.txt'), 'second\n');
    const second = await apply(record, run, registry);
    expect(second).toEqual({ kind: 'ok', files: ['c.txt'] });
  });

  it('applies a binary change larger than the runner\'s output bound byte for byte', async () => {
    const { project, registry } = setup('apply-large');
    const run = runner(64 * 1024);
    const record = await create(project, registry, run);
    const bytes = crypto.randomBytes(1024 * 1024);
    fs.writeFileSync(path.join(record.worktreeRoot, 'big.bin'), bytes);
    expect(await apply(record, run, registry)).toEqual({ kind: 'ok', files: ['big.bin'] });
    expect(fs.readFileSync(path.join(project, 'big.bin')).equals(bytes)).toBe(true);
  });

  it('copies binary adds, modifies, deletes and renames as objects, leaving unstaged changes as patched files, and patches only the text', async () => {
    const { project, registry } = setup('apply-binaries');
    const blob = (seed: number): Buffer => Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * seed + seed) % 256));
    fs.writeFileSync(path.join(project, 'mod.bin'), blob(3));
    fs.writeFileSync(path.join(project, 'del.bin'), blob(5));
    fs.writeFileSync(path.join(project, 'ren.bin'), blob(7));
    write(path.join(project, 'text.txt'), 'one\n');
    commitAll(project, 'seed');
    const lines: string[] = [];
    const run = loggingRunner(lines);
    const record = await create(project, registry, run);
    const wt = record.worktreeRoot;
    fs.writeFileSync(path.join(wt, 'mod.bin'), blob(11));
    fs.rmSync(path.join(wt, 'del.bin'));
    git(['mv', 'ren.bin', 'renamed.bin'], wt);
    git(['commit', '--quiet', '-m', 'rename'], wt);
    fs.writeFileSync(path.join(wt, 'new.bin'), blob(13));
    write(path.join(wt, 'text.txt'), 'two\n');
    lines.length = 0;
    const outcome = await apply(record, run, registry);
    expect(outcome.kind).toBe('ok');
    for (const name of ['mod.bin', 'renamed.bin', 'new.bin']) expect(fs.readFileSync(path.join(project, name)).equals(fs.readFileSync(path.join(wt, name)))).toBe(true);
    expect(fs.existsSync(path.join(project, 'del.bin'))).toBe(false);
    expect(fs.existsSync(path.join(project, 'ren.bin'))).toBe(false);
    expect(fs.readFileSync(path.join(project, 'text.txt'), 'utf8')).toBe('two\n');
    // the same index and working tree state the patched text file is in: nothing staged
    expect(git(['diff', '--cached', '--name-only'], project).trim()).toBe('');
    expect(git(['status', '--porcelain'], project).split('\n').filter(Boolean).sort()).toEqual([' D del.bin', ' D ren.bin', ' M mod.bin', ' M text.txt', '?? new.bin', '?? renamed.bin']);
    // the snapshot's blob of the untracked file is in the object store the project folder reads
    const newOid = git(['hash-object', 'new.bin'], wt).trim();
    expect(git(['cat-file', '-t', newOid], project).trim()).toBe('blob');
    expect(lines.some((line) => line.startsWith('> git restore ') && line.includes('--pathspec-from-file=-'))).toBe(true);
    const applied = lines.filter((line) => line.startsWith('> git apply --3way --binary'));
    expect(applied).toHaveLength(1);
  });

  it('sends a binary the project changed since the base through --3way, which reports it as a conflict', async () => {
    const { project, registry, run } = setup('apply-binary-conflict');
    fs.writeFileSync(path.join(project, 'img.bin'), Buffer.from([0, 1, 2, 3]));
    commitAll(project, 'seed');
    const record = await create(project, registry, run);
    fs.writeFileSync(path.join(record.worktreeRoot, 'img.bin'), Buffer.from([0, 9, 9, 9]));
    fs.writeFileSync(path.join(project, 'img.bin'), Buffer.from([0, 5, 5, 5]));
    commitAll(project, 'project changes the image');
    const outcome = await apply(record, run, registry);
    expect(outcome).toEqual({ kind: 'conflicts', files: ['img.bin'] });
    expect([...fs.readFileSync(path.join(project, 'img.bin'))]).toEqual([0, 5, 5, 5]);
  });

  it('refuses an Apply whose new binary would land on an ignored file the user keeps there, and writes nothing', async () => {
    const { project, registry, run } = setup('apply-binary-ignored');
    write(path.join(project, '.gitignore'), 'out/\n');
    write(path.join(project, 'text.txt'), 'one\n');
    commitAll(project, 'seed');
    const record = await create(project, registry, run);
    write(path.join(record.worktreeRoot, '.gitignore'), '');
    fs.mkdirSync(path.join(record.worktreeRoot, 'out'), { recursive: true });
    fs.writeFileSync(path.join(record.worktreeRoot, 'out', 'model.bin'), Buffer.from([0, 9, 9, 9]));
    write(path.join(record.worktreeRoot, 'text.txt'), 'two\n');
    fs.mkdirSync(path.join(project, 'out'), { recursive: true });
    fs.writeFileSync(path.join(project, 'out', 'model.bin'), Buffer.from([0, 1, 1, 1]));
    const outcome = await apply(record, run, registry);
    expect(outcome).toEqual({ kind: 'refused', files: [{ path: 'out/model.bin', letter: '!' }] });
    expect([...fs.readFileSync(path.join(project, 'out', 'model.bin'))]).toEqual([0, 1, 1, 1]);
    expect(fs.readFileSync(path.join(project, 'text.txt'), 'utf8')).toBe('one\n');
    expect(fs.readFileSync(path.join(project, '.gitignore'), 'utf8')).toBe('out/\n');
  });

  it('refuses an Apply when the project folder has an unstaged edit to a binary it touches, and changes nothing', async () => {
    const { project, registry, run } = setup('apply-binary-edited');
    fs.writeFileSync(path.join(project, 'img.bin'), Buffer.from([0, 1, 2, 3]));
    commitAll(project, 'seed');
    const record = await create(project, registry, run);
    fs.writeFileSync(path.join(record.worktreeRoot, 'img.bin'), Buffer.from([0, 9, 9, 9]));
    fs.writeFileSync(path.join(project, 'img.bin'), Buffer.from([0, 4, 4, 4]));
    const outcome = await apply(record, run, registry);
    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.files.map((file) => file.path)).toEqual(['img.bin']);
    expect([...fs.readFileSync(path.join(project, 'img.bin'))]).toEqual([0, 4, 4, 4]);
  });

  it('brings a tracked binary change larger than the runner\'s output bound byte for byte', async () => {
    const { project, registry } = setup('bring-large');
    fs.writeFileSync(path.join(project, 'big.bin'), Buffer.from([0, 1, 2]));
    commitAll(project, 'seed');
    const bytes = crypto.randomBytes(1024 * 1024);
    fs.writeFileSync(path.join(project, 'big.bin'), bytes);
    const run = runner(64 * 1024);
    const record = await create(project, registry, run, { bringChanges: true });
    expect(fs.readFileSync(path.join(record.worktreeRoot, 'big.bin')).equals(bytes)).toBe(true);
  });

  it('refuses an Apply that touches a file with local edits, naming it', async () => {
    const { project, registry, run } = setup('apply-refuse');
    const record = await create(project, registry, run);
    write(path.join(record.worktreeRoot, 'a.txt'), 'agent\n');
    write(path.join(project, 'a.txt'), 'user\n');
    expect((await applyPlan(record, run)).clashes).toEqual([{ path: 'a.txt', letter: 'M' }]);
    expect(await apply(record, run, registry)).toEqual({ kind: 'refused', files: [{ path: 'a.txt', letter: 'M' }] });
    expect(fs.readFileSync(path.join(project, 'a.txt'), 'utf8')).toBe('user\n');
  });

  it('asks for a message before merging uncommitted work, then merges', async () => {
    const { project, registry, run } = setup('merge');
    const record = await create(project, registry, run);
    write(path.join(record.worktreeRoot, 'a.txt'), 'merged\n');
    expect(await mergeInto(record, run, registry)).toEqual({ kind: 'needsMessage', files: [{ path: 'a.txt', letter: 'M' }] });
    expect(await mergeInto(record, run, registry, { message: 'Agent work' })).toEqual({ kind: 'ok' });
    expect(fs.readFileSync(path.join(project, 'a.txt'), 'utf8')).toBe('merged\n');
    expect(await unmergedCommits(registry.get(record.id) as ChatWorktreeRecord, run)).toEqual([]);
  });

  it('reports conflicts of a merge that cannot apply cleanly', async () => {
    const { project, registry, run } = setup('conflict');
    const record = await create(project, registry, run);
    write(path.join(record.worktreeRoot, 'a.txt'), 'worktree\n');
    commitAll(record.worktreeRoot, 'wt');
    write(path.join(project, 'a.txt'), 'project\n');
    commitAll(project, 'project');
    expect(await mergeInto(record, run, registry)).toEqual({ kind: 'conflicts', files: ['a.txt'] });
  });

  it('detects a rewritten branch, rebases onto it, and lists only the chat\'s own unmerged commits', async () => {
    const { project, registry, run } = setup('rewritten');
    let record = await create(project, registry, run);
    write(path.join(record.worktreeRoot, 'c.txt'), 'chat\n');
    commitAll(record.worktreeRoot, 'chat commit');
    git(['commit', '--quiet', '--amend', '-m', 'first, amended'], project);
    expect(await isRewritten(record, run)).toBe(true);
    expect(await mergeInto(record, run, registry)).toEqual({ kind: 'rewritten', branch: 'main' });
    expect((await unmergedCommits(record, run)).map((c) => c.subject)).toEqual(['chat commit']);
    expect(await rebaseOnto(record, run, registry)).toEqual({ kind: 'ok' });
    record = registry.get(record.id) as ChatWorktreeRecord;
    expect(await isRewritten(record, run)).toBe(false);
    expect(git(['log', '--format=%s', 'main..HEAD'], record.worktreeRoot).trim()).toBe('chat commit');
    expect(await mergeInto(record, run, registry)).toEqual({ kind: 'ok' });
    expect(await unmergedCommits(registry.get(record.id) as ChatWorktreeRecord, run)).toEqual([]);
  });

  it('counts commits behind the branch, updates from it, and a later Apply copies only the chat\'s changes', async () => {
    const { project, registry, run } = setup('update');
    let record = await create(project, registry, run);
    write(path.join(record.worktreeRoot, 'chat.txt'), 'chat\n');
    commitAll(record.worktreeRoot, 'chat');
    for (const n of [1, 2]) {
      write(path.join(project, `p${n}.txt`), `${n}\n`);
      commitAll(project, `project ${n}`);
    }
    expect(await aheadBehind(record, run)).toEqual({ behind: 2 });
    expect(await updateFrom(record, run, registry)).toEqual({ kind: 'ok' });
    record = registry.get(record.id) as ChatWorktreeRecord;
    expect(await aheadBehind(record, run)).toEqual({ behind: 0 });
    expect(await apply(record, run, registry)).toEqual({ kind: 'ok', files: ['chat.txt'] });
  });

  it('shows git\'s refusal when an update would overwrite an uncommitted worktree file', async () => {
    const { project, registry, run } = setup('update-refuse');
    const record = await create(project, registry, run);
    write(path.join(project, 'a.txt'), 'project\n');
    commitAll(project, 'project');
    write(path.join(record.worktreeRoot, 'a.txt'), 'dirty\n');
    const outcome = await updateFrom(record, run, registry);
    expect(outcome.kind).toBe('refused');
    expect(fs.readFileSync(path.join(record.worktreeRoot, 'a.txt'), 'utf8')).toBe('dirty\n');
  });

  it('removes the worktree, marks the record deleted and frees its index; the branch survives unless asked', async () => {
    const { project, registry, run } = setup('remove');
    const record = await create(project, registry, run);
    await removeWorktree(record, run, registry, { deleteBranch: false, force: false });
    expect(fs.existsSync(record.worktreeRoot)).toBe(false);
    expect(registry.get(record.id)?.deletedAt).toBeTypeOf('number');
    expect(registry.projectOf(record.workingFolder)).toBe(project);
    expect(git(['branch', '--list', record.branch], project).trim()).not.toBe('');
    expect((await create(project, registry, run)).index).toBe(1);
  });

  it('removes the project\'s folder under the worktrees folder with its last worktree, and keeps it while another is left', async () => {
    const { project, registry, run } = setup('remove-last');
    const first = await create(project, registry, run);
    const second = await create(project, registry, run);
    const projectFolder = path.dirname(first.worktreeRoot);
    await removeWorktree(first, run, registry, { deleteBranch: true, force: false });
    expect(fs.existsSync(projectFolder)).toBe(true);
    await removeWorktree(second, run, registry, { deleteBranch: true, force: false });
    expect(fs.existsSync(projectFolder)).toBe(false);
  });

  it('removes the project\'s folder when the discarded unused worktree was its last', async () => {
    const { project, registry, run } = setup('discard-last');
    const record = await create(project, registry, run);
    await discardChatWorktree(run, registry, record);
    expect(fs.existsSync(path.dirname(record.worktreeRoot))).toBe(false);
  });

  // Source control reads the open project meanwhile; on Windows a git opening a config being replaced fails.
  it('deletes a discarded worktree\'s moved branch and its reflog without rewriting the project\'s git config', async () => {
    const { project, registry, run } = setup('discard-config');
    const record = await create(project, registry, run);
    write(path.join(record.worktreeRoot, 'moved.txt'), 'x\n');
    commitAll(record.worktreeRoot, 'moved');
    const config = path.join(project, '.git', 'config');
    const before = { stat: fs.statSync(config), text: fs.readFileSync(config, 'utf8') };
    await discardChatWorktree(run, registry, record);
    expect(git(['branch', '--list', record.branch], project).trim()).toBe('');
    expect(fs.existsSync(path.join(project, '.git', 'logs', 'refs', 'heads', ...record.branch.split('/')))).toBe(false);
    const after = fs.statSync(config);
    expect([after.ino, after.mtimeMs]).toEqual([before.stat.ino, before.stat.mtimeMs]);
    expect(fs.readFileSync(config, 'utf8')).toBe(before.text);
  });

  it('reports an unregistered folder and a git record without its folder, and deletes nothing', async () => {
    const { project, registry, run } = setup('leftovers');
    const record = await create(project, registry, run);
    const stray = path.join(path.dirname(record.worktreeRoot), 'zzzzzzzz');
    fs.mkdirSync(stray);
    const gone = path.join(folder('gone-parent'), 'gone');
    git(['worktree', 'add', '--quiet', '-b', 'gone', gone], project);
    fs.rmSync(gone, { recursive: true, force: true });
    const findings = await scanLeftovers({ registry, git: run, projects: [project], isTrusted: () => true });
    expect(findings).toContainEqual({ path: stray, reason: 'unregistered' });
    expect(findings.some((f) => f.reason === 'gitRecordOnly' && f.path.toLowerCase().endsWith('gone'))).toBe(true);
    expect(fs.existsSync(stray)).toBe(true);
    expect(git(['worktree', 'list', '--porcelain'], project)).toContain('prunable');
  });

  it('scans the other open projects when one project\'s folder is gone', async () => {
    const { project, registry, run } = setup('leftovers-missing-project');
    const gone = path.join(folder('gone-parent-2'), 'gone');
    git(['worktree', 'add', '--quiet', '-b', 'gone', gone], project);
    fs.rmSync(gone, { recursive: true, force: true });
    const missingProject = path.join(folder('removed-project'), 'project');
    const findings = await scanLeftovers({ registry, git: run, projects: [missingProject, project], isTrusted: () => true });
    expect(findings.some((f) => f.reason === 'gitRecordOnly' && f.path.toLowerCase().endsWith('gone'))).toBe(true);
  });

  it('marks a record whose folder was removed in a terminal deleted, and reads a linked worktree without git', async () => {
    const { project, registry, run } = setup('adopt');
    const record = await create(project, registry, run);
    const linked = await linkedWorktreeOf(path.join(record.workingFolder));
    expect(linked && path.resolve(linked.repositoryRoot).toLowerCase()).toBe(path.resolve(project).toLowerCase());
    expect(linked?.branch).toBe(record.branch);
    expect(await linkedWorktreeOf(project)).toBeUndefined();
    git(['worktree', 'remove', '--force', record.worktreeRoot], project);
    expect(await scanLeftovers({ registry, git: run, projects: [project], isTrusted: () => true })).not.toContainEqual({ path: record.worktreeRoot, reason: 'missingFolder' });
    const findings = await scanLeftovers({ registry, git: run, projects: [project], isTrusted: () => true, now: Date.now() + 60 * 60 * 1000 });
    expect(findings).toContainEqual({ path: record.worktreeRoot, reason: 'missingFolder' });
    expect(registry.get(record.id)?.deletedAt).toBeTypeOf('number');
  });

  it('hands a chat\'s two changed files to its worktree and restores them in the project folder, leaving the user\'s third', async () => {
    const { project, registry, run } = setup('handoff');
    write(path.join(project, 'b.txt'), 'b\n');
    commitAll(project, 'b');
    const record = await create(project, registry, run);
    write(path.join(project, 'a.txt'), 'chat edit\n');
    write(path.join(project, 'new.txt'), 'chat created\n');
    write(path.join(project, 'b.txt'), 'user edit\n');
    const files = await filesToMove(project, run, [
      { absolute: path.join(project, 'a.txt'), outsideEdits: true },
      { absolute: path.join(project, 'new.txt'), outsideEdits: false },
      { absolute: path.join(project, 'clean.txt'), outsideEdits: false },
    ]);
    expect(files).toEqual([{ path: 'a.txt', letter: 'M', alsoUserEdits: true }, { path: 'new.txt', letter: 'U', alsoUserEdits: false }]);
    await moveFilesToWorktree(record, run, files);
    expect(fs.readFileSync(path.join(record.workingFolder, 'a.txt'), 'utf8')).toBe('chat edit\n');
    expect(fs.readFileSync(path.join(record.workingFolder, 'new.txt'), 'utf8')).toBe('chat created\n');
    expect(fs.readFileSync(path.join(project, 'a.txt'), 'utf8')).toBe('one\n');
    expect(fs.existsSync(path.join(project, 'new.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(project, 'b.txt'), 'utf8')).toBe('user edit\n');
    const back = await apply(record, run, registry);
    expect(back.kind).toBe('ok');
    expect(fs.readFileSync(path.join(project, 'a.txt'), 'utf8')).toBe('chat edit\n');
    write(path.join(record.worktreeRoot, 'b.txt'), 'chat b\n');
    expect(await apply(registry.get(record.id) as ChatWorktreeRecord, run, registry)).toEqual({ kind: 'refused', files: [{ path: 'b.txt', letter: 'M' }] });
  });

  it('hands off files the chat spelled in another case by the names git lists, where core.ignorecase is on', async (ctx) => {
    const { project, registry, run } = setup('handoff-case');
    write(path.join(project, 'Src', 'Foo.txt'), 'foo\n');
    commitAll(project, 'src');
    if (!fs.existsSync(path.join(project, 'SRC', 'FOO.TXT'))) ctx.skip('this file system tells names apart by case');
    expect(git(['config', '--bool', 'core.ignorecase'], project).trim()).toBe('true');
    const record = await create(project, registry, run);
    write(path.join(project, 'Src', 'Foo.txt'), 'chat edit\n');
    write(path.join(project, 'Src', 'New.txt'), 'chat created\n');
    const files = await filesToMove(project, run, [
      { absolute: path.join(project, 'src', 'FOO.txt'), outsideEdits: false },
      { absolute: path.join(project, 'SRC', 'new.TXT'), outsideEdits: false },
    ]);
    expect(files).toEqual([{ path: 'Src/Foo.txt', letter: 'M', alsoUserEdits: false }, { path: 'Src/New.txt', letter: 'U', alsoUserEdits: false }]);
    await moveFilesToWorktree(record, run, files);
    expect(fs.readFileSync(path.join(record.workingFolder, 'Src', 'Foo.txt'), 'utf8')).toBe('chat edit\n');
    expect(fs.readFileSync(path.join(record.workingFolder, 'Src', 'New.txt'), 'utf8')).toBe('chat created\n');
    expect(git(['status', '--porcelain=v1', '--untracked-files=all'], project)).toBe('');
  });

  it('restores a moved file named in another case than git lists it, where core.ignorecase is on', async (ctx) => {
    const { project, registry, run } = setup('handoff-case-move');
    write(path.join(project, 'Src', 'Foo.txt'), 'foo\n');
    commitAll(project, 'src');
    if (!fs.existsSync(path.join(project, 'SRC', 'FOO.TXT'))) ctx.skip('this file system tells names apart by case');
    const record = await create(project, registry, run);
    write(path.join(project, 'Src', 'Foo.txt'), 'chat edit\n');
    await moveFilesToWorktree(record, run, [{ path: 'src/FOO.txt', letter: 'M', alsoUserEdits: false }]);
    expect(fs.readFileSync(path.join(record.workingFolder, 'Src', 'Foo.txt'), 'utf8')).toBe('chat edit\n');
    expect(fs.readFileSync(path.join(project, 'Src', 'Foo.txt'), 'utf8')).toBe('foo\n');
    expect(git(['status', '--porcelain=v1', '--untracked-files=all'], project)).toBe('');
  });

  it('removes a staged new file from the project folder\'s index too when it moves to the worktree', async () => {
    const { project, registry, run } = setup('handoff-staged');
    const record = await create(project, registry, run);
    write(path.join(project, 'staged.txt'), 'chat created\n');
    git(['add', 'staged.txt'], project);
    const files = await filesToMove(project, run, [{ absolute: path.join(project, 'staged.txt'), outsideEdits: false }]);
    expect(files).toEqual([{ path: 'staged.txt', letter: 'A', alsoUserEdits: false }]);
    await moveFilesToWorktree(record, run, files);
    expect(fs.readFileSync(path.join(record.workingFolder, 'staged.txt'), 'utf8')).toBe('chat created\n');
    expect(fs.existsSync(path.join(project, 'staged.txt'))).toBe(false);
    expect(git(['status', '--porcelain=v1', '--untracked-files=all'], project)).toBe('');
  });

  it('loses no file when git restore fails during a hand-off, and says the project folder may have changed', async () => {
    const { project, registry, run } = setup('handoff-lock');
    const record = await create(project, registry, run);
    write(path.join(project, 'a.txt'), 'chat edit\n');
    write(path.join(project, 'new.txt'), 'chat created\n');
    const files = await filesToMove(project, run, ['a.txt', 'new.txt'].map((name) => ({ absolute: path.join(project, name), outsideEdits: false })));
    // Another git client holds the index.
    const lock = path.join(project, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    try {
      const failure = await moveFilesToWorktree(record, run, files).then(() => undefined, (err: unknown) => err);
      expect(failure).toBeInstanceOf(HandOffMoveError);
      expect((failure as HandOffMoveError).sourcesChanged).toBe(true);
    } finally {
      fs.rmSync(lock);
    }
    for (const dir of [project, record.workingFolder]) {
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('chat edit\n');
      expect(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8')).toBe('chat created\n');
    }
  });

  it('loses no file when removing an untracked source fails during a hand-off', async () => {
    const { project, registry, run } = setup('handoff-rm');
    const record = await create(project, registry, run);
    write(path.join(project, 'a.txt'), 'chat edit\n');
    write(path.join(project, 'new.txt'), 'chat created\n');
    const files = await filesToMove(project, run, ['a.txt', 'new.txt'].map((name) => ({ absolute: path.join(project, name), outsideEdits: false })));
    const rm = fs.promises.rm;
    const busy = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      if (path.resolve(String(target)) === path.join(project, 'new.txt')) throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
      return rm(target, options);
    });
    try {
      const failure = await moveFilesToWorktree(record, run, files).then(() => undefined, (err: unknown) => err);
      expect((failure as HandOffMoveError).sourcesChanged).toBe(true);
    } finally {
      busy.mockRestore();
    }
    expect(fs.readFileSync(path.join(record.workingFolder, 'a.txt'), 'utf8')).toBe('chat edit\n');
    expect(fs.readFileSync(path.join(project, 'a.txt'), 'utf8')).toBe('one\n');
    for (const dir of [project, record.workingFolder]) expect(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8')).toBe('chat created\n');
  });

  it('reports a hand-off copy that fails as leaving the project folder unchanged', async () => {
    const { project, registry, run } = setup('handoff-copy');
    const record = await create(project, registry, run);
    write(path.join(project, 'a.txt'), 'chat edit\n');
    const files = await filesToMove(project, run, [{ absolute: path.join(project, 'a.txt'), outsideEdits: false }]);
    const copy = vi.spyOn(fs.promises, 'copyFile').mockRejectedValueOnce(Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' }));
    try {
      const failure = await moveFilesToWorktree(record, run, files).then(() => undefined, (err: unknown) => err);
      expect((failure as HandOffMoveError).sourcesChanged).toBe(false);
    } finally {
      copy.mockRestore();
    }
    expect(fs.readFileSync(path.join(project, 'a.txt'), 'utf8')).toBe('chat edit\n');
  });

  it('hands off and applies back more paths than one Windows command line holds', async () => {
    const { project, registry, run } = setup('many-paths');
    // 300 names of 120 characters: about 37,000 characters of paths, over the 32,767 a Windows command line takes.
    const names = Array.from({ length: 300 }, (_, i) => `${String(i).padStart(3, '0')}-${'n'.repeat(112)}.txt`);
    for (const name of names) write(path.join(project, 'many', name), 'seed\n');
    commitAll(project, 'many files');
    const record = await create(project, registry, run);
    for (const name of names) write(path.join(project, 'many', name), 'chat edit\n');
    const files = await filesToMove(project, run, names.map((name) => ({ absolute: path.join(project, 'many', name), outsideEdits: false })));
    expect(files).toHaveLength(300);
    await moveFilesToWorktree(record, run, files);
    expect(git(['status', '--porcelain=v1'], project)).toBe('');
    expect(fs.readFileSync(path.join(record.workingFolder, 'many', names[299]!), 'utf8')).toBe('chat edit\n');
    const back = await apply(registry.get(record.id) as ChatWorktreeRecord, run, registry);
    expect(back.kind === 'ok' && back.files.length).toBe(300);
    expect(git(['diff', '--cached', '--name-only'], project)).toBe('');
    expect(fs.readFileSync(path.join(project, 'many', names[0]!), 'utf8')).toBe('chat edit\n');
  });

  it('brings and applies changes in a subfolder when the user sets diff.noprefix', async () => {
    const { project, registry, run } = setup('noprefix');
    write(path.join(project, 'dir', 'b.txt'), 'seed\n');
    commitAll(project, 'dir');
    git(['config', 'diff.noprefix', 'true'], project);
    write(path.join(project, 'dir', 'b.txt'), 'brought\n');
    const record = await create(project, registry, run, { bringChanges: true });
    expect(fs.readFileSync(path.join(record.workingFolder, 'dir', 'b.txt'), 'utf8')).toBe('brought\n');
    git(['checkout', '--', '.'], project);
    write(path.join(record.workingFolder, 'dir', 'b.txt'), 'applied\n');
    expect(await apply(record, run, registry)).toEqual({ kind: 'ok', files: ['dir/b.txt'] });
    expect(fs.readFileSync(path.join(project, 'dir', 'b.txt'), 'utf8')).toBe('applied\n');
  });

  it('removes the branch and the empty folder a refused worktree add leaves, and keeps git\'s error', async () => {
    const { project, registry, run } = setup('add-refused');
    const realRun = run.run.bind(run);
    let created: string | undefined;
    const failing = {
      ...run,
      run: async (call: Parameters<GitRunner['run']>[0]) => {
        if (call.args[0] !== 'worktree' || call.args[1] !== 'add') return realRun(call);
        // As git does: the branch first, then the refusal.
        const branch = call.args[call.args.indexOf('-b') + 1]!;
        created = branch;
        await realRun({ ...call, args: ['branch', branch, call.args.at(-1)!] });
        throw new GitError('git worktree add exited with 128', 128, '', 'fatal: simulated refusal');
      },
    } as GitRunner;
    vi.spyOn(registry, 'remove').mockRejectedValueOnce(new Error('registry write refused'));
    const failure = await createChatWorktree({ git: failing, registry, projectPath: project, startRef: 'refs/heads/main', bringChanges: false, slugSource: 'Fix the login page now please', branchPrefix: '' }).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(WorktreeCreateError);
    expect((failure as Error).message).toContain('simulated refusal');
    expect(created).toBe('damocles/fix-the-login-page-now');
    expect(git(['branch', '--list', created!], project).trim()).toBe('');
    expect(fs.readdirSync(registry.rootDir)).toEqual(['registry.json']);
  });

  it('stops discarding an unused worktree when git refuses to remove it, keeping its folder, branch and record', async () => {
    const { project, registry, run } = setup('discard-refused');
    const record = await create(project, registry, run);
    write(path.join(record.worktreeRoot, 'setup-output.txt'), 'x\n');
    // A locked worktree is one git refuses to remove without a second --force.
    git(['worktree', 'lock', record.worktreeRoot], project);
    await expect(discardChatWorktree(run, registry, record)).rejects.toThrow(record.worktreeRoot);
    expect(fs.existsSync(path.join(record.worktreeRoot, 'setup-output.txt'))).toBe(true);
    expect(registry.get(record.id)).toBeDefined();
    expect(git(['branch', '--list', record.branch], project).trim()).not.toBe('');
    git(['worktree', 'unlock', record.worktreeRoot], project);
    await discardChatWorktree(run, registry, record);
    expect(fs.existsSync(record.worktreeRoot)).toBe(false);
    expect(registry.get(record.id)).toBeUndefined();
    expect(git(['branch', '--list', record.branch], project).trim()).toBe('');
  });

  it('keeps a folder git refused to add into, and deletes only the branch the add made', async () => {
    const { project, registry, run } = setup('add-exists');
    const addChat = registry.addChat.bind(registry);
    vi.spyOn(registry, 'addChat').mockImplementationOnce(async (record) => {
      write(path.join(record.worktreeRoot, 'keep.txt'), 'user\n');
      return addChat(record);
    });
    await expect(create(project, registry, run)).rejects.toBeInstanceOf(WorktreeCreateError);
    expect(git(['branch', '--list', 'damocles/*'], project).trim()).toBe('');
    expect(registry.records()).toEqual([]);
    const projectDir = fs.readdirSync(registry.rootDir).find((name) => name !== 'registry.json')!;
    expect(fs.readdirSync(path.join(registry.rootDir, projectDir))).toHaveLength(1);
  });

  it('removes a worktree holding a folder link to outside it and leaves the link\'s target in place', async () => {
    const { project, registry, run } = setup('remove-link');
    const record = await create(project, registry, run);
    const outside = folder('outside');
    write(path.join(outside, 'keep.txt'), 'keep\n');
    fs.symlinkSync(outside, path.join(record.worktreeRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await removeWorktree(record, run, registry, { deleteBranch: false, force: true });
    expect(registry.get(record.id)?.deletedAt).toBeTypeOf('number');
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep\n');
  });

  it('leaves the cleanly applied files of an Apply with conflicts unstaged', async () => {
    const { project, registry, run } = setup('apply-conflict');
    const record = await create(project, registry, run);
    write(path.join(record.worktreeRoot, 'a.txt'), 'worktree\n');
    write(path.join(record.worktreeRoot, 'clean.txt'), 'clean\n');
    write(path.join(project, 'a.txt'), 'project\n');
    commitAll(project, 'project edit');
    expect(await apply(record, run, registry)).toEqual({ kind: 'conflicts', files: ['a.txt'] });
    expect(git(['diff', '--cached', '--name-only', '--diff-filter=ACDMRT'], project).trim()).toBe('');
    expect(git(['status', '--porcelain=v1', '--untracked-files=all'], project)).toContain('?? clean.txt');
  });

  it('copies anchored .worktreeinclude patterns of a project that is a subfolder of its repository', async () => {
    const { project: repo, registry, run } = setup('include-sub');
    const project = path.join(repo, 'app');
    write(path.join(project, 'keep.txt'), 'keep\n');
    write(path.join(repo, '.gitignore'), 'local.env\nnode_modules/\n');
    commitAll(repo, 'app');
    write(path.join(project, 'config', 'local.env'), 'A=1\n');
    write(path.join(project, 'local.env'), 'B=1\n');
    write(path.join(project, 'node_modules', 'pkg', 'index.js'), 'x\n');
    write(path.join(project, '.worktreeinclude'), '/config/local.env\n');
    const record = await create(project, registry, run);
    expect(fs.readFileSync(path.join(record.workingFolder, 'config', 'local.env'), 'utf8')).toBe('A=1\n');
    expect(fs.existsSync(path.join(record.workingFolder, 'local.env'))).toBe(false);
    expect(fs.existsSync(path.join(record.workingFolder, 'node_modules'))).toBe(false);
  });

  it('copies an anchored pattern of a subfolder project whose .worktreeinclude starts with a BOM', async () => {
    const { project: repo, registry, run } = setup('include-sub-bom');
    const project = path.join(repo, 'app');
    write(path.join(project, 'keep.txt'), 'keep\n');
    write(path.join(repo, '.gitignore'), 'local.env\n');
    commitAll(repo, 'app');
    write(path.join(project, 'config', 'local.env'), 'A=1\n');
    write(path.join(project, '.worktreeinclude'), '\uFEFF/config/local.env\n');
    const record = await create(project, registry, run);
    expect(fs.readFileSync(path.join(record.workingFolder, 'config', 'local.env'), 'utf8')).toBe('A=1\n');
  });

  it('skips a link the OS refuses to create and names it, and the creation succeeds', async (ctx) => {
    const { project, registry, run } = setup('link-eperm');
    write(path.join(project, '.gitignore'), 'link.env\n');
    write(path.join(project, 'target.env'), 'T=1\n');
    commitAll(project, 'ignore');
    try {
      fs.symlinkSync('target.env', path.join(project, 'link.env'), 'file');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') ctx.skip();
      throw err;
    }
    write(path.join(project, '.worktreeinclude'), 'link.env\n');
    const refuse = vi.spyOn(fs.promises, 'symlink').mockRejectedValue(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }));
    try {
      const created = await createChatWorktree({ git: run, registry, projectPath: project, startRef: 'refs/heads/main', bringChanges: false, slugSource: 'links', branchPrefix: '' });
      expect(created.skippedLinks).toEqual(['link.env']);
      expect(fs.existsSync(path.join(created.record.workingFolder, 'link.env'))).toBe(false);
      expect(registry.get(created.record.id)?.deletedAt).toBeUndefined();
    } finally {
      refuse.mockRestore();
    }
  });

  it('prunes and marks deleted a worktree whose folder was removed outside Damocles', async () => {
    const { project, registry, run } = setup('remove-missing');
    const record = await create(project, registry, run);
    fs.rmSync(record.worktreeRoot, { recursive: true, force: true });
    await removeWorktree(record, run, registry, { deleteBranch: true, force: false });
    expect(registry.get(record.id)?.deletedAt).toBeTypeOf('number');
    expect(git(['worktree', 'list', '--porcelain'], project)).not.toContain(path.basename(record.worktreeRoot));
    expect(git(['branch', '--list', record.branch], project).trim()).toBe('');
  });

  it('removes the folder a refused git worktree remove left without its .git link, then prunes git\'s record and deletes the branch asked for', async () => {
    const { project, registry, run } = setup('remove-leftover');
    const record = await create(project, registry, run);
    expect(await worktreeFolderState(record.worktreeRoot)).toBe('worktree');
    // what git leaves on Windows when another process holds the folder: its contents and .git link gone, a held file and the folder kept
    fs.rmSync(path.join(record.worktreeRoot, '.git'));
    write(path.join(record.worktreeRoot, 'held.txt'), 'x\n');
    expect(await worktreeFolderState(record.worktreeRoot)).toBe('leftover');
    await removeWorktree(record, run, registry, { deleteBranch: true, force: false });
    expect(fs.existsSync(record.worktreeRoot)).toBe(false);
    expect(await worktreeFolderState(record.worktreeRoot)).toBe('gone');
    expect(registry.get(record.id)?.deletedAt).toBeTypeOf('number');
    expect(git(['worktree', 'list', '--porcelain'], project)).not.toContain(path.basename(record.worktreeRoot));
    expect(git(['branch', '--list', record.branch], project).trim()).toBe('');
  });

  it('reports a live chat worktree past the creation grace that no session names', async () => {
    const { project, registry, run } = setup('no-chat');
    const record = await create(project, registry, run);
    const later = Date.now() + 60 * 60 * 1000;
    expect(await scanLeftovers({ registry, git: run, projects: [project], isTrusted: () => true, now: later })).toContainEqual({ path: record.worktreeRoot, reason: 'noChat', projectPath: project, worktreeId: record.id });
    const dir = piSessionDir(project);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2025-01-01T00-00-00-000Z_handed.jsonl'), `${JSON.stringify({ type: 'custom', customType: WORKTREE_ENTRY, data: { worktreeId: record.id, projectPath: project, place: 'worktree' } })}\n`);
    expect((await scanLeftovers({ registry, git: run, projects: [project], isTrusted: () => true, now: later })).some((f) => f.reason === 'noChat')).toBe(false);
    expect(registry.get(record.id)?.deletedAt).toBeUndefined();
    // Once a chat has worked in it, the worktree is no leftover after its sessions are gone (a kept worktree).
    expect((registry.get(record.id) as ChatWorktreeRecord).usedAt).toBeTypeOf('number');
    fs.rmSync(dir, { recursive: true, force: true });
    expect((await scanLeftovers({ registry, git: run, projects: [project], isTrusted: () => true, now: later })).some((f) => f.reason === 'noChat')).toBe(false);
  });

  it('keeps the base when a conflicted Merge into is aborted, and takes the merged commit in once the merge is committed', async () => {
    const { project, registry, run } = setup('merge-abort');
    const record = await create(project, registry, run);
    write(path.join(record.worktreeRoot, 'a.txt'), 'worktree\n');
    commitAll(record.worktreeRoot, 'chat work');
    write(path.join(project, 'a.txt'), 'project\n');
    commitAll(project, 'project work');
    const merged = git(['rev-parse', 'HEAD'], record.worktreeRoot).trim();
    expect(await mergeInto(record, run, registry)).toEqual({ kind: 'conflicts', files: ['a.txt'] });
    let current = registry.get(record.id) as ChatWorktreeRecord;
    expect(current.baseCommit).toBe(record.baseCommit);
    expect(current.pendingBase).toEqual({ commit: merged, side: 'project' });
    git(['merge', '--abort'], project);
    expect((await unmergedCommits(current, run)).map((c) => c.subject)).toEqual(['chat work']);
    expect(await branchContained(current, run)).toBe(false);
    current = await settlePendingBase(current, run, registry);
    expect(current.baseCommit).toBe(record.baseCommit);
    expect(current.pendingBase).toBeUndefined();
    expect((await mergeInto(current, run, registry)).kind).toBe('conflicts');
    write(path.join(project, 'a.txt'), 'resolved\n');
    git(['add', 'a.txt'], project);
    git(['commit', '--quiet', '--no-edit'], project);
    current = await settlePendingBase(current, run, registry);
    expect(current.baseCommit).toBe(merged);
    expect(current.pendingBase).toBeUndefined();
    expect(await branchContained(current, run)).toBe(true);
  });

  it('keeps the base when a conflicted Update is aborted, so a later Apply never reverts the project\'s commits', async () => {
    const { project, registry, run } = setup('update-abort');
    write(path.join(project, 'c.txt'), 'seed\n');
    commitAll(project, 'seed c');
    const record = await create(project, registry, run);
    write(path.join(record.worktreeRoot, 'c.txt'), 'worktree\n');
    commitAll(record.worktreeRoot, 'chat work');
    write(path.join(project, 'c.txt'), 'project\n');
    write(path.join(project, 'p.txt'), 'project only\n');
    commitAll(project, 'project work');
    const taken = git(['rev-parse', 'main'], project).trim();
    expect(await updateFrom(record, run, registry)).toEqual({ kind: 'conflicts', files: ['c.txt'] });
    expect((registry.get(record.id) as ChatWorktreeRecord).baseCommit).toBe(record.baseCommit);
    git(['merge', '--abort'], record.worktreeRoot);
    expect((await applyPlan(registry.get(record.id) as ChatWorktreeRecord, run)).touched).toEqual(['c.txt']);
    let current = await settlePendingBase(record, run, registry);
    expect(current.baseCommit).toBe(record.baseCommit);
    expect(current.pendingBase).toBeUndefined();
    expect((await updateFrom(current, run, registry)).kind).toBe('conflicts');
    write(path.join(record.worktreeRoot, 'c.txt'), 'resolved\n');
    git(['add', 'c.txt'], record.worktreeRoot);
    git(['commit', '--quiet', '--no-edit'], record.worktreeRoot);
    current = await settlePendingBase(current, run, registry);
    expect(current.baseCommit).toBe(taken);
    expect((await applyPlan(current, run)).touched).toEqual(['c.txt']);
  });

  it('keeps the base when a conflicted Rebase is aborted, and takes the onto commit in once the rebase finishes', async () => {
    const { project, registry, run } = setup('rebase-abort');
    const record = await create(project, registry, run);
    write(path.join(record.worktreeRoot, 'a.txt'), 'worktree\n');
    commitAll(record.worktreeRoot, 'chat work');
    write(path.join(project, 'a.txt'), 'project\n');
    commitAll(project, 'project work');
    const onto = git(['rev-parse', 'main'], project).trim();
    expect(await rebaseOnto(record, run, registry)).toEqual({ kind: 'conflicts', files: ['a.txt'] });
    let current = registry.get(record.id) as ChatWorktreeRecord;
    expect(current.baseCommit).toBe(record.baseCommit);
    // HEAD descends from the onto commit while the rebase runs, which must not count as taken in.
    expect((await settlePendingBase(current, run, registry)).pendingBase).toEqual({ commit: onto, side: 'worktree' });
    git(['rebase', '--abort'], record.worktreeRoot);
    current = await settlePendingBase(current, run, registry);
    expect(current.baseCommit).toBe(record.baseCommit);
    expect(current.pendingBase).toBeUndefined();
    expect((await rebaseOnto(current, run, registry)).kind).toBe('conflicts');
    write(path.join(record.worktreeRoot, 'a.txt'), 'resolved\n');
    git(['add', 'a.txt'], record.worktreeRoot);
    git(['-c', 'core.editor=true', 'rebase', '--continue'], record.worktreeRoot);
    current = await settlePendingBase(current, run, registry);
    expect(current.baseCommit).toBe(onto);
    expect(await isRewritten(current, run)).toBe(false);
  });

  it('refuses a finish action while a merge or rebase is unfinished, and leaves the base and the pending base alone', async () => {
    const { project, registry, run } = setup('refuse-in-progress');
    const record = await create(project, registry, run);
    write(path.join(record.worktreeRoot, 'a.txt'), 'worktree\n');
    commitAll(record.worktreeRoot, 'chat work');
    write(path.join(project, 'a.txt'), 'project\n');
    commitAll(project, 'project work');
    expect((await updateFrom(record, run, registry)).kind).toBe('conflicts');
    const pending = (registry.get(record.id) as ChatWorktreeRecord).pendingBase;
    for (const action of [updateFrom, rebaseOnto, mergeInto]) {
      const outcome = await action(record, run, registry);
      expect(outcome).toEqual({ kind: 'refused', message: expect.stringContaining(record.worktreeRoot) as unknown as string });
      expect((registry.get(record.id) as ChatWorktreeRecord).baseCommit).toBe(record.baseCommit);
      expect((registry.get(record.id) as ChatWorktreeRecord).pendingBase).toEqual(pending);
    }
    git(['merge', '--abort'], record.worktreeRoot);
    // A merge the user left unfinished in the project folder refuses Merge into the same way.
    git(['checkout', '--quiet', '-b', 'side', 'HEAD~1'], project);
    write(path.join(project, 'a.txt'), 'side\n');
    commitAll(project, 'side work');
    git(['checkout', '--quiet', 'main'], project);
    expect(() => git(['merge', 'side'], project)).toThrow();
    const settled = await settlePendingBase(record, run, registry);
    expect(settled.pendingBase).toBeUndefined();
    expect(await mergeInto(settled, run, registry)).toEqual({ kind: 'refused', message: expect.stringContaining(project) as unknown as string });
    expect((registry.get(record.id) as ChatWorktreeRecord).baseCommit).toBe(record.baseCommit);
  });

  it('throws, recording nothing, when git apply fails and the only unmerged path is an older one', async () => {
    const { project, registry, run } = setup('apply-older-unmerged');
    write(path.join(project, 'm.txt'), 'seed\n');
    commitAll(project, 'seed m');
    const record = await create(project, registry, run);
    write(path.join(record.worktreeRoot, 'd', 'x.txt'), 'chat\n');
    // The project commits a file where the chat made a folder, so the patch cannot apply.
    write(path.join(project, 'd'), 'file\n');
    commitAll(project, 'd is a file');
    git(['checkout', '--quiet', '-b', 'side', 'HEAD~1'], project);
    write(path.join(project, 'm.txt'), 'side\n');
    commitAll(project, 'side m');
    git(['checkout', '--quiet', 'main'], project);
    write(path.join(project, 'm.txt'), 'main\n');
    commitAll(project, 'main m');
    expect(() => git(['merge', 'side'], project)).toThrow();
    await expect(apply(record, run, registry)).rejects.toThrow();
    expect((registry.get(record.id) as ChatWorktreeRecord).lastAppliedTree).toBeUndefined();
  });

  it('offers HEAD\'s commit as the current start on a detached HEAD, and creates from it with the uncommitted changes', async () => {
    const { project, registry, run } = setup('detached-options');
    write(path.join(project, 'b.txt'), 'b\n');
    commitAll(project, 'second');
    git(['checkout', '--quiet', '--detach', 'HEAD~1'], project);
    const head = git(['rev-parse', 'HEAD'], project).trim();
    write(path.join(project, 'a.txt'), 'uncommitted\n');
    const options = await worktreeOptions(run, project);
    expect(options.available && options.currentBranch).toBeNull();
    const current = options.available ? options.branches.filter((b) => b.current) : [];
    expect(current).toEqual([{ ref: 'HEAD', name: git(['rev-parse', '--short', 'HEAD'], project).trim(), current: true, remote: false }]);
    const record = await create(project, registry, run, { startRef: 'HEAD', bringChanges: true });
    expect(record.baseCommit).toBe(head);
    expect(fs.readFileSync(path.join(record.workingFolder, 'a.txt'), 'utf8')).toBe('uncommitted\n');
    expect(fs.existsSync(path.join(record.workingFolder, 'b.txt'))).toBe(false);
  });

  it('counts newer commits only for remote branches whose tip differs from their local branch', async () => {
    const { project, run } = setup('newer-counts');
    git(['branch', 'feat'], project);
    write(path.join(project, 'f.txt'), 'f\n');
    commitAll(project, 'on main');
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], project);
    git(['update-ref', 'refs/remotes/origin/feat', 'HEAD'], project);
    const counted: string[] = [];
    const counting = { ...run, run: (call: Parameters<GitRunner['run']>[0]) => {
      if (call.args[0] === 'rev-list') counted.push(call.args.at(-1)!);
      return run.run(call);
    } } as GitRunner;
    const options = await worktreeOptions(counting, project);
    expect(counted).toEqual(['refs/heads/feat..refs/remotes/origin/feat']);
    expect(options.available && options.branches.find((b) => b.name === 'origin/feat')?.newer).toBe(1);
    expect(options.available && options.branches.find((b) => b.name === 'origin/main')?.newer).toBeUndefined();
  });

  it('reads a file at the base commit as absent only when git says it is missing there', async () => {
    const { project, registry, run } = setup('at-base');
    write(path.join(project, 'dir', 'x.txt'), 'x\n');
    fs.writeFileSync(path.join(project, 'big.txt'), Buffer.alloc(EDITOR_MAX_DOCUMENT_BYTES + 1, 0x61));
    commitAll(project, 'files');
    const record = await create(project, registry, run);
    const reads = worktreeGitOf(record, run);
    expect(await reads.atBase(record.baseCommit, 'a.txt')).toEqual({ kind: 'text', text: 'one\n' });
    expect(await reads.atBase(record.baseCommit, 'nope.txt')).toEqual({ kind: 'absent' });
    // A folder and a blob over the review's bound are there, but cannot be shown.
    expect(await reads.atBase(record.baseCommit, 'dir')).toEqual({ kind: 'unavailable' });
    expect(await reads.atBase(record.baseCommit, 'big.txt')).toEqual({ kind: 'unavailable' });
  });

  it('keeps the record live and names the path when git cannot remove the worktree', async () => {
    const { project, registry, run } = setup('remove-fail');
    const record = await create(project, registry, run);
    write(path.join(record.worktreeRoot, 'dirty.txt'), 'x\n');
    await expect(removeWorktree(record, run, registry, { deleteBranch: false, force: false })).rejects.toThrow(record.worktreeRoot);
    expect(registry.get(record.id)?.deletedAt).toBeUndefined();
  });

  // Windows' 260-character limit: a path that fits in the project passes it in the deeper worktree. Fails without
  // core.longpaths on Windows only; elsewhere it is a deep-path smoke test, and git-runner.test.ts covers the environment.
  it('creates, reads and removes a worktree whose paths pass 260 characters only there', async () => {
    const project = makeRepo(folder('longpaths'));
    const registry = new WorktreeRegistry({ rootDir: path.join(folder('longpaths-wt'), 'w'.repeat(60)), watcherFactory: watchers, log: () => undefined });
    registries.push(registry);
    const run = runner();
    const tracked = `${'d'.repeat(240 - project.length - 1)}/f.txt`;
    write(path.join(project, tracked), 'x\n');
    write(path.join(project, '.gitignore'), 'deep/\n');
    commitAll(project, 'deep file');
    const record = await create(project, registry, run);
    expect(path.join(record.worktreeRoot, tracked).length).toBeGreaterThan(260);
    expect(fs.readFileSync(path.join(record.worktreeRoot, tracked), 'utf8')).toBe('x\n');
    const status = await run.run({ project, cwd: record.worktreeRoot, args: ['status', '--porcelain'], kind: 'status' });
    expect(status.stdout.toString('utf8')).toBe('');
    write(path.join(record.worktreeRoot, 'deep', 'e'.repeat(120), 'f'.repeat(120), 'g.bin'), 'x');
    await removeWorktree(record, run, registry, { deleteBranch: true, force: true });
    expect(fs.existsSync(record.worktreeRoot)).toBe(false);
    expect(registry.get(record.id)?.deletedAt).toBeTypeOf('number');
  });
});

describe('setup commands (D32)', () => {
  it('reads the OS array over setup and remembers the approval hash per project', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-setup-'));
    fs.mkdirSync(path.join(project, '.damocles'));
    fs.writeFileSync(path.join(project, '.damocles', 'worktree.json'), JSON.stringify({ setup: ['npm ci'], setupWindows: ['npm.cmd ci'], setupUnix: ['npm ci --unix'] }));
    expect(await readSetupCommands(project, 'win32')).toEqual(['npm.cmd ci']);
    expect(await readSetupCommands(project, 'linux')).toEqual(['npm ci --unix']);
    const state = new MapMemento();
    const commands = await readSetupCommands(project, 'linux');
    expect(isSetupApproved(state, project, commands)).toBe(false);
    await approveSetup(state, project, commands);
    expect(isSetupApproved(state, project, commands)).toBe(true);
    expect(isSetupApproved(state, project, ['npm ci --unix', 'rm -rf /'])).toBe(false);
    fs.writeFileSync(path.join(project, '.damocles', 'worktree.json'), JSON.stringify({ setup: ['ok', 3] }));
    await expect(readSetupCommands(project, 'linux')).rejects.toThrow('non-empty commands');
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('reads a worktree.json that starts with a BOM', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-setup-'));
    try {
      fs.mkdirSync(path.join(project, '.damocles'));
      fs.writeFileSync(path.join(project, '.damocles', 'worktree.json'), `\uFEFF${JSON.stringify({ setup: ['npm ci'] })}`);
      expect(await readSetupCommands(project, 'linux')).toEqual(['npm ci']);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('refuses a command spanning lines and commands too long for one shell command line', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-setup-'));
    fs.mkdirSync(path.join(project, '.damocles'));
    const file = path.join(project, '.damocles', 'worktree.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ setup: ['npm ci\nrm -rf build'] }));
      await expect(readSetupCommands(project, 'linux')).rejects.toThrow('must be one line');
      fs.writeFileSync(file, JSON.stringify({ setup: Array.from({ length: 2 }, () => 'x'.repeat(4000)) }));
      await expect(readSetupCommands(project, 'linux')).rejects.toThrow('8000 characters long together');
      fs.writeFileSync(file, JSON.stringify({ setup: ['x'.repeat(4000), 'y'.repeat(2000)] }));
      expect(await readSetupCommands(project, 'linux')).toHaveLength(2);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('never reads worktree.json through a link', async (ctx) => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-setup-'));
    fs.mkdirSync(path.join(project, '.damocles'));
    const target = path.join(project, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify({ setup: ['npm ci'] }));
    try {
      try {
        fs.symlinkSync(target, path.join(project, '.damocles', 'worktree.json'), 'file');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EPERM') ctx.skip();
        throw err;
      }
      await expect(readSetupCommands(project, 'linux')).rejects.toThrow('not a regular file');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('linked worktrees read from git\'s files', () => {
  it.skipIf(process.platform !== 'win32')('refuses a linked worktree whose commondir names another host', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-linked-')));
    try {
      const gitDir = path.join(base, 'main', '.git', 'worktrees', 'wt');
      const worktree = path.join(base, 'wt');
      fs.mkdirSync(gitDir, { recursive: true });
      fs.mkdirSync(worktree);
      fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
      fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/wt\n');
      fs.writeFileSync(path.join(gitDir, 'gitdir'), `${path.join(worktree, '.git')}\n`);
      fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
      expect((await linkedWorktreeOf(worktree))?.repositoryRoot).toBe(path.join(base, 'main'));
      fs.writeFileSync(path.join(gitDir, 'commondir'), '\\\\attacker.invalid\\share\\.git\n');
      expect(await linkedWorktreeOf(worktree)).toBeUndefined();
      fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
      fs.writeFileSync(path.join(gitDir, 'gitdir'), '\\\\?\\UNC\\attacker.invalid\\share\\wt\\.git\n');
      expect(await linkedWorktreeOf(worktree)).toBeUndefined();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

const shortName = (target: string): string => execSync(`for %I in ("${target}") do @echo %~sI`, { shell: 'cmd.exe', encoding: 'utf8' }).trim();
// A junction needs no privilege on Windows; elsewhere a directory symlink is the same kind of second spelling.
const linkFolder = (target: string, link: string): void => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');

describe.skipIf(!HAS_GIT)('a project spelled otherwise than git spells its repository', { timeout: 120_000 }, () => {
  it.runIf(process.platform === 'win32')('creates, hands off to and applies from a worktree of a project listed by its 8.3 alias', async (ctx) => {
    const repo = makeRepo(path.join(folder('alias'), 'Long Project Folder'));
    write(path.join(repo, 'Sub Folder Name', 'b.txt'), 'b\n');
    commitAll(repo, 'sub');
    const short = shortName(repo);
    if (short === repo) ctx.skip('8.3 names are off on this volume');
    const registry = new WorktreeRegistry({ rootDir: folder('alias-wt'), watcherFactory: watchers, log: () => undefined });
    registries.push(registry);
    const run = runner();
    const record = await create(short, registry, run);
    expect(record.repositoryRoot).toBe(short);
    expect(record.workingFolder).toBe(record.worktreeRoot);
    write(path.join(repo, 'a.txt'), 'chat edit\n');
    const files = await filesToMove(short, run, [{ absolute: path.join(short, 'a.txt'), outsideEdits: false }]);
    expect(files).toEqual([{ path: 'a.txt', letter: 'M', alsoUserEdits: false }]);
    await moveFilesToWorktree(record, run, files);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('one\n');
    expect((await apply(record, run, registry)).kind).toBe('ok');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('chat edit\n');
    const sub = await create(shortName(path.join(repo, 'Sub Folder Name')), registry, run, { slugSource: 'sub folder project' });
    expect(path.relative(sub.worktreeRoot, sub.workingFolder)).toBe('Sub Folder Name');
  });

  it('creates and hands off in a worktree of a project listed through a link to its repository, or to a folder in it', async () => {
    const { project: repo, registry, run } = setup('linked');
    write(path.join(repo, 'app', 'b.txt'), 'b\n');
    commitAll(repo, 'app');
    const link = path.join(folder('links'), 'linked');
    linkFolder(repo, link);
    const record = await create(link, registry, run);
    expect(record.repositoryRoot).toBe(link);
    write(path.join(repo, 'a.txt'), 'chat edit\n');
    const files = await filesToMove(link, run, [{ absolute: path.join(link, 'a.txt'), outsideEdits: false }]);
    expect(files).toEqual([{ path: 'a.txt', letter: 'M', alsoUserEdits: false }]);
    await moveFilesToWorktree(record, run, files);
    expect(fs.readFileSync(path.join(record.workingFolder, 'a.txt'), 'utf8')).toBe('chat edit\n');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('one\n');
    const app = await create(path.join(link, 'app'), registry, run, { slugSource: 'app folder project' });
    expect(path.relative(app.worktreeRoot, app.workingFolder)).toBe('app');
  });

  it('finds the open project a linked worktree belongs to when that project is listed through a link', async () => {
    const { project: repo } = setup('holder');
    const link = path.join(folder('holder-links'), 'linked');
    linkFolder(repo, link);
    const elsewhere = folder('elsewhere');
    expect(await folderInRepository(repo, [elsewhere, link])).toBe(link);
    expect(await folderInRepository(repo, [elsewhere, path.join(folder('gone'), 'missing')])).toBeUndefined();
  });

  it('refuses a project reached through a link inside its repository, naming the link and the real folder, and leaves nothing', async () => {
    const { project: repo, registry, run } = setup('inner-link');
    write(path.join(repo, 'app', 'b.txt'), 'b\n');
    commitAll(repo, 'app');
    const link = path.join(folder('inner-links'), 'app-link');
    linkFolder(path.join(repo, 'app'), link);
    const refused = create(link, registry, run);
    await expect(refused).rejects.toBeInstanceOf(WorktreeCreateError);
    await expect(refused).rejects.toThrow(`${link} leads into the repository ${repo} through a link, below its root, so git cannot work on it there. Add the project by its own path, ${path.join(repo, 'app')}.`);
    expect(registry.records()).toEqual([]);
  });
});
