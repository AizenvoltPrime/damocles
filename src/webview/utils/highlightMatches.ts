import { escapeHtml } from '@shared/utils';

export function escapeRegex(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Escaped `text` for v-html with up to `limit` case-insensitive matches of `query` wrapped in `open` and `close`.
 * It matches the raw text and escapes each piece, so a match never lands inside an entity or drifts after a character whose lowercase is longer.
 */
export function highlightMatches(text: string, query: string, open: string, close: string, limit = Infinity): string {
  if (!query) return escapeHtml(text);
  let html = '';
  let end = 0;
  let count = 0;
  for (const match of text.matchAll(new RegExp(escapeRegex(query), 'giu'))) {
    if (count++ >= limit) break;
    html += `${escapeHtml(text.slice(end, match.index))}${open}${escapeHtml(match[0])}${close}`;
    end = match.index + match[0].length;
  }
  return html + escapeHtml(text.slice(end));
}

/** The @-mention and slash command popups' highlight: the first match in bold accent text. */
export function highlightFirstMatch(text: string, query: string): string {
  return highlightMatches(text, query, '<span class="text-(--d-accent-text) font-bold">', '</span>', 1);
}
