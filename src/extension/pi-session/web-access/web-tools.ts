import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { PiCodingAgentModule } from '../pi-loader';
import { webSearchExa, codeSearchExa, EXA_CATEGORIES } from './exa';
import { extractUrl, extractUrls, clampBudget, MIN_CHAR_BUDGET, SINGLE_URL_BUDGET, type ExtractedResult } from './extract';
import { fetchFeed, type FeedResult } from './feed';
import { parseVideoId, fetchTranscript } from './youtube';
import { mapWithConcurrency } from './util';

/**
 * Native, key-free web tools (Phase 7). `WebSearch`/`CodeSearch` hit Exa's free MCP endpoint;
 * `WebFetch` fetches + extracts to markdown (PDF/Readability/RSC → Jina); `FeedRead` reads RSS/Atom
 * feeds; `YouTubeTranscript` best-effort-fetches video captions. Built per-session in `buildCustomTools`
 * like the memory/compass/browser module tools — no `pi-web-access` install. The active-set names and the
 * Tools-panel catalog are declared in `./web-tool-specs`, which stays free of this module's runtime graph;
 * the `defineTool` names below are held in parity with it by
 * `tools/__tests__/web-tools-schema-parity.test.ts`. Every `execute` is fail-soft: any error becomes a text
 * result, never a thrown turn.
 */

const DEFAULT_CODE_MAX_TOKENS = 5000;
/** Cap on how many URLs one WebFetch call fetches — bounds fan-out (each URL is a full fetch+parse+Jina). */
const MAX_FETCH_URLS = 20;

