import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { log } from '../logger';
import type { MemoryKind, MemoryScope } from '@shared/types/memory';
import type { DatabaseInstance, MemoryRow } from './types';
import { normalizedContentHash } from './types';
import type { MemoryWriteQueue } from './write-queue';
import type { MemorySubCallRunner } from './subcall-runner';
import { buildFtsMatchQuery, tokenize } from './text-tokenize';

/** Time-to-live an episodic memory survives before the decay sweep forgets it. */
export const EPISODE_TTL_MS: number = 30 * 24 * 60 * 60 * 1000;

/** `access_count` at or above which an episode is promoted to durable (TTL cleared). */
export const EPISODE_PROMOTE_ACCESS: number = 3;

/** `source_count` at or above which an episode is promoted to durable (TTL cleared). */
export const EPISODE_PROMOTE_SOURCE_COUNT: number = 2;

/**
 * Minimum spread (`updated_at - created_at`) for the source-count promotion gate. A source-count bump
 * touches `updated_at`, so without this an episode restated in two adjacent turns would immortalize
 * (spread ≈ 0); requiring more than a day promotes only genuinely recurring episodes.
 */
export const EPISODE_PROMOTE_MIN_SPREAD_MS: number = 24 * 60 * 60 * 1000;

/** Age after which a decayed/merged (never user-forgotten) row is hard-purged from `memories`. */
export const FORGOTTEN_PURGE_AGE_MS: number = 90 * 24 * 60 * 60 * 1000;

const DEFAULT_DEDUP_THRESHOLD = 0.8;
const MERGE_TIMEOUT_MS = 20_000;
const CONSUMED_CANDIDATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NEAR_DUP_CANDIDATE_LIMIT = 25;

const MERGE_SYSTEM_PROMPT =
  'Merge these near-duplicate memory statements into ONE clear statement preserving all distinct ' +
  'information; choose which ids to keep and which are now redundant. Reply via the schema.';

const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    content: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    merged_ids: { type: 'array', items: { type: 'string' } },
  },
  required: ['content', 'merged_ids'],
  additionalProperties: false,
} satisfies Record<string, unknown>;

export interface MergeResult {
  content: string;
  tags?: string[];
  merged_ids: string[];
}

/**
 * Shape guard for the `merge` sub-call output. The runner's `T` is an unvalidated cast, so a
 * hallucinated shape would otherwise throw at first field access in `mergeNearDuplicates`. An invalid
 * shape is a logged no-op at the call site, never a throw.
 */
export function isMergeResult(v: unknown): v is MergeResult {
  if (!v || typeof v !== 'object') return false;
  const r = v as { content?: unknown; merged_ids?: unknown; tags?: unknown };
  if (typeof r.content !== 'string') return false;
  if (!Array.isArray(r.merged_ids) || !r.merged_ids.every(id => typeof id === 'string')) return false;
  if (r.tags !== undefined && (!Array.isArray(r.tags) || !r.tags.every(t => typeof t === 'string'))) return false;
  return true;
}

/** Fields a caller supplies for a brand-new live memory row. */
export interface NewMemoryFields {
  kind: MemoryKind;
  scope: MemoryScope;
  content: string;
  title?: string;
  summary?: string;
  tags?: string[];
  facts?: string[];
  observationType?: string;
  observationTags?: string[];
  filesRead?: string[];
  filesModified?: string[];
  sessionId?: string;
  workspace?: string;
  isStatic?: boolean;
  createdAt?: number;
}

/**
 * Reads `damocles.memory.dedup.threshold`. The default is duplicated in the `??` guard because some
 * config providers ignore the default and return `undefined`.
 */
export function getDedupThreshold(): number {
  return (
    vscode.workspace
      .getConfiguration('damocles.memory')
      .get<number>('dedup.threshold', DEFAULT_DEDUP_THRESHOLD) ?? DEFAULT_DEDUP_THRESHOLD
  );
}

function buildSameContentSelect(hasWorkspace: boolean, hasSession: boolean): string {
  const workspaceClause = hasWorkspace ? ' AND workspace = ?' : '';
  const sessionClause = hasSession ? ' AND session_id = ?' : '';
  return (
    `SELECT id FROM memories ` +
    `WHERE content_hash = ? AND scope = ? AND kind = ? AND is_latest = 1 AND forgotten = 0` +
    `${workspaceClause}${sessionClause} LIMIT 1`
  );
}

/**
 * Exact-dedup-on-write. Inside the write lock, finds an existing live row with the same normalized
 * content hash, scope, and kind (and workspace when supplied): on a hit, bumps `source_count` and
 * `updated_at` and returns its id with `deduped:true`. Otherwise inserts a fresh row — episodes get a
 * `forget_after` of `createdAt + EPISODE_TTL_MS`, all other kinds keep it NULL.
 */
