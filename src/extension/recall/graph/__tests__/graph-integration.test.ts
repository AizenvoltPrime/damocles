import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StateGraph, END } from '../state-graph';
import { createRecallGraphAnnotation } from '../recall-graph-state';
import { stateUpdateNode } from '../nodes/state-update';
import type { RecallGraphState } from '../recall-graph-state';
import type { StructuredTurn } from '../../types';
import type { GraphExecutionSnapshot } from '../../../../shared/types/graph';

function makeTurn(overrides: Partial<StructuredTurn> = {}): StructuredTurn {
  return {
    promptIndex: 0,
    timestamp: '2025-01-01T00:00:00.000Z',
    userMessage: 'test message',
    assistantResponse: 'test response',
    toolCalls: [],
    thinkingBlocks: [],
    filesTouched: [],
    ...overrides,
  };
}

describe('recall graph integration', () => {
  it('builds and compiles the full 3-node graph topology', () => {
    const annotation = createRecallGraphAnnotation();
    const graph = new StateGraph(annotation);

    graph.addNode('intent', async () => ({
      intent: 'debug' as const,
      keyEntities: ['auth'],
    }));
    graph.addNode('repl', async () => ({
      recallContext: 'mock context',
      recallTrajectory: {
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
      },
    }));
    graph.addNode('stateUpdate', stateUpdateNode);

    graph.addEdge('intent', 'repl');
    graph.addEdge('repl', 'stateUpdate');
    graph.addEdge('stateUpdate', END);
    graph.setEntryPoint('intent');

    const compiled = graph.compile();
    const topology = compiled.getTopology();

    expect(topology.nodes.filter(n => n.type === 'node')).toHaveLength(3);
    expect(topology.edges.length).toBeGreaterThanOrEqual(4);
  });

  it('runs the full pipeline with mock intent + repl nodes', async () => {
    const snapshots: GraphExecutionSnapshot[] = [];

    const annotation = createRecallGraphAnnotation();
    const graph = new StateGraph(annotation);

    graph.addNode('intent', async () => ({
      intent: 'feature' as const,
      keyEntities: ['sidebar', 'navigation'],
    }));
    graph.addNode('repl', async (state) => ({
      recallContext: `Context for ${state.intent}: ${state.keyEntities.join(', ')}`,
      recallTrajectory: {
        promptIndex: state.promptIndex,
        userPrompt: state.userPrompt,
        iterations: [],
        finalContext: `Context for ${state.intent}`,
        totalDurationMs: 80,
        shortCircuited: false,
        forcedAnswer: false,
        timedOut: false,
        turnCount: state.history.length,
        historyChars: 5000,
      },
    }));
    graph.addNode('stateUpdate', stateUpdateNode);

    graph.addEdge('intent', 'repl');
    graph.addEdge('repl', 'stateUpdate');
    graph.addEdge('stateUpdate', END);
    graph.setEntryPoint('intent');

    const history = [makeTurn(), makeTurn({ promptIndex: 1, userMessage: 'add sidebar' })];
    const compiled = graph.compile();
    const { state, snapshot } = await compiled.invoke(
      {
        userPrompt: 'add navigation to sidebar',
        history,
        promptIndex: 2,
      },
      {
        onSnapshot: (s) => snapshots.push(structuredClone(s)),
        promptIndex: 2,
      },
    );

    expect(state.intent).toBe('feature');
    expect(state.keyEntities).toEqual(['sidebar', 'navigation']);
    expect(state.recallContext).toContain('feature');
    expect(state.sessionTrace.entries).toHaveLength(1);
    expect(state.sessionTrace.entries[0]!.intent).toBe('feature');
    expect(state.sessionTrace.entries[0]!.recallSucceeded).toBe(true);
    expect(state.sessionTrace.lastIntent).toBe('feature');

    expect(snapshot.currentNode).toBeNull();
    expect(snapshot.promptIndex).toBe(2);
    expect(snapshot.nodeStates.filter(n => n.status === 'completed')).toHaveLength(3);
    expect(snapshots.length).toBeGreaterThanOrEqual(4);
  });

  it('handles abort during pipeline execution', async () => {
    const controller = new AbortController();

    const annotation = createRecallGraphAnnotation();
    const graph = new StateGraph(annotation);

    graph.addNode('intent', async () => {
      controller.abort();
      return { intent: 'general' as const };
    });
    graph.addNode('repl', async () => {
      throw new Error('Should not reach REPL');
    });
    graph.addNode('stateUpdate', stateUpdateNode);

    graph.addEdge('intent', 'repl');
    graph.addEdge('repl', 'stateUpdate');
    graph.addEdge('stateUpdate', END);
    graph.setEntryPoint('intent');

    const { state } = await graph.compile().invoke(
      { userPrompt: 'test' },
      { abortSignal: controller.signal },
    );

    expect(state.intent).toBe('general');
    expect(state.recallContext).toBeNull();
  });

  it('accumulates session trace across multiple invocations', async () => {
    const annotation = createRecallGraphAnnotation();

    async function runTurn(
      promptIndex: number,
      intent: string,
      keyEntities: string[],
      sessionTrace: RecallGraphState['sessionTrace'],
    ): Promise<RecallGraphState> {
      const graph = new StateGraph(annotation);
      graph.addNode('intent', async () => ({
        intent: intent as RecallGraphState['intent'],
        keyEntities,
      }));
      graph.addNode('repl', async () => ({
        recallContext: 'mock',
        recallTrajectory: {
          promptIndex,
          userPrompt: 'test',
          iterations: [],
          finalContext: 'mock',
          totalDurationMs: 50,
          shortCircuited: true,
          forcedAnswer: false,
          timedOut: false,
          turnCount: promptIndex + 1,
          historyChars: 1000,
        },
      }));
      graph.addNode('stateUpdate', stateUpdateNode);
      graph.addEdge('intent', 'repl');
      graph.addEdge('repl', 'stateUpdate');
      graph.addEdge('stateUpdate', END);
      graph.setEntryPoint('intent');

      const { state } = await graph.compile().invoke({
        userPrompt: 'test',
        promptIndex,
        sessionTrace,
      });
      return state;
    }

    const s1 = await runTurn(0, 'feature', ['auth'], { entries: [], lastIntent: '', recentEntities: [] });
    expect(s1.sessionTrace.entries).toHaveLength(1);
    expect(s1.sessionTrace.lastIntent).toBe('feature');

    const s2 = await runTurn(1, 'debug', ['login', 'error'], s1.sessionTrace);
    expect(s2.sessionTrace.entries).toHaveLength(2);
    expect(s2.sessionTrace.lastIntent).toBe('debug');
    expect(s2.sessionTrace.recentEntities).toContain('auth');
    expect(s2.sessionTrace.recentEntities).toContain('login');

    const s3 = await runTurn(2, 'recall', ['auth'], s2.sessionTrace);
    expect(s3.sessionTrace.entries).toHaveLength(3);
    expect(s3.sessionTrace.entries.map(e => e.intent)).toEqual(['feature', 'debug', 'recall']);
  });
});
