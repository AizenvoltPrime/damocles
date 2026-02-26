import type { MemoryTier } from './memory';

export interface ContextInjectionDisplay {
  promptIndex: number;
  bm25Context: string | null;
  rerankedContext: string | null;
  injectedContext: string;
  entryCount: number;
  rerankingEnabled: boolean;
  tokenBudget: number;
  planFilePath: string | null;
  decompositionFacets: string[] | null;
  createdAt: number;
}

export interface MemoryScoreBreakdown {
  ftsRelevance: number;
  recency: number;
  tierWeight: number;
  fileProximity: number;
  accessBoost: number;
  stalenessPenalty: number;
}

export interface MemoryInjectionEntry {
  id: string;
  tier: MemoryTier;
  title: string | null;
  content: string;
  score: number;
  scoreBreakdown: MemoryScoreBreakdown;
  estimatedTokens: number;
  isStale: boolean;
}

export interface MemoryTierInjection {
  tier: MemoryTier;
  budget: number;
  effectiveBudget: number;
  tokensUsed: number;
  entries: MemoryInjectionEntry[];
  totalAvailable: number;
}

export type QueryExpansionMode = 'off' | 'adaptive' | 'always';

export interface ExpansionDecision {
  mode: QueryExpansionMode;
  triggered: boolean;
  reason: string | null;
  firstPassMatches: number;
  firstPassCandidates: number;
}

export interface MemoryInjectionDisplay {
  tiers: MemoryTierInjection[];
  totalTokensUsed: number;
  totalBudget: number;
  ftsQuery: string | null;
  expandedTerms: string[] | null;
  confidenceMultiplier: number;
  hasHandoffContext: boolean;
  expansionDecision: ExpansionDecision | null;
}
