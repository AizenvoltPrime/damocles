import { log } from '../logger';
import { loadSdkQuery } from '../shared/sdk-loader';
import type { SdkQuery } from '../shared/sdk-loader';
import { DEFAULT_SUBCALL_MODEL, PER_CALL_TIMEOUT_MS } from './types';

const MAX_CONCURRENT_SUBCALLS = 5;

export class SubCallHandler {
  private model: string;
  private cwd: string;
  private sdkQuery: SdkQuery | null = null;
  private activeAborts = new Set<AbortController>();

  constructor(cwd: string, model?: string) {
    this.cwd = cwd;
    this.model = model ?? DEFAULT_SUBCALL_MODEL;
  }

  async query(prompt: string, model?: string): Promise<string> {
    if (!this.sdkQuery) {
      this.sdkQuery = loadSdkQuery();
      if (!this.sdkQuery) {
        log('[SubCallHandler] SDK query unavailable');
        return '[Error: SDK unavailable]';
      }
    }

    const targetModel = model ?? this.model;
    const abortController = new AbortController();
    this.activeAborts.add(abortController);

    try {
      const options = {
        model: targetModel,
        maxTurns: 1,
        systemPrompt: 'You are a helpful assistant. Respond concisely.',
        cwd: this.cwd,
        persistSession: false,
        tools: [] as string[],
        abortController,
      };

      const generator = this.sdkQuery({ prompt, options } as Parameters<SdkQuery>[0]);
      let streamText = '';
      let assistantText = '';

      const consume = async () => {
        for await (const event of generator) {
          if (abortController.signal.aborted) break;

          const msg = event as Record<string, unknown>;
          const msgType = msg['type'] as string;

          if (msgType === 'stream_event') {
            const streamEvent = msg['event'] as { type: string; delta?: { type: string; text?: string } } | undefined;
            if (streamEvent?.type === 'content_block_delta') {
              const delta = streamEvent.delta;
              if (delta?.type === 'text_delta' && delta.text) {
                streamText += delta.text;
              }
            }
          } else if (msgType === 'assistant') {
            const message = msg['message'] as { content?: unknown[] } | undefined;
            if (message?.content) {
              for (const block of message.content) {
                const b = block as { type?: string; text?: string };
                if (b.type === 'text' && b.text) {
                  assistantText += b.text;
                }
              }
            }
          }
        }
        return streamText || assistantText;
      };

      let callTimeoutHandle: ReturnType<typeof setTimeout>;
      const callTimeout = new Promise<string>((resolve) => {
        callTimeoutHandle = setTimeout(() => {
          abortController.abort();
          resolve('[Error: subcall timed out]');
        }, PER_CALL_TIMEOUT_MS);
      });

      try {
        return await Promise.race([consume(), callTimeout]);
      } finally {
        clearTimeout(callTimeoutHandle!);
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        return '[Aborted]';
      }
      const msg = err instanceof Error ? err.message : String(err);
      log('[SubCallHandler] Query error: %s', msg);
      return `[Error: ${msg}]`;
    } finally {
      this.activeAborts.delete(abortController);
    }
  }

  async queryBatched(prompts: string[], model?: string): Promise<string[]> {
    const results: string[] = new Array(prompts.length).fill('');
    for (let i = 0; i < prompts.length; i += MAX_CONCURRENT_SUBCALLS) {
      const batch = prompts.slice(i, i + MAX_CONCURRENT_SUBCALLS);
      const batchResults = await Promise.all(batch.map(p => this.query(p, model)));
      for (let j = 0; j < batchResults.length; j++) {
        results[i + j] = batchResults[j]!;
      }
    }
    return results;
  }

  abort(): void {
    for (const ac of this.activeAborts) {
      ac.abort();
    }
    this.activeAborts.clear();
  }
}
