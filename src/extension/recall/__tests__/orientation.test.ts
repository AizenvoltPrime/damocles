import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StructuredTurn } from '../types';
import type { SubCallHandler } from '../sub-call-handler';

vi.mock('../../memory/query-expansion', () => ({
  expandQuery: vi.fn(),
}));

vi.mock('../../logger', () => ({ log: vi.fn() }));

import { expandQuery } from '../../memory/query-expansion';
import {
  buildOrientationContext,
  formatOrientationForPrompt,
  parseInvestigatorResponse,
  deduplicateHits,
  type OrientationContext,
} from '../orientation';

const mockExpandQuery = vi.mocked(expandQuery);

function makeTurn(index: number, overrides: Partial<StructuredTurn> = {}): StructuredTurn {
  return {
    promptIndex: index,
    timestamp: new Date().toISOString(),
    userMessage: `User message for prompt ${index}`,
    assistantResponse: `Assistant response for prompt ${index}`,
    toolCalls: [],
    contentBlocks: [],
    thinkingBlocks: [],
    filesTouched: [],
    nodeId: null,
    summary: null,
    keywords: null,
    ...overrides,
  };
}

function makeSubCallHandler(queryBatchedImpl?: (...args: unknown[]) => unknown): SubCallHandler {
  return {
    queryBatched: vi.fn(queryBatchedImpl ?? (() => Promise.resolve([]))),
    query: vi.fn(),
    abort: vi.fn(),
  } as unknown as SubCallHandler;
}

describe('buildOrientationContext: basic flow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns expanded terms, BM25 results, turn index, and duration', async () => {
    mockExpandQuery.mockResolvedValue(['auth', 'jwt']);
    const handler = makeSubCallHandler();

    const history = [
      makeTurn(0, {
        userMessage: 'Fix the auth token validation bug',
        assistantResponse: 'I updated the jwt verification middleware',
        filesTouched: ['src/auth/jwt.ts'],
      }),
      makeTurn(1, {
        userMessage: 'Add refresh token rotation for auth',
        assistantResponse: 'Implemented jwt refresh token rotation in the auth service',
        filesTouched: ['src/auth/refresh.ts'],
      }),
    ];

    const result = await buildOrientationContext(history, 'fix auth jwt issue', handler);

    expect(result.expandedTerms).toEqual(['auth', 'jwt']);
    expect(result.bm25Results.length).toBeGreaterThan(0);
    expect(result.turnIndex).toHaveLength(2);
    expect(result.turnIndex[0]!.promptIndex).toBe(0);
    expect(result.turnIndex[1]!.promptIndex).toBe(1);
    expect(result.investigationReport).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('populates turnIndex with summary fallback from userMessage', async () => {
    mockExpandQuery.mockResolvedValue([]);
    const handler = makeSubCallHandler();

    const history = [
      makeTurn(0, {
        userMessage: 'Short message',
        filesTouched: ['src/a.ts'],
        keywords: ['keyword1'],
      }),
    ];

    const result = await buildOrientationContext(history, 'unrelated query xyz', handler);

    expect(result.turnIndex[0]!.summary).toBe('Short message');
    expect(result.turnIndex[0]!.filesTouched).toEqual(['src/a.ts']);
    expect(result.turnIndex[0]!.keywords).toEqual(['keyword1']);
  });

  it('uses summary field when available', async () => {
    mockExpandQuery.mockResolvedValue([]);
    const handler = makeSubCallHandler();

    const history = [
      makeTurn(0, { summary: 'Fixed auth middleware', keywords: ['auth', 'middleware'] }),
    ];

    const result = await buildOrientationContext(history, 'query', handler);

    expect(result.turnIndex[0]!.summary).toBe('Fixed auth middleware');
    expect(result.turnIndex[0]!.keywords).toEqual(['auth', 'middleware']);
  });
});

