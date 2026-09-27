import type { CarriedMemory, InjectedMemory, MemoryInjectionDisplay } from '@shared/types/context-injection';

export const ID_A = '11111111-1111-4111-8111-111111111111';
export const ID_B = '22222222-2222-4222-8222-222222222222';
export const ID_C = '33333333-3333-4333-8333-333333333333';

export function injected(overrides: Partial<InjectedMemory> = {}): InjectedMemory {
  return {
    id: ID_A,
    scope: 'project',
    kind: 'fact',
    title: null,
    content: 'Run vitest through the PowerShell tool on Windows.',
    facts: [],
    files: [],
    tier: 'full',
    truncated: false,
    upgradedFromCompact: false,
    tokens: 14,
    reasons: [{ kind: 'matched', terms: ['vitest', 'powershell'] }],
    score: 0.52,
    scoreBreakdown: {
      relevance: 0.6,
      matchedIdf: 3,
      queryIdf: 5,
      fileProximity: 0,
      recency: 0.8,
      retrievalBoost: 0.2,
      sourceCountBoost: 0.05,
      stalenessPenalty: 1,
    },
    isStale: false,
    isPinned: false,
    sourceCount: 1,
    ...overrides,
  };
}

export function carried(overrides: Partial<CarriedMemory> = {}): CarriedMemory {
  return {
    id: ID_C,
    scope: 'global',
    kind: 'preference',
    title: null,
    snippet: 'Prefers terse commit messages.',
    tier: 'full',
    injectedAtPrompt: 0,
    isPinned: false,
    ...overrides,
  };
}

export function display(overrides: Partial<MemoryInjectionDisplay> = {}): MemoryInjectionDisplay {
  return {
    version: 3,
    promptIndex: 2,
    added: [injected()],
    notices: [],
    carried: [carried()],
    profile: { state: 'inContext', tokens: 0, text: '' },
    compass: { state: 'unchanged', text: '' },
    query: {
      terms: ['vitest', 'powershell'],
      dropped: [
        { term: '985d5b12', reason: 'id' },
        { term: 'the', reason: 'common' },
      ],
      mentionedIds: [],
      files: [],
    },
    gate: { considered: 40, passed: 3, unmatchedSkipped: 30, alreadyInContext: 5, overBudget: 1, preferencesDeferred: 1 },
    tokens: { memories: 120, notices: 10, profile: 0, compass: 20, total: 150, budget: 2000 },
    storeCounts: { session: 2, project: 30, global: 10, observations: 58, total: 100 },
    rerankApplied: false,
    exactText: '<damocles_memory>…</damocles_memory>',
    ...overrides,
  };
}
