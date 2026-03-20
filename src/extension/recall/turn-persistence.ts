import * as fs from 'fs';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { log } from '../logger';
import { initializeSession, persistUserMessage, initNodeFile } from '../session';
import { readSessionEntries } from '../session';
import { getSessionDir, buildSessionFilePath, buildNodeFilePath } from '../session/paths';
import { EXTENSION_VERSION } from '../session/types';
import type { ContentBlock, UserContentBlock } from '../../shared/types/content';
import type { StructuredTurn, ToolCallRecord, TurnContentBlock, RecallTrajectory, NodeSummary, NodeState } from './types';
import { extractFilesTouched } from './types';

function readGitBranch(cwd: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', timeout: 3000 }).trim() || 'main';
  } catch {
    return 'main';
  }
}

export interface FlushedAssistantData {
  messageId: string;
  model: string;
  content: ContentBlock[];
  stopReason: string | null;
  sessionId: string;
  uuid?: string;
}

interface TurnAccumulator {
  promptIndex: number;
  userMessage: string;
  assistantResponse: string;
  toolCalls: ToolCallRecord[];
  contentBlocks: TurnContentBlock[];
  thinkingBlocks: string[];
  timestamp: string;
  nodeId: string | null;
}

export class TurnPersistence {
  private workspacePath: string;
  private sessionId: string;
  private _lastLeafUuid: string | null = null;
  private _lastFlushedUuid: string | null = null;
  private _lastUserUuid: string | null = null;
  private initialized = false;
  private gitBranch: string;
  private persistQueue: Promise<void> = Promise.resolve();
  private pendingToolResults: Array<{ toolUseId: string; content: string }> = [];
  private _blockPersistedForMessageId: string | null = null;
  private _planFilePath: string | null = null;
  private _generation = 0;

  private currentTurn: TurnAccumulator | null = null;
  private currentNodeId: string | null = null;
  private nodeFilesInitialized = new Set<string>();
  private nodeLeafUuids = new Map<string, string>();

  constructor(workspacePath: string, sessionId: string) {
    this.workspacePath = workspacePath;
    this.sessionId = sessionId;
    this.gitBranch = readGitBranch(workspacePath);
  }

  get lastLeafUuid(): string | null {
    return this._lastLeafUuid;
  }

  get lastFlushedLeafUuid(): string | null {
    return this._lastFlushedUuid ?? this._lastLeafUuid;
  }

  advanceLeafUuid(uuid: string): void {
    this._lastFlushedUuid = uuid;
  }

  get lastUserUuid(): string | null {
    return this._lastUserUuid;
  }

  get planFilePath(): string | null {
    return this._planFilePath;
  }

  set planFilePath(value: string | null) {
    this._planFilePath = value;
    if (value && this.initialized) {
      this.persistPlanPath(value).catch(err => {
        log('[TurnPersistence] Failed to persist plan path from setter:', err);
      });
    }
  }

  async persistPlanPath(planPath: string): Promise<void> {
    const sessionDir = await getSessionDir(this.workspacePath);
    const filePath = buildSessionFilePath(sessionDir, this.sessionId);
    const entry = {
      type: 'plan-path',
      planPath,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
    };
    await fs.promises.appendFile(filePath, JSON.stringify(entry) + '\n');
    this._planFilePath = planPath;
    log('[TurnPersistence.persistPlanPath] Written plan-path entry: %s', planPath);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await initializeSession(this.workspacePath, this.sessionId);
    await this.persistRecallMarker();
    this.initialized = true;
    if (this._planFilePath) {
      await this.persistPlanPath(this._planFilePath);
    }
  }

  private async persistRecallMarker(): Promise<void> {
    const sessionDir = await getSessionDir(this.workspacePath);
    const filePath = buildSessionFilePath(sessionDir, this.sessionId);
    const entry = {
      type: 'context-strategy',
      contextStrategy: 'recall',
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
    };
    await fs.promises.appendFile(filePath, JSON.stringify(entry) + '\n');
    log('[TurnPersistence] Written context-strategy recall marker');
  }

  private async resolveTargetFilePath(nodeId: string | null): Promise<string> {
    const sessionDir = await getSessionDir(this.workspacePath);
    if (!nodeId) return buildSessionFilePath(sessionDir, this.sessionId);
    if (!this.nodeFilesInitialized.has(nodeId)) {
      await initNodeFile(this.workspacePath, this.sessionId, nodeId);
      this.nodeFilesInitialized.add(nodeId);
    }
    return buildNodeFilePath(sessionDir, this.sessionId, nodeId);
  }

