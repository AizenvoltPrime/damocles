/* Adapted from pi-web-access (MIT). Copyright (c) 2025 Nico Bailon. See THIRD-PARTY-NOTICES.md. */

/**
 * URL → markdown extraction for `WebFetch`, with a resilient fallback chain (Phase 7, US-028.2).
 * HTTP fetch → PDF (`unpdf`, text returned INLINE — no disk write) / HTML (`linkedom` + Readability +
 * `turndown`, then Next.js RSC) → Jina Reader (`r.jina.ai`, dependency-free). A focused rewrite of
 * `pi-web-access/extract.ts`: only `extractViaHttp` + `extractWithJinaReader` + the title helpers are
 * reused; the video/YouTube/GitHub/Gemini routing in the upstream `extractContent` is dropped, as is
 * the PDF `~/Downloads` write. Output is bounded by an adaptive per-item budget (~30K single / ~10K
 * multi). The Jina path needs no libs, so `WebFetch` degrades gracefully if the HTML/PDF parsers throw.
 */

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { getDocumentProxy } from 'unpdf';
import { extractRSCContent } from './rsc-extract';
import { safeFetch, readBodyCapped, assertPublicUrl } from './safe-fetch';
import { mapWithConcurrency, withTimeout, errorMessage, isAbortError } from './util';

const DEFAULT_TIMEOUT_MS = 30_000;
const JINA_READER_BASE = 'https://r.jina.ai/';
const MIN_USEFUL_CONTENT = 500;
const MAX_PDF_PAGES = 100;
const CONCURRENT_LIMIT = 3;
/** Adaptive inline budget: a single URL gets the full slice; each URL in a batch gets a smaller one. */
export const SINGLE_URL_BUDGET = 30_000;
const MULTI_URL_BUDGET = 10_000;
/** Floor for a requested `maxChars`; smaller requests are raised to this so a result is never pointless. */
export const MIN_CHAR_BUDGET = 1000;
/** Byte cap for the Jina reader response, mirroring the direct-fetch HTML cap (prevents OOM on a huge body). */
const JINA_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const NON_RECOVERABLE_ERRORS = ['Unsupported content type', 'Response too large', 'Invalid URL', 'Blocked'];

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

export interface ExtractedResult {
  url: string;
  title: string;
  markdown: string;
  error: string | null;
  truncated: boolean;
}

/**
 * Output controls for `WebFetch`. `budget` caps the returned characters (clamped to `SINGLE_URL_BUDGET`);
 * `raw` returns the decoded body verbatim (skips Readability/RSC/turndown AND the Jina fallback);
 * `includeLinks`/`includeImages` (default true) toggle links/images in the extracted markdown.
 */
export interface ExtractOptions {
  budget?: number;
  raw?: boolean;
  includeLinks?: boolean;
  includeImages?: boolean;
}

interface ResolvedOptions {
  budget: number;
  raw: boolean;
  includeLinks: boolean;
  includeImages: boolean;
}

/** Clamp a requested character budget to a sane floor/ceiling (never above the single-URL slice). */
export function clampBudget(budget: number): number {
  if (!Number.isFinite(budget)) return SINGLE_URL_BUDGET;
  return Math.min(SINGLE_URL_BUDGET, Math.max(MIN_CHAR_BUDGET, Math.floor(budget)));
}

function resolveOptions(opts: ExtractOptions | undefined, defaultBudget: number): ResolvedOptions {
  return {
    budget: clampBudget(opts?.budget ?? defaultBudget),
    raw: opts?.raw ?? false,
    includeLinks: opts?.includeLinks ?? true,
    includeImages: opts?.includeImages ?? true,
  };
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

/**
 * The turndown instance for a request. Returns the shared default when links + images are both kept
 * (the common path); otherwise builds a per-request instance with rules that drop images and/or render
 * links as plain text. Per-request (not mutating the shared singleton) keeps concurrent extractions safe.
 */
function turndownFor(opts: ResolvedOptions): TurndownService {
  if (opts.includeLinks && opts.includeImages) return turndown;
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  if (!opts.includeImages) td.addRule('dropImages', { filter: 'img', replacement: () => '' });
  if (!opts.includeLinks) td.addRule('plainLinks', { filter: 'a', replacement: (content) => content });
  return td;
}

interface MutableEl {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}
interface QueryableDoc {
  querySelectorAll(selector: string): Iterable<MutableEl>;
}

/**
 * Rewrite relative `href`/`src` attributes in the parsed document to absolute URLs against the page
 * URL, IN PLACE before Readability extracts — so the stored markdown carries usable links/images (a
 * relative `/assets/x.png` is useless to the model and unresolvable in any renderer). Fail-soft: any
 * error leaves the document untouched. Mutating the live document (rather than re-parsing Readability's
 * output) avoids a linkedom fragment-serialization quirk where `body.innerHTML` comes back empty.
 */
function absolutizeDocument(doc: QueryableDoc, baseUrl: string, includeImages = true): void {
  const targets = includeImages
    ? ([['a[href]', 'href'], ['img[src]', 'src']] as const)
    : ([['a[href]', 'href']] as const);
  for (const [sel, attr] of targets) {
    for (const el of doc.querySelectorAll(sel)) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      try {
        el.setAttribute(attr, new URL(value, baseUrl).href);
      } catch {
        // leave non-resolvable values (e.g. data:, mailto:) untouched
      }
    }
  }
}

