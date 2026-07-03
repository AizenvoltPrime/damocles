import * as crypto from 'crypto';
import type { DatabaseInstance, MemoryRow } from '../types';
import { normalizedContentHash } from '../types';
import type { MemoryWriteQueue } from '../write-queue';
import type { MemorySubCallRunner } from '../subcall-runner';
import { buildFtsMatchQuery } from '../text-tokenize';

/** Directed relationship kinds stored in `memory_edges`. */
export type EdgeKind = 'UPDATES' | 'EXTENDS' | 'DERIVES' | 'SUPERSEDES';

interface EdgeRow {
  id: string;
  kind: string;
  source_id: string;
  target_id: string;
  extra: string;
  created_at: number;
}

const MAX_MATCH_TOKENS = 12;
const MAX_CONFLICT_CANDIDATES = 5;
const CONFLICT_SWEEP_LIMIT = 5;

/** A conflict candidate row plus its SQLite `rowid`, for the same-created_at tiebreak. */
type ConflictCandidate = MemoryRow & { _rowid: number };

/**
 * Restricts conflict candidates to the same isolation domain: project memories are workspace-isolated,
 * session memories session-isolated (session A can never supersede a fact in session B), global skips
 * the gate. Uses null-safe `IS` so the match never bleeds across domains when the column is NULL.
 */
function scopeGate(row: MemoryRow): { clause: string; params: unknown[] } {
  if (row.scope === 'project') return { clause: ' AND m.workspace IS ?', params: [row.workspace] };
  if (row.scope === 'session') return { clause: ' AND m.session_id IS ?', params: [row.session_id] };
  return { clause: '', params: [] };
}

const CONFLICT_SYSTEM_PROMPT =
  'You decide if statement NEW contradicts statement OLD. Two statements contradict if ' +
  'they cannot both be true at the same time about the same subject. Reply via the schema.';

const CONFLICT_SCHEMA = {
  type: 'object',
  properties: { contradicts: { type: 'boolean' } },
  required: ['contradicts'],
  additionalProperties: false,
} as const;

/**
 * Owns the memory fact graph: edge primitives, version-lineage maintenance, and LLM-judged conflict
 * resolution. Candidate selection and the LLM verdict run outside the write queue; every invariant
 * re-check plus its dependent mutations run inside one synchronous {@link MemoryWriteQueue.run}
 * callback so concurrent operations never interleave a read-modify-write.
 */
export class FactGraphManager {
  private db: DatabaseInstance;
  private writeQueue: MemoryWriteQueue;
  private runner: MemorySubCallRunner;

  constructor(db: DatabaseInstance, writeQueue: MemoryWriteQueue, runner: MemorySubCallRunner) {
    this.db = db;
    this.writeQueue = writeQueue;
    this.runner = runner;
  }

