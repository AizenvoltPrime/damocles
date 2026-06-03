import * as crypto from 'crypto';
import type { MemoryEntry } from '@shared/types/memory';
import type { DatabaseInstance } from '../types';
import { normalizedContentHash } from '../types';

export class SessionMemoryManager {
  private db: DatabaseInstance;

  constructor(db: DatabaseInstance) {
    this.db = db;
  }

  add(sessionId: string, content: string, tags: string[] = []): MemoryEntry {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO memories (id, scope, kind, content, content_hash, root_id, session_id, created_at, updated_at, tags)
      VALUES (?, 'session', 'fact', ?, ?, ?, ?, ?, ?, ?)
    `).run(id, content, normalizedContentHash(content), id, sessionId, now, now, JSON.stringify(tags));
    return { id, tier: 'session', kind: 'fact', scope: 'session', content, sessionId, workspace: null, createdAt: now, updatedAt: now, tags };
  }

  deleteBySession(sessionId: string): void {
    this.db.prepare("DELETE FROM memories WHERE scope = 'session' AND session_id = ?").run(sessionId);
  }
}
