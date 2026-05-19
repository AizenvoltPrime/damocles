import * as fs from 'fs/promises';
import * as path from 'path';
import { log } from '../logger';
import { loadSdkQuery } from '../shared/sdk-loader';
import type { SdkQuery } from '../shared/sdk-loader';
import { buildSdkEnv } from '../auth/sdk-env';
import type { ExploreRunConfig, ExploreResult } from './types';
import type { HistoryAgentMessage } from '../../shared/types/content';

const EXPLORE_SYSTEM_PROMPT = `You are a code exploration agent. Your job is to investigate codebases and report findings.

Rules:
- You can ONLY read files, search, and query the knowledge graph. You cannot edit, write, or run commands.
- Be thorough but concise. Report file paths, line numbers, and relevant code snippets.
- When searching, try multiple approaches: file patterns (Glob), content search (Grep), and structural queries (compass_search, compass_query).
- Summarize your findings at the end with a clear, structured report.`;

const EXPLORE_BUILTIN_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep'];

interface RawEntry {
  type: 'assistant' | 'user';
  message: { id?: string; content: unknown[]; usage?: Record<string, number> };
}

class LiveMessageBuilder {
  private messages: HistoryAgentMessage[] = [];
  private idToIndex = new Map<string, number>();
  private toolResults = new Map<string, string>();
  private toolUseIndex = new Map<string, { messageIndex: number; blockIndex: number }>();

  addEntry(entry: RawEntry): void {
    if (entry.type === 'user') {
      this.absorbUserEntry(entry);
      return;
    }
    this.absorbAssistantEntry(entry);
  }

  snapshot(): HistoryAgentMessage[] {
    return this.messages.map(msg => ({
      role: msg.role,
      contentBlocks: msg.contentBlocks.map(block => ({ ...block })),
    }));
  }

  private absorbUserEntry(entry: RawEntry): void {
    for (const block of entry.message.content) {
      const b = block as Record<string, unknown>;
      if (b['type'] !== 'tool_result' || typeof b['tool_use_id'] !== 'string') continue;
      const id = b['tool_use_id'] as string;
      const content = b['content'];
      const result = typeof content === 'string' ? content : JSON.stringify(content);
      this.toolResults.set(id, result);
      this.patchToolUse(id, result);
    }
  }

  private patchToolUse(id: string, result: string): void {
    const location = this.toolUseIndex.get(id);
    if (!location) return;
    const message = this.messages[location.messageIndex];
    if (!message) return;
    const block = message.contentBlocks[location.blockIndex];
    if (!block || block.type !== 'tool_use') return;
    (block as { result?: string }).result = result;
  }

  private absorbAssistantEntry(entry: RawEntry): void {
    const messageId = entry.message.id;
    let target: HistoryAgentMessage;
    let messageIndex: number;
    if (messageId && this.idToIndex.has(messageId)) {
      messageIndex = this.idToIndex.get(messageId)!;
      target = this.messages[messageIndex]!;
    } else {
      target = { role: 'assistant', contentBlocks: [] };
      messageIndex = this.messages.length;
      if (messageId) this.idToIndex.set(messageId, messageIndex);
      this.messages.push(target);
    }

    for (const block of entry.message.content) {
      const b = block as Record<string, unknown>;
      if (b['type'] === 'thinking' && typeof b['thinking'] === 'string') {
        target.contentBlocks.push({ type: 'thinking', thinking: b['thinking'] });
      } else if (b['type'] === 'text' && typeof b['text'] === 'string') {
        target.contentBlocks.push({ type: 'text', text: b['text'] });
      } else if (b['type'] === 'tool_use' && typeof b['id'] === 'string') {
        const id = b['id'] as string;
        const toolResult = this.toolResults.get(id);
        const blockIndex = target.contentBlocks.length;
        target.contentBlocks.push({
          type: 'tool_use',
          id,
          name: (b['name'] as string) ?? '',
          input: (b['input'] as Record<string, unknown>) ?? {},
          ...(toolResult !== undefined ? { result: toolResult } : {}),
        });
        this.toolUseIndex.set(id, { messageIndex, blockIndex });
      }
    }
  }
}

export class ExploreAgentRunner {
  private sdkQuery: SdkQuery | null = null;

  async run(config: ExploreRunConfig): Promise<ExploreResult> {
    if (!this.sdkQuery) {
      this.sdkQuery = loadSdkQuery();
    }
    if (!this.sdkQuery) {
      return { summary: 'SDK query module failed to load', toolCount: 0, elapsed: 0, status: 'failed', messages: [] };
    }

    return this.runAgent(config, this.sdkQuery);
  }