describe('buildOrientationContext: low-confidence triggers investigation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls queryBatched when top BM25 score is below threshold', async () => {
    mockExpandQuery.mockResolvedValue([]);

    const investigationResponse = JSON.stringify([
      { turnIndex: 0, relevance: 'medium', reason: 'tangentially related to config' },
    ]);
    const handler = makeSubCallHandler(() => Promise.resolve([investigationResponse]));

    const history = [
      makeTurn(0, {
        userMessage: 'update the database migration schema',
        assistantResponse: 'migrated the postgres tables to the new schema format',
        filesTouched: ['src/db/migration.ts'],
      }),
    ];

    const result = await buildOrientationContext(history, 'fix authentication jwt tokens', handler);

    expect(result.investigationReport).not.toBeNull();
    expect(handler.queryBatched).toHaveBeenCalled();
  });

  it('includes parsed investigation hits in the report', async () => {
    mockExpandQuery.mockResolvedValue([]);

    const investigationResponse = JSON.stringify([
      { turnIndex: 0, relevance: 'high', reason: 'config change affects auth' },
      { turnIndex: 1, relevance: 'low', reason: 'minor mention' },
    ]);
    const handler = makeSubCallHandler(() => Promise.resolve([investigationResponse]));

    const history = [
      makeTurn(0, {
        userMessage: 'refactor the config loader',
        assistantResponse: 'restructured config parsing logic',
        filesTouched: ['src/config/loader.ts'],
      }),
      makeTurn(1, {
        userMessage: 'clean up unused imports',
        assistantResponse: 'removed unused import statements',
        filesTouched: ['src/utils/helpers.ts'],
      }),
    ];

    const result = await buildOrientationContext(history, 'fix authentication jwt', handler);

    expect(result.investigationReport).toContain('Turn 0');
    expect(result.investigationReport).toContain('high');
    expect(result.investigationReport).toContain('config change affects auth');
  });
});

describe('buildOrientationContext: high-confidence skips investigation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not call queryBatched when BM25 scores are high', async () => {
    mockExpandQuery.mockResolvedValue(['authentication', 'token', 'login']);
    const handler = makeSubCallHandler();

    const history = [
      makeTurn(0, {
        userMessage: 'fix the authentication token validation in the login handler',
        assistantResponse: 'updated authentication token verification for login flow',
        filesTouched: ['src/auth/token.ts', 'src/auth/login.ts'],
        keywords: ['authentication', 'token', 'login', 'validation'],
      }),
      makeTurn(1, {
        userMessage: 'refactor the database migration runner',
        assistantResponse: 'restructured the migration runner to support rollbacks',
        filesTouched: ['src/db/migrate.ts'],
        keywords: ['database', 'migration', 'rollback'],
      }),
      makeTurn(2, {
        userMessage: 'update the styling for the dashboard widgets',
        assistantResponse: 'applied new CSS grid layout to dashboard widget cards',
        filesTouched: ['src/ui/dashboard.css'],
        keywords: ['dashboard', 'css', 'widgets', 'styling'],
      }),
      makeTurn(3, {
        userMessage: 'optimize the image compression pipeline',
        assistantResponse: 'switched to webp format and added caching layer',
        filesTouched: ['src/media/compress.ts'],
        keywords: ['image', 'compression', 'webp', 'cache'],
      }),
    ];

    const result = await buildOrientationContext(history, 'authentication token login', handler);

    expect(result.investigationReport).toBeNull();
    expect(handler.queryBatched).not.toHaveBeenCalled();
    expect(result.bm25Results.length).toBeGreaterThan(0);
    expect(result.bm25Results[0]!.score).toBeGreaterThanOrEqual(2.0);
  });
});

