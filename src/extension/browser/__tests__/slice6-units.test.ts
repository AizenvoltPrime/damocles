import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as vscode from 'vscode';
import { BrowserService } from '../index';
import { buildBrowserPiTools } from '../../pi-session/tools/browser-tools';

/**
 * Pure unit tests for Slice-6 BrowserIntercept logic that needs NO real browser. Each test drives the
 * REAL BrowserService (its real addInterceptRule/listInterceptRules/clearInterceptRules and the real
 * route handler it builds) against an injected FAKE Playwright context that records route/unroute calls,
 * plus a fake `route` object whose abort/continue/fulfill/fallback are spied. This proves the
 * coexistence design: every action path terminates in EXACTLY ONE terminal (no hung requests).
 */

type RouteHandler = (route: unknown) => Promise<void>;

/** A fake Playwright BrowserContext that records route()/unroute() calls (pattern + handler). */
function fakeContext() {
  const routeCalls: { pattern: string; handler: RouteHandler }[] = [];
  const unrouteCalls: { pattern: string; handler: RouteHandler }[] = [];
  const context = {
    route: (pattern: string, handler: RouteHandler) => { routeCalls.push({ pattern, handler }); },
    unroute: (pattern: string, handler: RouteHandler) => { unrouteCalls.push({ pattern, handler }); },
  };
  return { context, routeCalls, unrouteCalls };
}

/** A fake Playwright Route whose four terminals are counting spies; request().headers() is fixed. */
function fakeRoute(requestHeaders: Record<string, string> = { 'x-existing': '1' }) {
  const calls = { abort: 0, continue: [] as unknown[], fulfill: [] as unknown[], fallback: 0 };
  const route = {
    abort: async () => { calls.abort++; },
    continue: async (opts?: unknown) => { calls.continue.push(opts); },
    fulfill: async (opts?: unknown) => { calls.fulfill.push(opts); },
    fallback: async () => { calls.fallback++; },
    request: () => ({ headers: () => requestHeaders }),
  };
  return { route, calls };
}

/** Total number of terminal calls across all four terminals (must be exactly 1 per handler run). */
function terminalCount(calls: { abort: number; continue: unknown[]; fulfill: unknown[]; fallback: number }): number {
  return calls.abort + calls.continue.length + calls.fulfill.length + calls.fallback;
}

function serviceWith(context: unknown): BrowserService {
  const service = new BrowserService();
  (service as unknown as { context: unknown }).context = context;
  return service;
}

describe('Slice 6 — intercept handler terminals (exactly one, never hangs)', () => {
  it('block → route.abort() (and nothing else)', async () => {
    const { context, routeCalls } = fakeContext();
    const service = serviceWith(context);
    service.addInterceptRule({ pattern: '**/tracker.png', action: 'block' });
    const { route, calls } = fakeRoute();
    await routeCalls[0]!.handler(route);
    expect(calls.abort).toBe(1);
    expect(terminalCount(calls)).toBe(1);
  });

  it('fulfill → route.fulfill({status,headers,body}) (and nothing else)', async () => {
    const { context, routeCalls } = fakeContext();
    const service = serviceWith(context);
    service.addInterceptRule({
      pattern: '**/api/data',
      action: 'fulfill',
      fulfill: { status: 201, headers: { 'content-type': 'application/json' }, body: '{"mock":true}' },
    });
    const { route, calls } = fakeRoute();
    await routeCalls[0]!.handler(route);
    expect(calls.fulfill).toHaveLength(1);
    expect(calls.fulfill[0]).toEqual({ status: 201, headers: { 'content-type': 'application/json' }, body: '{"mock":true}' });
    expect(terminalCount(calls)).toBe(1);
  });

  it('continue + modify.headers → route.continue() with MERGED headers (existing preserved, overrides applied)', async () => {
    const { context, routeCalls } = fakeContext();
    const service = serviceWith(context);
    service.addInterceptRule({
      pattern: '**/api/**',
      action: 'continue',
      modify: { headers: { 'x-added': 'yes', 'x-existing': 'overridden' } },
    });
    const { route, calls } = fakeRoute({ 'x-existing': '1', 'x-keep': 'k' });
    await routeCalls[0]!.handler(route);
    expect(calls.continue).toHaveLength(1);
    expect(calls.continue[0]).toEqual({ headers: { 'x-existing': 'overridden', 'x-keep': 'k', 'x-added': 'yes' } });
    expect(terminalCount(calls)).toBe(1);
  });

  it('continue with NO modify (pure let-through) → route.fallback() so Patchright\'s route still runs', async () => {
    const { context, routeCalls } = fakeContext();
    const service = serviceWith(context);
    service.addInterceptRule({ pattern: '**/*.js', action: 'continue' });
    const { route, calls } = fakeRoute();
    await routeCalls[0]!.handler(route);
    expect(calls.fallback).toBe(1);
    expect(terminalCount(calls)).toBe(1);
  });

  it('a terminal that throws falls back (never-hang guard) — still exactly one settled terminal', async () => {
    const { context, routeCalls } = fakeContext();
    const service = serviceWith(context);
    service.addInterceptRule({ pattern: '**/tracker.png', action: 'block' });
    // abort() throws → the catch calls fallback() so the request proceeds instead of hanging.
    let fellBack = 0;
    const route = {
      abort: async () => { throw new Error('boom'); },
      continue: async () => {},
      fulfill: async () => {},
      fallback: async () => { fellBack++; },
      request: () => ({ headers: () => ({}) }),
    };
    await routeCalls[0]!.handler(route);
    expect(fellBack).toBe(1);
  });
});

