import { describe, it, expect } from 'vitest';
import { extractRSCContent } from '../rsc-extract';

/**
 * RSC flight-payload extractor (US-028.2): the happy path (heading + paragraph → markdown), the
 * no-marker short-circuit, and the recursion depth cap (a crafted deeply-nested chunk must not overflow
 * the stack — JSON.parse has no depth limit, so the cap is the guard).
 */

/** Wrap one or more `id:json` chunk lines into a Next.js flight-payload `<script>` tag. */
function rscHtml(chunkLines: string[], title = 'Test Page'): string {
  const payload = JSON.stringify(chunkLines.join('\n')).slice(1, -1); // JSON-escape, drop the outer quotes
  return `<html><head><title>${title}</title></head><body><script>self.__next_f.push([1,"${payload}"])</script></body></html>`;
}

describe('extractRSCContent', () => {
  it('returns null when the page has no RSC flight payload', () => {
    expect(extractRSCContent('<html><body><p>plain</p></body></html>')).toBeNull();
  });

  it('extracts headings and paragraphs from the main chunk', () => {
    const longBody =
      'Widgets are small reusable components that encapsulate behavior and presentation, with enough text to clear the extractor minimum.';
    const chunk23 = JSON.stringify([
      '$',
      'div',
      null,
      {
        children: [
          ['$', 'h1', null, { children: 'Understanding Widgets' }],
          ['$', 'p', null, { children: longBody }],
        ],
      },
    ]);
    const result = extractRSCContent(rscHtml([`23:${chunk23}`]));
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Test Page');
    expect(result!.content).toContain('# Understanding Widgets');
    expect(result!.content).toContain('Widgets are small reusable components');
  });

  it('does not stack-overflow on a deeply nested chunk (depth cap)', () => {
    const deep = '['.repeat(20000) + ']'.repeat(20000); // 20k-deep array — would overflow uncapped recursion
    let result: ReturnType<typeof extractRSCContent> | undefined;
    expect(() => {
      result = extractRSCContent(rscHtml([`23:${deep}`]));
    }).not.toThrow();
    expect(result).toBeNull(); // capped traversal yields no usable content
  });
});
