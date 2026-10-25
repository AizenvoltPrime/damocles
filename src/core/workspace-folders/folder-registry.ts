import * as os from "os";
import * as path from "path";
import { folderKey } from "./folder-key";
import { BranchTracker } from "./git-head";
import { personalConfigRoot } from "../worktrees/personal-config";
import { log } from "../logger";
import type { WorkspaceFolderInfo } from "../../shared/types/workspace-folders";
import type { Disposable } from "../../platform/disposable";
import type { FileWatcherFactory } from "../../platform/file-watcher";
import type { Memento } from "../../platform/key-value-state";
import type { WorkspaceFolders } from "../../platform/workspace-folders";
import type { SettingsFolder } from "../../platform/settings-store";
import type { Platform } from "../../platform/platform";

export const DEFAULT_WORKSPACE_FOLDER_STATE_KEY = "damocles.defaultWorkspaceFolder";

/** The home target's path; no-folder session dirs and memory strings already on disk key on exactly this. */
export function homeDirectory(): string {
  return process.env["HOME"] || process.env["USERPROFILE"] || os.homedir();
}

/** The folder a chat on `target` reads settings for; the home target has none, so its reads are user-level. */
export function settingsFolderOf(target: FolderTarget): SettingsFolder | undefined {
  if (!target.projectScope) return undefined;
  // D34: a worktree chat's local layer and trust are its project's.
  const personal = personalConfigRoot(target.fsPath);
  return personal === target.fsPath ? { path: target.fsPath } : { path: target.fsPath, personalPath: personal };
}

/**
 * The folder `WorkspaceFolderRegistry.defaultTarget()` names, read from the same inputs without a registry;
 * undefined when no folder is open (the home target has no project layer). Keep the two rules equal.
 */
export function defaultProjectPath(folders: WorkspaceFolders, state: Memento): string | undefined {
  const open = folders.folders();
  const stored = state.get<string>(DEFAULT_WORKSPACE_FOLDER_STATE_KEY);
  const match = stored !== undefined ? open.find((f) => folderKey(f.fsPath) === stored) : undefined;
  return (match ?? open[0])?.fsPath;
}

/**
 * The folder whose project and local files a settings read or write with no folder uses: the default project, and none
 * on a daemon's core, which serves every client's folders and no window. The desktop settings store applies the same rule.
 */
export function windowSettingsProject(platform: Pick<Platform, "workspaceFolders" | "state" | "remote">): string | undefined {
  return platform.remote !== undefined ? undefined : defaultProjectPath(platform.workspaceFolders, platform.state.workspace);
}

export interface FolderTarget {
  key: string;
  /** The raw `uri.fsPath`: session dirs, memory workspace strings and the Compass hash key on it verbatim. */
  fsPath: string;
  name: string;
  label: string;
  /** False only for the home target of a window with no folder open, which has no project layer. */
  projectScope: boolean;
  /** Set on a worktree chat's working folder: the key of the project that owns it (slice 12a rule 5). */
  ownerKey?: string;
}

export interface FolderChange {
  added: FolderTarget[];
  removed: FolderTarget[];
  /** A folder that stayed open now shows a different label. */
  relabelled: boolean;
  defaultChanged: boolean;
  /** A folder's git branch changed (D42); the folders themselves did not. */
  branchChanged: boolean;
}

type FolderChangeListener = (change: FolderChange) => void;

export interface OwnedFolderChange {
  readonly added: readonly FolderTarget[];
  readonly removed: readonly FolderTarget[];
}

type OwnedFolderChangeListener = (change: OwnedFolderChange) => void;

const NO_FOLDER_CHANGE: FolderChange = { added: [], removed: [], relabelled: false, defaultChanged: false, branchChanged: false };

/** The folders a panel may target: the open `file`-scheme workspace folders, or home when none is open. */
export class WorkspaceFolderRegistry implements Disposable {
  private snapshot: FolderTarget[];
  private readonly listeners = new Set<FolderChangeListener>();
  private readonly ownedListeners = new Set<OwnedFolderChangeListener>();
  private readonly subscription: Disposable;
  private readonly folders: WorkspaceFolders;
  private readonly state: Memento;
  private readonly branches: BranchTracker;
  // owned working folders by key, with the count of chats bound to each
  private readonly owned = new Map<string, { target: FolderTarget; refs: number }>();

