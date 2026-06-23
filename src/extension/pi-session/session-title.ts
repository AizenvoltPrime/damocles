import type { StructuredCompletionRequest } from './structured-completion';

/**
 * The AI session-title one-shot (US-012): the prompt/schema/timeout config plus the LLM-call core.
 * Pure of `PiSession` — the caller (`maybeGenerateTitle`) keeps the one-shot guard, the live-state
 * reads, the name-already-set re-check (user `/rename` outranks), and the side effects. Only the
 * `hasAuthedSubCallModel` gate + `runStructuredCompletion` call + title extraction live here.
 */

export const TITLE_OUTPUT_TOOL = 'set_session_title';

export const TITLE_SYSTEM_PROMPT: string =
  'You generate a short, descriptive title for a coding assistant conversation. Call the ' +
  `${TITLE_OUTPUT_TOOL} tool with a concise 3-6 word title in Title Case, summarizing the user's intent. ` +
  'No surrounding quotes and no trailing punctuation.';

export const TITLE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A concise 3-6 word Title Case summary of the conversation.' },
  },
  required: ['title'],
  additionalProperties: false,
};

/** The narrow runtime surface the title sub-call needs; the concrete `PiRuntime` satisfies it. */
export interface TitleRuntime {
  hasAuthedSubCallModel(): boolean;
  runStructuredCompletion<T>(req: StructuredCompletionRequest): Promise<T | null>;
}

/**
 * Generate an AI title for the first exchange via the small/fast sub-call model. Returns the trimmed
 * title, or null when no sub-call model is authed or the model returned an empty/whitespace title.
 * Fails soft at the call site (fire-and-forget); this core does not catch (its caller wraps it).
 */
export async function generateSessionTitle(exchange: string, runtime: TitleRuntime): Promise<string | null> {
  if (!runtime.hasAuthedSubCallModel()) return null;
  const result = await runtime.runStructuredCompletion<{ title?: string }>({
    systemPrompt: TITLE_SYSTEM_PROMPT,
    userMessage: exchange,
    outputToolName: TITLE_OUTPUT_TOOL,
    outputToolDescription: 'Record the conversation title.',
    schema: TITLE_SCHEMA,
    timeoutMs: 15_000,
  });
  return result?.title?.trim() || null;
}