  async persistUser(content: string | UserContentBlock[], nodeIdOverride?: string | null): Promise<string> {
    const normalizedContent = typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map(b => ({ type: b.type, text: b.text }));

    const effectiveNodeId = nodeIdOverride !== undefined ? nodeIdOverride : this.currentNodeId;

    if (effectiveNodeId) {
      const targetFilePath = await this.resolveTargetFilePath(effectiveNodeId);
      const parentUuid = this.nodeLeafUuids.get(effectiveNodeId) ?? this._lastLeafUuid;
      const uuid = await persistUserMessage({
        workspacePath: this.workspacePath,
        sessionId: this.sessionId,
        content: normalizedContent,
        parentUuid,
        targetFilePath,
      });

      this.nodeLeafUuids.set(effectiveNodeId, uuid);

      const sessionDir = await getSessionDir(this.workspacePath);
      const mainFilePath = buildSessionFilePath(sessionDir, this.sessionId);
      const refEntry = {
        type: 'node-turn-ref',
        uuid,
        parentUuid: this._lastLeafUuid,
        nodeId: effectiveNodeId,
        promptIndex: this.currentTurn?.promptIndex ?? -1,
        timestamp: new Date().toISOString(),
      };
      await fs.promises.appendFile(mainFilePath, JSON.stringify(refEntry) + '\n');

      this._lastFlushedUuid = null;
      this._lastLeafUuid = uuid;
      this._lastUserUuid = uuid;
      return uuid;
    }

    const uuid = await persistUserMessage({
      workspacePath: this.workspacePath,
      sessionId: this.sessionId,
      content: normalizedContent,
      parentUuid: this._lastLeafUuid,
    });

    this._lastFlushedUuid = null;
    this._lastLeafUuid = uuid;
    this._lastUserUuid = uuid;
    return uuid;
  }

  startTurn(promptIndex: number, userMessage: string, nodeId: string | null = null): void {
    this.currentNodeId = nodeId;
    this.currentTurn = {
      promptIndex,
      userMessage,
      assistantResponse: '',
      toolCalls: [],
      contentBlocks: [],
      thinkingBlocks: [],
      timestamp: new Date().toISOString(),
      nodeId,
    };
  }