function failure(url: string, error: string): ExtractedResult {
  return { url, title: '', markdown: '', error, truncated: false };
}

function truncate(markdown: string, budget: number): { markdown: string; truncated: boolean } {
  if (markdown.length <= budget) return { markdown, truncated: false };
  return { markdown: markdown.slice(0, budget).trimEnd() + `\n\n[Truncated to ${budget} characters.]`, truncated: true };
}

export function extractHeadingTitle(text: string): string | null {
  const captured = text.match(/^#{1,2}\s+(.+)/m)?.[1];
  if (!captured) return null;
  const cleaned = captured.replace(/\*+/g, '').trim();
  return cleaned || null;
}

function fallbackTitle(url: string): string {
  try {
    return new URL(url).pathname.split('/').pop() || url;
  } catch {
    return url;
  }
}

function extractTextTitle(text: string, url: string): string {
  return extractHeadingTitle(text) ?? fallbackTitle(url);
}

/** Title from a PDF: metadata `Title`, else a cleaned URL-derived name (arxiv ids handled). */
function pdfTitle(metaTitle: string | undefined, url: string): string {
  if (metaTitle?.trim()) return metaTitle.trim();
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    let name = path.split('/').pop()?.replace(/\.pdf$/i, '') ?? '';
    if (urlObj.hostname.includes('arxiv.org')) {
      const arxivId = path.match(/\/(?:pdf|abs)\/(\d+\.\d+)/)?.[1];
      if (arxivId) name = `arxiv-${arxivId}`;
    }
    name = name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return name || 'document';
  } catch {
    return 'document';
  }
}

function isPDF(url: string, contentType?: string): boolean {
  if (contentType?.includes('application/pdf')) return true;
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

function isLikelyJSRendered(html: string): boolean {
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1];
  if (!body) return false;
  const textContent = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const scriptCount = (html.match(/<script/gi) || []).length;
  return textContent.length < 500 && scriptCount > 3;
}

/** Extract PDF bytes to markdown INLINE (no disk write), capping pages + chars to the budget. */
async function extractPdf(url: string, bytes: Uint8Array, budget: number): Promise<ExtractedResult> {
  const pdf = await getDocumentProxy(bytes);
  const metadata = await pdf.getMetadata().catch(() => null);
  const info = metadata?.info && typeof metadata.info === 'object' ? (metadata.info as Record<string, unknown>) : null;
  const rawTitle = info?.['Title'];
  const rawAuthor = info?.['Author'];
  const metaTitle = typeof rawTitle === 'string' ? rawTitle : undefined;
  const metaAuthor = typeof rawAuthor === 'string' ? rawAuthor : undefined;
  const title = pdfTitle(metaTitle, url);

  const pagesToExtract = Math.min(pdf.numPages, MAX_PDF_PAGES);
  const lines: string[] = [`# ${title}`, '', `> Source: ${url}`, `> Pages: ${pdf.numPages}`];
  if (metaAuthor) lines.push(`> Author: ${metaAuthor}`);
  lines.push('', '---', '');

  let chars = lines.join('\n').length;
  let lastPage = 0;
  for (let i = 1; i <= pagesToExtract; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item: unknown) => (item as { str?: string }).str || '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!pageText) continue;
    if (lastPage > 0) lines.push('', `<!-- Page ${i} -->`, '');
    lines.push(pageText);
    lastPage = i;
    chars += pageText.length;
    if (chars >= budget) break;
  }

  const { markdown, truncated } = truncate(lines.join('\n'), budget);
  const truncatedPages = truncated || lastPage < pdf.numPages;
  return { url, title, markdown, error: null, truncated: truncatedPages };
}

