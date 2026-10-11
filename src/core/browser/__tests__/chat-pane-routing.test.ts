// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserService } from '../index';
import { launchBrowserContext } from '../launcher';
import { installFakePlatform, type FakePanelHost, type FakePlatform } from '../../../__mocks__/fake-platform';
import type { PanelHost } from '../../../platform/window-service';
import * as logger from '../../logger';
import { buildBrowserPiTools } from '../../pi-session/tools/browser-tools';

// These suites never launch Chromium: the context is set directly, as in panel-wiring.test.ts.
vi.mock('../launcher', () => ({ launchBrowserContext: vi.fn() }));

type Handler = (...args: unknown[]) => void;

interface FakePage {
  on(event: string, handler: Handler): void;
  emit(event: string, ...args: unknown[]): void;
  url(): string;
  close: ReturnType<typeof vi.fn>;
  opener(): Promise<FakePage | null>;
  mainFrame(): unknown;
  evaluate(): Promise<unknown>;
  // Chromium committing a main-frame document at url
  commit(url: string): void;
}

function fakePage(opener: FakePage | null = null): FakePage {
  const handlers = new Map<string, Handler[]>();
  let frameUrl = 'about:blank';
  const frame = { url: () => frameUrl };
  const page: FakePage = {
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    emit: (event, ...args) => {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
    url: () => frameUrl,
    close: vi.fn(async () => {
      page.emit('close');
    }),
    opener: async () => opener,
    mainFrame: () => frame,
    evaluate: async () => undefined,
    commit: (url) => {
      frameUrl = url;
      page.emit('framenavigated', frame);
    },
  };
  return page;
}

function navigationRequest(url: string, frame: unknown, errorText = 'net::ERR_NAME_NOT_RESOLVED') {
  return { url: () => url, isNavigationRequest: () => true, frame: () => frame, failure: () => ({ errorText }) };
}

function navigationResponse(url: string, status: number, frame: unknown, isNavigation = true) {
  return {
    url: () => url,
    status: () => status,
    statusText: () => '',
    frame: () => frame,
    request: () => ({ ...navigationRequest(url, frame), isNavigationRequest: () => isNavigation }),
  };
}

type NavigateAnswer = { frameId: string; loaderId: string; errorText?: string; isDownload?: boolean };

/** Answers every page's Page.navigate with `answer`, run while Chromium would be loading the page. */
function answerNavigations(svc: BrowserService, answer: (url: string, page: FakePage) => NavigateAnswer): string[] {
  const navigated: string[] = [];
  (priv(svc).context as { newCDPSession: unknown }).newCDPSession = async (page: FakePage) => ({
    on: () => {},
    send: vi.fn(async (method: string, params?: { url?: string }) => {
      if (method !== 'Page.navigate') return { currentIndex: 0, entries: [{}] };
      navigated.push(params!.url!);
      return answer(params!.url!, page);
    }),
    detach: vi.fn(async () => {}),
  });
  return navigated;
}

const loaded = (): NavigateAnswer => ({ frameId: 'f', loaderId: 'l' });

/** A launched context as launchBrowserContext resolves it, whose browser reports `userAgent`. */
function launchedContext(initial: FakePage, opts: { userAgent?: string; send?: (method: string, params?: Record<string, unknown>) => unknown } = {}) {
  const getVersion = vi.fn(async () => ({ userAgent: opts.userAgent ?? 'Mozilla/5.0 Chrome/155.0.0.0' }));
  const context = {
    exposeBinding: vi.fn(async () => {}),
    addInitScript: vi.fn(async () => {}),
    on: () => {},
    pages: () => [initial],
    newPage: vi.fn(async () => {
      const page = fakePage();
      created.push(page);
      return page;
    }),
    newCDPSession: async () => ({
      on: () => {},
      send: vi.fn(async (method: string, params?: Record<string, unknown>) => opts.send?.(method, params) ?? (method === 'Page.navigate' ? loaded() : { currentIndex: 0, entries: [{}] })),
      detach: vi.fn(async () => {}),
    }),
    browser: () => ({
      newBrowserCDPSession: async () => ({ send: async (method: string) => (method === 'Browser.getVersion' ? getVersion() : {}), detach: async () => {} }),
    }),
    close: async () => {},
  };
  return { context, getVersion };
}

/** A service with no browser running, whose next launch resolves `context`; never touches the real profile directory. */
function unlaunchedService(): BrowserService {
  const svc = new BrowserService(platform);
  (svc as unknown as { userDataDir: string }).userDataDir = '/tmp/damocles-test-profile';
  return svc;
}

const logLines = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((call) => call.map(String).join(' '));

interface Entry {
  page: FakePage;
  ownerScopeId: string;
  chat: PanelHost | undefined;
  panel: { panel: FakePanelHost | null };
  lastUrl: string | null;
}

type Priv = {
  context: unknown;
  state: string;
  pages: Map<FakePage, Entry>;
  launchOwnerScopeId: string | null;
  scopes: Map<string, unknown>;
  userAgentCheck: Promise<unknown> | null;
  registerPage(page: FakePage, owner?: string, opener?: Entry): Promise<Entry | null>;
  resetState(): void;
};

const priv = (service: BrowserService): Priv => service as unknown as Priv;

let platform: FakePlatform;
let created: FakePage[];

function install(chatBrowserPane: boolean, enabled = true): void {
  platform = installFakePlatform({ chatBrowserPane, settings: { user: { 'damocles.browser.enabled': enabled } } });
}

function service(): BrowserService {
  const svc = new BrowserService(platform);
  priv(svc).context = {
    newCDPSession: async () => ({ on: () => {}, send: vi.fn(async () => ({ currentIndex: 0, entries: [{}] })), detach: vi.fn(async () => {}) }),
    newPage: async () => {
      const page = fakePage();
      created.push(page);
      return page;
    },
    close: async () => {},
  };
  priv(svc).state = 'connected';
  return svc;
}

function chatHost(): FakePanelHost {
  return platform.window.createPanel({ kind: 'chat', title: 'chat', localResourceRoots: [] }) as FakePanelHost;
}

function entries(svc: BrowserService): Entry[] {
  return [...priv(svc).pages.values()];
}

function hostOf(entry: Entry): FakePanelHost {
  const host = entry.panel.panel;
  if (!host) throw new Error('the page has no panel');
  return host;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  created = [];
});

