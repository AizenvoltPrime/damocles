import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Fetch/extraction pipeline (US-028.2): Readability path, PDF path (mocked `unpdf`), Jina fallback,
 * non-recoverable error paths, and the libs-unavailable degraded path (PDF parser throws → Jina).
 * `fetch` and `unpdf` are mocked; linkedom + Readability + turndown run for real on a fixture.
 */

const { getDocumentProxyMock, lookupMock } = vi.hoisted(() => ({
  getDocumentProxyMock: vi.fn(),
  lookupMock: vi.fn(),
}));
vi.mock('unpdf', () => ({ getDocumentProxy: getDocumentProxyMock }));

// Keep the SSRF guard's DNS resolution hermetic and per-test controllable.
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import { extractUrl, extractUrls } from '../extract';

const ARTICLE_HTML = `<!doctype html><html><head><title>Great Post | Blog</title></head><body>
<header><nav>menu links here</nav></header>
<article>
<h1>Understanding Widgets</h1>
<p>Widgets are small reusable components that encapsulate behavior and presentation. This paragraph exists to give the readability algorithm enough textual content to consider the article meaningful and extractable.</p>
<p>In practice a widget combines state, rendering, and event handling. Developers compose widgets into larger trees, and each widget can be tested in isolation, which keeps the overall system maintainable over time.</p>
<p>This third paragraph adds further substance so the extracted markdown comfortably exceeds the minimum useful content threshold that the extractor enforces before accepting a result as complete.</p>
</article>
<footer>copyright</footer>
</body></html>`;

function htmlResponse(html: string, status = 200, contentType = 'text/html'): Response {
  return new Response(html, { status, headers: { 'content-type': contentType } });
}

function pdfResponse(): Response {
  return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/pdf' } });
}

function jinaResponse(markdown: string): Response {
  return new Response(`Title: Some Page\n\nMarkdown Content:\n${markdown}`, {
    status: 200,
    headers: { 'content-type': 'text/markdown' },
  });
}

const fakePdf = {
  numPages: 2,
  getMetadata: async () => ({ info: { Title: 'My Paper', Author: 'Jane Doe' } }),
  getPage: async (n: number) => ({
    getTextContent: async () => ({ items: [{ str: `Page ${n} body text with enough words to be useful.` }] }),
  }),
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  getDocumentProxyMock.mockReset();
  getDocumentProxyMock.mockResolvedValue(fakePdf);
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractUrl — HTML', () => {
  it('extracts readable markdown via Readability without hitting Jina', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('https://r.jina.ai/')) throw new Error('Jina should not be called');
      return Promise.resolve(htmlResponse(ARTICLE_HTML));
    });
    const result = await extractUrl('https://example.com/post');
    expect(result.error).toBeNull();
    expect(result.title).toContain('Great Post');
    expect(result.markdown).toContain('Understanding Widgets');
    expect(result.markdown).toContain('Widgets are small reusable components');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('extractUrl — relative URLs', () => {
  it('rewrites relative image/link URLs to absolute against the page URL', async () => {
    const html = `<!doctype html><html><head><title>Rel</title></head><body><article>
<h1>Relative Assets</h1>
<p>See the <a href="/docs/guide">guide</a> for details about this topic, which needs enough words here to pass the readability minimum-content threshold so the article is accepted as complete and usable content for the extractor pipeline under test.</p>
<p><img src="/assets/pic.webp" alt="a picture"> plus more descriptive paragraph text to comfortably exceed the minimum useful content length the extractor requires before returning a result instead of treating the page as too thin to parse.</p>
<p>A third paragraph adds further substance so the extracted markdown comfortably clears the minimum-content threshold and the readability algorithm keeps the article body rather than discarding it as boilerplate or navigation chrome.</p>
</article></body></html>`;
    fetchMock.mockResolvedValue(htmlResponse(html));
    const result = await extractUrl('https://example.com/blog/post');
    expect(result.error).toBeNull();
    expect(result.markdown).toContain('https://example.com/assets/pic.webp');
    expect(result.markdown).toContain('https://example.com/docs/guide');
    expect(result.markdown).not.toContain('](/assets/pic.webp)');
  });
});

