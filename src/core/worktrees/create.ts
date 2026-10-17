// Creating a chat's worktree (D30, D32, D63, AD12): the registry record first, then `git worktree add`, then the opted-in
// uncommitted changes and the `.worktreeinclude` copies. Setup commands are read here; the host runs them.
import * as crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ignore from 'ignore';
import type { Memento } from '../../platform/key-value-state';
import { endOfOptions, GitError, revision, type GitResult, type GitRunner } from '../scm/git-runner';
import { addWorktreeArgs } from '../scm/worktrees';
import type { ChangeLetter } from '../scm/repository';
import { updateSerially } from '../scm/serial-update';
import { folderKey } from '../workspace-folders/folder-key';
import { log } from '../logger';
import { pidAlive } from '../pi-session/checkpoints/lock';
import { t } from '../l10n';
import { branchBaseName, branchSlug, freeBranchName } from './slug';
import { folderContains, newWorktreeId, worktreeFolderFor, type ChatWorktreeRecord, type WorktreeRegistry } from './registry';

export const WORKTREE_INCLUDE_FILE = '.worktreeinclude';
export const WORKTREE_SETUP_FILE: string = path.join('.damocles', 'worktree.json');
export const SETUP_APPROVALS_KEY = 'damocles.worktrees.setupApprovals';
const MAX_SETUP_FILE_BYTES = 64 * 1024;
const MAX_SETUP_COMMANDS = 20;
const MAX_SETUP_COMMAND_LENGTH = 4096;
// Windows runs setup as one -EncodedCommand (base64 UTF-16LE, about 2.7 characters per script character) within its 32,767
// character command line: 6,000 characters plus setup-terminal.ts's ~280 of framing per command for 20 commands stay under it.
const MAX_SETUP_TOTAL_LENGTH = 6000;
const MAX_INCLUDE_FILE_BYTES = 64 * 1024;

export class WorktreeCreateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorktreeCreateError';
  }
}

/** git's own message for a failed call, else the error's. */
export function gitMessage(err: unknown): string {
  if (err instanceof GitError) return (err.stderr.trim() || err.message).slice(0, 2000);
  return err instanceof Error ? err.message : String(err);
}

/** Runs git for one project: `project` decides trust, `cwd` where it runs. */
export interface ProjectGit {
  readonly runner: GitRunner;
  readonly project: string;
  run(cwd: string, args: readonly string[], options?: GitRunOptions): Promise<GitResult>;
  text(cwd: string, args: readonly string[], options?: GitRunOptions): Promise<string>;
  eoo(): string[];
}

export interface GitRunOptions {
  kind?: 'read' | 'status' | 'mutation';
  input?: string | Buffer;
  allowFailure?: boolean;
  indexFile?: string;
  literalPathspecs?: true;
  maxOutputBytes?: number;
  preview?: true;
}

export function projectGit(runner: GitRunner, project: string): ProjectGit {
  const run: ProjectGit['run'] = (cwd, args, options = {}) => runner.run({
    project,
    cwd,
    args,
    kind: options.kind ?? 'read',
    parsed: true,
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.allowFailure ? { allowFailure: true } : {}),
    ...(options.indexFile !== undefined ? { indexFile: options.indexFile } : {}),
    ...(options.literalPathspecs ? { literalPathspecs: true } : {}),
    ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options.preview ? { preview: true } : {}),
  });
  return {
    runner,
    project,
    run,
    text: async (cwd, args, options) => (await run(cwd, args, options)).stdout.toString('utf8').trim(),
    eoo: () => endOfOptions(runner.git.version),
  };
}

/** NUL-separated git output as a list, the empty tail dropped. */
export function nulList(out: Buffer): string[] {
  return out.toString('utf8').split('\0').filter((s) => s.length > 0);
}

/**
 * The repository holding `folder`: its root spelled as `folder` is (an 8.3 alias, a link, a mapped drive), so it compares with
 * paths under `folder`, since git's own toplevel is its realpath (VS Code's getRepositoryRoot resolves a relative one too); and
 * `folder`'s path in it as git names it, '/'-separated with a trailing '/', or ''. Throws when the folder is reached through a
 * link inside the repository, where no parent of it spells the root.
 */
