import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StructuredTurn } from '../types';
import { DEFAULT_SUBCALL_MODEL } from '../types';
import {
  createCardGameHistory,
  createWebAppHistory,
  createLargeHistory,
  createOverlappingHistory,
} from './fixtures/histories';
import { scoreRetrieval } from './fixtures/mock-sdk';
import { padHistory, makeDefaultConfig } from './fixtures/integration-helpers';
import { createBM25Index } from '../bm25';

const INTEGRATION = !!process.env['DAMOCLES_INTEGRATION'];
const ROOT_MODEL = 'claude-sonnet-4-6';
const SUBCALL_MODEL = DEFAULT_SUBCALL_MODEL;
const suite = INTEGRATION ? describe : describe.skip;

// ─────────────────────────────────────────────────────────────────────────────
// Integration Tests: Orientation Pipeline, Turn Indexer, BM25
//
// These tests validate the NEW two-stage recall architecture with real models:
//
//   Stage 1 — Auto-Orientation (no root model):
//     - Query expansion via Haiku (memory module)
//     - BM25 ranking against turn text + keywords
//     - Chunk investigation (conditional, low-confidence queries)
//
//   Stage 2 — Oriented Retrieval (root model):
//     - Pre-ranked results injected into system prompt
//     - text_search() and turn_index available as REPL tools
//     - Max 8 iterations (vs 15 unoriented)
//
// Also validates the Turn Indexer (write-time Haiku-powered enrichment).
//
// Run:
//   DAMOCLES_INTEGRATION=1 npx vitest run src/extension/recall/__tests__/integration-orientation.test.ts
//
// Cost: ~$0.30-0.60 per full run
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: Turn Indexer — real Haiku structured output
//
// Validates that haikuStructuredQuery produces meaningful summaries and
// domain-specific keywords for realistic conversation turns. The indexer
// runs at write-time on every turn; quality here determines BM25 and
// orientation effectiveness downstream.
// ─────────────────────────────────────────────────────────────────────────────

