import type { EnrichedPrompt } from "@/composables/useEnrichedPrompts";

export interface VisibleRowItem {
  kind: "row";
  prompt: EnrichedPrompt;
  flatIndex: number;
}

export type VisibleRow = VisibleRowItem;

/**
 * HTML-escape a raw string. MUST run BEFORE wrapping matches in <mark>.
 * Order is load-bearing: escape first, then highlight, otherwise the
 * inserted <mark> tags would be re-escaped into literals.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Regex-escape a user-supplied query so it can be safely embedded in a RegExp.
 */
export function escapeRegex(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Wraps every case-insensitive occurrence of `query` inside `text` with a
 * `<mark>` element. The text is HTML-escaped first to neutralize stored-XSS-style
 * injections from prompt content. Empty queries return the escaped text only.
 */
export function highlight(text: string, query: string): string {
  const escaped = escapeHtml(text);
  if (!query) return escaped;
  const escapedQueryForHtml = escapeHtml(query);
  const re = new RegExp(`(${escapeRegex(escapedQueryForHtml)})`, "gi");
  return escaped.replace(
    re,
    '<mark class="bg-sky-400/25 text-sky-200 rounded-sm px-0.5">$1</mark>',
  );
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
 * Flattens prompts into the listbox row order. The `flatIndex` on each row
 * indexes into ROWS only — it is what `activeIndex` references.
 */
export function buildVisibleRows(prompts: EnrichedPrompt[]): VisibleRow[] {
  return prompts.map((prompt, flatIndex) => ({ kind: "row", prompt, flatIndex }));
}

/**
 * Counts visible rows. Used to clamp keyboard navigation.
 */
export function countVisibleRows(rows: VisibleRow[]): number {
  return rows.length;
}

/**
 * Pure rewind-eligibility check used by the row kebab. The single source of
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
