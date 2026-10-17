// D33's finish actions on a chat worktree: Apply, Merge into, Update from, Rebase onto and Delete, all through the GitRunner
// with argv only. No UI here: the host asks its questions and calls these in order (rule 14 for Delete).
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { MAX_CLI_LENGTH, revision, splitInChunks, type GitRunner } from '../scm/git-runner';
import { compassIndexPath } from '../compass/util';
import { t } from '../l10n';
import { log } from '../logger';
import { folderIdFor, getFolderRepoDir } from '../pi-session/checkpoints/resolver';
import { currentBranchRef, gitMessage, nulList, projectGit, uncommittedFiles as statusFiles, withPatchFile, withTempFolder, type ProjectGit, type WorktreeFile } from './create';
import type { ChatWorktreeRecord, PendingBase, WorktreeRegistry } from './registry';

export type ApplyOutcome =
  | { kind: 'ok'; files: string[] }
  | { kind: 'refused'; files: WorktreeFile[] }
  | { kind: 'conflicts'; files: string[] };

export type MergeOutcome =
  | { kind: 'ok' }
  | { kind: 'needsMessage'; files: WorktreeFile[] }
  | { kind: 'detached' }
  | { kind: 'rewritten'; branch: string }
  | { kind: 'conflicts'; files: string[] }
  | { kind: 'refused'; message: string };

export type UpdateOutcome =
  | { kind: 'ok' }
  | { kind: 'detached' }
  | { kind: 'rewritten'; branch: string }
  | { kind: 'conflicts'; files: string[] }
  | { kind: 'refused'; message: string };

function gitOf(record: ChatWorktreeRecord, runner: GitRunner): ProjectGit {
  return projectGit(runner, record.projectPath);
}

/** The branch checked out in the project folder (D33's `<branch>`), or undefined on a detached HEAD. */
export async function targetBranch(record: ChatWorktreeRecord, runner: GitRunner): Promise<string | undefined> {
  const ref = await currentBranchRef(gitOf(record, runner), record.projectPath);
  return ref?.slice('refs/heads/'.length);
}

async function unmergedPaths(git: ProjectGit, cwd: string): Promise<string[]> {
  return nulList((await git.run(cwd, ['diff', '--name-only', '-z', '--diff-filter=U'])).stdout);
}

// git's own markers of an unfinished operation (wt-status.c, VS Code's Repository.operation), kept per worktree.
const OPERATION_MARKERS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer'];

