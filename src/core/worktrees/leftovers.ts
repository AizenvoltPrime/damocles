// R15's startup scan (AD12 Leftovers) and the adopted pass (slice 12a rules 15, 16). The scan reports; it never deletes a
// folder or prunes git's records on its own. `git worktree prune` runs only from the Review dialog and from a Delete whose
// worktree folder is already gone (integrate.ts removeWorktree).
import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import type { GitRunner } from '../scm/git-runner';
import { findGitDir, GIT_FILE_READ_LIMIT, reachesAnotherHost, readBounded, readHead } from '../workspace-folders/git-head';
import { folderKey } from '../workspace-folders/folder-key';
import { projectGit } from './create';
import { REGISTRY_FILE, type ChatWorktreeRecord, type WorktreeRecord, type WorktreeRegistry } from './registry';
import { folderContains } from './records';
import { WORKTREE_ENTRY } from './hand-off';
import { piSessionDir } from '../pi-session/session-store/session-dir';

// Longer than any creation takes: the add, the copies and a large .worktreeinclude.
const CREATION_GRACE_MS = 15 * 60 * 1000;

/** noChat: a live chat worktree past the creation grace that no chat ever worked in and nobody kept (a quit during its setup). */
export type LeftoverReason = 'unregistered' | 'missingFolder' | 'gitRecordOnly' | 'noChat';

export interface LeftoverFinding {
  readonly path: string;
  readonly reason: LeftoverReason;
  /** The project whose repository holds git's record, for a 'gitRecordOnly' finding (Review's Prune runs there), and a 'noChat' worktree's project. */
  readonly projectPath?: string;
  /** The 'noChat' worktree's id. */
  readonly worktreeId?: string;
}

export interface LinkedWorktree {
  /** The linked worktree's top level. */
  readonly worktreeRoot: string;
  /** The main worktree's top level. */
  readonly repositoryRoot: string;
  readonly branch?: string;
}

/**
 * The linked worktree `folder` lies in, read from git's files as git-head.ts reads them, without running git; undefined for a
 * main worktree, a submodule, a bare repository or no repository.
 */
export async function linkedWorktreeOf(folder: string): Promise<LinkedWorktree | undefined> {
  const gitDir = await findGitDir(folder);
  // A linked worktree's git dir is <common dir>/worktrees/<name>, holding `commondir` and `gitdir`.
  if (gitDir === undefined || path.basename(path.dirname(gitDir)) !== 'worktrees') return undefined;
  const common = await readBounded(path.join(gitDir, 'commondir'), GIT_FILE_READ_LIMIT);
  const back = await readBounded(path.join(gitDir, 'gitdir'), GIT_FILE_READ_LIMIT);
  if (common === undefined || back === undefined) return undefined;
  const commonDir = path.resolve(gitDir, common.trim());
  if (path.basename(commonDir) !== '.git') return undefined;
  const dotGit = path.resolve(gitDir, back.trim());
  if (path.basename(dotGit) !== '.git') return undefined;
  // Both come from the folder's own git files, which a downloaded folder controls; neither may lead to another host.
  if (reachesAnotherHost(commonDir, folder) || reachesAnotherHost(dotGit, folder)) return undefined;
  const branch = await readHead(gitDir);
  return { worktreeRoot: path.dirname(dotGit), repositoryRoot: path.dirname(commonDir), ...(branch !== undefined ? { branch } : {}) };
}

/**
 * The first of `folders` that lies in `repositoryRoot`, as written or by realpath: git writes a linked worktree's repository
 * as its realpath, while a project keeps the spelling it was added by (an 8.3 alias, a link). A folder that is gone is in none.
 */
export async function folderInRepository(repositoryRoot: string, folders: readonly string[]): Promise<string | undefined> {
  const real = (folder: string): Promise<string | undefined> => fs.realpath(folder).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  });
  const rootReal = await real(repositoryRoot);
  for (const folder of folders) {
    if (folderContains(repositoryRoot, folder)) return folder;
    const folderReal = rootReal === undefined ? undefined : await real(folder);
    if (rootReal !== undefined && folderReal !== undefined && folderContains(rootReal, folderReal)) return folder;
  }
  return undefined;
}

export interface ScanInput {
  readonly registry: WorktreeRegistry;
  /** Undefined when git is missing; then only the folders and the registry are compared. */
  readonly git: GitRunner | undefined;
  /** The open projects. */
  readonly projects: readonly string[];
  readonly isTrusted: (project: string) => boolean;
  /** The scan's clock; tests pass one past the creation grace. */
  readonly now?: number;
}