  /** `state` is the window-scoped (workspace) memento. */
  constructor(folders: WorkspaceFolders, state: Memento, fileWatchers: FileWatcherFactory) {
    this.folders = folders;
    this.state = state;
    this.snapshot = readTargets(folders);
    this.branches = new BranchTracker(fileWatchers, () => this.emit({ ...NO_FOLDER_CHANGE, branchChanged: true }));
    this.trackBranches();
    this.subscription = folders.onDidChange(() => this.refresh());
  }

  /** The projects only; owned working folders never appear here. */
  targets(): readonly FolderTarget[] {
    return this.snapshot;
  }

  get isMultiRoot(): boolean {
    return this.snapshot.filter((t) => t.projectScope).length >= 2;
  }

  /** A project, or a working folder a loaded chat holds. */
  resolve(key: string): FolderTarget | undefined {
    return this.snapshot.find((t) => t.key === key) ?? this.owned.get(key)?.target;
  }

  /** The project target holding `key`: itself for a project, its owner for an owned folder. */
  projectOf(key: string): FolderTarget | undefined {
    const target = this.resolve(key);
    return target?.ownerKey !== undefined ? this.snapshot.find((t) => t.key === target.ownerKey) : target;
  }

  /**
   * Registers `fsPath` as a working folder owned by the open project `ownerKey`, counted per holder; the folder leaves
   * when the last holder disposes. Throws when the owner is not an open project or the folder is a project itself.
   */
  acquireOwned(fsPath: string, ownerKey: string): Disposable {
    const owner = this.snapshot.find((t) => t.key === ownerKey && t.projectScope);
    if (!owner) throw new Error(`The project ${ownerKey} is not open`);
    const key = folderKey(fsPath);
    if (this.snapshot.some((t) => t.key === key)) throw new Error(`${fsPath} is open as a project`);
    const existing = this.owned.get(key);
    if (existing && existing.target.ownerKey !== ownerKey) throw new Error(`${fsPath} belongs to another project`);
    let entry = existing;
    if (entry) entry.refs++;
    else {
      const target: FolderTarget = { key, fsPath, name: path.basename(fsPath), label: owner.label, projectScope: true, ownerKey };
      entry = { target, refs: 1 };
      this.owned.set(key, entry);
      this.trackBranches();
      this.emitOwned({ added: [target], removed: [] });
    }
    const held = entry;
    let released = false;
    return {
      dispose: () => {
        if (released) return;
        released = true;
        // A registration dropped with its project and made again since then is another holder's.
        if (this.owned.get(key) !== held) return;
        if (--held.refs > 0) return;
        this.owned.delete(key);
        this.trackBranches();
        this.emitOwned({ added: [], removed: [held.target] });
      },
    };
  }

  /** The working folders loaded chats hold, each owned by an open project (slice 12a rule 5). */
  ownedFolders(): readonly FolderTarget[] {
    return [...this.owned.values()].map((entry) => entry.target);
  }

  /** Fires when a working folder gains its first holder, loses its last, or leaves with its project. */
  onDidChangeOwned(listener: OwnedFolderChangeListener): Disposable {
    this.ownedListeners.add(listener);
    return { dispose: () => { this.ownedListeners.delete(listener); } };
  }

  /** The window's first folder, or home when none is open. */
  firstTarget(): FolderTarget {
    const first = this.snapshot[0];
    if (!first) throw new Error("WorkspaceFolderRegistry has no targets");
    return first;
  }

  defaultTarget(): FolderTarget {
    const stored = this.state.get<string>(DEFAULT_WORKSPACE_FOLDER_STATE_KEY);
    // A stored default that is not open stays stored, so re-adding that folder restores it.
    return (stored !== undefined ? this.resolve(stored) : undefined) ?? this.firstTarget();
  }

  /** Returns false, storing nothing, when `key` is not an open target. */
  async setDefault(key: string): Promise<boolean> {
    if (!this.resolve(key)) return false;
    const before = this.defaultTarget().key;
    await this.state.update(DEFAULT_WORKSPACE_FOLDER_STATE_KEY, key);
    if (this.defaultTarget().key !== before) this.emit({ ...NO_FOLDER_CHANGE, defaultChanged: true });
    return true;
  }

