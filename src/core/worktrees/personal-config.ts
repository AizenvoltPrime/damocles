// D34: personal files (settings.local.json, mcp.local.json) of a worktree chat are its project's. Every reader and writer
// resolves their folder through personalConfigRoot; files in git still come from the working folder.
import type { Disposable } from '../../platform/disposable';

export interface WorktreeProjectLookup {
  /** The project of the chat worktree holding `folder`, live or deleted; undefined for any other folder. */
  projectOf(folder: string): string | undefined;
  /** AD12 Listing: the records whose session directories the project's Chats list reads (recordsListedUnder). */
  recordsOfProject(projectPath: string): ReadonlyArray<{ readonly workingFolder: string; readonly kind: 'chat' | 'adopted' }>;
  /** A record by id. */
  get(id: string): { readonly workingFolder: string; readonly projectPath?: string } | undefined;
  /** The chat record whose worktree holds `folder`. */
  chatRecordFor(folder: string): { readonly worktreeRoot: string; readonly repositoryRoot: string } | undefined;
}

let lookup: WorktreeProjectLookup | undefined;

/** Installed once per core by a host with worktree chats; the VS Code host installs none (slice 12a rule 17). */
export function installWorktreeProjectLookup(next: WorktreeProjectLookup): Disposable {
  lookup = next;
  return { dispose: () => { if (lookup === next) lookup = undefined; } };
}

/**
 * Whether a chat's settings file applies: its project file while the chat's folder is trusted, its local file (the project's
 * for a worktree chat) while that folder and `personalPath` both are, so no file applies where isTrusted says untrusted.
 */
export function settingsFileTrusted(isTrusted: (folder: string) => boolean, folder: { readonly path: string; readonly personalPath?: string }, scope: 'project' | 'local'): boolean {
  return isTrusted(folder.path) && (scope === 'project' || folder.personalPath === undefined || isTrusted(folder.personalPath));
}

/** The project for a chat worktree's folder, and the folder itself otherwise. */
export function personalConfigRoot(folder: string): string {
  return lookup?.projectOf(folder) ?? folder;
}

/** Whether the personal files under personalConfigRoot(folder) apply to a chat in `folder`: settingsFileTrusted's local file. */
export function personalFilesTrusted(isTrusted: (folder: string) => boolean, folder: string): boolean {
  return settingsFileTrusted(isTrusted, { path: folder, personalPath: personalConfigRoot(folder) }, 'local');
}

/**
 * The other folders whose session directories may hold a session of `folder` (slice 12a rule 1): for a project or its chat
 * worktree, the project and every registry folder of the project; none for any other folder. It finds files; which list a
 * session is in is its own (docs/invariants.md "Worktree chats", Ownership).
 */
export function worktreeSessionFolders(folder: string): string[] {
  if (!lookup) return [];
  const project = lookup.projectOf(folder) ?? folder;
  const records = lookup.recordsOfProject(project);
  if (records.length === 0) return [];
  return [project, ...records.map((r) => r.workingFolder)];
}

/** The records whose session directories the Chats list of the open project `projectPath` reads (AD12 Listing). */
export function listedWorktreeRecords(projectPath: string): ReadonlyArray<{ readonly workingFolder: string; readonly kind: 'chat' | 'adopted' }> {
  return lookup ? lookup.recordsOfProject(projectPath) : [];
}

/** The project the worktree record `id` names, live or deleted; undefined when unknown or without a registry. */
export function worktreeProjectById(id: string): string | undefined {
  return lookup?.get(id)?.projectPath;
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
