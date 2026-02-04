import * as crypto from 'crypto';
import type { MemoryEntry } from '@shared/types/memory';
import type { DatabaseInstance, MemoryRow } from '../types';
import { escapeLike, rowToEntry } from '../types';

export class NoteManager {
  private db: DatabaseInstance;

  constructor(db: DatabaseInstance) {
    this.db = db;
  }

  add(content: string, tags: string[] = []): MemoryEntry {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO memories (id, tier, content, created_at, updated_at, tags)
      VALUES (?, 'note', ?, ?, ?, ?)
    `).run(id, content, now, now, JSON.stringify(tags));
    return { id, tier: 'note', content, sessionId: null, workspace: null, createdAt: now, updatedAt: now, tags };
  }

  list(tags?: string[]): MemoryEntry[] {
    if (tags && tags.length > 0) {
      const clauses = tags.map(() => "tags LIKE ? ESCAPE '\\'");
      const rows = this.db.prepare(
        `SELECT * FROM memories WHERE tier = ? AND (${clauses.join(' OR ')}) ORDER BY created_at DESC`
      ).all('note', ...tags.map(t => `%${escapeLike(JSON.stringify(t))}%`)) as MemoryRow[];
      return rows.map(rowToEntry);
    }
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE tier = ? ORDER BY created_at DESC'
    ).all('note') as MemoryRow[];
    return rows.map(rowToEntry);
  }
}
