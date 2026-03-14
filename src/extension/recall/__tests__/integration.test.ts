import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionTrace } from '../graph/recall-graph-state';
import type { StructuredTurn } from '../types';
import { DEFAULT_SUBCALL_MODEL } from '../types';
import { createCardGameHistory, createWebAppHistory, createLargeHistory } from './fixtures/histories';
import { scoreRetrieval } from './fixtures/mock-sdk';
import { padHistory, makeDefaultConfig, makeGraphState } from './fixtures/integration-helpers';

const INTEGRATION = !!process.env['DAMOCLES_INTEGRATION'];
const ROOT_MODEL = 'claude-sonnet-4-6';
const SUBCALL_MODEL = DEFAULT_SUBCALL_MODEL;
const suite = INTEGRATION ? describe : describe.skip;

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests — real model calls via SDK subscription
//
// These tests call actual Claude models through the Claude Agent SDK's
// subscription-based query() function — the same mechanism Damocles uses in
// production. They validate what mocks cannot:
//
//   1. Intent classification accuracy with real Haiku structured output
//   2. REPL code generation quality (valid JS, correct API usage)
//   3. End-to-end retrieval quality against fixture histories
//   4. Sub-call (llm_query) result usefulness
//   5. Prompt effectiveness and regression detection
//
// Models: Sonnet 4.6 (root/REPL), Haiku 4.5 (intent + sub-calls)
//
// Run:
//   DAMOCLES_INTEGRATION=1 npx vitest run src/extension/recall/__tests__/integration.test.ts
//
// Cost: ~$0.10-0.20 per full run
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Intent Classification — real Haiku structured output
//
// Tests that Haiku correctly classifies intent and extracts key entities
// using the production prompt in intent-analysis.ts. These catch regressions
// like the "what about X?" → general misclassification bug.
// ─────────────────────────────────────────────────────────────────────────────

