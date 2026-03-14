import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StructuredTurn } from '../types';
import { DEFAULT_SUBCALL_MODEL } from '../types';
import { createCardGameHistory, createWebAppHistory, createLargeHistory, createOverlappingHistory } from './fixtures/histories';
import { scoreRetrieval } from './fixtures/mock-sdk';
import { padHistory, makeDefaultConfig, makeGraphState } from './fixtures/integration-helpers';

const INTEGRATION = !!process.env['DAMOCLES_INTEGRATION'];
const ROOT_MODEL = 'claude-sonnet-4-6';
const suite = INTEGRATION ? describe : describe.skip;

// ─────────────────────────────────────────────────────────────────────────────
// Integration Quality Tests — precision, disambiguation, quality, paraphrasing
//
// These tests go beyond recall (did we find the right turns?) to measure:
//   - Precision: were irrelevant turns excluded?
//   - Disambiguation: can the model distinguish overlapping topics?
//   - Consumer quality: Haiku-scored context relevance (1-5 scale)
//   - Paraphrase robustness: same question, different words → same result?
//
// Run:
//   DAMOCLES_INTEGRATION=1 npx vitest run src/extension/recall/__tests__/integration-quality.test.ts
//
// Cost: ~$0.50-1.00 per full run (paraphrase tests are the most expensive)
// ─────────────────────────────────────────────────────────────────────────────

async function runFullPipeline(
  userPrompt: string,
  history: StructuredTurn[],
  opts?: { promptIndex?: number },
) {
  const intentModule = await import('../graph/nodes/intent-analysis');
  const recallModule = await import('../recall-loop');

  const graphOpts: Parameters<typeof makeGraphState>[1] = { history };
  if (opts?.promptIndex !== undefined) {
    graphOpts.promptIndex = opts.promptIndex;
  }
  const state = makeGraphState(userPrompt, graphOpts);
  const intentResult = await intentModule.intentAnalysisNode(state, { nodeName: 'intentAnalysis' });
  const { context, trajectory } = await recallModule.runRecallLoop(
    history, userPrompt, opts?.promptIndex ?? history.length,
    {
      config: makeDefaultConfig(),
      cwd: process.cwd(),
      model: ROOT_MODEL,
      intentContext: {
        intent: intentResult.intent ?? 'general',
        keyEntities: intentResult.keyEntities ?? [],
      },
    },
  );
  return { context, trajectory, intent: intentResult };
}

const PAD_PATTERN = /(\n\n)?(I also reviewed the surrounding code for consistency and made minor adjustments to ensure compatibility\. )+/g;

function stripPadding(text: string): string {
  return text.replace(PAD_PATTERN, '').trim();
}