describe('extractUrl — GitHub blob normalization', () => {
  it('fetches the raw.githubusercontent.com URL for a github blob URL but reports the requested URL', async () => {
    const blob = 'https://github.com/lodash/lodash/blob/4.17.21/debounce.js';
    const raw = 'https://raw.githubusercontent.com/lodash/lodash/4.17.21/debounce.js';
    fetchMock.mockImplementation((u: string) => {
      if (u === raw) return Promise.resolve(htmlResponse('function debounce(func, wait) { /* impl */ }', 200, 'text/plain'));
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });
    const result = await extractUrl(blob);
    expect(fetchMock).toHaveBeenCalledWith(raw, expect.anything());
    expect(result.error).toBeNull();
    expect(result.markdown).toContain('function debounce');
    expect(result.url).toBe(blob);
  });

  it('also normalizes the /raw/ view path and leaves non-blob github URLs untouched', async () => {
    fetchMock.mockImplementation((u: string) =>
      Promise.resolve(htmlResponse(`fetched: ${u}`, 200, 'text/plain')),
    );
    await extractUrl('https://github.com/a/b/raw/main/x.txt');
    expect(fetchMock).toHaveBeenLastCalledWith('https://raw.githubusercontent.com/a/b/main/x.txt', expect.anything());

    fetchMock.mockClear();
    await extractUrl('https://github.com/a/b/tree/main/dir');
    expect(fetchMock).toHaveBeenLastCalledWith('https://github.com/a/b/tree/main/dir', expect.anything());
  });
});

describe('extractUrl — PDF', () => {
  it('extracts PDF text inline (no disk write) with metadata title', async () => {
    fetchMock.mockResolvedValue(pdfResponse());
    const result = await extractUrl('https://example.com/paper.pdf');
    expect(result.error).toBeNull();
    expect(result.title).toBe('My Paper');
    expect(result.markdown).toContain('# My Paper');
    expect(result.markdown).toContain('Page 1 body text');
    expect(getDocumentProxyMock).toHaveBeenCalledOnce();
  });
});

describe('extractUrl — Jina fallback', () => {
  it('falls back to the Jina reader on a recoverable HTTP error', async () => {
    const readerMd = '# Recovered\n\nReader content body that is comfortably longer than the one hundred character minimum the Jina branch enforces before accepting a result.';
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith('https://r.jina.ai/') ? jinaResponse(readerMd) : htmlResponse('', 404)),
    );
    const result = await extractUrl('https://example.com/missing');
    expect(result.error).toBeNull();
    expect(result.markdown).toContain('Reader content body');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('degrades to Jina when the PDF parser throws (libs-unavailable path)', async () => {
    getDocumentProxyMock.mockRejectedValue(new Error('pdfjs unavailable'));
    const readerMd = '# PDF via reader\n\nReader-extracted PDF text that exceeds the one hundred character minimum so the Jina fallback branch accepts and returns it as the result.';
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith('https://r.jina.ai/') ? jinaResponse(readerMd) : pdfResponse()),
    );
    const result = await extractUrl('https://example.com/paper.pdf');
    expect(result.error).toBeNull();
    expect(result.markdown).toContain('Reader-extracted PDF text');
  });
});

describe('extractUrl — non-recoverable', () => {
  it('rejects an unsupported binary content type without calling Jina', async () => {
    fetchMock.mockResolvedValue(htmlResponse('binary', 200, 'image/png'));
    const result = await extractUrl('https://example.com/pic.png');
    expect(result.error).toMatch(/Unsupported content type/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid URL without any fetch', async () => {
    const result = await extractUrl('not a url');
    expect(result.error).toBe('Invalid URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks a URL whose host resolves to a private IP and never reaches the network or Jina', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    const result = await extractUrl('http://metadata.internal/latest/meta-data/');
    expect(result.error).toMatch(/Blocked/);
    expect(fetchMock).not.toHaveBeenCalled(); // neither the direct fetch nor r.jina.ai
  });
});

describe('extractUrls', () => {
  it('fetches multiple URLs, each resolving independently', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes('bad') ? htmlResponse('binary', 200, 'application/zip') : htmlResponse(ARTICLE_HTML)),
    );
    const results = await extractUrls(['https://example.com/good', 'https://example.com/bad']);
    expect(results).toHaveLength(2);
    expect(results[0]!.error).toBeNull();
    expect(results[1]!.error).toMatch(/Unsupported content type/);
  });
});

