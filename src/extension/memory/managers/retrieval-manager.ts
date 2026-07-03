import * as vscode from 'vscode';
import type {
  MemoryEntry,
  MemoryKind,
  MemoryScope,
  MemoryTier,
  ObservationType,
  SearchQuery,
  SearchResult,
} from '@shared/types/memory';
import { log } from '../../logger';
import type { DatabaseInstance, MemoryRow } from '../types';
import { deriveTier, escapeLike, rowToEntry } from '../types';
import { buildFtsMatchQuery } from '../text-tokenize';
import { expandQuery } from '../query-expansion';
import type { MemorySubCallRunner } from '../subcall-runner';

/**
 * Defensive forward-slash normalization for paths returned on an entry: a legacy row read before the
 * sweep ran could still carry backslashes, so normalize on the way out.
 */
function normalizeEntryFilePaths(entry: MemoryEntry): MemoryEntry {
  const slash = (files?: string[]): string[] | undefined =>
    files ? files.map((f) => f.replace(/\\/g, '/')) : undefined;
  return {
    ...entry,
    ...(entry.filesRead ? { filesRead: slash(entry.filesRead)! } : {}),
    ...(entry.filesModified ? { filesModified: slash(entry.filesModified)! } : {}),
  };
}

const RELEVANCE_RANK: Record<RerankRelevance, number> = { high: 3, medium: 2, low: 1 };

/**
 * Ungraded rows sort at a neutral position (between medium and low) so a high-BM25 row the LLM
 * didn't grade keeps its standing instead of sinking below explicitly-low grades. Distinct from
 * {@link RELEVANCE_RANK}, which only dedups grades.
 */
const RERANK_SORT_WEIGHT: Record<RerankRelevance, number> = { high: 3, medium: 2, low: 0 };
const UNGRADED_SORT_WEIGHT = 1;

/** Max time interactive search waits on LLM query expansion before falling back to BM25-only. */
const EXPANSION_DEADLINE_MS = 400;

/** Resolves with the promise's value if it settles within `ms`, else `null` (the promise keeps running). */
function raceDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}
function rerankSortWeight(relevance: RerankRelevance | undefined): number {
  return relevance === undefined ? UNGRADED_SORT_WEIGHT : RERANK_SORT_WEIGHT[relevance];
}

const DEFAULT_CANDIDATE_POOL = 30;
const DEFAULT_RESULT_LIMIT = 20;
const SNIPPET_CHARS = 120;
const RERANK_SNIPPET_CHARS = 160;

/**
 * Search-path rerank is user-blocking, so it may run longer than the 2s injection budget but must
 * stay bounded rather than inheriting the 12s runner default and hanging an interactive query.
 */
const SEARCH_RERANK_TIMEOUT_MS = 8000;

type RerankRelevance = 'high' | 'medium' | 'low';

type CandidateRow = MemoryRow & { rank: number };

interface RankedCandidate {
  row: CandidateRow;
  relevance?: RerankRelevance;
  reason?: string;
}

interface RerankResult {
  results: Array<{ id: string; relevance: RerankRelevance; reason?: string }>;
}

/** The runner's `T` is an unvalidated cast; a hallucinated shape would throw at `value.results`. */
function isRerankResult(v: unknown): v is RerankResult {
  return (
    !!v &&
    typeof v === 'object' &&
    Array.isArray((v as { results?: unknown }).results) &&
    (v as { results: unknown[] }).results.every(
      (r) => !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string',
    )
  );
}

const RERANK_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          relevance: { enum: ['high', 'medium', 'low'] },
          reason: { type: 'string' },
        },
        required: ['id', 'relevance'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} satisfies Record<string, unknown>;

const RERANK_SYSTEM_PROMPT =
  'Grade how relevant each candidate memory is to the user query. ' +
  'Return every candidate id exactly once with a relevance of high, medium, or low ' +
  'and a brief reason. Judge by semantic relevance, not keyword overlap.';

function tierPredicate(tier: MemoryTier, column: string): { clause: string; params: unknown[] } {
  if (tier === 'note') return { clause: `${column}kind = 'note'`, params: [] };
  if (tier === 'observation') return { clause: `${column}kind = 'observation'`, params: [] };
  // Scope tiers select facts/preferences/episodes only; notes and observations have their own tiers.
  return { clause: `(${column}scope = ? AND ${column}kind NOT IN ('note','observation'))`, params: [tier] };
}

function buildTierFilter(tiers: MemoryTier[], column: string): { clause: string; params: unknown[] } {
  const parts = tiers.map(tier => tierPredicate(tier, column));
  return {
    clause: `(${parts.map(p => p.clause).join(' OR ')})`,
    params: parts.flatMap(p => p.params),
  };
}