export async function repositoryOf(git: ProjectGit, folder: string): Promise<{ readonly root: string; readonly prefix: string }> {
  // --show-cdup and --show-prefix print an empty line at the top, so the lines are read before any trim
  const [cdup = '', prefix = '', toplevel = ''] = (await git.run(folder, ['rev-parse', '--show-cdup', '--show-prefix', '--show-toplevel'])).stdout.toString('utf8').split(/\r?\n/);
  const root = path.resolve(folder, cdup);
  const [rootReal, toplevelReal] = await Promise.all([fs.realpath(root), fs.realpath(toplevel)]);
  if (folderKey(rootReal) !== folderKey(toplevelReal)) {
    throw new Error(t('{0} leads into the repository {1} through a link, below its root, so git cannot work on it there. Add the project by its own path, {2}.', folder, toplevelReal, await fs.realpath(folder)));
  }
  return { root, prefix };
}

// withTempFolder's mkdtemp name: the creator's pid, then mkdtemp's six characters
const TEMP_FOLDER = /^damocles-git-(\d+)-[A-Za-z0-9]{6}$/;
// Far past any Apply or creation, so a folder this old whose creator is gone is read by nothing.
const ABANDONED_TEMP_FOLDER_MS = 60 * 60 * 1000;
const tempWork = new Set<Promise<unknown>>();

/**
 * A folder under the OS temp folder for the files a worktree's git work hands git (a patch, a temporary index, a pattern
 * list), removed when `use` settles; a quit waits for it (tempFoldersSettled) and the next start sweeps one a crash left.
 */
export async function withTempFolder<T>(use: (dir: string) => Promise<T>): Promise<T> {
  const work = useTempFolder(use);
  tempWork.add(work);
  try {
    return await work;
  } finally {
    tempWork.delete(work);
  }
}

/**
 * A file for a patch git writes with `diff --output` and reads with `apply`, so a patch of any size never passes through the
 * runner's bounded stdout (VS Code's `Repository.apply` also takes a patch file).
 */
export function withPatchFile<T>(use: (file: string) => Promise<T>): Promise<T> {
  return withTempFolder((dir) => use(path.join(dir, 'changes.patch')));
}

/** Settles once every temp folder in use has been removed, or its removal failed and was logged; a quit awaits it. */
export async function tempFoldersSettled(): Promise<void> {
  while (tempWork.size > 0) await Promise.allSettled([...tempWork]);
}

/**
 * Removes the temp folders a process that is gone left in `tempDir` (a quit past its bound, a crash). Each is named by its
 * creator's pid, as `writeJsonConfig` names its temp file; a folder of a live process or younger than an hour stays.
 */
export async function removeAbandonedTempFolders(tempDir: string, now: number): Promise<void> {
  for (const entry of await fs.readdir(tempDir, { withFileTypes: true })) {
    const pid = TEMP_FOLDER.exec(entry.name)?.[1];
    if (pid === undefined || !entry.isDirectory() || Number(pid) === process.pid || pidAlive(Number(pid))) continue;
    const dir = path.join(tempDir, entry.name);
    try {
      if (now - (await fs.stat(dir)).mtimeMs < ABANDONED_TEMP_FOLDER_MS) continue;
      await fs.rm(dir, { recursive: true, force: true });
      log('[worktrees] removed the abandoned temp folder %s', dir);
    } catch (err) {
      log('[worktrees] could not remove the abandoned temp folder %s: %O', dir, err);
    }
  }
}

async function useTempFolder<T>(use: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `damocles-git-${process.pid}-`));
  try {
    return await use(dir);
  } finally {
    // A scanner holding a file must not turn the git work's outcome into a failure, so a failed removal is only logged.
    await fs.rm(dir, { recursive: true, force: true }).catch((err: unknown) => log('[worktrees] could not remove the temp folder %s: %O', dir, err));
  }
}

export interface BranchOption {
  /** The full refname, which `startRef` takes; `HEAD` for a detached HEAD's commit, the one option then marked current. */
  ref: string;
  name: string;
  current: boolean;
  remote: boolean;
  /** Commits a remote branch has that its local branch lacks ("2 newer"). */
  newer?: number;
}

