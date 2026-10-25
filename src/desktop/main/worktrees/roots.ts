// The folders main lets a renderer name files in (AD5, AD12 Confinement): each open project's folder and its live `chat`
// worktrees. Every channel's root key resolves here, so an adopted, deleted or closing worktree, or another project's, is
// never a root.
import type { ChatWorktreeRecord } from '../../../core/worktrees/registry';
import type { WorktreeRecordReader } from './records';
import { folderKeyOn } from '../../../core/workspace-folders/folder-key';
import { parseRootKey, rootKey, type FolderRoot } from '../../preload/folder-root';
import type { Project } from '../../local-services/confine';
import { authorityKeyOfProject, targetFolderKeyOf } from '../../../shared/project-location';

export interface RootProject extends Project {
  readonly root: FolderRoot;
  // the chat record of a worktree root
  readonly worktree?: ChatWorktreeRecord;
}

export interface WorktreeRootsDeps {
  // the open projects, local ones keyed by folderKey and remote ones by their remote key
  readonly projects: () => readonly Project[];
  // the registry of the core that holds an authority's worktrees: this computer's, or a remote host's
  readonly registry: (authority: string) => WorktreeRecordReader | undefined;
  // the OS a project's paths are on: this computer's, or its remote host's
  readonly osOf: (projectKey: string) => NodeJS.Platform;
}

export class WorktreeRoots {
  private readonly deps: WorktreeRootsDeps;
  // worktrees whose delete has stopped what runs there (slice 12a rule 14), so nothing reopens them before the remove
  private readonly closing = new Set<string>();

  constructor(deps: WorktreeRootsDeps) {
    this.deps = deps;
  }

  /** The project folder or the live chat worktree a root key names, or undefined when main refuses it. */
  resolve(key: unknown): RootProject | undefined {
    const root = parseRootKey(key);
    if (!root) return undefined;
    const project = this.deps.projects().find((candidate) => candidate.key === root.projectKey);
    if (!project) return undefined;
    if (root.worktreeId === undefined) return { ...project, root: { projectKey: project.key } };
    const record = this.liveChat(root.worktreeId, project.key);
    return record ? worktreeRoot(project, record) : undefined;
  }

  /** The root of a live chat worktree of an open project of the authority whose core holds it. */
  ofWorktree(worktreeId: string, authority: string = 'local'): RootProject | undefined {
    const record = this.deps.registry(authority)?.get(worktreeId);
    if (record?.kind !== 'chat') return undefined;
    const project = this.deps.projects().find((candidate) => authorityKeyOfProject(candidate.key) === authority && this.holdsProject(candidate.key, record.projectPath));
    return project ? this.resolve(rootKey({ projectKey: project.key, worktreeId })) : undefined;
  }

  /** The open project folders. */
  projectRoots(): RootProject[] {
    return this.deps.projects().map((project) => ({ ...project, root: { projectKey: project.key } }));
  }

  /** Every project folder, then every live chat worktree of the open projects. */
  all(): RootProject[] {
    const roots = this.projectRoots();
    // each project's worktrees come from its own host's registry, never from another's that names the same path
    for (const project of this.deps.projects()) {
      for (const record of this.deps.registry(authorityKeyOfProject(project.key))?.liveChatRecords(project.fsPath) ?? []) {
        if (!this.closing.has(record.id)) roots.push(worktreeRoot(project, record));
      }
    }
    return roots;
  }

  /** The branch of the project's chat worktree a root key names, for a tab's label; a closing or deleted one included. */
  branchOf(key: string): string | undefined {
    const root = parseRootKey(key);
    if (root?.worktreeId === undefined) return undefined;
    const record = this.deps.registry(authorityKeyOfProject(root.projectKey))?.get(root.worktreeId);
    return record?.kind === 'chat' && this.holdsProject(root.projectKey, record.projectPath) ? record.branch : undefined;
  }

  /** Closes the worktree's root for a delete; dispose reopens it when the delete failed and the worktree is still live. */
  close(worktreeId: string): { dispose(): void } {
    this.closing.add(worktreeId);
    return { dispose: () => this.closing.delete(worktreeId) };
  }

  // A record names its project by the path on its own host; a remote key carries the folder key computed there.
  private holdsProject(projectKey: string, projectPath: string): boolean {
    return (targetFolderKeyOf(projectKey) ?? projectKey) === folderKeyOn(this.deps.osOf(projectKey), projectPath);
  }

  private liveChat(worktreeId: string, projectKey: string): ChatWorktreeRecord | undefined {
    if (this.closing.has(worktreeId)) return undefined;
    const record = this.deps.registry(authorityKeyOfProject(projectKey))?.get(worktreeId);
    if (record?.kind !== 'chat' || record.deletedAt !== undefined) return undefined;
    return this.holdsProject(projectKey, record.projectPath) ? record : undefined;
  }
}

/** The root set main last gave its root-keyed consumers (terminals, the file tree, Quick Open, formatter hosts). */
export class RootSet {
  private keys = new Set<string>();

  /** The keys that joined and left since the last update; undefined when the set is the same. */
  update(next: readonly string[]): { readonly added: string[]; readonly removed: string[] } | undefined {
    const keys = new Set(next);
    const added = [...keys].filter((key) => !this.keys.has(key));
    const removed = [...this.keys].filter((key) => !keys.has(key));
    this.keys = keys;
    return added.length === 0 && removed.length === 0 ? undefined : { added, removed };
  }
}

function worktreeRoot(project: Project, record: ChatWorktreeRecord): RootProject {
  const root = { projectKey: project.key, worktreeId: record.id };
  return { key: rootKey(root), fsPath: record.workingFolder, name: project.name, root, worktree: record };
}