function rowToSearchResult(
  row: CandidateRow,
  index: number,
  relevance?: RerankRelevance,
  reason?: string,
): SearchResult {
  return {
    id: row.id,
    tier: deriveTier(row.scope as MemoryScope, row.kind as MemoryKind),
    title: row.title,
    snippet: row.content.slice(0, SNIPPET_CHARS),
    rank: index + 1,
    timestamp: row.created_at,
    ...(row.observation_type ? { observationType: row.observation_type as ObservationType } : {}),
    ...(relevance ? { rerankRelevance: relevance } : {}),
    ...(reason ? { reason } : {}),
  };
}

/**
 * Two-stage semantic retrieval: BM25 over-fetch followed by an optional LLM rerank. Without a runner
 * (or when rerank is disabled), search degrades to pure BM25 ordering.
 */
export class RetrievalManager {
  private db: DatabaseInstance;
  private runner?: MemorySubCallRunner;

  constructor(db: DatabaseInstance, runner?: MemorySubCallRunner) {
    this.db = db;
    if (runner) this.runner = runner;
  }

  async search(query: SearchQuery, opts?: { rerank?: boolean }): Promise<SearchResult[]> {
    const cfg = vscode.workspace.getConfiguration('damocles.memory');
    const pool = cfg.get<number>('rerank.candidatePool', DEFAULT_CANDIDATE_POOL) ?? DEFAULT_CANDIDATE_POOL;
    const rerankEnabled = cfg.get<boolean>('rerank.enabled', true) ?? true;
    const limit = query.limit ?? DEFAULT_RESULT_LIMIT;

    // Expansion is best-effort AND time-boxed: a slow provider must not add dead latency to an
    // otherwise-instant BM25 search. If it doesn't resolve within the deadline, search with the
    // original query only; any failure degrades the same way.
    let expanded: string[] = [];
    try {
      if (query.query) {
        const result = await raceDeadline(expandQuery(query.query), EXPANSION_DEADLINE_MS);
        if (result) expanded = result.slice(0, 3);
      }
    } catch {
      expanded = [];
    }
    const candidates =
      query.query && expanded.length > 0
        ? this.fetchCandidatesExpanded(query, pool, expanded)
        : this.fetchCandidates(query, pool);
    if (candidates.length === 0) return [];

    const wantRerank =
      !!this.runner &&
      rerankEnabled &&
      (opts?.rerank ?? true) &&
      candidates.length > 1 &&
      !!query.query;

    const ordered: RankedCandidate[] = wantRerank
      ? await this.rerank(query.query!, candidates)
      : candidates.map(row => ({ row }));

    return ordered.slice(0, limit).map((entry, index) =>
      rowToSearchResult(entry.row, index, entry.relevance, entry.reason),
    );
  }

  private fetchCandidates(query: SearchQuery, pool: number): CandidateRow[] {
    const match = query.query ? buildFtsMatchQuery(query.query) : null;
    return match ? this.ftsCandidates(query, match, pool) : this.filteredCandidates(query, pool);
  }

  /**
   * Union of FTS candidates for the original query plus expanded synonym terms, deduped by id keeping
   * the best (lowest) rank. Fail-soft: a non-text query or a term with no tokens degrades to the
   * original candidates; expansion never breaks or throws.
   */
  private fetchCandidatesExpanded(query: SearchQuery, pool: number, expandedTerms: string[]): CandidateRow[] {
    const match = query.query ? buildFtsMatchQuery(query.query) : null;
    if (!match) return this.filteredCandidates(query, pool);

    const best = new Map<string, CandidateRow>();
    const merge = (rows: CandidateRow[]): void => {
      for (const row of rows) {
        const prev = best.get(row.id);
        if (!prev || row.rank < prev.rank) best.set(row.id, row);
      }
    };

    merge(this.ftsCandidates(query, match, pool));
    for (const term of expandedTerms) {
      const termMatch = buildFtsMatchQuery(term);
      if (termMatch) merge(this.ftsCandidates(query, termMatch, pool));
    }

    return [...best.values()].sort((a, b) => a.rank - b.rank).slice(0, pool);
  }

  private ftsCandidates(query: SearchQuery, match: string, pool: number): CandidateRow[] {
    const { clause, params } = this.commonFilters(query, 'm.');
    const sql = `
      SELECT m.*, f.rank
      FROM memories_fts f
      JOIN memories m ON m.rowid = f.rowid
      WHERE memories_fts MATCH ?${clause}
      ORDER BY f.rank
      LIMIT ?
    `;
    try {
      return this.db.prepare(sql).all(match, ...params, pool) as CandidateRow[];
    } catch (err) {
      log(`[Memory] FTS5 query failed, falling back to filtered search: ${err}`);
      return this.filteredCandidates(query, pool);
    }
  }

