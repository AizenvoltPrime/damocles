/* Adapted from pi-web-access (MIT). Copyright (c) 2025 Nico Bailon. See THIRD-PARTY-NOTICES.md. */

/**
 * Key-free Exa client powering `WebSearch` and `CodeSearch`. Both go through the free Exa MCP
 * endpoint (`https://mcp.exa.ai/mcp`) — one HTTP POST, no auth, no `~/.pi` access, no `process.env`.
 * Lifted from `pi-web-access/exa.ts` (`callExaMcp`/`parseMcpResults`/`buildAnswerFromMcpResults`) and
 * `pi-web-access/code-search.ts` (`executeCodeSearch`); the keyed `api.exa.ai` path, the
 * `~/.pi/exa-usage.json` budget tracking, `loadConfig`/`getApiKey`, and the `activityMonitor` are all
 * dropped (Phase 7, US-028.1).
 */

import { readBodyCapped } from './safe-fetch';

const EXA_MCP_URL = 'https://mcp.exa.ai/mcp';
const REQUEST_TIMEOUT_MS = 60_000;
/** Byte cap for an Exa MCP response — a fixed trusted host, but a misbehaving endpoint shouldn't OOM us. */
const MAX_EXA_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_NUM_RESULTS = 5;
const DEFAULT_CODE_MAX_TOKENS = 5000;
const CODE_CONTEXT_TOOL = 'get_code_context_exa';
const WEB_SEARCH_TOOL = 'web_search_exa';

interface ExaMcpRpcResponse {
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  error?: {
    code?: number;
    message?: string;
  };
}

interface McpParsedResult {
  title: string;
  url: string;
  content: string;
}

export interface WebSearchResult {
  markdown: string;
  resultCount: number;
}

export interface CodeSearchResult {
  markdown: string;
  mode: 'code-context' | 'web-search-fallback';
}

/** Combine the caller's signal with a 60s hard timeout, so a stuck Exa request never hangs the turn. */
function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Call the free Exa MCP endpoint and return the first text content block. The response is either SSE
 * (`data:` lines) or plain JSON — parse `data:`-prefixed lines first, else the whole body, taking the
 * first object carrying `.result` or `.error`. Throws a typed error the tool layer turns into a
 * fail-soft text result.
 */
export async function callExaMcp(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(EXA_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
    signal: requestSignal(signal),
  });

  if (!response.ok) {
    const errorText = new TextDecoder().decode(await readBodyCapped(response, MAX_EXA_RESPONSE_BYTES));
    throw new Error(`Exa MCP error ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const body = new TextDecoder().decode(await readBodyCapped(response, MAX_EXA_RESPONSE_BYTES));

  // Parse SSE per spec: an event's `data:` lines (multiple allowed) concatenate with `\n` and the event
  // ends at a blank line. Accumulate per event and keep the LAST frame carrying a result/error, so a
  // multi-line data frame or a multi-event stream (both SSE-legal) is handled, not just the first line.
  let parsed: ExaMcpRpcResponse | null = null;
  let dataBuf: string[] = [];
  const flushEvent = (): void => {
    if (dataBuf.length === 0) return;
    const payload = dataBuf.join('\n').trim();
    dataBuf = [];
    if (!payload) return;
    try {
      const candidate = JSON.parse(payload) as ExaMcpRpcResponse;
      if (candidate?.result || candidate?.error) parsed = candidate;
    } catch {
      // non-JSON SSE frame (comment/heartbeat) — skip
    }
  };
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\r$/, ''); // tolerate CRLF
    if (line === '') {
      flushEvent();
    } else if (line.startsWith('data:')) {
      dataBuf.push(line.slice(5).replace(/^ /, '')); // SSE strips exactly one leading space
    }
  }
  flushEvent(); // final event may have no trailing blank line

  if (!parsed) {
    try {
      const candidate = JSON.parse(body) as ExaMcpRpcResponse;
      if (candidate?.result || candidate?.error) parsed = candidate;
    } catch {
      // body was neither SSE nor a single JSON object
    }
  }

  if (!parsed) throw new Error('Exa MCP returned an empty response');

  if (parsed.error) {
    const code = typeof parsed.error.code === 'number' ? ` ${parsed.error.code}` : '';
    throw new Error(`Exa MCP error${code}: ${parsed.error.message || 'Unknown error'}`);
  }

  if (parsed.result?.isError) {
    const message = parsed.result.content
      ?.find((item) => item.type === 'text' && typeof item.text === 'string')
      ?.text?.trim();
    throw new Error(message || 'Exa MCP returned an error');
  }

  const text = parsed.result?.content?.find(
    (item) => item.type === 'text' && typeof item.text === 'string' && item.text.trim().length > 0,
  )?.text;

  if (!text) throw new Error('Exa MCP returned empty content');
  return text;
}

/** Parse the Exa `web_search_exa` text result (Title:/URL:/Text: blocks) into structured results. */
function parseMcpResults(text: string): McpParsedResult[] {
  const blocks = text.split(/(?=^Title: )/m).filter((block) => block.trim().length > 0);
  return blocks
    .map((block) => {
      const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? '';
      const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? '';
      let content = '';
      const textStart = block.indexOf('\nText: ');
      if (textStart >= 0) {
        content = block.slice(textStart + 7).trim();
      } else {
        const hlMatch = block.match(/\nHighlights:\s*\n/);
        if (hlMatch?.index != null) content = block.slice(hlMatch.index + hlMatch[0].length).trim();
      }
      content = content.replace(/\n---\s*$/, '').trim();
      return { title, url, content };
    })
    .filter((result) => result.url.length > 0);
}

/** Assemble an answer (per-source snippets) + a deduped Sources list from parsed Exa results. */
function buildAnswerFromMcpResults(results: McpParsedResult[]): string {
  if (results.length === 0) return '';
  const answerParts: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const snippet = results[i]!.content.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!snippet) continue;
    const sourceTitle = results[i]!.title || `Source ${i + 1}`;
    answerParts.push(`${snippet}\nSource: ${sourceTitle} (${results[i]!.url})`);
  }
  const sources = results.map((r, i) => `${i + 1}. [${r.title || `Source ${i + 1}`}](${r.url})`).join('\n');
  const sections: string[] = [];
  if (answerParts.length > 0) sections.push(answerParts.join('\n\n'));
  sections.push(`## Sources\n${sources}`);
  return sections.join('\n\n');
}

/**
 * Key-free web search via Exa's free MCP endpoint (`web_search_exa`). Returns assembled markdown
 * (per-source snippets + a Sources list) and the result count. RPC/HTTP errors propagate as typed
 * errors for the tool layer to turn into fail-soft results.
 */
export async function webSearchExa(
  query: string,
  opts: { numResults?: number } = {},
  signal?: AbortSignal,
): Promise<WebSearchResult> {
  const text = await callExaMcp(
    WEB_SEARCH_TOOL,
    {
      query,
      numResults: opts.numResults ?? DEFAULT_NUM_RESULTS,
      livecrawl: 'fallback',
      type: 'auto',
      contextMaxCharacters: 3000,
    },
    signal,
  );
  const results = parseMcpResults(text);
  if (results.length === 0) {
    return { markdown: `No results found for "${query}".`, resultCount: 0 };
  }
  return { markdown: buildAnswerFromMcpResults(results), resultCount: results.length };
}

let codeContextToolMissing = false;

function isMissingMcpToolError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('tool') && normalized.includes('not found');
}

