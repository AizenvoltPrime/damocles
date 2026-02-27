import type { MemoryEntry, MemoryTier, ObservationType } from '@shared/types/memory';

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
  close(): void;
}

export interface MemoryRow {
  id: string;
  tier: string;
  content: string;
  session_id: string | null;
  workspace: string | null;
  created_at: number;
  updated_at: number;
  tags: string;
  observation_type: string | null;
  title: string | null;
  facts: string;
  observation_tags: string;
  files_read: string;
  files_modified: string;
  access_count: number;
  file_change_count: number;
  search_terms: string;
  pinned: number;
}

export interface FtsMatchRow {
  id: string;
  rank: number;
}

export function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    tier: row.tier as MemoryTier,
    content: row.content,
    sessionId: row.session_id,
    workspace: row.workspace,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: JSON.parse(row.tags),
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
