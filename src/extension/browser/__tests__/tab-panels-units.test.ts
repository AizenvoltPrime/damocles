import { describe, it, expect, vi, afterEach } from 'vitest';
import { BrowserService } from '../index';
import { launchBrowserContext } from '../launcher';

/**
 * Unit tests for the one-editor-tab-per-page model AND per-agent scope isolation: each registered page
 * gets its OWN BrowserPanel, frames route to that page's panel, closing a tab disposes only its panel and
 * reactivates a neighbor, closing the last tab tears the session down, and selectTab reveals the target
 * panel. Tools resolve the SCOPE's current tab (not the human `activePage`), and the first open adopts
 * the launcher's initial page with no orphan blank tab. Drives the REAL BrowserService against fake
 * Playwright pages/sessions (the vscode mock provides createWebviewPanel).
 */

// The launcher is mocked so the "first open adopts the initial page" test can drive the real
// openForScope → ensureContext → launchAndAdopt path without a real Chromium. The other tests set
// `context` directly and never launch, so the mock stays inert for them.
vi.mock('../launcher', () => ({ launchBrowserContext: vi.fn() }));

type Handler = (...args: unknown[]) => unknown;

function fakePage(url = 'about:blank'): { on: (e: string, h: Handler) => void; url: () => string; close: ReturnType<typeof vi.fn>; opener: () => Promise<null> } {
  const handlers = new Map<string, Handler>();
  return {
    on: (e: string, h: Handler) => { handlers.set(e, h); },
    url: () => url,
    close: vi.fn(async () => {}),
    opener: async () => null,
  };
}

const fakeSession = { on: () => {} };

const PRIMARY = BrowserService.PRIMARY_SCOPE_ID;

type Priv = {
  context: unknown;
  pages: Map<unknown, { page: unknown; ownerScopeId: string; controller: unknown; panel: { reveal: () => void; dispose: () => void; pushFrame: (...a: unknown[]) => void }; lastFrame: unknown }>;
  scopes: Map<string, { currentPage: unknown }>;
  activePage: unknown;
  userDataDir: string | null;
  iconCacheDir: string | null;
  downloadManager: { downloadsDir: string | null };
  registerPage: (p: unknown, ownerScopeId?: string) => Promise<unknown>;
  setActivePage: (p: unknown) => void;
  handlePageClosed: (p: unknown) => void;
  onScreencastFrame: (entry: unknown, frame: unknown) => void;
};
/**
 * Slice 6 moved the screencast state machine onto `ScreencastController`. This proxy keeps the tests
 * addressing the service by the OLD names while every call lands on the REAL controller instance the
 * service owns — so these assertions still drive production code, not a copy.
 */
const MOVED_TO_SCREENCAST: Record<string, string> = {
  onScreencastFrame: 'onFrame',
  onFrameRendered: 'onFrameRendered',
  releasePendingAck: 'releasePendingAck',
  screencastOptions: 'options',
  startWatchdog: 'startWatchdog',
  clearWatchdog: 'clearWatchdog',
  startScreencast: 'start',
};
const priv = (s: BrowserService): Priv =>
  new Proxy(s as unknown as Priv, {
    get(target, prop: string, receiver) {
      const moved = MOVED_TO_SCREENCAST[prop];
      if (moved) {
        const ctrl = (target as unknown as { screencast: Record<string, (...a: unknown[]) => unknown> }).screencast;
        return (...args: unknown[]) => ctrl[moved]!(...args);
      }
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver) {
      return Reflect.set(target, prop, value, receiver);
    },
  });

/** A primary-scope handle over the service (mirrors what buildCustomTools threads into the tools). */
function scopeFor(service: BrowserService, id: string = PRIMARY) {
  return service.createAgentScope(id);
}

function serviceWith2Tabs(ctxExtra: Record<string, unknown> = {}): { service: BrowserService; pa: ReturnType<typeof fakePage>; pb: ReturnType<typeof fakePage> } {
  const service = new BrowserService();
  priv(service).context = { newCDPSession: async () => fakeSession, ...ctxExtra };
  const pa = fakePage('http://a');
  const pb = fakePage('http://b');
  return { service, pa, pb };
}

afterEach(() => {
  vi.mocked(launchBrowserContext).mockReset();
});