function buildFallbackQuery(query: string): string {
  const hasCodeTerms =
    /\b(api|code|docs?|documentation|example|github|implementation|library|source|stackoverflow|stack overflow)\b/.test(
      query.toLowerCase(),
    );
  return hasCodeTerms ? query : `${query} code examples documentation GitHub Stack Overflow official docs`;
}

function maxTokensToResultCount(maxTokens: number): number {
  return Math.min(20, Math.max(5, Math.ceil(maxTokens / 1000)));
}

function trimApproxTokens(text: string, maxTokens: number): string {
  const maxCharacters = Math.max(1000, maxTokens * 4);
  if (text.length <= maxCharacters) return text;
  return `${text.slice(0, maxCharacters).trimEnd()}\n\n[Truncated to approximately ${maxTokens} tokens.]`;
}

async function codeFallbackSearch(query: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
  const text = await callExaMcp(
    WEB_SEARCH_TOOL,
    {
      query: buildFallbackQuery(query),
      numResults: maxTokensToResultCount(maxTokens),
      livecrawl: 'fallback',
      type: 'auto',
      contextMaxCharacters: Math.min(50000, Math.max(1000, maxTokens * 4)),
    },
    signal,
  );
  return trimApproxTokens(text, maxTokens);
}

/**
 * Key-free code search via Exa's free MCP endpoint (`get_code_context_exa`). On a "tool not found"
 * error a sticky flag falls back to `web_search_exa` with a code-boosted query for the rest of the
 * process. Returns markdown + the mode used. Errors propagate as typed errors for the tool layer.
 */
export async function codeSearchExa(
  query: string,
  maxTokens: number = DEFAULT_CODE_MAX_TOKENS,
  signal?: AbortSignal,
): Promise<CodeSearchResult> {
  if (codeContextToolMissing) {
    return { markdown: await codeFallbackSearch(query, maxTokens, signal), mode: 'web-search-fallback' };
  }
  try {
    const text = await callExaMcp(CODE_CONTEXT_TOOL, { query, tokensNum: maxTokens }, signal);
    return { markdown: text, mode: 'code-context' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!isMissingMcpToolError(message)) throw err;
    codeContextToolMissing = true;
    return { markdown: await codeFallbackSearch(query, maxTokens, signal), mode: 'web-search-fallback' };
  }
}
