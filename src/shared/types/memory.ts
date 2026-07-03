/**
 * Server-side content bound shared by every write path. The prose-JSON tool fallback can bypass
 * schema validation, so the service layer clamps to this to keep a runaway payload out of the FTS row.
 */
export const MAX_MEMORY_CONTENT_CHARS = 20000;

// Keyset pagination cursor for observations. Opaque to the webview: only the
// extension builds it from DB rows; the store just holds and echoes it back.
export type ObservationCursor = { createdAt: number; id: string };

export type MemoryTier = 'session' | 'project' | 'global' | 'note' | 'observation';

export type MemoryKind = 'fact' | 'preference' | 'observation' | 'note' | 'episode';

export type MemoryScope = 'session' | 'project' | 'global';

export type ObservationType = 'implementation' | 'fix' | 'refactor' | 'architecture' | 'insight' | 'environment';

export type ObservationTag = 'mechanism' | 'rationale' | 'impact' | 'caveat' | 'approach' | 'dependency' | 'performance';

export interface MemoryEntry {
  id: string;
  tier: MemoryTier;
  content: string;
  sessionId: string | null;
  workspace: string | null;
  createdAt: number;
  updatedAt: number;
  tags: string[];
  observationType?: ObservationType;
  title?: string;
  facts?: string[];
  observationTags?: ObservationTag[];
  filesRead?: string[];
  filesModified?: string[];
  accessCount?: number;
  fileChangeCount?: number;
  searchTerms?: string[];
  pinned?: boolean;
  kind?: MemoryKind;
  scope?: MemoryScope;
  summary?: string;
  version?: number;
  isLatest?: boolean;
  parentId?: string | null;
  rootId?: string | null;
  sourceCount?: number;
  isInference?: boolean;
  isStatic?: boolean;
  forgetAfter?: number | null;
  forgotten?: boolean;
  forgetReason?: string | null;
}

export interface ObservationInput {
  type: ObservationType;
  title: string;
  content: string;
  facts: string[];
  observationTags?: ObservationTag[];
  filesRead?: string[];
  filesModified?: string[];
}

export interface SearchQuery {
  query?: string;
  files?: string[];
  types?: ObservationType[];
  tiers?: MemoryTier[];
  since?: number;
  until?: number;
  limit?: number;
  includeForgotten?: boolean;
  workspace?: string;
  sessionId?: string;
  allWorkspaces?: boolean;
}

export interface SearchResult {
  id: string;
  tier: MemoryTier;
  title: string | null;
  snippet: string;
  rank: number;
  timestamp: number;
  observationType?: ObservationType;
  rerankRelevance?: 'high' | 'medium' | 'low';
  reason?: string;
}

export interface TimelineEntry {
  id: string;
  tier: MemoryTier;
  title: string | null;
  snippet: string;
  observationType?: ObservationType;
  timestamp: number;
}

/** Auto-maintained per-scope profile: a stable `static` section and a recent-activity `dynamic` section. */
export interface UserProfile {
  static: string;
  dynamic: string;
}
