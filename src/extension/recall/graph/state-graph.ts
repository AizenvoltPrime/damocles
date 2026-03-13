import { log } from '../../logger';
import type {
  AnnotationSpec, NodeFunction, RouteFunction, EdgeDefinition,
  CompiledGraph, GraphInvokeOptions, GraphInvokeResult, NodeExecutionContext,
  StateShape,
} from './types';
import type { GraphTopology, GraphNodeState, GraphExecutionSnapshot } from '../../../shared/types/graph';

export const START = '__start__';
export const END = '__end__';

const MAX_STEPS = 50;

export class StateGraph<S extends StateShape> {
  private annotation: AnnotationSpec<S>;
  private nodes = new Map<string, NodeFunction<S>>();
  private edges: EdgeDefinition<S>[] = [];
  private entryNode: string | null = null;

  constructor(annotation: AnnotationSpec<S>) {
    this.annotation = annotation;
  }

  addNode(name: string, fn: NodeFunction<S>): this {
    if (name === START || name === END) {
      throw new Error(`Cannot use reserved name "${name}" as a node name`);
    }
    this.nodes.set(name, fn);
    return this;
  }

  addEdge(from: string, to: string): this {
    this.edges.push({ type: 'static', from, to });
    return this;
  }

  addConditionalEdges(from: string, routeFn: RouteFunction<S>, targets: Record<string, string>): this {
    this.edges.push({ type: 'conditional', from, routeFn, targets });
    return this;
  }

  setEntryPoint(name: string): this {
    this.entryNode = name;
    return this;
  }

  compile(): CompiledGraph<S> {
    if (!this.entryNode) {
      throw new Error('Entry point must be set before compiling');
    }
    if (!this.nodes.has(this.entryNode)) {
      throw new Error(`Entry point "${this.entryNode}" does not reference an existing node`);
    }

    for (const edge of this.edges) {
      if (edge.type === 'static') {
        if (edge.to !== END && !this.nodes.has(edge.to)) {
          throw new Error(`Static edge target "${edge.to}" does not reference an existing node`);
        }
        if (edge.from !== START && !this.nodes.has(edge.from)) {
          throw new Error(`Static edge source "${edge.from}" does not reference an existing node`);
        }
      } else {
        if (!this.nodes.has(edge.from)) {
          throw new Error(`Conditional edge source "${edge.from}" does not reference an existing node`);
        }
        for (const [label, target] of Object.entries(edge.targets)) {
          if (target !== END && !this.nodes.has(target)) {
            throw new Error(`Conditional edge target "${target}" (label "${label}") does not reference an existing node`);
          }
        }
      }
    }

    const topology = this.buildTopology();
    const nodesCopy = new Map(this.nodes);
    const edgesCopy = [...this.edges];
    const annotation = this.annotation;
    const entryNode = this.entryNode;

    return {
      getTopology: () => topology,

      invoke: async (input: Partial<S>, options?: GraphInvokeOptions): Promise<GraphInvokeResult<S>> => {
        const startTime = Date.now();
        const promptIndex = options?.promptIndex ?? -1;

        let state = { ...annotation.defaults() } as S;
        for (const key of Object.keys(input) as Array<keyof S>) {
          if (input[key] !== undefined) {
            state[key] = input[key] as S[keyof S];
          }
        }

        const nodeStates = new Map<string, GraphNodeState>();
        for (const [name] of nodesCopy) {
          nodeStates.set(name, { name, status: 'pending' });
        }

        const buildSnapshot = (currentNode: string | null): GraphExecutionSnapshot => ({
          topology,
          nodeStates: [...nodeStates.values()],
          currentNode,
          graphState: sanitizeStateForSnapshot(state),
          totalDurationMs: Date.now() - startTime,
          promptIndex,
        });

        options?.onSnapshot?.(buildSnapshot(entryNode));

        let currentNodeName = entryNode;
        let steps = 0;
        let aborted = false;

        while (currentNodeName !== END && steps < MAX_STEPS) {
          steps++;

          if (options?.abortSignal?.aborted) {
            log('[StateGraph] Aborted at node %s', currentNodeName);
            aborted = true;
            break;
          }

          const nodeFn = nodesCopy.get(currentNodeName);
          if (!nodeFn) {
            throw new Error(`Node "${currentNodeName}" not found`);
          }

          const nodeStart = Date.now();
          const capturedInputState = sanitizeStateForSnapshot(state);
          nodeStates.set(currentNodeName, {
            name: currentNodeName,
            status: 'running',
            startedAt: nodeStart,
            inputState: capturedInputState,
          });
          options?.onSnapshot?.(buildSnapshot(currentNodeName));

          const context: NodeExecutionContext = {
            abortSignal: options?.abortSignal,
            nodeName: currentNodeName,
          };

          try {
            const update = await nodeFn(state as Readonly<S>, context);

            state = applyUpdate(state, update, (annotation.reducers ?? {}) as Record<string, ((current: unknown, update: unknown) => unknown) | undefined>);

            const durationMs = Date.now() - nodeStart;
            nodeStates.set(currentNodeName, {
              name: currentNodeName,
              status: 'completed',
              startedAt: nodeStart,
              completedAt: Date.now(),
              durationMs,
              inputState: capturedInputState,
              outputState: sanitizePartialForSnapshot(update),
            });
          } catch (err) {
            const durationMs = Date.now() - nodeStart;
            const errorMessage = err instanceof Error ? err.message : String(err);
            nodeStates.set(currentNodeName, {
              name: currentNodeName,
              status: 'error',
              startedAt: nodeStart,
              completedAt: Date.now(),
              durationMs,
              error: errorMessage,
              inputState: capturedInputState,
            });
            options?.onSnapshot?.(buildSnapshot(null));
            throw err;
          }

          currentNodeName = resolveNextNode(currentNodeName, state, edgesCopy);
          options?.onSnapshot?.(buildSnapshot(currentNodeName === END ? null : currentNodeName));
        }

        if (steps >= MAX_STEPS) {
          log('[StateGraph] Max steps (%d) reached, halting', MAX_STEPS);
        }

        const finalSnapshot = buildSnapshot(null);
        return { state, snapshot: finalSnapshot, aborted };
      },
    };
  }