export type WorktreeOptions =
  | { available: false; reason: 'notGit' | 'noCommits' }
  | { available: true; currentBranch: string | null; branches: BranchOption[]; uncommittedCount: number };

/** D30's availability and D63's Start from choices for a trusted project. */
export async function worktreeOptions(runner: GitRunner, projectPath: string): Promise<WorktreeOptions> {
  const git = projectGit(runner, projectPath);
  const top = await git.run(projectPath, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (top.exitCode !== 0) return { available: false, reason: 'notGit' };
  const head = await git.run(projectPath, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true });
  if (head.exitCode !== 0) return { available: false, reason: 'noCommits' };
  const currentRef = await currentBranchRef(git, projectPath);
  // A refname holds no tab or newline (check-ref-format), so the fields split safely.
  const lines = (await git.text(projectPath, ['for-each-ref', '--format=%(refname)%09%(refname:short)%09%(symref)%09%(objectname)', '--sort=-committerdate', 'refs/heads', 'refs/remotes'])).split('\n');
  const branches: BranchOption[] = [];
  const tips = new Map<string, string>();
  // D61: on a detached HEAD, HEAD's own commit is the current start.
  if (currentRef === undefined) branches.push({ ref: 'HEAD', name: await git.text(projectPath, ['rev-parse', '--short', 'HEAD']), current: true, remote: false });
  for (const line of lines) {
    const [ref, name, symref, tip] = line.split('\t');
    // A remote's HEAD is a symbolic ref to one of its branches, which is listed on its own.
    if (!ref || !name || symref) continue;
    branches.push({ ref, name, current: ref === currentRef, remote: ref.startsWith('refs/remotes/') });
    if (tip) tips.set(ref, tip);
  }
  const locals = new Set(branches.filter((b) => !b.remote && b.ref !== 'HEAD').map((b) => b.name));
  for (const branch of branches) {
    if (!branch.remote) continue;
    const local = branch.name.slice(branch.name.indexOf('/') + 1);
    // A remote branch at its local branch's commit, the common case after a fetch, has nothing newer and costs no spawn.
    if (!locals.has(local) || tips.get(branch.ref) === tips.get(`refs/heads/${local}`)) continue;
    const count = await git.run(projectPath, ['rev-list', '--count', `refs/heads/${local}..${branch.ref}`], { allowFailure: true });
    const newer = Number(count.stdout.toString('utf8').trim());
    if (count.exitCode === 0 && newer > 0) branch.newer = newer;
  }
  return {
    available: true,
    currentBranch: currentRef ? currentRef.slice('refs/heads/'.length) : null,
    branches,
    uncommittedCount: (await uncommittedPaths(git, top.stdout.toString('utf8').trim())).length,
  };
}

/** The full refname HEAD points at, or undefined when detached. */
export async function currentBranchRef(git: ProjectGit, cwd: string): Promise<string | undefined> {
  const result = await git.run(cwd, ['symbolic-ref', '--quiet', 'HEAD'], { allowFailure: true });
  const ref = result.stdout.toString('utf8').trim();
  return result.exitCode === 0 && ref.startsWith('refs/heads/') ? ref : undefined;
}

/** Changed tracked files and untracked files that are not ignored, repository-relative with '/'. */
export async function uncommittedPaths(git: ProjectGit, repositoryRoot: string): Promise<string[]> {
  return (await uncommittedFiles(git, repositoryRoot)).map((file) => file.path);
}

/** A file a worktree dialog lists, with the letter source control decorates it with. */
export interface WorktreeFile {
  readonly path: string;
  readonly letter: ChangeLetter;
}

/**
 * git's comparison of the repository's paths: case-folded where its core.ignorecase is on (git init and clone set it on a
 * case-insensitive file system), so a path spelled in another case finds the name git lists. A pathspec takes git's name.
 */
export async function repositoryPathKey(git: ProjectGit, cwd: string): Promise<(relative: string) => string> {
  const ignoreCase = await git.text(cwd, ['config', '--bool', 'core.ignorecase'], { allowFailure: true });
  return ignoreCase === 'true' ? (relative) => relative.toLowerCase() : (relative) => relative;
}

