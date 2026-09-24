import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../../logger';
import type { DatabaseInstance, MemoryRow } from '../types';
import type { MemoryWriteQueue } from '../write-queue';
import { folderKey } from '../../workspace-folders/folder-key';
import { isWithinRoot } from '../../compass/util';

const CHANGE_DEBOUNCE_MS = 5000;

export class FileChangeTracker {
  private db: DatabaseInstance;
  private writeQueue: MemoryWriteQueue;
  private workspaceRoots: readonly string[];
  // Full-path index: normalized absolute forward-slash lowercase path → observation ids.
  private fileToObservations = new Map<string, Set<string>>();
  // Suffix fallback index (last-2-segment key) per observation folder, keyed by `folderKey`: lets an
  // event path whose full normalized form misses still match by trailing suffix within the folder that
  // contains it. Trade-off: can over-mark a same-suffix file in another directory of that folder,
  // deliberately preferred over never marking stale.
  private suffixIndexByFolder = new Map<string, Map<string, Set<string>>>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposables: vscode.Disposable[] = [];

  constructor(db: DatabaseInstance, writeQueue: MemoryWriteQueue, workspaceRoots: readonly string[]) {
    this.db = db;
    this.writeQueue = writeQueue;
    this.workspaceRoots = [...workspaceRoots];
  }

  /** Re-scope the index to the open folders' observations. */
  setWorkspaceRoots(workspaceRoots: readonly string[]): void {
    this.workspaceRoots = [...workspaceRoots];
    this.fileToObservations.clear();
    this.suffixIndexByFolder.clear();
    this.buildReverseIndex();
  }

