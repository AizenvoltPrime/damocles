import * as crypto from 'crypto';
import type { MemoryEntry, ObservationInput } from '@shared/types/memory';
import type { DatabaseInstance, MemoryRow } from '../types';
import { rowToEntry } from '../types';

export class ObservationManager {
  private db: DatabaseInstance;

  constructor(db: DatabaseInstance) {
    this.db = db;
  }

  addRichObservation(sessionId: string, workspace: string, input: ObservationInput): MemoryEntry {
    const id = crypto.randomUUID();
    const now = Date.now();
    const title = input.title.slice(0, 80);
    this.db.prepare(`
      INSERT INTO memories (id, tier, content, session_id, workspace, created_at, updated_at,
        observation_type, title, facts, observation_tags, files_read, files_modified)
      VALUES (?, 'observation', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.content, sessionId, workspace, now, now,
      input.type, title,
      JSON.stringify(input.facts),
      JSON.stringify(input.observationTags ?? []),
      JSON.stringify(input.filesRead ?? []),
      JSON.stringify(input.filesModified ?? [])
    );
    return {
      id, tier: 'observation', content: input.content, sessionId, workspace,
      createdAt: now, updatedAt: now, tags: [],
      observationType: input.type, title,
      facts: input.facts,
      ...(input.observationTags ? { observationTags: input.observationTags } : {}),
      ...(input.filesRead ? { filesRead: input.filesRead } : {}),
      ...(input.filesModified ? { filesModified: input.filesModified } : {}),
    };
  }

  getRecentForWorkspace(workspace: string, limit: number = 10): MemoryEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE tier = ? AND workspace = ? ORDER BY created_at DESC LIMIT ?'
    ).all('observation', workspace, limit) as MemoryRow[];
    return rows.map(rowToEntry);
  }

}
