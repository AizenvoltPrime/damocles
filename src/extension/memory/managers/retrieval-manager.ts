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
import type { MemorySubCallRunner } from '../subcall-runner';

const RELEVANCE_RANK: Record<RerankRelevance, number> = { high: 3, medium: 2, low: 1 };

/**
 * Sort weight for the final ordering: ungraded rows sit at a NEUTRAL position (between medium and
 * low) so a high-BM25 row the LLM simply didn't grade keeps its BM25 standing instead of sinking
 * below explicitly-low grades. Distinct from {@link RELEVANCE_RANK}, which only dedups grades.
 */
const RERANK_SORT_WEIGHT: Record<RerankRelevance, number> = { high: 3, medium: 2, low: 0 };
const UNGRADED_SORT_WEIGHT = 1;
function rerankSortWeight(relevance: RerankRelevance | undefined): number {
  return relevance === undefined ? UNGRADED_SORT_WEIGHT : RERANK_SORT_WEIGHT[relevance];
}

const DEFAULT_CANDIDATE_POOL = 30;
const DEFAULT_RESULT_LIMIT = 20;
const SNIPPET_CHARS = 120;
const RERANK_SNIPPET_CHARS = 160;

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
  return { clause: `${column}scope = ?`, params: [tier] };
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
 * Two-stage semantic retrieval: BM25 over-fetch followed by an optional LLM rerank.
 * Without a sub-call runner (or when rerank is disabled), search degrades cleanly to
 * pure BM25 ordering.
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

    const candidates = this.fetchCandidates(query, pool);
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
        const pattern = `%${escapeLike(file)}%`;
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
    });

    if (!value) return candidates.map(row => ({ row }));

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

  getDetails(ids: string[]): MemoryEntry[] {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    this.db
      .prepare(`UPDATE memories SET access_count = access_count + 1 WHERE id IN (${placeholders}) AND forgotten = 0`)
      .run(...ids);

    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders}) AND forgotten = 0`)
      .all(...ids) as MemoryRow[];
    return rows.map(rowToEntry);
  }
}