describe('extractUrl — output controls', () => {
  it('raw:true returns the decoded body verbatim (not Readability markdown) and skips Jina', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('https://r.jina.ai/')) throw new Error('Jina must not be called for raw');
      return Promise.resolve(htmlResponse(ARTICLE_HTML));
    });
    const result = await extractUrl('https://example.com/post', undefined, { raw: true });
    expect(result.error).toBeNull();
    // The verbatim HTML shell is returned — tags are present, not stripped-to-markdown.
    expect(result.markdown).toContain('<article>');
    expect(result.markdown).toContain('<footer>copyright</footer>');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('raw:true on a JS-rendered shell honestly returns the shell rather than falling back to Jina', async () => {
    const shell = '<!doctype html><html><head><title>App</title></head><body><div id="root"></div>' +
      '<script src="a.js"></script><script src="b.js"></script><script src="c.js"></script><script src="d.js"></script></body></html>';
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('https://r.jina.ai/')) throw new Error('Jina must not be called for raw');
      return Promise.resolve(htmlResponse(shell));
    });
    const result = await extractUrl('https://example.com/app', undefined, { raw: true });
    expect(result.error).toBeNull();
    expect(result.markdown).toContain('<div id="root"></div>');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maxChars truncates the output with the marker', async () => {
    const para =
      '<p>Widgets are small reusable components that encapsulate behavior and presentation, and this sentence is padded so the paragraph carries enough substance to be kept by the readability algorithm as meaningful article content worth extracting into the final markdown output.</p>';
    const longHtml = `<!doctype html><html><head><title>Long</title></head><body><article><h1>Long Article</h1>${para.repeat(12)}</article></body></html>`;
    fetchMock.mockResolvedValue(htmlResponse(longHtml));
    const result = await extractUrl('https://example.com/post', undefined, { budget: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.markdown).toContain('[Truncated to 1000 characters.]');
    expect(result.markdown.length).toBeLessThan(1100);
  });

  it('clamps a too-small budget up to the 1000-char floor', async () => {
    const para =
      '<p>Widgets are small reusable components that encapsulate behavior and presentation, and this sentence is padded so the paragraph carries enough substance to be kept by the readability algorithm as meaningful article content worth extracting into the final markdown output.</p>';
    const longHtml = `<!doctype html><html><head><title>Long</title></head><body><article><h1>Long Article</h1>${para.repeat(12)}</article></body></html>`;
    fetchMock.mockResolvedValue(htmlResponse(longHtml));
    // A budget of 10 is below the floor; it is raised to 1000, so the truncation marker reads 1000.
    const result = await extractUrl('https://example.com/post', undefined, { budget: 10 });
    expect(result.markdown).toContain('[Truncated to 1000 characters.]');
    expect(result.markdown.length).toBeGreaterThan(100);
  });

  it('clamps a too-large budget down to the 30000-char ceiling', async () => {
    const para =
      '<p>Widgets are small reusable components that encapsulate behavior and presentation, and this sentence is padded so the paragraph carries enough substance to be kept by readability.</p>';
    // ~200 paras of ~180 chars ≈ 36K, above the 30K ceiling, so truncation fires at 30000.
    const longHtml = `<!doctype html><html><head><title>Big</title></head><body><article><h1>Big</h1>${para.repeat(220)}</article></body></html>`;
    fetchMock.mockResolvedValue(htmlResponse(longHtml));
    const result = await extractUrl('https://example.com/post', undefined, { budget: 10_000_000 });
    expect(result.truncated).toBe(true);
    expect(result.markdown).toContain('[Truncated to 30000 characters.]');
    expect(result.markdown.length).toBeLessThan(30_100);
  });

  it('includeImages:false drops images from the markdown', async () => {
    const html = `<!doctype html><html><head><title>Imgs</title></head><body><article>
<h1>Images Everywhere</h1>
<p>Here is an inline image <img src="/assets/pic.webp" alt="a picture"> embedded in a paragraph that carries more than enough descriptive text to clear the readability minimum-content threshold so the article is accepted as complete and usable by the extractor.</p>
<p>A second paragraph continues the discussion with further meaningful prose so the extracted markdown comfortably exceeds the minimum useful content length before the extractor returns a result instead of discarding the page as too thin.</p>
<p>A third paragraph adds still more substance so readability keeps the article body rather than treating it as boilerplate navigation chrome, ensuring the extraction path under test is exercised end to end.</p>
</article></body></html>`;
    fetchMock.mockResolvedValue(htmlResponse(html));
    const result = await extractUrl('https://example.com/imgs', undefined, { includeImages: false });
    expect(result.error).toBeNull();
    expect(result.markdown).not.toContain('![');
    expect(result.markdown).not.toContain('pic.webp');
  });

  it('includeLinks:false renders link text without the URL', async () => {
    const html = `<!doctype html><html><head><title>Links</title></head><body><article>
<h1>Links Everywhere</h1>
<p>See the <a href="https://example.com/docs/guide">official guide</a> for the details, in a paragraph that carries more than enough descriptive text to clear the readability minimum-content threshold so the article is accepted as complete and usable by the extractor.</p>
<p>A second paragraph continues the discussion with further meaningful prose so the extracted markdown comfortably exceeds the minimum useful content length before the extractor returns a result instead of discarding the page as too thin.</p>
<p>A third paragraph adds still more substance so readability keeps the article body rather than treating it as boilerplate navigation chrome, ensuring the extraction path under test is exercised end to end.</p>
</article></body></html>`;
    fetchMock.mockResolvedValue(htmlResponse(html));
    const result = await extractUrl('https://example.com/links', undefined, { includeLinks: false });
    expect(result.error).toBeNull();
    expect(result.markdown).toContain('official guide');
    expect(result.markdown).not.toContain('](https://example.com/docs/guide)');
    expect(result.markdown).not.toContain('(https://example.com/docs/guide)');
  });

  it('SSRF block stays fail-soft under output options', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    const result = await extractUrl('http://intranet.local/', undefined, { raw: true });
    expect(result.error).toMatch(/Blocked/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
