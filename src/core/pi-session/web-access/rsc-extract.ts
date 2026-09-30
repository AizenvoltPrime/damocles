/* Adapted from pi-web-access (MIT). Copyright (c) 2025 Nico Bailon. See THIRD-PARTY-NOTICES.md. */

/**
 * RSC Content Extractor — dependency-free.
 *
 * Extracts readable content from Next.js React Server Components (RSC) flight payloads. RSC pages embed
 * content as JSON in `<script>self.__next_f.push([...])</script>` tags. Lifted whole from
 * `pi-web-access/rsc-extract.ts` (Phase 7, US-028.2); used as a fallback when Readability finds nothing.
 */

export interface RSCExtractResult {
  title: string;
  content: string;
}

/**
 * Recursion-depth cap for the tree walkers. V8's JSON.parse is iterative (no depth limit), so a crafted
 * deeply-nested flight payload within the body-size cap could otherwise drive `extractNode` to stack
 * exhaustion. 1000 is far above any real RSC tree (~tens deep) and well below the call-stack limit.
 */
const MAX_RSC_DEPTH = 1000;

/** Loose shape for an RSC element's props bag (`node[3]`); declared keys allow dot access under strict mode. */
interface RscProps {
  children?: unknown;
  baseId?: unknown;
  role?: unknown;
  href?: unknown;
  [key: string]: unknown;
}

