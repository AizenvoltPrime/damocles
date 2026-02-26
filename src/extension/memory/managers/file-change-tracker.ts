import * as vscode from 'vscode';
import { log } from '../../logger';
import type { DatabaseInstance, MemoryRow } from '../types';

export class FileChangeTracker {
  private db: DatabaseInstance;
  private fileToObservations = new Map<string, Set<string>>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposable: vscode.Disposable | null = null;

  constructor(db: DatabaseInstance) {
    this.db = db;
  }

  initialize(): void {
    this.buildReverseIndex();
    this.disposable = vscode.workspace.onDidSaveTextDocument((doc) => {
      this.onFileSaved(doc.uri.fsPath);
    });
  }

  dispose(): void {
    this.disposable?.dispose();
    this.disposable = null;
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
      let set = this.fileToObservations.get(normalized);
      if (!set) {
        set = new Set();
        this.fileToObservations.set(normalized, set);
      }
      set.add(id);
    }
  }

  resetStaleness(id: string): boolean {
    const result = this.db.prepare(
      'UPDATE memories SET file_change_count = 0 WHERE id = ?'
    ).run(id);
    return result.changes > 0;
  }

  removeObservation(id: string): void {
    for (const [path, ids] of this.fileToObservations) {
      ids.delete(id);
      if (ids.size === 0) this.fileToObservations.delete(path);
    }
  }

  private buildReverseIndex(): void {
    const rows = this.db.prepare(
      `SELECT id, files_read, files_modified FROM memories
       WHERE tier = 'observation'
       AND (files_read != '[]' OR files_modified != '[]')`
    ).all() as Pick<MemoryRow, 'id' | 'files_read' | 'files_modified'>[];

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

  private onFileSaved(fsPath: string): void {
    const normalized = this.normalizePath(fsPath);
    if (!normalized) return;

    const observationIds = this.fileToObservations.get(normalized);
    if (!observationIds || observationIds.size === 0) return;

    const existing = this.debounceTimers.get(normalized);
    if (existing) {
      clearTimeout(existing);
    }

    this.debounceTimers.set(normalized, setTimeout(() => {
      this.debounceTimers.delete(normalized);
      this.incrementStaleness(observationIds);
    }, 5000));
  }

  private incrementStaleness(observationIds: Set<string>): void {
    const stmt = this.db.prepare(
      'UPDATE memories SET file_change_count = file_change_count + 1 WHERE id = ?'
    );
    for (const id of observationIds) {
      stmt.run(id);
    }
    log('[FileChangeTracker] Incremented staleness for %d observations', observationIds.size);
  }

  private normalizePath(filePath: string): string | null {
    if (!filePath) return null;
    return filePath.replace(/\\/g, '/').toLowerCase();
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