/**
 * Compares the worktrees folder with the registry, and each trusted project's `git worktree list --porcelain` with the disk.
 * A registry record whose folder is gone is marked deleted, so its chats open read-only; nothing on disk changes.
 */
export async function scanLeftovers(input: ScanInput): Promise<LeftoverFinding[]> {
  const { registry } = input;
  const findings: LeftoverFinding[] = [];
  // Another app version's records name folders it may still use, so they count as recorded too.
  const recorded = new Set([...registry.records().map((r) => r.worktreeRoot), ...registry.foreignWorktreeRoots()].map(folderKey));
  for (const projectDir of await subdirectories(registry.rootDir)) {
    for (const chatDir of await subdirectories(projectDir)) {
      if (!recorded.has(folderKey(chatDir))) findings.push({ path: chatDir, reason: 'unregistered' });
    }
  }
  const now = input.now ?? Date.now();
  // AD12 Projects: the worktrees of a project that is not open are not reported.
  const open = new Set(input.projects.map(folderKey));
  const ofOpenProject = (record: WorktreeRecord): boolean => record.projectPath !== undefined && open.has(folderKey(record.projectPath));
  for (const record of registry.records()) {
    // A chat record is written before `git worktree add`, so a young record without its folder may be one being created.
    if (record.deletedAt !== undefined || now - record.createdAt < CREATION_GRACE_MS || (await exists(record.worktreeRoot))) continue;
    // An adopted worktree may sit on a drive that is not mounted now; only a folder gone from a parent that exists is deleted.
    if (record.kind === 'adopted' && !(await exists(path.dirname(record.worktreeRoot)))) continue;
    await registry.markDeleted(record.id);
    if (ofOpenProject(record)) findings.push({ path: record.worktreeRoot, reason: 'missingFolder' });
  }
  for (const record of registry.records()) {
    if (record.kind !== 'chat' || record.deletedAt !== undefined || record.usedAt !== undefined || now - record.createdAt < CREATION_GRACE_MS) continue;
    if (!(await exists(record.worktreeRoot))) continue;
    // A record written before usedAt existed is marked once a session is found naming it.
    if (await sessionNames(record)) {
      await registry.markUsed(record.id);
      continue;
    }
    if (ofOpenProject(record)) findings.push({ path: record.worktreeRoot, reason: 'noChat', projectPath: record.projectPath, worktreeId: record.id });
  }
  if (input.git) {
    const seen = new Set<string>();
    for (const project of input.projects) {
      // A project whose folder is gone has no worktree list to read, and git cannot start in it.
      if (!input.isTrusted(project) || !(await exists(project))) continue;
      const git = projectGit(input.git, project);
      const listed = await git.run(project, ['worktree', 'list', '--porcelain', '-z'], { allowFailure: true });
      if (listed.exitCode !== 0) continue;
      for (const block of listed.stdout.toString('utf8').split('\0\0')) {
        const lines = block.split('\0');
        const worktree = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
        if (worktree === undefined || !lines.some((l) => l === 'prunable' || l.startsWith('prunable '))) continue;
        const key = folderKey(worktree);
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ path: path.resolve(worktree), reason: 'gitRecordOnly', projectPath: project });
      }
    }
  }
  return findings;
}

/** Review's Prune: drops git's records of worktree folders that no longer exist, in one project's repository. */
export async function pruneWorktrees(git: GitRunner, projectPath: string): Promise<void> {
  await projectGit(git, projectPath).run(projectPath, ['worktree', 'prune'], { kind: 'mutation' });
}

// A chat started in the worktree keeps its file in the working folder's session dir; a chat handed off to it keeps its file in
// the project's, where one of its worktree entries names the worktree.
async function sessionNames(record: ChatWorktreeRecord): Promise<boolean> {
  if ((await sessionFiles(piSessionDir(record.workingFolder))).length > 0) return true;
  for (const file of await sessionFiles(piSessionDir(record.projectPath))) {
    if (await fileNamesWorktree(file, record.id)) return true;
  }
  return false;
}

async function sessionFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return names.filter((name) => name.endsWith('.jsonl') && !name.startsWith('agent-')).map((name) => path.join(dir, name));
}

// Read line by line without parsing: a line holding the entry type and the quoted id names the worktree.
async function fileNamesWorktree(file: string, worktreeId: string): Promise<boolean> {
  const quoted = JSON.stringify(worktreeId);
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.includes(WORKTREE_ENTRY) && line.includes(quoted)) return true;
    }
  } finally {
    lines.close();
  }
  return false;
}

async function subdirectories(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith(REGISTRY_FILE)).map((e) => path.join(dir, e.name));
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
