import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { log } from '../logger';
import { openContextDatabase, getMaxPromptIndex, getSummaryEntriesByPrompt, getEntriesForPrompt } from './context-database';
import { EntryTracker, summarizeToolInput, extractTaskResultTexts } from './entry-tracker';
import { createContextMcpServer } from './context-mcp-server';
import { retrieveContextForPrompt } from './context-retriever';
import { HAIKU_CONTEXT_SYSTEM_PROMPT, buildHaikuPrompt } from './prompts';
import { DistillPersistence } from './distill-persistence';
import type { FlushedAssistantData } from './distill-persistence';
import { CONTEXT_DIR } from './types';
import type { DistillationConfig } from './types';
import type { DatabaseInstance } from '../memory/types';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { HaikuPromptActivity, HaikuDisplayBlock } from '../../shared/types/haiku-observer';
import type { ContentBlock } from '../../shared/types/content';
import { initSubagentFile, persistSubagentEntry } from '../session';


function extractMcpResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((item: { type?: string; text?: string }) => item.type === 'text' && item.text)
      .map((item: { text: string }) => item.text)
      .join('\n');
  }
  return JSON.stringify(content);
}

interface SubagentPersistState {
  agentId: string;
  model?: string;
  pendingToolResults: Array<{ toolUseId: string; content: string }>;
  blockPersistedForMessageId: string | null;
  pendingFinalResponse?: string;
  writeQueue: Promise<void>;
  initFailed?: boolean;
}

type SdkCreateServer = typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer;
type SdkTool = typeof import('@anthropic-ai/claude-agent-sdk').tool;
type SdkQuery = typeof import('@anthropic-ai/claude-agent-sdk').query;
type ZodZ = typeof import('zod').z;

export { DEFAULT_OBSERVER_MODEL, DEFAULT_TOKEN_BUDGET } from './types';
const HAIKU_TIMEOUT_MS = 120_000;

export class ContextDistillationService {
  private config: DistillationConfig;
  private _persistenceSessionId: string;
  private _sessionId: string;
  private cwd: string;
  private persistence: DistillPersistence;
  private _lastUserPrompt = '';
  private _haikuProcessing = false;
  private _completionResolvers: (() => void)[] = [];
  private _promptIndex = -1;
  private _activeSubagents: Map<string, SubagentPersistState> = new Map();

  private contextDb: DatabaseInstance | null = null;
  private entryTracker: EntryTracker | null = null;
  private assistantTextBuffer = '';
  private currentAbort: AbortController | null = null;
  private mcpModules: { createSdkMcpServer: SdkCreateServer; tool: SdkTool; z: ZodZ; query: SdkQuery } | null = null;

  onHaikuStreamEvent?: (message: ExtensionToWebviewMessage) => void;
  onSubagentDataReady?: (taskToolUseId: string, agentId: string) => void;

  constructor(cwd: string, config: DistillationConfig) {
    this.config = config;
    this.cwd = cwd;
    this._persistenceSessionId = crypto.randomUUID();
    this._sessionId = crypto.randomUUID();
    this.persistence = new DistillPersistence(cwd, this._persistenceSessionId);

    if (this.config.enabled) {
      this.contextDb = openContextDatabase(this._persistenceSessionId);
    }

  }

  get isEnabled(): boolean {
    return this.config.enabled;
  }

  get isHaikuProcessing(): boolean {
    return this._haikuProcessing;
  }

  waitForDistillReady(): Promise<void> {
    if (!this._haikuProcessing) return Promise.resolve();
    return new Promise(resolve => this._completionResolvers.push(resolve));
  }

  cancelPendingWait(): void {
    this._haikuProcessing = false;
    this.currentAbort?.abort();
    this.currentAbort = null;
    this.resolveDistillWaiters();
  }

  get sessionId(): string | null {
    return this.config.enabled ? this._sessionId : null;
  }

  get persistenceSessionId(): string | null {
    return this.config.enabled ? this._persistenceSessionId : null;
  }

  get distillPersistence(): DistillPersistence {
    return this.persistence;
  }

  get planFilePath(): string | null {
    return this.persistence.planFilePath;
  }

  set planFilePath(value: string | null) {
    this.persistence.planFilePath = value;
  }

