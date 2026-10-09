import DOMPurify from 'dompurify';
import { marked } from 'marked';

// No img, picture, video or iframe: the overlay CSP has no remote img-src, and notes never load anything.
const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'del', 'code', 'pre',
  'blockquote', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
];
const SECTIONS: ReadonlySet<string> = new Set(['added', 'changed', 'fixed', 'removed', 'security', 'deprecated']);

/**
 * Release notes (a CHANGELOG.md section, or the update feed's HTML or markdown) as sanitized HTML. Links keep only an
 * http(s) href and open in a new window, which main's window-open handler sends to the browser; Keep a Changelog headings
 * carry data-section for their colour.
 */
export function releaseNotesHtml(source: string): string {
  const html = marked.parse(source, { async: false, gfm: true });
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'title'],
    ALLOWED_URI_REGEXP: /^https?:\/\//i,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const anchor of fragment.querySelectorAll('a[href]')) {
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
  }
  for (const heading of fragment.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const section = heading.textContent?.trim().toLowerCase() ?? '';
    if (SECTIONS.has(section)) heading.setAttribute('data-section', section);
  }
  const holder = document.createElement('div');
  holder.append(fragment);
  return holder.innerHTML;
}
