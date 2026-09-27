import type { MemoryKind, MemoryScope } from './memory';

export type InjectionTier = 'full' | 'compact';

export type InjectionReason =
  | { kind: 'matched'; terms: string[] }
  | { kind: 'file'; path: string; source: 'editor' | 'prompt' }
  | { kind: 'mentioned' }
  | { kind: 'pinned' }
  | { kind: 'session' }
  | { kind: 'preference' }
  | { kind: 'replacement'; replacesId: string };

export interface MemoryScoreBreakdown {
  relevance: number;
  matchedIdf: number;
  queryIdf: number;
  fileProximity: number;
  recency: number;
  retrievalBoost: number;
  sourceCountBoost: number;
  stalenessPenalty: number;
}

export interface InjectedMemory {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  title: string | null;
  content: string;
  facts: string[];
  files: string[];
  tier: InjectionTier;
  truncated: boolean;
  upgradedFromCompact: boolean;
  tokens: number;
  reasons: InjectionReason[];
  /** Null for entries that are not ranked: mentioned, pinned, session, preference, replacement. */
  score: number | null;
  scoreBreakdown: MemoryScoreBreakdown | null;
  isStale: boolean;
  isPinned: boolean;
  sourceCount: number;
  /** True for a mentioned memory the user has forgotten; it is shown but not tracked as in context. */
  isForgotten?: boolean;
  rerankRelevance?: 'high' | 'medium' | 'low';
  rerankReason?: string;
}

export interface CarriedMemory {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  title: string | null;
  snippet: string;
  tier: InjectionTier;
  injectedAtPrompt: number;
  isPinned: boolean;
}

export interface MemoryNotice {
  kind: 'superseded' | 'edited' | 'forgotten';
  id: string;
  title: string | null;
  snippet: string;
  replacementId: string | null;
  tokens: number;
}

export interface MemoryInjectionDisplay {
  version: 3;
  promptIndex: number;
  /** Render order. */
  added: InjectedMemory[];
  notices: MemoryNotice[];
  /** Live before this prompt and still current. */
  carried: CarriedMemory[];
  profile: { state: 'injected' | 'inContext' | 'empty' | 'disabled'; tokens: number; text: string };
  /** `text` is the status line sent with this prompt, '' unless `state` is 'injected'. */
  compass: { state: 'injected' | 'unchanged' | 'disabled'; text: string };
  query: {
    terms: string[];
    dropped: Array<{ term: string; reason: 'id' | 'common' }>;
    mentionedIds: string[];
    files: Array<{ path: string; source: 'editor' | 'prompt' }>;
  };
  gate: {
    considered: number;
    passed: number;
    unmatchedSkipped: number;
    alreadyInContext: number;
    overBudget: number;
    preferencesDeferred: number;
  };
  tokens: { memories: number; notices: number; profile: number; compass: number; total: number; budget: number };
  storeCounts: { session: number; project: number; global: number; observations: number; total: number };
  rerankApplied: boolean;
  /** The literal custom-message content the model received; '' when nothing was sent. */
  exactText: string;
}
