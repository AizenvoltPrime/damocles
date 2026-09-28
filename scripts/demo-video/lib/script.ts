import type { ExtensionToWebviewMessage } from '../../../src/shared/types/messages.ts';
import type { ContentBlock } from '../../../src/shared/types/content.ts';
import type { ExtensionSettings, ModelInfo, PermissionMode } from '../../../src/shared/types/settings.ts';
import type { AgentUsageTotals } from '../../../src/shared/usage-accounting.ts';
import type { Stage } from './stage.ts';

export const SID = '0197a3c2-5e1f-7b2a-9c44-2f1d8e6b0a11';
export const MODEL = 'claude-opus-5-5';
export const WORKSPACE = 'c:/dev/acme-api';

const MODELS: ModelInfo[] = [
  { value: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Most capable model for agentic work', contextWindow: 1_000_000, supportsAdaptiveThinking: true, supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'], defaultEffort: 'high', thinkingAlwaysOn: true },
  { value: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'Best balance of speed and capability', contextWindow: 1_000_000, supportsAdaptiveThinking: true, supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] },
  { value: 'gpt-6-sol', displayName: 'GPT-6 Sol', description: 'OpenAI Codex', contextWindow: 272_000, supportsAdaptiveThinking: true, supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
];

export function settings(permissionMode: PermissionMode = 'default'): ExtensionSettings {
  return {
    maxTurns: 100, maxBudgetUsd: null, taskBudget: null, permissionMode, defaultPermissionMode: 'default',
    enableFileCheckpointing: true, sandbox: { enabled: false }, autoCompact: { enabled: false, triggerPercent: 80 },
    cacheWarming: 'off', dangerouslySkipPermissions: false, defaultDangerouslySkipPermissions: false,
    ideContextEnabled: true, pinnedHeaderHidden: false,
    team: { leadModel: '', leadEffort: null, implementorModel: '', implementorEffort: null, reviewerModel: '', reviewerEffort: null },
  };
}

/** What the extension posts after `ready`, in its order. */
export function bootMessages(permissionMode: PermissionMode = 'default'): ExtensionToWebviewMessage[] {
  const folderKey = 'file:///c%3A/dev/acme-api';
  return [
    { type: 'sessionStateChanged', state: 'idle', sessionId: '' },
    { type: 'settingsUpdate', settings: settings(permissionMode) },
    { type: 'mcpConfigUpdate', servers: [], configErrors: [], localMcpUnignored: false },
    { type: 'modelUpdate', activeModel: MODEL, defaultModel: MODEL, contextWindowSize: 1_000_000 },
    { type: 'panelThinkingUpdate', panel: { thinkingDisabled: false, effort: 'high', maxThinkingTokens: null }, panelModel: MODEL, defaults: { thinkingDisabled: false, effort: 'high', maxThinkingTokens: null }, defaultsModel: MODEL },
    { type: 'languageChange', locale: 'en' },
    { type: 'workspaceFolderUpdate', folders: [{ key: folderKey, name: 'acme-api', label: 'acme-api', path: 'c:\\dev\\acme-api' }], panelFolderKey: folderKey, defaultFolderKey: folderKey },
    { type: 'storedSessions', sessions: [], hasMore: false, nextOffset: 0, isFirstPage: true },
    { type: 'promptHistory', history: [], hasMore: false },
    { type: 'sessionStarted', sessionId: SID },
    { type: 'accountInfo', data: { model: MODEL, subscriptionType: 'allowance', dollarBilled: false } },
    { type: 'availableModels', models: MODELS },
  ];
}

const words = (text: string) => text.match(/\S+\s*|\s+/g) ?? [];

/**
 * Drives one conversation the way `pi-stream-adapter.ts` reports it: per assistant message, cumulative
 * `partial` frames, a `toolStreaming` per tool call with the ordered blocks so far, then the sealed `assistant`.
 */
