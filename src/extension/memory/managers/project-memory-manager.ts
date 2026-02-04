import * as crypto from 'crypto';
import type { MemoryEntry } from '@shared/types/memory';
import type { DatabaseInstance, MemoryRow } from '../types';
import { rowToEntry } from '../types';

export class ProjectMemoryManager {
  private db: DatabaseInstance;

  constructor(db: DatabaseInstance) {
    this.db = db;
  }

  add(workspace: string, content: string, tags: string[] = []): MemoryEntry {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO memories (id, tier, content, workspace, created_at, updated_at, tags)
      VALUES (?, 'project', ?, ?, ?, ?, ?)
    `).run(id, content, workspace, now, now, JSON.stringify(tags));
    return { id, tier: 'project', content, sessionId: null, workspace, createdAt: now, updatedAt: now, tags };
  }

  list(workspace: string): MemoryEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE tier = ? AND workspace = ? ORDER BY created_at DESC'
    ).all('project', workspace) as MemoryRow[];
    return rows.map(rowToEntry);
  }
}
