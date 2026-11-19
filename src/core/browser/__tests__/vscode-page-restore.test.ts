import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserService } from '../index';
import { installFakePlatform, type FakePanelHost, type FakePlatform } from '../../../__mocks__/fake-platform';
import * as logger from '../../logger';
import { createHarness, folderEntry, makeFakeHost, type FakeHost, type Harness } from '../../chat-panel/__tests__/panel-manager-harness';

// A VS Code window reload revives each browser tab with the token of the chat its state names (restoredBrowserOwner).
vi.mock('../launcher', () => ({ launchBrowserContext: vi.fn() }));

const TOKEN_A = '6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d';
const TOKEN_B = '0b3e7a91-52c4-4d8e-a1f6-9c2d4e6f8a0b';
const GRANT = `http://${'a'.repeat(32)}.localhost:5000`;
const SERVED_FILE = 'file:///home/u/proj/docs/a.html';

type Handler = (...args: unknown[]) => void;

function fakePage() {
  const handlers = new Map<string, Handler[]>();
  const page = {
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    url: () => 'about:blank',
    close: vi.fn(async () => {
      for (const handler of handlers.get('close') ?? []) handler();
    }),
    opener: async () => null,
    mainFrame: () => ({}),
    evaluate: async () => undefined,
  };
  return page;
}

let platform: FakePlatform;
let harness: Harness;
let svc: BrowserService;
let navigated: string[];
let logSpy: ReturnType<typeof vi.spyOn>;

const restoreLines = (): string[] => logSpy.mock.calls.map((call: unknown[]) => call.map(String).join(' ')).filter((line: string) => line.includes('restor'));
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const pageCount = (): number => (svc as unknown as { pages: Map<unknown, unknown> }).pages.size;

/** A chat panel of the manager; with a token, its webview posts `ready` with it, which the router records as session-handlers does. */
async function chat(token?: string, host: FakeHost = makeFakeHost()): Promise<{ host: FakeHost; panelId: string }> {
  const panelId = await harness.manager.initializeHost(host);
  if (token !== undefined) await ready({ host, panelId }, token);
  return { host, panelId };
}

async function ready(target: { host: FakeHost; panelId: string }, token: string): Promise<void> {
  target.host.send({ type: 'ready', panelToken: token });
  await harness.manager.whenReadied(target.panelId);
}

/** The sidebar's chat host: a WebviewView, never active, in no editor column, which VS Code resolves only once it is shown. */
function sidebarHost(): FakeHost {
  return Object.assign(makeFakeHost(), { active: false, column: undefined });
}

function restoredTab(): FakePanelHost {
  return platform.window.createPanel({ kind: 'browser', title: 'old', localResourceRoots: [] }) as FakePanelHost;
}

beforeEach(() => {
  platform = installFakePlatform({ settings: { user: { 'damocles.browser.enabled': true } } });
  logSpy = vi.spyOn(logger, 'log').mockImplementation(() => {});
  harness = createHarness([folderEntry('/ws')], {
    handleWebviewMessage: async (message, panelId) => {
      if (message.type === 'ready') harness.instance(panelId).panelToken = message.panelToken;
    },
  });
  svc = new BrowserService(platform);
  navigated = [];
  const priv = svc as unknown as { context: unknown; state: string };
  priv.context = {
    newCDPSession: async () => ({
      on: () => {},
      send: vi.fn(async (method: string, params?: { url?: string }) => {
        if (method !== 'Page.navigate') return { currentIndex: 0, entries: [{}] };
        navigated.push(params!.url!);
        return { frameId: 'f', loaderId: 'l' };
      }),
      detach: vi.fn(async () => {}),
    }),
    newPage: async () => fakePage(),
    close: async () => {},
  };
  priv.state = 'connected';
  svc.setChatOwners(harness.manager.browserChatOwners());
});

afterEach(async () => {
  await svc.dispose();
  harness.dispose();
  logSpy.mockRestore();
});