export function conversation(stage: Stage, opts: { parentToolUseId?: string; messagePrefix?: string } = {}) {
  let turn = 0;
  let seq = 0;
  let messageId = '';
  let streamed = '';
  let committed = 0;
  let thinking = '';
  let blocks: ContentBlock[] = [];
  let usage: AgentUsageTotals = { totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
  const checkpoints: string[] = [];
  const parent = opts.parentToolUseId ? { parentToolUseId: opts.parentToolUseId } : {};
  const partial = (extra: { streamingText?: string; streamingThinking?: string; isThinking?: boolean; thinkingDuration?: number }): ExtensionToWebviewMessage =>
    ({ type: 'partial', data: { type: 'partial', content: [], session_id: SID, messageId, ...extra }, ...parent });

  const api = {
    /** Types the prompt into the real composer, sends it, and echoes it back as the extension does. */
    async prompt(text: string, { typeDelayMs = 28 } = {}): Promise<string> {
      const input = stage.page.locator('textarea').first();
      await stage.typeInto(input, text, { delayMs: typeDelayMs });
      await stage.pause(250);
      const sent = stage.waitForPost('sendMessage');
      await stage.page.keyboard.press('Enter');
      await sent;
      turn += 1;
      seq = 0;
      const correlationId = `corr-${turn}`;
      const entryId = `e${turn}f3a9c1`;
      await stage.send(
        { type: 'userMessage', content: text, correlationId, promptIndex: turn - 1 },
        { type: 'processing', isProcessing: true },
        { type: 'sessionStateChanged', state: 'running', sessionId: SID },
        { type: 'userMessageIdAssigned', sdkMessageId: entryId, correlationId },
      );
      checkpoints.push(entryId);
      return entryId;
    },

    startMessage(): string {
      seq += 1;
      messageId = opts.messagePrefix ? `${opts.messagePrefix}:a:${seq}` : `${SID}:a:${turn}:${seq}`;
      streamed = '';
      committed = 0;
      thinking = '';
      blocks = [];
      return messageId;
    },

    async think(text: string, seconds: number, charsPerSecond = 260): Promise<void> {
      for (const w of words(text)) {
        thinking += w;
        await stage.send(partial({ streamingThinking: thinking, isThinking: true }));
        await stage.pause((w.length / charsPerSecond) * 1000);
      }
      await stage.send(partial({ streamingThinking: thinking, isThinking: false, thinkingDuration: seconds }));
    },

    async say(text: string, charsPerSecond = 140): Promise<void> {
      const chunks = words(text);
      for (let i = 0; i < chunks.length; i += 2) {
        const chunk = chunks.slice(i, i + 2).join('');
        streamed += chunk;
        await stage.send(partial({ streamingText: streamed, isThinking: false }));
        await stage.pause((chunk.length / charsPerSecond) * 1000);
      }
    },

    async callTool(id: string, name: string, input: Record<string, unknown>): Promise<void> {
      const uncommitted = streamed.slice(committed);
      if (uncommitted.trim()) blocks.push({ type: 'text', text: uncommitted });
      committed = streamed.length;
      blocks.push({ type: 'tool_use', id, name, input });
      await stage.send({ type: 'toolStreaming', messageId, tool: { id, name, input }, contentBlocks: [...blocks], ...parent });
    },

    async seal(model = MODEL): Promise<void> {
      const tail = streamed.slice(committed);
      const content: ContentBlock[] = [
        ...(thinking ? [{ type: 'thinking' as const, thinking }] : []),
        ...blocks,
        ...(tail.trim() ? [{ type: 'text' as const, text: tail }] : []),
      ];
      await stage.send({ type: 'assistant', data: { type: 'assistant', message: { id: messageId, role: 'assistant', content, model, stop_reason: null }, session_id: SID }, ...parent });
    },

    async runTool(id: string, name: string, input: Record<string, unknown>, result: string, { durationMs = 300, progress = [] as string[], stepMs = 350 } = {}): Promise<void> {
      await stage.send({ type: 'toolPending', toolUseId: id, toolName: name, input, parentToolUseId: opts.parentToolUseId ?? null });
      let elapsed = 0;
      for (const output of progress) {
        await stage.pause(stepMs);
        elapsed += stepMs / 1000;
        await stage.send({ type: 'toolProgress', toolUseId: id, toolName: name, parentToolUseId: opts.parentToolUseId ?? null, elapsedTimeSeconds: elapsed, output, outputTruncated: false });
      }
      if (!progress.length) await stage.pause(Math.min(durationMs, 600));
      await stage.send({ type: 'toolCompleted', toolUseId: id, toolName: name, result, durationMs, ...parent });
    },

    /** Adds one assistant message's spend, as the status bar reports it after each `message_end`. */
    async bill(delta: Partial<AgentUsageTotals>): Promise<void> {
      usage = {
        totalInputTokens: usage.totalInputTokens + (delta.totalInputTokens ?? 0),
        totalOutputTokens: usage.totalOutputTokens + (delta.totalOutputTokens ?? 0),
        cacheReadTokens: usage.cacheReadTokens + (delta.cacheReadTokens ?? 0),
        cacheCreationTokens: usage.cacheCreationTokens + (delta.cacheCreationTokens ?? 0),
        costUsd: usage.costUsd + (delta.costUsd ?? 0),
      };
      await stage.send(
        { type: 'tokenUsageUpdate', inputTokens: delta.totalInputTokens ?? 0, cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: delta.cacheCreationTokens ?? 0 },
        { type: 'sessionUsage', usage, numTurns: turn },
      );
    },

    async endTurn(lastAssistantMessage: string): Promise<void> {
      await stage.send(
        { type: 'sessionUsage', usage, numTurns: turn },
        { type: 'done', data: { type: 'result', session_id: SID, is_done: true, stop_reason: null } },
        { type: 'processing', isProcessing: false },
        { type: 'sessionStateChanged', state: 'idle', sessionId: SID },
        { type: 'stopInfo', lastAssistantMessage },
        { type: 'checkpointInfo', userMessageIds: [...checkpoints] },
      );
    },
  };
  return api;
}

export type Conversation = ReturnType<typeof conversation>;
