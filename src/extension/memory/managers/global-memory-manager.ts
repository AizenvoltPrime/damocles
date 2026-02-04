import * as crypto from 'crypto';
import type { MemoryEntry } from '@shared/types/memory';
import type { DatabaseInstance, MemoryRow } from '../types';
import { rowToEntry } from '../types';

export class GlobalMemoryManager {
  private db: DatabaseInstance;

  constructor(db: DatabaseInstance) {
    this.db = db;
  }

  add(content: string, tags: string[] = []): MemoryEntry {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO memories (id, tier, content, created_at, updated_at, tags)
      VALUES (?, 'global', ?, ?, ?, ?)
    `).run(id, content, now, now, JSON.stringify(tags));
    return { id, tier: 'global', content, sessionId: null, workspace: null, createdAt: now, updatedAt: now, tags };
  }

  list(): MemoryEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE tier = ? ORDER BY created_at DESC'
    ).all('global') as MemoryRow[];
    return rows.map(rowToEntry);
  }
}
