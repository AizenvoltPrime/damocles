import * as crypto from 'crypto';
import type { DatabaseInstance, MemoryRow } from '../types';
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

/**
 * Project memories are workspace-isolated; global/session carry no workspace and skip the gate.
 * Uses SQLite `IS` (null-safe equality) so a project row matches only same-workspace rows — and
 * never bleeds across workspaces even when the column happens to be NULL.
 */
function workspaceGate(row: MemoryRow): { clause: string; params: unknown[] } {
  if (row.scope === 'project') return { clause: ' AND m.workspace IS ?', params: [row.workspace] };
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
 * Owns the memory fact graph: edge primitives, version-lineage maintenance, and
 * LLM-judged conflict resolution (D4). The deterministic candidate selection and
 * the LLM verdict run OUTSIDE the write queue; every invariant re-check plus its
 * dependent mutations run inside one synchronous {@link MemoryWriteQueue.run}
 * callback (D3) so concurrent operations never interleave a read-modify-write.
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

  /**
   * Insert a directed edge with a fresh id, JSON-serialized `extra`, and a `Date.now()` timestamp.
   * Idempotent on `(kind, source_id, target_id)` so repeated calls (e.g. enrich/markInferred) never
   * create duplicate edges.
   */
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

  /** True when an edge of `kind` from `sourceId` to `targetId` already exists. The dedup gate. */
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

  private selectConflictCandidates(newRow: MemoryRow): MemoryRow[] {
    const match = buildFtsMatchQuery(newRow.content, MAX_MATCH_TOKENS);
    if (!match) return [];
    const ws = workspaceGate(newRow);
    return this.db.prepare(
      `SELECT m.* FROM memories_fts fts
         JOIN memories m ON m.rowid = fts.rowid
        WHERE memories_fts MATCH ?
          AND m.is_latest = 1 AND m.forgotten = 0
          AND m.scope = ? AND m.kind = ? AND m.id != ?${ws.clause}
        ORDER BY fts.rank
        LIMIT ?`,
    ).all(match, newRow.scope, newRow.kind, newRow.id, ...ws.params, MAX_CONFLICT_CANDIDATES) as MemoryRow[];
  }

  private async judgeContradiction(newRow: MemoryRow, candidate: MemoryRow): Promise<boolean> {
    const result = await this.runner.run<{ contradicts: boolean }>({
      purpose: 'merge',
      systemPrompt: CONFLICT_SYSTEM_PROMPT,
      prompt: `NEW: ${newRow.content}\nOLD: ${candidate.content}`,
      schema: CONFLICT_SCHEMA,
    });
    return result.value?.contradicts === true;
  }

  /**
   * Resolves conflicts for a freshly written fact (D4): FTS-selects up to 5
   * latest, non-forgotten same-scope/kind candidates, asks the LLM which ones
   * the new fact contradicts, then under the write lock joins the new fact to a
   * SINGLE canonical lineage — the oldest contradicted fact's root — as its next
   * version (`UPDATES` edge), and demotes every other contradicted fact with a
   * `SUPERSEDES` edge WITHOUT re-rooting the new fact.
   *
   * Joining one lineage is what keeps the version chain coherent when a fact
   * contradicts several older facts from distinct roots: the new fact is the sole
   * `is_latest=1` survivor, its version is bumped exactly once (monotonic), the
   * canonical root's history stays reachable via `getVersionHistory`, and the
   * other superseded roots stay reachable via their `SUPERSEDES` edge rather than
   * being orphaned with zero latest rows. Idempotent: a re-run adds no edges and
   * causes no version churn.
   */
  async resolveConflict(newRow: MemoryRow): Promise<{ superseded: string[] }> {
    const candidates = this.selectConflictCandidates(newRow);
    if (candidates.length === 0) return { superseded: [] };

    const contradicting: MemoryRow[] = [];
    for (const candidate of candidates) {
      if (await this.judgeContradiction(newRow, candidate)) {
        contradicting.push(candidate);
      }
    }
    if (contradicting.length === 0) return { superseded: [] };

    return this.writeQueue.run(() => {
      const toSupersede: MemoryRow[] = [];
      for (const old of contradicting) {
        if (this.hasEdge('UPDATES', newRow.id, old.id) || this.hasEdge('SUPERSEDES', newRow.id, old.id)) continue;
        if (newRow.created_at <= old.created_at) continue;
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

  /**
   * Walks `parent_id` upward from the given row to its root and returns the
   * lineage in root→latest order (the starting row included). Cycle-safe via a
   * visited set so malformed parent loops terminate.
   */
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

  /**
   * Bidirectional BFS over `memory_edges` filtered to `kinds`, up to `maxDepth`
   * hops, returning the reachable rows (the start id excluded). Cycle-safe via a
   * visited set.
   */
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
