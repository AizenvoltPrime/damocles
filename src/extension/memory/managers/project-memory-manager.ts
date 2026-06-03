import * as crypto from 'crypto';
import type { MemoryEntry } from '@shared/types/memory';
import type { DatabaseInstance } from '../types';
import { normalizedContentHash } from '../types';

export class ProjectMemoryManager {
  private db: DatabaseInstance;

  constructor(db: DatabaseInstance) {
    this.db = db;
  }

  add(workspace: string, content: string, tags: string[] = []): MemoryEntry {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO memories (id, scope, kind, content, content_hash, root_id, workspace, created_at, updated_at, tags)
      VALUES (?, 'project', 'fact', ?, ?, ?, ?, ?, ?, ?)
    `).run(id, content, normalizedContentHash(content), id, workspace, now, now, JSON.stringify(tags));
    return { id, tier: 'project', kind: 'fact', scope: 'project', content, sessionId: null, workspace, createdAt: now, updatedAt: now, tags };
  }
}
