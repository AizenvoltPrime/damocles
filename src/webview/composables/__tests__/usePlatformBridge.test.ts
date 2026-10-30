// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

type Globals = { acquireVsCodeApi?: (() => VsCodeApi) | undefined };
const g = globalThis as unknown as Globals;
const setupApi = g.acquireVsCodeApi;

afterEach(() => {
  g.acquireVsCodeApi = setupApi;
  delete window.damoclesBridge;
  vi.resetModules();
});

describe('usePlatformBridge host selection', () => {
  it('uses the VS Code API when acquireVsCodeApi is a function, and receives window message events', async () => {
    const api = { postMessage: vi.fn(), getState: vi.fn(() => ({ a: 1 })), setState: vi.fn() };
    g.acquireVsCodeApi = vi.fn(() => api);
    window.damoclesBridge = { postMessage: vi.fn(), onMessage: vi.fn(() => () => {}), getState: vi.fn(), setState: vi.fn(), getHost: vi.fn(), onHost: vi.fn(() => () => {}), getOffline: vi.fn(), hostAction: vi.fn(), getConnection: vi.fn(), onConnection: vi.fn(() => () => {}), queueAction: vi.fn() };
    const { usePlatformBridge } = await import('../usePlatformBridge');
    const bridge = usePlatformBridge();
    usePlatformBridge().postMessage({ type: 'cancelSession' });

    bridge.postMessage({ type: 'cancelSession' });
    bridge.setState({ b: 2 });
    const received: ExtensionToWebviewMessage[] = [];
    const off = bridge.onMessage((m) => received.push(m));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'ping' } }));
    off();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'after' } }));

    expect(g.acquireVsCodeApi).toHaveBeenCalledTimes(1);
    expect(api.postMessage).toHaveBeenCalledTimes(2);
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'cancelSession' });
    expect(api.setState).toHaveBeenCalledWith({ b: 2 });
    expect(bridge.getState()).toEqual({ a: 1 });
    expect(bridge.host).toBe('vscode');
    expect(received).toEqual([{ type: 'ping' }]);
    expect(window.damoclesBridge.postMessage).not.toHaveBeenCalled();
  });

  it('uses window.damoclesBridge when acquireVsCodeApi is absent, and unsubscribes through it', async () => {
    delete g.acquireVsCodeApi;
    let listener: ((m: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const desktop = {
      postMessage: vi.fn(),
      onMessage: vi.fn((l: (m: unknown) => void) => {
        listener = l;
        return unsubscribe;
      }),
      getState: vi.fn(() => ({ tab: 'x' })),
      setState: vi.fn(),
      getHost: vi.fn(),
      onHost: vi.fn(() => () => {}),
      getOffline: vi.fn(),
      hostAction: vi.fn(),
      getConnection: vi.fn(),
      onConnection: vi.fn(() => () => {}),
      queueAction: vi.fn(),
    };
    window.damoclesBridge = desktop;
    const { usePlatformBridge } = await import('../usePlatformBridge');
    const bridge = usePlatformBridge();

    bridge.postMessage({ type: 'cancelSession' });
    bridge.setState({ tab: 'y' });
    const received: ExtensionToWebviewMessage[] = [];
    const off = bridge.onMessage((m) => received.push(m));
    listener?.({ type: 'ping' });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'window-event-ignored' } }));
    off();

    expect(desktop.postMessage).toHaveBeenCalledWith({ type: 'cancelSession' });
    expect(desktop.setState).toHaveBeenCalledWith({ tab: 'y' });
    expect(bridge.getState()).toEqual({ tab: 'x' });
    expect(bridge.host).toBe('desktop');
    expect(received).toEqual([{ type: 'ping' }]);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('fails loudly on first use when neither host bridge exists', async () => {
    delete g.acquireVsCodeApi;
    const { usePlatformBridge } = await import('../usePlatformBridge');
    expect(() => usePlatformBridge()).toThrow(/No host bridge/);
  });

  it('hands a page core\'s LocalizedText only once it parses, on either host, dropping a malformed message with an error', async () => {
    const good = { type: 'notification', message: { message: 'Your prompt was blocked by a hook.' }, notificationType: 'warning' };
    const bad = { type: 'notification', message: 'Your prompt was blocked by a hook.', notificationType: 'warning' };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() };
    g.acquireVsCodeApi = vi.fn(() => api);
    const vscodePage = await import('../usePlatformBridge');
    const received: unknown[] = [];
    const off = vscodePage.usePlatformBridge().onMessage((m) => received.push(m));
    window.dispatchEvent(new MessageEvent('message', { data: bad }));
    window.dispatchEvent(new MessageEvent('message', { data: good }));
    off();

    vi.resetModules();
    delete g.acquireVsCodeApi;
    let listener: ((m: unknown) => void) | undefined;
    window.damoclesBridge = { postMessage: vi.fn(), onMessage: vi.fn((l: (m: unknown) => void) => { listener = l; return () => {}; }), getState: vi.fn(), setState: vi.fn(), getHost: vi.fn(), onHost: vi.fn(() => () => {}), getOffline: vi.fn(), hostAction: vi.fn(), getConnection: vi.fn(), onConnection: vi.fn(() => () => {}), queueAction: vi.fn() };
    const desktopPage = await import('../usePlatformBridge');
    desktopPage.usePlatformBridge().onMessage((m) => received.push(m));
    listener?.(bad);
    listener?.(good);

    expect(received).toEqual([good, good]);
    expect(errors.mock.calls.map(([line]) => line)).toEqual([
      '[bridge] dropped a notification message: its .message is not LocalizedText',
      '[bridge] dropped a notification message: its .message is not LocalizedText',
    ]);
    errors.mockRestore();
  });

  it('uses a bridge the page installs before first use, such as the desktop overlay, and refuses a second one', async () => {
    delete g.acquireVsCodeApi;
    const page = { host: 'overlay' as const, postMessage: vi.fn(), onMessage: vi.fn(() => () => {}), getState: vi.fn(), setState: vi.fn() };
    const { installPlatformBridge, usePlatformBridge } = await import('../usePlatformBridge');
    installPlatformBridge(page);
    usePlatformBridge().postMessage({ type: 'requestSettingsState' });
    expect(page.postMessage).toHaveBeenCalledWith({ type: 'requestSettingsState' });
    expect(() => installPlatformBridge(page)).toThrow(/already in use/);
  });
});