  private async runAgent(config: ExploreRunConfig, queryFn: SdkQuery): Promise<ExploreResult> {
    const startTime = Date.now();
    let toolCount = 0;
    let finalResponse = '';
    const builder = new LiveMessageBuilder();

    const agentAbort = new AbortController();
    const onParentAbort = () => agentAbort.abort();
    config.abortSignal.addEventListener('abort', onParentAbort, { once: true });

    if (config.abortSignal.aborted) {
      config.abortSignal.removeEventListener('abort', onParentAbort);
      return { summary: 'Cancelled before start', toolCount: 0, elapsed: 0, status: 'failed', messages: [] };
    }

    const jsonlPath = config.sessionDir
      ? path.join(config.sessionDir, `${config.toolUseId}.jsonl`)
      : null;
    if (jsonlPath) {
      await fs.mkdir(path.dirname(jsonlPath), { recursive: true });
    }

    const appendEntry = (entry: unknown): Promise<void> => {
      if (!jsonlPath) return Promise.resolve();
      return fs.appendFile(jsonlPath, JSON.stringify(entry) + '\n').catch(err => {
        log('[ExploreAgentRunner] Failed to write JSONL: %O', err);
      });
    };

    const emitLiveMessages = (): void => {
      config.onMessage({
        type: 'exploreMessagesUpdate',
        toolUseId: config.toolUseId,
        messages: builder.snapshot(),
      });
    };

    const env: Record<string, string> = {
      ...buildSdkEnv(),
      ANTHROPIC_BASE_URL: config.envOverrides.baseUrl,
      ANTHROPIC_AUTH_TOKEN: config.envOverrides.bearer,
    };

    const options: Record<string, unknown> = {
      cwd: config.cwd,
      systemPrompt: EXPLORE_SYSTEM_PROMPT,
      persistSession: false,
      includePartialMessages: true,
      tools: [...EXPLORE_BUILTIN_TOOLS],
      abortController: agentAbort,
      canUseTool: async (_toolName: string, input: Record<string, unknown>) => ({
        behavior: 'allow' as const,
        updatedInput: input,
      }),
      env,
      stderr: (data: string) => log('[ExploreAgentRunner] CLI stderr: %s', data.trim()),
      ...(config.compassMcpServer ? { mcpServers: { 'damocles-compass': config.compassMcpServer } } : {}),
    };

    try {
      log('[ExploreAgentRunner] Starting explore agent');

      const generator = queryFn({
        prompt: config.prompt,
        options,
      } as Parameters<SdkQuery>[0]);

      const firedToolUseIds = new Set<string>();

      for await (const event of generator) {
        if (config.abortSignal.aborted) break;

        const msg = event as Record<string, unknown>;
        const msgType = msg['type'] as string;

        if (msgType === 'stream_event') {
          const streamEvent = msg['event'] as Record<string, unknown> | undefined;
          if (!streamEvent) continue;
          const eventType = streamEvent['type'] as string;

          if (eventType === 'content_block_start') {
            const block = streamEvent['content_block'] as Record<string, unknown> | undefined;
            if (block?.['type'] === 'tool_use' && typeof block['id'] === 'string' && typeof block['name'] === 'string') {
              const innerToolUseId = block['id'] as string;
              const toolName = block['name'] as string;
              if (!firedToolUseIds.has(innerToolUseId)) {
                firedToolUseIds.add(innerToolUseId);
                toolCount++;
                config.onMessage({
                  type: 'exploreToolCall',
                  toolUseId: config.toolUseId,
                  innerToolUseId,
                  toolName,
                  toolInput: (block['input'] as Record<string, unknown>) ?? {},
                });
              }
            }
          } else if (eventType === 'content_block_delta') {
            const delta = streamEvent['delta'] as Record<string, unknown> | undefined;
            if (delta?.['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') {
              config.onMessage({
                type: 'exploreDelta',
                toolUseId: config.toolUseId,
                deltaType: 'thinking',
                text: delta['thinking'] as string,
              });
            } else if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string') {
              config.onMessage({
                type: 'exploreDelta',
                toolUseId: config.toolUseId,
                deltaType: 'text',
                text: delta['text'] as string,
              });
            }
          }
        } else if (msgType === 'assistant') {
          const message = msg['message'] as { id?: string; content?: unknown[]; usage?: Record<string, number> } | undefined;
          if (message?.content) {
            for (const block of message.content) {
              const b = block as { type?: string; text?: string; name?: string; id?: string; input?: Record<string, unknown> };
              if (b.type === 'text' && b.text) finalResponse = b.text;
              if (b.type === 'tool_use' && b.name && b.id && !firedToolUseIds.has(b.id)) {
                firedToolUseIds.add(b.id);
                toolCount++;
                config.onMessage({
                  type: 'exploreToolCall',
                  toolUseId: config.toolUseId,
                  innerToolUseId: b.id,
                  toolName: b.name,
                  toolInput: b.input ?? {},
                });
              }
            }

            const entry: RawEntry = {
              type: 'assistant',
              message: { ...(message.id ? { id: message.id } : {}), content: message.content, ...(message.usage ? { usage: message.usage } : {}) },
            };
            builder.addEntry(entry);
            await appendEntry(entry);
            emitLiveMessages();
          }
        } else if (msgType === 'user') {
          const message = msg['message'] as { content?: unknown[] } | undefined;
          if (message?.content && Array.isArray(message.content)) {
            for (const block of message.content) {
              const b = block as Record<string, unknown>;
              if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
                config.onMessage({
                  type: 'exploreToolResult',
                  toolUseId: config.toolUseId,
                  innerToolUseId: b['tool_use_id'] as string,
                  result: typeof b['content'] === 'string'
                    ? (b['content'] as string).slice(0, 500)
                    : JSON.stringify(b['content']).slice(0, 500),
                  isError: b['is_error'] === true,
                });
              }
            }

            const entry: RawEntry = { type: 'user', message: { content: message.content } };
            builder.addEntry(entry);
            await appendEntry(entry);
            emitLiveMessages();
          }
        }
      }
    } catch (err) {
      const elapsed = Date.now() - startTime;
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? err.stack : '';
      log('[ExploreAgentRunner] Caught error: %s\n%s', errMsg, errStack);
      return {
        summary: `Explore agent failed: ${errMsg}`,
        toolCount,
        elapsed,
        status: 'failed',
        messages: builder.snapshot(),
      };
    } finally {
      config.abortSignal.removeEventListener('abort', onParentAbort);
    }

    log('[ExploreAgentRunner] Completed: toolCount=%d, aborted=%s, hasResponse=%s', toolCount, config.abortSignal.aborted, !!finalResponse);
    const elapsed = Date.now() - startTime;
    return {
      summary: finalResponse || 'No response generated',
      toolCount,
      elapsed,
      status: config.abortSignal.aborted ? 'failed' : 'completed',
      messages: builder.snapshot(),
    };
  }
}