suite('orientation: turn indexer (real Haiku)', () => {
  let haikuStructuredQuery: typeof import('../haiku-query').haikuStructuredQuery;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
    const module = await import('../haiku-query');
    haikuStructuredQuery = module.haikuStructuredQuery;
  });

  const TURN_INDEX_SCHEMA = {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'One sentence summarizing what happened in this conversation turn',
      },
      keywords: {
        type: 'array',
        items: { type: 'string' },
        minItems: 3,
        maxItems: 10,
        description: 'Domain-specific keywords: file paths, technical terms, component names, error types, concepts',
      },
    },
    required: ['summary', 'keywords'],
    additionalProperties: false,
  };

  const SYSTEM_PROMPT =
    'Summarize this conversation turn in one sentence and extract 5-10 domain-specific keyword tags. ' +
    'Keywords must be: file paths, technical terms, component names, error types, API names, concepts. ' +
    'Do NOT include generic words like "fix", "update", "help", "code", "file", "implement". ' +
    'Focus on words someone would search for to find this specific conversation.';

  function buildUserMessage(turn: StructuredTurn): string {
    const userSlice = turn.userMessage.slice(0, 500);
    const assistantSlice = turn.assistantResponse.slice(0, 1000);
    const files = turn.filesTouched.join(', ');
    const tools = turn.toolCalls.map(tc => tc.name).join(', ');
    return [
      `User: ${userSlice}`,
      `Assistant: ${assistantSlice}`,
      files ? `Files touched: ${files}` : '',
      tools ? `Tools used: ${tools}` : '',
    ].filter(Boolean).join('\n');
  }

  it('produces summary and keywords for an auth turn', async () => {
    const result = await haikuStructuredQuery<{ summary: string; keywords: string[] }>({
      systemPrompt: SYSTEM_PROMPT,
      userMessage: [
        'User: Fix the JWT refresh token rotation vulnerability where stolen tokens can be replayed',
        'Assistant: Fixed refresh token reuse detection. Invalidate entire token family on reuse. Prevents replay attacks.',
        'Files touched: src/auth/refresh.ts',
        'Tools used: Read, Edit',
      ].join('\n'),
      schema: TURN_INDEX_SCHEMA,
      cwd: process.cwd(),
    });

    expect(result).not.toBeNull();
    expect(result!.summary.length).toBeGreaterThan(10);
    expect(result!.summary.length).toBeLessThan(300);
    expect(result!.keywords.length).toBeGreaterThanOrEqual(3);
    expect(result!.keywords.length).toBeLessThanOrEqual(10);

    const keywordsLower = result!.keywords.map(k => k.toLowerCase());
    const hasRelevantKeyword = keywordsLower.some(k =>
      k.includes('jwt') || k.includes('refresh') || k.includes('token') ||
      k.includes('auth') || k.includes('replay') || k.includes('rotation'),
    );
    expect(hasRelevantKeyword).toBe(true);
  }, 30_000);

  it('produces domain-specific keywords for a UI/CSS turn', async () => {
    const result = await haikuStructuredQuery<{ summary: string; keywords: string[] }>({
      systemPrompt: SYSTEM_PROMPT,
      userMessage: [
        'User: The card hand display has a flickering bug when hovering over cards',
        'Assistant: The flickering is caused by a z-index race condition. When a card rises on hover, it overlaps with adjacent cards, triggering their mouse_entered signals. Fixed with a 50ms debounce and a _hover_locked mutex.',
        'Files touched: src/HandDisplay.gd',
        'Tools used: Edit',
      ].join('\n'),
      schema: TURN_INDEX_SCHEMA,
      cwd: process.cwd(),
    });

    expect(result).not.toBeNull();
    const keywordsLower = result!.keywords.map(k => k.toLowerCase());
    const hasDomainKeyword = keywordsLower.some(k =>
      k.includes('z-index') || k.includes('flicker') || k.includes('hover') ||
      k.includes('debounce') || k.includes('mutex') || k.includes('handdisplay') ||
      k.includes('race condition'),
    );
    expect(hasDomainKeyword).toBe(true);
  }, 30_000);

  it('excludes generic words from keywords', async () => {
    const result = await haikuStructuredQuery<{ summary: string; keywords: string[] }>({
      systemPrompt: SYSTEM_PROMPT,
      userMessage: [
        'User: Add WebSocket support for real-time notifications',
        'Assistant: Set up Socket.IO server with authentication middleware. Clients connect with JWT and join user-specific rooms.',
        'Files touched: src/websocket/server.ts',
      ].join('\n'),
      schema: TURN_INDEX_SCHEMA,
      cwd: process.cwd(),
    });

    expect(result).not.toBeNull();
    const keywordsLower = result!.keywords.map(k => k.toLowerCase());
    const genericWords = ['fix', 'update', 'help', 'code', 'file', 'implement'];
    for (const generic of genericWords) {
      expect(keywordsLower).not.toContain(generic);
    }
  }, 30_000);

  it('produces consistent quality across multiple diverse turns', async () => {
    const inputs = [
      [
        'User: Set up PostgreSQL database with Prisma ORM',
        'Assistant: Created Prisma schema with User, Post, Comment models. Added PrismaClient singleton to prevent connection pooling issues.',
        'Files touched: prisma/schema.prisma, src/lib/db.ts',
      ].join('\n'),
      [
        'User: Configure Redis cluster for production caching',
        'Assistant: Configured ioredis with 3 master nodes, 1 replica each. Set up automatic failover with Sentinel. Connection pooling min 5, max 20.',
        'Files touched: src/cache/redis-cluster.ts',
      ].join('\n'),
    ];

    const results: Array<{ summary: string; keywords: string[] } | null> = [];
    for (const input of inputs) {
      const result = await haikuStructuredQuery<{ summary: string; keywords: string[] }>({
        systemPrompt: SYSTEM_PROMPT,
        userMessage: input,
        schema: TURN_INDEX_SCHEMA,
        cwd: process.cwd(),
      });
      results.push(result);
    }

    for (const result of results) {
      expect(result).not.toBeNull();
      expect(result!.summary.length).toBeGreaterThan(10);
      expect(result!.keywords.length).toBeGreaterThanOrEqual(3);
    }

    const dbKeywords = results[0]!.keywords.map(k => k.toLowerCase());
    const cacheKeywords = results[1]!.keywords.map(k => k.toLowerCase());

    expect(dbKeywords.some(k => k.includes('prisma') || k.includes('postgres') || k.includes('database'))).toBe(true);
    expect(cacheKeywords.some(k => k.includes('redis') || k.includes('cache') || k.includes('ioredis'))).toBe(true);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: Orientation Pipeline — real query expansion + BM25 + investigation
//
// Tests buildOrientationContext() with real Haiku calls for query expansion
// and chunk investigation. BM25 is pure JS (no model call), but its quality
// depends on the turn data (and enriched keywords from the indexer).
// ─────────────────────────────────────────────────────────────────────────────

suite('orientation: pipeline (real Haiku)', () => {
  let buildOrientationContext: typeof import('../orientation').buildOrientationContext;
  let SubCallHandler: typeof import('../sub-call-handler').SubCallHandler;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
    const orientationModule = await import('../orientation');
    buildOrientationContext = orientationModule.buildOrientationContext;
    const subCallModule = await import('../sub-call-handler');
    SubCallHandler = subCallModule.SubCallHandler;
  });

  it('high-confidence query: BM25 ranks correct turn first, skips investigation', async () => {
    const history = createCardGameHistory();
    const handler = new SubCallHandler(process.cwd(), SUBCALL_MODEL);

    try {
      const result = await buildOrientationContext(
        history,
        'hover flickering bug in the card hand display',
        handler,
      );

      expect(result.bm25Results.length).toBeGreaterThan(0);
      expect(result.bm25Results[0]!.turnIndex).toBe(3);
      expect(result.bm25Results[0]!.score).toBeGreaterThanOrEqual(2.0);
      expect(result.investigationReport).toBeNull();
      expect(result.turnIndex).toHaveLength(history.length);
      expect(result.durationMs).toBeLessThan(15_000);
    } finally {
      handler.abort();
    }
  }, 30_000);

  it('low-confidence query: triggers chunk investigation and finds evidence', async () => {
    const history = createCardGameHistory();
    const handler = new SubCallHandler(process.cwd(), SUBCALL_MODEL);

    try {
      const result = await buildOrientationContext(
        history,
        'remember that thing we talked about before with the rendering',
        handler,
      );

      const topScore = result.bm25Results[0]?.score ?? 0;
      expect(topScore).toBeLessThan(2.0);
      expect(result.investigationReport).not.toBeNull();
      expect(result.investigationReport!.length).toBeGreaterThan(0);
      expect(result.investigationReport).toContain('Turn');
    } finally {
      handler.abort();
    }
  }, 60_000);

  it('query expansion enriches search for synonym-based queries', async () => {
    const history = createWebAppHistory();
    const handler = new SubCallHandler(process.cwd(), SUBCALL_MODEL);

    try {
      const result = await buildOrientationContext(
        history,
        'cross-origin request blocking issue',
        handler,
      );

      expect(result.bm25Results.length).toBeGreaterThan(0);

      const topIndices = result.bm25Results.slice(0, 3).map(r => r.turnIndex);
      expect(topIndices).toContain(3);
    } finally {
      handler.abort();
    }
  }, 30_000);

  it('phase callbacks fire in order: expanding → searching → investigating', async () => {
    const history = createCardGameHistory();
    const handler = new SubCallHandler(process.cwd(), SUBCALL_MODEL);
    const phases: string[] = [];

    try {
      await buildOrientationContext(
        history,
        'something completely unrelated like kubernetes deployment',
        handler,
        undefined,
        (phase) => { phases.push(phase); },
      );

      expect(phases[0]).toBe('expanding');
      expect(phases[1]).toBe('searching');
      if (phases.length > 2) {
        expect(phases[2]).toBe('investigating');
      }
    } finally {
      handler.abort();
    }
  }, 30_000);

  it('orientation with keyword-enriched turns produces better ranking', async () => {
    const baseHistory = createCardGameHistory();
    const enrichedHistory = baseHistory.map(t => ({
      ...t,
      summary: t.assistantResponse.slice(0, 80),
      keywords: t.promptIndex === 3
        ? ['z-index', 'race-condition', 'hover', 'flickering', 'debounce', 'mutex', 'HandDisplay.gd']
        : t.promptIndex === 5
          ? ['TurnManager', 'state-machine', 'mana-system', 'phases', 'draw', 'combat']
          : [],
    }));

    const handler = new SubCallHandler(process.cwd(), SUBCALL_MODEL);

    try {
      const baseResult = await buildOrientationContext(
        baseHistory,
        'z-index race condition debounce mutex',
        handler,
      );

      const enrichedResult = await buildOrientationContext(
        enrichedHistory,
        'z-index race condition debounce mutex',
        handler,
      );

      const baseScore = baseResult.bm25Results.find(r => r.turnIndex === 3)?.score ?? 0;
      const enrichedScore = enrichedResult.bm25Results.find(r => r.turnIndex === 3)?.score ?? 0;

      expect(enrichedScore).toBeGreaterThanOrEqual(baseScore);

      const enrichedRank = enrichedResult.bm25Results.findIndex(r => r.turnIndex === 3);
      expect(enrichedRank).toBe(0);
    } finally {
      handler.abort();
    }
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: Full Oriented Pipeline — Sonnet with orientation context
//
// Tests the complete two-stage architecture end-to-end:
//   1. Orientation auto-runs (query expansion + BM25 + investigation)
//   2. Sonnet enters REPL with pre-ranked results + text_search + turn_index
//   3. Validates that orientation improves retrieval and reduces iterations
// ─────────────────────────────────────────────────────────────────────────────

suite('orientation: full oriented pipeline (Sonnet)', () => {
  let runRecallLoop: typeof import('../recall-loop').runRecallLoop;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
    const recallModule = await import('../recall-loop');
    runRecallLoop = recallModule.runRecallLoop;
  });

  async function runOrientedPipeline(userPrompt: string, history: StructuredTurn[]) {
    const { context, trajectory } = await runRecallLoop(
      history, userPrompt, history.length,
      {
        config: makeDefaultConfig(),
        cwd: process.cwd(),
        model: ROOT_MODEL,
        nodeContext: null,
      },
    );
    return { context, trajectory };
  }

  it('oriented retrieval populates trajectory.orientation with real data', async () => {
    const history = padHistory(createCardGameHistory());
    const { trajectory } = await runOrientedPipeline(
      'show me the hover flickering bug fix',
      history,
    );

    expect(trajectory.orientation).not.toBeNull();
    expect(trajectory.orientation!.bm25Results.length).toBeGreaterThan(0);
    expect(trajectory.orientation!.durationMs).toBeGreaterThan(0);
    expect(trajectory.shortCircuited).toBe(false);
  }, 120_000);

  it('oriented pipeline retrieves correct context with fewer iterations', async () => {
    const history = padHistory(createCardGameHistory());
    const { context, trajectory } = await runOrientedPipeline(
      'the mana system bug where mana was not resetting at turn start',
      history,
    );

    expect(context).not.toBeNull();
    expect(context!.toLowerCase()).toContain('mana');

    const score = scoreRetrieval(context!, [5, 6], history);
    expect(score.recall).toBeGreaterThanOrEqual(0.5);

    expect(trajectory.iterations.length).toBeLessThanOrEqual(4);
    expect(trajectory.forcedAnswer).toBe(false);
    expect(trajectory.timedOut).toBe(false);
  }, 120_000);

  it('card game: direct keyword query hits on first-ish iteration with orientation', async () => {
    const history = padHistory(createCardGameHistory());
    const { context, trajectory } = await runOrientedPipeline(
      'DeckLoader JSON schema validation for card definitions',
      history,
    );

    expect(context).not.toBeNull();
    expect(context!.toLowerCase()).toContain('deckloader');

    const score = scoreRetrieval(context!, [4], history);
    expect(score.recall).toBe(1);

    expect(trajectory.iterations.length).toBeLessThanOrEqual(3);
  }, 120_000);

  it('web app: CORS fix retrieval with orientation pre-ranking', async () => {
    const history = padHistory(createWebAppHistory());
    const { context, trajectory } = await runOrientedPipeline(
      'the CORS localhost:3001 error fix with Access-Control-Allow-Origin header',
      history,
    );

    expect(context).not.toBeNull();
    expect(context!.toLowerCase()).toContain('cors');

    const score = scoreRetrieval(context!, [3], history);
    expect(score.recall).toBe(1);
    expect(score.precision).toBeGreaterThanOrEqual(0.5);

    expect(trajectory.orientation).not.toBeNull();
    const topBm25 = trajectory.orientation!.bm25Results[0];
    expect(topBm25).toBeDefined();
    expect(topBm25!.turnIndex).toBe(3);
  }, 120_000);

  it('large history (100 turns): oriented search through auth tokens in overlapping topics', async () => {
    const history = padHistory(createOverlappingHistory());
    const { context, trajectory } = await runOrientedPipeline(
      'JWT refresh token rotation vulnerability and replay attack prevention',
      history,
    );

    expect(context).not.toBeNull();
    expect(trajectory.shortCircuited).toBe(false);
    expect(/jwt|refresh|token|rotation|replay/i.test(context!)).toBe(true);

    const score = scoreRetrieval(context!, [10, 57], history);
    expect(score.recall).toBeGreaterThanOrEqual(0.5);

    expect(trajectory.orientation).not.toBeNull();
    expect(trajectory.orientation!.bm25Results.length).toBeGreaterThan(0);
  }, 120_000);

  it('vague query with investigation: "go back to that auth issue" retrieves auth context', async () => {
    const history = padHistory(createOverlappingHistory());
    const { context, trajectory } = await runOrientedPipeline(
      'go back to that auth issue we fixed',
      history,
    );

    expect(context).not.toBeNull();
    expect(/auth|jwt|token|login|session/i.test(context!)).toBe(true);

    const authIndices = [5, 7, 10, 12, 14, 15, 55, 56, 57, 58, 59, 60, 61, 62];
    const score = scoreRetrieval(context!, authIndices, history);
    expect(score.recall).toBeGreaterThanOrEqual(0.1);

    expect(trajectory.orientation).not.toBeNull();
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4: REPL Sandbox Tools — text_search() and turn_index usage
//
// Validates that the root model can effectively use the new REPL tools
// (text_search, turn_index) that were added as part of the orientation
// feature. Tests that models leverage these tools in their code blocks.
// ─────────────────────────────────────────────────────────────────────────────

suite('orientation: REPL sandbox tools (Sonnet)', () => {
  let runRecallLoop: typeof import('../recall-loop').runRecallLoop;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
    const recallModule = await import('../recall-loop');
    runRecallLoop = recallModule.runRecallLoop;
  });

  async function runAndInspect(userPrompt: string, history: StructuredTurn[]) {
    const { context, trajectory } = await runRecallLoop(
      history, userPrompt, history.length,
      {
        config: makeDefaultConfig(),
        cwd: process.cwd(),
        model: ROOT_MODEL,
        nodeContext: null,
      },
    );
    return { context, trajectory };
  }

  it('model retrieves correct context using orientation-guided approach', async () => {
    const history = padHistory(createOverlappingHistory());
    const { context, trajectory } = await runAndInspect(
      'show me the Redis cache invalidation strategy with tag-based clearing',
      history,
    );

    expect(context).not.toBeNull();
    expect(trajectory.iterations.length).toBeGreaterThan(0);

    const score = scoreRetrieval(context!, [31], history);
    expect(score.recall).toBe(1);

    const usesOrientationData = trajectory.iterations.some(iter => {
      if (!iter.codeBlock) return false;
      return iter.codeBlock.includes('text_search') ||
             iter.codeBlock.includes('turn_index') ||
             iter.codeBlock.includes('context[');
    });
    expect(usesOrientationData).toBe(true);
  }, 120_000);

  it('text_search follow-up: model refines search when initial results are insufficient', async () => {
    const history = padHistory(createOverlappingHistory());
    const { context, trajectory } = await runAndInspect(
      'the test session cleanup that was leaking database connections — the prisma disconnect fix',
      history,
    );

    expect(context).not.toBeNull();

    const score = scoreRetrieval(context!, [48], history);
    expect(score.recall).toBe(1);
  }, 120_000);

  it('model handles multi-topic oriented retrieval across conversation regions', async () => {
    const history = padHistory(createOverlappingHistory());
    const { context } = await runAndInspect(
      'show me both the Redis cluster setup AND the database backup strategy',
      history,
    );

    expect(context).not.toBeNull();

    const redisScore = scoreRetrieval(context!, [30], history);
    const backupScore = scoreRetrieval(context!, [20], history);
    expect(redisScore.recall + backupScore.recall).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 5: Orientation Quality — BM25 ranking accuracy across fixtures
//
// Tests that the BM25 engine (with and without keyword enrichment) correctly
// ranks turns across different fixture histories. These are fast (no model
// calls, pure BM25) and always run — they validate the ranking quality
// assumptions that the orientation pipeline depends on.
// ─────────────────────────────────────────────────────────────────────────────

describe('orientation: BM25 ranking quality (no model)', () => {
  it('overlapping history: "JWT refresh token" ranks auth turns above state-management', () => {
    const history = createOverlappingHistory();
    const index = createBM25Index(history);

    const results = index.search('JWT refresh token rotation vulnerability');

    expect(results.length).toBeGreaterThan(0);

    const top5Indices = results.slice(0, 5).map(r => r.turnIndex);

    const authTurnIndices = new Set([5, 7, 10, 57]);
    const stateIndices = new Set([23, 24, 25, 26, 27, 28, 29]);

    const authHits = top5Indices.filter(i => authTurnIndices.has(i)).length;
    const stateHits = top5Indices.filter(i => stateIndices.has(i)).length;

    expect(authHits).toBeGreaterThan(stateHits);
  });

  it('overlapping history: "Redis cache" ranks Redis turns above browser cache', () => {
    const history = createOverlappingHistory();
    const index = createBM25Index(history);

    const results = index.search('Redis cache invalidation tag-based');

    expect(results.length).toBeGreaterThan(0);

    const top3Indices = results.slice(0, 3).map(r => r.turnIndex);
    const redisIndices = new Set([30, 31, 32, 33, 34]);
    const browserCacheIndex = 40;

    const redisHits = top3Indices.filter(i => redisIndices.has(i)).length;
    expect(redisHits).toBeGreaterThanOrEqual(2);
    expect(top3Indices).not.toContain(browserCacheIndex);
  });

  it('keyword enrichment boosts target turn ranking', () => {
    const baseHistory = createCardGameHistory();
    const enrichedHistory = baseHistory.map(t => ({
      ...t,
      keywords: t.promptIndex === 3
        ? ['z-index', 'race-condition', 'hover-flickering', 'debounce', 'mutex-lock', 'HandDisplay', 'card-overlap']
        : [],
    }));

    const baseIndex = createBM25Index(baseHistory);
    const enrichedIndex = createBM25Index(enrichedHistory);

    const query = 'mutex lock race condition card overlap';

    const baseResults = baseIndex.search(query);
    const enrichedResults = enrichedIndex.search(query);

    const enrichedTurn3 = enrichedResults.find(r => r.turnIndex === 3);
    const baseTurn3 = baseResults.find(r => r.turnIndex === 3);

    expect(enrichedTurn3).toBeDefined();
    expect(enrichedTurn3!.score).toBeGreaterThan(baseTurn3?.score ?? 0);
  });

  it('empty query returns no results', () => {
    const history = createCardGameHistory();
    const index = createBM25Index(history);

    expect(index.search('')).toEqual([]);
    expect(index.search('the a an is')).toEqual([]);
  });
});
