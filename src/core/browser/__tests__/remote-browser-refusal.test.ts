import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BrowserService } from '../index';
import { launchBrowserContext } from '../launcher';
import { createFakePlatform, type FakePanelHost } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { installPlatform } from '../../platform-host';
import { USER_SCOPE_UNAVAILABLE } from '../../../shared/remote-user';
import { createBrowserHandlers } from '../../chat-panel/message-router/handlers/browser-handlers';
import type { HandlerContext, HandlerDependencies } from '../../chat-panel/message-router/types';
import type { WebviewToExtensionMessage } from '../../../shared/types/messages';

const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('../launcher', () => ({ launchBrowserContext: vi.fn() }));
vi.mock('os', async (importActual) => ({ ...(await importActual<typeof import('os')>()), homedir: () => home.dir }));

// On a daemon's core the browser is the client's, so nothing starts Chrome or creates a profile on the target.
let service: BrowserService;
let chat: FakePanelHost;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), 'damocles-remote-browser-'));
  vi.mocked(launchBrowserContext).mockClear();
  const platform = { ...createFakePlatform({ settings: { user: { 'damocles.browser.enabled': true } } }), remote: createFakeRemoteHost().remote };
  installPlatform(platform);
  service = new BrowserService(platform);
  chat = platform.window.createPanel({ kind: 'chat', title: 'chat', localResourceRoots: [] }) as FakePanelHost;
});

afterEach(async () => {
  await service.dispose();
  installPlatform(createFakePlatform());
  rmSync(home.dir, { recursive: true, force: true });
});

const launchedNothing = (): void => {
  expect(launchBrowserContext).not.toHaveBeenCalled();
  expect(readdirSync(home.dir)).toEqual([]);
};

describe("the browser on a daemon's core", () => {
  it('refuses every way a chat or an agent opens a page, with the user-scope reason', async () => {
    await expect(service.showForChat(chat)).rejects.toThrow(USER_SCOPE_UNAVAILABLE);
    await expect(service.openNewPageForChat(chat)).rejects.toThrow(USER_SCOPE_UNAVAILABLE);
    await expect(service.openForScope(service.chatScope(chat).id, 'https://example.com')).rejects.toThrow(USER_SCOPE_UNAVAILABLE);
    launchedNothing();
  });

  it('restores no page', async () => {
    await service.restoreChatPages(chat, ['https://example.com'], 0);
    await service.restorePanel(chat, 'https://example.com');
    launchedNothing();
  });

  it('answers the chat page\'s open and pick with the user-scope reason and never reaches the browser', async () => {
    const posted: unknown[] = [];
    const browserService = { showForChat: vi.fn(), pickElement: vi.fn(), isConnected: () => true };
    const handlers = createBrowserHandlers({ postMessage: (_host: unknown, message: unknown) => posted.push(message), browserService } as unknown as HandlerDependencies);
    const ctx = { host: chat } as unknown as HandlerContext;
    await handlers.openBrowser!({ type: 'openBrowser' } as WebviewToExtensionMessage, ctx);
    await handlers.pickBrowserElement!({ type: 'pickBrowserElement' } as WebviewToExtensionMessage, ctx);
    const BROWSER_REFUSAL = { message: '{0} is not available in a chat on a remote host yet: it runs on your computer ({1}).', args: [{ message: 'The browser' }, USER_SCOPE_UNAVAILABLE] };
    expect(posted).toEqual([
      { type: 'notification', message: BROWSER_REFUSAL, notificationType: 'warning' },
      { type: 'notification', message: BROWSER_REFUSAL, notificationType: 'warning' },
    ]);
    expect(browserService.showForChat).not.toHaveBeenCalled();
    expect(browserService.pickElement).not.toHaveBeenCalled();
  });
});
