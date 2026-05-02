import type { EnrichedPrompt } from "@/composables/useEnrichedPrompts";

export interface NavigatorGroup {
  key: string;
  title: string;
  prompts: EnrichedPrompt[];
}

export interface VisibleRowHeader {
  kind: "header";
  key: string;
  title: string;
  count: number;
  collapsed: boolean;
}

export interface VisibleRowItem {
  kind: "row";
  prompt: EnrichedPrompt;
  flatIndex: number;
}

export type VisibleRow = VisibleRowHeader | VisibleRowItem;

const NONE_KEY = "__none";

export function isMissingNodeKey(key: string): boolean {
  return key === NONE_KEY;
}

export function getMissingNodeKey(): string {
  return NONE_KEY;
}

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
 * Case-insensitive substring filter against text, nodeTitle, and the joined tool list.
 */
export function filterPrompts(prompts: EnrichedPrompt[], query: string): EnrichedPrompt[] {
  const trimmed = query.trim();
  if (!trimmed) return prompts.slice();
  const needle = trimmed.toLowerCase();
  return prompts.filter((p) => {
    if (p.text.toLowerCase().includes(needle)) return true;
    if (p.nodeTitle.toLowerCase().includes(needle)) return true;
    if (p.tools.length > 0 && p.tools.join(" ").toLowerCase().includes(needle)) return true;
    return false;
  });
}

/**
 * Groups prompts by node, preserving the insertion order of first occurrence per node.
 * Prompts without a nodeId fall under the missing-node sentinel key.
 */
export function groupByNode(prompts: EnrichedPrompt[], missingNodeTitle: string): NavigatorGroup[] {
  const seen = new Map<string, NavigatorGroup>();
  const order: string[] = [];
  for (const p of prompts) {
    const key = p.nodeId ?? NONE_KEY;
    let group = seen.get(key);
    if (!group) {
      const title = p.nodeId ? p.nodeTitle : missingNodeTitle;
      group = { key, title, prompts: [] };
      seen.set(key, group);
      order.push(key);
    }
    group.prompts.push(p);
  }
  return order.map((k) => seen.get(k)!);
}

/**
 * Flattens groups into the listbox row order (header, row, row, ..., header, row, ...),
 * skipping rows of collapsed groups but always emitting the header. The `flatIndex` on
 * row entries indexes into ROWS only — it is what `activeIndex` references.
 *
 * Headers are suppressed when only one group exists: the grouping UI has no value
 * with a single bucket and the header would just be a destructive collapse-all toggle.
 */
export function buildVisibleRows(groups: NavigatorGroup[], collapsed: Set<string>): VisibleRow[] {
  const out: VisibleRow[] = [];
  const showHeaders = groups.length > 1;
  let flatIndex = 0;
  for (const g of groups) {
    const isCollapsed = showHeaders && collapsed.has(g.key);
    if (showHeaders) {
      out.push({
        kind: "header",
        key: g.key,
        title: g.title,
        count: g.prompts.length,
        collapsed: isCollapsed,
      });
    }
    if (isCollapsed) continue;
    for (const prompt of g.prompts) {
      out.push({ kind: "row", prompt, flatIndex });
      flatIndex += 1;
    }
  }
  return out;
}

/**
 * Counts visible rows (entries with kind === 'row'). Used to clamp keyboard navigation.
 */
export function countVisibleRows(rows: VisibleRow[]): number {
  let count = 0;
  for (const r of rows) if (r.kind === "row") count += 1;
  return count;
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