describe('tab panels — one editor tab per page', () => {
  it('gives every registered page its own panel and lists them (scope-scoped)', async () => {
    const { service, pa, pb } = serviceWith2Tabs();
    await priv(service).registerPage(pa, PRIMARY);
    await priv(service).registerPage(pb, PRIMARY);

    const entries = [...priv(service).pages.values()];
    expect(entries).toHaveLength(2);
    expect(entries[0]!.panel).toBeDefined();
    expect(entries[0]!.panel).not.toBe(entries[1]!.panel);
    expect(scopeFor(service).listTabs().map((t) => t.url)).toEqual(['http://a', 'http://b']);
  });

  it('routes a page\'s frames to that page\'s own panel and caches lastFrame', async () => {
    const { service, pa } = serviceWith2Tabs();
    await priv(service).registerPage(pa, PRIMARY);
    const entry = priv(service).pages.get(pa)!;
    const push = vi.spyOn(entry.panel, 'pushFrame');

    priv(service).onScreencastFrame(entry, { data: 'AAAA', metadata: { deviceWidth: 800, deviceHeight: 600 }, sessionId: 1 });

    // Slice 1: the host base64-decodes once and pushes bytes + a frameId (the ack correlation key).
    // The frame pipeline itself is covered in depth by frame-pipeline.test.ts.
    expect(push).toHaveBeenCalledWith(Buffer.from('AAAA', 'base64'), 800, 600, 0);
    expect(entry.lastFrame).toEqual({ bytes: Buffer.from('AAAA', 'base64'), deviceWidth: 800, deviceHeight: 600 });
  });

  it('closing the active middle tab disposes only its panel and activates the right neighbor', async () => {
    const { service, pa, pb } = serviceWith2Tabs();
    await priv(service).registerPage(pa, PRIMARY);
    await priv(service).registerPage(pb, PRIMARY);
    priv(service).setActivePage(pa);
    const entryA = priv(service).pages.get(pa)!;
    const disposeA = vi.spyOn(entryA.panel, 'dispose');

    priv(service).handlePageClosed(pa);

    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(priv(service).pages.has(pa)).toBe(false);
    expect(priv(service).activePage).toBe(pb); // right neighbor becomes active
  });

  it('closing the last tab tears the session down (context closed)', async () => {
    const ctxClose = vi.fn(async () => {});
    const { service, pa } = serviceWith2Tabs({ close: ctxClose });
    await priv(service).registerPage(pa, PRIMARY);
    priv(service).setActivePage(pa);

    priv(service).handlePageClosed(pa);
    await new Promise((r) => setTimeout(r, 0)); // let the async close() settle

    expect(ctxClose).toHaveBeenCalledTimes(1);
    expect(priv(service).pages.size).toBe(0);
    expect(service.isConnected()).toBe(false);
  });

  it('selectTab reveals the target page\'s editor tab and marks it the scope\'s current + human active', async () => {
    const { service, pa, pb } = serviceWith2Tabs();
    await priv(service).registerPage(pa, PRIMARY);
    await priv(service).registerPage(pb, PRIMARY);
    const revealA = vi.spyOn(priv(service).pages.get(pa)!.panel, 'reveal');
    const scope = scopeFor(service);

    await scope.selectTab(0);

    expect(revealA).toHaveBeenCalledTimes(1);
    expect(scope.getCurrentPage()).toBe(pa);
    expect(priv(service).activePage).toBe(pa);
  });
});