  folderInfos(): WorkspaceFolderInfo[] {
    return this.snapshot.map((t) => {
      const branch = this.branchOf(t.key);
      return { key: t.key, name: t.name, label: t.label, path: t.fsPath, ...(branch !== undefined ? { branch } : {}) };
    });
  }

  /** The branch checked out in the folder's working tree, read from git's HEAD file (D42); undefined outside git. */
  branchOf(key: string): string | undefined {
    const target = this.resolve(key);
    return target ? this.branches.branchOf(target.fsPath) : undefined;
  }

  onDidChange(listener: FolderChangeListener): Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  dispose(): void {
    this.subscription.dispose();
    this.branches.dispose();
    this.listeners.clear();
    this.ownedListeners.clear();
  }

  // The home target of a window with no folder open is not a project, so it shows no branch.
  private trackBranches(): void {
    this.branches.setFolders([...this.snapshot.filter((t) => t.projectScope), ...[...this.owned.values()].map((e) => e.target)].map((t) => t.fsPath));
  }

  private refresh(): void {
    const previous = this.snapshot;
    const previousDefault = this.defaultTarget().key;
    this.snapshot = readTargets(this.folders);
    // A removed project takes its owned working folders with it; their panels move off like the project's own.
    const ownedRemoved: FolderTarget[] = [];
    for (const [key, entry] of this.owned) {
      if (this.snapshot.some((t) => t.key === entry.target.ownerKey)) continue;
      this.owned.delete(key);
      ownedRemoved.push(entry.target);
    }
    this.trackBranches();
    // Diffed by key, so a folder whose display name changed is neither removed nor added.
    const previousLabels = new Map(previous.map((t) => [t.key, t.label]));
    const currentKeys = new Set(this.snapshot.map((t) => t.key));
    if (ownedRemoved.length > 0) this.emitOwned({ added: [], removed: ownedRemoved });
    this.emit({
      added: this.snapshot.filter((t) => !previousLabels.has(t.key)),
      removed: [...previous.filter((t) => !currentKeys.has(t.key)), ...ownedRemoved],
      relabelled: this.snapshot.some((t) => previousLabels.has(t.key) && previousLabels.get(t.key) !== t.label),
      defaultChanged: this.defaultTarget().key !== previousDefault,
      branchChanged: false,
    });
  }

  private emitOwned(change: OwnedFolderChange): void {
    for (const listener of [...this.ownedListeners]) {
      try {
        listener(change);
      } catch (err) {
        log("[WorkspaceFolderRegistry] owned folder listener failed: %O", err);
      }
    }
  }

  private emit(change: FolderChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (err) {
        log("[WorkspaceFolderRegistry] folder change listener failed: %O", err);
      }
    }
  }
}

function readTargets(workspaceFolders: WorkspaceFolders): FolderTarget[] {
  const folders = workspaceFolders.folders();
  if (folders.length === 0) {
    const home = homeDirectory();
    return [{ key: folderKey(home), fsPath: home, name: path.basename(home), label: path.basename(home), projectScope: false }];
  }
  const entries = folders.map((f) => ({ key: folderKey(f.fsPath), fsPath: f.fsPath, name: f.name }));
  const labels = disambiguatedLabels(entries);
  return entries.map((e, i) => ({ ...e, label: labels[i] ?? e.name, projectScope: true }));
}

/**
 * Same-named folders get the shortest trailing run of parent directories that tells them apart,
 * `app (client)` and `app (server)`, as VS Code labels same-named editor tabs.
 */
function disambiguatedLabels(entries: ReadonlyArray<{ fsPath: string; name: string }>): string[] {
  const byName = new Map<string, number[]>();
  entries.forEach((e, i) => {
    const group = byName.get(e.name) ?? [];
    group.push(i);
    byName.set(e.name, group);
  });
  const labels = entries.map((e) => e.name);
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    const parents = group.map((i) => path.dirname(entries[i]!.fsPath).split(/[\\/]/).filter((s) => s.length > 0));
    const longest = Math.max(...parents.map((p) => p.length));
    let depth = 1;
    while (depth < longest && new Set(parents.map((p) => p.slice(-depth).join("/"))).size < group.length) depth++;
    group.forEach((entryIndex, j) => {
      const suffix = parents[j]!.slice(-depth).join("/");
      labels[entryIndex] = suffix ? `${name} (${suffix})` : name;
    });
  }
  return labels;
}
