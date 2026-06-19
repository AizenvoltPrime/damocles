import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { PiCodingAgentModule } from '../pi-loader';
import type { ToolCatalogEntry } from '@shared/types/tools';
import { webSearchExa, codeSearchExa } from './exa';
import { extractUrl, extractUrls, type ExtractedResult } from './extract';
import { mapWithConcurrency } from './util';

/**
 * Native, key-free web tools (Phase 7). `WebSearch`/`CodeSearch` hit Exa's free MCP endpoint;
 * `WebFetch` fetches + extracts to markdown (PDF/Readability/RSC → Jina). Built per-session in
 * `buildCustomTools` like the memory/compass/browser module tools — no `pi-web-access` install. `WEB_SPECS`
 * is the single source of truth for the active-set names, the `defineTool` names, and the Tools-panel
 * catalog. Every `execute` is fail-soft: any error becomes a text result, never a thrown turn.
 */

interface ToolSpec {
  /** PascalCase active-set name + `defineTool` name + label source. */
  name: string;
  /** Human-friendly Tools-panel label. */
  label: string;
  /** One-line Tools-panel blurb. */
  description: string;
}

const WEB_SPECS: readonly ToolSpec[] = [
  { name: 'WebSearch', label: 'Web search', description: 'Search the web (key-free via Exa).' },
  { name: 'WebFetch', label: 'Web fetch', description: 'Fetch and read a web page or PDF as markdown.' },
  { name: 'CodeSearch', label: 'Code search', description: 'Search public source code and docs (key-free via Exa).' },
] as const;

export const WEB_PI_TOOL_NAMES: readonly string[] = WEB_SPECS.map((s) => s.name);

export const WEB_TOOL_CATALOG: readonly ToolCatalogEntry[] = WEB_SPECS.map((s) => ({
  name: s.name,
  label: s.label,
  description: s.description,
  group: 'web',
  toggleable: true,
}));

const DEFAULT_CODE_MAX_TOKENS = 5000;

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
  },
  { additionalProperties: false },
);

const webFetchSchema = Type.Object(
  {
    url: Type.Optional(Type.String({ description: 'A single URL to fetch.' })),
    urls: Type.Optional(Type.Array(Type.String(), { description: 'Multiple URLs to fetch together.' })),
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

interface WebSearchDetails {
  queries: string[];
  queryCount: number;
  totalResults: number;
  error?: string;
}

interface WebFetchDetails {
  urls: string[];
  urlCount: number;
  successful: number;
  totalChars: number;
  title?: string;
  truncated?: boolean;
  error?: string;
}

interface CodeSearchDetails {
  query: string;
  maxTokens: number;
  mode: 'code-context' | 'web-search-fallback';
  error?: string;
}

function formatFetch(result: ExtractedResult): string {
  const header = result.title ? `# ${result.title}\n${result.url}` : `# ${result.url}`;
  if (result.error) return `${header}\n\nError: ${result.error}`;
  return `${header}\n\n${result.markdown}`;
}

/** Build the three native web tools as pi-native definitions (Phase 7). */
export function buildWebPiTools(deps: WebPiToolDeps): ToolDefinition[] {
  const { pi } = deps;

  return [
    pi.defineTool<typeof webSearchSchema, WebSearchDetails>({
      name: 'WebSearch',
      label: 'WebSearch',
      description:
        'Search the web and return an answer with cited sources. Key-free via Exa\'s free search endpoint. Pass `query` for one search or `queries` for several at once; `numResults` caps results per query (default 5). Returns markdown — a synthesized answer plus a Sources list.',
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
          const numResults = input.numResults;
          const results = await mapWithConcurrency(queries, 3, async (q) => {
            try {
              const r = await webSearchExa(q, numResults != null ? { numResults } : {}, signal);
              return { q, markdown: r.markdown, resultCount: r.resultCount };
            } catch (err) {
              return { q, markdown: `Error: ${errMsg(err)}`, resultCount: 0 };
            }
          });
          const totalResults = results.reduce((sum, r) => sum + r.resultCount, 0);
          const text =
            results.length === 1
              ? results[0]!.markdown
              : results.map((r) => `## Query: ${r.q}\n\n${r.markdown}`).join('\n\n---\n\n');
          return textResult(text, { queries, queryCount: queries.length, totalResults });
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
        'Fetch one or more web pages or PDFs and return their content as markdown. Pass `url` for one page or `urls` for several. PDFs are parsed to text inline; HTML is extracted via Readability. JavaScript-heavy pages may be fetched via the third-party `r.jina.ai` reader as a fallback (the URL is sent to that service). Content is returned inline and truncated to keep results manageable.',
      parameters: webFetchSchema,
      execute: async (_id, input, signal) => {
        const urls = (input.urls?.length ? input.urls : input.url ? [input.url] : [])
          .map((u) => u.trim())
          .filter(Boolean);
        if (urls.length === 0) {
          return textResult('Error: provide a `url` or `urls`.', {
            urls: [],
            urlCount: 0,
            successful: 0,
            totalChars: 0,
            error: 'No URL provided',
          });
        }
        try {
          const results = urls.length === 1 ? [await extractUrl(urls[0]!, signal)] : await extractUrls(urls, signal);
          const successful = results.filter((r) => !r.error).length;
          const totalChars = results.reduce((sum, r) => sum + r.markdown.length, 0);
          const truncated = results.some((r) => r.truncated);
          const text = results.map(formatFetch).join('\n\n---\n\n');
          return textResult(text, {
            urls,
            urlCount: urls.length,
            successful,
            totalChars,
            ...(results.length === 1 && results[0]!.title ? { title: results[0]!.title } : {}),
            ...(truncated ? { truncated: true } : {}),
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
  ];
}