describe('VS Code: one primary scope shared by every chat', () => {
  beforeEach(() => install(false));

  it('gives every chat the primary scope and opens its pages with the in-page toolbar', async () => {
    const svc = service();
    const [a, b] = [chatHost(), chatHost()];
    expect(svc.chatScope(a).id).toBe(BrowserService.PRIMARY_SCOPE_ID);
    expect(svc.chatScope(b).id).toBe(BrowserService.PRIMARY_SCOPE_ID);
    await svc.chatScope(a).open('https://a.example/');
    const [entry] = entries(svc);
    expect(entry?.ownerScopeId).toBe(BrowserService.PRIMARY_SCOPE_ID);
    expect(hostOf(entry!).options.owner).toBeUndefined();
    expect(hostOf(entry!).html).toContain('<div id="toolbar">');
    expect(svc.chatScope(b).listTabs()).toHaveLength(1);
  });

  it('shows the watched page at its address on the header open, instead of navigating it to a blank page', async () => {
    const svc = service();
    const a = chatHost();
    await svc.chatScope(a).open('https://a.example/');
    const host = hostOf(entries(svc)[0]!);
    const reveals = host.reveals.length;
    await svc.showForChat(a);
    expect(svc.chatScope(a).listTabs().map((tab) => tab.url)).toEqual(['https://a.example/']);
    expect(host.reveals.length).toBe(reveals + 1);
  });

  it('leaves the pages open when a chat closes', async () => {
    const svc = service();
    const a = chatHost();
    svc.chatScope(a);
    await svc.chatScope(a).open('https://a.example/');
    a.close();
    expect(created[0]?.close).not.toHaveBeenCalled();
  });

  it('attributes an unknown-opener page to the launch owner, then the primary scope', async () => {
    const svc = service();
    const entry = await priv(svc).registerPage(fakePage());
    expect(entry?.ownerScopeId).toBe(BrowserService.PRIMARY_SCOPE_ID);
  });

  it('broadcasts a toolbar pick without a chat, so the active chat receives it', async () => {
    const svc = service();
    const picked = vi.fn();
    svc.onElementPickedFromToolbar(picked);
    const a = chatHost();
    const sub = svc.createAgentScope('agent-1', a);
    await sub.open('https://a.example/').catch(() => undefined);
    const [entry] = entries(svc);
    expect(hostOf(entry!).options.owner).toBe(a);
    const attachment = { selector: 's', tagName: 'div', boundingBox: { x: 0, y: 0, width: 1, height: 1 }, computedStyles: {} };
    const picker = (entry as unknown as { picker: { startPicking: () => Promise<unknown> } }).picker;
    vi.spyOn(picker, 'startPicking').mockResolvedValue(attachment);
    hostOf(entry!).fireMessage({ type: 'pickElement' });
    await settle();
    expect(picked).toHaveBeenCalledWith(attachment, undefined);
  });
});

