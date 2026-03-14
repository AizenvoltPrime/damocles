import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StateGraph, END } from '../graph/state-graph';
import { createRecallGraphAnnotation } from '../graph/recall-graph-state';
import { stateUpdateNode } from '../graph/nodes/state-update';
import type { RecallGraphState, SessionTrace } from '../graph/recall-graph-state';
import type { RecallTrajectory } from '../types';
import { createCardGameHistory, createLargeHistory, createMinimalTurn } from './fixtures/histories';
import { padHistory, makeEmptyTrace } from './fixtures/integration-helpers';
import { createFullMockSdkQuery } from './fixtures/mock-sdk';
import type { GraphExecutionSnapshot } from '../../../shared/types/graph';

function makeTrajectory(overrides: Partial<RecallTrajectory> = {}): RecallTrajectory {
  return {
    promptIndex: 0,
    userPrompt: 'test',
    iterations: [],
    finalContext: 'mock context',
    totalDurationMs: 50,
    shortCircuited: true,
    forcedAnswer: false,
    timedOut: false,
    turnCount: 1,
    historyChars: 100,
    ...overrides,
  };
}

function buildMockPipeline(config: {
  intentResult: Partial<RecallGraphState>;
  replResult: Partial<RecallGraphState>;
}) {
  const annotation = createRecallGraphAnnotation();
  const graph = new StateGraph(annotation);

  graph.addNode('intentAnalysis', async () => config.intentResult);
  graph.addNode('recallRepl', async () => config.replResult);
  graph.addNode('stateUpdate', stateUpdateNode);

  graph.addEdge('intentAnalysis', 'recallRepl');
  graph.addEdge('recallRepl', 'stateUpdate');
  graph.addEdge('stateUpdate', END);
  graph.setEntryPoint('intentAnalysis');

  return graph.compile();
}

// ─────────────────────────────────────────────────────────────────────────────
// E2E Pipeline Tests
//
// These test the full graph pipeline (intent → REPL → state update) with
// mock nodes. They validate state flow, session trace accumulation, snapshot
// integrity, and edge cases in the graph execution engine.
// ─────────────────────────────────────────────────────────────────────────────

describe('graph pipeline: state flow', () => {
  it('intent classification feeds into REPL node state', async () => {
    const history = createCardGameHistory();
    const annotation = createRecallGraphAnnotation();
    const graph = new StateGraph(annotation);

    let capturedState: RecallGraphState | null = null;

    graph.addNode('intentAnalysis', async () => ({
      intent: 'recall' as const,
      keyEntities: ['InputManager', 'autoload'],
    }));
    graph.addNode('recallRepl', async (state) => {
      capturedState = { ...state } as RecallGraphState;
      return {
        recallContext: `Found InputManager context`,
        recallTrajectory: makeTrajectory({ promptIndex: state.promptIndex }),
      };
    });
    graph.addNode('stateUpdate', stateUpdateNode);

    graph.addEdge('intentAnalysis', 'recallRepl');
    graph.addEdge('recallRepl', 'stateUpdate');
    graph.addEdge('stateUpdate', END);
    graph.setEntryPoint('intentAnalysis');

    await graph.compile().invoke({
      userPrompt: 'what about InputManager?',
      history,
      promptIndex: 7,
    });

    expect(capturedState).not.toBeNull();
    expect(capturedState!.intent).toBe('recall');
    expect(capturedState!.keyEntities).toEqual(['InputManager', 'autoload']);
    expect(capturedState!.userPrompt).toBe('what about InputManager?');
    expect(capturedState!.history).toHaveLength(7);
  });

  it('REPL result feeds into state update node', async () => {
    const { state } = await buildMockPipeline({
      intentResult: { intent: 'debug', keyEntities: ['flickering'] },
      replResult: {
        recallContext: 'The flickering bug was a z-index issue',
        recallTrajectory: makeTrajectory({ forcedAnswer: false, timedOut: false }),
      },
    }).invoke({
      userPrompt: 'the flickering bug',
      promptIndex: 3,
    });

    expect(state.sessionTrace.entries).toHaveLength(1);
    expect(state.sessionTrace.entries[0]!.intent).toBe('debug');
    expect(state.sessionTrace.entries[0]!.keyEntities).toEqual(['flickering']);
    expect(state.sessionTrace.entries[0]!.recallSucceeded).toBe(true);
    expect(state.sessionTrace.lastIntent).toBe('debug');
  });

  it('marks recall as failed when context is null', async () => {
    const { state } = await buildMockPipeline({
      intentResult: { intent: 'feature', keyEntities: ['auth'] },
      replResult: {
        recallContext: null,
        recallTrajectory: makeTrajectory({ finalContext: null }),
      },
    }).invoke({
      userPrompt: 'add auth',
      promptIndex: 1,
    });

    expect(state.sessionTrace.entries[0]!.recallSucceeded).toBe(false);
  });

  it('marks recall as failed on forced answer', async () => {
    const { state } = await buildMockPipeline({
      intentResult: { intent: 'general', keyEntities: [] },
      replResult: {
        recallContext: 'some fallback',
        recallTrajectory: makeTrajectory({ forcedAnswer: true }),
      },
    }).invoke({
      userPrompt: 'test',
      promptIndex: 1,
    });

    expect(state.sessionTrace.entries[0]!.recallSucceeded).toBe(false);
  });

  it('marks recall as failed on timeout', async () => {
    const { state } = await buildMockPipeline({
      intentResult: { intent: 'recall', keyEntities: ['auth'] },
      replResult: {
        recallContext: 'partial results',
        recallTrajectory: makeTrajectory({ timedOut: true }),
      },
    }).invoke({
      userPrompt: 'what about auth?',
      promptIndex: 5,
    });

    expect(state.sessionTrace.entries[0]!.recallSucceeded).toBe(false);
  });
});

