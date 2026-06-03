import { log } from '../logger';
import { loadSdkQuery } from '../shared/sdk-loader';
import type { SdkQuery } from '../shared/sdk-loader';
import { buildSdkEnv, getSmallFastModel, requireAuthFor } from '../auth/sdk-env';

/**
 * Parameters for a one-shot structured-output SDK completion.
 *
 * `model`, `env`, `skipAuth`, and `timeoutMs` are optional escape hatches for
 * callers (e.g. the memory sub-call runner) that resolve their own auth/env or
 * route through a third-party proxy. Recall's own callers omit them and keep
 * the original small-fast Anthropic behavior.
 */
interface HaikuQueryParams {
  systemPrompt: string;
  userMessage: string;
  schema: Record<string, unknown>;
  cwd: string;
  abortSignal?: AbortSignal | undefined;
  /** `undefined` → small-fast Anthropic model; string → that model; `null` → omit `options.model` (proxy sets it). */
  model?: string | null | undefined;
  /** `undefined` → `buildSdkEnv()`; else the caller-supplied SDK env. */
  env?: Record<string, string> | undefined;
  /** `true` → skip the `requireAuthFor` gate (caller already resolved auth/env). */
  skipAuth?: boolean | undefined;
  /** `undefined` → no hard timeout; a number → abort the controller and return `null` after this many ms. */
  timeoutMs?: number | undefined;
}

export async function haikuStructuredQuery<T>(params: HaikuQueryParams): Promise<T | null> {
  const sdkQuery = loadSdkQuery();
  if (!sdkQuery) {
    log('[HaikuQuery] SDK unavailable');
    return null;
  }

  const resolvedModel = params.model === undefined ? getSmallFastModel() : params.model;

  if (!params.skipAuth) {
    const authModel = resolvedModel ?? getSmallFastModel();
    const auth = await requireAuthFor({ modelValue: authModel, featureName: 'recall.haikuStructuredQuery' });
    if (!auth.ok) return null;
  }

  const abortController = new AbortController();
  const onParentAbort = () => abortController.abort();
  params.abortSignal?.addEventListener('abort', onParentAbort);
  if (params.abortSignal?.aborted) abortController.abort();

  try {
    const generator = sdkQuery({
      prompt: params.userMessage,
      options: {
        ...(resolvedModel !== null ? { model: resolvedModel } : {}),
        systemPrompt: params.systemPrompt,
        cwd: params.cwd,
        persistSession: false,
        tools: [] as string[],
        abortController,
        thinking: { type: 'disabled' },
        outputFormat: { type: 'json_schema' as const, schema: params.schema },
        env: params.env ?? buildSdkEnv(),
      },
    } as Parameters<SdkQuery>[0]);

    const consume = async (): Promise<T | null> => {
      let structuredOutput: T | null = null;

      for await (const event of generator) {
        if (abortController.signal.aborted) break;

        const msg = event as {
          type: string;
          subtype?: string;
          structured_output?: T;
        };

        if (msg.type === 'result') {
          if (msg.subtype === 'error_max_structured_output_retries') {
            log('[HaikuQuery] Structured output retries exhausted');
            return null;
          }
          if (msg.subtype?.startsWith('error_')) {
            log('[HaikuQuery] SDK error: %s', msg.subtype);
            return null;
          }
          if (msg.structured_output) {
            structuredOutput = msg.structured_output;
          }
        }
      }

      return structuredOutput;
    };

    if (params.timeoutMs === undefined) {
      return await consume();
    }

    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeout = new Promise<T | null>((resolve) => {
      timeoutHandle = setTimeout(() => {
        abortController.abort();
        log('[HaikuQuery] Timed out after %dms', params.timeoutMs);
        resolve(null);
      }, params.timeoutMs);
    });

    const consumePromise = consume();
    void consumePromise.catch(() => {});
    try {
      return await Promise.race([consumePromise, timeout]);
    } finally {
      clearTimeout(timeoutHandle!);
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      log('[HaikuQuery] Error: %O', err);
    }
    return null;
  } finally {
    params.abortSignal?.removeEventListener('abort', onParentAbort);
  }
}
