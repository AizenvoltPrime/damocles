import { PiRuntime } from '../pi-session/pi-runtime';

/** The kind of memory sub-call, used to size the per-call timeout. */
export type MemorySubCallPurpose = 'rerank' | 'extract' | 'merge' | 'profile';

/** Why a sub-call produced no value: `transient` (retryable) vs `no-model` (no credentials/config). */
export type MemorySubCallFailure = 'transient' | 'no-model';

export interface MemorySubCallResult<T> {
  value: T | null;
  failure?: MemorySubCallFailure;
}

export interface MemorySubCallRequest {
  prompt: string;
  systemPrompt: string;
  schema: Record<string, unknown>;
  purpose: MemorySubCallPurpose;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

export interface MemorySubCallRunner {
  run<T>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>>;
}

const RERANK_TIMEOUT_MS = 8_000;
const EXTRACTION_TIMEOUT_MS = 20_000;

function defaultTimeoutMs(purpose: MemorySubCallPurpose): number {
  return purpose === 'rerank' ? RERANK_TIMEOUT_MS : EXTRACTION_TIMEOUT_MS;
}

/**
 * Construct a memory sub-call runner that issues one-shot structured-output LLM completions through the
 * pi small/fast model (US-006b). The runner never throws; every path resolves a `MemorySubCallResult`.
 */
export function createMemorySubCallRunner(): MemorySubCallRunner {
  return {
    async run<T>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> {
      const timeoutMs = req.timeoutMs ?? defaultTimeoutMs(req.purpose);
      const runtime = PiRuntime.get();
      if (!runtime.hasAuthedSubCallModel()) return { value: null, failure: 'no-model' };
      const value = await runtime.runStructuredCompletion<T>({
        systemPrompt: req.systemPrompt,
        userMessage: req.prompt,
        outputToolName: 'submit_result',
        outputToolDescription: 'Return the structured result for this request.',
        schema: req.schema,
        ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
        timeoutMs,
      });
      if (value === null) return { value: null, failure: 'transient' };
      return { value };
    },
  };
}
