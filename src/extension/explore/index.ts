import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { log } from '../logger';
import { ExploreAgentRunner } from './agent-runner';
import { ExploreProxy } from './proxy-server';
import type { ExploreResult, ExploreMetadataFile, ExploreProvider, ExploreThirdPartyProvider } from './types';
import { DEFAULT_EXPLORE_MODELS, EXPLORE_SECRET_KEYS, EXPLORE_THIRD_PARTY_PROVIDERS } from './types';
import { getExploreSessionDir } from '../auth/paths';
import type { HistoryAgentMessage } from '../../shared/types/content';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';

export type { ExploreResult } from './types';

export interface ExploreProviderConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export class ExploreService {
  private static readonly OPENROUTER_BASE_URL = 'https://openrouter.ai/api';
  private static readonly GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
  private static readonly STEPFUN_BASE_URL = 'https://api.stepfun.ai/step_plan';

  private cwd: string;
  private onMessage: (msg: ExtensionToWebviewMessage) => void;
  private getCompassMcpServer: () => Record<string, unknown> | null;
  private getSessionId: () => string | null;
  private secrets: vscode.SecretStorage | null;
  private runner = new ExploreAgentRunner();
  private metadataCache: ExploreMetadataFile = {};

  constructor(config: {
    cwd: string;
    onMessage: (msg: ExtensionToWebviewMessage) => void;
    getCompassMcpServer: () => Record<string, unknown> | null;
    getSessionId: () => string | null;
    secrets?: vscode.SecretStorage;
  }) {
    this.cwd = config.cwd;
    this.onMessage = config.onMessage;
    this.getCompassMcpServer = config.getCompassMcpServer;
    this.getSessionId = config.getSessionId;
    this.secrets = config.secrets ?? null;
  }

  dispose(): void {}

  get isEnabled(): boolean {
    return vscode.workspace.getConfiguration('damocles.explore').get<boolean>('enabled', false);
  }

  private getProvider(): ExploreProvider {
    return vscode.workspace.getConfiguration('damocles.explore').get<string>('provider', 'openrouter') as ExploreProvider;
  }

  private static readonly ENV_KEY_FALLBACK: Record<ExploreThirdPartyProvider, string> = {
    openrouter: 'OPENROUTER_API_KEY',
    gemini: 'GEMINI_API_KEY',
    stepfun: 'STEPFUN_API_KEY',
  };

  private static isThirdPartyProvider(provider: ExploreProvider): provider is ExploreThirdPartyProvider {
    return (EXPLORE_THIRD_PARTY_PROVIDERS as readonly string[]).includes(provider);
  }

  private async getApiKey(): Promise<string | null> {
    const provider = this.getProvider();
    if (!ExploreService.isThirdPartyProvider(provider)) return null;
    if (this.secrets) {
      const stored = await this.secrets.get(EXPLORE_SECRET_KEYS[provider]);
      if (stored) return stored.trim();
    }
    return process.env[ExploreService.ENV_KEY_FALLBACK[provider]]?.trim() ?? null;
  }

  /**
   * Resolve the third-party provider config for a memory sub-call, reading the API key freshly
   * from SecretStorage each call so a key set (or provider switched) after activation is honored.
   */
  async getProviderConfig(): Promise<ExploreProviderConfig | null> {
    const provider = this.getProvider();
    if (!ExploreService.isThirdPartyProvider(provider)) return null;
    const model = this.getModel();
    const baseUrl = this.getBaseUrl();
    const apiKey = await this.getApiKey();
    if (!model || !baseUrl || !apiKey) return null;
    return { provider, model, baseUrl, apiKey };
  }

  private getModel(): string {
    const provider = this.getProvider();
    if (!ExploreService.isThirdPartyProvider(provider)) return '';
    const map = vscode.workspace.getConfiguration('damocles.explore').get<Record<string, string>>('modelByProvider', {});
    const stored = map[provider]?.trim();
    if (stored) return stored;
    return DEFAULT_EXPLORE_MODELS[provider];
  }

  private getBaseUrl(): string {
    const provider = this.getProvider();
    switch (provider) {
      case 'gemini': return ExploreService.GEMINI_BASE_URL;
      case 'stepfun': return ExploreService.STEPFUN_BASE_URL;
      case 'openrouter': return ExploreService.OPENROUTER_BASE_URL;
    }
  }

  async runExploreAgent(
    toolUseId: string,
    input: Record<string, unknown>,
    parentSignal: AbortSignal,
  ): Promise<ExploreResult> {
    const provider = this.getProvider();
    const prompt = (input['prompt'] as string) || '';
    const description = (input['description'] as string) || 'Explore';
    const startTime = Date.now();
    const sessionId = this.getSessionId();
    const compassMcp = this.getCompassMcpServer();
    const sessionDir = sessionId ? getExploreSessionDir(this.cwd, sessionId) : null;

    const apiKey = await this.getApiKey();
    if (!apiKey) {
      if (!ExploreService.isThirdPartyProvider(provider)) {
        return { summary: `Unknown Explore provider: ${provider}`, toolCount: 0, elapsed: 0, status: 'failed', messages: [] };
      }
      const envVar = ExploreService.ENV_KEY_FALLBACK[provider];
      log('[ExploreService] No API key found for provider=%s — run "Damocles: Set Explore API Key" or set %s', provider, envVar);
      return { summary: 'No API key configured for Explore agent', toolCount: 0, elapsed: 0, status: 'failed', messages: [] };
    }

    const model = this.getModel();
    const baseUrl = this.getBaseUrl();

    this.onMessage({
      type: 'exploreStarted',
      toolUseId,
      model,
      prompt,
      description,
      startTime,
    });

    const bearer = crypto.randomBytes(32).toString('hex');
    const proxy = new ExploreProxy({ provider: provider as ExploreThirdPartyProvider, targetBaseUrl: baseUrl, apiKey, model, bearer });
    await proxy.start();
    let result: ExploreResult;
    try {
      result = await this.runner.run({
        toolUseId,
        prompt,
        description,
        cwd: this.cwd,
        abortSignal: parentSignal,
        onMessage: this.onMessage,
        ...(compassMcp ? { compassMcpServer: compassMcp } : {}),
        sessionId,
        sessionDir,
        envOverrides: { baseUrl: proxy.url, bearer },
      });
    } finally {
      proxy.stop();
    }

    return this.finalizeRun(toolUseId, model, description, prompt, startTime, result, sessionId);
  }

