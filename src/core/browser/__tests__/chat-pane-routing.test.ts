// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserService } from '../index';
import { installFakePlatform, type FakePanelHost, type FakePlatform } from '../../../__mocks__/fake-platform';
import type { PanelHost } from '../../../platform/window-service';

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
}

function fakePage(opener: FakePage | null = null): FakePage {
  const handlers = new Map<string, Handler[]>();
  const frame = {};
  const page: FakePage = {
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    emit: (event, ...args) => {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
    url: () => 'about:blank',
    close: vi.fn(async () => {
      page.emit('close');
    }),
    opener: async () => opener,
    mainFrame: () => frame,
  };
  return page;
}

interface Entry {
  page: FakePage;
  ownerScopeId: string;
  chat: PanelHost | undefined;
  panel: { panel: FakePanelHost | null };
}

type Priv = {
  context: unknown;
  state: string;
  pages: Map<FakePage, Entry>;
  launchOwnerScopeId: string | null;
  scopes: Map<string, unknown>;
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
});
