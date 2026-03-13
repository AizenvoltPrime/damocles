import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import { log } from '../logger';
import { TOOL_WRITE } from '../../shared/tool-names';
import { TurnPersistence } from './turn-persistence';
import type { FlushedAssistantData } from './turn-persistence';
import { SubagentManager } from './subagent-manager';
import { TrajectoryManager } from './managers/trajectory-manager';
import { buildSessionData } from './history-builder';
import { StateGraph, END } from './graph/state-graph';
import { createRecallGraphAnnotation } from './graph/recall-graph-state';
import type { RecallGraphState } from './graph/recall-graph-state';
import type { CompiledGraph } from './graph/types';
import { GraphSessionState } from './graph/session-state';
import { intentAnalysisNode } from './graph/nodes/intent-analysis';
import { createRecallReplNode } from './graph/nodes/recall-repl';
import { stateUpdateNode } from './graph/nodes/state-update';
import type { GraphExecutionSnapshot } from '../../shared/types/graph';
import { DEFAULT_ROOT_MODEL } from './types';
import type { RecallConfig, StructuredTurn, RecallTrajectory } from './types';

export { DEFAULT_ROOT_MODEL, DEFAULT_SUBCALL_MODEL } from './types';

export class RecallService {
  private config: RecallConfig;
  private cwd: string;
  private _persistenceSessionId: string;
  private _sessionId: string;
  private persistence: TurnPersistence;
  private subagentManager: SubagentManager;
  private trajectoryManager: TrajectoryManager;
  private history: StructuredTurn[] = [];
  private promptIndex = -1;
  private lastUserPrompt = '';
  private model = DEFAULT_ROOT_MODEL;
  private abortController: AbortController | null = null;

  private graphState = new GraphSessionState();
  private graph: CompiledGraph<RecallGraphState> | null = null;
  private graphSnapshotMap = new Map<number, GraphExecutionSnapshot>();

  onSubagentDataReady?: (agentToolUseId: string, agentId: string) => void;
  onGraphSnapshot?: (promptIndex: number, snapshot: GraphExecutionSnapshot) => void;

  constructor(cwd: string, config: RecallConfig) {
    this.cwd = cwd;
    this.config = config;
    this._persistenceSessionId = crypto.randomUUID();
    this._sessionId = crypto.randomUUID();
    this.persistence = new TurnPersistence(cwd, this._persistenceSessionId);
    this.trajectoryManager = new TrajectoryManager();

    this.subagentManager = new SubagentManager({
      cwd,
      getPersistenceSessionId: () => this._persistenceSessionId,
      onSubagentDataReady: (id, agentId) => this.onSubagentDataReady?.(id, agentId),
    });
  }

  get isEnabled(): boolean {
    return this.config.enabled;
  }

  get maxInjectedChars(): number {
    return this.config.maxInjectedChars;
  }

  get sessionId(): string | null {
    return this.config.enabled ? this._sessionId : null;
  }

  get persistenceSessionId(): string | null {
    return this.config.enabled ? this._persistenceSessionId : null;
  }

  get turnPersistence(): TurnPersistence {
    return this.persistence;
  }

  get planFilePath(): string | null {
    return this.persistence.planFilePath;
  }

  set planFilePath(value: string | null) {
    this.persistence.planFilePath = value;
  }

  get lastFlushedLeafUuid(): string | null {
    return this.config.enabled ? this.persistence.lastFlushedLeafUuid : null;
  }

  setModel(model: string): void {
    this.model = model;
    this.graph = null;
  }

  refreshConfig(config: RecallConfig): void {
    this.config = config;
    this.graph = null;
    this.cancelPendingRecall();
  }

