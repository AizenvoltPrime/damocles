import type { MemoryEntry, MemoryTier, ObservationType, SearchQuery, SearchResult } from '@shared/types/memory';
import { log } from '../../logger';
import type { DatabaseInstance, MemoryRow } from '../types';
import { escapeLike, rowToEntry } from '../types';

export class SearchManager {
  private db: DatabaseInstance;

  constructor(db: DatabaseInstance) {
    this.db = db;
  }

  search(query: SearchQuery): SearchResult[] {
    const limit = query.limit ?? 20;

    if (query.query) {
      return this.ftsSearch(query, limit);
    }

    return this.filteredSearch(query, limit);
  }

  private ftsSearch(query: SearchQuery, limit: number): SearchResult[] {
    const tokens = query.query!.trim().split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) return this.filteredSearch(query, limit);
    const ftsQuery = tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');

    let sql = `
      SELECT m.*, fts.rank
      FROM memories_fts fts
      JOIN memories m ON m.rowid = fts.rowid
      WHERE memories_fts MATCH ?
    `;
    const params: unknown[] = [ftsQuery];

    if (query.tiers && query.tiers.length > 0) {
      sql += ` AND m.tier IN (${query.tiers.map(() => '?').join(',')})`;
      params.push(...query.tiers);
    }

    if (query.types && query.types.length > 0) {
      sql += ` AND m.observation_type IN (${query.types.map(() => '?').join(',')})`;
      params.push(...query.types);
    }

    if (query.since) {
      sql += ' AND m.created_at >= ?';
      params.push(query.since);
    }
    if (query.until) {
      sql += ' AND m.created_at <= ?';
      params.push(query.until);
    }

    sql += ' ORDER BY fts.rank LIMIT ?';
    params.push(limit);

    try {
      const rows = this.db.prepare(sql).all(...params) as (MemoryRow & { rank: number })[];
      return rows.map((row, i) => ({
        id: row.id,
        tier: row.tier as MemoryTier,
        title: row.title,
        snippet: row.content.slice(0, 50),
        rank: i + 1,
        timestamp: row.created_at,
        ...(row.observation_type ? { observationType: row.observation_type as ObservationType } : {}),
      }));
    } catch (err) {
      log(`[Memory] FTS5 query failed, falling back to filtered search: ${err}`);
      return this.filteredSearch(query, limit);
    }
  }

  private filteredSearch(query: SearchQuery, limit: number): SearchResult[] {
    let sql = 'SELECT * FROM memories WHERE 1=1';
    const params: unknown[] = [];

    if (query.tiers && query.tiers.length > 0) {
      sql += ` AND tier IN (${query.tiers.map(() => '?').join(',')})`;
      params.push(...query.tiers);
    }
    if (query.types && query.types.length > 0) {
      sql += ` AND observation_type IN (${query.types.map(() => '?').join(',')})`;
      params.push(...query.types);
    }
    if (query.files && query.files.length > 0) {
      const fileClauses = query.files.map(() => "(files_read LIKE ? ESCAPE '\\' OR files_modified LIKE ? ESCAPE '\\')");
      sql += ` AND (${fileClauses.join(' OR ')})`;
      for (const f of query.files) {
        const pattern = `%${escapeLike(f)}%`;
        params.push(pattern, pattern);
      }
    }
    if (query.since) {
      sql += ' AND created_at >= ?';
      params.push(query.since);
    }
    if (query.until) {
      sql += ' AND created_at <= ?';
      params.push(query.until);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map((row, i) => ({
      id: row.id,
      tier: row.tier as MemoryTier,
      title: row.title,
      snippet: row.content.slice(0, 50),
      rank: i + 1,
      timestamp: row.created_at,
      ...(row.observation_type ? { observationType: row.observation_type as ObservationType } : {}),
    }));
  }

  getDetails(ids: string[]): MemoryEntry[] {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(
      `UPDATE memories SET access_count = access_count + 1 WHERE id IN (${placeholders})`
    ).run(...ids);

    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE id IN (${placeholders})`
    ).all(...ids) as MemoryRow[];
    return rows.map(rowToEntry);
  }

}