describe('a browser page a VS Code window reload revives', () => {
  it('reopens only in the chat whose webview readied with the token its state names', async () => {
    const a = await chat(TOKEN_A);
    const b = await chat(TOKEN_B);
    const tab = restoredTab();

    await svc.restorePanel(tab, 'https://a.example/', TOKEN_A);

    expect(tab.disposed).toBe(true);
    expect(svc.chatScope(a.host).listTabs().map((t) => t.url)).toEqual(['https://a.example/']);
    expect(svc.chatScope(b.host).listTabs()).toEqual([]);
    expect(restoreLines()).toEqual([]);
  });

  it('waits while a chat has not readied, and reopens in it once it readies with the token', async () => {
    const a = await chat();

    await svc.restorePanel(restoredTab(), 'https://a.example/', TOKEN_A);
    expect(svc.chatScope(a.host).listTabs()).toEqual([]);

    await ready(a, TOKEN_A);
    await vi.waitFor(() => expect(svc.chatScope(a.host).listTabs().map((t) => t.url)).toEqual(['https://a.example/']));
    expect(restoreLines()).toEqual([]);
  });

  it('waits, with no tab, while every open chat readied with another token, and reopens in a chat that opens and readies with it much later', async () => {
    const b = await chat(TOKEN_B);
    const tab = restoredTab();

    await svc.restorePanel(tab, 'https://a.example/', TOKEN_A);
    for (let i = 0; i < 5; i++) await settle();
    // other chats come and go meanwhile
    const c = await chat(TOKEN_B.replace('0b3e', '1b3e'));
    c.host.closeFromUser();
    await settle();
    expect(tab.disposed).toBe(true);
    expect(pageCount()).toBe(0);
    expect(svc.chatScope(b.host).listTabs()).toEqual([]);

    const a = await chat(TOKEN_A);
    await vi.waitFor(() => expect(svc.chatScope(a.host).listTabs().map((t) => t.url)).toEqual(['https://a.example/']));
    expect(svc.chatScope(b.host).listTabs()).toEqual([]);
    expect(restoreLines()).toEqual([]);
  });

  it('reopens a page the sidebar chat owned once the sidebar resolves and readies, after every editor chat readied', async () => {
    const b = await chat(TOKEN_B);

    await svc.restorePanel(restoredTab(), 'https://side.example/', TOKEN_A);
    await settle();
    expect(pageCount()).toBe(0);

    const sidebar = await chat(TOKEN_A, sidebarHost());
    await vi.waitFor(() => expect(svc.chatScope(sidebar.host).listTabs().map((t) => t.url)).toEqual(['https://side.example/']));
    expect(svc.chatScope(b.host).listTabs()).toEqual([]);
  });

  it('keeps waiting when a chat closes before it readied, and opens nothing after the service is disposed', async () => {
    const a = await chat();
    await svc.restorePanel(restoredTab(), 'https://a.example/', TOKEN_A);

    a.host.closeFromUser();
    await settle();
    expect(restoreLines()).toEqual([]);
    expect(pageCount()).toBe(0);

    await svc.dispose();
    expect((svc as unknown as { pendingRestores: unknown[] }).pendingRestores).toEqual([]);
    await chat(TOKEN_A);
    await settle();
    expect(pageCount()).toBe(0);
  });

  it('names each page\'s chat token in the address it posts to the page, which the page keeps in its state', async () => {
    const a = await chat(TOKEN_A);
    await svc.restorePanel(restoredTab(), 'https://a.example/', TOKEN_A);
    const pageHost = platform.window.panels.find((panel) => panel.options.kind === 'browser' && !panel.disposed)!;

    pageHost.fireMessage({ type: 'ready' });

    expect(pageHost.posted).toContainEqual({ type: 'urlChanged', url: 'https://a.example/', notSecure: false, owner: TOKEN_A });
    expect(harness.manager.browserChatOwners().tokenOf(a.host)).toBe(TOKEN_A);
  });

  it('saves a served page\'s file: address beside its served one, and reopens it at a fresh address its chat\'s served files give', async () => {
    const a = await chat(TOKEN_A);
    let opens = 0;
    const restoreTarget = vi.fn(async (_url: string) => ({ url: `${GRANT}/__damocles_preview/open?t=${++opens}` }));
    svc.bindServedPages(a.host, {
      toFile: (url) => (url.startsWith(GRANT) ? SERVED_FILE : url),
      restoreTarget,
      ownsOrigin: (origin) => origin === GRANT,
    });

    // the saved served address is dead after a reload; the page reopens from its file: address
    await svc.restorePanel(restoredTab(), `${GRANT}/docs/a.html`, TOKEN_A, SERVED_FILE);

    expect(restoreTarget).toHaveBeenCalledWith(SERVED_FILE);
    expect(navigated).toEqual([`${GRANT}/__damocles_preview/open?t=1`]);
    const pageHost = platform.window.panels.find((panel) => panel.options.kind === 'browser' && !panel.disposed)!;
    pageHost.fireMessage({ type: 'ready' });
    const saved = pageHost.posted.filter((m) => (m as { type: string }).type === 'urlChanged').at(-1) as { url: string; owner: string; file: string };
    expect(saved).toEqual({ type: 'urlChanged', url: `${GRANT}/__damocles_preview/open?t=1`, notSecure: false, owner: TOKEN_A, file: SERVED_FILE });

    // the state the page kept restores it again
    await svc.restorePanel(restoredTab(), saved.url, saved.owner, saved.file);
    expect(restoreTarget).toHaveBeenLastCalledWith(SERVED_FILE);
    expect(navigated.at(-1)).toBe(`${GRANT}/__damocles_preview/open?t=2`);
    expect(svc.chatScope(a.host).listTabs()).toHaveLength(2);
  });

  it('posts no file: address for a page that is not served', async () => {
    const a = await chat(TOKEN_A);
    svc.bindServedPages(a.host, { toFile: (url) => url, restoreTarget: vi.fn(), ownsOrigin: () => false });
    await svc.restorePanel(restoredTab(), 'https://a.example/', TOKEN_A);
    const pageHost = platform.window.panels.find((panel) => panel.options.kind === 'browser' && !panel.disposed)!;

    pageHost.fireMessage({ type: 'ready' });

    expect(pageHost.posted).toContainEqual({ type: 'urlChanged', url: 'https://a.example/', notSecure: false, owner: TOKEN_A });
  });
});
