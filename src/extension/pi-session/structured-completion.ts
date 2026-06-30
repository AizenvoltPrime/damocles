import type { Api, AssistantMessage, Context, Model, ProviderStreamOptions, Tool } from '@earendil-works/pi-ai';
import type { TSchema } from 'typebox';
import { log } from '../logger';

/** The pi-ai `complete` function, narrowed to what the structured-completion core needs. */
export type PiCompleteFn = (
  model: Model<Api>,
  context: Context,
  options?: ProviderStreamOptions,
) => Promise<AssistantMessage>;

export interface StructuredCompletionRequest {
  /** System prompt fully controlling the sub-call (no pi identity/tool prose). */
  systemPrompt: string;
  /** The user-role content driving the completion. */
  userMessage: string;
  /** Name of the single terminating tool the model is asked to call with the structured result. */
  outputToolName: string;
  /** Description shown to the model for the terminating tool. */
  outputToolDescription: string;
  /**
   * JSON Schema for the structured output (the terminating tool's parameters). TypeBox schemas ARE
   * JSON Schema, so existing plain JSON-schema objects (e.g. memory's sub-call schemas) pass through
   * unchanged — `complete()` forwards `parameters` to the provider as the tool's input schema and does
   * not TypeBox-validate it.
   */
  schema: Record<string, unknown>;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Resolved provider credentials for the sub-call. `complete()` does NOT resolve OAuth grants — it only
 * falls back to environment API keys (forbidden in Damocles), so the caller MUST pass the credential
 * (the OAuth bearer token or API key) and any provider headers, mirroring how pi's agent session
 * authenticates every request. Without this, subscription/allowance modes fail "No API key for
 * provider: anthropic".
 */
export interface StructuredCompletionAuth {
  apiKey?: string;
  headers?: Record<string, string>;
}

/** Pull JSON from raw model text — direct parse, then the first `{...}` span (handles fenced blocks). */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* not bare JSON */
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      /* not embedded JSON */
    }
  }
  return null;
}

/**
 * One-shot structured-output completion via the terminating-tool idiom. The model is given
 * a single tool whose parameters ARE the desired output shape; we read the tool call's `arguments`
 * (no `toolChoice` forcing — subscription/OAuth can't force tools), falling back to JSON parsed from
 * text when the model answers in prose. Returns `null` on abort/error/parse-failure so every caller
 * fails soft. The model is resolved by the caller (PiRuntime) — this core is pure for testability.
 */
export async function runStructuredCompletion<T>(
  complete: PiCompleteFn,
  model: Model<Api>,
  req: StructuredCompletionRequest,
  auth?: StructuredCompletionAuth,
): Promise<T | null> {
  const tool: Tool = { name: req.outputToolName, description: req.outputToolDescription, parameters: req.schema as unknown as TSchema };
  const context: Context = {
    systemPrompt: req.systemPrompt,
    messages: [{ role: 'user', content: [{ type: 'text', text: req.userMessage }], timestamp: Date.now() }],
    tools: [tool],
  };
  const options: ProviderStreamOptions = {
    ...(auth?.apiKey ? { apiKey: auth.apiKey } : {}),
    ...(auth?.headers ? { headers: auth.headers } : {}),
    ...(req.abortSignal ? { signal: req.abortSignal } : {}),
    ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
  };

  let result: AssistantMessage;
  try {
    result = await complete(model, context, options);
  } catch (err) {
    log('[PiStructuredCompletion] complete() threw: %O', err);
    return null;
  }

  if (result.stopReason === 'error' || result.stopReason === 'aborted') {
    log('[PiStructuredCompletion] non-terminal stopReason=%s (%s)', result.stopReason, result.errorMessage ?? '');
    return null;
  }

  const call = result.content.find(
    (c): c is Extract<typeof c, { type: 'toolCall' }> => c.type === 'toolCall' && c.name === req.outputToolName,
  );
  if (call) return call.arguments as T;

  const text = result.content
    .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('');
  return (extractJson(text) as T | null) ?? null;
}