/** True while a merge, rebase, cherry-pick or revert in `cwd`'s worktree waits to be finished or aborted. */
async function operationInProgress(git: ProjectGit, cwd: string): Promise<boolean> {
  // --git-path names the linked worktree's own git dir, where its MERGE_HEAD and rebase-merge live.
  const paths = (await git.text(cwd, ['rev-parse', ...OPERATION_MARKERS.flatMap((name) => ['--git-path', name])])).split('\n');
  if (paths.length !== OPERATION_MARKERS.length) throw new Error('git rev-parse --git-path printed an unexpected answer');
  for (const marker of paths) {
    try {
      await fs.lstat(path.resolve(cwd, marker));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return false;
}

function operationRefusal(folder: string): { kind: 'refused'; message: string } {
  return { kind: 'refused', message: t('{0} has an unfinished merge, rebase, cherry pick or revert. Finish or abort it, then try again.', folder) };
}

function gitRefusal(result: { stderr: string; stdout: Buffer }): { kind: 'refused'; message: string } {
  return { kind: 'refused', message: (result.stderr.trim() || result.stdout.toString('utf8').trim()).slice(0, 2000) };
}

/**
 * Where a pending base stands: `running` while its folder has an operation in progress, `taken` once that folder's HEAD
 * contains it, `dropped` once the operation ended without it (aborted).
 */
async function pendingOutcome(record: ChatWorktreeRecord, pending: PendingBase, git: ProjectGit): Promise<'running' | 'taken' | 'dropped'> {
  const cwd = pending.side === 'project' ? record.projectPath : record.worktreeRoot;
  // Mid-rebase HEAD already descends from the onto commit, so only an ended operation decides.
  if (await operationInProgress(git, cwd)) return 'running';
  const result = await git.run(cwd, ['merge-base', '--is-ancestor', revision(pending.commit), 'HEAD'], { allowFailure: true });
  if (result.exitCode > 1) throw new Error(result.stderr.trim() || 'git merge-base failed');
  return result.exitCode === 0 ? 'taken' : 'dropped';
}

/** The record's bases as they stand once a finished operation's pending base is counted; reads only. */
async function currentBases(record: ChatWorktreeRecord, git: ProjectGit): Promise<{ baseCommit: string; lastAppliedTree?: string }> {
  const pending = record.pendingBase;
  if (pending !== undefined && (await pendingOutcome(record, pending, git)) === 'taken') return { baseCommit: pending.commit };
  return { baseCommit: record.baseCommit, ...(record.lastAppliedTree !== undefined ? { lastAppliedTree: record.lastAppliedTree } : {}) };
}

/**
 * Writes the outcome of a pending base whose operation ended: taken in, it becomes baseCommit and lastAppliedTree clears;
 * aborted, it is dropped and the base stays. Resolves the record as it then stands.
 */
export async function settlePendingBase(record: ChatWorktreeRecord, runner: GitRunner, registry: WorktreeRegistry): Promise<ChatWorktreeRecord> {
  const current = registry.get(record.id);
  if (current?.kind !== 'chat') return record;
  const pending = current.pendingBase;
  if (pending === undefined) return current;
  const outcome = await pendingOutcome(current, pending, gitOf(current, runner));
  if (outcome === 'running') return current;
  await registry.settlePendingBase(current.id, pending.commit, outcome === 'taken');
  const settled = registry.get(current.id);
  return settled?.kind === 'chat' ? settled : current;
}

/** The worktree's uncommitted files, repository-relative. */
export function uncommittedFiles(record: ChatWorktreeRecord, runner: GitRunner): Promise<WorktreeFile[]> {
  return statusFiles(gitOf(record, runner), record.worktreeRoot);
}

/** The worktree's files as a tree, built through a temporary index so its real index never changes (AD12). */
export async function snapshotTree(record: ChatWorktreeRecord, runner: GitRunner): Promise<string> {
  const git = gitOf(record, runner);
  return withTempFolder(async (dir) => {
    const indexFile = path.join(dir, 'index');
    await git.run(record.worktreeRoot, ['read-tree', 'HEAD'], { kind: 'mutation', indexFile });
    await git.run(record.worktreeRoot, ['add', '-A', '--', '.'], { kind: 'mutation', indexFile });
    return await git.text(record.worktreeRoot, ['write-tree'], { indexFile });
  });
}

/** Lines added and removed in the worktree's files, untracked ones included, against its base commit. */
export async function lineChangesSinceBase(record: ChatWorktreeRecord, runner: GitRunner): Promise<{ readonly added: number; readonly removed: number }> {
  const git = gitOf(record, runner);
  const [tree, { baseCommit }] = await Promise.all([snapshotTree(record, runner), currentBases(record, git)]);
  const out = await git.text(record.worktreeRoot, ['diff', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', revision(baseCommit), revision(tree), '--']);
  let added = 0;
  let removed = 0;
  for (const line of out.split('\n')) {
    // a binary file shows - for both counts
    const [plus, minus] = line.split('\t');
    added += Number(plus) || 0;
    removed += Number(minus) || 0;
  }
  return { added, removed };
}

/** The files an Apply would touch, and those of them with local changes in the project's repository (Apply's refusal). */
export async function applyPlan(record: ChatWorktreeRecord, runner: GitRunner): Promise<{ tree: string; touched: string[]; clashes: WorktreeFile[] }> {
  const git = gitOf(record, runner);
  const tree = await snapshotTree(record, runner);
  const bases = await currentBases(record, git);
  const from = bases.lastAppliedTree ?? bases.baseCommit;
  const names = nulList((await git.run(record.worktreeRoot, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', revision(from), revision(tree), '--'])).stdout);
  const touched = new Set(touchedPaths(names));
  const local = touched.size > 0 ? await statusFiles(git, record.repositoryRoot) : [];
  return { tree, touched: [...touched], clashes: local.filter((file) => touched.has(file.path)) };
}

/**
 * D33 Apply: the worktree's changes since the previous Apply (or since baseCommit) land in the project's repository
 * uncommitted, binary files and renames included. Refuses, naming them, when a touched file has local changes there.
 */
export async function apply(record: ChatWorktreeRecord, runner: GitRunner, registry: WorktreeRegistry): Promise<ApplyOutcome> {
  const settled = await settlePendingBase(record, runner, registry);
  const git = gitOf(settled, runner);
  const { tree, touched, clashes } = await applyPlan(settled, runner);
  const from = settled.lastAppliedTree ?? settled.baseCommit;
  if (touched.length === 0) return { kind: 'ok', files: [] };
  if (clashes.length > 0) return { kind: 'refused', files: clashes };
  const unmergedBefore = new Set(await unmergedPaths(git, settled.repositoryRoot));
  // git apply parses a binary patch in time quadratic in its size, so binary files the project still has at their base
  // are copied as objects, as VS Code's migrateChanges applies a stash; the rest goes through the patch.
  const copied = await binaryCopies(git, settled, from, tree);
  const textTree = copied.length === 0 ? tree : await withoutPaths(git, settled, tree, copied);
  const result = await withPatchFile(async (patch) => {
    // Fixed prefixes, so a user's diff.noprefix or diff.srcPrefix never changes the paths `git apply -p1` reads.
    await git.run(settled.worktreeRoot, ['diff', '--binary', '--full-index', '-M', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', `--output=${patch}`, revision(from), revision(textTree), '--']);
    const hasPatch = (await fs.stat(patch)).size > 0;
    // Both writes come after every check, so a refusal changes nothing in the project folder.
    if (hasPatch) {
      const check = await git.run(settled.repositoryRoot, ['apply', '--3way', '--check', '--binary', '--whitespace=nowarn', '--', patch], { allowFailure: true });
      if (check.exitCode !== 0) throw new Error(check.stderr.trim() || 'git apply --check failed');
    }
    if (copied.length > 0) {
      const changed = await changedPreimages(git, settled.repositoryRoot, copied);
      if (changed.length > 0) return { refused: changed };
      await copyObjects(git, settled.repositoryRoot, tree, copied);
    }
    if (!hasPatch) return undefined;
    const applied = await git.run(settled.repositoryRoot, ['apply', '--3way', '--binary', '--whitespace=nowarn', '--', patch], { kind: 'mutation', allowFailure: true });
    return { applied };
  });
  if (result !== undefined && 'refused' in result) return { kind: 'refused', files: result.refused };
  // Only a touched path this Apply left unmerged is its conflict; an older unmerged path is someone else's.
  const conflicts = (await unmergedPaths(git, settled.repositoryRoot)).filter((p) => touched.includes(p) && !unmergedBefore.has(p));
  if (result !== undefined && 'applied' in result && result.applied.exitCode !== 0 && conflicts.length === 0) {
    const failure = result.applied.stderr.trim() || 'git apply failed';
    throw new Error(copied.length > 0 ? t('{0} These binary files were already copied to the project folder: {1}', failure, copied.map((entry) => entry.path).join(', ')) : failure);
  }
  await registry.update(settled.id, { lastAppliedTree: tree });
  // --3way stages what it applies cleanly; those files are left as plain uncommitted changes, the conflicted ones unmerged.
  const unconflicted = touched.filter((p) => !conflicts.includes(p));
  for (const chunk of splitInChunks(unconflicted, MAX_CLI_LENGTH)) {
    await git.run(settled.repositoryRoot, ['reset', '-q', '--', ...chunk], { kind: 'mutation', literalPathspecs: true });
  }
  if (conflicts.length > 0) return { kind: 'conflicts', files: conflicts };
  return { kind: 'ok', files: touched };
}

const ZERO_OID = /^0+$/;
// Regular files only; a link or a submodule entry always goes through the patch.
const FILE_MODES: ReadonlySet<string> = new Set(['100644', '100755']);

/** A binary path of an Apply copied as an object: its base entry, undefined where the base lacked it. */
interface BinaryCopy {
  readonly path: string;
  readonly base: { readonly mode: string; readonly oid: string } | undefined;
}

/**
 * The binary files between `from` and `tree` whose project HEAD entry is still their base one, so the snapshot's version
 * can replace them as a whole. Apply's refusal already holds back any touched path with staged, unstaged or untracked
 * changes in the project folder, so the index and the file there are HEAD's. Any other binary goes through `--3way`,
 * which reports it as a conflict when the project changed it.
 */
async function binaryCopies(git: ProjectGit, record: ChatWorktreeRecord, from: string, tree: string): Promise<BinaryCopy[]> {
  const numstat = (await git.run(record.worktreeRoot, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', revision(from), revision(tree), '--'])).stdout.toString('utf8').split('\0');
  const binary = new Set(numstat.filter((row) => row.startsWith('-\t-\t')).map((row) => row.slice(4)));
  if (binary.size === 0) return [];
  // --raw -z rows: ":oldmode newmode oldoid newoid status", then the path
  const raw = (await git.run(record.worktreeRoot, ['diff', '--raw', '-z', '--no-renames', '--full-index', '--no-ext-diff', revision(from), revision(tree), '--'])).stdout.toString('utf8').split('\0');
  const candidates: Array<BinaryCopy & { readonly target: string | undefined }> = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [oldMode, newMode, oldOid] = raw[i]!.slice(1).split(' ');
    const file = raw[i + 1]!;
    if (!binary.has(file) || oldMode === undefined || newMode === undefined || oldOid === undefined) continue;
    const base = ZERO_OID.test(oldMode) ? undefined : { mode: oldMode, oid: oldOid };
    const target = ZERO_OID.test(newMode) ? undefined : newMode;
    if ((base && !FILE_MODES.has(base.mode)) || (target !== undefined && !FILE_MODES.has(target))) continue;
    candidates.push({ path: file, base, target });
  }
  const head = new Map<string, { mode: string; oid: string }>();
  for (const chunk of splitInChunks(candidates.map((entry) => entry.path), MAX_CLI_LENGTH)) {
    const listed = await git.run(record.repositoryRoot, ['ls-tree', '-z', '--full-tree', 'HEAD', '--', ...chunk], { literalPathspecs: true });
    for (const row of listed.stdout.toString('utf8').split('\0')) {
      const match = /^(\d+) blob ([0-9a-f]+)\t(.*)$/s.exec(row);
      if (match) head.set(match[3]!, { mode: match[1]!, oid: match[2]! });
    }
  }
  return candidates
    .filter((entry) => {
      const now = head.get(entry.path);
      return entry.base === undefined ? now === undefined : now?.mode === entry.base.mode && now.oid === entry.base.oid;
    })
    .map(({ path: file, base }) => ({ path: file, base }));
}

/**
 * The copied paths whose project-folder state is no longer their base, checked right before the copy as `git apply` checks
 * a preimage: an added path must have nothing there, an ignored file included, which no status lists; a modified or deleted
 * one must still hold its base blob in the index and on disk. A copy over any of them would lose the user's file.
 */
async function changedPreimages(git: ProjectGit, repositoryRoot: string, copied: readonly BinaryCopy[]): Promise<WorktreeFile[]> {
  const out: WorktreeFile[] = [];
  for (const entry of copied) {
    const absolute = path.join(repositoryRoot, entry.path);
    let exists = true;
    try {
      await fs.lstat(absolute);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      exists = false;
    }
    if (entry.base === undefined) {
      if (exists) out.push({ path: entry.path, letter: '!' });
      continue;
    }
    if (!exists) {
      out.push({ path: entry.path, letter: 'D' });
      continue;
    }
    const indexed = (await git.run(repositoryRoot, ['ls-files', '-s', '-z', '--', entry.path], { literalPathspecs: true })).stdout.toString('utf8');
    const disk = (await git.run(repositoryRoot, ['hash-object', '--', entry.path], { literalPathspecs: true })).stdout.toString('utf8').trim();
    if (!indexed.startsWith(`${entry.base.mode} ${entry.base.oid} 0\t`) || disk !== entry.base.oid) out.push({ path: entry.path, letter: 'M' });
  }
  return out;
}

/** `tree` with each copied path put back at its base entry, so the patch made from it leaves those paths out. */
async function withoutPaths(git: ProjectGit, record: ChatWorktreeRecord, tree: string, copied: readonly BinaryCopy[]): Promise<string> {
  return withTempFolder(async (dir) => {
    const indexFile = path.join(dir, 'index');
    await git.run(record.worktreeRoot, ['read-tree', revision(tree)], { kind: 'mutation', indexFile });
    // --index-info takes "mode oid\tpath" lines; mode 0 removes the path, and stdin carries any number of them
    const info = copied.map((entry) => `${entry.base ? `${entry.base.mode} ${entry.base.oid}` : `0 ${'0'.repeat(tree.length)}`}\t${entry.path}`).join('\0');
    await git.run(record.worktreeRoot, ['update-index', '-z', '--index-info'], { kind: 'mutation', indexFile, input: `${info}\0` });
    return await git.text(record.worktreeRoot, ['write-tree'], { indexFile });
  });
}

/**
 * Writes the snapshot's version of each copied path into the project folder's files, deleting the ones it lacks, and
 * leaves the index alone: the files show as unstaged changes, as Apply leaves the patched ones. The worktree shares the
 * repository's object store, so the snapshot's blobs, untracked files' included, are readable there.
 */
async function copyObjects(git: ProjectGit, repositoryRoot: string, tree: string, copied: readonly BinaryCopy[]): Promise<void> {
  const result = await git.run(repositoryRoot, ['restore', `--source=${revision(tree)}`, '--worktree', '--no-overlay', '--pathspec-from-file=-', '--pathspec-file-nul'], {
    kind: 'mutation',
    literalPathspecs: true,
    allowFailure: true,
    input: `${copied.map((entry) => entry.path).join('\0')}\0`,
  });
  if (result.exitCode === 0) return;
  const written = await writtenCopies(git, repositoryRoot, tree, copied);
  throw new Error(t('The binary files could not all be copied to the project folder ({0}). Already copied: {1}', result.stderr.trim() || `git restore exited with ${result.exitCode}`, written.length > 0 ? written.join(', ') : t('none')));
}

// The copied paths whose file in the project folder now holds the snapshot's version (or is gone where the snapshot lacks it).
async function writtenCopies(git: ProjectGit, repositoryRoot: string, tree: string, copied: readonly BinaryCopy[]): Promise<string[]> {
  const out: string[] = [];
  for (const entry of copied) {
    const wanted = await git.run(repositoryRoot, ['rev-parse', '--verify', '--quiet', `${revision(tree)}:${entry.path}`], { allowFailure: true });
    const target = wanted.exitCode === 0 ? wanted.stdout.toString('utf8').trim() : undefined;
    let exists = true;
    try {
      await fs.lstat(path.join(repositoryRoot, entry.path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      exists = false;
    }
    if (target === undefined) {
      if (!exists) out.push(entry.path);
      continue;
    }
    if (!exists) continue;
    const hashed = (await git.run(repositoryRoot, ['hash-object', '--no-filters', '--', entry.path], { literalPathspecs: true })).stdout.toString('utf8').trim();
    if (hashed === target) out.push(entry.path);
  }
  return out;
}

// `--name-status -z` rows: status, then one path, or two for a rename or copy.
function touchedPaths(fields: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i]!;
    if (status.startsWith('R') || status.startsWith('C')) {
      out.push(fields[++i]!, fields[++i]!);
    } else {
      out.push(fields[++i]!);
    }
  }
  return [...new Set(out.filter((p) => p !== undefined))];
}

/** D33: the base commit is no longer an ancestor of `<branch>` (amended, rebased or reset after the worktree started). */
export async function isRewritten(record: ChatWorktreeRecord, runner: GitRunner, branch?: string): Promise<boolean> {
  const git = gitOf(record, runner);
  const target = branch ?? (await targetBranch(record, runner));
  if (target === undefined) return false;
  const { baseCommit } = await currentBases(record, git);
  const result = await git.run(record.worktreeRoot, ['merge-base', '--is-ancestor', revision(baseCommit), `refs/heads/${revision(target)}`], { allowFailure: true });
  if (result.exitCode > 1) throw new Error(result.stderr.trim() || 'git merge-base failed');
  return result.exitCode === 1;
}

/** Commits `<branch>` has that the worktree lacks (`git rev-list --count HEAD..<branch>`). */
export async function aheadBehind(record: ChatWorktreeRecord, runner: GitRunner, branch?: string): Promise<{ behind: number }> {
  const target = branch ?? (await targetBranch(record, runner));
  if (target === undefined) return { behind: 0 };
  const count = await gitOf(record, runner).text(record.worktreeRoot, ['rev-list', '--count', `HEAD..refs/heads/${revision(target)}`]);
  return { behind: Number(count) || 0 };
}

// The commit the project folder has checked out: its branch, or HEAD's commit when detached.
async function projectTip(record: ChatWorktreeRecord, runner: GitRunner): Promise<string> {
  const target = await targetBranch(record, runner);
  return target === undefined ? gitOf(record, runner).text(record.projectPath, ['rev-parse', 'HEAD']) : `refs/heads/${revision(target)}`;
}

/** The worktree branch's commits not in `<branch>` in any form (`git cherry <branch> <worktree branch> <base commit>`). */
export async function unmergedCommits(record: ChatWorktreeRecord, runner: GitRunner): Promise<{ hash: string; subject: string }[]> {
  const git = gitOf(record, runner);
  const [upstream, { baseCommit }] = await Promise.all([projectTip(record, runner), currentBases(record, git)]);
  const out = await git.text(record.worktreeRoot, ['cherry', '-v', upstream, `refs/heads/${revision(record.branch)}`, revision(baseCommit)]);
  return out.split('\n').filter((line) => line.startsWith('+ ')).map((line) => {
    const rest = line.slice(2);
    const space = rest.indexOf(' ');
    return { hash: space < 0 ? rest : rest.slice(0, space), subject: space < 0 ? '' : rest.slice(space + 1) };
  });
}

/** The worktree branch's tip is in the commit the project folder has checked out, so deleting the branch loses no commit. */
export async function branchContained(record: ChatWorktreeRecord, runner: GitRunner): Promise<boolean> {
  const git = gitOf(record, runner);
  const result = await git.run(record.worktreeRoot, ['merge-base', '--is-ancestor', `refs/heads/${revision(record.branch)}`, await projectTip(record, runner)], { allowFailure: true });
  if (result.exitCode > 1) throw new Error(result.stderr.trim() || 'git merge-base failed');
  return result.exitCode === 0;
}

async function headOf(git: ProjectGit, cwd: string, ref: string): Promise<string> {
  return git.text(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

// A non-zero exit that left an operation in progress is a conflict; any other is git's refusal, which changed nothing here.
async function finishOperation(
  record: ChatWorktreeRecord,
  registry: WorktreeRegistry,
  git: ProjectGit,
  result: { exitCode: number; stderr: string; stdout: Buffer },
  base: PendingBase,
): Promise<{ kind: 'ok' } | { kind: 'conflicts'; files: string[] } | { kind: 'refused'; message: string }> {
  if (result.exitCode === 0) {
    await registry.update(record.id, { baseCommit: base.commit, lastAppliedTree: undefined, pendingBase: undefined });
    return { kind: 'ok' };
  }
  const cwd = base.side === 'project' ? record.projectPath : record.worktreeRoot;
  if (!(await operationInProgress(git, cwd))) return gitRefusal(result);
  // The base moves only once git finished the operation with it (settlePendingBase); an abort keeps the old one.
  await registry.update(record.id, { pendingBase: base });
  return { kind: 'conflicts', files: await unmergedPaths(git, cwd) };
}

/**
 * D33 Merge into `<branch>`: uncommitted worktree files are committed first with `message`, then the worktree branch is
 * merged into the branch checked out in the project folder. baseCommit moves to the merged commit once git finished the merge.
 */
export async function mergeInto(record: ChatWorktreeRecord, runner: GitRunner, registry: WorktreeRegistry, options: { message?: string } = {}): Promise<MergeOutcome> {
  const settled = await settlePendingBase(record, runner, registry);
  const git = gitOf(settled, runner);
  const target = await targetBranch(settled, runner);
  if (target === undefined) return { kind: 'detached' };
  for (const folder of [settled.projectPath, settled.worktreeRoot]) {
    if (await operationInProgress(git, folder)) return operationRefusal(folder);
  }
  const dirty = await statusFiles(git, settled.worktreeRoot);
  if (dirty.length > 0) {
    if (options.message === undefined || options.message.trim() === '') return { kind: 'needsMessage', files: dirty };
    await git.run(settled.worktreeRoot, ['add', '-A', '--', '.'], { kind: 'mutation' });
    await git.run(settled.worktreeRoot, ['commit', '-q', '-F', '-'], { kind: 'mutation', input: options.message });
  }
  if (await isRewritten(settled, runner, target)) return { kind: 'rewritten', branch: target };
  const merged = await headOf(git, settled.worktreeRoot, 'HEAD');
  const result = await git.run(settled.projectPath, ['merge', '--no-edit', revision(merged)], { kind: 'mutation', allowFailure: true });
  return finishOperation(settled, registry, git, result, { commit: merged, side: 'project' });
}

/** D33 Update from `<branch>`: `git merge <branch>` in the worktree; the chat's commits never change. */
export async function updateFrom(record: ChatWorktreeRecord, runner: GitRunner, registry: WorktreeRegistry): Promise<UpdateOutcome> {
  const settled = await settlePendingBase(record, runner, registry);
  const git = gitOf(settled, runner);
  const target = await targetBranch(settled, runner);
  if (target === undefined) return { kind: 'detached' };
  if (await operationInProgress(git, settled.worktreeRoot)) return operationRefusal(settled.worktreeRoot);
  if (await isRewritten(settled, runner, target)) return { kind: 'rewritten', branch: target };
  const taken = await headOf(git, settled.worktreeRoot, `refs/heads/${revision(target)}`);
  const result = await git.run(settled.worktreeRoot, ['merge', '--no-edit', revision(taken)], { kind: 'mutation', allowFailure: true });
  return finishOperation(settled, registry, git, result, { commit: taken, side: 'worktree' });
}

/** D33 Rebase onto `<branch>`: `git rebase --onto <branch> <base commit>` in the worktree. */
export async function rebaseOnto(record: ChatWorktreeRecord, runner: GitRunner, registry: WorktreeRegistry): Promise<UpdateOutcome> {
  const settled = await settlePendingBase(record, runner, registry);
  const git = gitOf(settled, runner);
  const target = await targetBranch(settled, runner);
  if (target === undefined) return { kind: 'detached' };
  if (await operationInProgress(git, settled.worktreeRoot)) return operationRefusal(settled.worktreeRoot);
  const onto = await headOf(git, settled.worktreeRoot, `refs/heads/${revision(target)}`);
  const result = await git.run(settled.worktreeRoot, ['rebase', '--onto', revision(onto), revision(settled.baseCommit)], { kind: 'mutation', allowFailure: true });
  return finishOperation(settled, registry, git, result, { commit: onto, side: 'worktree' });
}

export class WorktreeRemoveError extends Error {
  readonly worktreePath: string;
  constructor(worktreePath: string, detail: string) {
    super(`Could not remove the worktree ${worktreePath}: ${detail}`);
    this.name = 'WorktreeRemoveError';
    this.worktreePath = worktreePath;
  }
}

/**
 * D33 Delete, after the host closed everything that runs there (rule 14): `git worktree remove`, then the worktree's Compass
 * index and checkpoint data, then the branch when asked. A failure keeps the record live and names the path.
 */
export async function removeWorktree(
  record: ChatWorktreeRecord,
  runner: GitRunner,
  registry: WorktreeRegistry,
  options: { deleteBranch: boolean; force: boolean },
): Promise<void> {
  const live = registry.get(record.id);
  if (live?.kind !== 'chat' || live.deletedAt !== undefined) throw new Error(`Worktree ${record.id} is not a live chat worktree`);
  const git = gitOf(live, runner);
  const state = await worktreeFolderState(live.worktreeRoot);
  if (state === 'worktree') {
    const result = await git.run(live.projectPath, ['worktree', 'remove', ...(options.force ? ['--force'] : []), ...git.eoo(), live.worktreeRoot], { kind: 'mutation', allowFailure: true });
    if (result.exitCode !== 0) throw new WorktreeRemoveError(live.worktreeRoot, result.stderr.trim() || `git worktree remove exited with ${result.exitCode}`);
  } else {
    // git refuses to remove a folder without its .git link, so the rest of a remove it could not finish goes here.
    if (state === 'leftover') {
      await fs.rm(live.worktreeRoot, { recursive: true }).catch((err: unknown) => {
        throw new WorktreeRemoveError(live.worktreeRoot, err instanceof Error ? err.message : String(err));
      });
    }
    // Removed outside Damocles, or just above: only git's record of it is left.
    await git.run(live.projectPath, ['worktree', 'prune'], { kind: 'mutation' });
  }
  await registry.markDeleted(live.id);
  // The worktree is gone by now, so an empty folder left in place is only logged.
  await registry.removeEmptyProjectFolder(live.projectPath).catch((err: unknown) => log(`[worktrees] Could not remove the empty folder of ${live.worktreeRoot}: ${gitMessage(err)}`));
  await fs.rm(path.dirname(compassIndexPath(live.workingFolder)), { recursive: true, force: true });
  await fs.rm(getFolderRepoDir(folderIdFor(live.workingFolder)), { recursive: true, force: true });
  if (options.deleteBranch) {
    await git.run(live.projectPath, ['branch', '-D', ...git.eoo(), revision(live.branch)], { kind: 'mutation' }).catch((err: unknown) => {
      throw new Error(`The worktree was removed, but its branch ${live.branch} was not deleted: ${gitMessage(err)}`);
    });
  }
}

/**
 * A chat worktree's folder as git sees it: a worktree, gone, or a leftover, a folder whose .git link is gone. A
 * `git worktree remove` that deletes the contents but cannot delete the folder itself (on Windows, a process outside
 * Damocles holding it open) leaves one, and git no longer knows it as a worktree.
 */
export async function worktreeFolderState(folder: string): Promise<'worktree' | 'leftover' | 'gone'> {
  if (!(await folderExists(folder))) return 'gone';
  return (await folderExists(path.join(folder, '.git'))) ? 'worktree' : 'leftover';
}

async function folderExists(folder: string): Promise<boolean> {
  try {
    await fs.access(folder);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
