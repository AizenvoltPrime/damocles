// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_WEBVIEW_SCRIPT } from '../browser-webview-script';

// The desktop panel preload's bridge: host messages arrive only through onMessage, never as window 'message' events.
interface Bridge {
  postMessage: ReturnType<typeof vi.fn>;
  onMessage: (listener: (message: unknown) => void) => () => void;
  getState: () => unknown;
  setState: ReturnType<typeof vi.fn>;
}

const TOOLBAR = `
    <div id="toolbar">
      <button id="btn-back"></button><button id="btn-forward"></button><button id="btn-reload"></button>
      <input id="url-input" /><button id="btn-pick"></button><button id="btn-devtools"></button>
      <button id="btn-newtab"></button>
    </div>`;

// toolbar false: the page as a host with a chat browser pane renders it, which draws the chrome itself.
function mount(toolbar = true): { bridge: Bridge; deliver: (message: unknown) => void } {
  document.body.innerHTML = `${toolbar ? TOOLBAR : ''}
    <div id="content-area">
      <div id="placeholder"></div>
      <canvas id="screen" style="display:none"></canvas>
      <div id="element-overlay"></div><div id="disconnected-overlay"></div>
    </div>`;
  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  Object.defineProperty(canvas, 'getContext', { value: () => ({ fillRect: vi.fn(), drawImage: vi.fn(), clearRect: vi.fn() }), configurable: true });
  const listeners: Array<(message: unknown) => void> = [];
  const bridge: Bridge = {
    postMessage: vi.fn(),
    onMessage: (listener) => {
      listeners.push(listener);
      return () => undefined;
    },
    getState: () => ({ url: 'https://restored.example/' }),
    setState: vi.fn(),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  delete g['acquireVsCodeApi'];
  g['damoclesBridge'] = bridge;
  g['ResizeObserver'] = class { observe(): void {} disconnect(): void {} };
  new Function(BROWSER_WEBVIEW_SCRIPT)();
  return { bridge, deliver: (message) => { for (const listener of listeners) listener(message); } };
}

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>)['damoclesBridge'];
});

describe('browser panel script on the desktop bridge', () => {
  it('posts through window.damoclesBridge and receives host messages from its onMessage', () => {
    const { bridge, deliver } = mount();
    expect(bridge.postMessage).toHaveBeenCalledWith({ type: 'ready' });
    deliver({ type: 'urlChanged', url: 'https://next.example/' });
    expect((document.getElementById('url-input') as HTMLInputElement).value).toBe('https://next.example/');
    expect(bridge.setState).toHaveBeenCalledWith({ url: 'https://next.example/' });
  });

  it('runs without the in-page toolbar and still handles every host message it draws', () => {
    const { bridge, deliver } = mount(false);
    expect(bridge.postMessage).toHaveBeenCalledWith({ type: 'ready' });
    deliver({ type: 'urlChanged', url: 'https://next.example/' });
    deliver({ type: 'pickingStateChanged', picking: true });
    deliver({ type: 'navigationState', loading: true, canGoBack: true, canGoForward: false });
    expect(bridge.setState).toHaveBeenCalledWith({ url: 'https://next.example/' });
    expect((document.getElementById('screen') as HTMLCanvasElement).style.cursor).toBe('crosshair');
  });
});