  async setSessionId(id: string): Promise<void> {
    this._persistenceSessionId = id;
    this._sessionId = crypto.randomUUID();
    this.cancelPendingRecall();

    this.subagentManager.reset();
    this.trajectoryManager.reset();
    this.graphState.reset();
    this.graphSnapshotMap.clear();
    this.graph = null;

    this.persistence.reset(id);

    const { history, trajectories, leafState, graphStateData, graphSnapshots } = await buildSessionData(this.cwd, id);
    this.history = history;
    this.trajectoryManager.load(trajectories);
    this.promptIndex = this.history.length > 0
      ? Math.max(...this.history.map(t => t.promptIndex))
      : -1;

    if (graphStateData) {
      this.graphState = GraphSessionState.deserialize(graphStateData);
    }

    for (const [idx, snap] of graphSnapshots) {
      this.graphSnapshotMap.set(idx, snap);
    }

    if (leafState.leafUuid) {
      this.persistence.applyLeafState(leafState.leafUuid, leafState.lastUserUuid, leafState.planFilePath);
    }

    log('[RecallService.setSessionId] Loaded %d turns, %d trajectories, %d graph snapshots, promptIndex=%d',
      this.history.length, trajectories.size, graphSnapshots.size, this.promptIndex);
  }

  async getContextForInjection(userPrompt?: string): Promise<string | null> {
    if (!this.config.enabled) return null;

    const prompt = userPrompt ?? this.lastUserPrompt;

    if (this.promptIndex <= 0) {
      log('[RecallService.getContextForInjection] No history, skipping recall loop');
      return this.getPlanReference();
    }

    this.cancelPendingRecall();
    this.abortController = new AbortController();

    try {
      return await this.runGraphPipeline(prompt);
    } catch (err) {
      log('[RecallService.getContextForInjection] Error: %O', err);
      return this.getPlanReference();
    } finally {
      this.abortController = null;
    }
  }

  getRecallTrajectory(promptIndex: number): RecallTrajectory | undefined {
    return this.trajectoryManager.get(promptIndex);
  }

  getGraphSnapshot(promptIndex: number): GraphExecutionSnapshot | undefined {
    return this.graphSnapshotMap.get(promptIndex);
  }

  onPromptSubmit(userPrompt: string): void {
    if (!this.config.enabled) return;
    this.promptIndex++;
    this.lastUserPrompt = userPrompt;
    this.persistence.startTurn(this.promptIndex, userPrompt);
    log('[RecallService.onPromptSubmit] promptIndex=%d', this.promptIndex);
  }

  onFlushedPromptSubmit(userPrompt: string): void {
    if (!this.config.enabled) return;
    this.promptIndex++;
    this.lastUserPrompt = userPrompt;
    this.persistence.startTurn(this.promptIndex, userPrompt);
  }

  onAssistantFlushed(uuid: string): void {
    if (!this.config.enabled) return;
    this.persistence.advanceLeafUuid(uuid);
  }

  onInterjection(_text: string): void {
    // No-op for recall — interjections are handled by the main SDK query
  }

  onThinkingBlockComplete(messageId: string, model: string, thinking: string, parentToolUseId?: string): void {
    if (!this.config.enabled) return;

    if (this.subagentManager.onThinkingBlockComplete(messageId, model, thinking, parentToolUseId)) return;

    this.persistence.addThinkingBlock(thinking);
    this.persistence.persistAssistantBlockQueued(messageId, model, [{ type: 'thinking', thinking }]);
  }

  onToolUse(toolName: string, input: Record<string, unknown>, toolUseId?: string): void {
    if (!this.config.enabled) return;

    if (toolName === TOOL_WRITE && typeof input['file_path'] === 'string') {
      const filePath = path.resolve(input['file_path']);
      const plansDir = path.resolve(os.homedir(), '.claude', 'plans');
      if (filePath.startsWith(plansDir + path.sep) && filePath.endsWith('.md')) {
        this.persistence.persistPlanPath(filePath).catch(err => {
          log('[RecallService] Failed to persist plan path:', err);
        });
        return;
      }
    }

    this.persistence.addToolCall(toolName, input, toolUseId);
  }

  onToolResult(toolName: string, toolUseId: string, result: string, parentToolUseId?: string): void {
    if (!this.config.enabled) return;

    if (this.subagentManager.onToolResult(toolName, toolUseId, result, parentToolUseId)) return;

    this.persistence.addToolResultById(toolUseId, toolName, result);
    this.persistence.persistToolResultQueued(toolUseId, result);
  }

  onStreamDelta(delta: string): void {
    if (!this.config.enabled) return;
    this.persistence.appendAssistantDelta(delta);
  }