describe('parseInvestigatorResponse', () => {
  it('parses valid JSON array', () => {
    const input = '[{"turnIndex": 1, "relevance": "high", "reason": "matches auth"}]';
    const result = parseInvestigatorResponse(input);

    expect(result).toEqual([{ turnIndex: 1, relevance: 'high', reason: 'matches auth' }]);
  });

  it('extracts JSON array from surrounding text', () => {
    const input = 'Here are the findings:\n[{"turnIndex": 3, "relevance": "low", "reason": "minor ref"}]\nDone.';
    const result = parseInvestigatorResponse(input);

    expect(result).toEqual([{ turnIndex: 3, relevance: 'low', reason: 'minor ref' }]);
  });

  it('returns empty array for malformed JSON', () => {
    expect(parseInvestigatorResponse('not json at all')).toEqual([]);
    expect(parseInvestigatorResponse('{not: valid}')).toEqual([]);
    expect(parseInvestigatorResponse('[{broken')).toEqual([]);
  });

  it('returns empty array for empty JSON array', () => {
    expect(parseInvestigatorResponse('[]')).toEqual([]);
  });

  it('filters items with missing required fields', () => {
    const input = JSON.stringify([
      { turnIndex: 1, relevance: 'high', reason: 'valid' },
      { relevance: 'high', reason: 'missing turnIndex' },
      { turnIndex: 2, reason: 'missing relevance' },
      { turnIndex: 3, relevance: 'high' },
    ]);

    const result = parseInvestigatorResponse(input);

    expect(result).toHaveLength(1);
    expect(result[0]!.turnIndex).toBe(1);
  });

  it('filters items with invalid relevance values', () => {
    const input = JSON.stringify([
      { turnIndex: 1, relevance: 'high', reason: 'valid' },
      { turnIndex: 2, relevance: 'critical', reason: 'invalid level' },
      { turnIndex: 3, relevance: 'medium', reason: 'also valid' },
      { turnIndex: 4, relevance: '', reason: 'empty relevance' },
    ]);

    const result = parseInvestigatorResponse(input);

    expect(result).toHaveLength(2);
    expect(result.map(r => r.turnIndex)).toEqual([1, 3]);
  });

  it('truncates reason to 150 characters', () => {
    const longReason = 'a'.repeat(200);
    const input = JSON.stringify([
      { turnIndex: 0, relevance: 'high', reason: longReason },
    ]);

    const result = parseInvestigatorResponse(input);

    expect(result[0]!.reason).toHaveLength(150);
  });

  it('returns empty array when no brackets found', () => {
    expect(parseInvestigatorResponse('no brackets here')).toEqual([]);
  });

  it('returns empty array when brackets are in wrong order', () => {
    expect(parseInvestigatorResponse('] before [')).toEqual([]);
  });
});

describe('deduplicateHits', () => {
  it('keeps highest relevance for each turnIndex', () => {
    const hits = [
      { turnIndex: 1, relevance: 'low', reason: 'first' },
      { turnIndex: 1, relevance: 'high', reason: 'second' },
      { turnIndex: 1, relevance: 'medium', reason: 'third' },
    ];

    const result = deduplicateHits(hits);

    expect(result).toHaveLength(1);
    expect(result[0]!.relevance).toBe('high');
    expect(result[0]!.reason).toBe('second');
  });

  it('passes through unique entries unchanged', () => {
    const hits = [
      { turnIndex: 0, relevance: 'high', reason: 'first' },
      { turnIndex: 1, relevance: 'medium', reason: 'second' },
      { turnIndex: 2, relevance: 'low', reason: 'third' },
    ];

    const result = deduplicateHits(hits);

    expect(result).toHaveLength(3);
    expect(result).toEqual(hits);
  });

  it('returns empty array for empty input', () => {
    expect(deduplicateHits([])).toEqual([]);
  });

  it('handles multiple duplicate turnIndices', () => {
    const hits = [
      { turnIndex: 0, relevance: 'low', reason: 'a' },
      { turnIndex: 1, relevance: 'low', reason: 'b' },
      { turnIndex: 0, relevance: 'medium', reason: 'c' },
      { turnIndex: 1, relevance: 'high', reason: 'd' },
    ];

    const result = deduplicateHits(hits);

    expect(result).toHaveLength(2);
    const turn0 = result.find(h => h.turnIndex === 0);
    const turn1 = result.find(h => h.turnIndex === 1);
    expect(turn0!.relevance).toBe('medium');
    expect(turn1!.relevance).toBe('high');
  });
});

