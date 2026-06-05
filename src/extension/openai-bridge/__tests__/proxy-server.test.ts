import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import { OpenAIBridgeProxy, extractUpstreamErrorMessage, summarizeCodexBody, type BridgeProxyDeps, type AuthResolveResult, type CodexToAnthropicStreamCtor } from '../proxy-server';
import type { CodexToAnthropicStream } from '../openai-transform';

function rawRequest(url: URL, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers },
      (res) => {
        let buf = '';
        res.on('data', (chunk: Buffer) => { buf += chunk.toString('utf8'); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildDeps(overrides: Partial<BridgeProxyDeps> = {}): BridgeProxyDeps {
  const StubStream: CodexToAnthropicStreamCtor = class implements CodexToAnthropicStream {
    write(_chunk: Uint8Array): string[] { return []; }
    end(): string[] { return []; }
  };
  return {
    translateAnthropicToCodex: vi.fn(() => ({ body: { model: 'gpt-5.5' }, toolNameMap: new Map(), toolRequiredKeys: new Map() })),
    CodexToAnthropicStream: StubStream,
    resolveAuth: vi.fn(async (_mode): Promise<AuthResolveResult | null> => ({ mode: 'apikey', token: 'sk-test' })),
    getAuthStatus: vi.fn(async () => ({ codex: { signedIn: false }, apikey: { configured: true } })),
    recordModelForPanel: vi.fn(),
    output: { appendLine: vi.fn() } as unknown as BridgeProxyDeps['output'],
    effortForPanelAndModel: vi.fn(() => 'high'),
    ...overrides,
  };
}

describe('OpenAIBridgeProxy — request gating', () => {
  let proxy: OpenAIBridgeProxy;

  beforeEach(async () => {
    proxy = new OpenAIBridgeProxy(buildDeps());
    await proxy.start();
  });

  afterEach(async () => {
    await proxy.dispose();
  });

  it('rejects cross-origin requests with 403', async () => {
    const entry = proxy.registerRoute('panel-a', 'apikey', 'gpt-5.5');
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${entry.bearer}`, 'Content-Type': 'application/json', 'Origin': 'https://evil.example' },
      body: JSON.stringify({ model: 'gpt-5.5', messages: [] }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects requests with Sec-Fetch-Site present', async () => {
    const entry = proxy.registerRoute('panel-a', 'apikey', 'gpt-5.5');
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${entry.bearer}`, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ model: 'gpt-5.5', messages: [] }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`${proxy.url}/v1/anything-else`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('returns 401 when no Authorization header is present', async () => {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a malformed Bearer token of the same length', async () => {
    const entry = proxy.registerRoute('panel-a', 'apikey', 'gpt-5.5');
    const sameLengthFake = 'f'.repeat(entry.bearer.length);
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sameLengthFake}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('returns 415 when Content-Type is missing application/json', async () => {
    const entry = proxy.registerRoute('panel-a', 'apikey', 'gpt-5.5');
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${entry.bearer}`, 'Content-Type': 'text/plain' },
      body: 'not-json',
    });
    expect(res.status).toBe(415);
  });

  it('returns 413 when Content-Length exceeds the cap', async () => {
    const entry = proxy.registerRoute('panel-a', 'apikey', 'gpt-5.5');
    const body = '{}';
    const res = await rawRequest(new URL(`${proxy.url}/v1/messages`), {
      'Authorization': `Bearer ${entry.bearer}`,
      'Content-Type': 'application/json',
      'Content-Length': String(26 * 1024 * 1024),
    }, body);
    expect(res.status).toBe(413);
  });

  it('returns 413 when cumulative chunked body exceeds the cap (no Content-Length declared)', async () => {
    const entry = proxy.registerRoute('panel-a', 'apikey', 'gpt-5.5');
    const oversized = await new Promise<{ status: number }>((resolve, reject) => {
      const url = new URL(`${proxy.url}/v1/messages`);
      const req = http.request(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${entry.bearer}`,
            'Content-Type': 'application/json',
            'Transfer-Encoding': 'chunked',
          },
        },
        (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0 });
        },
      );
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNRESET' || err.code === 'EPIPE') resolve({ status: 413 });
        else reject(err);
      });
      const chunk = Buffer.alloc(2 * 1024 * 1024, 0x61);
      let written = 0;
      const writeNext = (): void => {
        while (written < 30 * 1024 * 1024) {
          if (!req.write(chunk)) {
            req.once('drain', writeNext);
            return;
          }
          written += chunk.byteLength;
        }
        req.end();
      };
      writeNext();
    });
    expect(oversized.status).toBe(413);
  });

  it('responds to unauthenticated /health with liveness only — never leaks identifiers', async () => {
    const res = await fetch(`${proxy.url}/health`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload['status']).toBe('ok');
    expect(payload['codexAuth']).toBeUndefined();
    expect(payload['apikeyAuth']).toBeUndefined();
    expect(payload['inflightRequests']).toBeUndefined();
    expect(payload['model']).toBeUndefined();
    expect(payload['backend']).toBeUndefined();
  });

  it('exposes the full /health snapshot to bearer-authenticated callers', async () => {
    const entry = proxy.registerRoute('panel-a', 'apikey', 'gpt-5.5');
    const res = await fetch(`${proxy.url}/health`, {
      headers: { 'Authorization': `Bearer ${entry.bearer}` },
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload['status']).toBe('ok');
    expect(payload['codexAuth']).toBeDefined();
    expect(payload['apikeyAuth']).toBeDefined();
    expect(typeof payload['inflightRequests']).toBe('number');
  });

  it('estimates tokens for count_tokens path', async () => {
    const entry = proxy.registerRoute('panel-a', 'apikey', 'gpt-5.5');
    const res = await fetch(`${proxy.url}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${entry.bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(40) }] }),
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { input_tokens: number };
    expect(payload.input_tokens).toBeGreaterThan(0);
  });

  it('count_tokens uses UTF-8 byte length, not JS string length', async () => {
    const entry = proxy.registerRoute('panel-a', 'apikey', 'gpt-5.5');
    const res = await fetch(`${proxy.url}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${entry.bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ s: '你好你好你好你好' }),
    });
    const payload = (await res.json()) as { input_tokens: number };
    expect(payload.input_tokens).toBeGreaterThan(JSON.stringify({ s: '你好你好你好你好' }).length / 4);
  });
});

