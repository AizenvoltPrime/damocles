import * as vscode from 'vscode';
import * as crypto from 'crypto';
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

interface MergeResult {
  content: string;
  tags?: string[];
  merged_ids: string[];
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
 * Reads `damocles.memory.dedup.threshold`, falling back to {@link DEFAULT_DEDUP_THRESHOLD}
 * when the setting is unset. The default argument is duplicated in the `??` guard because
 * some configuration providers ignore the default and return `undefined`.
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
 * Exact-dedup-on-write (D2). Inside the write lock, looks for an existing live row with the
 * same normalized content hash, scope, and kind (and workspace when one is supplied). On a
 * hit it bumps `source_count` and `updated_at` and returns the existing id with `deduped:true`;
 * no new row is created. Otherwise it inserts a fresh born-default row — episodes receive a
 * `forget_after` of `createdAt + EPISODE_TTL_MS`, all other kinds keep `forget_after` NULL.
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
 * Near-dup detection over live rows of the same `(scope, kind)` — project rows are gated to the
 * same workspace and session rows to the same session, so a memory in one project/session never
 * merges another's (mirroring the exact-dedup gate). An FTS5 MATCH on
 * `row.content` is used only as a cheap lexical prefilter to bound the candidate set; the actual
 * near-dup decision is an ABSOLUTE Jaccard token-overlap score against each candidate, returning
 * rows whose overlap strictly exceeds `threshold`. (BM25 min-max normalization was unusable here:
 * the top hit always normalizes to 1.0, so every insert with any lexical neighbor was flagged.)
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
 * Merges near-duplicates into the primary row via one privacy-gated `merge` sub-call (D5). The
 * LLM call runs OUTSIDE the write lock; the dependent mutations run inside one synchronous
 * {@link MemoryWriteQueue.run} callback (D3). The kept/primary row absorbs the merged content,
 * optional tags, and the merged rows' `source_count`; each merged row that is still live is marked
 * `forgotten=1, forget_reason='merged'`. A `null` runner value degrades to a no-op.
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
  if (!value.content.trim()) return { merged: 0 };

  const allowed = new Set(dups.map(d => d.id));
  const mergeIds = new Set(value.merged_ids);

  return writeQueue.run(() => {
    const fresh = db.prepare('SELECT * FROM memories WHERE id = ?').get(primary.id) as MemoryRow | undefined;
    if (!fresh || fresh.is_latest !== 1 || fresh.forgotten !== 0) return { merged: 0 };

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
    const newTags = value.tags && value.tags.length > 0 ? value.tags : undefined;
    if (newTags) {
      const existingTags = JSON.parse(fresh.tags) as string[];
      const unionedTags = Array.from(new Set([...existingTags, ...newTags]));
      db.prepare(
        'UPDATE memories SET content = ?, tags = ?, source_count = source_count + ?, updated_at = ? WHERE id = ?',
      ).run(value.content, JSON.stringify(unionedTags), merged, now, primary.id);
    } else {
      db.prepare(
        'UPDATE memories SET content = ?, source_count = source_count + ?, updated_at = ? WHERE id = ?',
      ).run(value.content, merged, now, primary.id);
    }

    return { merged };
  });
}

/**
 * Time-based decay sweep (D2). Forgets every unpinned, still-live episode whose `forget_after`
 * has elapsed. The `forget_after` column is honored ONLY for `kind='episode'`: a hallucinated
 * `forget_after` on a fact or preference can never delete it.
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
 * Promotes episodes that have proven durable — accessed at least
 * {@link EPISODE_PROMOTE_ACCESS} times or merged from at least
 * {@link EPISODE_PROMOTE_SOURCE_COUNT} sources — by clearing their TTL so the decay sweep
 * leaves them alone.
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
            AND (access_count >= ? OR source_count >= ?)`,
      )
      .run(EPISODE_PROMOTE_ACCESS, EPISODE_PROMOTE_SOURCE_COUNT);
    return { promoted: result.changes };
  });
}

/**
 * Prunes processed extraction candidates older than 7 days. Gated on `reprocessed = 1` so a batch
 * left `consumed = 1, reprocessed = 0` by a crash is never silently deleted — the startup reclaim
 * resets it for re-processing instead.
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