  appendAssistantDelta(text: string): void {
    if (this.currentTurn) {
      this.currentTurn.assistantResponse += text;
      const blocks = this.currentTurn.contentBlocks;
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'text') {
        last.content += text;
      } else {
        blocks.push({ type: 'text', content: text });
      }
    }
  }

  addToolCall(name: string, input: Record<string, unknown>, toolUseId?: string): void {
    if (this.currentTurn) {
      const record: ToolCallRecord = { name, input, result: '' };
      if (toolUseId) record.id = toolUseId;
      const index = this.currentTurn.toolCalls.length;
      this.currentTurn.toolCalls.push(record);
      this.currentTurn.contentBlocks.push({ type: 'tool_call', index });
    }
  }

  addToolResult(name: string, result: string): void {
    if (!this.currentTurn) return;
    const call = [...this.currentTurn.toolCalls].reverse().find(tc => tc.name === name && !tc.result);
    if (call) {
      call.result = result;
    }
  }

  addToolResultById(toolUseId: string, name: string, result: string): void {
    if (!this.currentTurn) return;
    if (toolUseId) {
      const call = this.currentTurn.toolCalls.find(tc => tc.id === toolUseId);
      if (call) {
        call.result = result;
        return;
      }
    }
    const call = [...this.currentTurn.toolCalls].reverse().find(tc => tc.name === name && !tc.result);
    if (call) {
      call.result = result;
    }
  }

  addThinkingBlock(thinking: string): void {
    if (this.currentTurn) {
      this.currentTurn.thinkingBlocks.push(thinking);
    }
  }

  finalizeTurn(): StructuredTurn | null {
    if (!this.currentTurn) return null;
    const turn: StructuredTurn = {
      promptIndex: this.currentTurn.promptIndex,
      timestamp: this.currentTurn.timestamp,
      userMessage: this.currentTurn.userMessage,
      assistantResponse: this.currentTurn.assistantResponse,
      toolCalls: this.currentTurn.toolCalls,
      contentBlocks: this.currentTurn.contentBlocks,
      thinkingBlocks: [],
      filesTouched: extractFilesTouched(this.currentTurn.toolCalls),
      nodeId: this.currentTurn.nodeId,
    };
    this.currentTurn = null;
    this.currentNodeId = null;
    return turn;
  }

  setCurrentTurnNodeId(nodeId: string | null): void {
    if (this.currentTurn) {
      this.currentTurn.nodeId = nodeId;
    }
  }

  async persistAssistant(data: FlushedAssistantData, nodeIdOverride?: string | null): Promise<string> {
    const effectiveNodeId = nodeIdOverride !== undefined ? nodeIdOverride : this.currentNodeId;
    const messageUuid = data.uuid ?? crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const filePath = await this.resolveTargetFilePath(effectiveNodeId);
    const parentUuid = effectiveNodeId
      ? (this.nodeLeafUuids.get(effectiveNodeId) ?? this._lastLeafUuid)
      : this._lastLeafUuid;

    const contentBlocks = data.content.map(block => {
      switch (block.type) {
        case 'thinking':
          return { type: 'thinking', thinking: block.thinking, ...(block.signature ? { signature: block.signature } : {}) };
        case 'text':
          return { type: 'text', text: block.text };
        case 'tool_use':
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        case 'tool_result':
          return { type: 'tool_result', tool_use_id: block.tool_use_id, content: block.content };
        default:
          return block;
      }
    });

    const assistantEntry = {
      parentUuid,
      isSidechain: false,
      userType: 'external',
      cwd: this.workspacePath,
      sessionId: this.sessionId,
      version: EXTENSION_VERSION,
      gitBranch: this.gitBranch,
      type: 'assistant',
      message: {
        id: data.messageId,
        model: data.model,
        type: 'message',
        role: 'assistant',
        content: contentBlocks,
        stop_reason: data.stopReason !== undefined ? data.stopReason : 'end_turn',
      },
      uuid: messageUuid,
      timestamp,
    };

    await fs.promises.appendFile(filePath, JSON.stringify(assistantEntry) + '\n');
    if (effectiveNodeId) {
      this.nodeLeafUuids.set(effectiveNodeId, messageUuid);
    }
    this._lastLeafUuid = messageUuid;
    return messageUuid;
  }

  async persistToolResult(toolUseId: string, content: string, nodeIdOverride?: string | null): Promise<string> {
    const effectiveNodeId = nodeIdOverride !== undefined ? nodeIdOverride : this.currentNodeId;
    const uuid = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const filePath = await this.resolveTargetFilePath(effectiveNodeId);
    const parentUuid = effectiveNodeId
      ? (this.nodeLeafUuids.get(effectiveNodeId) ?? this._lastLeafUuid)
      : this._lastLeafUuid;

    const entry = {
      parentUuid,
      isSidechain: false,
      userType: 'external',
      cwd: this.workspacePath,
      sessionId: this.sessionId,
      version: EXTENSION_VERSION,
      gitBranch: this.gitBranch,
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
      },
      uuid,
      timestamp,
    };

    await fs.promises.appendFile(filePath, JSON.stringify(entry) + '\n');
    if (effectiveNodeId) {
      this.nodeLeafUuids.set(effectiveNodeId, uuid);
    }
    this._lastLeafUuid = uuid;
    return uuid;
  }

  persistAssistantBlockQueued(messageId: string, model: string, blocks: ContentBlock[]): void {
    this._blockPersistedForMessageId = messageId;
    const nodeId = this.currentNodeId;
    const data: FlushedAssistantData = {
      messageId,
      model,
      content: blocks,
      stopReason: null,
      sessionId: this.sessionId,
    };
    const gen = this._generation;
    this.persistQueue = this.persistQueue
      .then(() => {
        if (gen !== this._generation) return;
        return this.persistAssistant(data, nodeId).then(() => {});
      })
      .catch(err => log('[TurnPersistence] Queued block persist failed:', err));
  }

  persistToolResultQueued(toolUseId: string, content: string): void {
    this.pendingToolResults.push({ toolUseId, content });
  }

  persistUserQueued(content: string | UserContentBlock[]): void {
    const nodeId = this.currentNodeId;
    const gen = this._generation;
    this.persistQueue = this.persistQueue
      .then(async () => {
        if (gen !== this._generation) return;
        await this.persistUser(content, nodeId);
      })
      .catch(err => log('[TurnPersistence] Queued user persist failed:', err));
  }

  persistAssistantQueued(data: FlushedAssistantData): void {
    const toolResults = this.pendingToolResults.splice(0);
    const nodeId = this.currentNodeId;
    const strippedContent = this._blockPersistedForMessageId === data.messageId
      ? data.content.filter(b => b.type !== 'thinking')
      : data.content;
    this._blockPersistedForMessageId = null;

    const gen = this._generation;
    this.persistQueue = this.persistQueue
      .then(async () => {
        if (gen !== this._generation) return;
        for (const tr of toolResults) {
          if (gen !== this._generation) return;
          await this.persistToolResult(tr.toolUseId, tr.content, nodeId);
        }
        if (strippedContent.length > 0) {
          await this.persistAssistant({ ...data, content: strippedContent }, nodeId);
        }
      })
      .catch(err => log('[TurnPersistence] Queued persist failed:', err));
  }

  persistTrajectoryQueued(promptIndex: number, trajectory: RecallTrajectory): void {
    const nodeId = trajectory.nodeId ?? null;
    const gen = this._generation;
    this.persistQueue = this.persistQueue
      .then(async () => {
        if (gen !== this._generation) return;
        const filePath = await this.resolveTargetFilePath(nodeId);
        const entry = {
          type: 'recall-trajectory',
          promptIndex,
          trajectory,
          sessionId: this.sessionId,
          timestamp: new Date().toISOString(),
        };
        await fs.promises.appendFile(filePath, JSON.stringify(entry) + '\n');
        log('[TurnPersistence.persistTrajectory] Persisted trajectory for prompt %d', promptIndex);
      })
      .catch(err => log('[TurnPersistence] Queued trajectory persist failed:', err));
  }

  flushPendingToolResults(): void {
    const toolResults = this.pendingToolResults.splice(0);
    if (toolResults.length === 0) return;
    const gen = this._generation;
    this.persistQueue = this.persistQueue
      .then(async () => {
        if (gen !== this._generation) return;
        for (const tr of toolResults) {
          await this.persistToolResult(tr.toolUseId, tr.content);
        }
      })
      .catch(err => log('[TurnPersistence] Flush tool results failed:', err));
  }

  async flushQueue(): Promise<void> {
    await this.persistQueue;
  }

  async loadLeafUuid(): Promise<void> {
    const gen = this._generation;
    try {
      const entries = await readSessionEntries(this.workspacePath, this.sessionId);
      if (gen !== this._generation) return;

      this._lastLeafUuid = null;
      this._lastFlushedUuid = null;
      this._lastUserUuid = null;

      for (const entry of entries) {
        if (entry.type === 'plan-path' && entry.planPath) {
          this._planFilePath = entry.planPath;
        }
      }

      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (!entry?.uuid) continue;

        if (entry.type === 'user' || entry.type === 'assistant' || entry.type === 'node-turn-ref') {
          if (!this._lastLeafUuid) {
            this._lastLeafUuid = entry.uuid;
          }
          if (!this._lastUserUuid && (entry.type === 'user' || entry.type === 'node-turn-ref')) {
            this._lastUserUuid = entry.uuid;
          }
          if (this._lastLeafUuid && this._lastUserUuid) break;
        }
      }

      if (this._lastLeafUuid) {
        this.initialized = true;
      }
    } catch (err) {
      log('[TurnPersistence] loadLeafUuid failed:', err);
    }
  }

  applyLeafState(leafUuid: string, lastUserUuid: string | null, planPath: string | null): void {
    this._lastLeafUuid = leafUuid;
    this._lastUserUuid = lastUserUuid;
    this._planFilePath = planPath;
    this.initialized = true;
  }

  persistNodeCreatedQueued(nodeId: string, title: string, keyEntities: string[]): void {
    const gen = this._generation;
    this.persistQueue = this.persistQueue
      .then(async () => {
        if (gen !== this._generation) return;
        const sessionDir = await getSessionDir(this.workspacePath);
        const filePath = buildSessionFilePath(sessionDir, this.sessionId);
        const entry = {
          type: 'node-created',
          nodeId,
          title,
          keyEntities,
          sessionId: this.sessionId,
          timestamp: new Date().toISOString(),
        };
        await fs.promises.appendFile(filePath, JSON.stringify(entry) + '\n');
        log('[TurnPersistence] Persisted node-created: %s "%s"', nodeId.slice(0, 8), title);
      })
      .catch(err => log('[TurnPersistence] Queued node-created persist failed:', err));
  }

  persistNodeClosedQueued(nodeId: string, summary: NodeSummary): void {
    const gen = this._generation;
    this.persistQueue = this.persistQueue
      .then(async () => {
        if (gen !== this._generation) return;
        const sessionDir = await getSessionDir(this.workspacePath);
        const filePath = buildSessionFilePath(sessionDir, this.sessionId);
        const entry = {
          type: 'node-closed',
          nodeId,
          summary,
          sessionId: this.sessionId,
          timestamp: new Date().toISOString(),
        };
        await fs.promises.appendFile(filePath, JSON.stringify(entry) + '\n');
        log('[TurnPersistence] Persisted node-closed: %s', nodeId.slice(0, 8));
      })
      .catch(err => log('[TurnPersistence] Queued node-closed persist failed:', err));
  }

  persistNodeReopenedQueued(nodeId: string): void {
    const gen = this._generation;
    this.persistQueue = this.persistQueue
      .then(async () => {
        if (gen !== this._generation) return;
        const sessionDir = await getSessionDir(this.workspacePath);
        const filePath = buildSessionFilePath(sessionDir, this.sessionId);
        const entry = {
          type: 'node-reopened',
          nodeId,
          sessionId: this.sessionId,
          timestamp: new Date().toISOString(),
        };
        await fs.promises.appendFile(filePath, JSON.stringify(entry) + '\n');
        log('[TurnPersistence] Persisted node-reopened: %s', nodeId.slice(0, 8));
      })
      .catch(err => log('[TurnPersistence] Queued node-reopened persist failed:', err));
  }

  persistNodeSeedContextQueued(nodeId: string, seedContext: string, seedContextPrompt?: string | null): void {
    const gen = this._generation;
    this.persistQueue = this.persistQueue
      .then(async () => {
        if (gen !== this._generation) return;
        const sessionDir = await getSessionDir(this.workspacePath);
        const filePath = buildSessionFilePath(sessionDir, this.sessionId);
        const entry: Record<string, unknown> = {
          type: 'node-seed-context',
          nodeId,
          seedContext,
          sessionId: this.sessionId,
          timestamp: new Date().toISOString(),
        };
        if (seedContextPrompt) {
          entry['seedContextPrompt'] = seedContextPrompt;
        }
        await fs.promises.appendFile(filePath, JSON.stringify(entry) + '\n');
        log('[TurnPersistence] Persisted node-seed-context: %s (%d chars)', nodeId.slice(0, 8), seedContext.length);
      })
      .catch(err => log('[TurnPersistence] Queued node-seed-context persist failed:', err));
  }

  persistNodeStateQueued(nodeState: NodeState): void {
    const snapshot = JSON.stringify(nodeState);
    const gen = this._generation;
    this.persistQueue = this.persistQueue
      .then(async () => {
        if (gen !== this._generation) return;
        const sessionDir = await getSessionDir(this.workspacePath);
        const filePath = buildSessionFilePath(sessionDir, this.sessionId);
        const entry = {
          type: 'node-state',
          data: snapshot,
          sessionId: this.sessionId,
          timestamp: new Date().toISOString(),
        };
        await fs.promises.appendFile(filePath, JSON.stringify(entry) + '\n');
      })
      .catch(err => log('[TurnPersistence] Queued node-state persist failed:', err));
  }

  reset(newSessionId: string): void {
    this._generation++;
    this.sessionId = newSessionId;
    this._lastLeafUuid = null;
    this._lastFlushedUuid = null;
    this._lastUserUuid = null;
    this._planFilePath = null;
    this.pendingToolResults = [];
    this._blockPersistedForMessageId = null;
    this.currentTurn = null;
    this.currentNodeId = null;
    this.nodeFilesInitialized = new Set<string>();
    this.nodeLeafUuids = new Map<string, string>();
    this.initialized = false;
    this.persistQueue = Promise.resolve();
    this.gitBranch = readGitBranch(this.workspacePath);
  }
}