  setSessionId(id: string): void {
    this._persistenceSessionId = id;
    this._sessionId = crypto.randomUUID();
    this._lastUserPrompt = '';
    this.cancelPendingWait();
    this._activeSubagents.clear();
    this._promptIndex = -1;
    this.assistantTextBuffer = '';
    this.entryTracker = null;

    this.closeDb();
    this.contextDb = openContextDatabase(id);

    if (this.contextDb) {
      const maxIdx = getMaxPromptIndex(this.contextDb, id);
      if (maxIdx >= 0) {
        this._promptIndex = maxIdx;
        log('[ContextDistillation] Restored promptIndex to %d from DB', this._promptIndex);
      }
    }

    this.persistence.reset(id);
    this.persistence.loadLeafUuid().catch(err => {
      log('[ContextDistillation] Failed to load leaf UUID:', err);
    });
  }

  refreshConfig(config: DistillationConfig): void {
    this.config = config;
    this.cancelPendingWait();
  }

  getContextForInjection(userPrompt?: string): string | null {
    if (!this.config.enabled || !this.contextDb) return null;

    let content = retrieveContextForPrompt(
      this.contextDb,
      userPrompt ?? this._lastUserPrompt,
      this._promptIndex,
      this.config.tokenBudget,
    );

    log('[ContextDistillation.getContextForInjection] sessionId=%s, hasContent=%s, contentLength=%d',
      this._sessionId, content !== null, content?.length ?? 0);

    const planPath = this.persistence.planFilePath;
    if (planPath) {
      const planRef = `\n\nThis session has an associated plan file. Read it before starting implementation: ${planPath}`;
      content = content ? content + planRef : planRef.trimStart();
    }

    return content;
  }

  onPromptSubmit(userPrompt: string): void {
    if (!this.config.enabled) return;
    this._lastUserPrompt = userPrompt;
    this._promptIndex++;
    this.assistantTextBuffer = '';
    log('[ContextDistillation.onPromptSubmit] sessionId=%s, promptIndex=%d, prompt=%s',
      this._sessionId, this._promptIndex, userPrompt.slice(0, 80));

    if (this.contextDb) {
      this.entryTracker = new EntryTracker(this.contextDb, this._persistenceSessionId, this._promptIndex);
    }
  }

  get lastFlushedLeafUuid(): string | null {
    return this.config.enabled ? this.persistence.lastFlushedLeafUuid : null;
  }

  onAssistantFlushed(uuid: string): void {
    if (!this.config.enabled) return;
    this.persistence.advanceLeafUuid(uuid);
  }

  onInterjection(text: string): void {
    if (!this.config.enabled) return;
    this.assistantTextBuffer += `\n[User interjection]: ${text}\n`;
  }

  onFlushedPromptSubmit(userPrompt: string): void {
    if (!this.config.enabled) return;
    this._lastUserPrompt = userPrompt;
    this._promptIndex++;
    this.assistantTextBuffer = '';

    if (this.contextDb) {
      this.entryTracker = new EntryTracker(this.contextDb, this._persistenceSessionId, this._promptIndex);
    }
  }