/**
 * Jina Reader fallback (`r.jina.ai`) — recoverable errors only. Needs no parsing libs, so `WebFetch`
 * still works when the HTML/PDF parsers are unavailable. Returns null when Jina yields nothing usable.
 * The target URL is SSRF-re-validated before it is sent to the reader (so a blocked address never reaches
 * r.jina.ai even if the direct-path non-recoverable gate is ever loosened), and the response is size-capped.
 */
async function extractWithJinaReader(url: string, budget: number, signal?: AbortSignal): Promise<ExtractedResult | null> {
  try {
    await assertPublicUrl(new URL(url));
    const res = await fetch(JINA_READER_BASE + new URL(url).href, {
      headers: { Accept: 'text/markdown', 'X-No-Cache': 'true' },
      signal: AbortSignal.any([AbortSignal.timeout(DEFAULT_TIMEOUT_MS), ...(signal ? [signal] : [])]),
    });
    if (!res.ok) return null;
    const content = new TextDecoder().decode(await readBodyCapped(res, JINA_MAX_RESPONSE_BYTES));
    const contentStart = content.indexOf('Markdown Content:');
    if (contentStart < 0) return null;
    const markdownPart = content.slice(contentStart + 17).trim();
    if (
      markdownPart.length < 100 ||
      markdownPart.startsWith('Loading...') ||
      markdownPart.startsWith('Please enable JavaScript')
    ) {
      return null;
    }
    const title = extractHeadingTitle(markdownPart) ?? fallbackTitle(url);
    const { markdown, truncated } = truncate(markdownPart, budget);
    return { url, title, markdown, error: null, truncated };
  } catch {
    return null;
  }
}

/** Direct HTTP fetch + parse. Errors are tagged recoverable (→ Jina) or non-recoverable per prefix. */
async function extractViaHttp(url: string, opts: ResolvedOptions, signal?: AbortSignal): Promise<ExtractedResult> {
  const { budget } = opts;
  return withTimeout(DEFAULT_TIMEOUT_MS, signal, async (fetchSignal) => {
    try {
      const response = await safeFetch(url, { signal: fetchSignal, headers: BROWSER_HEADERS });

      if (!response.ok) return failure(url, `HTTP ${response.status}: ${response.statusText}`);

      const contentType = response.headers.get('content-type') || '';
      const contentLengthHeader = response.headers.get('content-length');
      const isPdfContent = isPDF(url, contentType);
      const maxResponseSize = isPdfContent ? 20 * 1024 * 1024 : 5 * 1024 * 1024;
      if (contentLengthHeader) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (Number.isFinite(contentLength) && contentLength > maxResponseSize) {
          return failure(url, `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`);
        }
      }

      if (isPdfContent) {
        // `raw` has no HTML concept for a PDF — still route through the text extractor.
        const bytes = await readBodyCapped(response, maxResponseSize);
        try {
          return await extractPdf(url, bytes, budget);
        } catch (err) {
          // Recoverable: a parse throw (or absent lib) falls through to the Jina reader, which reads PDFs.
          return failure(url, `PDF extraction failed: ${errorMessage(err)}`);
        }
      }

      if (
        contentType.includes('application/octet-stream') ||
        contentType.includes('image/') ||
        contentType.includes('audio/') ||
        contentType.includes('video/') ||
        contentType.includes('application/zip')
      ) {
        return failure(url, `Unsupported content type: ${contentType.split(';')[0]}`);
      }

      const text = new TextDecoder().decode(await readBodyCapped(response, maxResponseSize));
      const isHTML = contentType.includes('text/html') || contentType.includes('application/xhtml+xml');

      // `raw`: return exactly what the server sent (even a sparse JS shell), truncated to budget. Bypasses
      // Readability/RSC/turndown here, and the Jina fallback upstream (the direct fetch succeeded).
      if (opts.raw) {
        const { markdown, truncated } = truncate(text, budget);
        return { url, title: extractTextTitle(text, url), markdown, error: null, truncated };
      }

      if (!isHTML) {
        const { markdown, truncated } = truncate(text, budget);
        return { url, title: extractTextTitle(text, url), markdown, error: null, truncated };
      }

      let article: { title?: string | null; content?: string | null } | null = null;
      try {
        const { document } = parseHTML(text) as unknown as { document: QueryableDoc };
        absolutizeDocument(document, url, opts.includeImages);
        article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse() as {
          title?: string | null;
          content?: string | null;
        } | null;
      } catch {
        // linkedom/Readability parse throw — fall through to RSC, then to the recoverable Jina path.
        article = null;
      }

      if (article?.content) {
        let markdownRaw = '';
        try {
          markdownRaw = turndownFor(opts).turndown(article.content);
        } catch {
          markdownRaw = '';
        }
        if (markdownRaw.length >= MIN_USEFUL_CONTENT) {
          const { markdown, truncated } = truncate(markdownRaw, budget);
          return { url, title: article.title || '', markdown, error: null, truncated };
        }
      }

      const rsc = extractRSCContent(text);
      if (rsc) {
        const { markdown, truncated } = truncate(rsc.content, budget);
        return { url, title: rsc.title, markdown, error: null, truncated };
      }

      return failure(
        url,
        isLikelyJSRendered(text)
          ? 'Page appears to be JavaScript-rendered (content loads dynamically)'
          : 'Could not extract readable content from HTML structure',
      );
    } catch (err) {
      return failure(url, errorMessage(err));
    }
  });
}

