import { log } from '../logger';
import type { DistillationConfig } from './types';
import { HAIKU_SYSTEM_PROMPT, buildObservationPrompt } from './prompts';

const EARLY_TRIGGER_CHARS = 8000;
const MAX_ASSISTANT_CHARS = 40000;
const HAIKU_TIMEOUT_MS = 30_000;

let queryFn: typeof import('@anthropic-ai/claude-agent-sdk').query | undefined;

async function loadSDK() {
  if (!queryFn) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    queryFn = sdk.query;
  }
  return queryFn;
}

export interface HaikuObserverCallbacks {
  getContext: () => string | null;
  updateContext: (content: string) => void;
  onProcessingChange?: (isProcessing: boolean) => void;
}

export class HaikuObserver {
  private buffer = '';
  private userPrompt = '';
  private earlyCallAbort: AbortController | null = null;
  private finalizeAbort: AbortController | null = null;
  private earlyCallFired = false;
  private callbacks: HaikuObserverCallbacks;
  private config: DistillationConfig;
  private cwd: string;

  constructor(callbacks: HaikuObserverCallbacks, config: DistillationConfig, cwd: string) {
    this.callbacks = callbacks;
    this.config = config;
    this.cwd = cwd;
  }

  startObservation(userPrompt: string): void {
    log('[HaikuObserver.startObservation] prompt=%s, existingContext=%d chars',
      userPrompt.slice(0, 80), this.callbacks.getContext()?.length ?? 0);
    this.abortPending();
    this.buffer = '';
    this.userPrompt = userPrompt;
    this.earlyCallFired = false;
    this.callbacks.onProcessingChange?.(true);
  }

  appendInterjection(text: string): void {
    this.buffer += `\n\n[User interjection]: ${text}\n\n`;
  }

  appendContent(delta: string): void {
    this.buffer += delta;

    if (!this.earlyCallFired && this.buffer.length >= EARLY_TRIGGER_CHARS) {
      this.earlyCallFired = true;
      this.earlyCallAbort = new AbortController();
      this.fireHaikuCall(this.buffer, this.earlyCallAbort.signal)
        .catch(err => {
          if (err?.name !== 'AbortError') {
            log('[HaikuObserver] Early call failed:', err);
          }
        });
    }
  }

  async finalize(): Promise<void> {
    log('[HaikuObserver.finalize] bufferLen=%d, userPrompt=%s',
      this.buffer.length, this.userPrompt ? this.userPrompt.slice(0, 60) : '(EMPTY)');

    if (this.earlyCallAbort) {
      this.earlyCallAbort.abort();
      this.earlyCallAbort = null;
    }

    if (!this.buffer.trim()) {
      log('[HaikuObserver.finalize] SKIP — empty buffer');
      this.callbacks.onProcessingChange?.(false);
      return;
    }

    this.finalizeAbort = new AbortController();
    try {
      await this.fireHaikuCall(this.buffer, this.finalizeAbort.signal);
    } finally {
      this.finalizeAbort = null;
      this.callbacks.onProcessingChange?.(false);
    }
  }

  abortPending(): void {
    const wasActive = !!(this.earlyCallAbort || this.finalizeAbort || this.buffer);
    this.earlyCallAbort?.abort();
    this.earlyCallAbort = null;
    this.finalizeAbort?.abort();
    this.finalizeAbort = null;
    this.buffer = '';
    this.earlyCallFired = false;
    if (wasActive) this.callbacks.onProcessingChange?.(false);
  }

  private async fireHaikuCall(assistantText: string, signal: AbortSignal): Promise<void> {
    const currentContext = this.callbacks.getContext();

    log('[HaikuObserver.fireHaikuCall] inputs: contextLen=%d, userPrompt=%s, assistantLen=%d',
      currentContext?.length ?? 0,
      this.userPrompt ? `"${this.userPrompt.slice(0, 60)}"` : '(EMPTY)',
      assistantText.length);

    const truncatedAssistant = assistantText.length > MAX_ASSISTANT_CHARS
      ? assistantText.slice(-MAX_ASSISTANT_CHARS)
      : assistantText;

    const prompt = buildObservationPrompt(
      currentContext ?? '',
      this.userPrompt,
      truncatedAssistant
    );

    const queryFn = await loadSDK();
    const abortController = new AbortController();

    const onAbort = () => abortController.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      log('[HaikuObserver] Haiku call timed out after %dms', HAIKU_TIMEOUT_MS);
      abortController.abort();
    }, HAIKU_TIMEOUT_MS);

    try {
      const options = {
        model: this.config.observerModel,
        cwd: this.cwd,
        systemPrompt: HAIKU_SYSTEM_PROMPT,
        tools: [] as string[],
        maxTurns: 1,
        persistSession: false,
        abortController,
      };
      const result = queryFn({ prompt, options } as Parameters<typeof queryFn>[0]);

      let responseText = '';
      for await (const event of result) {
        if (signal.aborted) return;

        const msg = event as { type: string; result?: string; message?: { content?: Array<{ type: string; text?: string }> } };
        if (msg.type === 'result' && msg.result) {
          responseText = msg.result;
        }
      }

      if (!signal.aborted && responseText.trim()) {
        this.callbacks.updateContext(responseText.trim());
        log('[HaikuObserver] Context updated (%d chars, ~%d tokens)',
          responseText.trim().length,
          Math.ceil(responseText.trim().length / 4)
        );
      }
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  }
}
