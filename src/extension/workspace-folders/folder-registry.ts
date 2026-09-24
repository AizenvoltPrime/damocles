import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { folderKey } from "./folder-key";
import { log } from "../logger";
import type { WorkspaceFolderInfo } from "../../shared/types/workspace-folders";

export const DEFAULT_WORKSPACE_FOLDER_STATE_KEY = "damocles.defaultWorkspaceFolder";

/** The home target's path; no-folder session dirs and memory strings already on disk key on exactly this. */
export function homeDirectory(): string {
  return process.env["HOME"] || process.env["USERPROFILE"] || os.homedir();
}

export interface FolderTarget {
  key: string;
  /** The raw `uri.fsPath`: session dirs, memory workspace strings and the Compass hash key on it verbatim. */
  fsPath: string;
  name: string;
  label: string;
  /** False only for the home target of a window with no folder open, which has no project layer. */
  projectScope: boolean;
}

export interface FolderChange {
  added: FolderTarget[];
  removed: FolderTarget[];
  /** A folder that stayed open now shows a different label. */
  relabelled: boolean;
  defaultChanged: boolean;
}

type FolderChangeListener = (change: FolderChange) => void;

/** The folders a panel may target: the open `file`-scheme workspace folders, or home when none is open. */
export class WorkspaceFolderRegistry implements vscode.Disposable {
  private snapshot: FolderTarget[];
  private readonly listeners = new Set<FolderChangeListener>();
  private readonly subscription: vscode.Disposable;
  private readonly state: vscode.Memento;

  constructor(state: vscode.Memento) {
    this.state = state;
    this.snapshot = readTargets();
    this.subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh());
  }

  targets(): readonly FolderTarget[] {
    return this.snapshot;
  }

  get isMultiRoot(): boolean {
    return this.snapshot.filter((t) => t.projectScope).length >= 2;
  }

  resolve(key: string): FolderTarget | undefined {
    return this.snapshot.find((t) => t.key === key);
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
    if (this.defaultTarget().key !== before) this.emit({ added: [], removed: [], relabelled: false, defaultChanged: true });
    return true;
  }

  folderInfos(): WorkspaceFolderInfo[] {
    return this.snapshot.map((t) => ({ key: t.key, name: t.name, label: t.label, path: t.fsPath }));
  }

  onDidChange(listener: FolderChangeListener): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  dispose(): void {
    this.subscription.dispose();
    this.listeners.clear();
  }

  private refresh(): void {
    const previous = this.snapshot;
    const previousDefault = this.defaultTarget().key;
    this.snapshot = readTargets();
    // Diffed by key, so a folder whose display name changed is neither removed nor added.
    const previousLabels = new Map(previous.map((t) => [t.key, t.label]));
    const currentKeys = new Set(this.snapshot.map((t) => t.key));
    this.emit({
      added: this.snapshot.filter((t) => !previousLabels.has(t.key)),
      removed: previous.filter((t) => !currentKeys.has(t.key)),
      relabelled: this.snapshot.some((t) => previousLabels.has(t.key) && previousLabels.get(t.key) !== t.label),
      defaultChanged: this.defaultTarget().key !== previousDefault,
    });
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

function readTargets(): FolderTarget[] {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file");
  if (folders.length === 0) {
    const home = homeDirectory();
    return [{ key: folderKey(home), fsPath: home, name: path.basename(home), label: path.basename(home), projectScope: false }];
  }
  const entries = folders.map((f) => ({ key: folderKey(f.uri.fsPath), fsPath: f.uri.fsPath, name: f.name }));
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
