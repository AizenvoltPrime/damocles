import { describe, it, expect } from 'vitest';
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
