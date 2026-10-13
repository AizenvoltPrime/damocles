// Which repositories a project holds (plan AD4 and slice 10's discovery step; VS Code's model.ts scanWorkspaceFolders,
// traverseWorkspaceFolder and openRepository). Nothing here follows a link: a repository author controls the tree.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isRelativeFilePath } from '../../shared/relative-path';
import type { GitRunner } from './git-runner';
import { parseGitmodules, parseUnsafeRepository } from './parsers';

// VS Code's git.repositoryScanIgnoredFolders default.
export const SCAN_IGNORED_FOLDERS: readonly string[] = ['node_modules'];
// VS Code's git.detectSubmodulesLimit default: submodules opened per repository.
export const SUBMODULES_LIMIT = 10;
const MAX_GITMODULES_BYTES = 1024 * 1024;

/**
 * Whether child is parent or lies inside it; both absolute paths, compared as path.relative does: case-insensitive on Windows,
 * case-sensitive elsewhere (macOS's case-insensitive volumes included). A child folder may be named '..x'.
 */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export interface SubmoduleFolder {
  readonly name: string;
  // repo-relative, '/' separated
  readonly relativePath: string;
  readonly absolutePath: string;
}

/**
 * The submodule folders .gitmodules names that are real folders of root: each path is repository-controlled text, so it must
 * be a plain relative path whose folder is no link and whose realpath stays inside root.
 */
export async function readSubmodules(root: string): Promise<SubmoduleFolder[]> {
  const file = path.join(root, '.gitmodules');
  let text: string;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_GITMODULES_BYTES) return [];
    text = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const folders: SubmoduleFolder[] = [];
  for (const submodule of parseGitmodules(text)) {
    const relativePath = submodule.path.replace(/\/+$/, '');
    if (!isRelativeFilePath(relativePath)) continue;
    const absolutePath = path.join(root, ...relativePath.split('/'));
    try {
      if (!(await fs.lstat(absolutePath)).isDirectory()) continue;
      if (!isInside(root, await fs.realpath(absolutePath))) continue;
    } catch {
      continue;
    }
    folders.push({ name: submodule.name, relativePath, absolutePath });
  }
  return folders;
}

export type FolderRepository =
  | { readonly kind: 'repository'; readonly root: string; readonly gitDir: string; readonly commonDir: string }
  // path: as git printed it, the value safe.directory must hold
  | { readonly kind: 'unsafe'; readonly path: string }
  | { readonly kind: 'none' };

/** The repository git finds from folder (one rev-parse, which reads but never refreshes the index); signal cancels it. */
export async function inspectFolder(runner: GitRunner, project: string, folder: string, signal?: AbortSignal): Promise<FolderRepository> {
  const result = await runner.run({ project, cwd: folder, args: ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], kind: 'read', parsed: true, allowFailure: true, ...(signal ? { signal } : {}) });
  if (result.exitCode !== 0) {
    const unsafe = parseUnsafeRepository(result.stderr);
    return unsafe !== undefined ? { kind: 'unsafe', path: unsafe } : { kind: 'none' };
  }
  const [top, gitDir, commonDir] = result.stdout.toString('utf8').split('\n').map((line) => line.trim());
  if (!top || !gitDir || !commonDir) return { kind: 'none' };
  return { kind: 'repository', root: await fs.realpath(top), gitDir: path.resolve(gitDir), commonDir: path.resolve(folder, commonDir) };
}

// A linked worktree keeps its own git dir under the common dir's worktrees/; a submodule's git dir is its common dir.
export function isLinkedWorktree(found: { readonly gitDir: string; readonly commonDir: string }): boolean {
  return !samePath(found.gitDir, found.commonDir);
}

export interface FoundRepository {
  readonly root: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly kind: 'root' | 'nested' | 'submodule';
}

export interface DiscoveryResult {
  readonly repositories: readonly FoundRepository[];
  // top levels above the project folder, which open only after D9's answer
  readonly parents: readonly string[];
  // repositories git refused for dubious ownership, as git names them for safe.directory
  readonly unsafe: readonly string[];
}

