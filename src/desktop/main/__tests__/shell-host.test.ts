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
import { DEFAULT_SHELL_LAYOUT } from '../window-layout-store';
import { SHELL_PAGE_URL, resolveAppRequest } from '../protocol';
import { ShellHost, chatName, chatTag, contentBoundsToDip, isShellId, reportFailure, shellHtml, shellPoint, type ShellActions } from '../shell';
import { isPanelSender } from '../views';

describe('shell page', () => {
  it('is served in memory at the exact shell URL', () => {
    expect(SHELL_PAGE_URL).toBe('app://damocles/shell/index.html');
    expect(resolveAppRequest(SHELL_PAGE_URL, process.cwd())).toEqual({ kind: 'shell' });
    expect(resolveAppRequest('app://damocles/shell/other.html', process.cwd())).toBeUndefined();
  });

  it('locks script-src to a fresh nonce and allows no inline script or remote origin', () => {
    const first = shellHtml({ kind: 'dark', css: ':root{--d-text:#ccc}', reducedMotion: false });
    const second = shellHtml({ kind: 'light', css: '', reducedMotion: true });
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(first)?.[1] ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(csp).toBe(`default-src 'none'; style-src app://damocles 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src app://damocles; img-src app://damocles data:;`);
    expect(first).toContain(`<script nonce="${nonce}" type="module" src="app://damocles/desktop-shell/assets/index.js"></script>`);
    expect(first).toContain('<body class="vscode-dark"');
    expect(first).toContain('<style id="damocles-host-theme">:root{--d-text:#ccc}</style>');
    expect(first).toContain('<html lang="en">');
    expect(second).toContain('<body class="vscode-light"');
    expect(second).toContain('<html lang="en" data-reduced-motion>');
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

  it('trims a chat name and accepts 1 to 200 characters', () => {
    expect(chatName('  Fix the bug ')).toBe('Fix the bug');
    expect(chatName('x'.repeat(200))).toBe('x'.repeat(200));
    expect(chatName('x'.repeat(201))).toBeUndefined();
    expect(chatName('   ')).toBeUndefined();
    expect(chatName(5)).toBeUndefined();
  });

  it('trims a tag, accepts 1 to 50 characters and null to remove it', () => {
    expect(chatTag(' bug ')).toBe('bug');
    expect(chatTag(null)).toBeNull();
    expect(chatTag('x'.repeat(51))).toBeUndefined();
    expect(chatTag('')).toBeUndefined();
    expect(chatTag(undefined)).toBeUndefined();
  });

  it('accepts a finite in-range menu anchor only', () => {
    expect(shellPoint({ x: 4, y: 8 })).toEqual({ x: 4, y: 8 });
    expect(shellPoint({ x: -1, y: 8 })).toBeUndefined();
    expect(shellPoint({ x: Number.NaN, y: 8 })).toBeUndefined();
    expect(shellPoint({ x: 1e9, y: 8 })).toBeUndefined();
    expect(shellPoint(null)).toBeUndefined();
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
    getZoomFactor: () => 1.5,
    isFocused: () => false,
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
    actions = {
      selectChat: vi.fn(async () => ({ ok: true })),
      newChat: vi.fn(async () => { throw new Error('no session'); }),
      renameChat: vi.fn(async () => ({ ok: true })),
      tagChat: vi.fn(async () => ({ ok: true })),
      searchChats: vi.fn(async () => ({ projectKey: 'p', chats: [], tags: [] })),
      requestOverlay: vi.fn(async () => ({ kind: 'dismissed' })),
      openAppMenu: vi.fn(),
      setContentBounds: vi.fn(),
      setLayout: vi.fn(),
      setFocusedPart: vi.fn(),
    } as unknown as ShellActions;
  });

  const host = (): ShellHost => new ShellHost(window, actions, (line) => lines.push(line), () => { gaveUp++; });
  const own = { sender: contents, senderFrame: contents.mainFrame };

  it('rejects a call from any webContents but the window page, and runs it for the page', async () => {
    host();
    const foreign = { sender: { id: 2 }, senderFrame: { url: SHELL_PAGE_URL, parent: null } };
    const selectChat = ipc.handlers.get(SHELL_CHANNELS.chatsSelect)!;
    await expect(selectChat(foreign, 's-1')).rejects.toThrow('Rejected');
    await expect(selectChat({ sender: contents, senderFrame: { url: SHELL_PAGE_URL, parent: {} } }, 's-1')).rejects.toThrow('Rejected');
    ipc.listeners.get(SHELL_CHANNELS.contentBounds)!(foreign, { x: 0, y: 0, width: 10, height: 10 });
    expect(actions.selectChat).not.toHaveBeenCalled();
    expect(actions.setContentBounds).not.toHaveBeenCalled();

    await selectChat(own, 's-1');
    expect(actions.selectChat).toHaveBeenCalledWith('s-1');
    expect(lines.filter((line) => line.startsWith('[shell] rejected'))).toHaveLength(3);
  });

  it('type-checks and bounds every chat payload before it reaches main', async () => {
    host();
    const call = (channel: string, ...args: unknown[]): Promise<unknown> => ipc.handlers.get(channel)!(own, ...args) as Promise<unknown>;
    await expect(call(SHELL_CHANNELS.chatsSelect, 'x'.repeat(MAX_ID_LENGTH + 1))).rejects.toThrow('Malformed id');
    await expect(call(SHELL_CHANNELS.chatsRename, 's-1', '   ')).rejects.toThrow('Malformed chat name');
    await expect(call(SHELL_CHANNELS.chatsTag, 's-1', 'x'.repeat(51))).rejects.toThrow('Malformed tag');
    await expect(call(SHELL_CHANNELS.chatsSearch, 'p', 'x'.repeat(201))).rejects.toThrow('Malformed search');
    await expect(call(SHELL_CHANNELS.overlayRequest, { kind: 'menu', anchor: { x: 0, y: 0, width: 1, height: 1 }, items: [{ kind: 'item', id: 'a', label: 'A', icon: 'skull' }] })).rejects.toThrow('Malformed overlay request');
    await expect(call(SHELL_CHANNELS.appMenu, { x: 'a', y: 0 })).rejects.toThrow('Malformed menu anchor');
    expect(actions.renameChat).not.toHaveBeenCalled();
    expect(actions.tagChat).not.toHaveBeenCalled();
    expect(actions.requestOverlay).not.toHaveBeenCalled();

    await call(SHELL_CHANNELS.chatsRename, 's-1', '  New name ');
    await call(SHELL_CHANNELS.chatsTag, 's-1', null);
    await call(SHELL_CHANNELS.appMenu, { x: 10, y: 20 });
    await call(SHELL_CHANNELS.overlayRequest, { kind: 'confirm', title: 'T', message: 'M', confirmLabel: 'OK', cancelLabel: 'No', danger: true, injected: 1 });
    expect(actions.renameChat).toHaveBeenCalledWith('s-1', 'New name');
    expect(actions.tagChat).toHaveBeenCalledWith('s-1', null);
    expect(actions.openAppMenu).toHaveBeenCalledWith({ x: 15, y: 30 });
    expect(actions.requestOverlay).toHaveBeenCalledWith({ kind: 'confirm', title: 'T', message: 'M', confirmLabel: 'OK', cancelLabel: 'No', danger: true }, contents);
  });

  it('accepts a complete in-range layout and only the sidebar as focused part', () => {
    host();
    ipc.listeners.get(SHELL_CHANNELS.layout)!(own, { ...DEFAULT_SHELL_LAYOUT, sidebarWidth: 100 });
    ipc.listeners.get(SHELL_CHANNELS.layout)!(own, DEFAULT_SHELL_LAYOUT);
    ipc.listeners.get(SHELL_CHANNELS.focusedPart)!(own, 'chat');
    ipc.listeners.get(SHELL_CHANNELS.focusedPart)!(own, 'sidebar');
    ipc.listeners.get(SHELL_CHANNELS.focusedPart)!(own, null);
    expect(actions.setLayout).toHaveBeenCalledTimes(1);
    expect(actions.setLayout).toHaveBeenCalledWith(DEFAULT_SHELL_LAYOUT);
    expect((actions.setFocusedPart as ReturnType<typeof vi.fn>).mock.calls).toEqual([['sidebar'], [null]]);
    expect(lines).toContain('[shell] ignoring a malformed layout');
    expect(lines).toContain('[shell] ignoring a malformed focused part');
  });

  it('logs an action that fails before the page sees the rejection', async () => {
    host();
    await expect(ipc.handlers.get(SHELL_CHANNELS.chatsNew)!(own, undefined)).rejects.toThrow('no session');
    expect(lines).toContain(`[shell] ${SHELL_CHANNELS.chatsNew} failed: no session`);
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

  it('answers a failed call that returns a value with the fallback, and passes a success through', async () => {
    const reported: unknown[] = [];
    const request = reportFailure(async (ok: boolean): Promise<{ kind: string; itemId?: string }> => {
      if (!ok) throw new Error('The overlay did not respond');
      return { kind: 'menu', itemId: 'open' };
    }, (err) => reported.push(err), { kind: 'dismissed' });
    await expect(request(false)).resolves.toEqual({ kind: 'dismissed' });
    await expect(request(true)).resolves.toEqual({ kind: 'menu', itemId: 'open' });
    expect(reported).toEqual([new Error('The overlay did not respond')]);
  });
});
