import type { MemoryKind, MemoryScope } from './memory';

export interface MemoryScoreBreakdown {
  ftsRelevance: number;
  recency: number;
  scopeWeight: number;
  fileProximity: number;
  retrievalBoost: number;
  sourceCountBoost: number;
  stalenessPenalty: number;
}

export interface MemoryInjectionEntry {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  title: string | null;
  content: string;
  score: number;
  scoreBreakdown: MemoryScoreBreakdown;
  estimatedTokens: number;
  isStale: boolean;
  isPinned: boolean;
  sourceCount?: number;
  rerankRelevance?: 'high' | 'medium' | 'low';
  reason?: string;
}

/** One display group of injected catalog entries, keyed by a stable label. */
export interface MemoryInjectionGroup {
  label: 'session' | 'project' | 'global' | 'observations';
  entryLimit: number;
  entries: MemoryInjectionEntry[];
  totalAvailable: number;
  tokensUsed: number;
}

export interface MemoryInjectionDisplay {
  groups: MemoryInjectionGroup[];
  totalTokensUsed: number;
  ftsQuery: string | null;
  hasHandoffContext: boolean;
  hasProfile: boolean;
  rerankApplied: boolean;
  pinnedEntries: MemoryInjectionEntry[];
  pinnedBudget: number;
  pinnedTokensUsed: number;
}
