// D34: personal files (settings.local.json, mcp.local.json) of a worktree chat are its project's. Every reader and writer
// resolves their folder through personalConfigRoot; files in git still come from the working folder.
import type { Disposable } from '../../platform/disposable';

export interface WorktreeProjectLookup {
  /** The project of the chat worktree holding `folder`, live or deleted; undefined for any other folder. */
  projectOf(folder: string): string | undefined;
  /** AD12 Listing: the chat records of the project, live or deleted, and its adopted records whose folder is gone. */
  recordsOfProject(projectPath: string): ReadonlyArray<{ readonly workingFolder: string }>;
  /** A record by id. */
  get(id: string): { readonly workingFolder: string } | undefined;
  /** The chat record whose worktree holds `folder`. */
  chatRecordFor(folder: string): { readonly worktreeRoot: string; readonly repositoryRoot: string } | undefined;
}

let lookup: WorktreeProjectLookup | undefined;

/** Installed once per core by a host with worktree chats; the VS Code host installs none (slice 12a rule 17). */
export function installWorktreeProjectLookup(next: WorktreeProjectLookup): Disposable {
  lookup = next;
  return { dispose: () => { if (lookup === next) lookup = undefined; } };
}

/** The project for a chat worktree's folder, and the folder itself otherwise. */
export function personalConfigRoot(folder: string): string {
  return lookup?.projectOf(folder) ?? folder;
}

/**
 * The other folders whose session directories may hold a session of `folder` (slice 12a rule 1): for a project or its chat
 * worktree, the project and every registry folder of the project; none for any other folder.
 */
export function worktreeSessionFolders(folder: string): string[] {
  if (!lookup) return [];
  const project = lookup.projectOf(folder) ?? folder;
  const records = lookup.recordsOfProject(project);
  if (records.length === 0) return [];
  return [project, ...records.map((r) => r.workingFolder)];
}

/** The folder Damocles-owned records (memory's project scope, /stats) name for `folder`: its project for a chat worktree (D34). */
export function identityFolder(folder: string): string {
  return lookup?.projectOf(folder) ?? folder;
}

/** The context-file walk of a chat worktree's folder (rule 21); nothing for any other folder. */
export function worktreeWalkOf(folder: string): { worktree?: { worktreeRoot: string; repositoryRoot: string } } {
  const record = lookup?.chatRecordFor(folder);
  return record ? { worktree: { worktreeRoot: record.worktreeRoot, repositoryRoot: record.repositoryRoot } } : {};
}

/** The working folder of the worktree `id`, live or deleted; undefined when unknown or without a registry. */
export function worktreeFolderOf(id: string | undefined): string | undefined {
  return id === undefined ? undefined : lookup?.get(id)?.workingFolder;
}

/** The registered project of `folder`, for identity (memory, /stats, trust); undefined outside a chat worktree. */
export function worktreeProjectOf(folder: string): string | undefined {
  return lookup?.projectOf(folder);
}
