import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webSearchExa, codeSearchExa, callExaMcp } from '../exa';

/**
 * Exa free-endpoint client (US-028.1): asserts the JSON-RPC request shape, SSE-vs-plain-JSON parsing,
 * markdown assembly, and the code-context → web-search fallback path. `fetch` is mocked globally.
 */

const SEARCH_TEXT =
  'Title: Example Site\nURL: https://example.com\nText: VS Code 1.99 shipped new terminal features.\n---';

function rpcBody(text: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } });
}

function sseResponse(text: string): Response {
  return new Response(`event: message\ndata: ${rpcBody(text)}\n\n`, { status: 200 });
}

function jsonResponse(text: string): Response {
  return new Response(rpcBody(text), { status: 200 });
}

function rpcErrorResponse(message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message } }), { status: 200 });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callExaMcp', () => {
  it('posts a tools/call JSON-RPC body to the free Exa endpoint', async () => {
    fetchMock.mockResolvedValue(jsonResponse('ok'));
    await callExaMcp('web_search_exa', { query: 'x' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://mcp.exa.ai/mcp');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.method).toBe('tools/call');
    expect(body.params).toEqual({ name: 'web_search_exa', arguments: { query: 'x' } });
    expect((init as RequestInit).headers).toMatchObject({ Accept: 'application/json, text/event-stream' });
  });

  it('parses an SSE (data:) response', async () => {
    fetchMock.mockResolvedValue(sseResponse('hello sse'));
    expect(await callExaMcp('web_search_exa', {})).toBe('hello sse');
  });

  it('parses a plain-JSON response', async () => {
    fetchMock.mockResolvedValue(jsonResponse('hello json'));
    expect(await callExaMcp('web_search_exa', {})).toBe('hello json');
  });

  it('throws on a non-ok HTTP status', async () => {
    fetchMock.mockResolvedValue(new Response('down', { status: 503 }));
    await expect(callExaMcp('web_search_exa', {})).rejects.toThrow(/503/);
  });

  it('throws on a JSON-RPC error payload', async () => {
    fetchMock.mockResolvedValue(rpcErrorResponse('boom'));
    await expect(callExaMcp('web_search_exa', {})).rejects.toThrow(/boom/);
  });

  it('joins a multi-line SSE data frame before parsing', async () => {
    const body = 'data: {"jsonrpc":"2.0","id":1,\ndata: "result":{"content":[{"type":"text","text":"multiline-ok"}]}}\n\n';
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
    expect(await callExaMcp('web_search_exa', {})).toBe('multiline-ok');
  });

  it('skips heartbeat/comment frames and uses the last result frame', async () => {
    const body = `: keep-alive\n\ndata: ${rpcBody('first')}\n\ndata: ${rpcBody('second')}\n\n`;
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
    expect(await callExaMcp('web_search_exa', {})).toBe('second');
  });
});

describe('webSearchExa', () => {
  it('calls web_search_exa with the fixed args and assembles answer + sources', async () => {
    fetchMock.mockResolvedValue(sseResponse(SEARCH_TEXT));
    const result = await webSearchExa('vscode release notes', { numResults: 7 });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.params.name).toBe('web_search_exa');
    expect(body.params.arguments).toMatchObject({
      query: 'vscode release notes',
      numResults: 7,
      livecrawl: 'fallback',
      type: 'auto',
      contextMaxCharacters: 3000,
    });

    expect(result.resultCount).toBe(1);
    expect(result.markdown).toContain('VS Code 1.99 shipped new terminal features.');
    expect(result.markdown).toContain('## Sources');
    expect(result.markdown).toContain('[Example Site](https://example.com)');
  });

  it('defaults numResults to 5 and reports zero results gracefully', async () => {
    fetchMock.mockResolvedValue(jsonResponse('no parseable blocks here'));
    const result = await webSearchExa('obscure query');
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.params.arguments.numResults).toBe(5);
    expect(result.resultCount).toBe(0);
    expect(result.markdown).toContain('No results');
  });
});

describe('codeSearchExa', () => {
  it('uses get_code_context_exa and reports code-context mode', async () => {
    fetchMock.mockResolvedValue(jsonResponse('code context result'));
    const result = await codeSearchExa('debounce lodash', 4000);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.params.name).toBe('get_code_context_exa');
    expect(body.params.arguments).toEqual({ query: 'debounce lodash', tokensNum: 4000 });
    expect(result.mode).toBe('code-context');
    expect(result.markdown).toBe('code context result');
  });

  it('falls back to web_search_exa when the code-context tool is missing', async () => {
    fetchMock
      .mockResolvedValueOnce(rpcErrorResponse('Tool not found'))
      .mockResolvedValueOnce(jsonResponse('fallback web result'));
    const result = await codeSearchExa('rare api', 2000);
    expect(result.mode).toBe('web-search-fallback');
    expect(result.markdown).toContain('fallback web result');
    const secondBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(secondBody.params.name).toBe('web_search_exa');
  });
});