/**
 * Normalize a URL to its raw-content equivalent before fetching, so source files come back as content
 * rather than a host's JS-rendered page chrome. Currently maps GitHub blob/raw view URLs to
 * `raw.githubusercontent.com`: `github.com/<owner>/<repo>/blob/<ref>/<path>` (and `/raw/<ref>/<path>`)
 * → `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`. Returns the input unchanged otherwise.
 */
function normalizeFetchUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'github.com' || host === 'www.github.com') {
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
      if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Fetch a single URL and return its markdown, bounded by the (clamped) budget. Tries direct HTTP
 * (PDF/HTML), then the Jina reader for recoverable failures. Never throws — a failure is returned as an
 * `error` entry. The URL is normalized first (e.g. GitHub blob → raw); the result keeps the
 * originally-requested URL. With `raw:true` the decoded body is returned verbatim and the Jina fallback
 * is skipped (raw means raw — whatever the direct fetch returned).
 */
export async function extractUrl(url: string, signal?: AbortSignal, opts?: ExtractOptions): Promise<ExtractedResult> {
  if (signal?.aborted) return failure(url, 'Aborted');
  try {
    new URL(url);
  } catch {
    return failure(url, 'Invalid URL');
  }

  const resolved = resolveOptions(opts, SINGLE_URL_BUDGET);
  const fetchUrl = normalizeFetchUrl(url);
  const withRequestedUrl = (r: ExtractedResult): ExtractedResult => (fetchUrl === url ? r : { ...r, url });

  const httpResult = await extractViaHttp(fetchUrl, resolved, signal);
  if (signal?.aborted) return failure(url, 'Aborted');
  if (!httpResult.error) return withRequestedUrl(httpResult);
  if (resolved.raw) return withRequestedUrl(httpResult); // raw bypasses the Jina fallback entirely
  if (NON_RECOVERABLE_ERRORS.some((prefix) => httpResult.error!.startsWith(prefix))) return withRequestedUrl(httpResult);

  const jina = await extractWithJinaReader(fetchUrl, resolved.budget, signal);
  if (jina) return withRequestedUrl(jina);
  return withRequestedUrl(httpResult);
}

/**
 * Fetch many URLs concurrently (limit 3), each resolving independently — one failure becomes an `error`
 * entry, never a thrown batch. Uses the smaller per-URL budget when more than one URL is requested,
 * unless an explicit `budget` override is supplied via `opts`.
 */
export async function extractUrls(urls: string[], signal?: AbortSignal, opts?: ExtractOptions): Promise<ExtractedResult[]> {
  const defaultBudget = urls.length > 1 ? MULTI_URL_BUDGET : SINGLE_URL_BUDGET;
  const budget = opts?.budget ?? defaultBudget;
  return mapWithConcurrency(urls, CONCURRENT_LIMIT, async (url) => {
    try {
      return await extractUrl(url, signal, { ...opts, budget });
    } catch (err) {
      return failure(url, isAbortError(err) ? 'Aborted' : errorMessage(err));
    }
  });
}
