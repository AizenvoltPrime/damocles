import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { log } from '../logger';
import { haikuStructuredQuery } from '../recall/haiku-query';
import { buildSdkEnv, requireAuthFor } from '../auth/sdk-env';
import {
  buildSubCallEnv,
  getSmallFastModelForBackend,
  inferSubCallBackendForCtx,
  type SubCallBridgeCtx,
} from '../auth/sub-call-env';
import { ExploreProxy } from '../explore/proxy-server';
import type { ExploreThirdPartyProvider } from '../explore/types';
import type { ExploreProviderConfig } from '../explore';

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

export interface MemorySubCallDeps {
  getBridgeCtx: () => SubCallBridgeCtx | null;
  getExploreConfig: () => ExploreProviderConfig | null | Promise<ExploreProviderConfig | null>;
  getCwd: () => string;
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
 * Construct a memory sub-call runner that issues one-shot structured-output LLM
 * completions, choosing between the fast model on your main provider and a separate
 * Explore third-party provider per the `damocles.memory.subcallEngine` setting.
 *
 * When the third-party engine is selected, ALL memory tasks (rerank/extract/merge/
 * profile) run on it; the default engine keeps everything on your main provider.
 * The runner never throws; every path resolves a `MemorySubCallResult`.
 */
export function createMemorySubCallRunner(deps: MemorySubCallDeps): MemorySubCallRunner {
  async function runSmallFast<T>(req: MemorySubCallRequest, timeoutMs: number): Promise<MemorySubCallResult<T>> {
    const ctx = deps.getBridgeCtx();
    const backend = inferSubCallBackendForCtx(ctx);
    const model = getSmallFastModelForBackend(backend);

    const auth = await requireAuthFor({ modelValue: model, featureName: `memory.subcall.${req.purpose}` });
    if (!auth.ok) return { value: null, failure: 'no-model' };

    const env = await buildSubCallEnv(model, ctx);
    if (!env) return { value: null, failure: 'no-model' };

    const value = await haikuStructuredQuery<T>({
      systemPrompt: req.systemPrompt,
      userMessage: req.prompt,
      schema: req.schema,
      cwd: deps.getCwd(),
      abortSignal: req.abortSignal,
      env: env.env,
      model: env.resolvedModel,
      skipAuth: true,
      timeoutMs,
    });

    if (value === null) return { value: null, failure: 'transient' };
    return { value };
  }

  async function runExplore<T>(
    req: MemorySubCallRequest,
    cfg: ExploreProviderConfig,
    timeoutMs: number,
  ): Promise<MemorySubCallResult<T>> {
    const bearer = crypto.randomBytes(32).toString('hex');
    const proxy = new ExploreProxy({
      provider: cfg.provider as ExploreThirdPartyProvider,
      targetBaseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      bearer,
    });

    try {
      await proxy.start();
    } catch (err) {
      log('[MemorySubCall] Explore proxy failed to start: %O', err);
      return { value: null, failure: 'transient' };
    }

    try {
      const value = await haikuStructuredQuery<T>({
        systemPrompt: req.systemPrompt,
        userMessage: req.prompt,
        schema: req.schema,
        cwd: deps.getCwd(),
        abortSignal: req.abortSignal,
        env: { ...buildSdkEnv(), ANTHROPIC_BASE_URL: proxy.url, ANTHROPIC_AUTH_TOKEN: bearer },
        model: null,
        skipAuth: true,
        timeoutMs,
      });

      if (value === null) return { value: null, failure: 'transient' };
      return { value };
    } finally {
      proxy.stop();
    }
  }

  return {
    async run<T>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> {
      const engine = vscode.workspace
        .getConfiguration('damocles.memory')
        .get<'small-fast' | 'explore'>('subcallEngine', 'small-fast');

      const timeoutMs = req.timeoutMs ?? defaultTimeoutMs(req.purpose);

      if (engine === 'explore') {
        const cfg = await deps.getExploreConfig();
        if (!cfg || !cfg.apiKey) return { value: null, failure: 'no-model' };
        return runExplore<T>(req, cfg, timeoutMs);
      }

      return runSmallFast<T>(req, timeoutMs);
    },
  };
}
