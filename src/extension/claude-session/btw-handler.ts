import { log } from '../logger';
import { loadSdkQuery } from '../shared/sdk-loader';
import type { SdkQuery } from '../shared/sdk-loader';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';

const BTW_TIMEOUT_MS = 60_000;

const BTW_SYSTEM_PROMPT = `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect

CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- This is a one-off response - there will be no follow-up turns
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate

Simply answer the question with the information you have.</system-reminder>`;

interface BtwHandlerDeps {
  cwd: string;
  getSessionId: () => string | null;
  getModel: () => string | null;
  onMessage: (msg: ExtensionToWebviewMessage) => void;
  getCrossNodeContext?: (question: string) => Promise<string | null>;
}

export class BtwHandler {
  private sdkQuery: SdkQuery | null = null;
  private activeAborts = new Map<string, AbortController>();
  private deps: BtwHandlerDeps;

  constructor(deps: BtwHandlerDeps) {
    this.deps = deps;
  }

  async send(btwId: string, question: string): Promise<void> {
    const sessionId = this.deps.getSessionId();
    if (!sessionId) {
      this.deps.onMessage({ type: 'btwError', btwId, message: 'Start a conversation first' });
      return;
    }

    if (!this.sdkQuery) {
      this.sdkQuery = loadSdkQuery();
      if (!this.sdkQuery) {
        this.deps.onMessage({ type: 'btwError', btwId, message: 'SDK unavailable' });
        return;
      }
    }

    const abortController = new AbortController();
    this.activeAborts.set(btwId, abortController);

    const model = this.deps.getModel();

    try {
      const options = {
        resume: sessionId,
        forkSession: true,
        persistSession: false,
        maxTurns: 1,
        tools: [] as string[],
        model: model ?? undefined,
        systemPrompt: BTW_SYSTEM_PROMPT,
        abortController,
        cwd: this.deps.cwd,
      };

      const generator = this.sdkQuery({ prompt: question, options } as Parameters<SdkQuery>[0]);

      let cumulativeText = '';

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
                cumulativeText += delta.text;
                this.deps.onMessage({ type: 'btwStreaming', btwId, text: cumulativeText });
              }
            }
          } else if (msgType === 'assistant') {
            const message = msg['message'] as { content?: unknown[] } | undefined;
            if (message?.content) {
              for (const block of message.content) {
                const b = block as { type?: string; text?: string };
                if (b.type === 'text' && b.text && !cumulativeText) {
                  cumulativeText = b.text;
                }
              }
            }
          }
        }
      };

      const timeoutHandle = setTimeout(() => {
        abortController.abort();
        this.deps.onMessage({ type: 'btwError', btwId, message: 'Request timed out' });
      }, BTW_TIMEOUT_MS);

      const consumePromise = consume();
      try {
        await Promise.race([consumePromise, new Promise<void>(resolve => {
          abortController.signal.addEventListener('abort', () => resolve(), { once: true });
        })]);
      } finally {
        clearTimeout(timeoutHandle);
      }
      consumePromise.catch(() => {});

      if (!abortController.signal.aborted && cumulativeText) {
        this.deps.onMessage({ type: 'btwComplete', btwId, text: cumulativeText });
      } else if (!abortController.signal.aborted && !cumulativeText) {
        this.deps.onMessage({ type: 'btwError', btwId, message: 'No response received' });
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log('[BtwHandler] Query error: %s', errMsg);
        this.deps.onMessage({ type: 'btwError', btwId, message: errMsg });
      }
    } finally {
      this.activeAborts.delete(btwId);
    }
  }

  async sendWithContext(btwId: string, question: string): Promise<void> {
    if (!this.deps.getCrossNodeContext) {
      return this.send(btwId, question);
    }

    try {
      const context = await this.deps.getCrossNodeContext(question);

      if (!this.activeAborts.has(btwId)) {
        log('[BtwHandler] btwId=%s cancelled during context fetch, aborting', btwId);
        return;
      }

      if (!context) {
        return this.send(btwId, question);
      }

      const enrichedPrompt = `<cross_node_context>\n${context}\n</cross_node_context>\n\n${question}`;
      log('[BtwHandler] Injected %d chars of cross-node context', context.length);
      return this.send(btwId, enrichedPrompt);
    } catch (err) {
      log('[BtwHandler] Cross-node context failed, falling back: %s', err instanceof Error ? err.message : String(err));
      return this.send(btwId, question);
    }
  }

  cancel(btwId: string): void {
    const ac = this.activeAborts.get(btwId);
    if (ac) {
      ac.abort();
      this.activeAborts.delete(btwId);
    }
  }

  cancelAll(): void {
    for (const ac of this.activeAborts.values()) {
      ac.abort();
    }
    this.activeAborts.clear();
  }
}