  private buildTopology(): GraphTopology {
    const nodes: GraphTopology['nodes'] = [
      { name: START, type: 'start' },
    ];
    for (const [name] of this.nodes) {
      nodes.push({ name, type: 'node' });
    }
    nodes.push({ name: END, type: 'end' });

    const edges: GraphTopology['edges'] = [
      { from: START, to: this.entryNode!, type: 'static' },
    ];
    for (const edge of this.edges) {
      if (edge.type === 'static') {
        edges.push({ from: edge.from, to: edge.to, type: 'static' });
      } else {
        for (const [label, target] of Object.entries(edge.targets)) {
          edges.push({ from: edge.from, to: target, type: 'conditional', label });
        }
      }
    }

    return { nodes, edges };
  }
}

function applyUpdate<S extends StateShape>(
  state: S,
  update: Partial<S>,
  reducers: Record<string, ((current: unknown, update: unknown) => unknown) | undefined>,
): S {
  const next = { ...state };
  for (const key of Object.keys(update) as Array<keyof S>) {
    const reducer = reducers[key as string];
    if (reducer) {
      next[key] = reducer(state[key], update[key]) as S[keyof S];
    } else {
      next[key] = update[key] as S[keyof S];
    }
  }
  return next;
}

function resolveNextNode<S extends StateShape>(
  currentNode: string,
  state: S,
  edges: EdgeDefinition<S>[],
): string {
  for (const edge of edges) {
    if (edge.from !== currentNode) continue;
    if (edge.type === 'static') return edge.to;
    if (edge.type === 'conditional') {
      const key = edge.routeFn(state as Readonly<S>);
      const target = edge.targets[key];
      if (!target) throw new Error(`Conditional edge from "${currentNode}" returned unknown key "${key}"`);
      return target;
    }
  }
  throw new Error(`No outgoing edge from node "${currentNode}"`);
}

function sanitizeStateForSnapshot(state: StateShape): StateShape {
  const result: StateShape = {};
  for (const [key, value] of Object.entries(state)) {
    if (key === 'history') {
      result[key] = `[${(value as unknown[]).length} turns]`;
    } else if (typeof value === 'string' && value.length > 2000) {
      result[key] = value.substring(0, 200) + `... [${value.length} chars]`;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function sanitizePartialForSnapshot(update: StateShape): StateShape {
  return sanitizeStateForSnapshot(update);
}