describe('desktop: a browser scope per chat, pages beside their chat', () => {
  beforeEach(() => install(true));

  it('gives each chat its own scope and opens its pages beside it without the in-page toolbar', async () => {
    const svc = service();
    const [a, b] = [chatHost(), chatHost()];
    const scopeA = svc.chatScope(a);
    const scopeB = svc.chatScope(b);
    expect(scopeA.id).not.toBe(scopeB.id);
    expect(scopeA.id).not.toBe(BrowserService.PRIMARY_SCOPE_ID);
    expect(svc.chatScope(a).id).toBe(scopeA.id);

    await scopeA.open('https://a.example/');
    await svc.chatScope(b).open('https://b.example/');
    const [pageA, pageB] = entries(svc);
    expect(hostOf(pageA!).options.owner).toBe(a);
    expect(hostOf(pageB!).options.owner).toBe(b);
    expect(hostOf(pageA!).html).not.toContain('id="toolbar"');
    expect(hostOf(pageA!).html).toContain('id="screen"');
    expect(scopeA.listTabs().map((tab) => tab.url)).toEqual(['https://a.example/']);
    expect(scopeB.listTabs().map((tab) => tab.url)).toEqual(['https://b.example/']);
  });

  it('gives a subagent scope\'s pages to the chat whose session created the scope', async () => {
    const svc = service();
    const a = chatHost();
    svc.chatScope(a);
    const sub = svc.createAgentScope('agent-7', a);
    await sub.open('https://sub.example/');
    const [entry] = entries(svc);
    expect(entry?.ownerScopeId).toBe('agent-7');
    expect(entry?.chat).toBe(a);
    expect(hostOf(entry!).options.owner).toBe(a);
    expect(svc.chatScope(a).listTabs()).toEqual([]);
  });

  it('puts a popup beside its opener\'s chat, not the chat that launched the browser', async () => {
    const svc = service();
    const [a, b] = [chatHost(), chatHost()];
    const scopeA = svc.chatScope(a);
    priv(svc).launchOwnerScopeId = svc.chatScope(b).id;
    await scopeA.open('https://a.example/');
    const opener = entries(svc)[0]!;
    const popup = await priv(svc).registerPage(fakePage(opener.page));
    expect(popup?.chat).toBe(a);
    expect(popup?.ownerScopeId).toBe(scopeA.id);
    expect(hostOf(popup!).options.owner).toBe(a);

    const viaEvent = fakePage();
    opener.page.emit('popup', viaEvent);
    await settle();
    expect(priv(svc).pages.get(viaEvent)?.chat).toBe(a);
  });

  it('hands a popup of a finished subagent\'s kept page to its chat\'s human scope', async () => {
    const svc = service();
    const a = chatHost();
    const human = svc.chatScope(a);
    const sub = svc.createAgentScope('agent-9', a);
    await sub.open('https://kept.example/');
    svc.disposeScope('agent-9', false);
    const kept = entries(svc)[0]!;
    const popup = await priv(svc).registerPage(fakePage(kept.page));
    expect(popup?.chat).toBe(a);
    expect(popup?.ownerScopeId).toBe(human.id);
  });

  it('closes a page no open chat owns instead of re-attributing it', async () => {
    const svc = service();
    const orphan = fakePage();
    expect(await priv(svc).registerPage(orphan)).toBeNull();
    expect(orphan.close).toHaveBeenCalled();
    expect(priv(svc).pages.size).toBe(0);
  });

  it('closes every page a chat owns when it closes, kept subagent pages included, and refuses later ones', async () => {
    const svc = service();
    const [a, b] = [chatHost(), chatHost()];
    await svc.chatScope(a).open('https://a.example/');
    await svc.createAgentScope('agent-3', a).open('https://sub.example/');
    svc.disposeScope('agent-3', false);
    await svc.chatScope(b).open('https://b.example/');
    const [pageA, subA, pageB] = created;

    a.close();
    await settle();
    expect(pageA?.close).toHaveBeenCalled();
    expect(subA?.close).toHaveBeenCalled();
    expect(pageB?.close).not.toHaveBeenCalled();
    expect(entries(svc).map((entry) => entry.chat)).toEqual([b]);

    const late = fakePage(pageA ?? null);
    expect(await priv(svc).registerPage(late)).toBeNull();
    expect(late.close).toHaveBeenCalled();
    await expect(svc.chatScope(a).open('https://again.example/')).rejects.toThrow('disposed');
  });

  it.each([
    ['its chat closes', (svc: BrowserService, chat: FakePanelHost) => { void svc; chat.close(); }],
    ['the browser tears down', (svc: BrowserService) => { void svc.close(); }],
    ['its tab closes', (svc: BrowserService) => { hostOf(entries(svc)[0]!).close(); }],
  ] as const)('reads no page history for a page whose close is under way when %s, as a quit closes them', async (_label, closeAll) => {
    const svc = service();
    const sends: string[] = [];
    (priv(svc).context as { newCDPSession: unknown }).newCDPSession = async () => ({
      on: () => {},
      send: vi.fn(async (method: string) => {
        sends.push(method);
        return { currentIndex: 0, entries: [{}] };
      }),
      detach: vi.fn(async () => {}),
    });
    const chat = chatHost();
    await svc.chatScope(chat).open('https://a.example/');
    const [page] = created;
    page!.emit('load');
    await settle();
    expect(sends).toContain('Page.getNavigationHistory');
    page!.close.mockImplementation(async () => undefined);
    sends.length = 0;

    closeAll(svc, chat);
    page!.emit('requestfailed', { url: () => 'https://a.example/', failure: () => ({ errorText: 'net::ERR_ABORTED' }), isNavigationRequest: () => true, frame: () => page!.mainFrame() });
    page!.emit('load');
    await settle();

    expect(sends).not.toContain('Page.getNavigationHistory');
  });

  it('keeps each open chat\'s scope across a browser teardown, so its agent opens again', async () => {
    const svc = service();
    const a = chatHost();
    const scope = svc.chatScope(a);
    priv(svc).resetState();
    expect(priv(svc).scopes.has(scope.id)).toBe(true);
    priv(svc).context = (service() as unknown as Priv).context;
    priv(svc).state = 'connected';
    await scope.open('https://again.example/');
    expect(scope.listTabs()).toHaveLength(1);
  });

  it('restores every saved page into its chat, skipping non-web addresses, and reveals the saved active one', async () => {
    const svc = service();
    const a = chatHost();
    await svc.restoreChatPages(a, ['https://one.example/', 'file:///c:/secret', 'https://two.example/', 'https://three.example/'], 2);
    const scope = svc.chatScope(a);
    expect(scope.listTabs().map((tab) => tab.url)).toEqual(['https://one.example/', 'https://two.example/', 'https://three.example/']);
    expect(scope.listTabs().find((tab) => tab.active)?.url).toBe('https://two.example/');
    const two = entries(svc)[1]!;
    expect(hostOf(two).reveals.length).toBeGreaterThan(0);
    expect(entries(svc).every((entry) => entry.chat === a)).toBe(true);
  });

  it('restores beside a page the chat already has open without navigating it away', async () => {
    const svc = service();
    const a = chatHost();
    await svc.chatScope(a).open('https://agent.example/');
    await svc.restoreChatPages(a, ['https://saved.example/'], 0);
    expect(svc.chatScope(a).listTabs().map((tab) => tab.url)).toEqual(['https://agent.example/', 'https://saved.example/']);
  });

  it('restores nothing and opens no new page while the browser is turned off', async () => {
    install(true, false);
    const svc = service();
    const a = chatHost();
    await svc.restoreChatPages(a, ['https://one.example/'], 0);
    await svc.openNewPageForChat(a);
    expect(created).toEqual([]);
  });

  it('shows the chat\'s own page on the header open, and opens a blank one only in a chat without a page', async () => {
    const svc = service();
    const [a, b] = [chatHost(), chatHost()];
    await svc.chatScope(a).open('https://a.example/');
    svc.chatScope(b);
    const hostA = hostOf(entries(svc)[0]!);
    const reveals = hostA.reveals.length;

    await svc.showForChat(a);
    expect(svc.chatScope(a).listTabs().map((tab) => tab.url)).toEqual(['https://a.example/']);
    expect(hostA.reveals.length).toBe(reveals + 1);

    await svc.showForChat(b);
    expect(svc.chatScope(a).listTabs().map((tab) => tab.url)).toEqual(['https://a.example/']);
    expect(svc.chatScope(b).listTabs().map((tab) => tab.url)).toEqual(['about:blank']);
    expect(hostA.reveals.length).toBe(reveals + 1);
  });

  it('loads an address typed into a new blank page while it is still opening, and never navigates it to about:blank', async () => {
    const svc = service();
    const navigated: string[] = [];
    (priv(svc).context as { newCDPSession: unknown }).newCDPSession = async () => ({
      on: () => {},
      send: vi.fn(async (method: string, params?: { url?: string }) => {
        if (method === 'Page.navigate') navigated.push(params!.url!);
        return method === 'Page.navigate' ? { frameId: 'f', loaderId: 'l' } : { currentIndex: 0, entries: [{}] };
      }),
      detach: vi.fn(async () => {}),
    });
    const typed = 'http://127.0.0.1:1/ticking';
    const createPanel = platform.window.createPanel;
    platform.window.createPanel = (opts) => {
      const host = createPanel(opts) as FakePanelHost;
      if (opts.kind === 'browser') queueMicrotask(() => host.fireMessage({ type: 'navigate', url: typed }));
      return host;
    };
    await svc.showForChat(chatHost());
    await settle();
    expect(navigated).toEqual([typed]);
  });

  it('opens a new blank page with no browser running without navigating it', async () => {
    const svc = new BrowserService(platform);
    const navigate = vi.fn(async () => ({ frameId: 'f', loaderId: 'l' }));
    const initial = Object.assign(fakePage(), { evaluate: async () => 'Mozilla/5.0 Chrome/120' });
    vi.mocked(launchBrowserContext).mockResolvedValueOnce({
      exposeBinding: vi.fn(async () => {}),
      addInitScript: vi.fn(async () => {}),
      on: () => {},
      pages: () => [initial],
      newPage: vi.fn(),
      newCDPSession: async () => ({
        on: () => {},
        send: vi.fn(async (method: string) => (method === 'Page.navigate' ? navigate() : { currentIndex: 0, entries: [{}] })),
        detach: vi.fn(async () => {}),
      }),
      close: async () => {},
    } as never);
    const a = chatHost();
    await svc.openNewPageForChat(a);
    expect(svc.chatScope(a).listTabs()).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
    svc.dispose();
  });

  it('opens a new blank page in the chat\'s own scope', async () => {
    const svc = service();
    const a = chatHost();
    await svc.openNewPageForChat(a);
    expect(svc.chatScope(a).listTabs()).toHaveLength(1);
    expect(entries(svc)[0]?.chat).toBe(a);
  });

  it('opens the in-page New Tab of a page in that page\'s chat scope', async () => {
    const svc = service();
    const [a, b] = [chatHost(), chatHost()];
    await svc.chatScope(a).open('https://a.example/');
    svc.chatScope(b);
    hostOf(entries(svc)[0]!).fireMessage({ type: 'tabNew' });
    await settle();
    expect(svc.chatScope(a).listTabs()).toHaveLength(2);
    expect(svc.chatScope(b).listTabs()).toHaveLength(0);
  });

  it('picks on the requesting chat\'s page and posts a toolbar pick to the page\'s chat', async () => {
    const svc = service();
    const [a, b] = [chatHost(), chatHost()];
    await svc.chatScope(a).open('https://a.example/');
    await svc.chatScope(b).open('https://b.example/');
    const [pageA, pageB] = entries(svc);
    const attachment = { selector: 's', tagName: 'div', boundingBox: { x: 0, y: 0, width: 1, height: 1 }, computedStyles: {} };
    const pickA = vi.spyOn((pageA as unknown as { picker: { startPicking: () => Promise<unknown> } }).picker, 'startPicking').mockResolvedValue(attachment);
    const pickB = vi.spyOn((pageB as unknown as { picker: { startPicking: () => Promise<unknown> } }).picker, 'startPicking').mockResolvedValue(attachment);
    (svc as unknown as { setActivePage: (page: unknown) => void }).setActivePage(pageB!.page);
    await svc.pickElement(a);
    expect(pickA).toHaveBeenCalledTimes(1);
    expect(pickB).not.toHaveBeenCalled();

    const picked = vi.fn();
    svc.onElementPickedFromToolbar(picked);
    hostOf(pageA!).fireMessage({ type: 'pickElement' });
    await settle();
    expect(picked).toHaveBeenCalledWith(attachment, a);
  });

  it('opens a new page for New Browser Page that arrives while a launch is in flight, instead of revealing the adopted page', async () => {
    const svc = unlaunchedService();
    const initial = fakePage();
    let launch!: (context: unknown) => void;
    vi.mocked(launchBrowserContext).mockReturnValueOnce(new Promise((resolve) => { launch = resolve as (context: unknown) => void; }) as never);
    const a = chatHost();
    const agentOpen = svc.chatScope(a).open('https://a.example/');
    await settle();
    const newPage = svc.openNewPageForChat(a);
    launch(launchedContext(initial).context);
    await Promise.all([agentOpen, newPage]);
    expect(svc.chatScope(a).listTabs().map((tab) => tab.url)).toEqual(['https://a.example/', 'about:blank']);
    expect(svc.chatScope(a).listTabs().find((tab) => tab.active)?.url).toBe('about:blank');
    await svc.dispose();
  });

  it('keeps a restored page whose load failed as a restored tab and reveals it', async () => {
    const logSpy = vi.spyOn(logger, 'log').mockImplementation(() => {});
    const svc = service();
    answerNavigations(svc, () => ({ ...loaded(), errorText: 'net::ERR_CONNECTION_REFUSED' }));
    const a = chatHost();
    await svc.restoreChatPages(a, ['https://down.example/a?token=secret', 'https://down.example/b'], 0);
    expect(svc.chatScope(a).listTabs()).toHaveLength(2);
    expect(hostOf(entries(svc)[0]!).reveals.length).toBeGreaterThan(0);
    const lines = logLines(logSpy).filter((line) => line.includes('down.example'));
    expect(lines).toEqual([
      '[Browser] A restored page did not load: Navigation to https://down.example failed: net::ERR_CONNECTION_REFUSED',
      '[Browser] A restored page did not load: Navigation to https://down.example failed: net::ERR_CONNECTION_REFUSED',
    ]);
    logSpy.mockRestore();
  });

  it('restores a saved blank page without navigating it', async () => {
    const svc = service();
    const navigated = answerNavigations(svc, loaded);
    const a = chatHost();
    await svc.restoreChatPages(a, ['about:blank', 'https://two.example/'], 0);
    expect(svc.chatScope(a).listTabs().map((tab) => tab.url)).toEqual(['about:blank', 'https://two.example/']);
    expect(navigated).toEqual(['https://two.example/']);
  });
});

