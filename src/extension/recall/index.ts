import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import { log } from '../logger';
import { TOOL_AGENT, TOOL_WRITE } from '../../shared/tool-names';
import { TurnPersistence } from './turn-persistence';
import type { FlushedAssistantData } from './turn-persistence';
import { SubagentManager } from './subagent-manager';
import { TrajectoryManager } from './managers/trajectory-manager';
import { buildSessionData, clearBuildSessionDataCache } from './history-builder';
import { NodeManager } from './node-manager';
import { runRecallLoop, buildDirectContext } from './recall-loop';
import { buildSeedExtractionSystemPrompt, buildSeedExtractionInitialPrompt } from './prompts';
import { DEFAULT_ROOT_MODEL, DIRECT_CONTEXT_THRESHOLD } from './types';
import type { RecallConfig, StructuredTurn, RecallTrajectory, TaskNode } from './types';
import type { NodeTurnDisplay, TaskNodeDisplay, OrientationData, OrientationPhase } from '../../shared/types/recall';
import { extractAgentText } from './agent-text';
import { indexTurn } from './turn-indexer';
import type { CompassTermProvider } from './orientation';

export function toNodeTurnDisplays(
  turns: StructuredTurn[],
  opts?: { includeThinking?: boolean },
): NodeTurnDisplay[] {
  return turns.map(t => ({
    promptIndex: t.promptIndex,
    timestamp: t.timestamp,
    userMessage: t.userMessage,
    assistantResponse: t.assistantResponse,
    toolCalls: t.toolCalls.map(tc => ({ name: tc.name, input: tc.input, result: tc.result })),
    contentBlocks: t.contentBlocks.map(b => {
      if (b.type === 'text') return b;
      const tc = t.toolCalls[b.index];
      if (!tc) return { type: 'tool_call' as const, name: 'unknown', input: {}, result: '' };
      return { type: 'tool_call' as const, name: tc.name, input: tc.input, result: tc.result };
    }),
    thinkingBlocks: opts?.includeThinking ? t.thinkingBlocks : [],
    filesTouched: t.filesTouched,
  }));
}

export function toRelatedNodeSummaries(nodes: TaskNode[]): import('../../shared/types/recall').RelatedNodeSummaryCard[] {
  return nodes
    .filter(n => n.summary)
    .map(n => ({
      nodeId: n.nodeId,
      title: n.summary!.title,
      outcome: n.summary!.outcome,
      taskDescription: n.summary!.taskDescription,
      filesChanged: n.summary!.filesChanged,
      keyDecisions: n.summary!.keyDecisions,
    }));
}

export { DEFAULT_ROOT_MODEL, DEFAULT_SUBCALL_MODEL } from './types';

export class RecallService {
  private config: RecallConfig;
  private cwd: string;
  private _persistenceSessionId: string;
  private _sessionId: string;
  private persistence: TurnPersistence;
  private subagentManager: SubagentManager;
  private trajectoryManager: TrajectoryManager;
  private nodeManager: NodeManager;
  private history: StructuredTurn[] = [];
  private promptIndex = -1;
  private lastUserPrompt = '';
  private model = DEFAULT_ROOT_MODEL;
  private abortController: AbortController | null = null;
  private _pendingAgentToolCount = 0;
  private _deferredAssistant: FlushedAssistantData | null = null;
  private _compassProvider: CompassTermProvider | null = null;

  onSubagentDataReady?: (agentToolUseId: string, agentId: string) => void;
  onRecallIteration?: (promptIndex: number, iteration: import('./types').RecallIteration) => void;
  onRecallComplete?: (promptIndex: number, trajectory: RecallTrajectory) => void;
  onOrientationPhase?: (promptIndex: number, phase: OrientationPhase, orientation: OrientationData) => void;
  onNodeStateChanged?: (payload: { nodes: TaskNodeDisplay[]; activeNodeId: string | null; pendingNewNode: boolean }) => void;

