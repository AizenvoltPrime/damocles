import * as fs from 'fs';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { log } from '../logger';
import { initializeSession, persistUserMessage } from '../session';
import { readSessionEntries } from '../session';
import { getSessionDir, buildSessionFilePath } from '../session/paths';
import { EXTENSION_VERSION } from '../session/types';
import type { ContentBlock, UserContentBlock } from '../../shared/types/content';
import type { StructuredTurn, ToolCallRecord, RecallTrajectory } from './types';
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
  thinkingBlocks: string[];
  timestamp: string;
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

  async persistUser(content: string | UserContentBlock[]): Promise<string> {
    const normalizedContent = typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map(b => ({ type: b.type, text: b.text }));
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

  startTurn(promptIndex: number, userMessage: string): void {
    this.currentTurn = {
      promptIndex,
      userMessage,
      assistantResponse: '',
      toolCalls: [],
      thinkingBlocks: [],
      timestamp: new Date().toISOString(),
    };
  }

  appendAssistantDelta(text: string): void {
    if (this.currentTurn) {
      this.currentTurn.assistantResponse += text;
    }
  }

  addToolCall(name: string, input: Record<string, unknown>, toolUseId?: string): void {
    if (this.currentTurn) {
      const record: ToolCallRecord = { name, input, result: '' };
      if (toolUseId) record.id = toolUseId;
      this.currentTurn.toolCalls.push(record);
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
      thinkingBlocks: this.currentTurn.thinkingBlocks,
      filesTouched: extractFilesTouched(this.currentTurn.toolCalls),
    };
    this.currentTurn = null;
    return turn;
  }

  async persistAssistant(data: FlushedAssistantData): Promise<string> {
    const messageUuid = data.uuid ?? crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const sessionDir = await getSessionDir(this.workspacePath);
    const filePath = buildSessionFilePath(sessionDir, this.sessionId);

    const contentBlocks = data.content.map(block => {
      switch (block.type) {
        case 'thinking':
          return { type: 'thinking', thinking: block.thinking };
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
      parentUuid: this._lastLeafUuid,
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
    this._lastLeafUuid = messageUuid;
    return messageUuid;
  }

  async persistToolResult(toolUseId: string, content: string): Promise<string> {
    const uuid = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const sessionDir = await getSessionDir(this.workspacePath);
    const filePath = buildSessionFilePath(sessionDir, this.sessionId);

    const entry = {
      parentUuid: this._lastLeafUuid,
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
    this._lastLeafUuid = uuid;
    return uuid;
  }

  persistAssistantBlockQueued(messageId: string, model: string, blocks: ContentBlock[]): void {
    this._blockPersistedForMessageId = messageId;
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
        return this.persistAssistant(data).then(() => {});
      })
      .catch(err => log('[TurnPersistence] Queued block persist failed:', err));
  }

  persistToolResultQueued(toolUseId: string, content: string): void {
    this.pendingToolResults.push({ toolUseId, content });
  }

  persistAssistantQueued(data: FlushedAssistantData): void {
    const toolResults = this.pendingToolResults.splice(0);
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
          await this.persistToolResult(tr.toolUseId, tr.content);
        }
        if (strippedContent.length > 0) {
          await this.persistAssistant({ ...data, content: strippedContent });
        }
      })
      .catch(err => log('[TurnPersistence] Queued persist failed:', err));
  }

  persistTrajectoryQueued(promptIndex: number, trajectory: RecallTrajectory): void {
    const gen = this._generation;
    this.persistQueue = this.persistQueue
      .then(async () => {
        if (gen !== this._generation) return;
        const sessionDir = await getSessionDir(this.workspacePath);
        const filePath = buildSessionFilePath(sessionDir, this.sessionId);
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

  persistGraphSnapshotQueued(promptIndex: number, snapshot: import('../../shared/types/graph').GraphExecutionSnapshot): void {
    const gen = this._generation;
    this.persistQueue = this.persistQueue
      .then(async () => {
        if (gen !== this._generation) return;
        const sessionDir = await getSessionDir(this.workspacePath);
        const filePath = buildSessionFilePath(sessionDir, this.sessionId);
        const entry = {
          type: 'recall-graph-snapshot',
          promptIndex,
          snapshot,
          sessionId: this.sessionId,
          timestamp: new Date().toISOString(),
        };
        await fs.promises.appendFile(filePath, JSON.stringify(entry) + '\n');
      })
      .catch(err => log('[TurnPersistence] Queued graph snapshot persist failed:', err));
  }

  persistGraphStateQueued(data: string): void {
    const gen = this._generation;
    this.persistQueue = this.persistQueue
      .then(async () => {
        if (gen !== this._generation) return;
        const sessionDir = await getSessionDir(this.workspacePath);
        const filePath = buildSessionFilePath(sessionDir, this.sessionId);
        const entry = {
          type: 'recall-graph-state',
          data,
          sessionId: this.sessionId,
          timestamp: new Date().toISOString(),
        };
        await fs.promises.appendFile(filePath, JSON.stringify(entry) + '\n');
      })
      .catch(err => log('[TurnPersistence] Queued graph state persist failed:', err));
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

        if (entry.type === 'user' || entry.type === 'assistant') {
          if (!this._lastLeafUuid) {
            this._lastLeafUuid = entry.uuid;
          }
          if (!this._lastUserUuid && entry.type === 'user') {
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
    this.initialized = false;
    this.persistQueue = Promise.resolve();
    this.gitBranch = readGitBranch(this.workspacePath);
  }
}