  initialize(): void {
    this.buildReverseIndex();

    // One workspace-wide watcher catches editor saves, agent write/edit tools, AND git operations.
    // Non-tracked paths are rejected by a cheap Map lookup and DB writes stay debounced + batched.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(watcher);
    this.disposables.push(watcher.onDidChange((uri) => this.onFileChanged(uri.fsPath)));
    this.disposables.push(watcher.onDidCreate((uri) => this.onFileChanged(uri.fsPath)));
    this.disposables.push(watcher.onDidDelete((uri) => this.onFileDeletedOrRenamed(uri.fsPath)));
    this.disposables.push(
      vscode.workspace.onDidRenameFiles((e) => {
        for (const { oldUri, newUri } of e.files) {
          this.onFileDeletedOrRenamed(oldUri.fsPath);
          this.onFileDeletedOrRenamed(newUri.fsPath);
        }
      }),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /** `workspace` is the observation's own folder, which its relative stored paths resolve against. */
  trackObservation(id: string, filesRead: string[], filesModified: string[], workspace: string): void {
    const allFiles = [...filesRead, ...filesModified];
    const folder = folderKey(workspace);
    for (const file of allFiles) {
      const normalized = this.normalizePath(file, workspace);
      if (!normalized) continue;
      this.addToIndex(this.fileToObservations, normalized, id);
      const suffix = this.suffixKey(normalized);
      if (!suffix) continue;
      let suffixIndex = this.suffixIndexByFolder.get(folder);
      if (!suffixIndex) {
        suffixIndex = new Map();
        this.suffixIndexByFolder.set(folder, suffixIndex);
      }
      this.addToIndex(suffixIndex, suffix, id);
    }
  }

  resetStaleness(id: string): Promise<boolean> {
    const db = this.db;
    return this.writeQueue.run(() => {
      const result = db.prepare(
        'UPDATE memories SET file_change_count = 0 WHERE id = ?'
      ).run(id);
      return result.changes > 0;
    });
  }

  /** Untrack an observation from both the full-path and suffix indexes. */
  removeObservation(id: string): void {
    for (const [key, ids] of this.fileToObservations) {
      ids.delete(id);
      if (ids.size === 0) this.fileToObservations.delete(key);
    }
    for (const [folder, suffixIndex] of this.suffixIndexByFolder) {
      for (const [key, ids] of suffixIndex) {
        ids.delete(id);
        if (ids.size === 0) suffixIndex.delete(key);
      }
      if (suffixIndex.size === 0) this.suffixIndexByFolder.delete(folder);
    }
  }

  private addToIndex(index: Map<string, Set<string>>, key: string, id: string): void {
    let set = index.get(key);
    if (!set) {
      set = new Set();
      index.set(key, set);
    }
    set.add(id);
  }

  private buildReverseIndex(): void {
    // Only live, latest observations participate; forgotten/superseded rows must not accumulate count.
    // Scope to the open folders: suffix matching means a file edited here would otherwise bump
    // staleness on same-named files' observations in unrelated workspaces.
    const roots = this.workspaceRoots;
    const rows = roots.length === 0 ? [] : this.db.prepare(
      `SELECT id, workspace, files_read, files_modified FROM memories
       WHERE kind = 'observation'
       AND forgotten = 0 AND is_latest = 1
       AND workspace IN (${roots.map(() => '?').join(',')})
       AND (files_read != '[]' OR files_modified != '[]')`
    ).all(...roots) as (Pick<MemoryRow, 'id' | 'files_read' | 'files_modified'> & { workspace: string })[];

    for (const row of rows) {
      const filesRead = this.parseJsonArray(row.files_read);
      const filesModified = this.parseJsonArray(row.files_modified);
      this.trackObservation(row.id, filesRead, filesModified, row.workspace);
    }

    const uniqueObservations = new Set<string>();
    for (const ids of this.fileToObservations.values()) {
      for (const id of ids) uniqueObservations.add(id);
    }
    log('[FileChangeTracker] Built reverse index: %d files → %d observations',
      this.fileToObservations.size, uniqueObservations.size);
  }

  /** Bump after a 5s per-path debounce, coalescing the burst an agent edit or save produces. */
  private onFileChanged(fsPath: string): void {
    const normalized = this.normalizePath(fsPath);
    if (!normalized) return;

    const observationIds = this.lookupObservations(fsPath, normalized);
    if (observationIds.size === 0) return;

    const existing = this.debounceTimers.get(normalized);
    if (existing) {
      clearTimeout(existing);
    }

    this.debounceTimers.set(normalized, setTimeout(() => {
      this.debounceTimers.delete(normalized);
      this.incrementStaleness([...observationIds]);
    }, CHANGE_DEBOUNCE_MS));
  }

  /**
   * A delete or rename is definitive — bump immediately. Clear any pending debounce first so the
   * immediate bump isn't followed by a redundant debounced one.
   */
  private onFileDeletedOrRenamed(fsPath: string): void {
    const normalized = this.normalizePath(fsPath);
    if (!normalized) return;

    const observationIds = this.lookupObservations(fsPath, normalized);
    if (observationIds.size === 0) return;

    const pending = this.debounceTimers.get(normalized);
    if (pending) {
      clearTimeout(pending);
      this.debounceTimers.delete(normalized);
    }

    this.incrementStaleness([...observationIds]);
  }

  /** Resolve an event path to observation ids, unioning full-path hits and suffix hits in its own folder. */
  private lookupObservations(fsPath: string, normalized: string): Set<string> {
    const result = new Set<string>();
    const full = this.fileToObservations.get(normalized);
    if (full) for (const id of full) result.add(id);

    const suffix = this.suffixKey(normalized);
    const folder = this.containingFolder(fsPath);
    if (suffix && folder !== null) {
      const suffixHit = this.suffixIndexByFolder.get(folder)?.get(suffix);
      if (suffixHit) for (const id of suffixHit) result.add(id);
    }
    return result;
  }

  /** The `folderKey` of the innermost open folder containing `fsPath`, so a nested folder wins over its parent. */
  private containingFolder(fsPath: string): string | null {
    let best: string | null = null;
    for (const root of this.workspaceRoots) {
      if (isWithinRoot(fsPath, root) && (best === null || root.length > best.length)) best = root;
    }
    return best === null ? null : folderKey(best);
  }

  /**
   * Batch-bump staleness for every touched observation in one queued IN-clause UPDATE. Routed
   * fire-and-forget through the write queue so it can't interleave mid-consolidation nor block the caller.
   */
  private incrementStaleness(ids: string[]): void {
    if (ids.length === 0) return;
    const db = this.db;
    void this.writeQueue.run(() => {
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(
        `UPDATE memories SET file_change_count = file_change_count + 1 WHERE id IN (${placeholders})`
      ).run(...ids);
    });
    log('[FileChangeTracker] Incremented staleness for %d observations', ids.length);
  }

  /**
   * Full-path index key: resolve relative stored paths against `workspace` (so `src/foo.ts` and an
   * absolute `<root>/src/foo.ts` collapse to one key), then forward-slash + lowercase. Event paths
   * from the watcher are absolute, so they never need a workspace.
   */
  private normalizePath(filePath: string, workspace?: string): string | null {
    if (!filePath) return null;
    let abs: string;
    if (path.isAbsolute(filePath)) abs = filePath;
    else if (workspace !== undefined) abs = path.resolve(workspace, filePath);
    else return null;
    return abs.replace(/\\/g, '/').toLowerCase();
  }

  /** Last 2 trailing segments of a normalized path, joined by '/'. Null if <2 segments. */
  private suffixKey(normalized: string): string | null {
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    return segments.slice(-2).join('/');
  }

  private parseJsonArray(json: string): string[] {
    try {
      const parsed = JSON.parse(json);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