/** As uncommittedPaths, each with its source control letter; paths are relative to `cwd`'s repository top. */
export async function uncommittedFiles(git: ProjectGit, cwd: string): Promise<WorktreeFile[]> {
  const out = (await git.run(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { kind: 'status' })).stdout;
  return nulList(out).map((entry) => ({ path: entry.slice(3), letter: porcelainLetter(entry.slice(0, 2)) }));
}

const CONFLICT_PAIRS: ReadonlySet<string> = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** VS Code's decoration letter for a porcelain v1 XY pair: the working tree's change first, else the index's. */
export function porcelainLetter(xy: string): ChangeLetter {
  if (xy === '??') return 'U';
  if (xy === '!!') return 'I';
  if (CONFLICT_PAIRS.has(xy)) return '!';
  const worktree = xy.charAt(1);
  if (worktree === 'M' || worktree === 'D' || worktree === 'A' || worktree === 'T') return worktree;
  const index = xy.charAt(0);
  if (index === 'M' || index === 'A' || index === 'D' || index === 'R' || index === 'C' || index === 'T') return index;
  throw new Error(`git status printed an unknown pair ${JSON.stringify(xy)}`);
}

export interface CreateChatWorktreeInput {
  readonly git: GitRunner;
  readonly registry: WorktreeRegistry;
  readonly projectPath: string;
  /** A full refname from worktreeOptions. */
  readonly startRef: string;
  readonly bringChanges: boolean;
  /** The first prompt, for the branch slug. */
  readonly slugSource: string;
  readonly branchPrefix: string;
}

export interface CreatedWorktree {
  readonly record: ChatWorktreeRecord;
  /** Links the OS refused to create (Windows without Developer Mode), relative to the folder they belong in. */
  readonly skippedLinks: readonly string[];
}

/** Creates and registers the worktree; on failure nothing stays behind and the error carries git's message. */
export async function createChatWorktree(input: CreateChatWorktreeInput): Promise<CreatedWorktree> {
  const { registry, projectPath } = input;
  const git = projectGit(input.git, projectPath);
  let id = newWorktreeId();
  while (registry.get(id)) id = newWorktreeId();
  let repositoryRoot: string;
  let prefix: string;
  let startCommit: string;
  let currentRef: string | undefined;
  let branch: string;
  try {
    ({ root: repositoryRoot, prefix } = await repositoryOf(git, projectPath));
    startCommit = await git.text(projectPath, ['rev-parse', '--verify', '--quiet', ...git.eoo(), `${revision(input.startRef)}^{commit}`]);
    currentRef = await currentBranchRef(git, projectPath);
    branch = await freeBranchName(input.git, projectPath, projectPath, branchBaseName(input.branchPrefix, branchSlug(input.slugSource, id)));
  } catch (err) {
    throw new WorktreeCreateError(gitMessage(err), { cause: err });
  }
  const worktreeRoot = worktreeFolderFor(registry.rootDir, projectPath, id);
  // git's names, never the project's spelling: an 8.3 alias of the project's folder need not exist in the worktree
  const workingFolder = prefix === '' ? worktreeRoot : path.join(worktreeRoot, ...prefix.split('/').filter(Boolean));
  // Written before `git worktree add`, so another process's leftover scan never reports a worktree being created (rule 15).
  const record = await registry.addChat({ id, kind: 'chat', projectPath, repositoryRoot, worktreeRoot, workingFolder, branch, baseCommit: startCommit, createdAt: Date.now() });
  try {
    await fs.mkdir(path.dirname(worktreeRoot), { recursive: true });
    await git.run(projectPath, addWorktreeArgs(worktreeRoot, startCommit, branch, git.eoo()), { kind: 'mutation' });
  } catch (err) {
    await undoFailedAdd(git, registry, record, startCommit);
    throw new WorktreeCreateError(gitMessage(err), { cause: err });
  }
  const skippedLinks: string[] = [];
  try {
    if (input.bringChanges && (currentRef ?? 'HEAD') === input.startRef) skippedLinks.push(...await copyUncommitted(git, repositoryRoot, worktreeRoot));
    skippedLinks.push(...(await copyWorktreeInclude(input.git, projectPath, workingFolder)).skippedLinks);
  } catch (err) {
    await discardChatWorktree(input.git, registry, record).catch((discardErr: unknown) => log(`[worktrees] Discarding ${worktreeRoot} after a failed copy failed: ${gitMessage(discardErr)}`));
    throw new WorktreeCreateError(gitMessage(err), { cause: err });
  }
  return { record, skippedLinks };
}