suite('integration: intent classification (real Haiku)', () => {
  let intentAnalysisNode: typeof import('../graph/nodes/intent-analysis').intentAnalysisNode;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
    const module = await import('../graph/nodes/intent-analysis');
    intentAnalysisNode = module.intentAnalysisNode;
  });

  it('recall — "what did you say about X?"', async () => {
    const result = await intentAnalysisNode(
      makeGraphState('what did you say about the InputManager autoload singleton that was registered in the project setup?'),
      { nodeName: 'intentAnalysis' },
    );

    expect(result.intent).toBe('recall');
    expect(result.keyEntities!.length).toBeGreaterThan(0);
    expect(result.keyEntities!.some(e => /inputmanager/i.test(e))).toBe(true);
  }, 30_000);

  it('recall — "what about X?" regression (was misclassified as general)', async () => {
    const result = await intentAnalysisNode(
      makeGraphState('what about the mana system and the bug where mana was not resetting at the start of each turn?'),
      { nodeName: 'intentAnalysis' },
    );

    expect(['recall', 'debug']).toContain(result.intent);
    expect(result.keyEntities!.some(e => /mana/i.test(e))).toBe(true);
  }, 30_000);

  it('recall — "you mentioned Y earlier"', async () => {
    const result = await intentAnalysisNode(
      makeGraphState('you mentioned earlier that the HandDisplay uses trigonometric calculations for the arc — can you go back to that?'),
      { nodeName: 'intentAnalysis' },
    );

    expect(result.intent).toBe('recall');
    expect(result.keyEntities!.length).toBeGreaterThan(0);
    expect(result.keyEntities!.some(e => /hand|display|arc|trig/i.test(e))).toBe(true);
  }, 30_000);

  it('debug — bug description with error symptoms', async () => {
    const result = await intentAnalysisNode(
      makeGraphState('there is a bug where cards are flickering when I hover over them in the hand display component'),
      { nodeName: 'intentAnalysis' },
    );

    expect(['debug', 'general']).toContain(result.intent);
    expect(result.keyEntities!.length).toBeGreaterThan(0);
  }, 30_000);

  it('feature — adding new functionality', async () => {
    const result = await intentAnalysisNode(
      makeGraphState('add a new card type that has special abilities and can target multiple enemies on the board'),
      { nodeName: 'intentAnalysis' },
    );

    expect(result.intent).toBe('feature');
    expect(result.keyEntities!.length).toBeGreaterThan(0);
  }, 30_000);

  it('explain — understanding request', async () => {
    const result = await intentAnalysisNode(
      makeGraphState('can you explain how the turn system state machine transitions between the different game phases?'),
      { nodeName: 'intentAnalysis' },
    );

    expect(result.intent).toBe('explain');
    expect(result.keyEntities!.length).toBeGreaterThan(0);
  }, 30_000);

  it('refactor — restructuring request', async () => {
    const result = await intentAnalysisNode(
      makeGraphState('refactor the CardManager to use a composition pattern instead of the current inheritance structure'),
      { nodeName: 'intentAnalysis' },
    );

    expect(result.intent).toBe('refactor');
    expect(result.keyEntities!.length).toBeGreaterThan(0);
  }, 30_000);

  it('multi-entity extraction from complex prompt', async () => {
    const result = await intentAnalysisNode(
      makeGraphState('show me the TurnManager state machine implementation and how the ManaSystem integrates with the draw phase'),
      { nodeName: 'intentAnalysis' },
    );

    expect(result.keyEntities!.length).toBeGreaterThanOrEqual(2);
    const lower = result.keyEntities!.map(e => e.toLowerCase());
    const hasTurnRelated = lower.some(e => e.includes('turn') || e.includes('turnmanager'));
    const hasManaRelated = lower.some(e => e.includes('mana') || e.includes('manasystem'));
    expect(hasTurnRelated || hasManaRelated).toBe(true);
  }, 30_000);

  it('test — writing tests for a module', async () => {
    const result = await intentAnalysisNode(
      makeGraphState('write unit tests for the CardManager that cover the draw and discard operations'),
      { nodeName: 'intentAnalysis' },
    );

    expect(result.intent).toBe('test');
    expect(result.keyEntities!.length).toBeGreaterThan(0);
  }, 30_000);

  it('multi-intent — debug primary with test secondary', async () => {
    const result = await intentAnalysisNode(
      makeGraphState('fix the failing CardManager test and add more test cases for edge scenarios'),
      { nodeName: 'intentAnalysis' },
    );

    expect(result.intent).toBe('debug');
    expect(result.secondaryIntent).toBe('test');
  }, 30_000);

  it('session trace aids disambiguation of ambiguous prompt', async () => {
    const trace: SessionTrace = {
      entries: [
        { promptIndex: 18, intent: 'debug', secondaryIntent: null, keyEntities: ['flickering', 'hover'], recallSucceeded: true, timestamp: '2025-01-01T00:18:00Z' },
        { promptIndex: 19, intent: 'feature', secondaryIntent: null, keyEntities: ['mana', 'reset'], recallSucceeded: true, timestamp: '2025-01-01T00:19:00Z' },
      ],
      lastIntent: 'feature',
      recentEntities: ['flickering', 'hover', 'mana', 'reset'],
    };

    const result = await intentAnalysisNode(
      makeGraphState(
        'how did we fix that issue with the mana and the hover flickering that kept happening?',
        { trace },
      ),
      { nodeName: 'intentAnalysis' },
    );

    expect(['recall', 'debug']).toContain(result.intent);
    expect(result.keyEntities!.length).toBeGreaterThan(0);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Full Pipeline Retrieval — intent classification → REPL loop → context
//
// These run the COMPLETE recall pipeline with real models:
//   1. Haiku classifies intent (structured output)
//   2. Sonnet generates REPL JavaScript code
//   3. Code executes in JsRepl sandbox against fixture history
//   4. FINAL() captures the retrieved context
//
// Assertions use bands (recall >= 0.5) not exact matches, because model
// output is non-deterministic. Keywords are checked case-insensitively.
// ─────────────────────────────────────────────────────────────────────────────

suite('integration: full pipeline retrieval (Sonnet + Haiku)', () => {
  let intentAnalysisNode: typeof import('../graph/nodes/intent-analysis').intentAnalysisNode;
  let runRecallLoop: typeof import('../recall-loop').runRecallLoop;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
    const intentModule = await import('../graph/nodes/intent-analysis');
    intentAnalysisNode = intentModule.intentAnalysisNode;
    const recallModule = await import('../recall-loop');
    runRecallLoop = recallModule.runRecallLoop;
  });

  async function classify(userPrompt: string, history: StructuredTurn[]) {
    const state = makeGraphState(userPrompt, { history });
    return intentAnalysisNode(state, { nodeName: 'intentAnalysis' });
  }

  async function runPipeline(userPrompt: string, history: StructuredTurn[]) {
    const intentResult = await classify(userPrompt, history);
    const { context, trajectory } = await runRecallLoop(
      history, userPrompt, history.length,
      {
        config: makeDefaultConfig(),
        cwd: process.cwd(),
        model: ROOT_MODEL,
        intentContext: {
          intent: intentResult.intent ?? 'general',
          secondaryIntent: intentResult.secondaryIntent ?? null,
          keyEntities: intentResult.keyEntities ?? [],
        },
      },
    );
    return { context, trajectory, intent: intentResult };
  }

  it('card game: retrieves InputManager autoload context', async () => {
    const history = padHistory(createCardGameHistory());
    const { context, trajectory } = await runPipeline(
      'what did you say about the InputManager autoload singleton that was registered in the project structure setup?',
      history,
    );

    expect(context).not.toBeNull();
    expect(context!.toLowerCase()).toContain('inputmanager');
    expect(trajectory.shortCircuited).toBe(false);
    expect(trajectory.iterations.length).toBeGreaterThan(0);

    const score = scoreRetrieval(context!, [0, 1], history);
    expect(score.recall).toBeGreaterThanOrEqual(0.5);
    expect(score.precision).toBeGreaterThanOrEqual(0.5);
  }, 120_000);

  it('card game: retrieves flickering bug fix (z-index race condition)', async () => {
    const history = padHistory(createCardGameHistory());
    const { context, trajectory } = await runPipeline(
      'can you show me the bug with hover flickering that was caused by the z-index race condition in the hand?',
      history,
    );

    expect(context).not.toBeNull();
    expect(trajectory.shortCircuited).toBe(false);
    expect(/flicker|z-index|hover|debounce|mutex/i.test(context!)).toBe(true);

    const score = scoreRetrieval(context!, [3], history);
    expect(score.recall).toBe(1);
    expect(score.precision).toBeGreaterThanOrEqual(0.5);
  }, 120_000);

  it('card game: retrieves mana system bug across two related turns', async () => {
    const history = padHistory(createCardGameHistory());
    const { context } = await runPipeline(
      'what about the mana system and the bug where mana was not resetting at the start of each turn?',
      history,
    );

    expect(context).not.toBeNull();
    expect(context!.toLowerCase()).toContain('mana');

    const score = scoreRetrieval(context!, [5, 6], history);
    expect(score.recall).toBeGreaterThanOrEqual(0.5);
    expect(score.precision).toBeGreaterThanOrEqual(0.5);
  }, 120_000);

  it('web app: retrieves CORS issue fix', async () => {
    const history = padHistory(createWebAppHistory());
    const { context } = await runPipeline(
      'how did you fix the CORS issue with the localhost:3001 API requests that was blocking the frontend?',
      history,
    );

    expect(context).not.toBeNull();
    expect(context!.toLowerCase()).toContain('cors');

    const score = scoreRetrieval(context!, [3], history);
    expect(score.recall).toBe(1);
    expect(score.precision).toBeGreaterThanOrEqual(0.5);
  }, 120_000);

  it('large history (50 turns): finds authentication module across scattered turns', async () => {
    const history = padHistory(createLargeHistory(50));
    const { context, trajectory } = await runPipeline(
      'show me all the authentication module implementations including JWT setup, refresh tokens, and session fixes',
      history,
    );

    expect(context).not.toBeNull();
    expect(trajectory.shortCircuited).toBe(false);
    expect(context!.toLowerCase()).toContain('authentication');

    const authIndices = history
      .filter(t => t.userMessage.toLowerCase().includes('authentication'))
      .map(t => t.promptIndex);
    const score = scoreRetrieval(context!, authIndices, history);
    expect(score.recall).toBeGreaterThanOrEqual(0.3);
    expect(score.precision).toBeGreaterThanOrEqual(0.5);
  }, 120_000);

  it('validates REPL code executes without errors and completes cleanly', async () => {
    const history = padHistory(createCardGameHistory());
    const { trajectory } = await runPipeline(
      'show me the DeckLoader implementation details including the JSON schema validation and CardData resource',
      history,
    );

    expect(trajectory.shortCircuited).toBe(false);
    expect(trajectory.iterations.length).toBeGreaterThan(0);

    const hasSuccessfulIteration = trajectory.iterations.some(
      i => i.codeBlock !== null && !i.replOutput?.includes('[Error:'),
    );
    expect(hasSuccessfulIteration).toBe(true);

    expect(trajectory.forcedAnswer).toBe(false);
    expect(trajectory.timedOut).toBe(false);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Sub-call Handler — real llm_query via SDK subscription
//
// Tests that SubCallHandler.query() and queryBatched() produce useful
// results when called with real Haiku. These are the same calls that the
// REPL sandbox makes when the model writes `await llm_query(...)`.
// ─────────────────────────────────────────────────────────────────────────────

suite('integration: sub-call handler (real Haiku)', () => {
  let SubCallHandler: typeof import('../sub-call-handler').SubCallHandler;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
    const module = await import('../sub-call-handler');
    SubCallHandler = module.SubCallHandler;
  });

  it('single query produces useful summarization', async () => {
    const handler = new SubCallHandler(process.cwd(), SUBCALL_MODEL);

    try {
      const response = await handler.query(
        'Summarize this code exchange in 2 sentences:\n' +
        'User: Add JWT authentication with refresh tokens\n' +
        'Assistant: I implemented JWT authentication using jsonwebtoken. The system generates ' +
        'access tokens (15min TTL) and refresh tokens (7d TTL) stored in httpOnly cookies. ' +
        'Created auth middleware, /login, /refresh, and /logout endpoints.',
      );

      expect(response.length).toBeGreaterThan(10);
      expect(response).not.toContain('[Error:');
      expect(response.toLowerCase()).toMatch(/jwt|auth|token/);
    } finally {
      handler.abort();
    }
  }, 30_000);

  it('batched queries return relevant results for each prompt', async () => {
    const handler = new SubCallHandler(process.cwd(), SUBCALL_MODEL);

    try {
      const responses = await handler.queryBatched([
        'What is the main topic of this exchange? Answer in one word.\nUser: Fix the CORS error on localhost:3001\nAssistant: Added CORS headers in next.config.js',
        'What is the main topic of this exchange? Answer in one word.\nUser: Add drag and drop to Card scene\nAssistant: Created Card.gd extending Area2D with mouse drag input handling',
      ]);

      expect(responses).toHaveLength(2);
      for (const r of responses) {
        expect(r.length).toBeGreaterThan(2);
        expect(r).not.toContain('[Error:');
      }

      expect(responses[0]!.toLowerCase()).toMatch(/cors|error|config|network/);
      expect(responses[1]!.toLowerCase()).toMatch(/drag|drop|card|input/);
    } finally {
      handler.abort();
    }
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge Cases — robustness under adversarial conditions
//
// Tests that the pipeline handles gracefully when:
//   - The query references topics that don't exist in the history
//   - Paraphrased queries produce overlapping retrieval results
//   - Multi-topic queries retrieve from multiple conversation regions
// ─────────────────────────────────────────────────────────────────────────────

suite('integration: edge cases', () => {
  let intentAnalysisNode: typeof import('../graph/nodes/intent-analysis').intentAnalysisNode;
  let runRecallLoop: typeof import('../recall-loop').runRecallLoop;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
    const intentModule = await import('../graph/nodes/intent-analysis');
    intentAnalysisNode = intentModule.intentAnalysisNode;
    const recallModule = await import('../recall-loop');
    runRecallLoop = recallModule.runRecallLoop;
  });

  async function runPipeline(userPrompt: string, history: StructuredTurn[]) {
    const state = makeGraphState(userPrompt, { history });
    const intentResult = await intentAnalysisNode(state, { nodeName: 'intentAnalysis' });
    const { context, trajectory } = await runRecallLoop(
      history, userPrompt, history.length,
      {
        config: makeDefaultConfig(),
        cwd: process.cwd(),
        model: ROOT_MODEL,
        intentContext: {
          intent: intentResult.intent ?? 'general',
          secondaryIntent: intentResult.secondaryIntent ?? null,
          keyEntities: intentResult.keyEntities ?? [],
        },
      },
    );
    return { context, trajectory, intent: intentResult };
  }

  it('no-match query produces graceful fallback without crash', async () => {
    const history = padHistory(createCardGameHistory());
    const { context, trajectory } = await runPipeline(
      'show me the Kubernetes deployment configuration and the container orchestration setup we discussed',
      history,
    );

    expect(context).not.toBeNull();
    expect(trajectory.shortCircuited).toBe(false);
  }, 120_000);

  it('paraphrased queries both retrieve InputManager context', async () => {
    const history = padHistory(createCardGameHistory());
    const queries = [
      'what did you say about the InputManager autoload singleton that was registered in the project structure setup?',
      'can you remind me about the InputManager singleton pattern and how it was set up as a global autoload node?',
    ];

    const contexts: (string | null)[] = [];
    for (const query of queries) {
      const { context } = await runPipeline(query, history);
      contexts.push(context);
    }

    for (const ctx of contexts) {
      expect(ctx).not.toBeNull();
      expect(ctx!.toLowerCase()).toContain('inputmanager');
    }
  }, 240_000);

  it('multi-topic query retrieves from separate conversation regions', async () => {
    const history = padHistory(createCardGameHistory());
    const { context } = await runPipeline(
      'show me the drag and drop Card scene implementation AND the mana system turn phase integration we built',
      history,
    );

    expect(context).not.toBeNull();

    const score = scoreRetrieval(context!, [1, 5, 6], history);
    expect(score.recall).toBeGreaterThanOrEqual(0.33);
  }, 120_000);
});
