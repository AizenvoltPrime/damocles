import * as fs from 'fs';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { log } from '../logger';
import { initializeSession, persistUserMessage } from '../session';
import { readSessionEntries } from '../session';
import { getSessionDir, buildSessionFilePath } from '../session/paths';
import { EXTENSION_VERSION } from '../session/types';
import type { ContentBlock, UserContentBlock } from '../../shared/types/content';

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

export class DistillPersistence {
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
  private _generation = 0;

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

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await initializeSession(this.workspacePath, this.sessionId);
    this.initialized = true;
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

    log('[DistillPersistence.persistAssistant] Written to %s, uuid=%s, blocks=%d',
      filePath, messageUuid, contentBlocks.length);

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

    log('[DistillPersistence.persistToolResult] Written tool_result for %s, uuid=%s', toolUseId, uuid);

    this._lastLeafUuid = uuid;
    return uuid;
  }

  persistAssistantBlockQueued(messageId: string, model: string, blocks: ContentBlock[]): void {
    log('[DistillPersistence.persistAssistantBlockQueued] messageId=%s, blockTypes=%s',
      messageId, blocks.map(b => b.type).join(','));
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
      .catch(err => log('[DistillPersistence] Queued block persist failed:', err));
  }

  persistToolResultQueued(toolUseId: string, content: string): void {
    log('[DistillPersistence.persistToolResultQueued] Buffering toolUseId=%s', toolUseId);
    this.pendingToolResults.push({ toolUseId, content });
  }

  persistAssistantQueued(data: FlushedAssistantData): void {
    const toolResults = this.pendingToolResults.splice(0);
    const strippedContent = this._blockPersistedForMessageId === data.messageId
      ? data.content.filter(b => b.type !== 'thinking')
      : data.content;
    this._blockPersistedForMessageId = null;

    log('[DistillPersistence.persistAssistantQueued] messageId=%s, contentBlocks=%d (stripped=%d), pendingToolResults=%d',
      data.messageId, data.content.length, strippedContent.length, toolResults.length);
    const gen = this._generation;
    this.persistQueue = this.persistQueue
      .then(async () => {
        if (gen !== this._generation) return;
        if (strippedContent.length > 0) {
          await this.persistAssistant({ ...data, content: strippedContent });
        }
        for (const tr of toolResults) {
          if (gen !== this._generation) return;
          await this.persistToolResult(tr.toolUseId, tr.content);
        }
      })
      .catch(err => log('[DistillPersistence] Queued persist failed:', err));
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
      log('[DistillPersistence] loadLeafUuid failed:', err);
    }
  }

  reset(newSessionId: string): void {
    this._generation++;
    this.sessionId = newSessionId;
    this._lastLeafUuid = null;
    this._lastFlushedUuid = null;
    this._lastUserUuid = null;
    this.pendingToolResults = [];
    this._blockPersistedForMessageId = null;
    this.initialized = false;
  }
}