export interface WebPiToolDeps {
  pi: PiCodingAgentModule;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function textResult<D>(text: string, details: D): AgentToolResult<D> {
  return { content: [{ type: 'text', text }], details };
}

const webSearchSchema = Type.Object(
  {
    query: Type.Optional(Type.String({ description: 'A single search query.' })),
    queries: Type.Optional(Type.Array(Type.String(), { description: 'Multiple search queries to run together.' })),
    numResults: Type.Optional(Type.Number({ description: 'Results per query (default 5).' })),
    includeDomains: Type.Optional(
      Type.Array(Type.String(), { description: 'Only return results from these domains (e.g. ["arxiv.org"]).' }),
    ),
    excludeDomains: Type.Optional(
      Type.Array(Type.String(), { description: 'Exclude results from these domains.' }),
    ),
    startPublishedDate: Type.Optional(
      Type.String({ description: 'Earliest publish date, ISO YYYY-MM-DD.', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    ),
    endPublishedDate: Type.Optional(
      Type.String({ description: 'Latest publish date, ISO YYYY-MM-DD.', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    ),
    category: Type.Optional(
      Type.Union(
        EXA_CATEGORIES.map((c) => Type.Literal(c)),
        { description: 'Restrict results to a content category.' },
      ),
    ),
  },
  { additionalProperties: false },
);

const webFetchSchema = Type.Object(
  {
    url: Type.Optional(Type.String({ description: 'A single URL to fetch.' })),
    urls: Type.Optional(Type.Array(Type.String(), { description: 'Multiple URLs to fetch together.' })),
    raw: Type.Optional(
      Type.Boolean({
        description:
          'Return the server response verbatim (skip Readability extraction and the r.jina.ai fallback). For JavaScript-rendered pages this may be a sparse HTML shell. Default false.',
      }),
    ),
    maxChars: Type.Optional(
      Type.Number({
        description: `Cap the returned characters per URL (clamped to ${MIN_CHAR_BUDGET}–${SINGLE_URL_BUDGET}; the effective cap is echoed in details.maxChars).`,
      }),
    ),
    includeLinks: Type.Optional(
      Type.Boolean({ description: 'Keep hyperlinks in the extracted markdown (default true).' }),
    ),
    includeImages: Type.Optional(
      Type.Boolean({ description: 'Keep images in the extracted markdown (default true).' }),
    ),
  },
  { additionalProperties: false },
);

const codeSearchSchema = Type.Object(
  {
    query: Type.String({ description: 'What to find in public source code / docs.' }),
    maxTokens: Type.Optional(Type.Number({ description: 'Approximate token budget for the result (default 5000).' })),
  },
  { additionalProperties: false },
);

const feedReadSchema = Type.Object(
  {
    url: Type.String({ description: 'The RSS or Atom feed URL.' }),
    limit: Type.Optional(Type.Number({ description: 'Maximum items to return (default 20, max 100).' })),
  },
  { additionalProperties: false },
);

const youtubeTranscriptSchema = Type.Object(
  {
    url: Type.String({ description: 'A YouTube video URL (watch, youtu.be, shorts, embed) or a bare 11-character video id.' }),
    lang: Type.Optional(Type.String({ description: 'Preferred caption language code (e.g. "en"); falls back to the best available.' })),
  },
  { additionalProperties: false },
);

interface WebSearchDetails {
  queries: string[];
  queryCount: number;
  totalResults: number;
  /** True when structured domain/date filters routed through the advanced Exa tool. */
  advanced?: boolean;
  /** True when the advanced tool was unreachable and filters were dropped (surfaced to the model). */
  degraded?: boolean;
  error?: string;
}

interface WebFetchDetails {
  urls: string[];
  urlCount: number;
  successful: number;
  totalChars: number;
  title?: string;
  truncated?: boolean;
  raw?: boolean;
  maxChars?: number;
  includeLinks?: boolean;
  includeImages?: boolean;
  error?: string;
}

interface CodeSearchDetails {
  query: string;
  maxTokens: number;
  mode: 'code-context' | 'web-search-fallback';
  error?: string;
}

interface FeedReadDetails {
  url: string;
  itemCount: number;
  note?: string;
  error?: string;
}

interface YouTubeTranscriptDetails {
  videoId: string;
  lang?: string;
  chars: number;
  error?: string;
}

function formatFetch(result: ExtractedResult): string {
  const header = result.title ? `# ${result.title}\n${result.url}` : `# ${result.url}`;
  if (result.error) return `${header}\n\nError: ${result.error}`;
  return `${header}\n\n${result.markdown}`;
}

/** Render a parsed feed as markdown: feed title, optional note, then one section per item. */
function formatFeed(url: string, result: FeedResult): string {
  const header = result.title ? `# ${result.title}\n${url}` : `# ${url}`;
  if (result.error && result.items.length === 0) return `${header}\n\nError: ${result.error}`;
  const parts: string[] = [header];
  if (result.note) parts.push(`> Note: ${result.note}`);
  const items = result.items.map((item, i) => {
    const title = item.title || `Item ${i + 1}`;
    const titleLine = item.link ? `## [${title}](${item.link})` : `## ${title}`;
    const lines = [titleLine];
    if (item.published) lines.push(`*${item.published}*`);
    if (item.summary) lines.push('', item.summary);
    return lines.join('\n');
  });
  parts.push(items.join('\n\n'));
  return parts.join('\n\n');
}

/** Build the native web tools as pi-native definitions (Phase 7). */
export function buildWebPiTools(deps: WebPiToolDeps): ToolDefinition[] {
  const { pi } = deps;

  return [
    pi.defineTool<typeof webSearchSchema, WebSearchDetails>({
      name: 'WebSearch',
      label: 'WebSearch',
      description:
        'Search the web and return an answer with cited sources. Key-free via Exa\'s free search endpoint. Pass `query` for one search or `queries` for several at once; `numResults` caps results per query (default 5). Optional filters: `category` (e.g. "news", "research paper", "github") restricts to a content type; `includeDomains`/`excludeDomains` scope the sources; `startPublishedDate`/`endPublishedDate` (ISO YYYY-MM-DD) bound the publish date. Any domain/date filter routes through Exa\'s advanced search (with graceful fallback). Returns markdown — a synthesized answer plus a Sources list.',
      parameters: webSearchSchema,
      execute: async (_id, input, signal) => {
        const queries = (input.queries?.length ? input.queries : input.query ? [input.query] : [])
          .map((q) => q.trim())
          .filter(Boolean);
        if (queries.length === 0) {
          return textResult('Error: provide a `query` or `queries`.', {
            queries: [],
            queryCount: 0,
            totalResults: 0,
            error: 'No query provided',
          });
        }
        try {
          const searchOpts = {
            ...(input.numResults != null ? { numResults: input.numResults } : {}),
            ...(input.includeDomains?.length ? { includeDomains: input.includeDomains } : {}),
            ...(input.excludeDomains?.length ? { excludeDomains: input.excludeDomains } : {}),
            ...(input.startPublishedDate ? { startPublishedDate: input.startPublishedDate } : {}),
            ...(input.endPublishedDate ? { endPublishedDate: input.endPublishedDate } : {}),
            ...(input.category ? { category: input.category } : {}),
          };
          const advanced = Boolean(
            input.includeDomains?.length ||
              input.excludeDomains?.length ||
              input.startPublishedDate ||
              input.endPublishedDate,
          );
          const results = await mapWithConcurrency(queries, 3, async (q) => {
            try {
              const r = await webSearchExa(q, searchOpts, signal);
              // Surface the degraded note in the model-visible text (not just details) — otherwise the
              // model treats silently-unfiltered results as if the domain/date filters had been applied.
              const markdown = r.degraded && r.note ? `> Note: ${r.note}\n\n${r.markdown}` : r.markdown;
              return { q, markdown, resultCount: r.resultCount, degraded: Boolean(r.degraded) };
            } catch (err) {
              return { q, markdown: `Error: ${errMsg(err)}`, resultCount: 0, degraded: false };
            }
          });
          const totalResults = results.reduce((sum, r) => sum + r.resultCount, 0);
          const degraded = results.some((r) => r.degraded);
          const text =
            results.length === 1
              ? results[0]!.markdown
              : results.map((r) => `## Query: ${r.q}\n\n${r.markdown}`).join('\n\n---\n\n');
          return textResult(text, {
            queries,
            queryCount: queries.length,
            totalResults,
            ...(advanced ? { advanced: true } : {}),
            ...(degraded ? { degraded: true } : {}),
          });
        } catch (err) {
          return textResult(`Error: ${errMsg(err)}`, {
            queries,
            queryCount: queries.length,
            totalResults: 0,
            error: errMsg(err),
          });
        }
      },
    }),

    pi.defineTool<typeof webFetchSchema, WebFetchDetails>({
      name: 'WebFetch',
      label: 'WebFetch',
      description:
        'Fetch one or more web pages or PDFs and return their content as markdown. Pass `url` for one page or `urls` for several (up to 20 per call). PDFs are parsed to text inline; HTML is extracted via Readability. JavaScript-heavy pages may be fetched via the third-party `r.jina.ai` reader as a fallback (the URL is sent to that service). Options: `raw:true` returns the server response verbatim and skips Readability AND the r.jina.ai fallback (useful to inspect the exact HTML, but a JS-rendered page may come back as a sparse shell; `raw` does not apply to PDFs, which are always text-extracted); `maxChars` caps the returned characters per URL; `includeLinks:false`/`includeImages:false` strip links/images from the markdown. Content is returned inline and truncated to keep results manageable.',
      parameters: webFetchSchema,
      execute: async (_id, input, signal) => {
        const allUrls = (input.urls?.length ? input.urls : input.url ? [input.url] : [])
          .map((u) => u.trim())
          .filter(Boolean);
        if (allUrls.length === 0) {
          return textResult('Error: provide a `url` or `urls`.', {
            urls: [],
            urlCount: 0,
            successful: 0,
            totalChars: 0,
            error: 'No URL provided',
          });
        }
        // Bound fan-out: each URL is a full fetch+parse+Jina round-trip; a prompt-injected page listing
        // hundreds of URLs shouldn't be able to steer that many requests.
        const urls = allUrls.slice(0, MAX_FETCH_URLS);
        const droppedUrls = allUrls.length - urls.length;
        // Echo the budget actually enforced (after clamping), so the model can tell its cap was honored.
        const effectiveMaxChars = input.maxChars != null ? clampBudget(input.maxChars) : undefined;
        try {
          const extractOpts = {
            ...(input.raw ? { raw: true } : {}),
            ...(input.maxChars != null ? { budget: input.maxChars } : {}),
            ...(input.includeLinks != null ? { includeLinks: input.includeLinks } : {}),
            ...(input.includeImages != null ? { includeImages: input.includeImages } : {}),
          };
          const results =
            urls.length === 1
              ? [await extractUrl(urls[0]!, signal, extractOpts)]
              : await extractUrls(urls, signal, extractOpts);
          const successful = results.filter((r) => !r.error).length;
          const totalChars = results.reduce((sum, r) => sum + r.markdown.length, 0);
          const truncated = results.some((r) => r.truncated);
          const body = results.map(formatFetch).join('\n\n---\n\n');
          const text = droppedUrls > 0
            ? `> Note: ${allUrls.length} URLs requested; only the first ${MAX_FETCH_URLS} were fetched (${droppedUrls} dropped).\n\n${body}`
            : body;
          return textResult(text, {
            urls,
            urlCount: urls.length,
            successful,
            totalChars,
            ...(results.length === 1 && results[0]!.title ? { title: results[0]!.title } : {}),
            ...(truncated ? { truncated: true } : {}),
            ...(input.raw ? { raw: true } : {}),
            ...(effectiveMaxChars != null ? { maxChars: effectiveMaxChars } : {}),
            ...(input.includeLinks != null ? { includeLinks: input.includeLinks } : {}),
            ...(input.includeImages != null ? { includeImages: input.includeImages } : {}),
          });
        } catch (err) {
          return textResult(`Error: ${errMsg(err)}`, {
            urls,
            urlCount: urls.length,
            successful: 0,
            totalChars: 0,
            error: errMsg(err),
          });
        }
      },
    }),

    pi.defineTool<typeof codeSearchSchema, CodeSearchDetails>({
      name: 'CodeSearch',
      label: 'CodeSearch',
      description:
        'Search public source code, libraries, and developer docs (GitHub, Stack Overflow, official docs). Key-free via Exa\'s free code-context endpoint, with a web-search fallback. `maxTokens` caps the result size (default 5000). Returns markdown code context.',
      parameters: codeSearchSchema,
      execute: async (_id, input, signal) => {
        const query = input.query.trim();
        const maxTokens = input.maxTokens ?? DEFAULT_CODE_MAX_TOKENS;
        if (!query) {
          return textResult('Error: provide a `query`.', { query: '', maxTokens, mode: 'code-context', error: 'No query provided' });
        }
        try {
          const r = await codeSearchExa(query, maxTokens, signal);
          return textResult(r.markdown, { query, maxTokens, mode: r.mode });
        } catch (err) {
          return textResult(`Error: ${errMsg(err)}`, { query, maxTokens, mode: 'code-context', error: errMsg(err) });
        }
      },
    }),

    pi.defineTool<typeof feedReadSchema, FeedReadDetails>({
      name: 'FeedRead',
      label: 'FeedRead',
      description:
        'Read an RSS 2.0 or Atom feed and return its latest items as markdown (title, link, publish date, summary). Pass the feed `url`; `limit` caps the number of items (default 20, max 100). Fetched URLs are validated to block internal/loopback/cloud-metadata addresses.',
      parameters: feedReadSchema,
      execute: async (_id, input, signal) => {
        const url = input.url.trim();
        if (!url) {
          return textResult('Error: provide a feed `url`.', { url: '', itemCount: 0, error: 'No URL provided' });
        }
        try {
          const result = await fetchFeed(url, signal, input.limit);
          const text = formatFeed(url, result);
          return textResult(text, {
            url,
            itemCount: result.items.length,
            ...(result.note ? { note: result.note } : {}),
            ...(result.error ? { error: result.error } : {}),
          });
        } catch (err) {
          return textResult(`Error: ${errMsg(err)}`, { url, itemCount: 0, error: errMsg(err) });
        }
      },
    }),

    pi.defineTool<typeof youtubeTranscriptSchema, YouTubeTranscriptDetails>({
      name: 'YouTubeTranscript',
      label: 'YouTubeTranscript',
      description:
        'Fetch a YouTube video transcript when captions are available. Pass a video `url` (watch, youtu.be, shorts, or embed) or a bare 11-character id; optional `lang` picks a caption language (falls back to a human-authored track, then auto-generated). Best-effort and dependency-free — YouTube may block server-side access, in which case a clear diagnostic is returned so you can fall back to WebFetch/WebSearch. Fetches are restricted to youtube.com.',
      parameters: youtubeTranscriptSchema,
      execute: async (_id, input, signal) => {
        const raw = input.url.trim();
        if (!raw) {
          return textResult('Error: provide a YouTube `url` or video id.', { videoId: '', chars: 0, error: 'No URL provided' });
        }
        const videoId = parseVideoId(raw);
        if (!videoId) {
          return textResult(`Error: could not parse a YouTube video id from "${raw}".`, {
            videoId: '',
            chars: 0,
            error: 'Invalid YouTube URL or id',
          });
        }
        try {
          const result = await fetchTranscript(videoId, signal, input.lang != null ? { lang: input.lang } : undefined);
          if (result.error) {
            const header = result.title ? `# ${result.title}\n${videoId}` : `# ${videoId}`;
            return textResult(`${header}\n\nError: ${result.error}`, {
              videoId,
              ...(result.lang ? { lang: result.lang } : {}),
              chars: 0,
              error: result.error,
            });
          }
          const header = result.title ? `# ${result.title}` : `# YouTube ${videoId}`;
          const parts = [header];
          if (result.lang) parts.push(`> Language: ${result.lang}`);
          parts.push('', result.text);
          return textResult(parts.join('\n'), {
            videoId,
            ...(result.lang ? { lang: result.lang } : {}),
            chars: result.text.length,
          });
        } catch (err) {
          return textResult(`Error: ${errMsg(err)}`, { videoId, chars: 0, error: errMsg(err) });
        }
      },
    }),
  ];
}