describe('graph pipeline: session trace accumulation', () => {
  it('accumulates entries across 5 sequential turns', async () => {
    const turns = [
      { intent: 'feature', entities: ['auth'], prompt: 'add auth' },
      { intent: 'debug', entities: ['login', 'error'], prompt: 'fix login error' },
      { intent: 'recall', entities: ['auth'], prompt: 'what about auth?' },
      { intent: 'explain', entities: ['middleware'], prompt: 'explain the middleware' },
      { intent: 'refactor', entities: ['auth', 'session'], prompt: 'refactor auth session' },
    ];

    let trace = makeEmptyTrace();

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]!;
      const { state } = await buildMockPipeline({
        intentResult: { intent: turn.intent, keyEntities: turn.entities },
        replResult: {
          recallContext: `context for ${turn.prompt}`,
          recallTrajectory: makeTrajectory({ promptIndex: i }),
        },
      }).invoke({
        userPrompt: turn.prompt,
        promptIndex: i,
        sessionTrace: trace,
      });

      trace = state.sessionTrace;
    }

    expect(trace.entries).toHaveLength(5);
    expect(trace.entries.map(e => e.intent)).toEqual(['feature', 'debug', 'recall', 'explain', 'refactor']);
    expect(trace.lastIntent).toBe('refactor');
    expect(trace.recentEntities).toContain('auth');
    expect(trace.recentEntities).toContain('login');
    expect(trace.recentEntities).toContain('middleware');
    expect(trace.recentEntities).toContain('session');
  });

  it('deduplicates entities in recentEntities', async () => {
    let trace = makeEmptyTrace();

    for (let i = 0; i < 3; i++) {
      const { state } = await buildMockPipeline({
        intentResult: { intent: 'feature', keyEntities: ['auth', 'session'] },
        replResult: {
          recallContext: 'mock',
          recallTrajectory: makeTrajectory({ promptIndex: i }),
        },
      }).invoke({
        userPrompt: 'test',
        promptIndex: i,
        sessionTrace: trace,
      });
      trace = state.sessionTrace;
    }

    const authCount = trace.recentEntities.filter(e => e === 'auth').length;
    expect(authCount).toBe(1);
  });

  it('caps recentEntities at 20', async () => {
    let trace = makeEmptyTrace();
    const manyEntities = Array.from({ length: 8 }, (_, i) => `entity_${i}`);

    for (let i = 0; i < 5; i++) {
      const { state } = await buildMockPipeline({
        intentResult: { intent: 'feature', keyEntities: manyEntities.map(e => `${e}_turn${i}`) },
        replResult: {
          recallContext: 'mock',
          recallTrajectory: makeTrajectory({ promptIndex: i }),
        },
      }).invoke({
        userPrompt: 'test',
        promptIndex: i,
        sessionTrace: trace,
      });
      trace = state.sessionTrace;
    }

    expect(trace.recentEntities.length).toBeLessThanOrEqual(20);
  });

  it('preserves trace entries from prior turns when building new ones', async () => {
    const priorTrace: SessionTrace = {
      entries: [
        { promptIndex: 0, intent: 'feature', keyEntities: ['auth'], recallSucceeded: true, timestamp: '2025-01-01T00:00:00Z' },
        { promptIndex: 1, intent: 'debug', keyEntities: ['login'], recallSucceeded: false, timestamp: '2025-01-01T00:01:00Z' },
      ],
      lastIntent: 'debug',
      recentEntities: ['auth', 'login'],
    };

    const { state } = await buildMockPipeline({
      intentResult: { intent: 'recall', keyEntities: ['auth'] },
      replResult: {
        recallContext: 'found auth context',
        recallTrajectory: makeTrajectory({ promptIndex: 2 }),
      },
    }).invoke({
      userPrompt: 'what about auth?',
      promptIndex: 2,
      sessionTrace: priorTrace,
    });

    expect(state.sessionTrace.entries).toHaveLength(3);
    expect(state.sessionTrace.entries[0]!.intent).toBe('feature');
    expect(state.sessionTrace.entries[1]!.intent).toBe('debug');
    expect(state.sessionTrace.entries[2]!.intent).toBe('recall');
  });
});