describe('formatOrientationForPrompt', () => {
  it('includes expanded terms section when present', () => {
    const orientation: OrientationContext = {
      expandedTerms: ['authentication', 'token'],
      bm25Results: [],
      turnIndex: [],
      investigationReport: null,
      durationMs: 50,
    };

    const result = formatOrientationForPrompt(orientation, 'fix auth');

    expect(result).toContain('EXPANDED TERMS');
    expect(result).toContain('"fix auth"');
    expect(result).toContain('authentication, token');
  });

  it('includes BM25 results section with scores', () => {
    const orientation: OrientationContext = {
      expandedTerms: [],
      bm25Results: [
        { turnIndex: 0, promptIndex: 0, score: 5.2, preview: 'Fix the auth bug' },
        { turnIndex: 3, promptIndex: 3, score: 2.8, preview: 'Update token handler' },
      ],
      turnIndex: [],
      investigationReport: null,
      durationMs: 50,
    };

    const result = formatOrientationForPrompt(orientation, 'auth');

    expect(result).toContain('TOP TURNS BY KEYWORD RELEVANCE');
    expect(result).toContain('[Turn 0]');
    expect(result).toContain('5.2');
    expect(result).toContain('Fix the auth bug');
    expect(result).toContain('[Turn 3]');
    expect(result).toContain('2.8');
  });

  it('includes investigation report when present', () => {
    const orientation: OrientationContext = {
      expandedTerms: [],
      bm25Results: [],
      turnIndex: [],
      investigationReport: 'Turn 5 [high]: auth config change detected',
      durationMs: 100,
    };

    const result = formatOrientationForPrompt(orientation, 'auth');

    expect(result).toContain('INVESTIGATION');
    expect(result).toContain('Turn 5 [high]: auth config change detected');
  });

  it('shows no keyword matches message when bm25Results is empty', () => {
    const orientation: OrientationContext = {
      expandedTerms: [],
      bm25Results: [],
      turnIndex: [],
      investigationReport: null,
      durationMs: 50,
    };

    const result = formatOrientationForPrompt(orientation, 'query');

    expect(result).toContain('No keyword matches');
  });

  it('omits expanded terms section when empty', () => {
    const orientation: OrientationContext = {
      expandedTerms: [],
      bm25Results: [{ turnIndex: 0, promptIndex: 0, score: 3.0, preview: 'test' }],
      turnIndex: [],
      investigationReport: null,
      durationMs: 50,
    };

    const result = formatOrientationForPrompt(orientation, 'query');

    expect(result).not.toContain('EXPANDED TERMS');
  });

  it('omits investigation section when null', () => {
    const orientation: OrientationContext = {
      expandedTerms: ['term1'],
      bm25Results: [{ turnIndex: 0, promptIndex: 0, score: 3.0, preview: 'test' }],
      turnIndex: [],
      investigationReport: null,
      durationMs: 50,
    };

    const result = formatOrientationForPrompt(orientation, 'query');

    expect(result).not.toContain('INVESTIGATION');
  });

  it('includes all sections when all data is present', () => {
    const orientation: OrientationContext = {
      expandedTerms: ['expanded1'],
      bm25Results: [{ turnIndex: 0, promptIndex: 0, score: 4.5, preview: 'relevant turn' }],
      turnIndex: [],
      investigationReport: 'Turn 2 [medium]: found indirect evidence',
      durationMs: 200,
    };

    const result = formatOrientationForPrompt(orientation, 'my query');

    expect(result).toContain('EXPANDED TERMS');
    expect(result).toContain('TOP TURNS BY KEYWORD RELEVANCE');
    expect(result).toContain('INVESTIGATION');
  });
});
