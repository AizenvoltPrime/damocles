// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';
import { buildFileDiff } from '../parseUnifiedDiff';
import { highlightDiffLines } from '../highlightDiff';

/** The text a highlighted row shows, without Shiki's markup. */
function shownText(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content.textContent ?? '';
}

describe('highlightDiffLines', () => {
  it('keeps each row\'s highlighted code on its own row across gap and no-newline markers', async () => {
    const middle = Array.from({ length: 12 }, (_, i) => `const k${i} = ${i};`);
    // The old side ends without a line end, so the marker sits before every added line.
    const before = ['const a = 1;', ...middle, 'const b = 2;'].join('\n');
    const after = ['const a = 10;', ...middle, 'const b = 2;', 'const c = 3;', 'const d = 4;', ''].join('\n');
    const diff = buildFileDiff({
      kind: 'patch',
      patch: createTwoFilesPatch('f.ts', 'f.ts', before, after, undefined, undefined, { context: 4, headerOptions: FILE_HEADERS_ONLY })!,
    });
    expect(diff.lines.map((l) => l.type)).toContain('gap');
    expect(diff.lines.slice(-5).map((l) => l.type)).toEqual(['deletion', 'noNewline', 'addition', 'addition', 'addition']);

    const highlighted = await highlightDiffLines(diff.lines, 'typescript', 'github-dark');

    expect(highlighted.map((line) => shownText(line.highlightedContent))).toEqual(
      diff.lines.map((line) => (line.type === 'gap' || line.type === 'noNewline' ? '' : line.content)),
    );
    expect(highlighted.find((line) => line.content === 'const c = 3;')?.highlightedContent).toContain('<span');
  });
});
