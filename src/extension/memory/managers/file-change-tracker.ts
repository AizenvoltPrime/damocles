import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../../logger';
import type { DatabaseInstance, MemoryRow } from '../types';
import type { MemoryWriteQueue } from '../write-queue';

const CHANGE_DEBOUNCE_MS = 5000;

export class FileChangeTracker {
  private db: DatabaseInstance;
  private writeQueue: MemoryWriteQueue;
  private workspaceRoot: string;
  // Full-path index: normalized absolute forward-slash lowercase path → observation ids.
  private fileToObservations = new Map<string, Set<string>>();
  // Suffix fallback index (last-2-segment key): lets an event path whose full normalized form misses
  // still match by trailing suffix. Trade-off: can over-mark a same-suffix file in another directory,
  // deliberately preferred over never marking stale.
  private fileToObservationsBySuffix = new Map<string, Set<string>>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposables: vscode.Disposable[] = [];

  constructor(db: DatabaseInstance, writeQueue: MemoryWriteQueue, workspaceRoot: string) {
    this.db = db;
    this.writeQueue = writeQueue;
    this.workspaceRoot = workspaceRoot;
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

  trackObservation(id: string, filesRead: string[], filesModified: string[]): void {
    const allFiles = [...filesRead, ...filesModified];
    for (const file of allFiles) {
      const normalized = this.normalizePath(file);
      if (!normalized) continue;
      this.addToIndex(this.fileToObservations, normalized, id);
      const suffix = this.suffixKey(normalized);
      if (suffix) this.addToIndex(this.fileToObservationsBySuffix, suffix, id);
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
    for (const [key, ids] of this.fileToObservationsBySuffix) {
      ids.delete(id);
      if (ids.size === 0) this.fileToObservationsBySuffix.delete(key);
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
    // Scope to this workspace: suffix matching means a file edited here would otherwise bump staleness
    // on same-named files' observations in unrelated workspaces.
    const rows = this.db.prepare(
      `SELECT id, files_read, files_modified FROM memories
       WHERE kind = 'observation'
       AND forgotten = 0 AND is_latest = 1
       AND workspace = ?
       AND (files_read != '[]' OR files_modified != '[]')`
    ).all(this.workspaceRoot) as Pick<MemoryRow, 'id' | 'files_read' | 'files_modified'>[];

    for (const row of rows) {
      const filesRead = this.parseJsonArray(row.files_read);
      const filesModified = this.parseJsonArray(row.files_modified);
      this.trackObservation(row.id, filesRead, filesModified);
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

    const observationIds = this.lookupObservations(normalized);
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

    const observationIds = this.lookupObservations(normalized);
    if (observationIds.size === 0) return;

    const pending = this.debounceTimers.get(normalized);
    if (pending) {
      clearTimeout(pending);
      this.debounceTimers.delete(normalized);
    }

    this.incrementStaleness([...observationIds]);
  }

  /** Resolve an event path to observation ids, unioning full-path and suffix-index hits. */
  private lookupObservations(normalized: string): Set<string> {
    const result = new Set<string>();
    const full = this.fileToObservations.get(normalized);
    if (full) for (const id of full) result.add(id);

    const suffix = this.suffixKey(normalized);
    if (suffix) {
      const suffixHit = this.fileToObservationsBySuffix.get(suffix);
      if (suffixHit) for (const id of suffixHit) result.add(id);
    }
    return result;
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
   * Full-path index key: resolve relative stored paths against the workspace root (so `src/foo.ts`
   * and an absolute `<root>/src/foo.ts` collapse to one key), then forward-slash + lowercase.
   */
  private normalizePath(filePath: string): string | null {
    if (!filePath) return null;
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(this.workspaceRoot, filePath);
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
