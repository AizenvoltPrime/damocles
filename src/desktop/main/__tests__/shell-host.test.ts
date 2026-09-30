import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => ipc.listeners.set(channel, listener),
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => ipc.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipc.handlers.delete(channel),
    removeListener: (channel: string) => ipc.listeners.delete(channel),
  },
  WebContentsView: vi.fn(),
  nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  protocol: {},
}));

import { MAX_ID_LENGTH, SHELL_CHANNELS } from '../../preload/shell-channels';
import { SHELL_PAGE_URL, resolveAppRequest } from '../protocol';
import { ShellHost, contentBoundsToDip, isShellId, isToastAction, reportFailure, shellHtml, type ShellActions } from '../shell';
import { isPanelSender } from '../views';

describe('shell page', () => {
  it('is served in memory at the exact shell URL', () => {
    expect(SHELL_PAGE_URL).toBe('app://damocles/shell/index.html');
    expect(resolveAppRequest(SHELL_PAGE_URL, process.cwd())).toEqual({ kind: 'shell' });
    expect(resolveAppRequest('app://damocles/shell/other.html', process.cwd())).toBeUndefined();
  });

  it('locks script-src to a fresh nonce and allows no inline script or remote origin', () => {
    const first = shellHtml({ kind: 'dark', css: ':root{--vscode-foreground:#ccc}' });
    const second = shellHtml({ kind: 'light', css: '' });
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(first)?.[1] ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(csp).toBe(`default-src 'none'; style-src app://damocles 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src app://damocles; img-src app://damocles data:;`);
    expect(first).toContain(`<script nonce="${nonce}" type="module" src="app://damocles/desktop-shell/assets/index.js"></script>`);
    expect(first).toContain('<body class="vscode-dark"');
    expect(second).toContain('<body class="vscode-light"');
    expect(second).not.toContain(`'nonce-${nonce}'`);
  });

  it('accepts IPC only from the window page main frame on the shell URL', () => {
    const own = { id: 1 };
    expect(isPanelSender({ sender: own, senderFrame: { url: SHELL_PAGE_URL, parent: null } }, own, SHELL_PAGE_URL)).toBe(true);
    expect(isPanelSender({ sender: { id: 2 }, senderFrame: { url: SHELL_PAGE_URL, parent: null } }, own, SHELL_PAGE_URL)).toBe(false);
    expect(isPanelSender({ sender: own, senderFrame: { url: `${SHELL_PAGE_URL}#x`, parent: null } }, own, SHELL_PAGE_URL)).toBe(false);
    expect(isPanelSender({ sender: own, senderFrame: { url: SHELL_PAGE_URL, parent: {} } }, own, SHELL_PAGE_URL)).toBe(false);
  });
});

describe('shell argument validation', () => {
  it('accepts bounded non-empty ids only', () => {
    expect(isShellId('host-1')).toBe(true);
    expect(isShellId('')).toBe(false);
    expect(isShellId('x'.repeat(MAX_ID_LENGTH + 1))).toBe(false);
    expect(isShellId(3)).toBe(false);
    expect(isShellId({ toString: () => 'a' })).toBe(false);
  });

  it('accepts an absent or bounded string toast action', () => {
    expect(isToastAction(undefined)).toBe(true);
    expect(isToastAction('Reload')).toBe(true);
    expect(isToastAction(null)).toBe(false);
    expect(isToastAction(1)).toBe(false);
  });

  it('scales CSS bounds by the zoom factor and rounds the far edge outward', () => {
    expect(contentBoundsToDip({ x: 240, y: 36, width: 960, height: 784 }, 1)).toEqual({ x: 240, y: 36, width: 960, height: 784 });
    expect(contentBoundsToDip({ x: 100.4, y: 10.6, width: 200.3, height: 50 }, 1.25)).toEqual({ x: 126, y: 13, width: 250, height: 63 });
  });

  it.each([
    null,
    'x',
    { x: 0, y: 0, width: 10 },
    { x: -1, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: Number.NaN, height: 10 },
    { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 },
    { x: 0, y: 0, width: 1e9, height: 10 },
    { x: '0', y: 0, width: 10, height: 10 },
  ])('rejects malformed bounds %j', (raw) => {
    expect(contentBoundsToDip(raw, 1)).toBeUndefined();
  });
});

