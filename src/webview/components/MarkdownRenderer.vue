<script setup lang="ts">
import { computed, h, type VNode } from 'vue';
import { marked, type Token, type Tokens } from 'marked';
import CodeBlock from './CodeBlock.vue';
import RemoteImagePlaceholder from './RemoteImagePlaceholder.vue';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { sanitizeUrl } from '@/lib/sanitize-url';

const props = withDefaults(
  defineProps<{
    content: string;
    /** When set (e.g. WebFetch's source URL), relative image/link hrefs are resolved against it so
     *  extracted web content renders correctly. Omitted for normal messages → hrefs pass through. */
    baseUrl?: string | undefined;
    /** Gate remote images behind click-to-load. Default true (chat unchanged); Memory panel passes false. */
    allowRemoteImages?: boolean | undefined;
  }>(),
  { baseUrl: undefined, allowRemoteImages: true }
);

const { postMessage } = usePlatformBridge();

/** Resolve a possibly-relative href against `baseUrl`, then sanitize dangerous schemes. */
function resolveUrl(href: string): string {
  const resolved = (() => {
    if (!props.baseUrl) return href;
    try {
      return new URL(href, props.baseUrl).href;
    } catch {
      return href;
    }
  })();
  return sanitizeUrl(resolved);
}

const tokens = computed(() => {
  try {
    return marked.lexer(props.content);
  } catch {
    return [];
  }
});

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isLocalPath(href: string): boolean {
  return href.startsWith('file://') || href.startsWith('/') || !href.includes('://');
}

function isAbsolutePath(filePath: string): boolean {
  if (filePath.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\\/]/.test(filePath)) return true;
  return false;
}

function handleLinkClick(e: MouseEvent, href: string) {
  if (href === '#') {
    e.preventDefault();
    return;
  }
  if (!isLocalPath(href)) return;

  e.preventDefault();

  let filePath = href.replace('file://', '');

  const match = filePath.match(/(.*):(\d+)(-\d+)?$/);
  let values: { line: number } | undefined;
  if (match?.[1] !== undefined && match[2] !== undefined) {
    filePath = match[1];
    values = { line: parseInt(match[2]) };
  }

  if (!isAbsolutePath(filePath) && !filePath.startsWith('./')) {
    filePath = './' + filePath;
  }

  postMessage({
    type: 'openFile',
    filePath,
    ...(values !== undefined && { line: values.line }),
  });
}

function renderInlineTokens(tokens: Token[] | undefined): VNode[] {
  if (!tokens) return [];
  return tokens.map(renderToken).filter((v): v is VNode => v !== null);
}