describe('Slice 6 — registry lifecycle (route/unroute + redaction)', () => {
  it('addInterceptRule registers on the context with the rule pattern and returns an id', () => {
    const { context, routeCalls } = fakeContext();
    const service = serviceWith(context);
    const id = service.addInterceptRule({ pattern: '**/*.png', action: 'block' });
    expect(id).toMatch(/^ir_/);
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]!.pattern).toBe('**/*.png');
  });

  it('addInterceptRule throws when the context is null (browser not connected)', () => {
    const service = new BrowserService(); // context defaults to null
    expect(() => service.addInterceptRule({ pattern: '**/*.png', action: 'block' })).toThrow(/not connected/i);
  });

  it('rejects an over-broad pattern for block/fulfill but allows it for continue', () => {
    const { context, routeCalls } = fakeContext();
    const service = serviceWith(context);
    for (const pattern of ['**', '*', '**/*', '*://*/*']) {
      expect(() => service.addInterceptRule({ pattern, action: 'block' })).toThrow(/over-broad/i);
      expect(() =>
        service.addInterceptRule({ pattern, action: 'fulfill', fulfill: { status: 204 } }),
      ).toThrow(/over-broad/i);
    }
    // A pass-through (continue) rule may legitimately target everything (e.g. a header injector).
    const id = service.addInterceptRule({ pattern: '**', action: 'continue', modify: { headers: { 'x-a': '1' } } });
    expect(id).toMatch(/^ir_/);
    // A specific block pattern is still accepted.
    expect(() => service.addInterceptRule({ pattern: '**/tracker.png', action: 'block' })).not.toThrow();
    expect(routeCalls.some((c) => c.pattern === '**/tracker.png')).toBe(true);
  });
});

/**
 * Slice 5 / S4 — the over-broad predicate, exercised through the PUBLIC `addInterceptRule`.
 *
 * The defect this closes: the old predicate stripped only wildcard/separator characters WITHOUT first
 * removing the scheme, so `https://**` reduced to the non-empty string `"https"` and PASSED. A
 * `block` rule on it then aborted every HTTPS request on the
 * page — precisely the outcome the guard exists to prevent. Scheme-prefixed catch-alls are therefore
 * the load-bearing cases here, not the bare `**` the old test already covered.
 */
