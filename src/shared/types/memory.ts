export type MemoryTier = 'session' | 'project' | 'global' | 'note' | 'observation';

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
}

export interface SearchResult {
  id: string;
  tier: MemoryTier;
  title: string | null;
  snippet: string;
  rank: number;
  timestamp: number;
  observationType?: ObservationType;
}

export interface TimelineEntry {
  id: string;
  tier: MemoryTier;
  title: string | null;
  snippet: string;
  observationType?: ObservationType;
  timestamp: number;
}