  onResponseComplete(): void {
    if (!this.config.enabled) return;
    log('[RecallService.onResponseComplete] sessionId=%s', this._sessionId);

    const turn = this.persistence.finalizeTurn();
    if (turn) {
      this.history.push(turn);
    }

    this.subagentManager.flushRemainingResponses();
  }

  persistAssistantData(data: FlushedAssistantData, parentToolUseId: string | null): void {
    if (!this.config.enabled) return;

    if (this.subagentManager.persistAssistantData(data, parentToolUseId)) return;

    this.persistence.persistAssistantQueued(data);
    if (data.uuid) {
      this.onAssistantFlushed(data.uuid);
    }
  }

  regenerateSessionId(): void {
    const oldSdkId = this._sessionId;
    this._sessionId = crypto.randomUUID();
    log('[RecallService.regenerateSessionId] sdkId %s → %s',
      oldSdkId.slice(0, 8), this._sessionId.slice(0, 8));
  }

  onSubagentStart(toolUseId: string, agentId: string): void {
    if (!this.config.enabled) return;
    this.subagentManager.onSubagentStart(toolUseId, agentId);
  }

  onSubagentStop(agentId: string): void {
    if (!this.config.enabled) return;
    this.subagentManager.onSubagentStop(agentId);
  }

  reset(): void {
    this.cancelPendingRecall();
    this._persistenceSessionId = crypto.randomUUID();
    this._sessionId = crypto.randomUUID();

    this.subagentManager.reset();
    this.trajectoryManager.reset();
    this.graphState.reset();
    this.graphSnapshotMap.clear();
    this.graph = null;
    this.history = [];
    this.promptIndex = -1;

    this.persistence.reset(this._persistenceSessionId);
  }

  dispose(): void {
    this.cancelPendingRecall();
  }

  cancelPendingRecall(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private async runGraphPipeline(prompt: string): Promise<string | null> {
    const graph = this.getOrBuildGraph();

    const { state: result, snapshot } = await graph.invoke(
      {
        userPrompt: prompt,
        history: this.history,
        promptIndex: this.promptIndex,
        sessionTrace: this.graphState.getSessionTrace(),
      },
      {
        abortSignal: this.abortController!.signal,
        promptIndex: this.promptIndex,
        onSnapshot: (snap) => this.onGraphSnapshot?.(this.promptIndex, snap),
      },
    );

    this.graphSnapshotMap.set(this.promptIndex, snapshot);
    this.persistence.persistGraphSnapshotQueued(this.promptIndex, snapshot);

    this.graphState.updateSessionTrace(result.sessionTrace);
    this.persistence.persistGraphStateQueued(this.graphState.serialize());

    if (result.recallTrajectory) {
      this.trajectoryManager.store(this.promptIndex, result.recallTrajectory);
      this.persistence.persistTrajectoryQueued(this.promptIndex, result.recallTrajectory);
    }

    let finalContext = result.recallContext;
    const planRef = this.getPlanReference();
    if (planRef) {
      finalContext = finalContext ? finalContext + planRef : planRef;
    }

    log('[RecallService.runGraphPipeline] intent=%s, entities=%d, contextLen=%d',
      result.intent, result.keyEntities.length, finalContext?.length ?? 0);

    return finalContext;
  }

  private getOrBuildGraph(): CompiledGraph<RecallGraphState> {
    if (this.graph) return this.graph;

    const annotation = createRecallGraphAnnotation();
    const builder = new StateGraph(annotation);

    builder
      .addNode('intentAnalysis', intentAnalysisNode)
      .addNode('recallRepl', createRecallReplNode({
        config: this.config,
        cwd: this.cwd,
        model: this.model,
      }))
      .addNode('stateUpdate', stateUpdateNode)
      .setEntryPoint('intentAnalysis')
      .addEdge('intentAnalysis', 'recallRepl')
      .addEdge('recallRepl', 'stateUpdate')
      .addEdge('stateUpdate', END);

    this.graph = builder.compile();
    return this.graph;
  }

  private getPlanReference(): string | null {
    const planPath = this.persistence.planFilePath;
    if (!planPath) return null;
    return `\n\nThis session has an associated plan file. Read it before starting implementation: ${planPath}`;
  }
}
