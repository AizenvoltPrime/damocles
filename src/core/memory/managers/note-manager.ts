import * as crypto from 'crypto';
import type { MemoryEntry } from '@shared/types/memory';
import type { DatabaseInstance, MemoryRow } from '../types';
import { escapeLike, normalizedContentHash, rowToEntry } from '../types';

export class NoteManager {
  private db: DatabaseInstance;

  constructor(db: DatabaseInstance) {
    this.db = db;
  }

  add(content: string, tags: string[] = []): MemoryEntry {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO memories (id, scope, kind, content, content_hash, root_id, created_at, updated_at, tags)
      VALUES (?, 'global', 'note', ?, ?, ?, ?, ?, ?)
    `).run(id, content, normalizedContentHash(content), id, now, now, JSON.stringify(tags));
    return { id, tier: 'note', kind: 'note', scope: 'global', content, sessionId: null, workspace: null, createdAt: now, updatedAt: now, tags };
  }

  list(tags?: string[]): MemoryEntry[] {
    if (tags && tags.length > 0) {
      const clauses = tags.map(() => "tags LIKE ? ESCAPE '\\'");
      const rows = this.db.prepare(
        `SELECT * FROM memories WHERE kind = 'note' AND (${clauses.join(' OR ')}) ORDER BY created_at DESC`
      ).all(...tags.map(t => `%${escapeLike(JSON.stringify(t))}%`)) as MemoryRow[];
      return rows.map(rowToEntry);
    }
    const rows = this.db.prepare(
      "SELECT * FROM memories WHERE kind = 'note' ORDER BY created_at DESC"
    ).all() as MemoryRow[];
    return rows.map(rowToEntry);
  }
}
