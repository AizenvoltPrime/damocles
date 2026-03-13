import type { GraphTopology, GraphExecutionSnapshot, GraphNodeState, GraphNodeStatus } from '../../../shared/types/graph';

export type { GraphTopology, GraphExecutionSnapshot, GraphNodeState, GraphNodeStatus };

export type StateReducer<T> = (current: T, update: T) => T;

export type StateShape = { [key: string]: unknown };

export interface AnnotationSpec<S extends StateShape> {
  defaults: () => S;
  reducers?: { [K in keyof S]?: StateReducer<S[K]> } | undefined;
}

export interface NodeFunction<S extends StateShape> {
  (state: Readonly<S>, context: NodeExecutionContext): Promise<Partial<S>>;
}

export interface NodeExecutionContext {
  abortSignal?: AbortSignal | undefined;
  nodeName: string;
}

export type SnapshotListener = (snapshot: GraphExecutionSnapshot) => void;

export interface GraphInvokeOptions {
  abortSignal?: AbortSignal | undefined;
  onSnapshot?: SnapshotListener | undefined;
  promptIndex?: number | undefined;
}

export interface GraphInvokeResult<S extends StateShape> {
  state: S;
  snapshot: GraphExecutionSnapshot;
  aborted: boolean;
}

export interface CompiledGraph<S extends StateShape> {
  invoke(input: Partial<S>, options?: GraphInvokeOptions): Promise<GraphInvokeResult<S>>;
  getTopology(): GraphTopology;
}

export type RouteFunction<S extends StateShape> = (state: Readonly<S>) => string;

export type EdgeDefinition<S extends StateShape> =
  | { type: 'static'; from: string; to: string }
  | { type: 'conditional'; from: string; routeFn: RouteFunction<S>; targets: Record<string, string> };
