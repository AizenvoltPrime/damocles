import * as crypto from 'crypto';
import type { MemoryEntry } from '@shared/types/memory';
import type { DatabaseInstance, MemoryRow } from '../types';
import { rowToEntry } from '../types';

export class AutoSummaryManager {
  private db: DatabaseInstance;

  constructor(db: DatabaseInstance) {
    this.db = db;
  }

  capture(sessionId: string, workspace: string, summary: string): void {
    const now = Date.now();

    const existing = this.db.prepare(
      'SELECT id FROM memories WHERE tier = ? AND session_id = ?'
    ).get('auto-summary', sessionId) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(
        'UPDATE memories SET content = ?, updated_at = ? WHERE id = ?'
      ).run(summary, now, existing.id);
    } else {
      const id = crypto.randomUUID();
      this.db.prepare(`
        INSERT INTO memories (id, tier, content, session_id, workspace, created_at, updated_at)
        VALUES (?, 'auto-summary', ?, ?, ?, ?, ?)
      `).run(id, summary, sessionId, workspace, now, now);
    }

    const excess = this.db.prepare(`
      SELECT id FROM memories WHERE tier = ? AND workspace = ?
      ORDER BY created_at DESC LIMIT -1 OFFSET 3
    `).all('auto-summary', workspace) as { id: string }[];

    if (excess.length > 0) {
      const ids = excess.map(r => r.id);
      this.db.prepare(
        `DELETE FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`
      ).run(...ids);
    }
  }

  getLatest(workspace: string, limit: number = 3): MemoryEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE tier = ? AND workspace = ? ORDER BY created_at DESC LIMIT ?'
    ).all('auto-summary', workspace, limit) as MemoryRow[];
    return rows.map(rowToEntry);
  }

  deleteBySession(sessionId: string): void {
    this.db.prepare('DELETE FROM memories WHERE tier = ? AND session_id = ?').run('auto-summary', sessionId);
  }
}