function renderToken(token: Token): VNode | null {
  switch (token.type) {
    case 'heading':
      return h(
        `h${(token as Tokens.Heading).depth}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6',
        { class: 'markdown-heading' },
        renderInlineTokens((token as Tokens.Heading).tokens)
      );

    case 'paragraph':
      return h('p', { class: 'markdown-p' }, renderInlineTokens((token as Tokens.Paragraph).tokens));

    case 'text': {
      const textToken = token as Tokens.Text;
      if ('tokens' in textToken && textToken.tokens) {
        return h('span', {}, renderInlineTokens(textToken.tokens));
      }
      return h('span', { innerHTML: escapeHtml(textToken.text || (textToken as any).raw || '') });
    }

    case 'strong':
      return h('strong', {}, renderInlineTokens((token as Tokens.Strong).tokens));

    case 'em':
      return h('em', {}, renderInlineTokens((token as Tokens.Em).tokens));

    case 'del':
      return h('del', {}, renderInlineTokens((token as Tokens.Del).tokens));

    case 'codespan':
      return h('code', { class: 'inline-code' }, (token as Tokens.Codespan).text);

    case 'code': {
      const codeToken = token as Tokens.Code;
      return h(CodeBlock, {
        code: codeToken.text,
        language: codeToken.lang || 'text',
      });
    }

    case 'link': {
      const linkToken = token as Tokens.Link;
      const href = resolveUrl(linkToken.href);
      return h(
        'a',
        {
          href,
          title: linkToken.title || undefined,
          target: isLocalPath(href) ? undefined : '_blank',
          rel: isLocalPath(href) ? undefined : 'noopener noreferrer',
          onClick: (e: MouseEvent) => handleLinkClick(e, href),
        },
        renderInlineTokens(linkToken.tokens)
      );
    }

    case 'image': {
      const imgToken = token as Tokens.Image;
      const src = resolveUrl(imgToken.href);
      // A sanitized-away src ('#') is not a loadable image; show a static blocked-image label instead
      // of a clickable placeholder that would fetch '#' and render broken.
      if (src === '#') {
        return h('span', { class: 'markdown-image-blocked', title: imgToken.title || undefined }, `🚫 ${imgToken.text || 'blocked image'}`);
      }
      // Allowlist, not denylist: a denylist misses uppercase HTTPS:// and scheme-relative //host.
      if (props.allowRemoteImages === false && !src.toLowerCase().startsWith('data:image/')) {
        return h(RemoteImagePlaceholder, { src, alt: imgToken.text, ...(imgToken.title ? { title: imgToken.title } : {}) });
      }
      return h('img', {
        src,
        alt: imgToken.text,
        title: imgToken.title || undefined,
        class: 'markdown-image',
      });
    }

    case 'list': {
      const listToken = token as Tokens.List;
      const Tag = listToken.ordered ? 'ol' : 'ul';
      return h(
        Tag,
        { start: listToken.start || undefined },
        listToken.items.map((item: Tokens.ListItem) =>
          h('li', {}, renderInlineTokens(item.tokens))
        )
      );
    }

    case 'blockquote':
      return h(
        'blockquote',
        { class: 'markdown-blockquote' },
        renderInlineTokens((token as Tokens.Blockquote).tokens)
      );

    case 'table': {
      const tableToken = token as Tokens.Table;
      return h('div', { class: 'table-wrapper' }, [
        h('table', { class: 'markdown-table' }, [
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              tableToken.header.map((cell, i) =>
                h(
                  'th',
                  { style: { textAlign: tableToken.align[i] || undefined } },
                  renderInlineTokens(cell.tokens)
                )
              )
            )
          ),
          h(
            'tbody',
            {},
            tableToken.rows.map((row) =>
              h(
                'tr',
                {},
                row.map((cell, i) =>
                  h(
                    'td',
                    { style: { textAlign: tableToken.align[i] || undefined } },
                    renderInlineTokens(cell.tokens)
                  )
                )
              )
            )
          ),
        ]),
      ]);
    }

    case 'hr':
      return h('hr', { class: 'markdown-hr' });

    case 'br':
      return h('br');

    case 'html': {
      const htmlToken = token as Tokens.HTML;
      return h('span', { innerHTML: escapeHtml(htmlToken.raw) });
    }

    case 'space':
      return null;

    default:
      if ('raw' in token && typeof token.raw === 'string') {
        return h('span', { innerHTML: escapeHtml(token.raw) });
      }
      return null;
  }
}

function renderTokens(tokens: Token[]): VNode[] {
  return tokens.map(renderToken).filter((v): v is VNode => v !== null);
}
</script>

<template>
  <div class="markdown-renderer">
    <component :is="() => renderTokens(tokens)" />
  </div>
</template>

<style scoped>
.markdown-renderer {
  color: var(--d-text);
}

.markdown-renderer :deep(.markdown-heading) {
  margin-top: 1rem;
  margin-bottom: 0.5rem;
  font-weight: 600;
  color: var(--d-text);
}

.markdown-renderer :deep(h1) {
  font-size: 1.5em;
}

.markdown-renderer :deep(h2) {
  font-size: 1.3em;
}

.markdown-renderer :deep(h3) {
  font-size: 1.1em;
}

.markdown-renderer :deep(.markdown-p) {
  margin: 0.5rem 0;
}

.markdown-renderer :deep(.inline-code) {
  background-color: var(--d-hover);
  color: var(--d-accent-text);
  padding: 0.0625rem 0.375rem;
  border-radius: 0.3125rem;
  font-family: var(--d-mono);
  font-size: 0.89em;
}

.markdown-renderer :deep(a) {
  color: var(--d-text);
  text-decoration: underline;
}

.markdown-renderer :deep(a:hover) {
  text-decoration: underline;
  opacity: 0.8;
}

.markdown-renderer :deep(ul) {
  list-style-type: disc;
  margin: 0.5rem 0;
  padding-left: 1.25rem;
}

.markdown-renderer :deep(ol) {
  list-style-type: decimal;
  margin: 0.5rem 0;
  padding-left: 1.25rem;
}

.markdown-renderer :deep(li) {
  margin: 0.25rem 0;
}

.markdown-renderer :deep(ul > li::marker) {
  color: var(--d-accent);
}

.markdown-renderer :deep(.markdown-blockquote) {
  border-left: 3px solid var(--d-border2);
  margin: 0.5rem 0;
  padding: 0.5rem 0.75rem;
  color: var(--d-text);
  background: var(--d-code);
  border-radius: 0 0.25rem 0.25rem 0;
}

.markdown-renderer :deep(.table-wrapper) {
  overflow-x: auto;
  margin: 0.5rem 0;
  background: var(--d-code);
  border-radius: 0.75rem;
  border: 1px solid var(--d-border);
  box-shadow: 0 4px 12px -2px rgba(0, 0, 0, 0.25), 0 2px 6px -1px rgba(0, 0, 0, 0.2);
}

.markdown-renderer :deep(.markdown-table) {
  border-collapse: collapse;
  width: 100%;
}

.markdown-renderer :deep(th),
.markdown-renderer :deep(td) {
  border: 1px solid var(--d-border);
  padding: 0.5rem 0.75rem;
  text-align: left;
}

.markdown-renderer :deep(th) {
  background-color: var(--d-card);
  color: var(--d-text);
  font-weight: 600;
}

.markdown-renderer :deep(tr:nth-child(even)) {
  background-color: color-mix(in srgb, var(--d-hover) 50%, transparent);
}

.markdown-renderer :deep(tr:hover) {
  background-color: var(--d-hover);
  transition: background-color 0.15s ease;
}

.markdown-renderer :deep(strong) {
  color: var(--d-text);
  font-weight: 600;
}

.markdown-renderer :deep(em) {
  color: var(--d-text);
}

.markdown-renderer :deep(.markdown-hr) {
  border: none;
  border-top: 1px solid var(--d-border);
  margin: 1rem 0;
}

.markdown-renderer :deep(.markdown-image) {
  max-width: 100%;
  border-radius: 0.25rem;
}

.markdown-renderer :deep(.markdown-image-blocked) {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.0625rem 0.375rem;
  font-size: 0.85em;
  color: var(--d-muted);
  border: 1px dashed var(--d-border);
  border-radius: 0.25rem;
}
</style>