describe('ShellHost', () => {
  const contents = Object.assign(new EventEmitter(), {
    id: 1,
    mainFrame: { url: SHELL_PAGE_URL, parent: null },
    loadURL: vi.fn(async () => undefined),
    getZoomFactor: () => 1,
    isDestroyed: () => false,
    isCrashed: () => false,
    send: vi.fn(),
  });
  const window = { webContents: contents, isDestroyed: () => false } as never;
  let actions: ShellActions;
  let lines: string[];
  let gaveUp: number;

  beforeEach(() => {
    ipc.handlers.clear();
    ipc.listeners.clear();
    contents.removeAllListeners();
    contents.loadURL.mockClear();
    lines = [];
    gaveUp = 0;
    actions = { selectTab: vi.fn(), closeTab: vi.fn(), newTab: vi.fn(async () => { throw new Error('no session'); }), setContentBounds: vi.fn(), resolveToast: vi.fn(), pendingToasts: () => [] } as unknown as ShellActions;
  });

  const host = (): ShellHost => new ShellHost(window, actions, (line) => lines.push(line), () => { gaveUp++; });
  const own = { sender: contents, senderFrame: contents.mainFrame };

  it('rejects a call from any webContents but the window page, and runs it for the page', async () => {
    host();
    const foreign = { sender: { id: 2 }, senderFrame: { url: SHELL_PAGE_URL, parent: null } };
    const selectTab = ipc.handlers.get(SHELL_CHANNELS.selectTab)!;
    await expect(selectTab(foreign, 'tab-1')).rejects.toThrow('Rejected');
    await expect(selectTab({ sender: contents, senderFrame: { url: SHELL_PAGE_URL, parent: {} } }, 'tab-1')).rejects.toThrow('Rejected');
    ipc.listeners.get(SHELL_CHANNELS.contentBounds)!(foreign, { x: 0, y: 0, width: 10, height: 10 });
    expect(actions.selectTab).not.toHaveBeenCalled();
    expect(actions.setContentBounds).not.toHaveBeenCalled();

    await selectTab(own, 'tab-1');
    expect(actions.selectTab).toHaveBeenCalledWith('tab-1');
    expect(lines.filter((line) => line.startsWith('[shell] rejected'))).toHaveLength(3);
  });

  it('logs an action that fails before the page sees the rejection', async () => {
    host();
    await expect(ipc.handlers.get(SHELL_CHANNELS.newTab)!(own, undefined)).rejects.toThrow('no session');
    expect(lines).toContain(`[shell] ${SHELL_CHANNELS.newTab} failed: no session`);
  });

  it('reloads a crashed page until the crash limit, then hands it to the host once and restarts on request', () => {
    const shell = host();
    shell.load();
    const crash = (): void => {
      contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    };
    for (let i = 0; i < 3; i++) crash();
    expect(contents.loadURL).toHaveBeenCalledTimes(4);
    crash();
    expect(contents.loadURL).toHaveBeenCalledTimes(4);
    expect(gaveUp).toBe(1);
    shell.restart();
    expect(contents.loadURL).toHaveBeenCalledTimes(5);
  });
});

describe('reportFailure', () => {
  it('hands a failed shell action to the reporter and resolves, since the page cannot show the error', async () => {
    const reported: unknown[] = [];
    const failing = reportFailure(async (key: string) => {
      throw new Error(`${key} is not open`);
    }, (err) => reported.push(err));
    await expect(failing('p1')).resolves.toBeUndefined();
    expect(reported).toEqual([new Error('p1 is not open')]);
  });
});
