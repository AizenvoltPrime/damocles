import { describe, it, expect } from 'vitest';
import { StateGraph, START, END } from '../state-graph';
import type { AnnotationSpec, NodeFunction } from '../types';
import type { GraphExecutionSnapshot } from '../../../../shared/types/graph';

// ─────────────────────────────────────────────────────────────────────────────
// Test state types
// ─────────────────────────────────────────────────────────────────────────────

type TestState = {
  value: number;
  label: string;
  items: string[];
};

function makeAnnotation(): AnnotationSpec<TestState> {
  return {
    defaults: () => ({ value: 0, label: '', items: [] }),
  };
}

function makeAnnotationWithReducers(): AnnotationSpec<TestState> {
  return {
    defaults: () => ({ value: 0, label: '', items: [] }),
    reducers: {
      value: (current: number, update: number) => current + update,
      items: (current: string[], update: string[]) => [...current, ...update],
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// StateGraph construction
// ─────────────────────────────────────────────────────────────────────────────

describe('StateGraph construction', () => {
  it('creates a graph with nodes and edges', () => {
    const graph = new StateGraph(makeAnnotation());
    const node: NodeFunction<TestState> = async (state) => ({ value: state.value + 1 });

    graph.addNode('increment', node);
    graph.addEdge('increment', END);
    graph.setEntryPoint('increment');

    const compiled = graph.compile();
    expect(compiled).toBeDefined();
    expect(compiled.invoke).toBeInstanceOf(Function);
    expect(compiled.getTopology).toBeInstanceOf(Function);
  });

  it('supports method chaining', () => {
    const graph = new StateGraph(makeAnnotation());
    const node: NodeFunction<TestState> = async () => ({});

    const result = graph
      .addNode('a', node)
      .addEdge('a', END)
      .setEntryPoint('a');

    expect(result).toBe(graph);
  });

  it('throws when using reserved name START as node name', () => {
    const graph = new StateGraph(makeAnnotation());
    expect(() => graph.addNode(START, async () => ({}))).toThrow('reserved name');
  });

  it('throws when using reserved name END as node name', () => {
    const graph = new StateGraph(makeAnnotation());
    expect(() => graph.addNode(END, async () => ({}))).toThrow('reserved name');
  });

  it('throws when compiling without entry point', () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('a', async () => ({}));
    expect(() => graph.compile()).toThrow('Entry point must be set');
  });

  it('throws when entry point references non-existent node', () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('a', async () => ({}));
    graph.setEntryPoint('nonexistent');
    expect(() => graph.compile()).toThrow('does not reference an existing node');
  });

  it('throws when static edge target does not exist', () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('a', async () => ({}));
    graph.addEdge('a', 'nonexistent');
    graph.setEntryPoint('a');
    expect(() => graph.compile()).toThrow('does not reference an existing node');
  });

  it('throws when static edge source does not exist', () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('a', async () => ({}));
    graph.addEdge('nonexistent', 'a');
    graph.setEntryPoint('a');
    expect(() => graph.compile()).toThrow('does not reference an existing node');
  });

  it('allows START as edge source', () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('a', async () => ({}));
    graph.addEdge(START, 'a');
    graph.addEdge('a', END);
    graph.setEntryPoint('a');
    expect(() => graph.compile()).not.toThrow();
  });

  it('allows END as edge target', () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('a', async () => ({}));
    graph.addEdge('a', END);
    graph.setEntryPoint('a');
    expect(() => graph.compile()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Topology
// ─────────────────────────────────────────────────────────────────────────────

describe('getTopology', () => {
  it('includes START and END nodes', () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('a', async () => ({}));
    graph.addEdge('a', END);
    graph.setEntryPoint('a');

    const topology = graph.compile().getTopology();
    expect(topology.nodes.find(n => n.name === START)).toEqual({ name: START, type: 'start' });
    expect(topology.nodes.find(n => n.name === END)).toEqual({ name: END, type: 'end' });
  });

  it('includes all user-defined nodes', () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('alpha', async () => ({}));
    graph.addNode('beta', async () => ({}));
    graph.addEdge('alpha', 'beta');
    graph.addEdge('beta', END);
    graph.setEntryPoint('alpha');

    const topology = graph.compile().getTopology();
    const userNodes = topology.nodes.filter(n => n.type === 'node');
    expect(userNodes).toHaveLength(2);
    expect(userNodes.map(n => n.name)).toContain('alpha');
    expect(userNodes.map(n => n.name)).toContain('beta');
  });

  it('includes entry edge from START to entry node', () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('first', async () => ({}));
    graph.addEdge('first', END);
    graph.setEntryPoint('first');

    const topology = graph.compile().getTopology();
    const entryEdge = topology.edges.find(e => e.from === START);
    expect(entryEdge).toEqual({ from: START, to: 'first', type: 'static' });
  });

  it('includes static edges', () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('a', async () => ({}));
    graph.addNode('b', async () => ({}));
    graph.addEdge('a', 'b');
    graph.addEdge('b', END);
    graph.setEntryPoint('a');

    const topology = graph.compile().getTopology();
    expect(topology.edges).toContainEqual({ from: 'a', to: 'b', type: 'static' });
    expect(topology.edges).toContainEqual({ from: 'b', to: END, type: 'static' });
  });

  it('includes conditional edges with labels', () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('router', async () => ({}));
    graph.addNode('pathA', async () => ({}));
    graph.addNode('pathB', async () => ({}));
    graph.addConditionalEdges('router', () => 'go_a', {
      go_a: 'pathA',
      go_b: 'pathB',
    });
    graph.addEdge('pathA', END);
    graph.addEdge('pathB', END);
    graph.setEntryPoint('router');

    const topology = graph.compile().getTopology();
    const condEdges = topology.edges.filter(e => e.type === 'conditional');
    expect(condEdges).toHaveLength(2);
    expect(condEdges).toContainEqual({ from: 'router', to: 'pathA', type: 'conditional', label: 'go_a' });
    expect(condEdges).toContainEqual({ from: 'router', to: 'pathB', type: 'conditional', label: 'go_b' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// invoke — linear execution
// ─────────────────────────────────────────────────────────────────────────────

describe('invoke — linear execution', () => {
  it('executes a single node and returns updated state', async () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('double', async (state) => ({ value: state.value * 2 }));
    graph.addEdge('double', END);
    graph.setEntryPoint('double');

    const { state } = await graph.compile().invoke({ value: 5 });
    expect(state.value).toBe(10);
  });

  it('executes a chain of nodes in order', async () => {
    const executionOrder: string[] = [];

    const graph = new StateGraph(makeAnnotation());
    graph.addNode('first', async (state) => {
      executionOrder.push('first');
      return { value: state.value + 1 };
    });
    graph.addNode('second', async (state) => {
      executionOrder.push('second');
      return { value: state.value * 10 };
    });
    graph.addNode('third', async (state) => {
      executionOrder.push('third');
      return { label: `result: ${state.value}` };
    });
    graph.addEdge('first', 'second');
    graph.addEdge('second', 'third');
    graph.addEdge('third', END);
    graph.setEntryPoint('first');

    const { state } = await graph.compile().invoke({ value: 3 });
    expect(executionOrder).toEqual(['first', 'second', 'third']);
    expect(state.value).toBe(40);
    expect(state.label).toBe('result: 40');
  });

  it('applies defaults when input is partial', async () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('check', async (state) => {
      return { label: `v=${state.value},items=${state.items.length}` };
    });
    graph.addEdge('check', END);
    graph.setEntryPoint('check');

    const { state } = await graph.compile().invoke({});
    expect(state.label).toBe('v=0,items=0');
  });

  it('merges input with defaults', async () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('pass', async () => ({}));
    graph.addEdge('pass', END);
    graph.setEntryPoint('pass');

    const { state } = await graph.compile().invoke({ value: 42 });
    expect(state.value).toBe(42);
    expect(state.label).toBe('');
    expect(state.items).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// invoke — reducers
// ─────────────────────────────────────────────────────────────────────────────

describe('invoke — reducers', () => {
  it('applies additive reducer for value', async () => {
    const graph = new StateGraph(makeAnnotationWithReducers());
    graph.addNode('add5', async () => ({ value: 5 }));
    graph.addNode('add10', async () => ({ value: 10 }));
    graph.addEdge('add5', 'add10');
    graph.addEdge('add10', END);
    graph.setEntryPoint('add5');

    const { state } = await graph.compile().invoke({ value: 100 });
    expect(state.value).toBe(115);
  });

  it('applies concat reducer for items', async () => {
    const graph = new StateGraph(makeAnnotationWithReducers());
    graph.addNode('addA', async () => ({ items: ['a'] }));
    graph.addNode('addB', async () => ({ items: ['b', 'c'] }));
    graph.addEdge('addA', 'addB');
    graph.addEdge('addB', END);
    graph.setEntryPoint('addA');

    const { state } = await graph.compile().invoke({});
    expect(state.items).toEqual(['a', 'b', 'c']);
  });

  it('uses direct assignment when no reducer exists for a key', async () => {
    const graph = new StateGraph(makeAnnotationWithReducers());
    graph.addNode('setLabel', async () => ({ label: 'hello' }));
    graph.addEdge('setLabel', END);
    graph.setEntryPoint('setLabel');

    const { state } = await graph.compile().invoke({ label: 'original' });
    expect(state.label).toBe('hello');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// invoke — conditional edges
// ─────────────────────────────────────────────────────────────────────────────

describe('invoke — conditional edges', () => {
  it('routes to correct branch based on state', async () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('router', async () => ({}));
    graph.addNode('high', async () => ({ label: 'high path' }));
    graph.addNode('low', async () => ({ label: 'low path' }));
    graph.addConditionalEdges('router', (state) => state.value > 50 ? 'high' : 'low', {
      high: 'high',
      low: 'low',
    });
    graph.addEdge('high', END);
    graph.addEdge('low', END);
    graph.setEntryPoint('router');

    const highResult = await graph.compile().invoke({ value: 100 });
    expect(highResult.state.label).toBe('high path');

    const lowResult = await graph.compile().invoke({ value: 10 });
    expect(lowResult.state.label).toBe('low path');
  });

  it('throws when route function returns unknown key', async () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('router', async () => ({}));
    graph.addNode('only', async () => ({}));
    graph.addConditionalEdges('router', () => 'unknown_key', {
      known: 'only',
    });
    graph.addEdge('only', END);
    graph.setEntryPoint('router');

    await expect(graph.compile().invoke({})).rejects.toThrow('unknown key');
  });

  it('supports conditional edge to END', async () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('check', async () => ({}));
    graph.addConditionalEdges('check', (state) => state.value > 0 ? 'done' : 'continue', {
      done: END,
      continue: 'check',
    });
    graph.setEntryPoint('check');

    const { state } = await graph.compile().invoke({ value: 1 });
    expect(state.value).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// invoke — snapshots
// ─────────────────────────────────────────────────────────────────────────────

describe('invoke — snapshots', () => {
  it('emits snapshots via onSnapshot callback', async () => {
    const snapshots: GraphExecutionSnapshot[] = [];

    const graph = new StateGraph(makeAnnotation());
    graph.addNode('a', async () => ({ value: 1 }));
    graph.addNode('b', async () => ({ label: 'done' }));
    graph.addEdge('a', 'b');
    graph.addEdge('b', END);
    graph.setEntryPoint('a');

    await graph.compile().invoke({}, {
      onSnapshot: (s) => snapshots.push(structuredClone(s)),
    });

    expect(snapshots.length).toBeGreaterThanOrEqual(3);

    const initialSnapshot = snapshots[0]!;
    expect(initialSnapshot.currentNode).toBe('a');
    const pendingNodes = initialSnapshot.nodeStates.filter(n => n.status === 'pending');
    expect(pendingNodes.length).toBeGreaterThanOrEqual(1);
  });

  it('final snapshot has null currentNode', async () => {
    const snapshots: GraphExecutionSnapshot[] = [];

    const graph = new StateGraph(makeAnnotation());
    graph.addNode('only', async () => ({ value: 42 }));
    graph.addEdge('only', END);
    graph.setEntryPoint('only');

    await graph.compile().invoke({}, {
      onSnapshot: (s) => snapshots.push(structuredClone(s)),
    });

    const last = snapshots[snapshots.length - 1]!;
    expect(last.currentNode).toBeNull();
  });

  it('snapshot tracks node running and completed status', async () => {
    const snapshots: GraphExecutionSnapshot[] = [];

    const graph = new StateGraph(makeAnnotation());
    graph.addNode('work', async () => ({ value: 1 }));
    graph.addEdge('work', END);
    graph.setEntryPoint('work');

    await graph.compile().invoke({}, {
      onSnapshot: (s) => snapshots.push(structuredClone(s)),
    });

    const runningSnapshot = snapshots.find(s =>
      s.nodeStates.some(n => n.name === 'work' && n.status === 'running'),
    );
    expect(runningSnapshot).toBeDefined();

    const completedSnapshot = snapshots.find(s =>
      s.nodeStates.some(n => n.name === 'work' && n.status === 'completed'),
    );
    expect(completedSnapshot).toBeDefined();
  });

  it('snapshot includes promptIndex from options', async () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('a', async () => ({}));
    graph.addEdge('a', END);
    graph.setEntryPoint('a');

    const { snapshot } = await graph.compile().invoke({}, { promptIndex: 42 });
    expect(snapshot.promptIndex).toBe(42);
  });

  it('snapshot defaults promptIndex to -1', async () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('a', async () => ({}));
    graph.addEdge('a', END);
    graph.setEntryPoint('a');

    const { snapshot } = await graph.compile().invoke({});
    expect(snapshot.promptIndex).toBe(-1);
  });

  it('snapshot tracks totalDurationMs', async () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('slow', async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return {};
    });
    graph.addEdge('slow', END);
    graph.setEntryPoint('slow');

    const { snapshot } = await graph.compile().invoke({});
    expect(snapshot.totalDurationMs).toBeGreaterThanOrEqual(40);
  });

  it('snapshot includes topology', async () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('a', async () => ({}));
    graph.addEdge('a', END);
    graph.setEntryPoint('a');

    const { snapshot } = await graph.compile().invoke({});
    expect(snapshot.topology.nodes.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.topology.edges.length).toBeGreaterThanOrEqual(2);
  });

  it('node error status is captured in snapshot', async () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('fail', async () => { throw new Error('node failed'); });
    graph.addEdge('fail', END);
    graph.setEntryPoint('fail');

    const snapshots: GraphExecutionSnapshot[] = [];
    await expect(
      graph.compile().invoke({}, {
        onSnapshot: (s) => snapshots.push(structuredClone(s)),
      }),
    ).rejects.toThrow('node failed');

    const errorSnapshot = snapshots.find(s =>
      s.nodeStates.some(n => n.status === 'error'),
    );
    expect(errorSnapshot).toBeDefined();
    const errorNode = errorSnapshot!.nodeStates.find(n => n.status === 'error')!;
    expect(errorNode.error).toBe('node failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// invoke — abort signal
// ─────────────────────────────────────────────────────────────────────────────

describe('invoke — abort signal', () => {
  it('stops execution when abort signal fires', async () => {
    const executionOrder: string[] = [];
    const controller = new AbortController();

    const graph = new StateGraph(makeAnnotation());
    graph.addNode('a', async () => {
      executionOrder.push('a');
      controller.abort();
      return { value: 1 };
    });
    graph.addNode('b', async () => {
      executionOrder.push('b');
      return { value: 2 };
    });
    graph.addEdge('a', 'b');
    graph.addEdge('b', END);
    graph.setEntryPoint('a');

    await graph.compile().invoke({}, { abortSignal: controller.signal });
    expect(executionOrder).toEqual(['a']);
  });

  it('stops before first node when already aborted', async () => {
    const executionOrder: string[] = [];
    const controller = new AbortController();
    controller.abort();

    const graph = new StateGraph(makeAnnotation());
    graph.addNode('a', async () => {
      executionOrder.push('a');
      return {};
    });
    graph.addEdge('a', END);
    graph.setEntryPoint('a');

    await graph.compile().invoke({}, { abortSignal: controller.signal });
    expect(executionOrder).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// invoke — error propagation
// ─────────────────────────────────────────────────────────────────────────────

describe('invoke — error propagation', () => {
  it('propagates node errors', async () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('fail', async () => { throw new Error('node error'); });
    graph.addEdge('fail', END);
    graph.setEntryPoint('fail');

    await expect(graph.compile().invoke({})).rejects.toThrow('node error');
  });

  it('throws when no outgoing edge exists', async () => {
    const graph = new StateGraph(makeAnnotation());
    graph.addNode('orphan', async () => ({}));
    graph.setEntryPoint('orphan');

    await expect(graph.compile().invoke({})).rejects.toThrow('No outgoing edge');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// invoke — state sanitization for snapshots
// ─────────────────────────────────────────────────────────────────────────────

describe('state sanitization', () => {
  it('truncates long strings in snapshot graphState', async () => {
    type LargeState = { data: string };
    const annotation: AnnotationSpec<LargeState> = {
      defaults: () => ({ data: '' }),
    };

    const graph = new StateGraph(annotation);
    graph.addNode('fill', async () => ({ data: 'x'.repeat(5000) }));
    graph.addEdge('fill', END);
    graph.setEntryPoint('fill');

    const { snapshot } = await graph.compile().invoke({});
    const data = snapshot.graphState['data'] as string;
    expect(data.length).toBeLessThan(5000);
    expect(data).toContain('chars]');
  });

  it('summarizes history array in snapshot', async () => {
    type HistoryState = { history: unknown[] };
    const annotation: AnnotationSpec<HistoryState> = {
      defaults: () => ({ history: [] }),
    };

    const graph = new StateGraph(annotation);
    graph.addNode('pass', async () => ({}));
    graph.addEdge('pass', END);
    graph.setEntryPoint('pass');

    const { snapshot } = await graph.compile().invoke({
      history: [{ a: 1 }, { a: 2 }, { a: 3 }],
    });
    expect(snapshot.graphState['history']).toBe('[3 turns]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MAX_STEPS safety
// ─────────────────────────────────────────────────────────────────────────────

describe('MAX_STEPS safety', () => {
  it('stops after 50 steps to prevent infinite loops', async () => {
    let stepCount = 0;

    const graph = new StateGraph(makeAnnotation());
    graph.addNode('loop', async (state) => {
      stepCount++;
      return { value: state.value + 1 };
    });
    graph.addConditionalEdges('loop', () => 'again', {
      again: 'loop',
    });
    graph.setEntryPoint('loop');

    const { state } = await graph.compile().invoke({});
    expect(stepCount).toBe(50);
    expect(state.value).toBe(50);
  });
});
