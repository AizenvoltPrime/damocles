import * as crypto from 'crypto';
import { loadSdkQuery } from '../shared/sdk-loader';
import type { SdkQuery } from '../shared/sdk-loader';
import { buildSdkEnv } from '../auth/sdk-env';
import {
  OpenAIAuthRequiredError,
  buildOpenAIBridgeEnv,
  provisionOpenAIBridge,
  resolveSdkModel,
} from '../openai-bridge';
import type { AgentRunConfig, AgentResult } from './types';
import packageJson from '../../../package.json';

type ContentInput = string | Array<{ type: string; text?: string }>;

type UserMessage = {
  type: 'user';
  message: { role: 'user'; content: ContentInput };
  parent_tool_use_id: null;
};

interface InputController {
  sendMessage: (content: ContentInput) => void;
  close: () => void;
}

const KEEP_ALIVE_TIMEOUT_MS = 120_000;
const MAX_KEEP_ALIVE_CYCLES = 20;

const MAX_BEARER_ROTATION_RETRIES = 2;

export class AgentRunner {
  private sdkQuery: SdkQuery | null = null;

  async startAgent(config: AgentRunConfig): Promise<AgentResult> {
    if (!this.sdkQuery) {
      this.sdkQuery = loadSdkQuery();
    }
    if (!this.sdkQuery) {
      return {
        agentId: config.agentId,
        status: 'failed',
        finalResponse: 'SDK query module failed to load',
        toolCallCount: 0,
        durationMs: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      };
    }

    /**
     * Bearer-rotation outer loop. The bridge fires `onBearersRotated` when
     * `setOpenAIPreferApiKey` toggles mid-team — the in-flight subprocess holds
     * the stale bearer and would 401 on its next upstream call. We capture that
     * signal, abort the SDK, re-provision with fresh credentials, and replay the
     * initial specialization prompt. Cap at MAX_BEARER_ROTATION_RETRIES to bound
     * the recovery surface; beyond that, the agent surfaces a failed status.
     */
    for (let attempt = 0; attempt <= MAX_BEARER_ROTATION_RETRIES; attempt++) {
      const result = await this.runAgent(config, this.sdkQuery, attempt > 0);
      if (result.status !== 'cancelled' || !result.finalResponse?.startsWith('[bearer-rotated]')) {
        return result;
      }
      if (config.abortSignal.aborted) return result;
    }
    return {
      agentId: config.agentId,
      status: 'failed',
      finalResponse: `Agent aborted after ${MAX_BEARER_ROTATION_RETRIES + 1} bearer-rotation attempts`,
      toolCallCount: 0,
      durationMs: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
    };
  }