describe('OpenAIBridgeProxy — route management', () => {
  it('reuses the bearer when the auth-mode is unchanged', () => {
    const proxy = new OpenAIBridgeProxy(buildDeps());
    const e1 = proxy.registerRoute('panel-a', 'apikey', 'gpt-5.5');
    const e2 = proxy.registerRoute('panel-a', 'apikey', 'gpt-5.4');
    expect(e1.bearer).toBe(e2.bearer);
    expect(e2.currentModel).toBe('gpt-5.4');
  });

  it('rotates the bearer when the auth-mode changes', () => {
    const proxy = new OpenAIBridgeProxy(buildDeps());
    const e1 = proxy.registerRoute('panel-a', 'apikey', 'gpt-5.5');
    const e2 = proxy.registerRoute('panel-a', 'codex', 'gpt-5.5');
    expect(e1.bearer).not.toBe(e2.bearer);
    expect(proxy.getRouteEntry(e1.bearer)).toBeNull();
    expect(proxy.getRouteEntry(e2.bearer)?.backend).toBe('codex');
  });

  it('rotateAllBearers evicts every route', () => {
    const proxy = new OpenAIBridgeProxy(buildDeps());
    const e1 = proxy.registerRoute('panel-a', 'apikey', 'gpt-5.5');
    const e2 = proxy.registerRoute('panel-b', 'codex', 'gpt-5.5');
    proxy.rotateAllBearers();
    expect(proxy.getRouteEntry(e1.bearer)).toBeNull();
    expect(proxy.getRouteEntry(e2.bearer)).toBeNull();
  });

  it('removeRoutesForPanel only evicts the matching panel', () => {
    const proxy = new OpenAIBridgeProxy(buildDeps());
    const e1 = proxy.registerRoute('panel-a', 'apikey', 'gpt-5.5');
    const e2 = proxy.registerRoute('panel-b', 'apikey', 'gpt-5.5');
    proxy.removeRoutesForPanel('panel-a');
    expect(proxy.getRouteEntry(e1.bearer)).toBeNull();
    expect(proxy.getRouteEntry(e2.bearer)?.panelId).toBe('panel-b');
  });
});

