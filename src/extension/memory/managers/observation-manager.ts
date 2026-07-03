import * as crypto from 'crypto';
import type { MemoryEntry, ObservationInput } from '@shared/types/memory';
import type { ObservationCursor } from '@shared/types/memory';
import { log } from '../../logger';
import type { DatabaseInstance, MemoryRow } from '../types';
import { normalizedContentHash, rowToEntry } from '../types';

/** Server-side content bound; the prose-JSON fallback bypasses schema validation, so clamp here too to avoid a megabyte FTS row. */
const MAX_CONTENT_CHARS = 20000;

/**
 * Forward-slash normalize stored file paths so they're slash-consistent regardless of capture OS, so
 * a stored path and a file-change event path resolve to the same key. Case is preserved.
 */
function forwardSlash(files: string[]): string[] {
  return files.map((f) => f.replace(/\\/g, '/'));
}

export class ObservationManager {
  private db: DatabaseInstance;

  constructor(db: DatabaseInstance) {
    this.db = db;
    this.normalizeStoredFilePaths();
  }

  addRichObservation(sessionId: string, workspace: string, input: ObservationInput): MemoryEntry {
    const id = crypto.randomUUID();
    const now = Date.now();
    const title = input.title.slice(0, 80);
    const content = input.content.slice(0, MAX_CONTENT_CHARS);
    const filesRead = forwardSlash(input.filesRead ?? []);
    const filesModified = forwardSlash(input.filesModified ?? []);
    this.db.prepare(`
      INSERT INTO memories (id, scope, kind, content, content_hash, root_id, session_id, workspace, created_at, updated_at,
        observation_type, title, facts, observation_tags, files_read, files_modified)
      VALUES (?, 'project', 'observation', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, content, normalizedContentHash(content), id, sessionId, workspace, now, now,
      input.type, title,
      JSON.stringify(input.facts),
      JSON.stringify(input.observationTags ?? []),
      JSON.stringify(filesRead),
      JSON.stringify(filesModified)
    );
    return {
      id, tier: 'observation', kind: 'observation', scope: 'project', content, sessionId, workspace,
      createdAt: now, updatedAt: now, tags: [],
      observationType: input.type, title,
      facts: input.facts,
      ...(input.observationTags ? { observationTags: input.observationTags } : {}),
      ...(input.filesRead ? { filesRead } : {}),
      ...(input.filesModified ? { filesModified } : {}),
    };
  }

  /**
   * Idempotent sweep rewriting legacy rows whose stored `files_*` JSON contains backslashes to
   * forward slashes. The `GLOB '*\*'` guard (backslash is literal in GLOB) selects only rows that
   * contain one, so once clean this is a pure no-op — safe at every init. Runs in one transaction; a
   * row whose JSON fails to parse is logged and skipped so one bad row can't abort the sweep.
   */
  private normalizeStoredFilePaths(): void {
    const rows = this.db.prepare(
      "SELECT id, files_read, files_modified FROM memories WHERE files_read GLOB '*\\*' OR files_modified GLOB '*\\*'"
    ).all() as Pick<MemoryRow, 'id' | 'files_read' | 'files_modified'>[];
    if (rows.length === 0) return;

    const rewritten: Array<{ id: string; filesRead: string; filesModified: string }> = [];
    for (const row of rows) {
      const filesRead = this.normalizeJsonArray(row.id, 'files_read', row.files_read);
      const filesModified = this.normalizeJsonArray(row.id, 'files_modified', row.files_modified);
      if (filesRead === null && filesModified === null) continue;
      rewritten.push({
        id: row.id,
        filesRead: filesRead ?? row.files_read,
        filesModified: filesModified ?? row.files_modified,
      });
    }
    if (rewritten.length === 0) return;

    const update = this.db.prepare(
      'UPDATE memories SET files_read = ?, files_modified = ? WHERE id = ?'
    );
    this.db.transaction(() => {
      for (const r of rewritten) update.run(r.filesRead, r.filesModified, r.id);
    });
    log('[ObservationManager] Normalized backslash file paths in %d observation rows', rewritten.length);
  }

  /**
   * Parse, forward-slash normalize, and re-stringify a stored path array — or `null` when there are
   * no backslashes to rewrite, or on a parse failure (leave the malformed value untouched).
   */
  private normalizeJsonArray(id: string, column: string, json: string): string | null {
    if (!json.includes('\\')) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      log('[ObservationManager] Skipped un-parseable %s JSON on observation %s: %s', column, id, String(err));
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    return JSON.stringify(forwardSlash(parsed as string[]));
  }

  /**
   * Keyset page of observations, newest first. Paging on the (created_at, id) tuple keeps a stable
   * window even when new observations land between page fetches — an offset would shift and skip/dupe.
   */
  getRecentForWorkspace(workspace: string, limit: number = 10, cursor?: ObservationCursor): MemoryEntry[] {
    const rows = cursor
      ? this.db.prepare(
          `SELECT * FROM memories WHERE kind = 'observation' AND workspace = ?
             AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`
        ).all(workspace, cursor.createdAt, cursor.createdAt, cursor.id, limit) as MemoryRow[]
      : this.db.prepare(
          `SELECT * FROM memories WHERE kind = 'observation' AND workspace = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`
        ).all(workspace, limit) as MemoryRow[];
    return rows.map(rowToEntry);
  }

  countForWorkspace(workspace: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM memories WHERE kind = 'observation' AND workspace = ?"
    ).get(workspace) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

}
