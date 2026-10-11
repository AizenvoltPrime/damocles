import type { EnrichedPrompt } from "@/composables/useEnrichedPrompts";
import { highlightMatches } from "@/utils/highlightMatches";

/** Escaped `text` with every case-insensitive occurrence of `query` in a `<mark>`. */
export function highlight(text: string, query: string): string {
  return highlightMatches(text, query, "<mark>", "</mark>");
}

/**
 * Case-insensitive substring filter against text and the joined tool list.
 */
export function filterPrompts(prompts: EnrichedPrompt[], query: string): EnrichedPrompt[] {
  const trimmed = query.trim();
  if (!trimmed) return prompts.slice();
  const needle = trimmed.toLowerCase();
  return prompts.filter((p) => {
    if (p.text.toLowerCase().includes(needle)) return true;
    if (p.tools.length > 0 && p.tools.join(" ").toLowerCase().includes(needle)) return true;
    return false;
  });
}

/**
 * Pure rewind-eligibility check used by the row's rewind action. The single source of
 * truth is the session store's `checkpointMessages` set (sdkMessageId-keyed).
 * Extracted as a free function so unit tests can hit it without mounting Pinia.
 */
export function canRewindForPrompt(
  prompt: Pick<EnrichedPrompt, "sdkMessageId">,
  checkpointMessages: Set<string> | null | undefined,
): boolean {
  if (!prompt.sdkMessageId) return false;
  if (!checkpointMessages) return false;
  return checkpointMessages.has(prompt.sdkMessageId);
}
