import * as crypto from 'crypto';
import type { MemoryEntry } from '@shared/types/memory';
import type { DatabaseInstance, MemoryRow } from '../types';
import { rowToEntry } from '../types';

export class SessionMemoryManager {
  private db: DatabaseInstance;

  constructor(db: DatabaseInstance) {
    this.db = db;
  }

  add(sessionId: string, content: string, tags: string[] = []): MemoryEntry {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO memories (id, tier, content, session_id, created_at, updated_at, tags)
      VALUES (?, 'session', ?, ?, ?, ?, ?)
    `).run(id, content, sessionId, now, now, JSON.stringify(tags));
    return { id, tier: 'session', content, sessionId, workspace: null, createdAt: now, updatedAt: now, tags };
  }

  list(sessionId: string): MemoryEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE tier = ? AND session_id = ? ORDER BY created_at DESC'
    ).all('session', sessionId) as MemoryRow[];
    return rows.map(rowToEntry);
  }

  deleteBySession(sessionId: string): void {
    this.db.prepare('DELETE FROM memories WHERE tier = ? AND session_id = ?').run('session', sessionId);
  }
}