export function extractRSCContent(html: string): RSCExtractResult | null {
  if (!html.includes('self.__next_f.push')) {
    return null;
  }

  const chunkMap = new Map<string, string>();
  const scriptRegex = /<script>self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g;

  for (const match of html.matchAll(scriptRegex)) {
    let content: string;
    try {
      content = JSON.parse('"' + match[1] + '"');
    } catch {
      continue;
    }

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;

      const colonIdx = line.indexOf(':');
      if (colonIdx <= 0 || colonIdx > 4) continue;

      const id = line.slice(0, colonIdx);
      if (!/^[0-9a-f]+$/i.test(id)) continue;

      const payload = line.slice(colonIdx + 1);
      if (!payload) continue;

      const existing = chunkMap.get(id);
      if (!existing || payload.length > existing.length) {
        chunkMap.set(id, payload);
      }
    }
  }

  if (chunkMap.size === 0) return null;

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/);
  const title = titleMatch?.[1]?.split('|')[0]?.trim() || '';

  const parsedCache = new Map<string, unknown>();

  function getParsedChunk(id: string): unknown | null {
    if (parsedCache.has(id)) return parsedCache.get(id);

    const chunk = chunkMap.get(id);
    if (!chunk || !chunk.startsWith('[')) {
      parsedCache.set(id, null);
      return null;
    }

    try {
      const parsed = JSON.parse(chunk);
      parsedCache.set(id, parsed);
      return parsed;
    } catch {
      parsedCache.set(id, null);
      return null;
    }
  }

  type Node = unknown;
  const visitedRefs = new Set<string>();

  function extractNode(node: Node, ctx = { inTable: false, inCode: false }, depth = 0): string {
    if (depth > MAX_RSC_DEPTH) return '';
    if (node === null || node === undefined) return '';

    if (typeof node === 'string') {
      const refMatch = node.match(/^\$L([0-9a-f]+)$/i);
      if (refMatch?.[1]) {
        const refId = refMatch[1];
        if (visitedRefs.has(refId)) return '';
        visitedRefs.add(refId);
        const refNode = getParsedChunk(refId);
        const result = refNode ? extractNode(refNode, ctx, depth + 1) : '';
        visitedRefs.delete(refId);
        return result;
      }
      if (!ctx.inCode && (node === '$undefined' || node === '$' || /^\$[A-Z]/.test(node))) return '';
      return node.trim() ? node : '';
    }

    if (typeof node === 'number') return String(node);
    if (typeof node === 'boolean') return '';
    if (!Array.isArray(node)) return '';

    if (node[0] === '$' && typeof node[1] === 'string') {
      const tag = node[1] as string;
      const props = (node[3] || {}) as RscProps;

      const skipTags = ['script', 'style', 'svg', 'path', 'circle', 'link', 'meta',
        'template', 'button', 'input', 'nav', 'footer', 'aside'];
      if (skipTags.includes(tag)) return '';

      if (tag.startsWith('$L')) {
        const refId = tag.slice(2);
        if (visitedRefs.has(refId)) return '';

        if (props.baseId && props.children) {
          return `## ${String(props.children)}\n\n`;
        }

        visitedRefs.add(refId);
        const refNode = getParsedChunk(refId);
        let result = '';
        if (refNode) {
          result = extractNode(refNode, ctx, depth + 1);
        } else if (props.children) {
          result = extractNode(props.children as Node, ctx, depth + 1);
        }
        visitedRefs.delete(refId);
        return result;
      }

      const children = props.children;
      const content = children ? extractNode(children as Node, ctx, depth + 1) : '';

      switch (tag) {
        case 'h1': return `# ${content.trim()}\n\n`;
        case 'h2': return `## ${content.trim()}\n\n`;
        case 'h3': return `### ${content.trim()}\n\n`;
        case 'h4': return `#### ${content.trim()}\n\n`;
        case 'h5': return `##### ${content.trim()}\n\n`;
        case 'h6': return `###### ${content.trim()}\n\n`;
        case 'p': return ctx.inTable ? content : `${content.trim()}\n\n`;
        case 'code': {
          const codeContent = children ? extractNode(children as Node, { ...ctx, inCode: true }, depth + 1) : '';
          return ctx.inCode ? codeContent : `\`${codeContent}\``;
        }
        case 'pre': {
          const preContent = children ? extractNode(children as Node, { ...ctx, inCode: true }, depth + 1) : '';
          return '```\n' + preContent + '\n```\n\n';
        }
        case 'strong': case 'b': return `**${content}**`;
        case 'em': case 'i': return `*${content}*`;
        case 'li': return `- ${content.trim()}\n`;
        case 'ul': case 'ol': return content + '\n';
        case 'blockquote': return `> ${content.trim()}\n\n`;
        case 'table': return extractTable(node as unknown[], depth + 1) + '\n';
        case 'thead': case 'tbody': case 'tr': case 'th': case 'td':
          return content;
        case 'div':
          if (props.role === 'alert' || props['data-slot'] === 'alert') {
            return `> ${content.trim()}\n\n`;
          }
          return content;
        case 'a': {
          const href = props.href as string | undefined;
          return href && !href.startsWith('#') ? `[${content}](${href})` : content;
        }
        default: return content;
      }
    }

    return (node as Node[]).map((n) => extractNode(n, ctx, depth + 1)).join('');
  }

  function extractTable(tableNode: unknown[], depth = 0): string {
    const props = (tableNode[3] || {}) as RscProps;
    const rows: string[][] = [];
    let headerRowCount = 0;

    function walkTable(node: unknown, isHeader = false, d = depth): void {
      if (d > MAX_RSC_DEPTH) return;
      if (node === null || node === undefined) return;

      if (typeof node === 'string') {
        const refId = node.match(/^\$L([0-9a-f]+)$/i)?.[1];
        if (refId && !visitedRefs.has(refId)) {
          visitedRefs.add(refId);
          const refNode = getParsedChunk(refId);
          if (refNode) walkTable(refNode, isHeader, d + 1);
          visitedRefs.delete(refId);
        }
        return;
      }

      if (!Array.isArray(node)) return;

      if (node[0] === '$') {
        const tag = node[1] as string;
        const nodeProps = (node[3] || {}) as RscProps;

        if (tag.startsWith('$L')) {
          const refId = tag.slice(2);
          if (!visitedRefs.has(refId)) {
            visitedRefs.add(refId);
            const refNode = getParsedChunk(refId);
            if (refNode) walkTable(refNode, isHeader, d + 1);
            visitedRefs.delete(refId);
          }
          return;
        }

        if (tag === 'thead') walkTable(nodeProps.children, true, d + 1);
        else if (tag === 'tbody') walkTable(nodeProps.children, false, d + 1);
        else if (tag === 'tr') {
          const cells: string[] = [];
          walkCells(nodeProps.children, cells, d + 1);
          if (cells.length > 0) {
            rows.push(cells);
            if (isHeader) headerRowCount++;
          }
        } else walkTable(nodeProps.children, isHeader, d + 1);
      } else {
        for (const child of node) walkTable(child, isHeader, d + 1);
      }
    }

    function walkCells(node: unknown, cells: string[], d = depth): void {
      if (d > MAX_RSC_DEPTH) return;
      if (node === null || node === undefined) return;

      if (typeof node === 'string') {
        const refId = node.match(/^\$L([0-9a-f]+)$/i)?.[1];
        if (refId && !visitedRefs.has(refId)) {
          visitedRefs.add(refId);
          const refNode = getParsedChunk(refId);
          if (refNode) walkCells(refNode, cells, d + 1);
          visitedRefs.delete(refId);
        }
        return;
      }

      if (!Array.isArray(node)) return;

      if (node[0] === '$' && (node[1] === 'td' || node[1] === 'th')) {
        const cellProps = (node[3] || {}) as RscProps;
        const text = extractNode(cellProps.children, { inTable: true, inCode: false }, d + 1)
          .trim()
          .replace(/\n/g, ' ')
          .replace(/\\/g, '\\\\')
          .replace(/\|/g, '\\|');
        cells.push(text);
      } else if (node[0] === '$' && typeof node[1] === 'string' && (node[1] as string).startsWith('$L')) {
        const refId = (node[1] as string).slice(2);
        if (!visitedRefs.has(refId)) {
          visitedRefs.add(refId);
          const refNode = getParsedChunk(refId);
          if (refNode) walkCells(refNode, cells, d + 1);
          visitedRefs.delete(refId);
        }
      } else {
        for (const child of node) walkCells(child, cells, d + 1);
      }
    }

    walkTable(props.children);
    if (rows.length === 0) return '';

    const colCount = Math.max(...rows.map((r) => r.length));
    let md = '';
    for (let i = 0; i < rows.length; i++) {
      const cells = rows[i]!;
      const row = cells.concat(Array(colCount - cells.length).fill(''));
      md += '| ' + row.join(' | ') + ' |\n';
      if (i === headerRowCount - 1 || (headerRowCount === 0 && i === 0)) {
        md += '| ' + Array(colCount).fill('---').join(' | ') + ' |\n';
      }
    }
    return md;
  }

  const mainChunk = getParsedChunk('23');

  if (mainChunk) {
    const content = extractNode(mainChunk);
    if (content.trim().length > 100) {
      const cleaned = content.replace(/\n{3,}/g, '\n\n').trim();
      return { title, content: cleaned };
    }
  }

  const contentParts: { order: number; text: string }[] = [];

  for (const [id] of chunkMap) {
    if (id === '23') continue;
    const parsed = getParsedChunk(id);
    if (!parsed) continue;

    visitedRefs.clear();
    const text = extractNode(parsed);

    if (text.trim().length > 50 &&
      !text.includes('page was not found') &&
      !text.includes('404')) {
      contentParts.push({ order: parseInt(id, 16), text: text.trim() });
    }
  }

  if (contentParts.length === 0) return null;

  contentParts.sort((a, b) => a.order - b.order);

  const seen = new Set<string>();
  const uniqueParts: string[] = [];
  for (const part of contentParts) {
    const key = part.text.slice(0, 150);
    if (!seen.has(key)) {
      seen.add(key);
      uniqueParts.push(part.text);
    }
  }

  const content = uniqueParts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return content.length > 100 ? { title, content } : null;
}