  private filteredCandidates(query: SearchQuery, pool: number): CandidateRow[] {
    const { clause, params } = this.commonFilters(query, '');
    const sql = `
      SELECT *, 0 AS rank
      FROM memories
      WHERE 1 = 1${clause}
      ORDER BY created_at DESC
      LIMIT ?
    `;
    return this.db.prepare(sql).all(...params, pool) as CandidateRow[];
  }

  private commonFilters(query: SearchQuery, column: string): { clause: string; params: unknown[] } {
    const clauses: string[] = [`${column}is_latest = 1`];
    if (!query.includeForgotten) clauses.push(`${column}forgotten = 0`);
    clauses.push(`(${column}forget_after IS NULL OR ${column}forget_after >= ?)`);
    const params: unknown[] = [Date.now()];

    // Scope to this workspace + global + this session; foreign-session rows never surface. allWorkspaces opts out.
    if (!query.allWorkspaces) {
      const scopeBranches: string[] = [`${column}scope = 'global'`];
      if (query.workspace !== undefined) {
        scopeBranches.push(`${column}workspace = ?`);
        params.push(query.workspace);
      }
      if (query.sessionId !== undefined) {
        scopeBranches.push(`(${column}session_id = ? AND ${column}scope = 'session')`);
        params.push(query.sessionId);
      }
      clauses.push(`(${scopeBranches.join(' OR ')})`);
    }

    if (query.tiers && query.tiers.length > 0) {
      const tier = buildTierFilter(query.tiers, column);
      clauses.push(tier.clause);
      params.push(...tier.params);
    }
    if (query.types && query.types.length > 0) {
      clauses.push(`${column}observation_type IN (${query.types.map(() => '?').join(',')})`);
      params.push(...query.types);
    }
    if (query.files && query.files.length > 0) {
      const fileClauses = query.files.map(
        () => `(${column}files_read LIKE ? ESCAPE '\\' OR ${column}files_modified LIKE ? ESCAPE '\\')`,
      );
      clauses.push(`(${fileClauses.join(' OR ')})`);
      for (const file of query.files) {
        // Forward-slash normalize so a backslash query `src\foo.ts` matches the stored `src/foo.ts`.
        const pattern = `%${escapeLike(file.replace(/\\/g, '/'))}%`;
        params.push(pattern, pattern);
      }
    }
    if (query.since) {
      clauses.push(`${column}created_at >= ?`);
      params.push(query.since);
    }
    if (query.until) {
      clauses.push(`${column}created_at <= ?`);
      params.push(query.until);
    }

    return { clause: ` AND ${clauses.join(' AND ')}`, params };
  }

  private async rerank(query: string, candidates: CandidateRow[]): Promise<RankedCandidate[]> {
    const prompt = this.buildRerankPrompt(query, candidates);
    const { value } = await this.runner!.run<RerankResult>({
      purpose: 'rerank',
      systemPrompt: RERANK_SYSTEM_PROMPT,
      prompt,
      schema: RERANK_SCHEMA,
      timeoutMs: SEARCH_RERANK_TIMEOUT_MS,
    });

    if (!isRerankResult(value)) return candidates.map(row => ({ row }));

    const graded = new Map<string, { relevance: RerankRelevance; reason?: string }>();
    for (const item of value.results) {
      if (!(item.relevance in RELEVANCE_RANK)) continue;
      const existing = graded.get(item.id);
      if (!existing || RELEVANCE_RANK[item.relevance] > RELEVANCE_RANK[existing.relevance]) {
        graded.set(item.id, { relevance: item.relevance, ...(item.reason ? { reason: item.reason } : {}) });
      }
    }

    if (graded.size === 0) return candidates.map(row => ({ row }));

    return candidates
      .map((row, bm25Index) => {
        const grade = graded.get(row.id);
        return { row, bm25Index, relevance: grade?.relevance, ...(grade?.reason ? { reason: grade.reason } : {}) };
      })
      .sort(
        (a, b) =>
          rerankSortWeight(b.relevance) - rerankSortWeight(a.relevance) ||
          b.row.source_count - a.row.source_count ||
          a.bm25Index - b.bm25Index,
      )
      .map(({ row, relevance, reason }) => ({ row, ...(relevance ? { relevance } : {}), ...(reason ? { reason } : {}) }));
  }

  private buildRerankPrompt(query: string, candidates: CandidateRow[]): string {
    const items = candidates.map(row => ({
      id: row.id,
      title: row.title,
      snippet: row.content.slice(0, RERANK_SNIPPET_CHARS),
    }));
    return `Query: ${query}\n\nCandidates:\n${JSON.stringify(items)}`;
  }

  /** Pure read of full entries by id; the access-count bump lives in `MemoryService.getMemoryDetails`. */
  getDetails(ids: string[]): MemoryEntry[] {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    // Explicit-ID fetch must resolve a forgotten row (search can surface it via includeForgotten).
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...ids) as MemoryRow[];
    return rows.map(rowToEntry).map(normalizeEntryFilePaths);
  }
}