  /** Insert a directed edge. Idempotent on `(kind, source_id, target_id)` — repeated calls add no duplicate. */
  addEdge(kind: EdgeKind, sourceId: string, targetId: string, extra?: Record<string, unknown>): void {
    if (this.hasEdge(kind, sourceId, targetId)) return;
    this.db.prepare(
      'INSERT INTO memory_edges (id, kind, source_id, target_id, extra, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(crypto.randomUUID(), kind, sourceId, targetId, JSON.stringify(extra ?? {}), Date.now());
  }

  getEdgesBySource(id: string): EdgeRow[] {
    return this.db.prepare('SELECT * FROM memory_edges WHERE source_id = ?').all(id) as EdgeRow[];
  }

  getEdgesByTarget(id: string): EdgeRow[] {
    return this.db.prepare('SELECT * FROM memory_edges WHERE target_id = ?').all(id) as EdgeRow[];
  }

  getEdgesAmong(ids: string[]): EdgeRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT * FROM memory_edges WHERE source_id IN (${placeholders}) AND target_id IN (${placeholders})`,
    ).all(...ids, ...ids) as EdgeRow[];
  }

  /** True when the edge already exists. The dedup gate. */
  hasEdge(kind: EdgeKind, sourceId: string, targetId: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM memory_edges WHERE kind = ? AND source_id = ? AND target_id = ? LIMIT 1',
    ).get(kind, sourceId, targetId);
    return row !== undefined && row !== null;
  }

  private getRow(id: string): MemoryRow | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ?? null;
  }

  private selectConflictCandidates(newRow: MemoryRow): ConflictCandidate[] {
    const match = buildFtsMatchQuery(newRow.content, MAX_MATCH_TOKENS);
    if (!match) return [];
    const gate = scopeGate(newRow);
    return this.db.prepare(
      `SELECT m.*, m.rowid AS _rowid FROM memories_fts fts
         JOIN memories m ON m.rowid = fts.rowid
        WHERE memories_fts MATCH ?
          AND m.is_latest = 1 AND m.forgotten = 0
          AND m.scope = ? AND m.kind = ? AND m.id != ?${gate.clause}
        ORDER BY fts.rank
        LIMIT ?`,
    ).all(match, newRow.scope, newRow.kind, newRow.id, ...gate.params, MAX_CONFLICT_CANDIDATES) as ConflictCandidate[];
  }

  /** The `rowid` backing `id`, for the same-created_at tiebreak. Null when the row is gone. */
  private getRowid(id: string): number | null {
    const row = this.db.prepare('SELECT rowid AS _rowid FROM memories WHERE id = ?').get(id) as
      | { _rowid: number }
      | undefined;
    return row?._rowid ?? null;
  }

  /**
   * `a` is newer than `b` when its `created_at` is greater, or on an equal millisecond when its rowid
   * is higher (inserted later). A missing rowid can never win, so a stale candidate never supersedes.
   */
  private isNewer(aCreatedAt: number, aRowid: number | null, bCreatedAt: number, bRowid: number): boolean {
    if (aCreatedAt > bCreatedAt) return true;
    if (aCreatedAt < bCreatedAt) return false;
    return aRowid !== null && aRowid > bRowid;
  }

  /**
   * Asks the LLM whether NEW contradicts the candidate. Three-valued: `true`, `false`, or `null`
   * (judge outage). The null case is load-bearing: a transient outage must stay distinct from a
   * definite "no" so the caller can defer and re-check later — never coerce it to false.
   */
  private async judgeContradiction(newRow: MemoryRow, candidate: MemoryRow): Promise<boolean | null> {
    const result = await this.runner.run<{ contradicts: boolean }>({
      purpose: 'merge',
      systemPrompt: CONFLICT_SYSTEM_PROMPT,
      prompt: `NEW: ${newRow.content}\nOLD: ${candidate.content}`,
      schema: CONFLICT_SCHEMA,
    });
    if (result.value === null) return null;
    return result.value.contradicts === true;
  }

  /**
   * Resolves conflicts for a freshly written fact: FTS-selects up to 5 latest, non-forgotten
   * same-scope/kind candidates, asks the LLM which ones the new fact contradicts, then under the
   * write lock joins the new fact to a SINGLE canonical lineage — the oldest contradicted fact's
   * root — as its next version (`UPDATES` edge), and demotes every other contradicted fact with a
   * `SUPERSEDES` edge without re-rooting the new fact.
   *
   * Joining one lineage keeps the version chain coherent when a fact contradicts several older facts
   * from distinct roots: the new fact is the sole `is_latest=1` survivor, its version is bumped
   * exactly once, and every superseded root stays reachable rather than orphaned. Idempotent.
   */
  async resolveConflict(newRow: MemoryRow): Promise<{ superseded: string[] }> {
    const candidates = this.selectConflictCandidates(newRow);

    // A null verdict is deferred, never treated as "no contradiction" — it flags the row for a re-check.
    let sawNullVerdict = false;
    const contradicting: ConflictCandidate[] = [];
    for (const candidate of candidates) {
      const verdict = await this.judgeContradiction(newRow, candidate);
      if (verdict === null) {
        sawNullVerdict = true;
        continue;
      }
      if (verdict) contradicting.push(candidate);
    }

    // Common-path exit: nothing to supersede, the pass was fully definite, and no flag to clear.
    if (contradicting.length === 0 && !sawNullVerdict && newRow.needs_conflict_check === 0) {
      return { superseded: [] };
    }

    return this.writeQueue.run(() => {
      // The judging window ran outside the lock (up to 5×45s). Re-read newRow: a racing edit/forget
      // may have demoted it, and blindly re-marking is_latest=1 below would resurrect a co-latest head.
      const live = this.getRow(newRow.id);
      if (!live || live.is_latest !== 1 || live.forgotten !== 0) return { superseded: [] };

      // Defer on any outage this pass; clear only on a fully-definite pass.
      if (sawNullVerdict) {
        this.db.prepare('UPDATE memories SET needs_conflict_check = 1 WHERE id = ?').run(newRow.id);
        newRow.needs_conflict_check = 1;
      } else {
        this.db.prepare('UPDATE memories SET needs_conflict_check = 0 WHERE id = ?').run(newRow.id);
        newRow.needs_conflict_check = 0;
      }

      if (contradicting.length === 0) return { superseded: [] };

      const newRowid = this.getRowid(newRow.id);
      const toSupersede: MemoryRow[] = [];
      for (const old of contradicting) {
        if (this.hasEdge('UPDATES', newRow.id, old.id) || this.hasEdge('SUPERSEDES', newRow.id, old.id)) continue;
        if (!this.isNewer(newRow.created_at, newRowid, old.created_at, old._rowid)) continue;
        if (newRow.parent_id === old.id) continue;

        const fresh = this.getRow(old.id);
        if (!fresh || fresh.is_latest !== 1) continue;
        toSupersede.push(fresh);
      }
      toSupersede.sort((a, b) => a.created_at - b.created_at);
      const canonical = toSupersede[0];
      if (!canonical) return { superseded: [] };
      const crossLineage = toSupersede.slice(1);
      const rootId = canonical.root_id ?? canonical.id;
      const nextVersion = canonical.version + 1;

      this.db.prepare(
        'UPDATE memories SET parent_id = ?, root_id = ?, version = ?, is_latest = 1 WHERE id = ?',
      ).run(canonical.id, rootId, nextVersion, newRow.id);
      this.db.prepare('UPDATE memories SET is_latest = 0 WHERE id = ?').run(canonical.id);
      this.addEdge('UPDATES', newRow.id, canonical.id);

      newRow.parent_id = canonical.id;
      newRow.root_id = rootId;
      newRow.version = nextVersion;
      newRow.is_latest = 1;

      const superseded: string[] = [canonical.id];
      for (const other of crossLineage) {
        this.db.prepare('UPDATE memories SET is_latest = 0 WHERE id = ?').run(other.id);
        this.addEdge('SUPERSEDES', newRow.id, other.id);
        superseded.push(other.id);
      }

      return { superseded };
    });
  }

  /**
   * Maintenance re-check for facts deferred by a judge outage. Selects up to `limit` latest,
   * non-forgotten rows flagged `needs_conflict_check = 1` and re-runs {@link resolveConflict} on
   * each: a now-definite verdict clears the flag; a still-null verdict leaves it flagged. The
   * per-pass cap bounds LLM fan-out so a prolonged outage cannot blow the maintenance budget.
   * Returns the number of flagged rows processed.
   */
  async sweepConflictChecks(limit: number = CONFLICT_SWEEP_LIMIT): Promise<number> {
    const rows = this.db.prepare(
      `SELECT * FROM memories
        WHERE needs_conflict_check = 1 AND is_latest = 1 AND forgotten = 0
        ORDER BY updated_at ASC
        LIMIT ?`,
    ).all(limit) as MemoryRow[];

    for (const row of rows) {
      await this.resolveConflict(row);
    }
    return rows.length;
  }

  /**
   * Applies a user edit as a NEW version rather than an in-place mutation, so it shows in
   * {@link getVersionHistory}. When `tags` is undefined the old row's tags are kept (an edit that
   * omits tags never wipes them); identity/weight columns (incl. source_count) carry over so the
   * fact's evidential weight persists. Adds an `UPDATES` edge new→old and demotes the old row.
   * Returns the new row id.
   */
  editAsNewVersion(oldRow: MemoryRow, content: string, tags: string[] | undefined): Promise<string> {
    return this.writeQueue.run(() => {
      const now = Date.now();
      const newId = crypto.randomUUID();
      const newHash = normalizedContentHash(content);
      const resolvedTags = tags === undefined ? oldRow.tags : JSON.stringify(tags);

      this.db.prepare(
        `INSERT INTO memories (
           id, kind, observation_type, scope, content, summary, title,
           tags, facts, observation_tags, search_terms,
           content_hash, version, is_latest, parent_id, root_id, source_count,
           is_inference, is_static, forget_after, forgotten, forget_reason, reprocessed,
           session_id, workspace, files_read, files_modified,
           access_count, file_change_count, pinned, created_at, updated_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, '[]',
           ?, ?, 1, ?, ?, ?,
           ?, ?, ?, 0, NULL, 1,
           ?, ?, ?, ?,
           0, 0, ?, ?, ?
         )`,
      ).run(
        newId,
        oldRow.kind,
        oldRow.observation_type,
        oldRow.scope,
        content,
        oldRow.summary,
        oldRow.title,
        resolvedTags,
        oldRow.facts,
        oldRow.observation_tags,
        newHash,
        oldRow.version + 1,
        oldRow.id,
        oldRow.root_id ?? oldRow.id,
        oldRow.source_count,
        oldRow.is_inference,
        oldRow.is_static,
        oldRow.forget_after,
        oldRow.session_id,
        oldRow.workspace,
        oldRow.files_read,
        oldRow.files_modified,
        oldRow.pinned,
        now,
        now,
      );

      this.db.prepare('UPDATE memories SET is_latest = 0 WHERE id = ?').run(oldRow.id);
      this.addEdge('UPDATES', newId, oldRow.id);

      return newId;
    });
  }

  /** Record that `newId` extends (augments without contradicting) `targetId`; both stay latest. */
  enrich(newId: string, targetId: string): Promise<void> {
    return this.writeQueue.run(() => {
      this.addEdge('EXTENDS', newId, targetId);
    });
  }

  /** Mark `id` as an inference derived from `derivedFromId`, wiring a `DERIVES` edge. */
  markInferred(id: string, derivedFromId: string): Promise<void> {
    return this.writeQueue.run(() => {
      this.db.prepare('UPDATE memories SET is_inference = 1 WHERE id = ?').run(id);
      this.addEdge('DERIVES', id, derivedFromId);
    });
  }

  /** Walks `parent_id` to the root, returning the lineage in root→latest order. Cycle-safe. */
  getVersionHistory(id: string): MemoryRow[] {
    const lineage: MemoryRow[] = [];
    const visited = new Set<string>();
    let current = this.getRow(id);

    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      lineage.push(current);
      current = current.parent_id ? this.getRow(current.parent_id) : null;
    }

    return lineage.reverse();
  }

  /** Bidirectional BFS over `memory_edges` filtered to `kinds`, up to `maxDepth` hops. Cycle-safe. */
  getRelated(id: string, kinds: EdgeKind[], maxDepth: number): MemoryRow[] {
    const kindSet = new Set<string>(kinds);
    const visited = new Set<string>([id]);
    const reached = new Set<string>();
    let frontier = new Set<string>([id]);

    for (let depth = 0; depth < maxDepth && frontier.size > 0; depth++) {
      const nextFrontier = new Set<string>();

      for (const node of frontier) {
        for (const edge of this.getEdgesBySource(node)) {
          if (!kindSet.has(edge.kind) || visited.has(edge.target_id)) continue;
          visited.add(edge.target_id);
          nextFrontier.add(edge.target_id);
          reached.add(edge.target_id);
        }
        for (const edge of this.getEdgesByTarget(node)) {
          if (!kindSet.has(edge.kind) || visited.has(edge.source_id)) continue;
          visited.add(edge.source_id);
          nextFrontier.add(edge.source_id);
          reached.add(edge.source_id);
        }
      }

      frontier = nextFrontier;
    }

    const rows: MemoryRow[] = [];
    for (const reachedId of reached) {
      const row = this.getRow(reachedId);
      if (row && row.forgotten === 0) rows.push(row);
    }
    return rows;
  }
}
