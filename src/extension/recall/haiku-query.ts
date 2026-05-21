import { log } from '../logger';
import { loadSdkQuery } from '../shared/sdk-loader';
import type { SdkQuery } from '../shared/sdk-loader';
import { buildSdkEnv, getSmallFastModel, requireAuthFor } from '../auth/sdk-env';

interface HaikuQueryParams {
  systemPrompt: string;
  userMessage: string;
  schema: Record<string, unknown>;
  cwd: string;
  abortSignal?: AbortSignal | undefined;
}

export async function haikuStructuredQuery<T>(params: HaikuQueryParams): Promise<T | null> {
  const sdkQuery = loadSdkQuery();
  if (!sdkQuery) {
    log('[HaikuQuery] SDK unavailable');
    return null;
  }

  const subcallModel = getSmallFastModel();
  const auth = await requireAuthFor({ modelValue: subcallModel, featureName: 'recall.haikuStructuredQuery' });
  if (!auth.ok) return null;

  const abortController = new AbortController();
  const onParentAbort = () => abortController.abort();
  params.abortSignal?.addEventListener('abort', onParentAbort);
  if (params.abortSignal?.aborted) abortController.abort();

  try {
    const generator = sdkQuery({
      prompt: params.userMessage,
      options: {
        model: subcallModel,
        systemPrompt: params.systemPrompt,
        cwd: params.cwd,
        persistSession: false,
        tools: [] as string[],
        abortController,
        thinking: { type: 'disabled' },
        outputFormat: { type: 'json_schema' as const, schema: params.schema },
        env: buildSdkEnv(),
      },
    } as Parameters<SdkQuery>[0]);

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
  } catch (err) {
    if (!abortController.signal.aborted) {
      log('[HaikuQuery] Error: %O', err);
    }
    return null;
  } finally {
    params.abortSignal?.removeEventListener('abort', onParentAbort);
  }
}