describe('OpenAIBridgeProxy — workspace trust', () => {
  it('refuses to start when the workspace is untrusted', async () => {
    const vscode = await import('vscode');
    const original = vscode.workspace.isTrusted;
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = false;
    try {
      const proxy = new OpenAIBridgeProxy(buildDeps());
      await expect(proxy.start()).rejects.toThrow(/trusted workspace/i);
    } finally {
      (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = original;
    }
  });
});

describe('OpenAIBridgeProxy — slot cancellation under semaphore', () => {
  it('releases a queued waiter on client disconnect without consuming an inflight slot', async () => {
    let upstreamHits = 0;
    const stallReleasers: Array<() => void> = [];
    const slowStream: CodexToAnthropicStreamCtor = class implements CodexToAnthropicStream {
      write(): string[] { return []; }
      end(): string[] { return []; }
    };
    const realFetch = globalThis.fetch;
    const stubFetch = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (target.startsWith('https://')) {
        upstreamHits++;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            stallReleasers.push(() => {
              try { controller.close(); } catch { /* already closed */ }
            });
          },
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return realFetch(input, init);
    }) as typeof fetch);

    const localProxy = new OpenAIBridgeProxy({
      translateAnthropicToCodex: vi.fn(() => ({ body: { model: 'gpt-5.5' }, toolNameMap: new Map(), toolRequiredKeys: new Map() })),
      CodexToAnthropicStream: slowStream,
      resolveAuth: vi.fn(async (): Promise<AuthResolveResult | null> => ({ mode: 'apikey', token: 'sk-x' })),
      getAuthStatus: vi.fn(async () => ({ codex: { signedIn: false }, apikey: { configured: true } })),
      recordModelForPanel: vi.fn(),
      output: { appendLine: vi.fn() } as unknown as BridgeProxyDeps['output'],
      effortForPanelAndModel: vi.fn(() => 'high'),
    });
    try {
      await localProxy.start();
      const entry = localProxy.registerRoute('panel-a', 'apikey', 'gpt-5.5');

      const occupierAborts: AbortController[] = [];
      const occupiers: Array<Promise<unknown>> = [];
      for (let i = 0; i < 10; i++) {
        const ac = new AbortController();
        occupierAborts.push(ac);
        occupiers.push(fetch(`${localProxy.url}/v1/messages`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${entry.bearer}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.5' }),
          signal: ac.signal,
        }).catch(() => undefined));
      }

      await new Promise(r => setTimeout(r, 100));
      expect(upstreamHits).toBe(10);

      const queuedAbort = new AbortController();
      const queuedReq = fetch(`${localProxy.url}/v1/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${entry.bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.5' }),
        signal: queuedAbort.signal,
      }).catch(() => undefined);

      await new Promise(r => setTimeout(r, 50));
      expect(upstreamHits).toBe(10);

      queuedAbort.abort();
      await queuedReq;

      await new Promise(r => setTimeout(r, 50));
      expect(upstreamHits).toBe(10);

      for (const ac of occupierAborts) ac.abort();
      for (const release of stallReleasers) release();
      await Promise.allSettled(occupiers);
    } finally {
      stubFetch.mockRestore();
      await localProxy.dispose();
    }
  });
});

describe('extractUpstreamErrorMessage', () => {
  it('reads error.message', () => {
    expect(extractUpstreamErrorMessage('{"error":{"message":"boom"}}')).toBe('boom');
  });
  it('reads a top-level message', () => {
    expect(extractUpstreamErrorMessage('{"message":"nope"}')).toBe('nope');
  });
  it('reads detail (the Codex envelope shape)', () => {
    expect(extractUpstreamErrorMessage('{"detail":"System messages are not allowed"}')).toBe('System messages are not allowed');
  });
  it('falls back to the raw body when not JSON', () => {
    expect(extractUpstreamErrorMessage('plain text error')).toBe('plain text error');
  });
  it("returns 'no detail' for an empty/whitespace body", () => {
    expect(extractUpstreamErrorMessage('   ')).toBe('no detail');
  });
  it('truncates very long messages to 500 chars', () => {
    expect(extractUpstreamErrorMessage(JSON.stringify({ detail: 'x'.repeat(900) })).length).toBe(500);
  });
});

describe('summarizeCodexBody', () => {
  it('emits only lengths/roles/counts, never request content', () => {
    const body = JSON.stringify({
      instructions: 'You are Codex secret prompt',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'SENSITIVE SYSTEM PROMPT' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello world' }] },
        { type: 'function_call', call_id: 'x', name: 'Read', arguments: '{}' },
      ],
      tools: [{}, {}],
      reasoning: { effort: 'high' },
    });
    const summary = summarizeCodexBody(body);
    expect(summary).toBe('instructionsLen=27 inputRoles=[developer,user,function_call] tools=2 effort=high');
    expect(summary).not.toContain('SENSITIVE');
    expect(summary).not.toContain('secret prompt');
    expect(summary).not.toContain('hello world');
  });
  it('handles absent instructions and unparseable bodies', () => {
    expect(summarizeCodexBody('{"input":[]}')).toBe('instructionsLen=0 inputRoles=[] tools=0 effort=-');
    expect(summarizeCodexBody('not json')).toBe('unparseable');
  });
});