describe('per-agent scope isolation', () => {
  it('tools resolve the SCOPE\'s current tab, not the human activePage, after a focus change', async () => {
    const { service, pa, pb } = serviceWith2Tabs();
    await priv(service).registerPage(pa, PRIMARY);
    await priv(service).registerPage(pb, PRIMARY);
    const scope = scopeFor(service);
    // The scope's current tab is pa (what the agent drives).
    priv(service).scopes.get(PRIMARY)!.currentPage = pa;

    // The human focuses a DIFFERENT editor tab (pb) — exactly what onVisibilityChange does.
    priv(service).setActivePage(pb);

    // The agent's tools still act on pa (the scope's tab); only the human screencast moved to pb.
    expect(priv(service).activePage).toBe(pb);
    expect(scope.getCurrentPage()).toBe(pa);
    expect(scope.getController()).toBe(priv(service).pages.get(pa)!.controller);
  });

  it('a subagent scope lists ONLY its own tabs, never the primary\'s', async () => {
    const { service, pa, pb } = serviceWith2Tabs();
    await priv(service).registerPage(pa, PRIMARY);
    await priv(service).registerPage(pb, 'sub-1');
    priv(service).scopes.set('sub-1', { currentPage: pb });

    expect(scopeFor(service, PRIMARY).listTabs().map((t) => t.url)).toEqual(['http://a']);
    expect(scopeFor(service, 'sub-1').listTabs().map((t) => t.url)).toEqual(['http://b']);
  });

  it('disposeScope(closeTabs=false) keeps an errored subagent\'s tab open and drops its registry entry', async () => {
    const { service, pa, pb } = serviceWith2Tabs();
    await priv(service).registerPage(pa, PRIMARY);
    await priv(service).registerPage(pb, 'sub-1');
    priv(service).scopes.set('sub-1', { currentPage: pb });

    service.disposeScope('sub-1', false);

    expect(pb.close).not.toHaveBeenCalled(); // tab kept for inspection
    expect(priv(service).scopes.has('sub-1')).toBe(false); // no registry leak
    expect(priv(service).pages.has(pb)).toBe(true);
  });

  it('disposeScope(closeTabs=true) closes a successful subagent\'s tabs', async () => {
    const { service, pa, pb } = serviceWith2Tabs();
    await priv(service).registerPage(pa, PRIMARY);
    await priv(service).registerPage(pb, 'sub-1');
    priv(service).scopes.set('sub-1', { currentPage: pb });

    service.disposeScope('sub-1', true);

    expect(pb.close).toHaveBeenCalledTimes(1);
    expect(priv(service).scopes.has('sub-1')).toBe(false);
  });

  it('disposeScope never removes or closes the primary scope', async () => {
    const { service, pa } = serviceWith2Tabs();
    await priv(service).registerPage(pa, PRIMARY);
    priv(service).scopes.set(PRIMARY, { currentPage: pa });

    service.disposeScope(PRIMARY, true);

    expect(pa.close).not.toHaveBeenCalled();
    expect(priv(service).scopes.has(PRIMARY)).toBe(true);
  });

  it('disposeScope is idempotent — a second call never closes tabs the first kept', async () => {
    const { service, pa, pb } = serviceWith2Tabs();
    await priv(service).registerPage(pa, PRIMARY);
    await priv(service).registerPage(pb, 'sub-1');
    priv(service).scopes.set('sub-1', { currentPage: pb });

    // The team drain-timeout sweep and the agent's own settle handler can both reach a wedged agent.
    service.disposeScope('sub-1', false);
    service.disposeScope('sub-1', true);

    expect(pb.close).not.toHaveBeenCalled();
  });

  it('discardScope reclaims tabs a failed agent kept, even after its scope entry is gone', async () => {
    const { service, pa, pb } = serviceWith2Tabs();
    await priv(service).registerPage(pa, PRIMARY);
    await priv(service).registerPage(pb, 'sub-1');
    priv(service).scopes.set('sub-1', { currentPage: pb });

    service.disposeScope('sub-1', false); // agent failed: entry dropped, tab kept for inspection
    service.discardScope('sub-1'); // session teardown: nothing else can reach that tab

    expect(pb.close).toHaveBeenCalledTimes(1);
    expect(pa.close).not.toHaveBeenCalled();
  });
});

