// The folders main lets a renderer name files in (AD5, AD12 Confinement): each open project's folder and its live `chat`
// worktrees. Every channel's root key resolves here, so an adopted, deleted or closing worktree, or another project's, is
// never a root.
import type { ChatWorktreeRecord } from '../../../core/worktrees/registry';
import type { WorktreeRecordReader } from './records';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { parseRootKey, rootKey, type FolderRoot } from '../../preload/folder-root';
import type { Project } from '../../local-services/confine';

export interface RootProject extends Project {
  readonly root: FolderRoot;
  // the chat record of a worktree root
  readonly worktree?: ChatWorktreeRecord;
}

export interface WorktreeRootsDeps {
  // the open projects, keyed by folderKey
  readonly projects: () => readonly Project[];
  readonly registry: () => WorktreeRecordReader | undefined;
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

  /** The root of a live chat worktree of an open project. */
  ofWorktree(worktreeId: string): RootProject | undefined {
    const record = this.deps.registry()?.get(worktreeId);
    if (record?.kind !== 'chat') return undefined;
    const project = this.deps.projects().find((candidate) => candidate.key === folderKey(record.projectPath));
    return project ? this.resolve(rootKey({ projectKey: project.key, worktreeId })) : undefined;
  }

  /** The open project folders. */
  projectRoots(): RootProject[] {
    return this.deps.projects().map((project) => ({ ...project, root: { projectKey: project.key } }));
  }

  /** Every project folder, then every live chat worktree of the open projects. */
  all(): RootProject[] {
    const projects = this.deps.projects();
    const roots = this.projectRoots();
    const registry = this.deps.registry();
    if (!registry) return roots;
    for (const project of projects) {
      for (const record of registry.liveChatRecords(project.fsPath)) {
        if (!this.closing.has(record.id)) roots.push(worktreeRoot(project, record));
      }
    }
    return roots;
  }

  /** The branch of the project's chat worktree a root key names, for a tab's label; a closing or deleted one included. */
  branchOf(key: string): string | undefined {
    const root = parseRootKey(key);
    if (root?.worktreeId === undefined) return undefined;
    const record = this.deps.registry()?.get(root.worktreeId);
    return record?.kind === 'chat' && folderKey(record.projectPath) === root.projectKey ? record.branch : undefined;
  }

  /** Closes the worktree's root for a delete; dispose reopens it when the delete failed and the worktree is still live. */
  close(worktreeId: string): { dispose(): void } {
    this.closing.add(worktreeId);
    return { dispose: () => this.closing.delete(worktreeId) };
  }

  private liveChat(worktreeId: string, projectKey: string): ChatWorktreeRecord | undefined {
    if (this.closing.has(worktreeId)) return undefined;
    const record = this.deps.registry()?.get(worktreeId);
    if (record?.kind !== 'chat' || record.deletedAt !== undefined) return undefined;
    return folderKey(record.projectPath) === projectKey ? record : undefined;
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
