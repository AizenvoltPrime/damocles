import createDOMPurify from 'dompurify';
import { marked } from 'marked';

// No img, picture, video, iframe, object, svg, style or form: a preview never loads anything (the shell CSP allows no remote
// image), and the file's raw HTML renders only through this allowlist.
const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'del', 'code', 'pre',
  'blockquote', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input', 'span',
];
// http(s), an in-page anchor, or a path with no scheme (another file of the project, opened through main).
const ALLOWED_URI = /^(?:https?:\/\/|#|(?![a-z][a-z0-9+.-]*:)[^\s]*$)/i;
// The only classes a preview keeps: the image placeholder and a code block's language. Any other class could reach the
// shell's own utilities (`fixed inset-0`) and cover the window with the file's links.
const ALLOWED_CLASS = /^(?:md-preview-image|language-[\w-]+)$/;

// A purifier of its own, so these hooks never reach the release notes' sanitizer.
const purifier = createDOMPurify(window);
purifier.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'class' && !ALLOWED_CLASS.test(data.attrValue)) data.keepAttr = false;
});
// A task list's box is the only input a preview shows, and it is never editable.
purifier.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName !== 'INPUT') return;
  node.setAttribute('type', 'checkbox');
  node.setAttribute('disabled', '');
});

/** A markdown file as sanitized HTML for the preview tab; an image shows as its alt text. */
export function markdownPreviewHtml(source: string): string {
  const renderer = new marked.Renderer();
  renderer.image = ({ text }) => `<span class="md-preview-image">${escapeText(text)}</span>`;
  const html = marked.parse(source, { async: false, gfm: true, renderer });
  return purifier.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'title', 'class', 'checked', 'align'],
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: ALLOWED_URI,
  });
}

function escapeText(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export type PreviewLink = { kind: 'external' } | { kind: 'anchor'; id: string } | { kind: 'file'; relativePath: string };

// A link with a malformed escape names nothing to follow.
function decoded(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/** What a click on a preview link does: http(s) opens in the browser, an anchor scrolls, a relative path opens beside it. */
export function previewLink(href: string, documentPath: string | undefined): PreviewLink | undefined {
  if (/^https?:\/\//i.test(href)) return { kind: 'external' };
  if (href.startsWith('#')) {
    const id = decoded(href.slice(1));
    return id === undefined ? undefined : { kind: 'anchor', id };
  }
  if (documentPath === undefined || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) return undefined;
  const target = decoded(href.split('#')[0]?.split('?')[0] ?? '');
  if (!target) return undefined;
  const parts = documentPath.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.length === 0 ? undefined : { kind: 'file', relativePath: parts.join('/') };
}