export function insertWithDedup(
  db: DatabaseInstance,
  writeQueue: MemoryWriteQueue,
  fields: NewMemoryFields,
): Promise<{ id: string; deduped: boolean }> {
  return writeQueue.run(() => {
    const now = Date.now();
    const createdAt = fields.createdAt ?? now;
    const contentHash = normalizedContentHash(fields.content);
    const hasWorkspace = fields.workspace !== undefined;
    const hasSession = fields.scope === 'session' && fields.sessionId !== undefined;

    const params: unknown[] = [contentHash, fields.scope, fields.kind];
    if (hasWorkspace) params.push(fields.workspace);
    if (hasSession) params.push(fields.sessionId);

    const existing = db
      .prepare(buildSameContentSelect(hasWorkspace, hasSession))
      .get(...params) as { id: string } | undefined;

    if (existing) {
      db.prepare(
        'UPDATE memories SET source_count = source_count + 1, updated_at = ? WHERE id = ?',
      ).run(now, existing.id);
      return { id: existing.id, deduped: true };
    }

    const id = crypto.randomUUID();
    const forgetAfter = fields.kind === 'episode' ? createdAt + EPISODE_TTL_MS : null;

    db.prepare(
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
         ?, 1, 1, NULL, ?, 1,
         0, ?, ?, 0, NULL, 1,
         ?, ?, ?, ?,
         0, 0, 0, ?, ?
       )`,
    ).run(
      id,
      fields.kind,
      fields.observationType ?? null,
      fields.scope,
      fields.content,
      fields.summary ?? null,
      fields.title ?? null,
      JSON.stringify(fields.tags ?? []),
      JSON.stringify(fields.facts ?? []),
      JSON.stringify(fields.observationTags ?? []),
      contentHash,
      id,
      fields.isStatic ? 1 : 0,
      forgetAfter,
      fields.sessionId ?? null,
      fields.workspace ?? null,
      JSON.stringify(fields.filesRead ?? []),
      JSON.stringify(fields.filesModified ?? []),
      createdAt,
      createdAt,
    );

    return { id, deduped: false };
  });
}

/** Jaccard similarity of two token sets: |A ∩ B| / |A ∪ B|, in [0, 1]. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return intersection / union;
}

/**
 * Near-dup detection over live rows of the same `(scope, kind)`, gated to the same workspace/session
 * so one project/session never merges another's. The FTS5 MATCH is only a cheap lexical prefilter;
 * the decision is an absolute Jaccard token-overlap strictly exceeding `threshold`. (BM25 min-max
 * normalization was unusable — the top hit always normalizes to 1.0, flagging every lexical neighbor.)
 */
export function findNearDuplicates(db: DatabaseInstance, row: MemoryRow, threshold: number): MemoryRow[] {
  const match = buildFtsMatchQuery(row.content);
  if (!match) return [];

  const rowTokens = new Set(tokenize(row.content));
  if (rowTokens.size === 0) return [];

  const isProject = row.scope === 'project';
  const isSession = row.scope === 'session';
  const scopeClause = isProject ? ' AND m.workspace IS ?' : isSession ? ' AND m.session_id IS ?' : '';
  const params: unknown[] = [match, row.scope, row.kind, row.id];
  if (isProject) params.push(row.workspace);
  else if (isSession) params.push(row.session_id);
  params.push(NEAR_DUP_CANDIDATE_LIMIT);

  const candidates = db
    .prepare(
      `SELECT m.* FROM memories_fts f
         JOIN memories m ON m.rowid = f.rowid
        WHERE memories_fts MATCH ?
          AND m.is_latest = 1 AND m.forgotten = 0
          AND m.scope = ? AND m.kind = ? AND m.id != ?${scopeClause}
        ORDER BY f.rank
        LIMIT ?`,
    )
    .all(...params) as MemoryRow[];

  return candidates.filter(c => jaccardSimilarity(rowTokens, new Set(tokenize(c.content))) > threshold);
}

function buildMergePrompt(primary: MemoryRow, dups: MemoryRow[]): string {
  const statements = [primary, ...dups]
    .map(r => `- id ${r.id}: ${r.content}`)
    .join('\n');
  return `Primary id: ${primary.id}\n\nNear-duplicate statements:\n${statements}`;
}

/**
 * Merges near-duplicates into the primary row via one privacy-gated `merge` sub-call. The LLM call
 * runs outside the write lock; the dependent mutations run inside one synchronous
 * {@link MemoryWriteQueue.run} callback. The primary absorbs the merged content, tags, and
 * `source_count`; each still-live merged row is marked `forgotten=1, forget_reason='merged'`.
 */
export async function mergeNearDuplicates(
  db: DatabaseInstance,
  writeQueue: MemoryWriteQueue,
  runner: MemorySubCallRunner,
  primary: MemoryRow,
  dups: MemoryRow[],
): Promise<{ merged: number }> {
  if (dups.length === 0) return { merged: 0 };

  const { value } = await runner.run<MergeResult>({
    purpose: 'merge',
    systemPrompt: MERGE_SYSTEM_PROMPT,
    prompt: buildMergePrompt(primary, dups),
    schema: MERGE_SCHEMA,
    timeoutMs: MERGE_TIMEOUT_MS,
  });

  if (!value) return { merged: 0 };
  // Reject an unvalidated hallucinated shape as a logged no-op rather than throw at first field access.
  if (!isMergeResult(value)) {
    log('[MemoryDedup] merge sub-call returned an invalid shape; skipping merge (no-op): %o', value);
    return { merged: 0 };
  }
  if (!value.content.trim()) return { merged: 0 };

  const allowed = new Set(dups.map(d => d.id));
  const mergeIds = new Set(value.merged_ids);

  return writeQueue.run(() => {
    const fresh = db.prepare('SELECT * FROM memories WHERE id = ?').get(primary.id) as MemoryRow | undefined;
    if (!fresh || fresh.is_latest !== 1 || fresh.forgotten !== 0) return { merged: 0 };
    // value.content was synthesized from the pre-lock primary. If the primary was edited during the
    // (async) merge window, writing the stale merged text would silently clobber that edit — bail.
    if (fresh.content_hash !== primary.content_hash) return { merged: 0 };

    let merged = 0;
    for (const dupId of mergeIds) {
      if (dupId === primary.id || !allowed.has(dupId)) continue;
      const dupRow = db.prepare('SELECT * FROM memories WHERE id = ?').get(dupId) as MemoryRow | undefined;
      if (!dupRow || dupRow.is_latest !== 1 || dupRow.forgotten !== 0) continue;

      db.prepare(
        "UPDATE memories SET forgotten = 1, forget_reason = 'merged' WHERE id = ?",
      ).run(dupId);
      merged += 1;
    }

    if (merged === 0) return { merged: 0 };

    const now = Date.now();
    const mergedHash = normalizedContentHash(value.content);
    const newTags = value.tags && value.tags.length > 0 ? value.tags : undefined;
    if (newTags) {
      const existingTags = JSON.parse(fresh.tags) as string[];
      const unionedTags = Array.from(new Set([...existingTags, ...newTags]));
      db.prepare(
        'UPDATE memories SET content = ?, content_hash = ?, tags = ?, source_count = source_count + ?, updated_at = ? WHERE id = ?',
      ).run(value.content, mergedHash, JSON.stringify(unionedTags), merged, now, primary.id);
    } else {
      db.prepare(
        'UPDATE memories SET content = ?, content_hash = ?, source_count = source_count + ?, updated_at = ? WHERE id = ?',
      ).run(value.content, mergedHash, merged, now, primary.id);
    }

    return { merged };
  });
}

/**
 * Time-based decay sweep. Forgets every unpinned, still-live episode whose `forget_after` has elapsed.
 * Honored ONLY for `kind='episode'`, so a hallucinated `forget_after` on a fact can never delete it.
 */
export function applyDecaySweep(
  db: DatabaseInstance,
  writeQueue: MemoryWriteQueue,
): Promise<{ forgotten: number }> {
  return writeQueue.run(() => {
    const now = Date.now();
    const result = db
      .prepare(
        `UPDATE memories SET forgotten = 1, forget_reason = 'episode_decay'
          WHERE kind = 'episode' AND forget_after IS NOT NULL AND forget_after < ?
            AND pinned = 0 AND forgotten = 0`,
      )
      .run(now);
    return { forgotten: result.changes };
  });
}

/**
 * Promotes durable episodes by clearing their TTL. Two independent gates:
 *   - accessed at least {@link EPISODE_PROMOTE_ACCESS} times, OR
 *   - restated from at least {@link EPISODE_PROMOTE_SOURCE_COUNT} sources AND spread over more than a
 *     day ({@link EPISODE_PROMOTE_MIN_SPREAD_MS}). The spread gate stops an episode restated twice in
 *     adjacent turns (spread ≈ 0) from immortalizing while keeping a genuinely recurring one durable.
 */
export function promoteEpisodes(
  db: DatabaseInstance,
  writeQueue: MemoryWriteQueue,
): Promise<{ promoted: number }> {
  return writeQueue.run(() => {
    const result = db
      .prepare(
        `UPDATE memories SET forget_after = NULL
          WHERE kind = 'episode' AND forget_after IS NOT NULL AND forgotten = 0
            AND (
              access_count >= ?
              OR (source_count >= ? AND (updated_at - created_at) >= ?)
            )`,
      )
      .run(EPISODE_PROMOTE_ACCESS, EPISODE_PROMOTE_SOURCE_COUNT, EPISODE_PROMOTE_MIN_SPREAD_MS);
    return { promoted: result.changes };
  });
}

/**
 * Prunes processed extraction candidates older than 7 days. Gated on `reprocessed = 1` so a
 * crash-stranded batch (`consumed = 1, reprocessed = 0`) is reclaimed for re-processing, not deleted.
 */
export function pruneConsumedCandidates(db: DatabaseInstance, writeQueue: MemoryWriteQueue): Promise<{ pruned: number }> {
  return writeQueue.run(() => {
    const cutoff = Date.now() - CONSUMED_CANDIDATE_TTL_MS;
    const result = db
      .prepare('DELETE FROM memory_candidates WHERE consumed = 1 AND reprocessed = 1 AND created_at < ?')
      .run(cutoff);
    return { pruned: result.changes };
  });
}

/**
 * Hard-delete the given memory ids and everything referencing them: incident edges and retrievals,
 * then the `memories` rows. Runs synchronously inside the caller's transaction (the caller already
 * holds the write lock), so it MUST NOT re-enter the queue. `memory_edges` has no foreign key, so
 * incident edges would otherwise dangle. Does not promote version-chain parents (caller-specific).
 */
export function deleteMemoriesWithHygiene(db: DatabaseInstance, ids: string[]): void {
  if (ids.length === 0) return;
  const ph = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM memory_edges WHERE source_id IN (${ph}) OR target_id IN (${ph})`).run(...ids, ...ids);
  db.prepare(`DELETE FROM memory_retrievals WHERE memory_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM memories WHERE id IN (${ph})`).run(...ids);
}

/**
 * Hard-purges long-forgotten decayed/merged rows so `memories` doesn't grow monotonically. Only
 * `forget_reason IN ('episode_decay','merged')` rows older than {@link FORGOTTEN_PURGE_AGE_MS} are
 * removed — a `user_forget` row is NEVER purged, since the user can still unforget it.
 */
export function purgeForgottenRows(db: DatabaseInstance, writeQueue: MemoryWriteQueue): Promise<{ purged: number }> {
  return writeQueue.run(() => {
    const cutoff = Date.now() - FORGOTTEN_PURGE_AGE_MS;
    const rows = db
      .prepare(
        `SELECT id FROM memories
          WHERE forgotten = 1
            AND forget_reason IN ('episode_decay', 'merged')
            AND updated_at < ?`,
      )
      .all(cutoff) as { id: string }[];
    const ids = rows.map(r => r.id);
    deleteMemoriesWithHygiene(db, ids);
    return { purged: ids.length };
  });
}

/** Free-list page fraction above which {@link maybeVacuum} runs a VACUUM (below this the rewrite isn't worth it). */
export const VACUUM_FREELIST_RATIO = 0.25;

/** Minimum page count before {@link maybeVacuum} runs, so the ratio gate can't fire on a near-empty file. */
export const VACUUM_MIN_PAGES = 2500;

/** Reads a scalar query-form PRAGMA as a number. Reads take no write lock, so hits `db` directly. */
function readPragmaCount(db: DatabaseInstance, name: string): number {
  return Number(db.pragma(name));
}

/**
 * Runs `VACUUM` when enough dead pages have accumulated to be worth the full-file rewrite (ratio +
 * min-pages gates). Nothing else shrinks the file — hard-deletes only move pages onto the free list.
 * VACUUM cannot run inside a transaction, so it goes through {@link MemoryWriteQueue.runOutsideTransaction}.
 */
export async function maybeVacuum(db: DatabaseInstance, writeQueue: MemoryWriteQueue): Promise<void> {
  const freelistBefore = readPragmaCount(db, 'freelist_count');
  const pageCount = readPragmaCount(db, 'page_count');
  if (pageCount <= 0) return;

  const ratio = freelistBefore / pageCount;
  if (ratio <= VACUUM_FREELIST_RATIO || pageCount <= VACUUM_MIN_PAGES) return;

  await writeQueue.runOutsideTransaction(() => db.exec('VACUUM'));

  const freelistAfter = readPragmaCount(db, 'freelist_count');
  log(
    '[MemoryMaintenance] VACUUM ran (freelist %d → %d of %d pages)',
    freelistBefore,
    freelistAfter,
    pageCount,
  );
}
