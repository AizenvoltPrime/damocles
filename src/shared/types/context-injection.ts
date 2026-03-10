import type { MemoryTier } from './memory';

export interface MemoryScoreBreakdown {
  ftsRelevance: number;
  recency: number;
  tierWeight: number;
  fileProximity: number;
  retrievalBoost: number;
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
  isPinned: boolean;
}

export interface MemoryTierInjection {
  tier: MemoryTier;
  entryLimit: number;
  entries: MemoryInjectionEntry[];
  totalAvailable: number;
  tokensUsed: number;
}

export interface MemoryInjectionDisplay {
  tiers: MemoryTierInjection[];
  totalTokensUsed: number;
  ftsQuery: string | null;
  hasHandoffContext: boolean;
  pinnedEntries: MemoryInjectionEntry[];
  pinnedBudget: number;
  pinnedTokensUsed: number;
}
