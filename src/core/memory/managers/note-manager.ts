import * as crypto from 'crypto';
import type { MemoryEntry } from '@shared/types/memory';
import type { DatabaseInstance, MemoryRow } from '../types';
import { escapeLike, normalizedContentHash, rowToEntry } from '../types';
import { carriesAnyTag } from '../../../shared/remote-user';

export class NoteManager {
  private db: DatabaseInstance;

  constructor(db: DatabaseInstance) {
    this.db = db;
  }

  add(content: string, tags: string[] = [], id: string = crypto.randomUUID()): MemoryEntry {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO memories (id, scope, kind, content, content_hash, root_id, created_at, updated_at, tags)
      VALUES (?, 'global', 'note', ?, ?, ?, ?, ?, ?)
    `).run(id, content, normalizedContentHash(content), id, now, now, JSON.stringify(tags));
    return { id, tier: 'note', kind: 'note', scope: 'global', content, sessionId: null, workspace: null, createdAt: now, updatedAt: now, tags };
  }

  list(tags?: readonly string[]): MemoryEntry[] {
    const tagged = anyTagCondition(tags);
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE kind = 'note'${tagged.sql} ORDER BY created_at DESC, id DESC`
    ).all(...tagged.params) as MemoryRow[];
    const entries = rows.map(rowToEntry);
    return tags && tags.length > 0 ? entries.filter((entry) => carriesAnyTag(entry.tags, tags)) : entries;
  }
}

/**
 * The notes list's tag prefilter: a LIKE over a row's tags JSON (ASCII letters match in either case), which also matches
 * inside another tag's text, so `carriesAnyTag` decides each row it keeps; no tags, every row.
 */
export function anyTagCondition(tags: readonly string[] | undefined): { readonly sql: string; readonly params: string[] } {
  if (!tags || tags.length === 0) return { sql: '', params: [] };
  return {
    sql: ` AND (${tags.map(() => "tags LIKE ? ESCAPE '\\'").join(' OR ')})`,
    params: tags.map((tag) => `%${escapeLike(JSON.stringify(tag))}%`),
  };
}