// `worktree add -b` creates the branch before it checks the folder, so a refused add can leave the branch and the project's
// worktrees folder behind. Each step is logged on failure, so git's error stays the one the caller sees.
async function undoFailedAdd(git: ProjectGit, registry: WorktreeRegistry, record: ChatWorktreeRecord, startCommit: string): Promise<void> {
  const ref = `refs/heads/${revision(record.branch)}`;
  const undo: Array<[string, () => Promise<unknown>]> = [
    ['delete the branch', async () => {
      const tip = await git.run(record.projectPath, ['rev-parse', '--verify', '--quiet', ref], { allowFailure: true });
      if (tip.exitCode !== 0 || tip.stdout.toString('utf8').trim() !== startCommit) return;
      // With the old value, update-ref deletes only a branch that still points at the start commit.
      await git.run(record.projectPath, ['update-ref', '-d', ref, revision(startCommit)], { kind: 'mutation' });
    }],
    ['remove the empty folder', () => fs.rmdir(path.dirname(record.worktreeRoot)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOTEMPTY' && err.code !== 'EEXIST' && err.code !== 'ENOENT') throw err;
    })],
    ['remove the record', () => registry.remove(record.id)],
  ];
  for (const [what, step] of undo) {
    await step().catch((err: unknown) => log(`[worktrees] After a failed worktree add, could not ${what} of ${record.worktreeRoot}: ${gitMessage(err)}`));
  }
}

/**
 * A worktree no session has used yet leaves no folder, branch or record behind (a failed creation, a chat gone meanwhile).
 * Only `git worktree remove` deletes its folder: when git refuses (a process holds a file), the error is thrown and the
 * folder, branch and record stay, so the leftover scan still finds them.
 */
export async function discardChatWorktree(runner: GitRunner, registry: WorktreeRegistry, record: ChatWorktreeRecord): Promise<void> {
  const git = projectGit(runner, record.projectPath);
  const removed = await git.run(record.projectPath, ['worktree', 'remove', '--force', ...git.eoo(), record.worktreeRoot], { kind: 'mutation', allowFailure: true });
  if (removed.exitCode !== 0) throw new Error(`Could not remove the worktree ${record.worktreeRoot}: ${removed.stderr.trim() || `git worktree remove exited with ${removed.exitCode}`}`);
  await registry.remove(record.id);
  await registry.removeEmptyProjectFolder(record.projectPath).catch((err: unknown) => log(`[worktrees] Could not remove the empty folder of ${record.worktreeRoot}: ${gitMessage(err)}`));
  await git.run(record.projectPath, ['branch', '-D', ...git.eoo(), revision(record.branch)], { kind: 'mutation' }).catch((err: unknown) => {
    throw new Error(`The worktree ${record.worktreeRoot} was removed, but its branch ${record.branch} was not deleted: ${gitMessage(err)}`);
  });
}

/** D63: tracked changes through `git diff HEAD --binary` applied in the worktree, and untracked files that are not ignored. */
async function copyUncommitted(git: ProjectGit, repositoryRoot: string, worktreeRoot: string): Promise<string[]> {
  // Fixed prefixes, so a user's diff.noprefix or diff.srcPrefix never changes the paths `git apply -p1` reads.
  await withPatchFile(async (patch) => {
    await git.run(repositoryRoot, ['-c', 'diff.autoRefreshIndex=false', 'diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', `--output=${patch}`, '--']);
    if ((await fs.stat(patch)).size > 0) await git.run(worktreeRoot, ['apply', '--binary', '--whitespace=nowarn', '--', patch], { kind: 'mutation' });
  });
  const untracked = nulList((await git.run(repositoryRoot, ['ls-files', '-z', '--others', '--exclude-standard', '--full-name'])).stdout);
  const skipped: string[] = [];
  for (const rel of untracked) {
    if ((await copyEntry(repositoryRoot, worktreeRoot, rel)) === 'linkSkipped') skipped.push(rel);
  }
  return skipped;
}

