import * as crypto from 'crypto';
import type { MemoryEntry, MemoryKind, MemoryScope, MemoryTier, ObservationType } from '@shared/types/memory';

export interface RunResult {
  changes: number;
}

export interface PreparedStatement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface DatabaseInstance {
  prepare(sql: string): PreparedStatement;
  exec(sql: string): void;
  pragma(value: string): unknown;
  /**
   * Run `fn` atomically: the outermost call issues `BEGIN IMMEDIATE` (taking the write lock up front),
   * runs `fn`, then `COMMIT`; any throw triggers `ROLLBACK` and rethrows. `fn` MUST be synchronous —
   * a transaction can't span an `await` — so a thenable result is rejected (and rolled back).
   */
  transaction<T>(fn: () => T): T;
  /** Best-effort WAL checkpoint, then close. Double-close is a no-op. */
  close(): void;
}

export interface MemoryRow {
  id: string;
  kind: string;
  observation_type: string | null;
  scope: string;
  content: string;
  summary: string | null;
  title: string | null;
  tags: string;
  facts: string;
  observation_tags: string;
  search_terms: string;
  content_hash: string;
  version: number;
  is_latest: number;
  parent_id: string | null;
  root_id: string | null;
  source_count: number;
  is_inference: number;
  is_static: number;
  forget_after: number | null;
  forgotten: number;
  forget_reason: string | null;
  reprocessed: number;
  session_id: string | null;
  workspace: string | null;
  files_read: string;
  files_modified: string;
  access_count: number;
  file_change_count: number;
  pinned: number;
  needs_conflict_check: number;
  created_at: number;
  updated_at: number;
}

export interface FtsMatchRow {
  id: string;
  rank: number;
}

export function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** Derives the outbound `tier` DTO field from the scope/kind columns. */
export function deriveTier(scope: MemoryScope, kind: MemoryKind): MemoryTier {
  if (kind === 'note') return 'note';
  if (kind === 'observation') return 'observation';
  return scope;
}

/** Stable hash over whitespace- and case-normalized content for dedup keys. */
export function normalizedContentHash(content: string): string {
  const normalized = content.trim().toLowerCase().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    tier: deriveTier(row.scope as MemoryScope, row.kind as MemoryKind),
    kind: row.kind as MemoryKind,
    scope: row.scope as MemoryScope,
    content: row.content,
    sessionId: row.session_id,
    workspace: row.workspace,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: JSON.parse(row.tags),
    version: row.version,
    isLatest: !!row.is_latest,
    parentId: row.parent_id,
    rootId: row.root_id,
    sourceCount: row.source_count,
    isInference: !!row.is_inference,
    isStatic: !!row.is_static,
    forgetAfter: row.forget_after,
    forgotten: !!row.forgotten,
    forgetReason: row.forget_reason,
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.access_count > 0 ? { accessCount: row.access_count } : {}),
    ...(row.observation_type ? { observationType: row.observation_type as ObservationType } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.facts && row.facts !== '[]' ? { facts: JSON.parse(row.facts) } : {}),
    ...(row.observation_tags && row.observation_tags !== '[]' ? { observationTags: JSON.parse(row.observation_tags) } : {}),
    ...(row.files_read && row.files_read !== '[]' ? { filesRead: JSON.parse(row.files_read) } : {}),
    ...(row.files_modified && row.files_modified !== '[]' ? { filesModified: JSON.parse(row.files_modified) } : {}),
    ...(row.file_change_count > 0 ? { fileChangeCount: row.file_change_count } : {}),
    ...(row.search_terms && row.search_terms !== '[]' ? { searchTerms: JSON.parse(row.search_terms) } : {}),
    ...(row.pinned ? { pinned: true } : {}),
  };
}