describe('graph pipeline: snapshots', () => {
  it('produces snapshots at each pipeline stage', async () => {
    const snapshots: GraphExecutionSnapshot[] = [];
    const history = createCardGameHistory().slice(0, 2);

    const { snapshot } = await buildMockPipeline({
      intentResult: { intent: 'recall', keyEntities: ['card'] },
      replResult: {
        recallContext: 'card context',
        recallTrajectory: makeTrajectory(),
      },
    }).invoke(
      { userPrompt: 'about cards', history, promptIndex: 2 },
      {
        onSnapshot: (s) => snapshots.push(structuredClone(s)),
        promptIndex: 2,
      },
    );

    expect(snapshots.length).toBeGreaterThanOrEqual(4);

    const initialSnapshot = snapshots[0]!;
    expect(initialSnapshot.currentNode).toBe('intentAnalysis');
    expect(initialSnapshot.nodeStates.every(n => n.status === 'pending')).toBe(true);

    const finalSnapshot = snapshot;
    expect(finalSnapshot.currentNode).toBeNull();
    expect(finalSnapshot.promptIndex).toBe(2);
    expect(finalSnapshot.nodeStates.filter(n => n.status === 'completed')).toHaveLength(3);
    expect(finalSnapshot.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('snapshot topology matches the 3-node graph', async () => {
    const { snapshot } = await buildMockPipeline({
      intentResult: { intent: 'general' },
      replResult: { recallContext: 'test', recallTrajectory: makeTrajectory() },
    }).invoke({ userPrompt: 'test', promptIndex: 0 });

    const { topology } = snapshot;
    const nodeNames = topology.nodes.map(n => n.name);
    expect(nodeNames).toContain('__start__');
    expect(nodeNames).toContain('intentAnalysis');
    expect(nodeNames).toContain('recallRepl');
    expect(nodeNames).toContain('stateUpdate');
    expect(nodeNames).toContain('__end__');

    expect(topology.edges.some(e => e.from === '__start__' && e.to === 'intentAnalysis')).toBe(true);
    expect(topology.edges.some(e => e.from === 'intentAnalysis' && e.to === 'recallRepl')).toBe(true);
    expect(topology.edges.some(e => e.from === 'recallRepl' && e.to === 'stateUpdate')).toBe(true);
    expect(topology.edges.some(e => e.from === 'stateUpdate' && e.to === '__end__')).toBe(true);
  });

  it('completed nodes have timing and state data', async () => {
    const { snapshot } = await buildMockPipeline({
      intentResult: { intent: 'debug', keyEntities: ['auth'] },
      replResult: { recallContext: 'context', recallTrajectory: makeTrajectory() },
    }).invoke({ userPrompt: 'test', promptIndex: 1 });

    for (const nodeState of snapshot.nodeStates.filter(n => n.status === 'completed')) {
      expect(nodeState.startedAt).toBeDefined();
      expect(nodeState.completedAt).toBeDefined();
      expect(nodeState.durationMs).toBeGreaterThanOrEqual(0);
      expect(nodeState.inputState).toBeDefined();
      expect(nodeState.outputState).toBeDefined();
    }
  });

  it('sanitizes history in snapshot state (not the full array)', async () => {
    const history = createCardGameHistory();

    const { snapshot } = await buildMockPipeline({
      intentResult: { intent: 'general' },
      replResult: { recallContext: 'test', recallTrajectory: makeTrajectory() },
    }).invoke({ userPrompt: 'test', history, promptIndex: 7 });

    const graphState = snapshot.graphState as Record<string, unknown>;
    expect(graphState['history']).toBe(`[${history.length} turns]`);
  });
});

describe('graph pipeline: abort handling', () => {
  it('stops execution when abort fires before REPL', async () => {
    const controller = new AbortController();
    const annotation = createRecallGraphAnnotation();
    const graph = new StateGraph(annotation);

    graph.addNode('intentAnalysis', async () => {
      controller.abort();
      return { intent: 'general' as const };
    });
    graph.addNode('recallRepl', async () => {
      throw new Error('Should not execute after abort');
    });
    graph.addNode('stateUpdate', stateUpdateNode);

    graph.addEdge('intentAnalysis', 'recallRepl');
    graph.addEdge('recallRepl', 'stateUpdate');
    graph.addEdge('stateUpdate', END);
    graph.setEntryPoint('intentAnalysis');

    const { state } = await graph.compile().invoke(
      { userPrompt: 'test' },
      { abortSignal: controller.signal },
    );

    expect(state.intent).toBe('general');
    expect(state.recallContext).toBeNull();
  });

  it('preserves partial state from completed nodes after abort', async () => {
    const controller = new AbortController();
    const annotation = createRecallGraphAnnotation();
    const graph = new StateGraph(annotation);

    graph.addNode('intentAnalysis', async () => ({
      intent: 'debug' as const,
      keyEntities: ['error', 'crash'],
    }));
    graph.addNode('recallRepl', async () => {
      controller.abort();
      return { recallContext: 'partial context' };
    });
    graph.addNode('stateUpdate', stateUpdateNode);

    graph.addEdge('intentAnalysis', 'recallRepl');
    graph.addEdge('recallRepl', 'stateUpdate');
    graph.addEdge('stateUpdate', END);
    graph.setEntryPoint('intentAnalysis');

    const { state } = await graph.compile().invoke(
      { userPrompt: 'fix the crash' },
      { abortSignal: controller.signal },
    );

    expect(state.intent).toBe('debug');
    expect(state.keyEntities).toEqual(['error', 'crash']);
    expect(state.recallContext).toBe('partial context');
    expect(state.sessionTrace.entries).toHaveLength(0);
  });
});

describe('graph pipeline: error handling', () => {
  it('propagates node errors with clear error info in snapshot', async () => {
    const snapshots: GraphExecutionSnapshot[] = [];
    const annotation = createRecallGraphAnnotation();
    const graph = new StateGraph(annotation);

    graph.addNode('intentAnalysis', async () => ({ intent: 'general' as const }));
    graph.addNode('recallRepl', async () => {
      throw new Error('SDK connection failed');
    });
    graph.addNode('stateUpdate', stateUpdateNode);

    graph.addEdge('intentAnalysis', 'recallRepl');
    graph.addEdge('recallRepl', 'stateUpdate');
    graph.addEdge('stateUpdate', END);
    graph.setEntryPoint('intentAnalysis');

    await expect(
      graph.compile().invoke(
        { userPrompt: 'test' },
        { onSnapshot: (s) => snapshots.push(structuredClone(s)) },
      ),
    ).rejects.toThrow('SDK connection failed');

    const lastSnapshot = snapshots[snapshots.length - 1]!;
    const errorNode = lastSnapshot.nodeStates.find(n => n.status === 'error');
    expect(errorNode).toBeDefined();
    expect(errorNode!.name).toBe('recallRepl');
    expect(errorNode!.error).toBe('SDK connection failed');
  });
});

describe('graph pipeline: intent analysis with mock SDK', () => {
  let intentAnalysisNode: typeof import('../graph/nodes/intent-analysis').intentAnalysisNode;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
  });

  it('skips classification for small history (under direct threshold)', async () => {
    vi.doMock('../../shared/sdk-loader', () => ({
      loadSdkQuery: () => null,
    }));
    const module = await import('../graph/nodes/intent-analysis');
    intentAnalysisNode = module.intentAnalysisNode;

    const history = [createMinimalTurn({ promptIndex: 0, userMessage: 'hi', assistantResponse: 'hello' })];
    const result = await intentAnalysisNode(
      {
        userPrompt: 'test',
        history,
        promptIndex: 1,
        intent: 'general',
        keyEntities: [],
        recallContext: null,
        recallTrajectory: null,
        sessionTrace: makeEmptyTrace(),
      } as RecallGraphState,
      { nodeName: 'intentAnalysis' },
    );

    expect(result.intent).toBe('general');
    expect(result.keyEntities).toEqual([]);
  });

  it('classifies intent using structured output from SDK', async () => {
    const mockSdk = createFullMockSdkQuery({
      intentResponse: { intent: 'recall', keyEntities: ['InputManager', 'autoload'] },
      replResponses: [],
    });

    vi.doMock('../../shared/sdk-loader', () => ({
      loadSdkQuery: () => mockSdk,
    }));
    const module = await import('../graph/nodes/intent-analysis');
    intentAnalysisNode = module.intentAnalysisNode;

    const history = padHistory(createLargeHistory(20));
    const result = await intentAnalysisNode(
      {
        userPrompt: 'what did you say about the InputManager autoload singleton that was registered in the project structure setup?',
        history,
        promptIndex: 20,
        intent: 'general',
        keyEntities: [],
        recallContext: null,
        recallTrajectory: null,
        sessionTrace: makeEmptyTrace(),
      } as RecallGraphState,
      { nodeName: 'intentAnalysis' },
    );

    expect(result.intent).toBe('recall');
    expect(result.keyEntities).toEqual(['InputManager', 'autoload']);
  });

  it('returns defaults when SDK is unavailable', async () => {
    vi.doMock('../../shared/sdk-loader', () => ({
      loadSdkQuery: () => null,
    }));
    const module = await import('../graph/nodes/intent-analysis');
    intentAnalysisNode = module.intentAnalysisNode;

    const history = createLargeHistory(20);
    const result = await intentAnalysisNode(
      {
        userPrompt: 'complex query requiring classification',
        history,
        promptIndex: 20,
        intent: 'general',
        keyEntities: [],
        recallContext: null,
        recallTrajectory: null,
        sessionTrace: makeEmptyTrace(),
      } as RecallGraphState,
      { nodeName: 'intentAnalysis' },
    );

    expect(result.intent).toBe('general');
    expect(result.keyEntities).toEqual([]);
  });
});

describe('graph pipeline: full REPL node with mock SDK', () => {
  let createRecallReplNode: typeof import('../graph/nodes/recall-repl').createRecallReplNode;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
  });

  it('REPL node executes search code and returns context', async () => {
    const mockSdk = createFullMockSdkQuery({
      replResponses: [{
        text: '```repl\nconst matches = context.filter(t => t.userMessage.includes("deck"));\nconst output = matches.map(t => `[Prompt ${t.promptIndex}] User: ${t.userMessage}\\nAssistant: ${t.assistantResponse}`).join("\\n\\n");\nFINAL(output);\n```',
      }],
    });

    vi.doMock('../../shared/sdk-loader', () => ({
      loadSdkQuery: () => mockSdk,
    }));

    const replModule = await import('../graph/nodes/recall-repl');
    createRecallReplNode = replModule.createRecallReplNode;

    const history = padHistory(createLargeHistory(20));
    const replNode = createRecallReplNode({
      config: { enabled: true, subcallModel: 'test', maxIterations: 15, maxInjectedChars: 200_000 },
      cwd: '/test',
      model: 'test-model',
    });

    const result = await replNode(
      {
        userPrompt: 'show me the deck data structure implementation and JSON card definition loader we discussed earlier',
        history,
        promptIndex: 20,
        intent: 'recall',
        keyEntities: ['deck'],
        recallContext: null,
        recallTrajectory: null,
        sessionTrace: makeEmptyTrace(),
      } as RecallGraphState,
      { nodeName: 'recallRepl' },
    );

    expect(result.recallContext).not.toBeNull();
    expect(result.recallTrajectory).toBeDefined();
    expect(result.recallTrajectory!.shortCircuited).toBe(false);
  });
});