/**
 * D32: files matching a `.worktreeinclude` pattern (gitignore syntax, relative to the project folder) that git ignores are
 * copied to the same place under the working folder. Tracked files never match; a symlink is copied as a link.
 */
export async function copyWorktreeInclude(runner: GitRunner, projectPath: string, workingFolder: string): Promise<{ copied: string[]; skippedLinks: string[] }> {
  const none = { copied: [], skippedLinks: [] };
  const file = path.join(projectPath, WORKTREE_INCLUDE_FILE);
  let text: string;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_INCLUDE_FILE_BYTES) {
      log(`[worktrees] ${file} is not a regular file under ${MAX_INCLUDE_FILE_BYTES} bytes, so nothing was copied`);
      return none;
    }
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return none;
    throw err;
  }
  const matcher = ignore().add(text);
  const git = projectGit(runner, projectPath);
  const sub = (await repositoryOf(git, projectPath)).prefix.replace(/\/$/, '');
  // The candidates are the untracked files the include patterns match, so git never lists a whole ignored tree it need not.
  let candidates = await withTempFolder(async (dir) => {
    const patternsFile = path.join(dir, 'worktreeinclude');
    await fs.writeFile(patternsFile, anchoredAtTop(text, sub), 'utf8');
    return nulList((await git.run(projectPath, ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${patternsFile}`])).stdout);
  });
  candidates = candidates.filter((rel) => isPlainRelative(rel) && matcher.ignores(rel));
  if (candidates.length === 0) return none;
  // Of those, only the files git ignores are copied; tracked files are never candidates. check-ignore reads plain paths.
  const checked = await git.run(projectPath, ['check-ignore', '-z', '--stdin'], { input: `${candidates.join('\0')}\0`, allowFailure: true });
  if (checked.exitCode > 1) throw new Error(checked.stderr.trim() || `git check-ignore exited with ${checked.exitCode}`);
  const copied: string[] = [];
  const skippedLinks: string[] = [];
  for (const rel of nulList(checked.stdout)) {
    if ((await copyEntry(projectPath, workingFolder, rel)) === 'linkSkipped') skippedLinks.push(rel);
    else copied.push(rel);
  }
  return { copied, skippedLinks };
}

// `.worktreeinclude` patterns are relative to the project folder, git's --exclude-from patterns to the repository top.
function anchoredAtTop(text: string, sub: string): string {
  if (sub === '') return text;
  return text.split(/\r?\n/).map((line) => {
    if (line.trim() === '' || line.startsWith('#')) return line;
    const negated = line.startsWith('!');
    const body = negated ? line.slice(1) : line;
    // A pattern with a slash before its end is anchored to its file's folder; one without matches at any depth.
    if (!body.replace(/\/+\s*$/, '').includes('/')) return line;
    return `${negated ? '!' : ''}/${sub}/${body.replace(/^\//, '')}`;
  }).join('\n');
}

function isPlainRelative(rel: string): boolean {
  return rel.length > 0 && !path.isAbsolute(rel) && !rel.split(/[\\/]/).some((part) => part === '..' || part === '');
}

/**
 * Creates the parent folders of `root/rel` one level at a time, refusing a level that is a link, so no folder is made and no
 * file written outside `root`. Resolves the target path.
 */
export async function confinedTarget(root: string, rel: string): Promise<string> {
  const parts = rel.split(/[\\/]/);
  if (!isPlainRelative(rel)) throw new Error(`Refused the path ${rel}`);
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    const stat = await fs.lstat(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    });
    if (stat === undefined) await fs.mkdir(dir);
    else if (!stat.isDirectory()) throw new Error(`${rel} passes through ${dir}, which is not a folder`);
  }
  return path.join(root, ...parts);
}

// Copies one file or link from `fromRoot/rel` to `toRoot/rel`; neither side may resolve outside its root.
async function copyEntry(fromRoot: string, toRoot: string, rel: string): Promise<'copied' | 'linkSkipped'> {
  if (!isPlainRelative(rel)) throw new Error(`Refused to copy ${rel}`);
  const source = path.join(fromRoot, rel);
  const realFromRoot = await fs.realpath(fromRoot);
  if (!folderContains(realFromRoot, await fs.realpath(path.dirname(source)))) throw new Error(`${rel} lies outside ${fromRoot}`);
  const target = await confinedTarget(toRoot, rel);
  const stat = await fs.lstat(source);
  await fs.rm(target, { force: true });
  if (stat.isSymbolicLink()) return (await copyLink(source, target)) ? 'copied' : 'linkSkipped';
  if (stat.isFile()) {
    await fs.copyFile(source, target);
    await fs.chmod(target, stat.mode & 0o777);
  }
  return 'copied';
}

/**
 * Recreates the link `source` at `target` without following it; false when the OS refused it (a file link on Windows without
 * Developer Mode), and nothing was created.
 */
export async function copyLink(source: string, target: string): Promise<boolean> {
  const link = await fs.readlink(source);
  const linkType = process.platform === 'win32' ? await symlinkType(source) : undefined;
  try {
    // A junction holds an absolute target; a relative link keeps pointing beside its copy.
    await fs.symlink(linkType === 'junction' && !path.isAbsolute(link) ? path.resolve(path.dirname(target), link) : link, target, linkType);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') return false;
    throw err;
  }
  return true;
}

// A link to a folder is recreated as a junction, which Windows lets any user make.
async function symlinkType(source: string): Promise<'junction' | 'file'> {
  try {
    return (await fs.stat(source)).isDirectory() ? 'junction' : 'file';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'file';
    throw err;
  }
}

/** D32's commands from the project folder's `.damocles/worktree.json`; the OS array replaces `setup` on its OS. */
export async function readSetupCommands(projectPath: string, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const file = path.join(projectPath, WORKTREE_SETUP_FILE);
  let text: string;
  try {
    // lstat: a link or a FIFO in the repository is never followed or read.
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
    if (stat.size > MAX_SETUP_FILE_BYTES) throw new Error(`${file} is larger than ${MAX_SETUP_FILE_BYTES} bytes`);
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${file} must hold an object`);
  const config = parsed as Record<string, unknown>;
  const osKey = platform === 'win32' ? 'setupWindows' : 'setupUnix';
  const key = config[osKey] !== undefined ? osKey : 'setup';
  const list = config[key];
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > MAX_SETUP_COMMANDS || !list.every((c) => typeof c === 'string' && c.trim() !== '' && c.length <= MAX_SETUP_COMMAND_LENGTH)) {
    throw new Error(`${file}: "${key}" must be an array of at most ${MAX_SETUP_COMMANDS} non-empty commands`);
  }
  const commands = list as string[];
  // A line break would make one entry several shell lines, and only the last line's exit status would be checked.
  if (commands.some((c) => /[\r\n]/.test(c))) throw new Error(t('{0}: each setup command must be one line. Put each command in its own entry of "{1}".', file, key));
  const total = commands.reduce((sum, c) => sum + c.length, 0);
  if (total > MAX_SETUP_TOTAL_LENGTH) throw new Error(t('{0}: the commands in "{1}" are {2} characters long together, and setup runs at most {3}.', file, key, total, MAX_SETUP_TOTAL_LENGTH));
  return commands;
}

export function setupCommandsHash(commands: readonly string[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(commands)).digest('hex');
}

function approvals(state: Memento): Record<string, unknown> {
  const value = state.get<unknown>(SETUP_APPROVALS_KEY);
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** D32: the project's approved commands are exactly these. */
export function isSetupApproved(state: Memento, projectPath: string, commands: readonly string[]): boolean {
  return approvals(state)[folderKey(projectPath)] === setupCommandsHash(commands);
}

export function approveSetup(state: Memento, projectPath: string, commands: readonly string[]): Promise<void> {
  const key = folderKey(projectPath);
  const hash = setupCommandsHash(commands);
  return updateSerially(state, SETUP_APPROVALS_KEY, (current) => ({ ...approvals({ get: () => current } as unknown as Memento), [key]: hash }));
}