async function scoreContextQuality(
  query: string,
  context: string,
): Promise<number> {
  const { SubCallHandler } = await import('../sub-call-handler');
  const handler = new SubCallHandler(process.cwd(), DEFAULT_SUBCALL_MODEL);

  try {
    const cleaned = stripPadding(context);
    const prompt = [
      'Rate the relevance and quality of the following retrieved context for answering the user query.',
      'Score from 1 (completely irrelevant) to 5 (perfectly relevant and sufficient).',
      'Respond with ONLY a single digit 1-5, nothing else.',
      '',
      `Query: ${query}`,
      '',
      `Context:\n${cleaned.slice(0, 4000)}`,
    ].join('\n');

    const response = await handler.query(prompt);
    const match = response.match(/[1-5]/);
    return match ? parseInt(match[0], 10) : 1;
  } finally {
    handler.abort();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: Precision / Noise Rejection
//
// Tests that the retrieval system returns ONLY relevant turns, not everything
// that vaguely matches. A system that dumps all history would score 100% recall
// but 0% precision — these tests catch that.
// ─────────────────────────────────────────────────────────────────────────────

suite('quality: precision / noise rejection', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
  });

  it('DeckLoader precision — retrieves JSON schema turn, not unrelated turns', async () => {
    const history = padHistory(createCardGameHistory());
    const { context } = await runFullPipeline(
      'show me the DeckLoader JSON schema',
      history,
    );

    expect(context).not.toBeNull();
    const score = scoreRetrieval(context!, [4], history);
    expect(score.precision).toBeGreaterThanOrEqual(0.7);
  }, 120_000);

  it('CORS precision — retrieves CORS fix turn without pulling in unrelated web app turns', async () => {
    const history = padHistory(createWebAppHistory());
    const { context } = await runFullPipeline(
      'the CORS localhost:3001 fix',
      history,
    );

    expect(context).not.toBeNull();
    const score = scoreRetrieval(context!, [3], history);
    expect(score.precision).toBeGreaterThanOrEqual(0.7);
  }, 120_000);

  it('auth precision in large history — retrieves auth turns without pulling in all 50 turns', async () => {
    const history = padHistory(createLargeHistory(50));
    const authIndices = history
      .filter(t => t.userMessage.toLowerCase().includes('authentication'))
      .map(t => t.promptIndex);

    const { context } = await runFullPipeline(
      'JWT auth setup and refresh tokens',
      history,
    );

    expect(context).not.toBeNull();
    const score = scoreRetrieval(context!, authIndices, history);
    expect(score.precision).toBeGreaterThanOrEqual(0.5);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: Overlapping Topic Disambiguation
//
// Uses the overlapping history fixture where keywords bleed across topics:
// "session" appears in auth, state mgmt, testing, and deployment.
// "cache" appears in Redis, browser cache, and DB query cache.
// The model must disambiguate based on semantic context, not just keyword match.
// ─────────────────────────────────────────────────────────────────────────────

suite('quality: overlapping topic disambiguation', () => {
  let overlappingHistory: StructuredTurn[];

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
    overlappingHistory = padHistory(createOverlappingHistory());
  });

  it('auth-session vs state-session — "authentication session" retrieves auth, not Redux state', async () => {
    const { context } = await runFullPipeline(
      'authentication session handling with tokens',
      overlappingHistory,
    );

    expect(context).not.toBeNull();

    const authIndices = [5, 7, 10, 12, 14, 15, 55, 57, 61, 62];
    const mustNotRetrieve = [25, 28];

    const score = scoreRetrieval(context!, authIndices, overlappingHistory);
    expect(score.recall).toBeGreaterThanOrEqual(0.3);
    expect(score.precision).toBeGreaterThanOrEqual(0.5);

    for (const idx of mustNotRetrieve) {
      expect(context!).not.toContain(`[Prompt ${idx}]`);
    }
  }, 120_000);

  it('database-for-auth vs general-db — "database schema for authentication" targets auth, not general DB', async () => {
    const { context } = await runFullPipeline(
      'database schema changes for authentication',
      overlappingHistory,
    );

    expect(context).not.toBeNull();

    const score = scoreRetrieval(context!, [2, 5, 9, 15, 58], overlappingHistory);
    expect(score.recall).toBeGreaterThanOrEqual(0.3);
    expect(score.precision).toBeGreaterThanOrEqual(0.5);
  }, 120_000);

  it('temporal disambiguation — "go back to the auth issue" at late promptIndex retrieves recent auth, not early auth', async () => {
    const { context } = await runFullPipeline(
      'go back to the auth issue',
      overlappingHistory,
      { promptIndex: 65 },
    );

    expect(context).not.toBeNull();

    const recentAuthIndices = [55, 56, 57, 58, 59, 60, 61, 62];
    const earlyAuthIndices = [5, 6, 7, 9, 10, 11, 13, 14];

    const recentScore = scoreRetrieval(context!, recentAuthIndices, overlappingHistory);
    const earlyScore = scoreRetrieval(context!, earlyAuthIndices, overlappingHistory);

    expect(recentScore.recall).toBeGreaterThan(earlyScore.recall);
  }, 120_000);

  it('Redis cache vs browser cache — "Redis cache invalidation" retrieves Redis turns, not browser cache', async () => {
    const { context } = await runFullPipeline(
      'Redis cache invalidation strategy',
      overlappingHistory,
    );

    expect(context).not.toBeNull();

    const redisIndices = [30, 31, 32, 33, 34];
    const mustNotRetrieve = [40];

    const score = scoreRetrieval(context!, redisIndices, overlappingHistory);
    expect(score.recall).toBeGreaterThanOrEqual(0.5);
    expect(score.precision).toBeGreaterThanOrEqual(0.5);

    for (const idx of mustNotRetrieve) {
      expect(context!).not.toContain(`[Prompt ${idx}]`);
    }
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: Consumer Quality — Haiku-Scored
//
// Uses a real Haiku call to rate the retrieved context for relevance and
// usefulness on a 1-5 scale. This catches cases where the retrieval is
// technically correct but the context is incomplete or poorly formatted.
// ─────────────────────────────────────────────────────────────────────────────

suite('quality: consumer quality (Haiku-scored)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
  });

  it('InputManager query produces high-quality context', async () => {
    const history = padHistory(createCardGameHistory());
    const query = 'what did you say about the InputManager autoload singleton that was registered in the project setup?';
    const { context } = await runFullPipeline(query, history);

    expect(context).not.toBeNull();
    const score = await scoreContextQuality(query, context!);
    expect(score).toBeGreaterThanOrEqual(4);
  }, 120_000);

  it('mana bug query produces high-quality context', async () => {
    const history = padHistory(createCardGameHistory());
    const query = 'what about the mana system and the bug where mana was not resetting at the start of each turn?';
    const { context } = await runFullPipeline(query, history);

    expect(context).not.toBeNull();
    const score = await scoreContextQuality(query, context!);
    expect(score).toBeGreaterThanOrEqual(4);
  }, 120_000);

  it('CORS fix query produces high-quality context', async () => {
    const history = padHistory(createWebAppHistory());
    const query = 'how did you fix the CORS issue with the localhost:3001 API requests?';
    const { context } = await runFullPipeline(query, history);

    expect(context).not.toBeNull();
    const score = await scoreContextQuality(query, context!);
    expect(score).toBeGreaterThanOrEqual(4);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4: Paraphrase Robustness
//
// Each scenario runs 5 differently-worded versions of the same question.
// A robust system should retrieve the same core turns regardless of phrasing.
// This catches brittle keyword-matching that fails when users rephrase.
// ─────────────────────────────────────────────────────────────────────────────

suite('quality: paraphrase robustness', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
  });

  async function runParaphraseScenario(
    paraphrases: string[],
    history: StructuredTurn[],
    coreIndices: number[],
  ) {
    const results: { context: string | null; score: ReturnType<typeof scoreRetrieval> }[] = [];

    for (const query of paraphrases) {
      const { context } = await runFullPipeline(query, history);
      const score = scoreRetrieval(context ?? '', coreIndices, history);
      results.push({ context, score });
    }

    for (const r of results) {
      expect(r.context).not.toBeNull();
      expect(r.score.recall).toBeGreaterThan(0);
    }

    const allRetrieved = results.map(r => new Set(r.score.retrievedIndices));
    const intersection = [...allRetrieved[0]!].filter(idx =>
      allRetrieved.every(s => s.has(idx))
    );
    expect(intersection.length).toBeGreaterThan(0);

    const highRecallCount = results.filter(r => r.score.recall >= 0.5).length;
    expect(highRecallCount).toBeGreaterThanOrEqual(4);
  }

  it('InputManager — 5 paraphrases all retrieve core turn', async () => {
    const history = padHistory(createCardGameHistory());
    await runParaphraseScenario(
      [
        'what did you say about the InputManager autoload singleton?',
        'can you remind me about the InputManager and how it was set up as a global autoload?',
        'show me the part where we configured the InputManager as an autoloaded singleton node',
        'I need to see the InputManager setup we discussed — the autoload registration',
        'go back to when we created the InputManager for handling user input globally',
      ],
      history,
      [0],
    );
  }, 300_000);

  it('flickering bug — 5 paraphrases all retrieve core turn', async () => {
    const history = padHistory(createCardGameHistory());
    await runParaphraseScenario(
      [
        'show me the hover flickering bug you fixed in the card hand',
        'the z-index race condition that caused cards to flicker on hover',
        'what was the bug where cards kept flickering when I moused over them?',
        'can you find the fix for the hover effect triggering repeatedly on cards?',
        'go back to when we debugged the card flickering — it was a z-index issue',
      ],
      history,
      [3],
    );
  }, 300_000);

  it('CORS fix — 5 paraphrases all retrieve core turn', async () => {
    const history = padHistory(createWebAppHistory());
    await runParaphraseScenario(
      [
        'the CORS localhost:3001 fix',
        'how did we fix the CORS error when fetching from the API?',
        'show me the cross-origin fix for the localhost:3001 API requests',
        'I need the CORS configuration we added to next.config.js',
        'go back to when we resolved the CORS issue between frontend and API',
      ],
      history,
      [3],
    );
  }, 300_000);
});