  private async runAgent(config: AgentRunConfig, queryFn: SdkQuery, isRetry: boolean): Promise<AgentResult> {
    const startTime = Date.now();
    let toolCallCount = 0;
    let finalResponse: string | null = null;
    let status: 'completed' | 'failed' | 'cancelled' = 'completed';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let costUsd = 0;

    const pendingMessages: Array<{ from: string; content: string }> = [];
    let keepAliveCycles = 0;

    let resolveNext: ((content: ContentInput | null) => void) | null = null;
    let messageNotifyResolve: (() => void) | null = null;
    const bufferedMessages: ContentInput[] = [];

    async function* inputStream(): AsyncGenerator<UserMessage, void, unknown> {
      while (true) {
        let content: ContentInput | null;
        if (bufferedMessages.length > 0) {
          content = bufferedMessages.shift()!;
        } else {
          content = await new Promise<ContentInput | null>((resolve) => {
            resolveNext = resolve;
          });
        }
        if (content === null) break;
        yield {
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
        };
      }
    }

    const inputController: InputController = {
      sendMessage: (content: ContentInput) => {
        if (resolveNext) {
          resolveNext(content);
          resolveNext = null;
        } else {
          bufferedMessages.push(content);
        }
      },
      close: () => {
        if (resolveNext) resolveNext(null);
      },
    };

    function waitForMessage(signal: AbortSignal, timeoutMs: number): Promise<'message' | 'timeout' | 'abort'> {
      if (pendingMessages.length > 0) return Promise.resolve('message');
      if (signal.aborted) return Promise.resolve('abort');

      return new Promise((resolve) => {
        let resolved = false;
        const finish = (result: 'message' | 'timeout' | 'abort') => {
          if (resolved) return;
          resolved = true;
          messageNotifyResolve = null;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        };

        messageNotifyResolve = () => finish('message');
        const timer = setTimeout(() => finish('timeout'), timeoutMs);
        const onAbort = () => finish('abort');
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }

    function flushPendingMessages(): string {
      const combined = pendingMessages
        .map(m => `[Message from ${m.from}]: ${m.content}`)
        .join('\n\n');
      pendingMessages.length = 0;
      keepAliveCycles = 0;
      return combined;
    }

    const unsubscribe = config.messageBus.subscribe((msg) => {
      if (msg.to === config.name || msg.to === null) {
        if (msg.from !== config.name) {
          if (config.shouldDeliverMessage && !config.shouldDeliverMessage({ from: msg.from, to: msg.to })) {
            return;
          }
          pendingMessages.push({ from: msg.from, content: msg.content });
          if (messageNotifyResolve) {
            messageNotifyResolve();
            messageNotifyResolve = null;
          }
        }
      }
    });

    const sdkAbortController = new AbortController();
    let bearerRotated = false;

    const onAbort = () => {
      sdkAbortController.abort();
      inputController.close();
    };
    config.abortSignal.addEventListener('abort', onAbort, { once: true });

    const bridgeFactory = config.openaiBridgeDeps?.getBridge;
    const rotationSub = bridgeFactory
      ? bridgeFactory().onBearersRotated(() => {
          bearerRotated = true;
          sdkAbortController.abort();
          inputController.close();
        })
      : null;

    if (config.abortSignal.aborted) {
      config.abortSignal.removeEventListener('abort', onAbort);
      rotationSub?.dispose();
      return { agentId: config.agentId, status: 'cancelled', finalResponse: null, toolCallCount: 0, durationMs: Date.now() - startTime, totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
    }

    const modelInfo = config.resolveModelInfo?.(config.model);
    const bridgeDepsForAgent = config.openaiBridgeDeps && config.bridgePanelId
      ? { ...config.openaiBridgeDeps, panelId: config.bridgePanelId }
      : null;

    let bridgeProvisioning;
    try {
      bridgeProvisioning = await provisionOpenAIBridge(modelInfo, bridgeDepsForAgent);
    } catch (err) {
      unsubscribe();
      config.abortSignal.removeEventListener('abort', onAbort);
      const reason = err instanceof OpenAIAuthRequiredError
        ? `OpenAI auth required for model ${err.modelValue}`
        : (err instanceof Error ? err.message : String(err));
      config.messageBus.broadcast('system', `Agent "${config.name}" failed to start: ${reason}`);
      return {
        agentId: config.agentId,
        status: 'failed',
        finalResponse: reason,
        toolCallCount: 0,
        durationMs: Date.now() - startTime,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      };
    }

    const sdkModel = resolveSdkModel(config.model, modelInfo, false);

    const options: Record<string, unknown> = {
      cwd: config.cwd,
      model: sdkModel,
      systemPrompt: config.systemPrompt,
      persistSession: false,
      tools: { type: 'preset', preset: 'claude_code' },
      skills: 'all',
      mcpServers: {
        'damocles-team': config.mcpServer,
        ...(config.additionalMcpServers ?? {}),
      },
      abortController: sdkAbortController,
      env: {
        ...buildSdkEnv(),
        ...buildOpenAIBridgeEnv(bridgeProvisioning, packageJson.version),
      },
    };

    if (config.canUseTool) {
      options['canUseTool'] = config.canUseTool;
    } else {
      options['permissionMode'] = 'bypassPermissions';
      options['allowDangerouslySkipPermissions'] = true;
    }

    try {
      /** Skip start-of-life broadcast + persistence on bearer-rotation retry to avoid duplicate JSONL entries and UI flicker. The SDK input still gets the specialization since the fresh session has no memory. */
      if (!isRetry) {
        config.onMessage({
          type: 'teamAgentStatusUpdate',
          teamId: config.teamId,
          agentId: config.agentId,
          status: 'running',
        });
      }

      const generator = queryFn({
        prompt: inputStream() as unknown as string,
        options,
      } as Parameters<SdkQuery>[0]);

      inputController.sendMessage(config.specialization);
      if (!isRetry) {
        config.onMessage({
          type: 'teamAgentUserMessage', teamId: config.teamId,
          agentId: config.agentId, content: config.specialization, timestamp: Date.now(),
        });
        config.persistence.appendAgentEntry(config.teamId, config.agentId, {
          type: 'user', agentId: config.agentId,
          content: config.specialization, timestamp: new Date().toISOString(),
        });
      }

      let eventCount = 0;
      for await (const event of generator) {
        eventCount++;
        if (config.abortSignal.aborted) {
          status = 'cancelled';
          break;
        }

        const msg = event as Record<string, unknown>;
        const msgType = msg['type'] as string;

        if (msgType === 'stream_event') {
          const streamEvent = msg['event'] as Record<string, unknown> | undefined;
          if (!streamEvent) continue;
          const eventType = streamEvent['type'] as string;

          if (eventType === 'content_block_delta') {
            const delta = streamEvent['delta'] as Record<string, unknown> | undefined;
            if (delta?.['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') {
              config.onMessage({
                type: 'teamAgentStreamDelta', teamId: config.teamId,
                agentId: config.agentId, deltaType: 'thinking', text: delta['thinking'] as string,
              });
            } else if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string') {
              config.onMessage({
                type: 'teamAgentStreamDelta', teamId: config.teamId,
                agentId: config.agentId, deltaType: 'text', text: delta['text'] as string,
              });
            }
          }
        } else if (msgType === 'assistant') {
          const message = msg['message'] as {
            id?: string;
            content?: unknown[];
            usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
          } | undefined;
          if (message?.content) {
            for (const block of message.content) {
              const b = block as { type?: string; text?: string; name?: string; id?: string };
              if (b.type === 'text' && b.text) {
                finalResponse = b.text;
              }
              if (b.type === 'tool_use' && b.name) {
                toolCallCount++;
                config.onToolCall?.(b.name, toolCallCount);
                config.onMessage({
                  type: 'teamAgentToolCall',
                  teamId: config.teamId,
                  agentId: config.agentId,
                  toolName: b.name,
                  toolInput: {},
                });
              }
            }

            config.onMessage({
              type: 'teamAgentAssistant', teamId: config.teamId,
              agentId: config.agentId,
              messageId: (message.id as string) ?? crypto.randomUUID(),
              content: message.content as import('../../shared/types/team').TeamAgentContentBlock[],
              timestamp: Date.now(),
            });

            config.persistence.appendAgentEntry(config.teamId, config.agentId, {
              type: 'assistant',
              agentId: config.agentId,
              content: message.content,
              timestamp: new Date().toISOString(),
            });
          }
        } else if (msgType === 'user') {
          const message = msg['message'] as { content?: unknown[] } | undefined;
          if (message?.content && Array.isArray(message.content)) {
            for (const block of message.content) {
              const b = block as Record<string, unknown>;
              if (b['type'] === 'tool_result') {
                config.onMessage({
                  type: 'teamAgentToolResult', teamId: config.teamId,
                  agentId: config.agentId,
                  toolUseId: b['tool_use_id'] as string,
                  result: typeof b['content'] === 'string' ? b['content'] : JSON.stringify(b['content']),
                  isError: b['is_error'] === true,
                });
              }
            }
            config.persistence.appendAgentEntry(config.teamId, config.agentId, {
              type: 'user', agentId: config.agentId,
              content: message.content, timestamp: new Date().toISOString(),
            });
          }
        } else if (msgType === 'result') {
          const resultUsage = msg['usage'] as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
          if (resultUsage) {
            totalInputTokens = resultUsage.input_tokens ?? totalInputTokens;
            totalOutputTokens = resultUsage.output_tokens ?? totalOutputTokens;
            cacheReadTokens = resultUsage.cache_read_input_tokens ?? cacheReadTokens;
            cacheCreationTokens = resultUsage.cache_creation_input_tokens ?? cacheCreationTokens;
          }
          const resultCost = msg['total_cost_usd'] as number | undefined;
          if (resultCost !== undefined) {
            costUsd = resultCost;
          }
          if (resultUsage || resultCost !== undefined) {
            config.onUsageUpdate?.({ inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheReadTokens, cacheCreationTokens, costUsd });
          }

          config.onMessage({
            type: 'teamAgentTurnComplete',
            teamId: config.teamId, agentId: config.agentId,
          });

          if (pendingMessages.length > 0) {
            const flushed = flushPendingMessages();
            inputController.sendMessage(flushed);
            config.onMessage({
              type: 'teamAgentUserMessage', teamId: config.teamId,
              agentId: config.agentId, content: flushed, timestamp: Date.now(),
            });
          } else if (config.keepAlive?.() && keepAliveCycles < MAX_KEEP_ALIVE_CYCLES) {
            keepAliveCycles++;
            config.onTurnEnd?.();
            const waitResult = await waitForMessage(config.abortSignal, config.keepAliveTimeoutMs ?? KEEP_ALIVE_TIMEOUT_MS);
            if (waitResult === 'message') {
              config.onKeepAliveResume?.();
              const flushed = flushPendingMessages();
              inputController.sendMessage(flushed);
              config.onMessage({
                type: 'teamAgentUserMessage', teamId: config.teamId,
                agentId: config.agentId, content: flushed, timestamp: Date.now(),
              });
            } else if (waitResult === 'timeout') {
              const keepAliveMsg = config.keepAliveMessage?.()
                ?? '[System: Waiting for team members to complete.]';
              inputController.sendMessage(keepAliveMsg);
              config.onMessage({
                type: 'teamAgentUserMessage', teamId: config.teamId,
                agentId: config.agentId, content: keepAliveMsg, timestamp: Date.now(),
              });
            } else {
              inputController.close();
            }
          } else {
            inputController.close();
          }
        }
      }
    } catch (err) {
      if (config.abortSignal.aborted) {
        status = 'cancelled';
      } else if (bearerRotated) {
        status = 'cancelled';
        finalResponse = '[bearer-rotated] OpenAI bridge auth rotated mid-stream; respawning';
      } else {
        status = 'failed';
        const errMsg = err instanceof Error ? err.message : String(err);
        config.messageBus.broadcast('system', `Agent "${config.name}" failed: ${errMsg}`);
      }
    } finally {
      unsubscribe();
      config.abortSignal.removeEventListener('abort', onAbort);
      rotationSub?.dispose();
    }

    if (bearerRotated && !config.abortSignal.aborted) {
      return { agentId: config.agentId, status: 'cancelled', finalResponse: '[bearer-rotated] OpenAI bridge auth rotated mid-stream; respawning', toolCallCount, durationMs: Date.now() - startTime, totalInputTokens, totalOutputTokens, cacheReadTokens, cacheCreationTokens, costUsd };
    }

    const durationMs = Date.now() - startTime;

    config.onMessage({
      type: 'teamAgentStatusUpdate',
      teamId: config.teamId,
      agentId: config.agentId,
      status,
      ...(status === 'completed'
        ? { progressSummary: `Completed (${toolCallCount} tools, ${Math.round(durationMs / 1000)}s)` }
        : {}),
    });

    return { agentId: config.agentId, status, finalResponse, toolCallCount, durationMs, totalInputTokens, totalOutputTokens, cacheReadTokens, cacheCreationTokens, costUsd };
  }
}
