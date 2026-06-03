import * as crypto from 'crypto';
import type { MemoryEntry } from '@shared/types/memory';
import type { DatabaseInstance } from '../types';
import { normalizedContentHash } from '../types';

export class GlobalMemoryManager {
  private db: DatabaseInstance;

  constructor(db: DatabaseInstance) {
    this.db = db;
  }

  add(content: string, tags: string[] = []): MemoryEntry {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO memories (id, scope, kind, content, content_hash, root_id, created_at, updated_at, tags)
      VALUES (?, 'global', 'fact', ?, ?, ?, ?, ?, ?)
    `).run(id, content, normalizedContentHash(content), id, now, now, JSON.stringify(tags));
    return { id, tier: 'global', kind: 'fact', scope: 'global', content, sessionId: null, workspace: null, createdAt: now, updatedAt: now, tags };
  }
}