/** Folders below root, to maxDepth (-1: no limit), holding a .git entry; links and junctions are never entered. */
export async function scanForRepositories(root: string, maxDepth: number): Promise<string[]> {
  const found: string[] = [];
  const queue = [{ folder: root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let children;
    try {
      children = await fs.readdir(current.folder, { withFileTypes: true });
    } catch {
      continue;
    }
    if (current.depth !== 0 && children.some((child) => child.name === '.git' && (child.isDirectory() || child.isFile()))) found.push(current.folder);
    if (current.depth >= maxDepth && maxDepth !== -1) continue;
    for (const child of children) {
      if (!child.isDirectory() || child.name === '.git' || SCAN_IGNORED_FOLDERS.some((ignored) => samePath(ignored, child.name))) continue;
      queue.push({ folder: path.join(current.folder, child.name), depth: current.depth + 1 });
    }
  }
  return found;
}

/**
 * The project's repositories: the one holding the project folder (always, even when that folder is a linked worktree), those
 * a scan to maxDepth finds (linked worktrees left unopened, as VS Code's git.detectWorktrees: false), and the submodules each
 * one's .gitmodules names. projectReal is the project folder's realpath. No git runs in, and nothing is read from, a folder
 * mayRunIn refuses, and no repository opens whose root, git dir or common dir it refuses.
 */
export async function discover(runner: GitRunner, project: string, projectReal: string, maxDepth: number, mayRunIn: (folder: string) => boolean, signal?: AbortSignal): Promise<DiscoveryResult> {
  const repositories = new Map<string, FoundRepository>();
  const parents: string[] = [];
  const unsafe: string[] = [];
  const key = (root: string): string => (process.platform === 'win32' ? root.toLowerCase() : root);
  const note = (found: FolderRepository): Extract<FolderRepository, { kind: 'repository' }> | undefined => {
    if (found.kind === 'unsafe' && mayRunIn(path.resolve(found.path)) && !unsafe.some((entry) => samePath(entry, found.path))) unsafe.push(found.path);
    return found.kind === 'repository' && [found.root, found.gitDir, found.commonDir].every(mayRunIn) ? found : undefined;
  };

  // VS Code's order: a repository above the project folder is a parent first, refused for ownership or not, so
  // safe.directory is offered for it only after D9's consent
  const ownFound = await inspectFolder(runner, project, projectReal, signal);
  if (ownFound.kind === 'unsafe' && !isInside(projectReal, path.resolve(ownFound.path))) parents.push(ownFound.path);
  const own = ownFound.kind === 'unsafe' && parents.includes(ownFound.path) ? undefined : note(ownFound);
  if (own && samePath(own.root, projectReal)) repositories.set(key(own.root), { ...own, kind: 'root' });
  else if (own && isInside(own.root, projectReal)) parents.push(own.root);

  for (const folder of await scanForRepositories(projectReal, maxDepth)) {
    if (!mayRunIn(folder)) continue;
    const found = note(await inspectFolder(runner, project, folder, signal));
    if (!found || !samePath(found.root, folder) || !isInside(projectReal, found.root) || isLinkedWorktree(found) || repositories.has(key(found.root))) continue;
    repositories.set(key(found.root), { ...found, kind: 'nested' });
  }

  const pending = [...repositories.values()];
  while (pending.length > 0) {
    const parent = pending.shift()!;
    for (const submodule of (await readSubmodules(parent.root)).slice(0, SUBMODULES_LIMIT)) {
      if (!mayRunIn(submodule.absolutePath)) continue;
      const found = note(await inspectFolder(runner, project, submodule.absolutePath, signal));
      if (!found || !samePath(found.root, submodule.absolutePath) || !isInside(projectReal, found.root)) continue;
      const entry: FoundRepository = { ...found, kind: 'submodule' };
      if (!repositories.has(key(found.root))) pending.push(entry);
      repositories.set(key(found.root), entry);
    }
  }
  return { repositories: [...repositories.values()], parents: parents.filter((root) => mayRunIn(path.resolve(root))), unsafe };
}