  constructor(cwd: string, config: RecallConfig) {
    this.cwd = cwd;
    this.config = config;
    this._persistenceSessionId = crypto.randomUUID();
    this._sessionId = crypto.randomUUID();
    this.persistence = new TurnPersistence(cwd, this._persistenceSessionId);
    this.trajectoryManager = new TrajectoryManager();
    this.nodeManager = new NodeManager(this.persistence, cwd);

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

  get currentPromptIndex(): number {
    if (!this.config.enabled) return -1;
    return this.promptIndex;
  }

  get activeNodeId(): string | null {
    if (!this.config.enabled) return null;
    return this.nodeManager.getNodeState().activeNodeId;
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

  getNodeManager(): NodeManager {
    return this.nodeManager;
  }

  getHistory(): StructuredTurn[] {
    return this.history;
  }

  setModel(model: string): void {
    this.model = model;
  }

  setCompassProvider(provider: CompassTermProvider | null): void {
    this._compassProvider = provider;
  }

  refreshConfig(config: RecallConfig): void {
    this.config = config;
    this.cancelPendingRecall();
  }

  async setSessionId(id: string): Promise<void> {
    this._persistenceSessionId = id;
    this._sessionId = crypto.randomUUID();
    this.cancelPendingRecall();

    this.subagentManager.reset();
    this.trajectoryManager.reset();

    this.persistence.reset(id);

    const { history, trajectories, leafState, nodeState, nodeLeafUuids } = await buildSessionData(this.cwd, id);
    this.history = history;
    this.trajectoryManager.load(trajectories);
    this.promptIndex = this.history.length > 0
      ? Math.max(...this.history.map(t => t.promptIndex))
      : -1;

    this.nodeManager.loadState(nodeState);

    for (const node of nodeState.nodes) {
      this.persistence.markNodeInitialized(node.nodeId);
    }

    if (leafState.leafUuid) {
      this.persistence.applyLeafState(leafState.leafUuid, leafState.lastUserUuid, leafState.planFilePath);
    }

    if (nodeLeafUuids.size > 0) {
      this.persistence.applyNodeLeafUuids(nodeLeafUuids);
    }

    log('[RecallService.setSessionId] Loaded %d turns, %d trajectories, %d nodes, promptIndex=%d',
      this.history.length, trajectories.size, nodeState.nodes.length, this.promptIndex);
  }

  async getContextForInjection(userPrompt?: string): Promise<string | null> {
    if (!this.config.enabled) return null;

    const prompt = userPrompt ?? this.lastUserPrompt;

    if (this.promptIndex <= 0) {
      log('[RecallService.getContextForInjection] No history, skipping recall');
      const planRef = this.getPlanReference();
      if (planRef) {
        const trajectory: RecallTrajectory = {
          promptIndex: this.promptIndex,
          userPrompt: prompt,
          iterations: [],
          finalContext: planRef,
          totalDurationMs: 0,
          shortCircuited: true,
          forcedAnswer: false,
          timedOut: false,
          turnCount: 0,
          historyChars: 0,
          nodeId: null,
          nodeTitle: null,
          contextTurns: [],
          seedContext: null,
          relatedSummaries: [],
          orientation: null,
        };
        this.trajectoryManager.store(this.promptIndex, trajectory);
        this.onRecallComplete?.(this.promptIndex, trajectory);
      }
      return planRef;
    }

    this.cancelPendingRecall();
    this.abortController = new AbortController();

    try {
      const activeNodeId = this.nodeManager.getNodeState().activeNodeId;
      if (!activeNodeId) {
        return await this.buildFlatContext(prompt);
      }

      const activeNode = this.nodeManager.getNodeById(activeNodeId);
      if (!activeNode) {
        return await this.buildFlatContext(prompt);
      }

      const relatedClosed = this.nodeManager.findRelatedClosedNodes(activeNode);
      const result = await this.buildNodeContext({
        activeNode,
        relatedClosedNodes: relatedClosed,
        userPrompt: prompt,
      });

      let finalContext = result.context;
      const planRef = this.getPlanReference();
      if (planRef) {
        finalContext = finalContext ? finalContext + planRef : planRef;
      }

      if (result.trajectory) {
        result.trajectory.finalContext = finalContext;
        this.trajectoryManager.store(this.promptIndex, result.trajectory);
        this.persistence.persistTrajectoryQueued(this.promptIndex, result.trajectory);
        this.onRecallComplete?.(this.promptIndex, result.trajectory);
      }

      log('[RecallService.getContextForInjection] nodeId=%s, contextLen=%d',
        activeNodeId.slice(0, 8), finalContext?.length ?? 0);

      return finalContext;
    } catch (err) {
      log('[RecallService.getContextForInjection] Error: %O', err);
      return this.getPlanReference();
    } finally {
      this.abortController = null;
    }
  }

  async getCrossNodeContext(userPrompt: string): Promise<string | null> {
    if (!this.config.enabled) return null;

    const allTurns = this.history;
    if (allTurns.length === 0) return null;

    this.cancelPendingRecall();
    const ac = new AbortController();
    this.abortController = ac;

    try {
      const { context } = await runRecallLoop(
        allTurns,
        userPrompt,
        this.promptIndex,
        {
          config: this.config,
          cwd: this.cwd,
          model: this.model,
          abortSignal: ac.signal,
          nodeContext: null,
          onIteration: (iter) => this.onRecallIteration?.(this.promptIndex, iter),
          onOrientationPhase: (phase, data) => this.onOrientationPhase?.(this.promptIndex, phase, data),
          skipTimeout: true,
          ...(this._compassProvider ? { compassProvider: this._compassProvider } : {}),
        },
      );
      return context;
    } finally {
      if (this.abortController === ac) {
        this.abortController = null;
      }
    }
  }

  getRecallTrajectory(promptIndex: number): RecallTrajectory | undefined {
    return this.trajectoryManager.get(promptIndex);
  }

  getNodeTrajectories(nodeId: string): RecallTrajectory[] {
    return this.trajectoryManager.getByNodeId(nodeId);
  }

  onPromptSubmit(userPrompt: string, nodeId?: string | null): void {
    this.advancePrompt(userPrompt, nodeId);
    log('[RecallService.onPromptSubmit] promptIndex=%d, nodeId=%s', this.promptIndex, nodeId?.slice(0, 8) ?? 'none');
  }

  onFlushedPromptSubmit(userPrompt: string): void {
    const activeNodeId = this.nodeManager.getNodeState().activeNodeId;
    this.advancePrompt(userPrompt, activeNodeId);
    this.persistence.persistUserQueued(userPrompt);
  }

  private advancePrompt(userPrompt: string, nodeId?: string | null): void {
    if (!this.config.enabled) return;
    this.promptIndex++;
    this._pendingAgentToolCount = 0;
    this._deferredAssistant = null;
    this.lastUserPrompt = userPrompt;
    this.persistence.startTurn(this.promptIndex, userPrompt, nodeId ?? null);

    if (nodeId) {
      this.nodeManager.assignTurnToNode(this.promptIndex, nodeId, userPrompt);
    }
  }

  onAssistantFlushed(uuid: string): void {
    if (!this.config.enabled) return;
    this.persistence.advanceLeafUuid(uuid);
  }

  onInterjection(_text: string): void {
    // No-op for recall
  }

  onThinkingBlockComplete(messageId: string, model: string, thinking: string, parentToolUseId?: string, signature?: string): void {
    if (!this.config.enabled) return;

    if (this.subagentManager.onThinkingBlockComplete(messageId, model, thinking, parentToolUseId)) return;

    this.persistence.addThinkingBlock(thinking);
    const thinkingBlock: import('../../shared/types/content').ThinkingBlock = { type: 'thinking', thinking };
    if (signature) thinkingBlock.signature = signature;
    this.persistence.persistAssistantBlockQueued(messageId, model, [thinkingBlock]);
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

    if (toolName === TOOL_AGENT) {
      this._pendingAgentToolCount++;
    }

    this.persistence.addToolCall(toolName, input, toolUseId);
  }

  onToolResult(toolName: string, toolUseId: string, result: string, parentToolUseId?: string): void {
    if (!this.config.enabled) return;

    if (this.subagentManager.onToolResult(toolName, toolUseId, result, parentToolUseId)) return;

    if (parentToolUseId) return;

    const turnResult = toolName === TOOL_AGENT ? extractAgentText(result) : result;
    this.persistence.addToolResultById(toolUseId, toolName, turnResult);
    this.persistence.persistToolResultQueued(toolUseId, result);

    if (toolName === TOOL_AGENT) {
      this._pendingAgentToolCount = Math.max(0, this._pendingAgentToolCount - 1);
      if (this._pendingAgentToolCount === 0 && this._deferredAssistant) {
        const deferred = this._deferredAssistant;
        this._deferredAssistant = null;
        log('[RecallService.onToolResult] Flushing deferred synthesis after last agent result');
        this.persistence.persistAssistantQueued(deferred);
        if (deferred.uuid) {
          this.onAssistantFlushed(deferred.uuid);
        }
      }
    }
  }

  onStreamDelta(delta: string): void {
    if (!this.config.enabled) return;
    this.persistence.appendAssistantDelta(delta);
  }

  onResponseComplete(): void {
    if (!this.config.enabled) return;
    log('[RecallService.onResponseComplete] sessionId=%s', this._sessionId);

    if (this._deferredAssistant) {
      log('[RecallService.onResponseComplete] Flushing deferred synthesis: %d agent results still pending', this._pendingAgentToolCount);
      const deferred = this._deferredAssistant;
      this._deferredAssistant = null;
      this._pendingAgentToolCount = 0;
      this.persistence.persistAssistantQueued(deferred);
      if (deferred.uuid) {
        this.onAssistantFlushed(deferred.uuid);
      }
    }

    this.persistence.flushPendingToolResults();

    const turn = this.persistence.finalizeTurn();
    if (turn) {
      this.history.push(turn);
      this.indexTurnAsync(turn);
    }

    this.subagentManager.flushRemainingResponses();

    if (this.nodeManager.hasNodes()) {
      this.onNodeStateChanged?.(this.buildNodeDisplayState());
    }
  }

  buildNodeDisplayState(): { nodes: TaskNodeDisplay[]; activeNodeId: string | null; pendingNewNode: boolean } {
    const state = this.nodeManager.getNodeState();
    return {
      nodes: state.nodes.map(n => {
        const nodeTurns = this.nodeManager.getNodeTurns(n.nodeId, this.history);
        const allFiles = new Set<string>();
        for (const t of nodeTurns) {
          for (const f of t.filesTouched) allFiles.add(f);
        }
        const lastTurn = nodeTurns.length > 0 ? nodeTurns[nodeTurns.length - 1] : null;

        return {
          nodeId: n.nodeId,
          title: n.title,
          status: n.status,
          keyEntities: n.keyEntities,
          turnCount: n.turnIndices.length,
          createdAt: n.createdAt,
          closedAt: n.closedAt,
          summary: n.summary ? {
            title: n.summary.title,
            taskDescription: n.summary.taskDescription,
            outcome: n.summary.outcome,
            filesChanged: n.summary.filesChanged,
            keyDecisions: n.summary.keyDecisions,
          } : null,
          relatedClosedNodeIds: n.relatedClosedNodeIds,
          firstPrompt: nodeTurns[0]?.userMessage ?? null,
          filesTouched: [...allFiles],
          lastActivity: lastTurn?.timestamp ?? n.createdAt,
        };
      }),
      activeNodeId: state.activeNodeId,
      pendingNewNode: this.nodeManager.pendingNewNode,
    };
  }

  persistAssistantData(data: FlushedAssistantData, parentToolUseId: string | null): void {
    if (!this.config.enabled) return;

    if (this.subagentManager.persistAssistantData(data, parentToolUseId)) return;

    if (parentToolUseId) return;

    const hasAgentToolUse = data.content.some(
      b => b.type === 'tool_use' && 'name' in b && b.name === TOOL_AGENT,
    );

    if (this._pendingAgentToolCount > 0 && !hasAgentToolUse) {
      log('[RecallService.persistAssistantData] Deferring synthesis: %d agent results pending', this._pendingAgentToolCount);
      this._deferredAssistant = data;
      return;
    }

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

  onSubagentStart(toolUseId: string, agentId: string, isBackground?: boolean, prompt?: string): void {
    if (!this.config.enabled) return;
    this.subagentManager.onSubagentStart(toolUseId, agentId, isBackground, prompt);
  }

  onSubagentStop(agentId: string, lastAssistantMessage?: string): void {
    if (!this.config.enabled) return;
    this.subagentManager.onSubagentStop(agentId, lastAssistantMessage);
  }

  onSubagentToolCall(parentToolUseId: string, toolName: string, toolUseId: string, input: Record<string, unknown>): void {
    if (!this.config.enabled) return;
    this.subagentManager.onToolCall(toolName, toolUseId, input, parentToolUseId);
  }

  reset(): void {
    this.cancelPendingRecall();
    this._persistenceSessionId = crypto.randomUUID();
    this._sessionId = crypto.randomUUID();

    this.subagentManager.reset();
    this.trajectoryManager.reset();
    this.nodeManager.loadState({ nodes: [], activeNodeId: null });
    this.history = [];
    this.promptIndex = -1;
    this._pendingAgentToolCount = 0;
    this._deferredAssistant = null;

    this.persistence.reset(this._persistenceSessionId);
  }

  dispose(): void {
    this.cancelPendingRecall();
    clearBuildSessionDataCache();
  }

  cancelPendingRecall(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private indexTurnAsync(turn: StructuredTurn): void {
    const signal = this.abortController?.signal;
    indexTurn(turn, this.cwd, signal).then(data => {
      if (data && !signal?.aborted) {
        turn.summary = data.summary;
        turn.keywords = data.keywords;
        this.persistence.persistTurnIndexQueued(turn.promptIndex, data, turn.nodeId);
      }
    }).catch(err => {
      log('[RecallService] Turn indexing failed (non-blocking): %O', err);
    });
  }

  private async buildNodeContext(params: {
    activeNode: TaskNode;
    relatedClosedNodes: TaskNode[];
    userPrompt: string;
  }): Promise<{ context: string | null; trajectory: RecallTrajectory | null }> {
    const { activeNode, relatedClosedNodes, userPrompt } = params;

    if (activeNode.seedContext === null && !activeNode._seedContextPending) {
      activeNode._seedContextPending = true;
      try {
        await this.extractSeedContext(activeNode, userPrompt);
      } finally {
        activeNode._seedContextPending = false;
      }
    }

    const nodeTurns = this.nodeManager.getNodeTurns(activeNode.nodeId, this.history);
    const hasSeed = !!activeNode.seedContext;

    if (nodeTurns.length === 0 && !hasSeed) {
      return { context: null, trajectory: null };
    }

    const relatedSummaries = relatedClosedNodes
      .filter(n => n.summary)
      .map(n => ({
        nodeId: n.nodeId,
        title: n.summary!.title,
        outcome: n.summary!.outcome,
        taskDescription: n.summary!.taskDescription,
        filesChanged: n.summary!.filesChanged,
        keyDecisions: n.summary!.keyDecisions,
      }));

    const summaryCards = relatedSummaries
      .map(s => `[Related Task: ${s.title}] (CLOSED - ${s.outcome})\nTask: ${s.taskDescription}\nFiles: ${s.filesChanged.join(', ')}\nKey decisions: ${s.keyDecisions.join('; ')}`);

    const parts: string[] = [];
    if (hasSeed) {
      parts.push(`[Prior session context relevant to "${activeNode.title}"]\n${activeNode.seedContext}`);
    }
    if (summaryCards.length > 0) {
      parts.push(summaryCards.join('\n\n'));
    }
    if (nodeTurns.length > 0) {
      parts.push(buildDirectContext(nodeTurns));
    }

    const totalContext = parts.join('\n\n');

    if (totalContext.length <= this.config.maxInjectedChars) {
      log('[RecallService.buildNodeContext] Direct return: %d chars, %d turns, seed=%s, %d related summaries',
        totalContext.length, nodeTurns.length, hasSeed, summaryCards.length);
      const trajectory: RecallTrajectory = {
        promptIndex: this.promptIndex,
        userPrompt,
        iterations: [],
        finalContext: totalContext,
        totalDurationMs: 0,
        shortCircuited: true,
        forcedAnswer: false,
        timedOut: false,
        turnCount: nodeTurns.length,
        historyChars: totalContext.length,
        nodeId: activeNode.nodeId,
        nodeTitle: activeNode.title,
        contextTurns: toNodeTurnDisplays(nodeTurns),
        seedContext: activeNode.seedContext,
        relatedSummaries,
        orientation: null,
      };
      return { context: totalContext, trajectory };
    }

    log('[RecallService.buildNodeContext] REPL fallback: %d chars exceeds %d limit',
      totalContext.length, this.config.maxInjectedChars);

    const { context, trajectory } = await runRecallLoop(
      nodeTurns,
      userPrompt,
      this.promptIndex,
      {
        config: this.config,
        cwd: this.cwd,
        model: this.model,
        abortSignal: this.abortController?.signal,
        nodeContext: { nodeTitle: activeNode.title },
        onIteration: (iter) => this.onRecallIteration?.(this.promptIndex, iter),
        onOrientationPhase: (phase, data) => this.onOrientationPhase?.(this.promptIndex, phase, data),
        ...(this._compassProvider ? { compassProvider: this._compassProvider } : {}),
      },
    );

    if (trajectory) {
      trajectory.nodeId = activeNode.nodeId;
      trajectory.nodeTitle = activeNode.title;
      trajectory.contextTurns = [];
      trajectory.seedContext = activeNode.seedContext;
      trajectory.relatedSummaries = relatedSummaries;
    }

    const fallbackParts: string[] = [];
    let budgetRemaining = this.config.maxInjectedChars;
    const JOINER = '\n\n';
    if (context) {
      fallbackParts.push(context);
      budgetRemaining -= context.length;
    }
    if (hasSeed) {
      const seedBlock = `[Prior session context relevant to "${activeNode.title}"]\n${activeNode.seedContext}`;
      const costWithJoiner = seedBlock.length + (fallbackParts.length > 0 ? JOINER.length : 0);
      if (costWithJoiner <= budgetRemaining) {
        fallbackParts.push(seedBlock);
        budgetRemaining -= costWithJoiner;
      }
    }
    if (summaryCards.length > 0) {
      const joined = summaryCards.join(JOINER);
      const costWithJoiner = joined.length + (fallbackParts.length > 0 ? JOINER.length : 0);
      if (costWithJoiner <= budgetRemaining) {
        fallbackParts.push(joined);
        budgetRemaining -= costWithJoiner;
      }
    }
    const finalContext = fallbackParts.length > 0 ? fallbackParts.join(JOINER) : null;

    return { context: finalContext, trajectory };
  }

  async regenerateSeedContext(nodeId: string, customPrompt: string): Promise<void> {
    const node = this.nodeManager.getNodeById(nodeId);
    if (!node) return;

    const orphanTurns = this.nodeManager.getOrphanTurns(this.history);
    if (orphanTurns.length === 0) return;

    const totalChars = orphanTurns.reduce((sum, t) =>
      sum + t.userMessage.length + t.assistantResponse.length
      + t.toolCalls.reduce((s, tc) => s + tc.result.length, 0), 0);

    if (totalChars === 0) return;

    log('[RecallService.regenerateSeedContext] Running extraction REPL on %d orphan turns (%d chars) with prompt: "%s"',
      orphanTurns.length, totalChars, customPrompt.slice(0, 100));

    const ac = new AbortController();
    this.abortController = ac;

    try {
      const { context } = await runRecallLoop(
        orphanTurns,
        customPrompt,
        this.promptIndex,
        {
          config: this.config,
          cwd: this.cwd,
          model: this.model,
          abortSignal: ac.signal,
          nodeContext: { nodeTitle: node.title },
          onIteration: (iter) => this.onRecallIteration?.(this.promptIndex, iter),
          onOrientationPhase: (phase, data) => this.onOrientationPhase?.(this.promptIndex, phase, data),
          forceRepl: true,
          systemPromptOverride: buildSeedExtractionSystemPrompt(customPrompt, orphanTurns.length, totalChars),
          initialPromptOverride: buildSeedExtractionInitialPrompt(customPrompt),
        },
      );

      if (context) {
        this.nodeManager.setSeedContext(nodeId, context, customPrompt);
        log('[RecallService.regenerateSeedContext] REPL seed: %d chars extracted', context.length);
      }
    } finally {
      if (this.abortController === ac) {
        this.abortController = null;
      }
    }
  }

  private async extractSeedContext(node: TaskNode, userPrompt: string): Promise<void> {
    const orphanTurns = this.nodeManager.getOrphanTurns(this.history);
    if (orphanTurns.length === 0) return;

    const totalChars = orphanTurns.reduce((sum, t) =>
      sum + t.userMessage.length + t.assistantResponse.length
      + t.toolCalls.reduce((s, tc) => s + tc.result.length, 0), 0);

    if (totalChars === 0) return;

    if (totalChars <= DIRECT_CONTEXT_THRESHOLD) {
      const context = buildDirectContext(orphanTurns);
      this.nodeManager.setSeedContext(node.nodeId, context);
      log('[RecallService.extractSeedContext] Direct seed: %d chars from %d orphan turns', context.length, orphanTurns.length);
      return;
    }

    log('[RecallService.extractSeedContext] Running REPL on %d orphan turns (%d chars) for node "%s"',
      orphanTurns.length, totalChars, node.title);

    const { context } = await runRecallLoop(
      orphanTurns,
      userPrompt,
      this.promptIndex,
      {
        config: this.config,
        cwd: this.cwd,
        model: this.model,
        abortSignal: this.abortController?.signal,
        nodeContext: { nodeTitle: node.title },
        onIteration: (iter) => this.onRecallIteration?.(this.promptIndex, iter),
        ...(this._compassProvider ? { compassProvider: this._compassProvider } : {}),
      },
    );

    if (context) {
      this.nodeManager.setSeedContext(node.nodeId, context);
      log('[RecallService.extractSeedContext] REPL seed: %d chars extracted', context.length);
    }
  }

  private async buildFlatContext(prompt: string): Promise<string | null> {
    if (this.history.length === 0) return this.getPlanReference();

    const totalChars = this.history.reduce((sum, t) =>
      sum + t.userMessage.length + t.assistantResponse.length
      + t.toolCalls.reduce((s, tc) => s + tc.result.length, 0), 0);

    let context: string | null;
    let trajectory: RecallTrajectory | null = null;

    if (totalChars <= this.config.maxInjectedChars) {
      context = buildDirectContext(this.history);
      trajectory = {
        promptIndex: this.promptIndex,
        userPrompt: prompt,
        iterations: [],
        finalContext: context,
        totalDurationMs: 0,
        shortCircuited: true,
        forcedAnswer: false,
        timedOut: false,
        turnCount: this.history.length,
        historyChars: totalChars,
        nodeId: null,
        nodeTitle: null,
        contextTurns: toNodeTurnDisplays(this.history),
        seedContext: null,
        relatedSummaries: [],
        orientation: null,
      };
    } else {
      const result = await runRecallLoop(
        this.history,
        prompt,
        this.promptIndex,
        {
          config: this.config,
          cwd: this.cwd,
          model: this.model,
          abortSignal: this.abortController?.signal,
          nodeContext: null,
          onIteration: (iter) => this.onRecallIteration?.(this.promptIndex, iter),
          onOrientationPhase: (phase, data) => this.onOrientationPhase?.(this.promptIndex, phase, data),
          ...(this._compassProvider ? { compassProvider: this._compassProvider } : {}),
        },
      );

      context = result.context;
      trajectory = result.trajectory;
    }

    const planRef = this.getPlanReference();
    if (planRef) {
      context = context ? context + planRef : planRef;
    }

    if (trajectory) {
      trajectory.finalContext = context;
      this.trajectoryManager.store(this.promptIndex, trajectory);
      this.persistence.persistTrajectoryQueued(this.promptIndex, trajectory);
      this.onRecallComplete?.(this.promptIndex, trajectory);
    }

    return context;
  }

  private getPlanReference(): string | null {
    const planPath = this.persistence.planFilePath;
    if (!planPath) return null;
    return `\n\nThis session has an associated plan file. Read it before starting implementation: ${planPath}`;
  }
}