describe('Slice 5 — over-broad intercept patterns (S4)', () => {
  // Every one of these matches effectively every request. `://**` and `https://**` are the S4 regression
  // cases; `HTTP://*` pins the case-insensitivity of the scheme strip.
  // Every one of these matches effectively every request. The brace-group rows are the second
  // regression: a source-text strip cannot see them because `{`, `}` and `,` survive it, yet the real
  // glob compiler turns `{**}` into `^((.*))$` and `{**,*}` into `^((.*)|([^/]*))$` — both universal.
  // Judging the COMPILED pattern against probe URLs is what closes that class rather than one spelling.
  const OVER_BROAD = [
    '**', '*', '**/*', '://**', 'https://**', 'HTTP://*', '*://*/*',
    '{**}', '{**,*}', '{*,**}', '**{}', '**/**', '{https://**,http://**}',
    '/.*/', // regex-literal notation is compiled and tested the same way, so it is not a way around
  ];
  // Real, useful patterns that must keep working — the positive control. If the predicate over-corrects
  // (e.g. strips the scheme AND the host), these start throwing and the guard becomes unusable.
  const ALLOWED = [
    '**/tracker.png', '**/*.png', 'https://api.example.com/**',
    // A brace group is a legitimate, useful pattern — the guard must reject what it MATCHES, not the
    // notation. Rejecting braces wholesale would be an over-correction that breaks real rules.
    '{**/*.png,**/*.jpg}', '/example\\.com\\/api/',
  ];

  for (const pattern of OVER_BROAD) {
    it(`refuses "${pattern}" for BOTH block and fulfill, naming it as over-broad`, () => {
      const { context, routeCalls } = fakeContext();
      const service = serviceWith(context);

      expect(() => service.addInterceptRule({ pattern, action: 'block' })).toThrow(/over-broad/i);
      expect(() => service.addInterceptRule({ pattern, action: 'fulfill', fulfill: { status: 204 } })).toThrow(/over-broad/i);
      // The message names the offending pattern and the action, so the agent can act on it.
      let message = '';
      try { service.addInterceptRule({ pattern, action: 'block' }); } catch (err) { message = (err as Error).message; }
      expect(message).toContain(pattern);
      expect(message).toContain('block');

      // A refused rule leaves NOTHING behind: no route registered, no registry entry.
      expect(routeCalls).toHaveLength(0);
      expect(service.listInterceptRules()).toHaveLength(0);
    });
  }

  for (const pattern of ALLOWED) {
    it(`still accepts the narrow pattern "${pattern}" for block and fulfill`, () => {
      const { context, routeCalls } = fakeContext();
      const service = serviceWith(context);

      expect(() => service.addInterceptRule({ pattern, action: 'block' })).not.toThrow();
      expect(() => service.addInterceptRule({ pattern, action: 'fulfill', fulfill: { status: 200 } })).not.toThrow();
      expect(service.listInterceptRules()).toHaveLength(2);
      expect(routeCalls.map((c) => c.pattern)).toEqual([pattern, pattern]);
    });
  }

  it('leaves the continue carve-out intact — a pass-through rule may target everything', () => {
    const { context } = fakeContext();
    const service = serviceWith(context);
    for (const pattern of OVER_BROAD) {
      expect(() =>
        service.addInterceptRule({ pattern, action: 'continue', modify: { headers: { 'x-a': '1' } } }),
      ).not.toThrow();
    }
    expect(service.listInterceptRules()).toHaveLength(OVER_BROAD.length);
  });

  it('the S4 regression case specifically: a block on "https://**" no longer registers a route', () => {
    // Guarding the exact defect. Before the fix this call SUCCEEDED and aborted every HTTPS request.
    const { context, routeCalls } = fakeContext();
    const service = serviceWith(context);
    expect(() => service.addInterceptRule({ pattern: 'https://**', action: 'block' })).toThrow(/over-broad/i);
    expect(routeCalls).toHaveLength(0);

    // POSITIVE CONTROL: the same scheme with a real host still registers, so the fix is not just
    // "reject anything containing a scheme".
    expect(() => service.addInterceptRule({ pattern: 'https://ads.example.com/**', action: 'block' })).not.toThrow();
    expect(routeCalls.map((c) => c.pattern)).toEqual(['https://ads.example.com/**']);
  });

  it('surfaces the over-broad refusal through the BrowserIntercept tool as an error, not a silent no-op', async () => {
    type ToolLike = { name: string; execute: (id: string, input: unknown) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> };
    const { context } = fakeContext();
    const service = serviceWith(context);
    const scope = service.createAgentScope(BrowserService.PRIMARY_SCOPE_ID);
    const built = buildBrowserPiTools({ pi: { defineTool: (c: unknown) => c }, scope } as never) as unknown as ToolLike[];
    const tool = new Map(built.map((t) => [t.name, t])).get('BrowserIntercept')!;

    const res = await tool.execute('t', { action: 'add', pattern: 'https://**', type: 'block' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/over-broad/i);
    expect(service.listInterceptRules()).toHaveLength(0);

    // POSITIVE CONTROL: a narrow pattern through the SAME tool path succeeds.
    const ok = await tool.execute('t', { action: 'add', pattern: 'https://ads.example.com/**', type: 'block' });
    expect(ok.isError).toBeFalsy();
    expect(service.listInterceptRules()).toHaveLength(1);
  });
});

/**
 * Slice 5 / S5 — intercept header bounds. `fulfill.headers` / `modify.headers` are agent-supplied and
 * applied context-wide, so a rule can reach past "mock this response" into the connection itself or
 * the shared profile's cookie jar. The bound is deliberately NARROW (contract §5): `Set-Cookie` on
 * fulfill, hop-by-hop headers on both. `Cookie`/`Authorization` on modify stay ALLOWED by design —
 * that power is documented, not closed — and the positive controls below pin that so a later
 * over-correction is caught.
 */
describe('Slice 5 — intercept header bounds (S5)', () => {
  const HOP_BY_HOP = ['Connection', 'Transfer-Encoding', 'Upgrade', 'Keep-Alive', 'Proxy-Authorization'];

  const addFulfill = (service: BrowserService, headers: Record<string, string>) =>
    service.addInterceptRule({ pattern: '**/api/data', action: 'fulfill', fulfill: { status: 200, headers } });
  const addModify = (service: BrowserService, headers: Record<string, string>) =>
    service.addInterceptRule({ pattern: '**/api/**', action: 'continue', modify: { headers } });

  it('rejects Set-Cookie in fulfill.headers, naming the header', () => {
    const { context, routeCalls } = fakeContext();
    const service = serviceWith(context);
    expect(() => addFulfill(service, { 'Set-Cookie': 'session=hijacked' })).toThrow(/set-cookie/i);
    // No partial registration: the rule left no route and no registry entry.
    expect(routeCalls).toHaveLength(0);
    expect(service.listInterceptRules()).toHaveLength(0);
  });

  it('rejects set-cookie case-insensitively (a lowercase spelling is not a bypass)', () => {
    const { context } = fakeContext();
    const service = serviceWith(context);
    expect(() => addFulfill(service, { 'set-cookie': 'a=b' })).toThrow(/set-cookie/i);
    expect(() => addFulfill(service, { 'SET-COOKIE': 'a=b' })).toThrow(/set-cookie/i);
    expect(service.listInterceptRules()).toHaveLength(0);
  });

  for (const header of HOP_BY_HOP) {
    it(`rejects the hop-by-hop header "${header}" in BOTH fulfill and modify`, () => {
      const { context, routeCalls } = fakeContext();
      const service = serviceWith(context);

      expect(() => addFulfill(service, { [header]: 'x' })).toThrow(new RegExp(header, 'i'));
      expect(() => addModify(service, { [header]: 'x' })).toThrow(new RegExp(header, 'i'));

      // The message says WHERE, so the agent knows which half of the rule to fix.
      let message = '';
      try { addModify(service, { [header]: 'x' }); } catch (err) { message = (err as Error).message; }
      expect(message).toContain(header);
      expect(message).toContain('modify.headers');

      expect(routeCalls).toHaveLength(0);
      expect(service.listInterceptRules()).toHaveLength(0);
    });
  }

  it('rejects hop-by-hop headers case-insensitively (CONNECTION, transfer-encoding)', () => {
    const { context } = fakeContext();
    const service = serviceWith(context);
    expect(() => addFulfill(service, { CONNECTION: 'keep-alive' })).toThrow(/connection/i);
    expect(() => addModify(service, { 'transfer-encoding': 'chunked' })).toThrow(/transfer-encoding/i);
    expect(() => addModify(service, { 'PROXY-Authenticate': 'x' })).toThrow(/proxy-authenticate/i);
    expect(service.listInterceptRules()).toHaveLength(0);
  });

  /**
   * A deny-list that reads only the header NAME is not a deny-list. `headersObjectToArray` passes
   * these straight to `Fetch.fulfillRequest`, and `splitSetCookieHeader` downstream exists precisely
   * to split multi-value headers — so the machinery honours exactly this injection. Every row below
   * was verified ALLOWED against the name-only check, and each smuggles a header the rule above it
   * claims to forbid.
   */
  it.each([
    ['CRLF in the VALUE carrying a Set-Cookie', { 'X-Foo': 'bar\r\nSet-Cookie: session=attacker' }],
    ['CRLF in the NAME, past where the lookup reads', { 'X-Foo\r\nSet-Cookie': 'x' }],
    ['a bare LF in the value', { 'X-A': 'v\nX-Injected: 1' }],
    ['a lone CR in the value', { 'X-A': 'v\rX-Injected: 1' }],
    ['whitespace padding that defeats the name lookup', { ' Set-Cookie ': 'a=b' }],
    ['a NUL byte in the value', { 'X-Null': 'a\u0000b' }],
    ['a separator character in the name', { 'X-Foo: Set-Cookie': 'a=b' }],
    ['an empty name', { '': 'a=b' }],
  ])('rejects %s', (_label, headers) => {
    const { context, routeCalls } = fakeContext();
    const service = serviceWith(context);

    expect(() => addFulfill(service, headers)).toThrow();
    expect(() => addModify(service, headers)).toThrow();
    expect(routeCalls).toHaveLength(0);
    expect(service.listInterceptRules()).toHaveLength(0);
  });

  it('never echoes a rejected header VALUE back to the model', () => {
    // The value is the field most likely to hold a credential, and the error text goes straight into
    // the transcript. Naming the header is actionable; repeating its value is a second leak.
    const { context } = fakeContext();
    const service = serviceWith(context);
    let message = '';
    try {
      addFulfill(service, { 'X-Foo': 'hunter2-SECRET\r\nSet-Cookie: a=b' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain('hunter2-SECRET');
    // POSITIVE CONTROL: it still says WHICH header, so the agent can fix the rule.
    expect(message).toContain('X-Foo');
  });

  it('POSITIVE CONTROL — ordinary values with punctuation and spaces still pass', () => {
    // The syntax check must reject control characters, not everything that is not alphanumeric.
    const { context } = fakeContext();
    const service = serviceWith(context);
    expect(() => addFulfill(service, {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: '*/*',
      'Cache-Control': 'no-cache, no-store, max-age=0',
      'X-Trace': 'a=1&b=2 (client)',
    })).not.toThrow();
    expect(service.listInterceptRules()).toHaveLength(1);
  });

  it('rejects the whole rule when only ONE of several headers is forbidden', () => {
    // Validation must run before registration, not per-header mid-install: a rule with two good
    // headers and one bad one must leave NO trace.
    const { context, routeCalls } = fakeContext();
    const service = serviceWith(context);
    expect(() =>
      addFulfill(service, { 'content-type': 'application/json', 'X-Test': 'ok', Connection: 'close' }),
    ).toThrow(/connection/i);
    expect(routeCalls).toHaveLength(0);
    expect(service.listInterceptRules()).toHaveLength(0);
  });

  it('POSITIVE CONTROL — Set-Cookie is allowed on a MODIFY rule (the bound is fulfill-only, by design)', () => {
    const { context, routeCalls } = fakeContext();
    const service = serviceWith(context);
    // On a request, `Set-Cookie` is not the cookie-writing response header — blocking it here would be
    // an over-correction the brief explicitly does not ask for.
    expect(() => addModify(service, { 'Set-Cookie': 'a=b' })).not.toThrow();
    expect(service.listInterceptRules()).toHaveLength(1);
    expect(routeCalls).toHaveLength(1);
  });

  it('POSITIVE CONTROL — ordinary headers still work, including Cookie/Authorization on modify', () => {
    const { context } = fakeContext();
    const service = serviceWith(context);
    expect(() => addFulfill(service, { 'content-type': 'application/json', 'X-Test': '1' })).not.toThrow();
    // The brief DELIBERATELY leaves these available: attaching credentials to matched requests is
    // within the agent's granted power, and the boundary is documented rather than closed.
    expect(() => addModify(service, { Cookie: 'session=abc', Authorization: 'Bearer t', 'X-Test': '1' })).not.toThrow();
    expect(service.listInterceptRules()).toHaveLength(2);
  });

  it('POSITIVE CONTROL — an accepted rule really is live (its handler applies the headers)', () => {
    // Proves the acceptance above is not merely "did not throw": the registered handler runs and
    // merges the allowed headers onto the request.
    const { context, routeCalls } = fakeContext();
    const service = serviceWith(context);
    addModify(service, { Authorization: 'Bearer t' });
    const { route, calls } = fakeRoute({ 'x-existing': '1' });
    return routeCalls[0]!.handler(route).then(() => {
      expect(calls.continue[0]).toEqual({ headers: { 'x-existing': '1', Authorization: 'Bearer t' } });
    });
  });

  it('surfaces the header refusal through the BrowserIntercept tool as an error', async () => {
    type ToolLike = { name: string; execute: (id: string, input: unknown) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> };
    const { context } = fakeContext();
    const service = serviceWith(context);
    const scope = service.createAgentScope(BrowserService.PRIMARY_SCOPE_ID);
    const built = buildBrowserPiTools({ pi: { defineTool: (c: unknown) => c }, scope } as never) as unknown as ToolLike[];
    const tool = new Map(built.map((t) => [t.name, t])).get('BrowserIntercept')!;

    const res = await tool.execute('t', {
      action: 'add', pattern: '**/api/data', type: 'fulfill', status: 200, headers: { 'Set-Cookie': 'a=b' },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/set-cookie/i);
    expect(service.listInterceptRules()).toHaveLength(0);

    const hop = await tool.execute('t', {
      action: 'add', pattern: '**/api/**', type: 'modify', headers: { Connection: 'close' },
    });
    expect(hop.isError).toBe(true);
    expect(hop.content[0]!.text).toMatch(/connection/i);
    expect(service.listInterceptRules()).toHaveLength(0);

    // POSITIVE CONTROL: an ordinary header through the SAME tool path succeeds.
    const ok = await tool.execute('t', {
      action: 'add', pattern: '**/api/**', type: 'modify', headers: { 'X-Test': '1' },
    });
    expect(ok.isError).toBeFalsy();
    expect(service.listInterceptRules()).toHaveLength(1);
  });

  it('documents the context-wide trust boundary in the BrowserIntercept description', () => {
    type ToolLike = { name: string; description: string };
    const { context } = fakeContext();
    const service = serviceWith(context);
    const scope = service.createAgentScope(BrowserService.PRIMARY_SCOPE_ID);
    const built = buildBrowserPiTools({ pi: { defineTool: (c: unknown) => c }, scope } as never) as unknown as ToolLike[];
    const description = new Map(built.map((t) => [t.name, t])).get('BrowserIntercept')!.description;

    expect(description).toMatch(/context-wide|context-global/i);
    expect(description).toMatch(/set-cookie/i);
    expect(description).toMatch(/hop-by-hop/i);
  });

  it('clears intercept rules synchronously on context loss (session teardown)', () => {
    const { context } = fakeContext();
    const service = serviceWith(context);
    service.addInterceptRule({ pattern: '**/api/data', action: 'block' });
    expect(service.listInterceptRules()).toHaveLength(1);
    // A Chrome crash fires the context 'close' event. With one editor tab per page there is no single
    // recovery panel to keep alive: the session tears down and intercept rules drop immediately (they
    // are routes on the now-dead context and must not surface as phantoms).
    const s = service as unknown as { handleContextGone: (c: unknown) => void };
    s.handleContextGone(context);
    expect(service.listInterceptRules()).toHaveLength(0);
  });

  it('listInterceptRules REDACTS the fulfill body (bodyBytes only) and reports header keys', () => {
    const { context } = fakeContext();
    const service = serviceWith(context);
    const secret = '{"token":"super-secret-value"}';
    service.addInterceptRule({
      pattern: '**/api/data',
      action: 'fulfill',
      fulfill: { status: 200, headers: { 'content-type': 'application/json' }, body: secret },
    });
    service.addInterceptRule({ pattern: '**/api/**', action: 'continue', modify: { headers: { 'x-a': '1', 'x-b': '2' } } });

    const listed = service.listInterceptRules();
    expect(listed).toHaveLength(2);
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain('super-secret-value');
    // The raw body value is never present; only the redacted `bodyBytes` metric is exposed.
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('"body"');

    const fulfillView = listed.find((r) => r.action === 'fulfill')!;
    expect(fulfillView.status).toBe(200);
    expect(fulfillView.bodyBytes).toBe(Buffer.byteLength(secret, 'utf8'));
    expect(fulfillView.fulfillHeaderKeys).toEqual(['content-type']);

    const modifyView = listed.find((r) => r.action === 'continue')!;
    expect(modifyView.modifyHeaderKeys).toEqual(['x-a', 'x-b']);
  });

  it('clearInterceptRules calls unroute per pattern/handler and empties the registry', () => {
    const { context, routeCalls, unrouteCalls } = fakeContext();
    const service = serviceWith(context);
    service.addInterceptRule({ pattern: '**/a.png', action: 'block' });
    service.addInterceptRule({ pattern: '**/b.png', action: 'block' });
    expect(service.listInterceptRules()).toHaveLength(2);

    service.clearInterceptRules();
    expect(service.listInterceptRules()).toHaveLength(0);
    expect(unrouteCalls).toHaveLength(2);
    expect(unrouteCalls.map((c) => c.pattern)).toEqual(['**/a.png', '**/b.png']);
    // The exact handler references registered via route() are the ones unrouted (required for removal).
    expect(unrouteCalls[0]!.handler).toBe(routeCalls[0]!.handler);
    expect(unrouteCalls[1]!.handler).toBe(routeCalls[1]!.handler);
  });
});

describe('Slice 6 — BrowserIntercept tool (validation + body-size cap, no body echo)', () => {
  type ToolLike = { name: string; execute: (id: string, input: unknown) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> };
  function toolsFor(service: BrowserService): Map<string, ToolLike> {
    // Intercept rules are context-global: the scope forwards add/list/clear straight to the service.
    const scope = service.createAgentScope(BrowserService.PRIMARY_SCOPE_ID);
    const built = buildBrowserPiTools({ pi: { defineTool: (c: unknown) => c }, scope } as never) as unknown as ToolLike[];
    return new Map(built.map((t) => [t.name, t]));
  }

  it('rejects a fulfill body over the 1 MB cap (fail-loud, never truncates or echoes the body)', async () => {
    const { context } = fakeContext();
    const service = serviceWith(context);
    const tool = toolsFor(service).get('BrowserIntercept')!;
    const oversized = 'a'.repeat(1_048_576 + 1);
    const res = await tool.execute('t', { action: 'add', pattern: '**/api/data', type: 'fulfill', status: 200, body: oversized });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('exceeding');
    // The oversized body must NOT be echoed back.
    expect(res.content[0]!.text).not.toContain(oversized);
    // No rule was registered.
    expect(service.listInterceptRules()).toHaveLength(0);
  });

  it('accepts a fulfill body at the 1 MB cap boundary', async () => {
    const { context } = fakeContext();
    const service = serviceWith(context);
    const tool = toolsFor(service).get('BrowserIntercept')!;
    const atCap = 'a'.repeat(1_048_576);
    const res = await tool.execute('t', { action: 'add', pattern: '**/api/data', type: 'fulfill', status: 200, body: atCap });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain('Added intercept rule');
    expect(service.listInterceptRules()).toHaveLength(1);
  });

  it('add requires pattern + type; fulfill requires status; modify requires headers', async () => {
    const { context } = fakeContext();
    const service = serviceWith(context);
    const tool = toolsFor(service).get('BrowserIntercept')!;

    const noPattern = await tool.execute('t', { action: 'add', type: 'block' });
    expect(noPattern.isError).toBe(true);
    expect(noPattern.content[0]!.text).toContain('requires both');

    const noStatus = await tool.execute('t', { action: 'add', pattern: '**/x', type: 'fulfill' });
    expect(noStatus.isError).toBe(true);
    expect(noStatus.content[0]!.text).toContain('status');

    const noHeaders = await tool.execute('t', { action: 'add', pattern: '**/x', type: 'modify' });
    expect(noHeaders.isError).toBe(true);
    expect(noHeaders.content[0]!.text).toContain('headers');

    expect(service.listInterceptRules()).toHaveLength(0);
  });

  it('add → list → clear round-trip through the tool (list is redacted, clear reports the count)', async () => {
    const { context } = fakeContext();
    const service = serviceWith(context);
    const tool = toolsFor(service).get('BrowserIntercept')!;

    const emptyList = await tool.execute('t', { action: 'list' });
    expect(emptyList.content[0]!.text).toBe('No intercept rules.');

    await tool.execute('t', { action: 'add', pattern: '**/*.png', type: 'block' });
    await tool.execute('t', { action: 'add', pattern: '**/api/data', type: 'fulfill', status: 200, body: '{"secret":"xyz"}' });

    const list = await tool.execute('t', { action: 'list' });
    const listText = list.content[0]!.text!;
    expect(listText).toContain('Intercept rules (2)');
    expect(listText).toContain('block');
    expect(listText).toContain('bodyBytes=');
    expect(listText).not.toContain('secret');

    const clear = await tool.execute('t', { action: 'clear' });
    expect(clear.content[0]!.text).toBe('Cleared 2 intercept rule(s).');
    expect(service.listInterceptRules()).toHaveLength(0);
  });

  it('modify maps to a continue rule with modify.headers', async () => {
    const { context, routeCalls } = fakeContext();
    const service = serviceWith(context);
    const tool = toolsFor(service).get('BrowserIntercept')!;
    const res = await tool.execute('t', { action: 'add', pattern: '**/api/**', type: 'modify', headers: { 'x-trace': 'abc' } });
    expect(res.isError).toBeFalsy();
    const rule = service.listInterceptRules()[0]!;
    expect(rule.action).toBe('continue');
    expect(rule.modifyHeaderKeys).toEqual(['x-trace']);
    // The registered handler merges headers on continue.
    const { route, calls } = fakeRoute({ 'x-existing': '1' });
    await routeCalls[0]!.handler(route);
    expect(calls.continue[0]).toEqual({ headers: { 'x-existing': '1', 'x-trace': 'abc' } });
  });
});

/**
 * Slice 5 / S6 — the DevTools debugging port.
 *
 * Two independent behaviours, both driven through the REAL `openDevToolsFor` / `readDevToolsPort`:
 *  1. STALENESS. `DevToolsActivePort` survives a crashed launch, so the port it names can now belong
 *     to an unrelated local process. Opening an external window at that port would aim the user (and
 *     a DevTools client) at a foreign service. A real loopback HTTP server stands in for that process,
 *     so the probe is exercised end-to-end rather than against a mocked fetch.
 *  2. DISABLED. With `damocles.browser.devToolsPort` false there is no port at all, so the button must
 *     explain why and offer Open Settings — and must not probe anything.
 */
describe('Slice 5 — DevTools port: staleness guard + disabled path (S6)', () => {
  let server: Server | null = null;
  let userDataDir = '';
  const warnings: unknown[][] = [];
  const executed: unknown[][] = [];
  let warningChoice: string | undefined;

  const realGetConfiguration = vscode.workspace.getConfiguration;

  /** Serve `payload` on loopback; `null` yields a real port with NOTHING listening (connection refused). */
  async function serveOnPort(payload: string | null, contentType = 'application/json'): Promise<number> {
    if (payload === null) {
      const probe = createServer();
      await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
      const dead = (probe.address() as AddressInfo).port;
      await new Promise<void>((r) => probe.close(() => r()));
      return dead;
    }
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': contentType });
      res.end(payload);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return (server!.address() as AddressInfo).port;
  }

  async function serviceForPort(port: number): Promise<{ service: BrowserService; readPort: () => Promise<number | null> }> {
    await fsp.writeFile(join(userDataDir, 'DevToolsActivePort'), `${port}\n/devtools/browser/abc\n`, 'utf8');
    const service = new BrowserService();
    (service as unknown as { userDataDir: string }).userDataDir = userDataDir;
    return {
      service,
      readPort: () => (service as unknown as { readDevToolsPort: () => Promise<number | null> }).readDevToolsPort(),
    };
  }

  const openedExternal = (): unknown[] => (vscode as unknown as { __openedExternal: unknown[] }).__openedExternal;
  const openDevTools = (service: BrowserService): Promise<void> =>
    (service as unknown as { openDevToolsFor: (e: unknown) => Promise<void> })
      .openDevToolsFor({ page: { url: () => 'http://example.com' } });

  beforeEach(async () => {
    userDataDir = await fsp.mkdtemp(join(tmpdir(), 'damocles-devtools-'));
    warnings.length = 0;
    executed.length = 0;
    warningChoice = undefined;
    openedExternal().splice(0);
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage =
      (...args: unknown[]) => { warnings.push(args); return Promise.resolve(warningChoice); };
    (vscode.commands as unknown as { executeCommand: unknown }).executeCommand =
      (...args: unknown[]) => { executed.push(args); return Promise.resolve(undefined); };
  });

  afterEach(async () => {
    if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
    (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = realGetConfiguration;
    await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('POSITIVE CONTROL — a Chrome-shaped /json/version payload yields the port', async () => {
    // Without this, every "returns null" assertion below would also pass against an implementation
    // that simply always returned null — i.e. a permanently broken DevTools button.
    const port = await serveOnPort(JSON.stringify({ Browser: 'Chrome/121.0.6167.85', 'Protocol-Version': '1.3' }));
    const { readPort } = await serviceForPort(port);
    expect(await readPort()).toBe(port);
  });

  it('POSITIVE CONTROL — a headless Chrome payload is also accepted', async () => {
    const port = await serveOnPort(JSON.stringify({ Browser: 'HeadlessChrome/121.0.6167.85' }));
    const { readPort } = await serviceForPort(port);
    expect(await readPort()).toBe(port);
  });

  it('returns null when the recorded port answers with a NON-Chrome payload (foreign process)', async () => {
    // The exact stale-file threat: another local service now owns the port and answers happily.
    const port = await serveOnPort(JSON.stringify({ Browser: 'nginx/1.25.3', status: 'ok' }));
    const { readPort } = await serviceForPort(port);
    expect(await readPort()).toBeNull();
  });

  it('returns null when the port answers with a Firefox-shaped payload (not our browser)', async () => {
    const port = await serveOnPort(JSON.stringify({ Browser: 'Firefox/122.0' }));
    const { readPort } = await serviceForPort(port);
    expect(await readPort()).toBeNull();
  });

  it('returns null when the port serves non-JSON (an unrelated HTTP service)', async () => {
    const port = await serveOnPort('<html><body>some other app</body></html>', 'text/html');
    const { readPort } = await serviceForPort(port);
    expect(await readPort()).toBeNull();
  });

  it('returns null when the port refuses the connection (process gone)', async () => {
    const port = await serveOnPort(null);
    const { readPort } = await serviceForPort(port);
    expect(await readPort()).toBeNull();
  });

  it('returns null when DevToolsActivePort is absent or unparseable', async () => {
    const service = new BrowserService();
    (service as unknown as { userDataDir: string }).userDataDir = userDataDir;
    const readPort = () => (service as unknown as { readDevToolsPort: () => Promise<number | null> }).readDevToolsPort();
    expect(await readPort()).toBeNull(); // no file at all

    await fsp.writeFile(join(userDataDir, 'DevToolsActivePort'), 'not-a-port\n', 'utf8');
    expect(await readPort()).toBeNull();
  });

  it('a stale port never reaches openExternal — no window is opened at a foreign process', async () => {
    const port = await serveOnPort(JSON.stringify({ Browser: 'nginx/1.25.3' }));
    const { service } = await serviceForPort(port);

    await openDevTools(service);

    expect(openedExternal()).toHaveLength(0);
  });

  it('POSITIVE CONTROL — a LIVE Chrome-shaped endpoint does open the DevTools URL at that port', async () => {
    // Proves the previous test discriminates on the payload, not on openDevToolsFor being inert.
    // One server answers both /json/version (the staleness guard) and /json (the target list).
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url === '/json/version'
        ? JSON.stringify({ Browser: 'Chrome/121.0.6167.85' })
        : JSON.stringify([{ id: 'TARGET1', type: 'page', url: 'http://example.com' }]));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const { service } = await serviceForPort(port);

    await openDevTools(service);

    const opened = openedExternal();
    expect(opened).toHaveLength(1);
    const url = String((opened[0] as { path?: string }).path ?? opened[0]);
    expect(url).toContain(`127.0.0.1:${port}`);
    expect(url).toContain('TARGET1');
  });

  describe('when damocles.browser.devToolsPort is disabled', () => {
    /** Force ONLY that key false, the way VS Code would; every other setting keeps its caller default. */
    function disableSetting(): void {
      (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = () => ({
        get: (key: string, defaultValue?: unknown) => (key === 'browser.devToolsPort' ? false : defaultValue),
        update: () => Promise.resolve(),
      });
    }

    it('warns with an Open Settings action and never probes the port', async () => {
      // The port here is LIVE and Chrome-shaped, so an implementation that probed anyway would open a
      // window. That is what makes "never probes" a real assertion rather than a vacuous one.
      const port = await serveOnPort(JSON.stringify({ Browser: 'Chrome/121.0.6167.85' }));
      const { service } = await serviceForPort(port);
      disableSetting();

      await openDevTools(service);

      expect(warnings).toHaveLength(1);
      const [message, ...actions] = warnings[0]! as [string, ...string[]];
      // The message names the setting and states that a RELAUNCH is required — a launch-time flag
      // cannot be toggled live, and implying otherwise would be a lie.
      expect(message).toContain('damocles.browser.devToolsPort');
      expect(message).toMatch(/relaunch/i);
      expect(actions).toContain('Open Settings');
      expect(openedExternal()).toHaveLength(0);
      expect(executed).toHaveLength(0);
    });

    it('runs workbench.action.openSettings when the user picks Open Settings', async () => {
      const port = await serveOnPort(JSON.stringify({ Browser: 'Chrome/121.0.6167.85' }));
      const { service } = await serviceForPort(port);
      disableSetting();
      warningChoice = 'Open Settings';

      await openDevTools(service);

      expect(executed).toHaveLength(1);
      expect(executed[0]![0]).toBe('workbench.action.openSettings');
      expect(executed[0]![1]).toBe('damocles.browser.devToolsPort');
    });

    it('does NOT run the command when the user dismisses the warning', async () => {
      const port = await serveOnPort(JSON.stringify({ Browser: 'Chrome/121.0.6167.85' }));
      const { service } = await serviceForPort(port);
      disableSetting();
      warningChoice = undefined; // dismissed

      await openDevTools(service);

      expect(warnings).toHaveLength(1);
      expect(executed).toHaveLength(0);
    });

    it('POSITIVE CONTROL — with the setting ENABLED the same call probes and opens, no warning', async () => {
      // Pins that the warning path is gated on the setting rather than always taken.
      server = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(req.url === '/json/version'
          ? JSON.stringify({ Browser: 'Chrome/121.0.6167.85' })
          : JSON.stringify([{ id: 'TARGET2', type: 'page', url: 'http://example.com' }]));
      });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
      const port = (server.address() as AddressInfo).port;
      const { service } = await serviceForPort(port);

      await openDevTools(service);

      expect(warnings).toHaveLength(0);
      expect(openedExternal()).toHaveLength(1);
    });
  });

  it('the setting reader defaults to TRUE, so behaviour is unchanged for anyone who ignores it', () => {
    // The vscode mock returns the CALLER's default, so this asserts production passes `true` as the
    // default to `get('browser.devToolsPort', ...)`. A reader defaulting to false would surface here.
    const service = new BrowserService();
    expect((service as unknown as { readDevToolsPortSetting: () => boolean }).readDevToolsPortSetting()).toBe(true);
  });

  it('the setting reader falls back to TRUE when the configuration lookup throws', () => {
    (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = () => {
      throw new Error('workspace not ready');
    };
    const service = new BrowserService();
    expect((service as unknown as { readDevToolsPortSetting: () => boolean }).readDevToolsPortSetting()).toBe(true);
  });
});