  private async finalizeRun(
    toolUseId: string,
    model: string,
    description: string,
    prompt: string,
    startTime: number,
    result: ExploreResult,
    sessionId: string | null,
  ): Promise<ExploreResult> {
    const endTime = Date.now();

    this.onMessage({
      type: 'exploreCompleted',
      toolUseId,
      status: result.status,
      result: result.summary,
      elapsed: result.elapsed,
      toolCount: result.toolCount,
      model,
    });

    if (result.messages.length > 0) {
      this.onMessage({
        type: 'exploreMessagesUpdate',
        toolUseId,
        messages: result.messages,
      });
    }

    this.metadataCache[toolUseId] = {
      model,
      description,
      status: result.status,
      startTime,
      endTime,
      toolCount: result.toolCount,
      prompt,
    };
    await this.persistMetadata(sessionId);

    return result;
  }

  private async persistMetadata(sessionId: string | null): Promise<void> {
    if (!sessionId) return;
    const dir = getExploreSessionDir(this.cwd, sessionId);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify(this.metadataCache, null, 2));
    } catch (err) {
      log('[ExploreService] Failed to persist metadata: %O', err);
    }
  }

  async emitExploreHistory(sessionId: string): Promise<void> {
    const dir = getExploreSessionDir(this.cwd, sessionId);
    let metadata: ExploreMetadataFile;

    try {
      const content = await fs.readFile(path.join(dir, 'metadata.json'), 'utf-8');
      metadata = JSON.parse(content) as ExploreMetadataFile;
    } catch {
      return;
    }

    for (const [toolUseId, entry] of Object.entries(metadata)) {
      this.onMessage({
        type: 'exploreStarted',
        toolUseId,
        model: entry.model,
        prompt: entry.prompt,
        description: entry.description,
        startTime: entry.startTime,
      });
      this.onMessage({
        type: 'exploreCompleted',
        toolUseId,
        status: entry.status,
        result: null,
        elapsed: entry.endTime - entry.startTime,
        toolCount: entry.toolCount,
        model: entry.model,
      });

      const messages = await this.readExploreMessages(dir, toolUseId);
      if (messages.length > 0) {
        this.onMessage({ type: 'exploreMessagesUpdate', toolUseId, messages });
      }
    }
  }

  private async readExploreMessages(dir: string, toolUseId: string): Promise<HistoryAgentMessage[]> {
    try {
      const content = await fs.readFile(path.join(dir, `${toolUseId}.jsonl`), 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const toolResults = new Map<string, string>();
      const entries: Array<{ type: string; message: { id?: string; content: unknown[] } }> = [];

      for (const line of lines) {
        const entry = JSON.parse(line);
        entries.push(entry);
        if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
          for (const block of entry.message.content) {
            const b = block as Record<string, unknown>;
            if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
              const c = b['content'];
              toolResults.set(b['tool_use_id'] as string, typeof c === 'string' ? c : JSON.stringify(c));
            }
          }
        }
      }

      const messages: HistoryAgentMessage[] = [];
      const idToIndex = new Map<string, number>();

      for (const entry of entries) {
        if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;
        const messageId = entry.message.id;
        let target: HistoryAgentMessage;
        if (messageId && idToIndex.has(messageId)) {
          target = messages[idToIndex.get(messageId)!]!;
        } else {
          target = { role: 'assistant', contentBlocks: [] };
          if (messageId) idToIndex.set(messageId, messages.length);
          messages.push(target);
        }
        for (const block of entry.message.content) {
          const b = block as Record<string, unknown>;
          if (b['type'] === 'thinking' && typeof b['thinking'] === 'string') {
            target.contentBlocks.push({ type: 'thinking', thinking: b['thinking'] });
          } else if (b['type'] === 'text' && typeof b['text'] === 'string') {
            target.contentBlocks.push({ type: 'text', text: b['text'] });
          } else if (b['type'] === 'tool_use' && typeof b['id'] === 'string') {
            const toolResult = toolResults.get(b['id'] as string);
            target.contentBlocks.push({
              type: 'tool_use',
              id: b['id'] as string,
              name: (b['name'] as string) ?? '',
              input: (b['input'] as Record<string, unknown>) ?? {},
              ...(toolResult !== undefined ? { result: toolResult } : {}),
            });
          }
        }
      }

      return messages;
    } catch {
      return [];
    }
  }
}
