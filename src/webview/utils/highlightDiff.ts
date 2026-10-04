import { getHighlighter, normalizeLanguage, type HighlightTheme } from '@/composables/useShikiHighlighter';
import type { DiffLine } from './parseUnifiedDiff';
import { escapeHtml } from './stringUtils';

export interface HighlightedDiffLine extends DiffLine {
  highlightedContent: string;
}

const MAX_HIGHLIGHT_LINES = 1000;

/** Gap and end-of-file marker rows hold no code, so they stay out of the highlighted text. */
function isCode(line: DiffLine): boolean {
  return line.type !== 'gap' && line.type !== 'noNewline';
}

export async function highlightDiffLines(
  lines: DiffLine[],
  language: string,
  theme: HighlightTheme
): Promise<HighlightedDiffLine[]> {
  if (lines.length > MAX_HIGHLIGHT_LINES || lines.length === 0) {
    return lines.map((line) => ({
      ...line,
      highlightedContent: escapeHtml(line.content),
    }));
  }

  try {
    const normalizedLang = normalizeLanguage(language);
    const highlighter = await getHighlighter(normalizedLang, theme);

    const contentLines = lines
      .filter(isCode)
      .map((l) => l.content);

    if (contentLines.length === 0) {
      return lines.map((line) => ({
        ...line,
        highlightedContent: escapeHtml(line.content),
      }));
    }

    const fullCode = contentLines.join('\n');
    const html = highlighter.codeToHtml(fullCode, {
      lang: normalizedLang,
      theme,
      transformers: [
        {
          pre(node) {
            node.properties.style = 'padding:0;margin:0;background:transparent;';
            return node;
          },
        },
      ],
    });

    const highlightedLines = extractLinesFromHtml(html);

    let highlightIdx = 0;

    return lines.map((line) => {
      if (!isCode(line)) {
        return { ...line, highlightedContent: '' };
      }
      const highlighted = highlightedLines[highlightIdx++] || escapeHtml(line.content);
      return { ...line, highlightedContent: highlighted };
    });
  } catch (error) {
    console.error('[highlightDiff] Failed to highlight:', error);
    return lines.map((line) => ({
      ...line,
      highlightedContent: escapeHtml(line.content),
    }));
  }
}

function extractLinesFromHtml(html: string): string[] {
  const template = document.createElement('template');
  template.innerHTML = html;

  const codeElement = template.content.querySelector('code');
  if (!codeElement) return [];

  const lineSpans = codeElement.querySelectorAll(':scope > .line');
  if (lineSpans.length > 0) {
    return Array.from(lineSpans).map((span) => span.innerHTML);
  }

  return codeElement.innerHTML.split('\n');
}