describe('an agent navigation reports what Chromium did with it', () => {
  beforeEach(() => install(false));

  const scopeOf = (svc: BrowserService) => svc.chatScope(undefined);

  it('carries the main frame\'s final navigation response status, ignoring subframes, other requests and redirect hops', async () => {
    const svc = service();
    answerNavigations(svc, (url, page) => {
      page.emit('response', navigationResponse('https://ads.example/frame', 500, {}));
      page.emit('response', navigationResponse('https://a.example/api', 503, page.mainFrame(), false));
      page.emit('response', navigationResponse(url, 302, page.mainFrame()));
      page.emit('response', navigationResponse('https://a.example/missing', 404, page.mainFrame()));
      return loaded();
    });
    expect(await scopeOf(svc).open('https://a.example/old')).toBe(404);
  });

  it('resolves no status for a navigation with no response after an earlier one answered 404', async () => {
    const svc = service();
    let respond = true;
    answerNavigations(svc, (url, page) => {
      if (respond) page.emit('response', navigationResponse(url, 404, page.mainFrame()));
      return loaded();
    });
    expect(await scopeOf(svc).open('https://a.example/missing')).toBe(404);
    respond = false;
    expect(await scopeOf(svc).open('https://a.example/missing#section')).toBeUndefined();
  });

  it('treats an HTTP error with an empty body, which Chromium answers ERR_HTTP_RESPONSE_CODE_FAILURE, as a loaded page with its status', async () => {
    const svc = service();
    answerNavigations(svc, (url, page) => {
      page.emit('response', navigationResponse(url, 500, page.mainFrame()));
      return { ...loaded(), errorText: 'net::ERR_HTTP_RESPONSE_CODE_FAILURE' };
    });
    expect(await scopeOf(svc).open('https://api.example/broken')).toBe(500);
    expect(scopeOf(svc).getCurrentUrl()).toBe('https://api.example/broken');
  });

  it('rejects a navigation that became a download and points the agent to BrowserDownloads', async () => {
    const logSpy = vi.spyOn(logger, 'log').mockImplementation(() => {});
    const svc = service();
    answerNavigations(svc, () => ({ ...loaded(), errorText: 'net::ERR_ABORTED', isDownload: true }));
    const tools = buildBrowserPiTools({ pi: { defineTool: (c: unknown) => c }, scope: scopeOf(svc) } as never) as unknown as Array<{ name: string; execute: (id: string, input: unknown) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }> }>;
    const result = await tools.find((tool) => tool.name === 'BrowserOpen')!.execute('t', { url: 'https://files.example/report.pdf?token=secret' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('Error: https://files.example started a download instead of loading a page; BrowserDownloads lists it');
    logSpy.mockRestore();
  });

  it('logs a failed agent navigation exactly once, by origin only', async () => {
    const logSpy = vi.spyOn(logger, 'log').mockImplementation(() => {});
    const svc = service();
    answerNavigations(svc, () => ({ ...loaded(), errorText: 'net::ERR_NAME_NOT_RESOLVED' }));
    const tools = buildBrowserPiTools({ pi: { defineTool: (c: unknown) => c }, scope: scopeOf(svc) } as never) as unknown as Array<{ name: string; execute: (id: string, input: unknown) => Promise<{ isError?: boolean }> }>;
    const result = await tools.find((tool) => tool.name === 'BrowserNavigate')!.execute('t', { url: 'https://nowhere.example/x?token=secret' });
    expect(result.isError).toBe(true);
    const lines = logLines(logSpy).filter((line) => line.includes('nowhere.example'));
    expect(lines).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('secret');
    logSpy.mockRestore();
  });

  it('sends no Page.navigate for a signal that already aborted', async () => {
    const svc = service();
    const navigated = answerNavigations(svc, loaded);
    await scopeOf(svc).open('https://a.example/');
    const aborted = new AbortController();
    aborted.abort();
    await expect(scopeOf(svc).open('https://b.example/', aborted.signal)).rejects.toThrow('Browser open aborted');
    expect(navigated).toEqual(['https://a.example/']);
  });

  it('keeps the last address that loaded when Chromium commits its error page, and shows the address that failed', async () => {
    const svc = service();
    answerNavigations(svc, (url, page) => {
      if (url.includes('nowhere')) {
        page.emit('requestfailed', navigationRequest(url, page.mainFrame()));
        return { ...loaded(), errorText: 'net::ERR_NAME_NOT_RESOLVED' };
      }
      return loaded();
    });
    await scopeOf(svc).open('https://a.example/');
    const [page] = created;
    page!.commit('https://a.example/');
    await expect(scopeOf(svc).open('https://nowhere.example/x')).rejects.toThrow('net::ERR_NAME_NOT_RESOLVED');
    page!.commit('chrome-error://chromewebdata/');

    const entry = entries(svc)[0]!;
    const shown = (): string[] => hostOf(entry).posted.flatMap((m) => ((m as { type: string }).type === 'urlChanged' ? [(m as { url: string }).url] : []));
    expect(entry.lastUrl).toBe('https://a.example/');
    // The agent reads the address the user sees, not the last one that loaded.
    expect(scopeOf(svc).getCurrentUrl()).toBe('https://nowhere.example/x');
    expect(scopeOf(svc).listTabs().map((tab) => tab.url)).toEqual(['https://nowhere.example/x']);
    expect(shown()).not.toContain('chrome-error://chromewebdata/');
    expect(shown().at(-1)).toBe('https://nowhere.example/x');
    expect(hostOf(entry).title).toBe('nowhere.example/x');

    page!.commit('https://b.example/');
    expect(entry.lastUrl).toBe('https://b.example/');
    expect(shown().at(-1)).toBe('https://b.example/');
  });

  it('does not present a page whose browser tore down while the user-agent check was pending', async () => {
    const svc = service();
    let release!: (userAgent: string | null) => void;
    priv(svc).userAgentCheck = new Promise((resolve) => { release = resolve; });
    const registration = priv(svc).registerPage(fakePage(), BrowserService.PRIMARY_SCOPE_ID);
    await settle();
    await svc.close();
    release(null);
    expect(await registration).toBeNull();
    expect(platform.window.panels.filter((panel) => panel.options.kind === 'browser' && !panel.disposed)).toEqual([]);
  });

  it('reads the user agent from the browser, without page JS, and applies the clean one before the page is presented', async () => {
    const svc = unlaunchedService();
    const order: string[] = [];
    // A page whose JS never answers, as while a dialog is open.
    const initial = Object.assign(fakePage(), { evaluate: () => new Promise(() => {}) });
    const { context, getVersion } = launchedContext(initial, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) HeadlessChrome/155.0.0.0 Safari/537.36',
      send: (method, params) => {
        if (method === 'Emulation.setUserAgentOverride') order.push(`override ${String(params?.['userAgent'])}`);
        return undefined;
      },
    });
    vi.mocked(launchBrowserContext).mockResolvedValueOnce(context as never);
    const chat = chatHost();
    const createPanel = platform.window.createPanel;
    platform.window.createPanel = (opts) => {
      order.push('presented');
      return createPanel(opts);
    };
    const opened = svc.showForChat(chat);
    await vi.waitFor(() => expect(order).toContain('presented'), { timeout: 1000 });
    await opened;
    expect(order).toEqual(['override Mozilla/5.0 (Windows NT 10.0) Chrome/155.0.0.0 Safari/537.36', 'presented']);
    await scopeOf(svc).openNewTab();
    expect(getVersion).toHaveBeenCalledTimes(1);
    await svc.dispose();
  });

  it.each([
    ['an agent\'s first open', (svc: BrowserService) => svc.chatScope(undefined).open('about:blank')],
    ['a restored blank tab', (svc: BrowserService) => svc.restorePanel(platform.window.createPanel({ kind: 'browser', title: 'old', localResourceRoots: [] }), 'about:blank')],
  ] as const)('sends no Page.navigate to about:blank for %s with no browser running', async (_label, open) => {
    install(false, true);
    const svc = unlaunchedService();
    const navigate = vi.fn(() => loaded());
    vi.mocked(launchBrowserContext).mockResolvedValueOnce(launchedContext(fakePage(), { send: (method) => (method === 'Page.navigate' ? navigate() : undefined) }).context as never);
    await open(svc);
    expect(svc.chatScope(undefined).listTabs()).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
    await svc.dispose();
  });

  it('logs a restored tab whose load failed once, and not as a failed restore', async () => {
    install(false, true);
    const logSpy = vi.spyOn(logger, 'log').mockImplementation(() => {});
    const svc = unlaunchedService();
    vi.mocked(launchBrowserContext).mockResolvedValueOnce(launchedContext(fakePage(), {
      send: (method) => (method === 'Page.navigate' ? { ...loaded(), errorText: 'net::ERR_CONNECTION_REFUSED' } : undefined),
    }).context as never);
    await svc.restorePanel(platform.window.createPanel({ kind: 'browser', title: 'old', localResourceRoots: [] }), 'https://down.example/a?token=secret');
    expect(svc.chatScope(undefined).listTabs()).toHaveLength(1);
    expect(logLines(logSpy).filter((line) => line.includes('down.example') || line.includes('restore'))).toEqual([
      '[Browser] A restored page did not load: Navigation to https://down.example failed: net::ERR_CONNECTION_REFUSED',
    ]);
    logSpy.mockRestore();
    await svc.dispose();
  });

  it('opens an agent\'s new about:blank tab without navigating it', async () => {
    const svc = service();
    const navigated = answerNavigations(svc, loaded);
    await scopeOf(svc).open('https://a.example/');
    await scopeOf(svc).openNewTab('about:blank');
    expect(scopeOf(svc).listTabs()).toHaveLength(2);
    expect(navigated).toEqual(['https://a.example/']);
  });
});
