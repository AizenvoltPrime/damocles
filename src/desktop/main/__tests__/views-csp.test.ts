import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  WebContentsView: class {
    webContents = { on: vi.fn(), ipc: { on: vi.fn() }, isDestroyed: () => false, isCrashed: () => false };
    setBackgroundColor = vi.fn();
    setVisible = vi.fn();
  },
  nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  protocol: {},
}));
vi.mock('../security', () => ({ registerPanelContents: vi.fn(), loadAppPage: vi.fn(), loggableUrl: (url: string) => url }));

import type { PanelOptions } from '../../../platform/window-service';
import type { PanelStateStore } from '../panel-state-store';
import { CHAT_WORKER_SRC, DesktopPanel, type PanelViews } from '../views';

function panel(kind: PanelOptions['kind']): DesktopPanel {
  const deps = { window: {} as never, preloadPath: '', panePreloadPath: '', states: { set: vi.fn() } as unknown as PanelStateStore, log: vi.fn(), onChange: vi.fn(), onRestack: vi.fn(), onReveal: vi.fn(), onRendererGaveUp: vi.fn(), onSavedSessionChange: vi.fn(), onPaneGaveUp: vi.fn(), paneContext: vi.fn() };
  return new DesktopPanel({} as PanelViews, deps, { options: { kind, title: '', localResourceRoots: [] } }, undefined, undefined);
}

// workerSrc becomes the chat page's CSP worker-src (core panel HTML); Monaco's workers need it and nothing else may get it.
describe('panel CSP inputs', () => {
  it('lets a chat load workers from the built webview assets only', () => {
    expect(CHAT_WORKER_SRC).toBe('app://damocles/webview/assets/');
    expect(panel('chat').workerSrc).toBe(CHAT_WORKER_SRC);
  });

  it('gives a browser page no worker source', () => {
    expect(panel('browser').workerSrc).toBeUndefined();
  });
});