describe('concurrent scopes', () => {
  /** A context whose newPage() resolves only when the test releases it, so two scopes can be in flight. */
  function gatedContext(pages: ReturnType<typeof fakePage>[]) {
    const releases: Array<() => void> = [];
    let next = 0;
    return {
      releases,
      ctx: {
        newCDPSession: async () => fakeSession,
        newPage: () => {
          const page = pages[next++]!;
          return new Promise((resolve) => releases.push(() => resolve(page)));
        },
      },
    };
  }

  it('keeps each scope on its OWN current tab and indexes tabs per scope, not globally', async () => {
    const { service } = serviceWith2Tabs();
    const [a1, a2, b1] = [fakePage('http://a1'), fakePage('http://a2'), fakePage('http://b1')];
    await priv(service).registerPage(a1, 'agent-a');
    await priv(service).registerPage(b1, 'agent-b');
    await priv(service).registerPage(a2, 'agent-a');
    const scopeA = scopeFor(service, 'agent-a');
    const scopeB = scopeFor(service, 'agent-b');
    priv(service).scopes.set('agent-a', { currentPage: a1 });
    priv(service).scopes.set('agent-b', { currentPage: b1 });

    // Registration order interleaves the two scopes, so a global index would disagree with both.
    expect(scopeA.listTabs().map((t) => t.url)).toEqual(['http://a1', 'http://a2']);
    expect(scopeB.listTabs().map((t) => t.url)).toEqual(['http://b1']);

    // Index 1 means a DIFFERENT page for each scope, and B has no index 1 at all.
    await scopeA.selectTab(1);
    expect(scopeA.getCurrentPage()).toBe(a2);
    expect(scopeB.getCurrentPage()).toBe(b1); // untouched by A's switch
    await expect(scopeB.selectTab(1)).rejects.toThrow(/out of range/);
  });

  it('only the primary scope steals the human screencast when selecting a tab', async () => {
    const { service } = serviceWith2Tabs();
    const [p1, p2, s1, s2] = [fakePage('http://p1'), fakePage('http://p2'), fakePage('http://s1'), fakePage('http://s2')];
    for (const [page, owner] of [[p1, PRIMARY], [p2, PRIMARY], [s1, 'sub-1'], [s2, 'sub-1']] as const) {
      await priv(service).registerPage(page, owner);
    }
    priv(service).scopes.set('sub-1', { currentPage: s1 });
    priv(service).setActivePage(p1);
    const revealOf = (page: unknown) =>
      vi.spyOn(priv(service).pages.get(page)!.panel as { reveal: () => void }, 'reveal');
    const revealS2 = revealOf(s2);
    const revealP2 = revealOf(p2);

    await scopeFor(service, 'sub-1').selectTab(1);
    expect(scopeFor(service, 'sub-1').getCurrentPage()).toBe(s2);
    expect(revealS2).not.toHaveBeenCalled();
    expect(priv(service).activePage).toBe(p1); // the human keeps watching their own tab

    await scopeFor(service, PRIMARY).selectTab(1);
    expect(revealP2).toHaveBeenCalled();
    expect(priv(service).activePage).toBe(p2);
  });

  it('opens tabs for two scopes concurrently, each landing on its own page', async () => {
    const { service } = serviceWith2Tabs();
    const pageA = fakePage('http://a');
    const pageB = fakePage('http://b');
    const { ctx, releases } = gatedContext([pageA, pageB]);
    priv(service).context = ctx;
    const scopeA = scopeFor(service, 'agent-a');
    const scopeB = scopeFor(service, 'agent-b');

    const openA = scopeA.openNewTab();
    const openB = scopeB.openNewTab();
    await vi.waitFor(() => expect(releases).toHaveLength(2)); // both in flight at once
    releases[1]!(); // resolve B first — ownership must follow page identity, not completion order
    releases[0]!();
    await Promise.all([openA, openB]);

    expect(scopeA.getCurrentPage()).toBe(pageA);
    expect(scopeB.getCurrentPage()).toBe(pageB);
    expect(priv(service).pages.get(pageA)!.ownerScopeId).toBe('agent-a');
    expect(priv(service).pages.get(pageB)!.ownerScopeId).toBe('agent-b');
  });

  it('a scope disposed mid-open is NOT resurrected, and the tab it opened is closed', async () => {
    const { service } = serviceWith2Tabs();
    const page = fakePage('http://late');
    const { ctx, releases } = gatedContext([page]);
    priv(service).context = ctx;
    const scope = scopeFor(service, 'sub-1');

    // `abortableTool` resolves the tool call on abort while this promise keeps running; the agent then
    // settles and disposes its scope before newPage() ever comes back.
    const open = scope.openNewTab();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    service.disposeScope('sub-1', false);
    releases[0]!();

    await expect(open).rejects.toThrow(/was disposed/);
    expect(priv(service).scopes.has('sub-1')).toBe(false); // no resurrection
    expect(page.close).toHaveBeenCalledTimes(1); // no stranded editor tab
  });
});

describe('first open adopts the launcher\'s initial page (no orphan tab)', () => {
  it('reuses context.pages()[0] and navigates it — never opens a second tab', async () => {
    const service = new BrowserService();
    // Skip the real filesystem ensureUserDataDir work.
    priv(service).userDataDir = '/tmp/damocles-adopt';
    priv(service).iconCacheDir = '/tmp/damocles-adopt/icons';
    priv(service).downloadManager.downloadsDir = '/tmp/damocles-adopt/dl';

    const initial = {
      on: () => {},
      url: () => 'about:blank',
      close: vi.fn(async () => {}),
      opener: async () => null,
      evaluate: async () => 'Mozilla/5.0 Chrome/120',
    };
    const sessionWithSend = { on: () => {}, send: vi.fn(async () => ({ frameId: 'f', loaderId: 'l' })) };
    const newPage = vi.fn(async () => fakePage('http://second'));
    const fakeCtx = {
      exposeBinding: vi.fn(async () => {}),
      addInitScript: vi.fn(async () => {}),
      on: () => {},
      pages: () => [initial],
      newPage,
      newCDPSession: async () => sessionWithSend,
      close: async () => {},
    };
    vi.mocked(launchBrowserContext).mockResolvedValue(fakeCtx as never);

    await service.openForScope(BrowserService.PRIMARY_SCOPE_ID, 'http://a');

    // Exactly one tab (the adopted initial page), no orphan blank; newPage() was never called.
    expect(priv(service).pages.size).toBe(1);
    expect(newPage).not.toHaveBeenCalled();
    expect(priv(service).pages.has(initial)).toBe(true);
    // The launcher's scope owns + currently points at the adopted page, and it was navigated.
    expect(scopeFor(service).getCurrentPage()).toBe(initial);
    expect(sessionWithSend.send).toHaveBeenCalledWith('Page.navigate', { url: 'http://a' });

    service.dispose();
  });
});
