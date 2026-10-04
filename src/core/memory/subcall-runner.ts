import type { ClassifierAnswer, ClassifierQuestion, JsonObject } from '@earendil-works/pi-ai';
import { PiRuntime } from '../pi-session/pi-runtime';

/** The kind of memory sub-call, used to size the per-call timeout. */
export type MemorySubCallPurpose = 'rerank' | 'extract' | 'merge' | 'profile' | 'audit';

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

/** A Jev request: untrusted text only in `state`; `questions` come from constants in code. */
export interface MemoryClassifyRequest {
  purpose: Extract<MemorySubCallPurpose, 'merge' | 'rerank'>;
  state: JsonObject;
  questions: Record<string, ClassifierQuestion>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

export interface MemorySubCallRunner {
  run<T>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>>;
  /** Absent or false: the judges use `run` alone. */
  hasClassifier?(): boolean;
  /** The answers, or null on any failure. Never throws. */
  classify?(req: MemoryClassifyRequest): Promise<Record<string, ClassifierAnswer> | null>;
}

const RERANK_TIMEOUT_MS = 12_000;
// Extraction + profile summaries run on the small/fast model (incl. third-party Explore providers like
// StepFun), which can be slower than Haiku; 45s avoids spurious "Request timed out" no-model/error cards.
const EXTRACTION_TIMEOUT_MS = 45_000;

function defaultTimeoutMs(purpose: MemorySubCallPurpose): number {
  return purpose === 'rerank' ? RERANK_TIMEOUT_MS : EXTRACTION_TIMEOUT_MS;
}

/** The model memory sub-calls run on, with its API rates; `null` when none is configured. */
export function describeMemorySubCallModel(): ReturnType<PiRuntime['describeSubCallModel']> {
  return PiRuntime.get().describeSubCallModel();
}

/**
 * Construct a memory sub-call runner that issues one-shot structured-output LLM completions through the
 * pi small/fast model. The runner never throws; every path resolves a `MemorySubCallResult`.
 *
 * `lifetime` is the owning service's: once it aborts, in-flight calls are cancelled and new ones resolve
 * without a value, which every caller already treats as "no answer, decide later". A retired PiRuntime
 * is never re-created by a call made after the abort.
 */
export function createMemorySubCallRunner(lifetime: AbortSignal): MemorySubCallRunner {
  const signalFor = (req: { abortSignal?: AbortSignal }): AbortSignal =>
    req.abortSignal ? AbortSignal.any([req.abortSignal, lifetime]) : lifetime;
  return {
    async run<T>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> {
      if (lifetime.aborted) return { value: null, failure: 'transient' };
      const timeoutMs = req.timeoutMs ?? defaultTimeoutMs(req.purpose);
      const runtime = PiRuntime.get();
      if (!runtime.hasAuthedSubCallModel()) return { value: null, failure: 'no-model' };
      const value = await runtime.runStructuredCompletion<T>({
        systemPrompt: req.systemPrompt,
        userMessage: req.prompt,
        outputToolName: 'submit_result',
        outputToolDescription: 'Return the structured result for this request.',
        schema: req.schema,
        // No `attribution`: memory spans workspace roots, so its sub-calls belong to no project.
        purpose: `memory-${req.purpose}`,
        abortSignal: signalFor(req),
        timeoutMs,
      });
      if (value === null) return { value: null, failure: 'transient' };
      return { value };
    },
    hasClassifier(): boolean {
      return !lifetime.aborted && PiRuntime.get().hasClassifier();
    },
    async classify(req: MemoryClassifyRequest): Promise<Record<string, ClassifierAnswer> | null> {
      if (lifetime.aborted) return null;
      return PiRuntime.get().runClassification({
        state: req.state,
        questions: req.questions,
        purpose: `memory-${req.purpose}`,
        timeoutMs: req.timeoutMs,
        abortSignal: signalFor(req),
      });
    },
  };
}
