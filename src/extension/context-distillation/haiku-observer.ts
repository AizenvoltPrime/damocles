import { log } from '../logger';
import type { DistillationConfig } from './types';
import { HAIKU_SYSTEM_PROMPT, buildObservationPrompt } from './prompts';

const MAX_ASSISTANT_CHARS = 40000;
const HAIKU_TIMEOUT_MS = 30_000;
const MAX_TOOL_RESULT_CHARS = 500;

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return String(input['file_path'] ?? '');
    case 'Bash':
      return String(input['command'] ?? '').slice(0, 200);
    case 'Glob':
      return String(input['pattern'] ?? '');
    case 'Grep':
      return `pattern="${input['pattern'] ?? ''}" path=${input['path'] ?? '.'}`;
    case 'Task':
      return String(input['description'] ?? '');
    default:
      return Object.keys(input).join(', ');
  }
}

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
  onObservationStart?: () => void;
  onStreamDelta?: (deltaType: 'thinking' | 'text', delta: string) => void;
  onObservationComplete?: (thinking: string, text: string) => void;
}

type ObserverState = 'idle' | 'running' | 'done';

export class HaikuObserver {
  private buffer = '';
  private userPrompt = '';
  private callbacks: HaikuObserverCallbacks;
  private config: DistillationConfig;
  private cwd: string;
  private observerState: ObserverState = 'idle';
  private currentAbort: AbortController | null = null;

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
    this.observerState = 'idle';
  }

  appendInterjection(text: string): void {
    this.buffer += `\n\n[User interjection]: ${text}\n\n`;
  }

  appendContent(delta: string): void {
    this.buffer += delta;
  }

  appendToolUse(toolName: string, input: Record<string, unknown>): void {
    const summary = summarizeToolInput(toolName, input);
    this.buffer += `\n[Tool: ${toolName}] ${summary}\n`;
    log('[HaikuObserver.appendToolUse] tool=%s, summary=%s, bufferLen=%d, state=%s',
      toolName, summary.slice(0, 80), this.buffer.length, this.observerState);
  }

  appendToolResult(toolName: string, result: string): void {
    const truncated = result.length > MAX_TOOL_RESULT_CHARS
      ? result.slice(0, MAX_TOOL_RESULT_CHARS) + '...'
      : result;
    this.buffer += `[Result: ${toolName}] ${truncated}\n`;
    log('[HaikuObserver.appendToolResult] tool=%s, resultLen=%d, bufferLen=%d, state=%s',
      toolName, result.length, this.buffer.length, this.observerState);
  }

  finalize(): void {
    log('[HaikuObserver.finalize] bufferLen=%d, state=%s, userPrompt=%s',
      this.buffer.length, this.observerState,
      this.userPrompt ? this.userPrompt.slice(0, 60) : '(EMPTY)');

    if (this.observerState !== 'idle') return;

    if (!this.buffer.trim()) {
      this.observerState = 'done';
      return;
    }

    this.observerState = 'running';
    this.callbacks.onProcessingChange?.(true);
    this.fireSingleCall();
  }

  abortPending(): void {
    const wasActive = !!(this.currentAbort || this.buffer);
    this.currentAbort?.abort();
    this.currentAbort = null;
    this.observerState = 'done';
    this.buffer = '';
    if (wasActive) this.callbacks.onProcessingChange?.(false);
  }

  private fireSingleCall(): void {
    this.runSingleHaikuCall().catch(err => {
      if (err?.name !== 'AbortError') {
        log('[HaikuObserver] Haiku call failed:', err);
      }
    });
  }

  private async runSingleHaikuCall(): Promise<void> {
    this.currentAbort = new AbortController();
    const result = await this.fireHaikuCall(this.buffer, this.currentAbort.signal);
    this.currentAbort = null;

    if (!result) return;

    this.callbacks.updateContext(result.text);
    this.callbacks.onObservationComplete?.(result.thinking, result.text);
    this.observerState = 'done';
    this.callbacks.onProcessingChange?.(false);
  }

  private async fireHaikuCall(
    assistantText: string,
    signal: AbortSignal,
  ): Promise<{ thinking: string; text: string } | null> {
    const currentContext = this.callbacks.getContext();

    const hasToolMarkers = assistantText.includes('[Tool:');
    const toolCount = (assistantText.match(/\[Tool:/g) || []).length;
    const resultCount = (assistantText.match(/\[Result:/g) || []).length;

    log('[HaikuObserver.fireHaikuCall] contextLen=%d, userPrompt=%s, assistantLen=%d, hasTools=%s, toolCount=%d, resultCount=%d',
      currentContext?.length ?? 0,
      this.userPrompt ? `"${this.userPrompt.slice(0, 60)}"` : '(EMPTY)',
      assistantText.length, hasToolMarkers, toolCount, resultCount);

    if (hasToolMarkers) {
      log('[HaikuObserver.fireHaikuCall] buffer tail (last 300 chars): %s',
        assistantText.slice(-300));
    }

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

    this.callbacks.onObservationStart?.();

    try {
      const options = {
        model: this.config.observerModel,
        cwd: this.cwd,
        systemPrompt: HAIKU_SYSTEM_PROMPT,
        tools: [] as string[],
        maxTurns: 1,
        persistSession: false,
        abortController,
        maxThinkingTokens: 2048,
      };
      const generator = queryFn({ prompt, options } as Parameters<typeof queryFn>[0]);

      let responseText = '';
      let accumulatedThinking = '';
      let accumulatedText = '';

      for await (const event of generator) {
        if (signal.aborted) return null;

        const msg = event as {
          type: string;
          result?: string;
          event?: {
            type: string;
            delta?: { type: string; text?: string; thinking?: string };
          };
        };

        if (msg.type === 'stream_event' && msg.event) {
          if (msg.event.type === 'content_block_delta' && msg.event.delta) {
            if (msg.event.delta.type === 'thinking_delta' && msg.event.delta.thinking) {
              accumulatedThinking += msg.event.delta.thinking;
              this.callbacks.onStreamDelta?.('thinking', msg.event.delta.thinking);
            } else if (msg.event.delta.type === 'text_delta' && msg.event.delta.text) {
              accumulatedText += msg.event.delta.text;
              this.callbacks.onStreamDelta?.('text', msg.event.delta.text);
            }
          }
        }

        if (msg.type === 'result' && msg.result) {
          responseText = msg.result;
        }
      }

      if (signal.aborted) return null;

      const finalText = responseText.trim() || accumulatedText.trim();

      log('[HaikuObserver] Observation complete (%d chars thinking, %d chars text)',
        accumulatedThinking.length, finalText.length);

      return { thinking: accumulatedThinking, text: finalText };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  }
}