  onThinkingBlockComplete(messageId: string, model: string, thinking: string, parentToolUseId?: string): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onThinkingBlockComplete] messageId=%s, thinkingLen=%d, parentToolUseId=%s',
      messageId, thinking.length, parentToolUseId ?? 'none');

    if (parentToolUseId) {
      const subState = this._activeSubagents.get(parentToolUseId);
      if (subState) {
        subState.blockPersistedForMessageId = messageId;
        const entry = this.buildAgentAssistantEntry(
          { messageId, model, stopReason: null },
          [{ type: 'thinking' as const, thinking }]
        );
        subState.writeQueue = subState.writeQueue
          .then(() => {
            if (subState.initFailed) return;
            return persistSubagentEntry(this.cwd, this._persistenceSessionId, subState.agentId, entry);
          })
          .catch(err => log('[ContextDistillation] Failed to write subagent thinking:', err));
        return;
      }
    }

    this.persistence.persistAssistantBlockQueued(messageId, model, [{ type: 'thinking', thinking }]);
  }

  onToolUse(toolName: string, input: Record<string, unknown>, toolUseId?: string): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onToolUse] tool=%s, id=%s', toolName, toolUseId ?? 'none');

    if (toolName === 'Write' && typeof input['file_path'] === 'string') {
      const filePath = path.resolve(input['file_path']);
      const plansDir = path.resolve(os.homedir(), '.claude', 'plans');
      if (filePath.startsWith(plansDir + path.sep) && filePath.endsWith('.md')) {
        this.persistence.persistPlanPath(filePath).catch(err => {
          log('[ContextDistillation] Failed to persist plan path:', err);
        });
        return;
      }
    }

    this.entryTracker?.onToolUse(toolName, input, toolUseId);
    this.assistantTextBuffer += `\n[${toolName}] ${summarizeToolInput(toolName, input)}\n`;
  }

  onToolResult(toolName: string, toolUseId: string, result: string, parentToolUseId?: string): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onToolResult] tool=%s, toolUseId=%s, resultLen=%d, parentToolUseId=%s',
      toolName, toolUseId, result.length, parentToolUseId ?? 'none');

    if (parentToolUseId) {
      const subState = this._activeSubagents.get(parentToolUseId);
      if (subState) {
        subState.pendingToolResults.push({ toolUseId, content: result });
        return;
      }
    }

    this.entryTracker?.onToolResult(toolName, result, toolUseId);

    const preview = result.length > 300 ? result.slice(0, 300) + '...' : result;
    this.assistantTextBuffer += `→ ${preview}\n`;

    if (toolName === 'Task') {
      const subState = this._activeSubagents.get(toolUseId);
      if (subState) {
        subState.pendingFinalResponse = result;
      }
    }

    this.persistence.persistToolResultQueued(toolUseId, result);
  }

  onStreamDelta(delta: string): void {
    if (!this.config.enabled) return;
    this.assistantTextBuffer += delta;
  }

  onResponseComplete(): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onResponseComplete] sessionId=%s', this._sessionId);

    if (this.entryTracker) {
      this.entryTracker.finalize();
      this.fireHaikuWithMcp();
    }

    this.flushRemainingSubagentResponses();
  }

  regenerateSessionId(): void {
    const oldSdkId = this._sessionId;
    this._sessionId = crypto.randomUUID();

    log('[ContextDistillation.regenerateSessionId] sdkId %s → %s (persistenceId=%s unchanged)',
      oldSdkId.slice(0, 8), this._sessionId.slice(0, 8),
      this._persistenceSessionId.slice(0, 8));

    if (this.contextDb && this._lastUserPrompt) {
      this.entryTracker = new EntryTracker(this.contextDb, this._persistenceSessionId, this._promptIndex);
    }
  }

  onSubagentStart(toolUseId: string, agentId: string): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onSubagentStart] toolUseId=%s, agentId=%s', toolUseId, agentId);
    const subState: SubagentPersistState = {
      agentId,
      pendingToolResults: [],
      blockPersistedForMessageId: null,
      writeQueue: Promise.resolve(),
    };
    this._activeSubagents.set(toolUseId, subState);
    subState.writeQueue = initSubagentFile(this.cwd, this._persistenceSessionId, agentId)
      .catch(err => {
        log('[ContextDistillation] Failed to init subagent file:', err);
        subState.initFailed = true;
      });
  }

  onSubagentStop(agentId: string): void {
    if (!this.config.enabled) return;
    log('[ContextDistillation.onSubagentStop] agentId=%s', agentId);
  }

  persistAssistantData(data: FlushedAssistantData, parentToolUseId: string | null): void {
    if (!this.config.enabled) return;

    if (parentToolUseId) {
      const subState = this._activeSubagents.get(parentToolUseId);
      if (subState) {
        if (!subState.model) {
          subState.model = data.model;
        }

        const toolResults = subState.pendingToolResults.splice(0);
        const strippedContent = subState.blockPersistedForMessageId === data.messageId
          ? data.content.filter(b => b.type !== 'thinking')
          : data.content;
        subState.blockPersistedForMessageId = null;

        const hasPendingFinal = subState.pendingFinalResponse !== undefined;
        const taskToolUseId = parentToolUseId;

        subState.writeQueue = subState.writeQueue
          .then(async () => {
            if (subState.initFailed) return;
            if (strippedContent.length > 0) {
              await persistSubagentEntry(this.cwd, this._persistenceSessionId, subState.agentId,
                this.buildAgentAssistantEntry({ messageId: data.messageId, model: data.model, stopReason: data.stopReason }, strippedContent));
            }
            for (const tr of toolResults) {
              await persistSubagentEntry(this.cwd, this._persistenceSessionId, subState.agentId,
                this.buildAgentToolResultEntry(tr.toolUseId, tr.content));
            }
            if (subState.pendingFinalResponse) {
              await this.writeSubagentFinalResponse(subState);
            }
          })
          .then(() => {
            if (hasPendingFinal) {
              this.onSubagentDataReady?.(taskToolUseId, subState.agentId);
              this._activeSubagents.delete(taskToolUseId);
            }
          })
          .catch(err => log('[ContextDistillation] Failed to write subagent assistant:', err));
        return;
      }
    }

    this.persistence.persistAssistantQueued(data);
    if (data.uuid) {
      this.onAssistantFlushed(data.uuid);
    }
  }

  reset(): void {
    this.cancelPendingWait();
    this._persistenceSessionId = crypto.randomUUID();
    this._sessionId = crypto.randomUUID();
    this._activeSubagents.clear();
    this._promptIndex = -1;
    this._lastUserPrompt = '';
    this.assistantTextBuffer = '';
    this.entryTracker = null;

    this.closeDb();
    this.contextDb = openContextDatabase(this._persistenceSessionId);

    this.persistence.reset(this._persistenceSessionId);
  }

  dispose(): void {
    this.cancelPendingWait();
    this.closeDb();
  }

  async getHaikuActivities(): Promise<HaikuPromptActivity[]> {
    if (!this.contextDb) return [];

    const summaries = getSummaryEntriesByPrompt(this.contextDb, this._persistenceSessionId);
    const activities: HaikuPromptActivity[] = [];

    for (const s of summaries) {
      const logPath = this.getHaikuLogPath(s.prompt_index);
      const blocks = await this.parseHaikuLogBlocks(logPath);

      activities.push({
        promptIndex: s.prompt_index,
        thinking: '',
        text: s.description ?? '',
        blocks: blocks.length > 0 ? blocks : (s.description ? [{ type: 'text' as const, content: s.description }] : []),
        contextSnapshot: s.description ?? '',
        timestamp: s.created_at,
      });
    }

    return activities;
  }

  getHaikuLogPath(promptIndex: number): string {
    return path.join(CONTEXT_DIR, 'haiku', this._persistenceSessionId, `prompt-${promptIndex}`, 'haiku.jsonl');
  }

  getContextSummary(promptIndex: number): string | null {
    if (!this.contextDb) return null;

    const entries = getEntriesForPrompt(this.contextDb, this._persistenceSessionId, promptIndex);
    const summary = entries.find(e => e.entry_type === 'summary');
    if (!summary?.description) return null;

    const lines: string[] = [
      `# Context Summary — Prompt ${promptIndex}`,
      '',
      summary.description,
    ];
    if (summary.tags) lines.push('', `**Tags:** ${summary.tags}`);

    const contextEntries = entries.filter(e => e.entry_type !== 'summary' && e.description);
    if (contextEntries.length > 0) {
      lines.push('', '---', '', '## Annotated Entries', '');
      for (const entry of contextEntries) {
        lines.push(`- **${entry.file_path ?? entry.entry_type}**: ${entry.description}`);
      }
    }

    return lines.join('\n');
  }

  private resolveDistillWaiters(): void {
    const resolvers = this._completionResolvers;
    this._completionResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  private appendToHaikuLog(logDir: string, entry: unknown): Promise<void> {
    const line = JSON.stringify(entry) + '\n';
    return fs.appendFile(path.join(logDir, 'haiku.jsonl'), line, 'utf-8');
  }

  private async parseHaikuLogBlocks(logPath: string): Promise<HaikuDisplayBlock[]> {
    let raw: string;
    try {
      raw = await fs.readFile(logPath, 'utf-8');
    } catch {
      return [];
    }

    type LogEntry = { type: string; message?: { content?: Array<Record<string, unknown>> } };
    const entries: LogEntry[] = [];
    const toolResults = new Map<string, string>();

    for (const line of raw.split('\n')) {
      if (!line) continue;
      let entry: LogEntry;
      try { entry = JSON.parse(line); } catch { continue; }
      entries.push(entry);

      if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
        for (const block of entry.message!.content!) {
          if (block['type'] === 'tool_result' && block['tool_use_id'] && block['content'] != null) {
            toolResults.set(block['tool_use_id'] as string, extractMcpResultText(block['content']));
          }
        }
      }
    }

    const blocks: HaikuDisplayBlock[] = [];

    for (const entry of entries) {
      if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;

      for (const block of entry.message!.content!) {
        if (block['type'] === 'thinking' && block['thinking']) {
          blocks.push({ type: 'thinking', content: block['thinking'] as string });
        } else if (block['type'] === 'text' && block['text']) {
          blocks.push({ type: 'text', content: block['text'] as string });
        } else if (block['type'] === 'tool_use' && block['name']) {
          const toolUseId = block['id'] as string;
          blocks.push({
            type: 'tool',
            content: '',
            toolName: (block['name'] as string).replace('mcp__damocles-context__', ''),
            toolInput: block['input'] ? JSON.stringify(block['input']) : '',
            toolResult: toolResults.get(toolUseId) ?? '',
          });
        }
      }
    }

    return blocks;
  }

  private closeDb(): void {
    if (this.contextDb) {
      try { this.contextDb.close(); } catch { /* ignore */ }
      this.contextDb = null;
    }
  }

  private fireHaikuWithMcp(): void {
    if (!this.contextDb) return;

    const promptIndex = this._promptIndex;
    const userPrompt = this._lastUserPrompt;
    const assistantText = this.assistantTextBuffer;

    this._haikuProcessing = true;
    this.onHaikuStreamEvent?.({ type: 'haikuObservationStart', promptIndex });

    this.runHaikuWithMcp(promptIndex, userPrompt, assistantText).catch(err => {
      if (err?.name !== 'AbortError') {
        log('[ContextDistillation] Haiku MCP call failed: %O', err);
      }
    }).finally(() => {
      this._haikuProcessing = false;
      this.currentAbort = null;
      this.resolveDistillWaiters();
    });
  }

  private async runHaikuWithMcp(
    promptIndex: number,
    userPrompt: string,
    assistantText: string,
  ): Promise<void> {
    const db = this.contextDb;
    if (!db) return;

    const modules = this.loadMcpModules();
    if (!modules) return;

    const { createSdkMcpServer, tool, z, query } = modules;

    const mcpServer = createContextMcpServer(
      db, this._persistenceSessionId, promptIndex,
      createSdkMcpServer, tool, z,
    );

    const prompt = buildHaikuPrompt(userPrompt, assistantText);

    this.currentAbort = new AbortController();
    const abortController = new AbortController();
    const signal = this.currentAbort.signal;

    const onAbort = () => abortController.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      log('[ContextDistillation] Haiku MCP call timed out after %dms', HAIKU_TIMEOUT_MS);
      abortController.abort();
    }, HAIKU_TIMEOUT_MS);

    try {
      const options = {
        model: this.config.observerModel,
        cwd: this.cwd,
        systemPrompt: HAIKU_CONTEXT_SYSTEM_PROMPT,
        tools: [] as string[],
        persistSession: false,
        abortController,
        includePartialMessages: true,
        mcpServers: { 'damocles-context': mcpServer },
        canUseTool: async (_name: string, input: Record<string, unknown>) =>
          ({ behavior: 'allow' as const, updatedInput: input }),
      };

      const generator = query({ prompt, options } as Parameters<typeof query>[0]);
      let accumulatedText = '';
      let inToolUse = false;

      const logSessionId = this._persistenceSessionId;
      const logDir = path.join(CONTEXT_DIR, 'haiku', logSessionId, `prompt-${promptIndex}`);
      const dirReady = fs.mkdir(logDir, { recursive: true }).catch(() => {});

      let logBlocks: unknown[] = [];
      let logInputAcc = '';
      let logMsgId = '';
      let logModel = '';
      let logStopReason: string | null = null;

      const flushAssistantLog = (): void => {
        if (logBlocks.length === 0) return;
        const entry = {
          type: 'assistant',
          sessionId: logSessionId,
          cwd: this.cwd,
          message: {
            id: logMsgId,
            model: logModel,
            type: 'message',
            role: 'assistant',
            content: logBlocks,
            stop_reason: logStopReason ?? 'end_turn',
          },
          uuid: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
        };
        dirReady.then(() => this.appendToHaikuLog(logDir, entry)).catch(() => {});
        logBlocks = [];
        logInputAcc = '';
        logStopReason = null;
      };

      for await (const event of generator) {
        if (signal.aborted) return;

        const msg = event as {
          type: string;
          event?: {
            type: string;
            message?: { id?: string; model?: string };
            content_block?: { type: string; id?: string; name?: string };
            delta?: { type: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
          };
          message?: {
            role?: string;
            content?: Array<{ type: string; content?: unknown }>;
          };
        };

        if (msg.type === 'stream_event' && msg.event) {
          const evt = msg.event;

          if (evt.type === 'message_start') {
            logMsgId = evt.message?.id ?? `msg_haiku_${promptIndex}`;
            logModel = evt.message?.model ?? this.config.observerModel;
          } else if (evt.type === 'content_block_start') {
            if (evt.content_block?.type === 'tool_use' && evt.content_block.name) {
              inToolUse = true;
              logBlocks.push({ type: 'tool_use', id: evt.content_block.id ?? '', name: evt.content_block.name, input: {} });
              logInputAcc = '';
              const shortName = evt.content_block.name.replace('mcp__damocles-context__', '');
              accumulatedText += `\n[${shortName}] `;
              this.onHaikuStreamEvent?.({ type: 'haikuStreamDelta', promptIndex, deltaType: 'tool_start', delta: shortName });
            } else if (evt.content_block?.type === 'text') {
              logBlocks.push({ type: 'text', text: '' });
            } else if (evt.content_block?.type === 'thinking') {
              logBlocks.push({ type: 'thinking', thinking: '' });
            }
          } else if (evt.type === 'content_block_delta' && evt.delta) {
            if (evt.delta.type === 'text_delta' && evt.delta.text) {
              accumulatedText += evt.delta.text;
              const last = logBlocks[logBlocks.length - 1] as Record<string, unknown> | undefined;
              if (last?.['type'] === 'text') last['text'] = (last['text'] as string) + evt.delta.text;
              this.onHaikuStreamEvent?.({ type: 'haikuStreamDelta', promptIndex, deltaType: 'text', delta: evt.delta.text });
            } else if (evt.delta.type === 'thinking_delta' && evt.delta.thinking) {
              const last = logBlocks[logBlocks.length - 1] as Record<string, unknown> | undefined;
              if (last?.['type'] === 'thinking') last['thinking'] = (last['thinking'] as string) + evt.delta.thinking;
              this.onHaikuStreamEvent?.({ type: 'haikuStreamDelta', promptIndex, deltaType: 'thinking', delta: evt.delta.thinking });
            } else if (evt.delta.type === 'input_json_delta' && evt.delta.partial_json) {
              accumulatedText += evt.delta.partial_json;
              logInputAcc += evt.delta.partial_json;
              this.onHaikuStreamEvent?.({ type: 'haikuStreamDelta', promptIndex, deltaType: 'tool_input', delta: evt.delta.partial_json });
            }
          } else if (evt.type === 'content_block_stop') {
            if (logInputAcc) {
              const last = logBlocks[logBlocks.length - 1] as Record<string, unknown> | undefined;
              if (last?.['type'] === 'tool_use') {
                try { last['input'] = JSON.parse(logInputAcc); } catch { last['input'] = logInputAcc; }
              }
              logInputAcc = '';
            }
            if (inToolUse) {
              inToolUse = false;
              accumulatedText += '\n';
            }
          } else if (evt.type === 'message_delta') {
            logStopReason = evt.delta?.stop_reason ?? null;
          } else if (evt.type === 'message_stop') {
            flushAssistantLog();
          }
        } else if (msg.type === 'user') {
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'tool_result' && block.content != null) {
              const text = extractMcpResultText(block.content);
              accumulatedText += `> ${text}\n`;
              this.onHaikuStreamEvent?.({ type: 'haikuStreamDelta', promptIndex, deltaType: 'tool_result', delta: text });
            }
          }
          const userEntry = {
            type: 'user',
            sessionId: logSessionId,
            cwd: this.cwd,
            message: msg.message,
            uuid: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
          };
          dirReady.then(() => this.appendToHaikuLog(logDir, userEntry)).catch(() => {});
        }
      }

      flushAssistantLog();

      const summaryEntry = getEntriesForPrompt(db, this._persistenceSessionId, promptIndex)
        .find(e => e.entry_type === 'summary');
      const contextSnapshot = summaryEntry?.description ?? accumulatedText;

      log('[ContextDistillation] Haiku MCP complete for prompt %d (%d chars output, summary=%s)',
        promptIndex, accumulatedText.length, summaryEntry ? 'yes' : 'no');

      this.onHaikuStreamEvent?.({
        type: 'haikuObservationComplete',
        promptIndex,
        thinking: '',
        text: accumulatedText,
        contextSnapshot,
      });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private loadMcpModules(): { createSdkMcpServer: SdkCreateServer; tool: SdkTool; z: ZodZ; query: SdkQuery } | null {
    if (this.mcpModules) return this.mcpModules;

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sdk = require('@anthropic-ai/claude-agent-sdk') as typeof import('@anthropic-ai/claude-agent-sdk');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const zod = require('zod') as typeof import('zod');
      this.mcpModules = {
        createSdkMcpServer: sdk.createSdkMcpServer,
        tool: sdk.tool,
        z: zod.z,
        query: sdk.query,
      };
      return this.mcpModules;
    } catch (err) {
      log('[ContextDistillation] Failed to load SDK/Zod modules: %O', err);
      return null;
    }
  }

  private flushRemainingSubagentResponses(): void {
    for (const [toolUseId, subState] of this._activeSubagents.entries()) {
      if (!subState.pendingFinalResponse) continue;

      subState.writeQueue = subState.writeQueue
        .then(async () => {
          if (!subState.pendingFinalResponse) return;
          if (!subState.initFailed) {
            await this.writeSubagentFinalResponse(subState);
          }
          this.onSubagentDataReady?.(toolUseId, subState.agentId);
          this._activeSubagents.delete(toolUseId);
        })
        .catch(err => log('[ContextDistillation] Failed to write fallback subagent response:', err));
    }
  }

  private async writeSubagentFinalResponse(subState: SubagentPersistState): Promise<void> {
    const content = this.parseSubagentFinalContent(subState.pendingFinalResponse!);
    delete subState.pendingFinalResponse;
    if (content.length === 0) return;

    const model = subState.model ?? 'unknown';
    const messageId = `msg_final_${subState.agentId}`;
    const entry = this.buildAgentAssistantEntry(
      { messageId, model, stopReason: 'end_turn' },
      content
    );

    await persistSubagentEntry(this.cwd, this._persistenceSessionId, subState.agentId, entry);
  }

  private parseSubagentFinalContent(result: string): ContentBlock[] {
    const texts = extractTaskResultTexts(result);
    if (!texts) return [];
    return texts.map(text => ({ type: 'text' as const, text }));
  }

  private buildAgentAssistantEntry(
    data: { messageId: string; model: string; stopReason: string | null },
    content: ContentBlock[]
  ): Record<string, unknown> {
    return {
      type: 'assistant',
      sessionId: this._persistenceSessionId,
      cwd: this.cwd,
      message: {
        id: data.messageId,
        model: data.model,
        type: 'message',
        role: 'assistant',
        content: content.map(block => {
          switch (block.type) {
            case 'thinking': return { type: 'thinking', thinking: block.thinking };
            case 'text': return { type: 'text', text: block.text };
            case 'tool_use': return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
            default: return block;
          }
        }),
        stop_reason: data.stopReason ?? 'end_turn',
      },
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };
  }

  private buildAgentToolResultEntry(toolUseId: string, content: string): Record<string, unknown> {
    return {
      type: 'user',
      sessionId: this._persistenceSessionId,
      cwd: this.cwd,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
      },
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };
  }
}
