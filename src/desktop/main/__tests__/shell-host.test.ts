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

import { MAX_EDITOR_TEXT_CHARS, MAX_FORMAT_ERROR_CHARS, MAX_ID_LENGTH, SHELL_CHANNELS, type ShellChatList, type ShellState } from '../../preload/shell-channels';
import { DEFAULT_SHELL_LAYOUT } from '../window-layout-store';
import { SHELL_PAGE_URL, resolveAppRequest } from '../protocol';
import { ShellHost, browserPageAreaToDip, chatName, chatTag, contentBoundsToDip, isShellId, parseTerminalCreate, reportFailure, shellHtml, shellPoint, type ShellActions } from '../shell';
import { MAX_TERMINAL_ATTACHMENT_CHARS, MAX_TERMINAL_ATTACHMENT_OMITTED_LINES } from '../../preload/terminal-attachment-cap';
import {
  MAX_TERMINAL_GROUP_PANES,
  MAX_TERMINAL_INPUT_CHARS,
  MAX_TERMINAL_LINK_PATH_LENGTH,
  MAX_TERMINAL_LINK_PATHS,
  MAX_TERMINAL_LINK_POSITION,
  MAX_TERMINAL_NAME_LENGTH,
  TERMINAL_CHANNELS,
  isTerminalPasteChord,
} from '../../preload/terminal-channels';
import { PASTE_CHORD_CASES } from './paste-chords';
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
    // worker-src: Monaco's module workers from the built shell assets only, never blob: or another origin.
    expect(csp).toBe(`default-src 'none'; style-src app://damocles 'unsafe-inline'; script-src 'nonce-${nonce}'; worker-src app://damocles/desktop-shell/assets/; font-src app://damocles; img-src app://damocles data:; base-uri 'none'; form-action 'none';`);
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

  it('scales a browser page area and its corner radius by the zoom factor, and refuses a radius out of bounds', () => {
    expect(browserPageAreaToDip({ x: 100, y: 40, width: 300, height: 200, radius: 9 }, 1.5)).toEqual({ bounds: { x: 150, y: 60, width: 450, height: 300 }, radius: 14 });
    expect(browserPageAreaToDip({ x: 100, y: 40, width: 300, height: 200, radius: 0 }, 1)).toEqual({ bounds: { x: 100, y: 40, width: 300, height: 200 }, radius: 0 });
    for (const radius of [-1, Number.NaN, Number.POSITIVE_INFINITY, 65, '9', undefined]) expect(browserPageAreaToDip({ x: 0, y: 0, width: 10, height: 10, radius }, 1)).toBeUndefined();
    expect(browserPageAreaToDip({ x: -1, y: 0, width: 10, height: 10, radius: 9 }, 1)).toBeUndefined();
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
      setSidebarLayout: vi.fn(),
      setGridSizes: vi.fn(),
      setFocusedPart: vi.fn(),
      windowControl: vi.fn(),
      showSidebar: vi.fn(),
      toggleSidebar: vi.fn(),
      terminal: { shellLoaded: vi.fn(), setInputFocused: vi.fn() },
      editor: { setFocusOverlay: vi.fn() },
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

  it('shows the sidebar for the page only, and never toggles it', async () => {
    host();
    const show = ipc.handlers.get(SHELL_CHANNELS.showSidebar)!;
    await expect(show({ sender: { id: 2 }, senderFrame: { url: SHELL_PAGE_URL, parent: null } })).rejects.toThrow('Rejected');
    expect(actions.showSidebar).not.toHaveBeenCalled();
    await show(own);
    await show(own);
    expect(actions.showSidebar).toHaveBeenCalledTimes(2);
    expect(actions.toggleSidebar).not.toHaveBeenCalled();
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
    contents.emit('before-mouse-event', { preventDefault: vi.fn() }, { type: 'mouseUp', button: 'left', x: 1, y: 1, modifiers: [] });
    await call(SHELL_CHANNELS.appMenu, { x: 10, y: 20 });
    await call(SHELL_CHANNELS.overlayRequest, { kind: 'confirm', title: 'T', message: 'M', confirmLabel: 'OK', cancelLabel: 'No', danger: true, injected: 1 });
    expect(actions.renameChat).toHaveBeenCalledWith('s-1', 'New name');
    expect(actions.tagChat).toHaveBeenCalledWith('s-1', null);
    expect(actions.openAppMenu).toHaveBeenCalledWith({ x: 15, y: 30 });
    expect(actions.requestOverlay).toHaveBeenCalledWith({ kind: 'confirm', title: 'T', message: 'M', confirmLabel: 'OK', cancelLabel: 'No', danger: true }, contents);
  });

  it('runs only a known window control', async () => {
    host();
    const control = ipc.handlers.get(SHELL_CHANNELS.windowControl)!;
    await expect(control(own, 'quit')).rejects.toThrow('Unknown window control');
    await expect(control(own, 1)).rejects.toThrow('Unknown window control');
    expect(actions.windowControl).not.toHaveBeenCalled();
    await control(own, 'toggleMaximize');
    expect(actions.windowControl).toHaveBeenCalledWith('toggleMaximize');
  });

  it('accepts only the sender\'s own in-range layout fields and only the shell parts as focused part', () => {
    host();
    const { sidebarWidth, sections, search } = DEFAULT_SHELL_LAYOUT;
    ipc.listeners.get(SHELL_CHANNELS.sidebarLayout)!(own, { sidebarWidth: 100, sections, search });
    // A whole layout reaches main as the sidebar's fields alone, so a stale copy of the grid or the visibility never lands.
    ipc.listeners.get(SHELL_CHANNELS.sidebarLayout)!(own, { ...DEFAULT_SHELL_LAYOUT, sidebarVisible: false });
    ipc.listeners.get(SHELL_CHANNELS.gridSizes)!(own, { sideWidth: -1, bottomHeight: 230 });
    ipc.listeners.get(SHELL_CHANNELS.gridSizes)!(own, { sideWidth: 640, bottomHeight: 300, slots: { main: 'terminal', side: 'chat', bottom: 'editor' } });
    ipc.listeners.get(SHELL_CHANNELS.focusedPart)!(own, 'chat');
    ipc.listeners.get(SHELL_CHANNELS.focusedPart)!(own, 'sidebar');
    ipc.listeners.get(SHELL_CHANNELS.focusedPart)!(own, 'editor');
    ipc.listeners.get(SHELL_CHANNELS.focusedPart)!(own, null);
    expect(vi.mocked(actions.setSidebarLayout).mock.calls).toEqual([[{ sidebarWidth, sections, search }]]);
    expect(vi.mocked(actions.setGridSizes).mock.calls).toEqual([[{ sideWidth: 640, bottomHeight: 300 }]]);
    expect((actions.setFocusedPart as ReturnType<typeof vi.fn>).mock.calls).toEqual([['sidebar'], ['editor'], [null]]);
    expect(lines).toContain('[shell] ignoring a malformed sidebar layout');
    expect(lines).toContain('[shell] ignoring malformed grid sizes');
    expect(lines).toContain('[shell] ignoring a malformed focused part');
  });

  it('runs only a known update action from the page, and pushes the update state once the page has loaded', async () => {
    actions.update = vi.fn(() => ({ state: { kind: 'idle' as const }, lastCheckedAt: null, platform: 'win32' as const }));
    actions.runUpdateAction = vi.fn(async () => undefined);
    actions.state = vi.fn(() => ({ projects: [], selected: {} }) as never);
    const shell = host();
    const call = (channel: string, ...args: unknown[]): Promise<unknown> => ipc.handlers.get(channel)!(own, ...args) as Promise<unknown>;
    for (const action of ['install', 'openExternal', '', null, ['restart'], { action: 'restart' }]) {
      await expect(call(SHELL_CHANNELS.updateRun, action)).rejects.toThrow('Unknown update action');
    }
    await expect(ipc.handlers.get(SHELL_CHANNELS.updateRun)!({ sender: { id: 2 }, senderFrame: { url: SHELL_PAGE_URL, parent: null } }, 'restart')).rejects.toThrow('Rejected');
    expect(actions.runUpdateAction).not.toHaveBeenCalled();
    await call(SHELL_CHANNELS.updateRun, 'restart');
    expect(actions.runUpdateAction).toHaveBeenCalledWith('restart');
    await expect(call(SHELL_CHANNELS.updateGet)).resolves.toEqual({ state: { kind: 'idle' }, lastCheckedAt: null, platform: 'win32' });

    const snapshot = { state: { kind: 'downloading', version: '3.5.0', percent: 4 }, lastCheckedAt: 1, platform: 'win32' } as const;
    contents.send.mockClear();
    shell.updateChanged(snapshot);
    expect(contents.send).not.toHaveBeenCalled();
    contents.emit('did-finish-load');
    shell.updateChanged(snapshot);
    expect(contents.send).toHaveBeenCalledWith(SHELL_CHANNELS.updateState, snapshot);
  });

  // The page asks by the state it holds while main may already have changed the list and sent the next state.
  it('answers a chat list only for a project of the state the page names; one that left the list since answers null after the state without it', async () => {
    const projects = (...keys: string[]): ShellState['projects'] => keys.map((key) => ({ key, name: key, fsPath: key, trusted: true, running: 0, waiting: 0 }));
    let body: Pick<ShellState, 'projects' | 'selected'> = { projects: projects('a', 'b'), selected: { projectKey: 'a' } };
    const known = new Set(['a', 'b']);
    const listed = (key: string): ShellChatList | undefined => (known.has(key) ? { projectKey: key, chats: [], tags: [] } : undefined);
    actions.state = vi.fn(() => body as never);
    actions.listChats = vi.fn(async (key: string) => listed(key));
    actions.searchChats = vi.fn(async (key: string) => listed(key));
    const shell = host();
    contents.emit('did-finish-load');
    const call = (channel: string, ...args: unknown[]): Promise<unknown> => ipc.handlers.get(channel)!(own, ...args) as Promise<unknown>;
    const held = (await call(SHELL_CHANNELS.getState)) as ShellState;
    await expect(call(SHELL_CHANNELS.chatsList, 'b', held.revision)).resolves.toEqual({ projectKey: 'b', chats: [], tags: [] });

    known.delete('b');
    body = { projects: projects('a'), selected: { projectKey: 'a' } };
    contents.send.mockClear();
    await expect(call(SHELL_CHANNELS.chatsList, 'b', held.revision)).resolves.toBeNull();
    await expect(call(SHELL_CHANNELS.chatsSearch, 'b', 'fix', held.revision)).resolves.toBeNull();
    const sent = contents.send.mock.calls.filter(([channel]) => channel === SHELL_CHANNELS.state).map(([, state]) => state as ShellState);
    expect(sent.map((state) => state.projects.map((project) => project.key))).toEqual([['a'], ['a']]);
    const latest = sent.at(-1)!.revision;
    expect(latest).toBeGreaterThan(held.revision);

    // A key the named state never held, or that a later state dropped, is refused, as is a revision the page was never given.
    await expect(call(SHELL_CHANNELS.chatsList, 'c', held.revision)).rejects.toThrow('Unknown project');
    await expect(call(SHELL_CHANNELS.chatsList, 'b', latest)).rejects.toThrow('Unknown project');
    await expect(call(SHELL_CHANNELS.chatsSearch, 'b', 'fix', latest)).rejects.toThrow('Unknown project');
    for (const revision of [latest + 1, 0, String(held.revision), undefined]) {
      await expect(call(SHELL_CHANNELS.chatsList, 'a', revision)).rejects.toThrow('Malformed state revision');
    }
    expect(actions.listChats).not.toHaveBeenCalledWith('c');

    // Main publishing a project its list refuses is a fault of main's, never answered as the page's lag.
    body = { projects: projects('a'), selected: { projectKey: 'b' } };
    await expect(call(SHELL_CHANNELS.chatsList, 'b', held.revision)).rejects.toThrow('A published project is not in the project list');

    // A reloaded page holds only the states given to it.
    shell.load();
    await expect(call(SHELL_CHANNELS.chatsList, 'a', latest)).rejects.toThrow('Malformed state revision');
  });

  it('logs an action that fails before the page sees the rejection', async () => {
    host();
    await expect(ipc.handlers.get(SHELL_CHANNELS.chatsNew)!(own, undefined)).rejects.toThrow('no session');
    expect(lines).toContain(`[shell] ${SHELL_CHANNELS.chatsNew} failed: no session`);
  });

  it('settles once every request it was still answering when its page went has been answered, a failed one included', async () => {
    let answer!: (result: { ok: true }) => void;
    actions.selectChat = vi.fn(() => new Promise<{ ok: true }>((resolve) => (answer = resolve)));
    const shell = host();
    const selected = ipc.handlers.get(SHELL_CHANNELS.chatsSelect)!(own, 's-1') as Promise<unknown>;
    const failed = ipc.handlers.get(SHELL_CHANNELS.chatsNew)!(own, undefined) as Promise<unknown>;
    shell.dispose();
    let settled = false;
    const done = shell.settled().then(() => {
      settled = true;
    });
    await expect(failed).rejects.toThrow('no session');
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    answer({ ok: true });
    await expect(selected).resolves.toEqual({ ok: true });
    await done;
    expect(settled).toBe(true);
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

  it('reports no focus once a closing window destroyed its page, before the window itself is destroyed', () => {
    const page = Object.assign(new EventEmitter(), {
      isDestroyed: () => true,
      isFocused: (): boolean => {
        throw new TypeError('Object has been destroyed');
      },
    });
    const closing = { webContents: page, isDestroyed: () => false } as never;
    expect(new ShellHost(closing, actions, () => undefined, () => undefined).focused).toBe(false);
  });

  it('closes the editor focus overlay main holds when its page loads or its renderer goes, since a new page starts without it', () => {
    actions.state = vi.fn(() => ({ projects: [], selected: {} }) as never);
    host();
    const setFocusOverlay = vi.mocked(actions.editor.setFocusOverlay);
    ipc.handlers.get(SHELL_CHANNELS.editorFocusOverlay)!(own, { open: true });
    expect(setFocusOverlay).toHaveBeenLastCalledWith(true);
    contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    expect(setFocusOverlay).toHaveBeenLastCalledWith(false);
    ipc.handlers.get(SHELL_CHANNELS.editorFocusOverlay)!(own, { open: true });
    contents.emit('did-finish-load');
    expect(setFocusOverlay).toHaveBeenLastCalledWith(false);
  });
});

describe('editor, Files, layout and Quick Open channels', () => {
  const contents = Object.assign(new EventEmitter(), {
    id: 1,
    mainFrame: { url: SHELL_PAGE_URL, parent: null },
    loadURL: vi.fn(async () => undefined),
    getZoomFactor: () => 1,
    isFocused: () => false,
    isDestroyed: () => false,
    isCrashed: () => false,
    send: vi.fn(),
  });
  const window = { webContents: contents, isDestroyed: () => false } as never;
  const own = { sender: contents, senderFrame: contents.mainFrame };
  const foreign = { sender: { id: 2 }, senderFrame: { url: 'app://damocles/webview/x', parent: null } };
  let editor: Record<string, ReturnType<typeof vi.fn>>;
  let files: Record<string, ReturnType<typeof vi.fn>>;
  let actions: ShellActions;
  let lines: string[];

  beforeEach(() => {
    ipc.handlers.clear();
    ipc.listeners.clear();
    contents.removeAllListeners();
    lines = [];
    editor = Object.fromEntries(['state', 'content', 'open', 'tab', 'edit', 'save', 'conflict', 'format', 'formatFailed', 'selection', 'mention', 'setFocusOverlay', 'flushed', 'clipboard'].map((name) => [name, vi.fn(async () => ({ ok: true }))]));
    files = Object.fromEntries(['list', 'create', 'rename', 'delete', 'copyPath', 'reveal', 'mention'].map((name) => [name, vi.fn(async () => ({ ok: true }))]));
    actions = {
      editor,
      files,
      layoutMove: vi.fn(),
      toggleMaximize: vi.fn(),
      dropZonesPointer: vi.fn(),
    } as unknown as ShellActions;
    new ShellHost(window, actions, (line) => lines.push(line), () => undefined);
  });

  const call = (channel: string, payload?: unknown, sender: unknown = own): Promise<unknown> => Promise.resolve(ipc.handlers.get(channel)!(sender, payload));
  const send = (channel: string, payload: unknown, sender: unknown = own): void => ipc.listeners.get(channel)!(sender, payload);

  it.each([
    ['a parent escape', '../secret.txt'],
    ['a nested escape', 'src/../../secret.txt'],
    ['a Windows absolute path', 'C:\\Windows\\win.ini'],
    ['a drive-relative path', 'C:win.ini'],
    ['a POSIX absolute path', '/etc/passwd'],
    ['a UNC path', '\\\\server\\share\\x'],
    ['a NUL byte', 'a\0b'],
    ['the project folder itself', ''],
    ['an overlong path', 'a/'.repeat(2049)],
  ])('refuses %s in editor:open and every Files channel before main sees it', async (_name, relativePath) => {
    await expect(call(SHELL_CHANNELS.editorOpen, { projectKey: 'p', relativePath })).resolves.toEqual({ ok: false, reason: 'outside' });
    await expect(call(SHELL_CHANNELS.filesDelete, { projectKey: 'p', relativePath })).rejects.toThrow(/Malformed/);
    await expect(call(SHELL_CHANNELS.filesRename, { projectKey: 'p', relativePath, newName: 'x' })).rejects.toThrow(/Malformed/);
    await expect(call(SHELL_CHANNELS.filesMention, { projectKey: 'p', relativePath })).rejects.toThrow(/Malformed/);
    expect(editor['open']).not.toHaveBeenCalled();
    expect(files['delete']).not.toHaveBeenCalled();
    expect(files['rename']).not.toHaveBeenCalled();
    expect(files['mention']).not.toHaveBeenCalled();
  });

  it('passes a clean copy of a confined request on, and refuses every channel from another sender', async () => {
    await call(SHELL_CHANNELS.editorOpen, { projectKey: 'p', relativePath: 'src/a.ts', line: 3, as: 'preview', extra: 1 });
    expect(editor['open']).toHaveBeenCalledWith({ projectKey: 'p', relativePath: 'src/a.ts', line: 3, as: 'preview' });
    await call(SHELL_CHANNELS.filesList, { projectKey: 'p', relativeDir: '', report: false });
    expect(files['list']).toHaveBeenCalledWith('p', '', false);
    await call(SHELL_CHANNELS.filesList, { projectKey: 'p', relativeDir: 'src', report: true });
    expect(files['list']).toHaveBeenLastCalledWith('p', 'src', true);
    await expect(call(SHELL_CHANNELS.filesList, { projectKey: 'p', relativeDir: '', report: 'yes' })).rejects.toThrow(/Malformed/);
    for (const channel of [SHELL_CHANNELS.editorOpen, SHELL_CHANNELS.editorSave, SHELL_CHANNELS.filesDelete, SHELL_CHANNELS.filesList, SHELL_CHANNELS.layoutMove, SHELL_CHANNELS.quickOpen]) {
      await expect(call(channel, { projectKey: 'p', relativePath: 'a' }, foreign)).rejects.toThrow('Rejected');
    }
  });

  it('bounds lines, versions, text, selections, names, enums and pointers', async () => {
    await expect(call(SHELL_CHANNELS.editorOpen, { projectKey: 'p', relativePath: 3 })).rejects.toThrow(/Malformed/);
    await expect(call(SHELL_CHANNELS.editorOpen, 'src/a.ts')).rejects.toThrow(/Malformed/);
    await expect(call(SHELL_CHANNELS.editorOpen, { projectKey: 'p', relativePath: 'a', line: 0 })).rejects.toThrow(/Malformed/);
    await expect(call(SHELL_CHANNELS.editorOpen, { projectKey: 'p', relativePath: '../a', as: 'html' })).rejects.toThrow(/Malformed/);
    await expect(call(SHELL_CHANNELS.editorSave, { documentId: 'd', version: -1, text: '' })).rejects.toThrow(/Malformed/);
    await expect(call(SHELL_CHANNELS.editorSave, { documentId: 'd', version: 1.5, text: '' })).rejects.toThrow(/Malformed/);
    await expect(call(SHELL_CHANNELS.editorSave, { documentId: 'd', version: 1, text: 3 })).rejects.toThrow(/Malformed/);
    await expect(call(SHELL_CHANNELS.editorTab, { action: 'delete', tabId: 't' })).rejects.toThrow(/Malformed/);
    await expect(call(SHELL_CHANNELS.editorConflict, { documentId: 'd', action: 'discard' })).rejects.toThrow(/Malformed/);
    await expect(call(SHELL_CHANNELS.filesCreate, { projectKey: 'p', relativeDir: '', name: 'x'.repeat(256), kind: 'file' })).rejects.toThrow(/Malformed/);
    await expect(call(SHELL_CHANNELS.filesCreate, { projectKey: 'p', relativeDir: '', name: 'x', kind: 'link' })).rejects.toThrow(/Malformed/);
    await expect(call(SHELL_CHANNELS.layoutMove, { pane: 'browser', slot: 'main' })).rejects.toThrow(/Malformed/);
    await expect(call(SHELL_CHANNELS.toggleMaximize, { pane: 'sidebar' })).rejects.toThrow(/Malformed/);
    await expect(call(SHELL_CHANNELS.editorFocusOverlay, { open: 'yes' })).rejects.toThrow(/Malformed/);
    send(SHELL_CHANNELS.editorSelection, { documentId: 'd', selection: { startLine: 0, startColumn: 1, endLine: 1, endColumn: 1 } });
    send(SHELL_CHANNELS.editorEdit, { documentId: 'd', version: 1 });
    send(SHELL_CHANNELS.dropZonesPointer, { x: Number.NaN, y: 0, released: false });
    expect(editor['selection']).not.toHaveBeenCalled();
    expect(editor['edit']).not.toHaveBeenCalled();
    expect(actions.dropZonesPointer).not.toHaveBeenCalled();

    send(SHELL_CHANNELS.editorSelection, { documentId: 'd', selection: { startLine: 2, startColumn: 1, endLine: 1, endColumn: 4 } });
    send(SHELL_CHANNELS.editorSelection, { documentId: 'd', selection: null });
    send(SHELL_CHANNELS.dropZonesPointer, { x: 10, y: 20, released: true });
    await call(SHELL_CHANNELS.layoutMove, { pane: 'terminal', slot: 'side' });
    expect(editor['selection']).toHaveBeenCalledWith('d', { startLine: 2, startColumn: 1, endLine: 1, endColumn: 4 });
    expect(editor['selection']).toHaveBeenCalledWith('d', null);
    expect(actions.dropZonesPointer).toHaveBeenCalledWith({ x: 10, y: 20, released: true });
    expect(actions.layoutMove).toHaveBeenCalledWith('terminal', 'side');
  });

  it('takes a format request only from the window page, type-checked and bounded, as a clean copy', async () => {
    const request = { documentId: 'd', text: 'const a=1', options: { tabSize: 2, insertSpaces: true }, reason: 'save' };
    await expect(call(SHELL_CHANNELS.editorFormat, request, foreign)).rejects.toThrow('Rejected');
    for (const bad of [
      { ...request, documentId: '' },
      { ...request, documentId: 'x'.repeat(MAX_ID_LENGTH + 1) },
      { ...request, text: 3 },
      { ...request, text: 'x'.repeat(MAX_EDITOR_TEXT_CHARS + 1) },
      { ...request, reason: 'agent' },
      { ...request, options: { tabSize: 0, insertSpaces: true } },
      { ...request, options: { tabSize: 33, insertSpaces: true } },
      { ...request, options: { tabSize: 2.5, insertSpaces: true } },
      { ...request, options: { tabSize: 2, insertSpaces: 'yes' } },
      { ...request, options: null },
      { documentId: 'd', text: '', reason: 'save' },
    ]) await expect(call(SHELL_CHANNELS.editorFormat, bad)).rejects.toThrow('Malformed format request');
    expect(editor['format']).not.toHaveBeenCalled();
    await call(SHELL_CHANNELS.editorFormat, { ...request, path: 'C:\\evil.js', options: { ...request.options, prettier: 'x' } });
    expect(editor['format']).toHaveBeenCalledWith({ documentId: 'd', text: 'const a=1', options: { tabSize: 2, insertSpaces: true }, reason: 'save' });

    send(SHELL_CHANNELS.editorFormatFailed, { documentId: 'd', reason: 'save', timedOut: true, message: 'x' }, foreign);
    send(SHELL_CHANNELS.editorFormatFailed, { documentId: 'd', reason: 'save', timedOut: 'yes', message: 'x' });
    send(SHELL_CHANNELS.editorFormatFailed, { documentId: 'd', reason: 'save', timedOut: false, message: 'x'.repeat(MAX_FORMAT_ERROR_CHARS + 1) });
    expect(editor['formatFailed']).not.toHaveBeenCalled();
    send(SHELL_CHANNELS.editorFormatFailed, { documentId: 'd', reason: 'command', timedOut: false, message: 'worker died' });
    expect(editor['formatFailed']).toHaveBeenCalledWith({ documentId: 'd', reason: 'command', timedOut: false, message: 'worker died' });
    expect(lines).toContain('[shell] ignoring a malformed format failure');
  });

  it('has no channel through which the page could run cut, copy or paste itself', () => {
    expect([...ipc.handlers.keys(), ...ipc.listeners.keys()].filter((channel) => /clipboard/i.test(channel))).toEqual([]);
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

describe('terminal channels', () => {
  const contents = Object.assign(new EventEmitter(), {
    id: 1,
    mainFrame: { url: SHELL_PAGE_URL, parent: null },
    loadURL: vi.fn(async () => undefined),
    getZoomFactor: () => 1,
    isFocused: () => false,
    isDestroyed: () => false,
    isCrashed: () => false,
    send: vi.fn(),
    focus: vi.fn(),
    paste: vi.fn(),
  });
  const window = { webContents: contents, isDestroyed: () => false } as never;
  const own = { sender: contents, senderFrame: contents.mainFrame };
  const foreign = { sender: { id: 2 }, senderFrame: { url: 'app://damocles/webview/x', parent: null } };
  let terminal: Record<string, ReturnType<typeof vi.fn>>;
  let gestures: Record<string, ReturnType<typeof vi.fn>>;
  let openAppMenu: ReturnType<typeof vi.fn>;
  let showSidebar: ReturnType<typeof vi.fn>;
  let lines: string[];
  let shell: ShellHost;

  beforeEach(() => {
    ipc.handlers.clear();
    ipc.listeners.clear();
    contents.removeAllListeners();
    contents.send.mockClear();
    contents.paste.mockClear();
    lines = [];
    terminal = Object.fromEntries([
      'state', 'create', 'openNew', 'input', 'resize', 'ack', 'kill', 'restart', 'select', 'split', 'unsplit', 'resizePanes', 'setListWidth', 'shellLoaded', 'paste', 'setInputFocused', 'openLink', 'rename', 'pickIcon', 'pickColor', 'selectDefaultProfile',
    ].map((name) => [name, vi.fn(() => ({ ok: true, id: 'term-1' }))]));
    terminal['resolveLinks'] = vi.fn(async () => ['file']);
    terminal['has'] = vi.fn((id: string) => id === 'term-1');
    gestures = Object.fromEntries(['pasteKey', 'middleClick', 'contextMenu', 'blurred'].map((name) => [name, vi.fn()]));
    openAppMenu = vi.fn();
    showSidebar = vi.fn();
    const actions = { terminal, gestures, openAppMenu, showSidebar, state: vi.fn(() => ({ projects: [], selected: {} })), setFocusedPart: vi.fn(), editor: { setFocusOverlay: vi.fn() } } as unknown as ShellActions;
    shell = new ShellHost(window, actions, (line) => lines.push(line), () => undefined);
  });

  const send = (channel: string, payload: unknown, sender: unknown = own): void => ipc.listeners.get(channel)!(sender, payload);
  const call = (channel: string, payload?: unknown, sender: unknown = own): Promise<unknown> => Promise.resolve(ipc.handlers.get(channel)!(sender, payload));

  it.each([
    ['a cwd', { profileId: null, projectKey: 'p', cwd: 'C:\\Windows' }],
    ['a shell path', { profileId: 'C:\\evil.exe', projectKey: 'p', file: 'C:\\evil.exe' }],
    ['args', { profileId: 'pwsh', projectKey: 'p', args: ['-c', 'x'] }],
    ['an environment', { profileId: 'pwsh', projectKey: 'p', env: {} }],
    ['a missing field', { profileId: 'pwsh' }],
    ['a number', { profileId: 1, projectKey: 'p' }],
    ['an empty key', { profileId: 'pwsh', projectKey: '' }],
    ['an array', ['pwsh', 'p']],
  ])('refuses a create carrying %s before main sees it', async (_name, payload) => {
    expect(parseTerminalCreate(payload)).toBeUndefined();
    await expect(call(TERMINAL_CHANNELS.create, payload)).rejects.toThrow('Malformed terminal create');
    expect(terminal['create']).not.toHaveBeenCalled();
  });

  it('passes a create of a profile id and a project key, each possibly null, and nothing else', async () => {
    await expect(call(TERMINAL_CHANNELS.create, { profileId: null, projectKey: null })).resolves.toEqual({ ok: true, id: 'term-1' });
    await call(TERMINAL_CHANNELS.create, { profileId: 'wsl:Ubuntu', projectKey: 'c:\\work\\alpha' });
    expect(terminal['create']!.mock.calls).toEqual([[{ profileId: null, projectKey: null }], [{ profileId: 'wsl:Ubuntu', projectKey: 'c:\\work\\alpha' }]]);
  });

  it('bounds input, resize, ack, ids and the list width, dropping and logging a malformed payload', () => {
    send(TERMINAL_CHANNELS.input, { id: 'term-1', data: 'x'.repeat(MAX_TERMINAL_INPUT_CHARS + 1) });
    send(TERMINAL_CHANNELS.input, { id: '../term-1', data: 'ls' });
    send(TERMINAL_CHANNELS.input, { id: 'term-1', data: 'ls', extra: true });
    send(TERMINAL_CHANNELS.resize, { id: 'term-1', cols: 0, rows: 10 });
    send(TERMINAL_CHANNELS.resize, { id: 'term-1', cols: 80.5, rows: 10 });
    send(TERMINAL_CHANNELS.resize, { id: 'term-1', cols: 2001, rows: 10 });
    send(TERMINAL_CHANNELS.ack, { id: 'term-1', chars: 0 });
    send(TERMINAL_CHANNELS.ack, { id: 'term-1', chars: 1_000_001 });
    send(TERMINAL_CHANNELS.kill, { id: 'term-0' });
    send(TERMINAL_CHANNELS.listWidth, { rem: Number.NaN });
    for (const name of ['input', 'resize', 'ack', 'kill', 'setListWidth']) expect(terminal[name], name).not.toHaveBeenCalled();
    expect(lines).toContain(`[shell] ignoring a malformed ${TERMINAL_CHANNELS.input}`);
    expect(lines.filter((line) => line.includes(TERMINAL_CHANNELS.input))).toHaveLength(1);

    send(TERMINAL_CHANNELS.input, { id: 'term-1', data: 'x'.repeat(MAX_TERMINAL_INPUT_CHARS) });
    send(TERMINAL_CHANNELS.resize, { id: 'term-1', cols: 2000, rows: 1000 });
    send(TERMINAL_CHANNELS.ack, { id: 'term-1', chars: 5000 });
    send(TERMINAL_CHANNELS.listWidth, { rem: 99 });
    send(TERMINAL_CHANNELS.restart, { id: 'term-1' });
    send(TERMINAL_CHANNELS.select, { id: 'term-1' });
    send(TERMINAL_CHANNELS.kill, { id: 'term-1' });
    expect(terminal['input']).toHaveBeenCalledWith('term-1', 'x'.repeat(MAX_TERMINAL_INPUT_CHARS));
    expect(terminal['resize']).toHaveBeenCalledWith('term-1', 2000, 1000);
    expect(terminal['ack']).toHaveBeenCalledWith('term-1', 5000);
    expect(terminal['setListWidth']).toHaveBeenCalledWith(99);
    for (const name of ['restart', 'select', 'kill']) expect(terminal[name], name).toHaveBeenCalledWith('term-1');
  });

  it('refuses every terminal channel from another sender', async () => {
    for (const channel of [TERMINAL_CHANNELS.input, TERMINAL_CHANNELS.kill, TERMINAL_CHANNELS.new, TERMINAL_CHANNELS.paste, TERMINAL_CHANNELS.ack]) send(channel, { id: 'term-1', data: 'x', chars: 1 }, foreign);
    await expect(call(TERMINAL_CHANNELS.create, { profileId: null, projectKey: null }, foreign)).rejects.toThrow('Rejected');
    await expect(call(TERMINAL_CHANNELS.getState, undefined, foreign)).rejects.toThrow('Rejected');
    for (const name of ['input', 'kill', 'openNew', 'ack', 'create', 'state', 'paste']) expect(terminal[name], name).not.toHaveBeenCalled();
  });

  it('hands a well-formed paste to main, which reads the clipboard itself; the page never sends or gets its text', () => {
    for (const payload of [
      { id: 'term-1' },
      { id: 'term-1', bracketedPasteMode: false, source: 'clipboard', text: 'x' },
      { id: 'term-1', bracketedPasteMode: 'yes', source: 'clipboard' },
      { id: 'term-1', bracketedPasteMode: true, source: 'primary' },
      { id: '../term-1', bracketedPasteMode: true, source: 'clipboard' },
    ]) send(TERMINAL_CHANNELS.paste, payload);
    expect(terminal['paste']).not.toHaveBeenCalled();
    send(TERMINAL_CHANNELS.paste, { id: 'term-1', bracketedPasteMode: true, source: 'selection' });
    expect(terminal['paste']).toHaveBeenCalledWith({ id: 'term-1', bracketedPasteMode: true, source: 'selection' });
    send(TERMINAL_CHANNELS.paste, { id: 'term-1', bracketedPasteMode: false, source: 'clipboard' }, foreign);
    expect(terminal['paste']).toHaveBeenCalledOnce();
    expect(contents.paste).not.toHaveBeenCalled();
  });

  it('takes only a boolean input focus from the window page, and forgets it when the page loads or its renderer goes', () => {
    send(TERMINAL_CHANNELS.inputFocus, { focused: true }, foreign);
    send(TERMINAL_CHANNELS.inputFocus, { focused: 'yes' });
    send(TERMINAL_CHANNELS.inputFocus, { focused: true, id: 'term-1' });
    expect(terminal['setInputFocused']).not.toHaveBeenCalled();
    send(TERMINAL_CHANNELS.inputFocus, { focused: true });
    expect(terminal['setInputFocused']).toHaveBeenLastCalledWith(true);
    contents.emit('did-finish-load');
    expect(terminal['setInputFocused']).toHaveBeenLastCalledWith(false);
    send(TERMINAL_CHANNELS.inputFocus, { focused: true });
    contents.emit('render-process-gone', {}, { reason: 'clean-exit' });
    expect(terminal['setInputFocused']).toHaveBeenLastCalledWith(false);
  });

  describe('user input main observes in its page', () => {
    const platform = process.platform;
    const onPlatform = (value: NodeJS.Platform): void => {
      Object.defineProperty(process, 'platform', { value, configurable: true });
    };
    const key = (code: string, modifiers: { control?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}, type = 'keyDown', isComposing = false) => ({
      type, code, key: '', isAutoRepeat: false, isComposing, control: false, shift: false, alt: false, meta: false, location: 0, modifiers: [], ...modifiers,
    });
    const press = (input: ReturnType<typeof key>): void => {
      contents.emit('before-input-event', { preventDefault: vi.fn() }, input);
    };
    const mouse = (button: 'left' | 'middle' | 'right', type = 'mouseDown', modifiers: string[] = []): void => {
      contents.emit('before-mouse-event', { preventDefault: vi.fn() }, { type, button, x: 1, y: 1, modifiers });
    };
    const restore = (): void => onPlatform(platform);

    // terminal-essentials.test.ts holds the shell's key handler to the same predicate over the same chords.
    it.each(PASTE_CHORD_CASES)('on %s, V with control %s, shift %s, alt %s, meta %s is a paste key: %s', (os, control, shift, alt, meta, pastes) => {
      expect(isTerminalPasteChord({ code: 'KeyV', ctrl: control, shift, alt, meta }, os)).toBe(pastes);
      onPlatform(os);
      try {
        press(key('KeyV', { control, shift, alt, meta }));
        expect(gestures['pasteKey']).toHaveBeenCalledTimes(pastes ? 1 : 0);
      } finally {
        restore();
      }
    });

    it('ignores a key release, a composing key and another key, and takes an auto-repeated chord', () => {
      onPlatform('win32');
      try {
        press(key('KeyV', { control: true }, 'keyUp'));
        press(key('KeyV', { control: true }, 'keyDown', true));
        press(key('KeyC', { control: true }));
        expect(gestures['pasteKey']).not.toHaveBeenCalled();
        press({ ...key('KeyV', { control: true }), isAutoRepeat: true });
        expect(gestures['pasteKey']).toHaveBeenCalledOnce();
      } finally {
        restore();
      }
    });

    it('takes the context menu key, Shift+F10, a right press and on macOS a Control+click as a context-menu gesture', () => {
      onPlatform('win32');
      try {
        press(key('F10'));
        press(key('F10', { shift: true, control: true }));
        press(key('ContextMenu', {}, 'keyUp'));
        mouse('right', 'mouseUp');
        mouse('left', 'mouseDown', ['control']);
        expect(gestures['contextMenu']).not.toHaveBeenCalled();
        press(key('ContextMenu'));
        press(key('F10', { shift: true }));
        mouse('right');
        expect(gestures['contextMenu']).toHaveBeenCalledTimes(3);
        onPlatform('darwin');
        mouse('left', 'mouseDown', ['control']);
        expect(gestures['contextMenu']).toHaveBeenCalledTimes(4);
      } finally {
        restore();
      }
    });

    it('takes a middle press as a selection paste gesture only on Linux, and reports the page losing focus', () => {
      onPlatform('win32');
      try {
        mouse('middle');
        expect(gestures['middleClick']).not.toHaveBeenCalled();
        onPlatform('linux');
        mouse('middle', 'mouseUp');
        mouse('left');
        expect(gestures['middleClick']).not.toHaveBeenCalled();
        mouse('middle');
        expect(gestures['middleClick']).toHaveBeenCalledOnce();
      } finally {
        restore();
      }
      contents.emit('blur');
      expect(gestures['blurred']).toHaveBeenCalledOnce();
    });

    it('opens the application menu once per click or activation key it saw, never on the page\'s own call', async () => {
      const openMenu = (): Promise<unknown> => call(SHELL_CHANNELS.appMenu, { x: 4, y: 8 });
      await openMenu();
      press(key('Enter', {}, 'keyUp'));
      press(key('Space'));
      press(key('Enter', { control: true }));
      press(key('Enter', {}, 'keyDown', true));
      mouse('left');
      mouse('right', 'mouseUp');
      await openMenu();
      expect(openAppMenu).not.toHaveBeenCalled();
      expect(lines).toContain('[shell] not opening the application menu: no click or key of the user asked for it');

      mouse('left', 'mouseUp');
      await openMenu();
      await openMenu();
      expect(openAppMenu).toHaveBeenCalledOnce();
      expect(openAppMenu).toHaveBeenCalledWith({ x: 4, y: 8 });
      press(key('Enter'));
      await openMenu();
      press(key('NumpadEnter'));
      await openMenu();
      press(key('Space', {}, 'keyUp'));
      await openMenu();
      expect(openAppMenu).toHaveBeenCalledTimes(4);

      onPlatform('darwin');
      try {
        mouse('left', 'mouseUp', ['control']);
        await openMenu();
        expect(openAppMenu).toHaveBeenCalledTimes(4);
      } finally {
        restore();
      }
      mouse('left', 'mouseUp');
      contents.emit('blur');
      await openMenu();
      expect(openAppMenu).toHaveBeenCalledTimes(4);
    });
  });

  it('resolves only bounded link paths of a terminal id, and refuses anything else', async () => {
    await expect(call(TERMINAL_CHANNELS.resolveLinks, { id: 'term-1', paths: ['src/app.ts'] })).resolves.toEqual(['file']);
    expect(terminal['resolveLinks']).toHaveBeenCalledWith({ id: 'term-1', paths: ['src/app.ts'] });
    for (const payload of [
      { id: 'term-1', paths: [] },
      { id: 'term-1', paths: Array.from({ length: MAX_TERMINAL_LINK_PATHS + 1 }, () => 'a') },
      { id: 'term-1', paths: ['a'.repeat(MAX_TERMINAL_LINK_PATH_LENGTH + 1)] },
      { id: 'term-1', paths: [''] },
      { id: 'term-1', paths: ['a\u0000b'] },
      { id: 'term-1', paths: [7] },
      { id: 'term-1', paths: 'src/app.ts' },
      { id: 'term-1', paths: ['a'], projectKey: 'c:\\' },
      { id: 'nope', paths: ['a'] },
    ]) await expect(call(TERMINAL_CHANNELS.resolveLinks, payload), JSON.stringify(payload).slice(0, 80)).rejects.toThrow('Malformed terminal link resolution');
    await expect(call(TERMINAL_CHANNELS.resolveLinks, { id: 'term-1', paths: ['a'] }, foreign)).rejects.toThrow('Rejected');
    expect(terminal['resolveLinks']).toHaveBeenCalledOnce();
  });

  it('opens a link only with an integer line and column in range, or none', () => {
    send(TERMINAL_CHANNELS.openLink, { id: 'term-1', path: 'src/app.ts', line: 42, column: 7 });
    send(TERMINAL_CHANNELS.openLink, { id: 'term-1', path: 'src', line: null, column: null });
    for (const payload of [
      { id: 'term-1', path: 'src/app.ts', line: 0, column: null },
      { id: 'term-1', path: 'src/app.ts', line: 1.5, column: null },
      { id: 'term-1', path: 'src/app.ts', line: MAX_TERMINAL_LINK_POSITION + 1, column: null },
      { id: 'term-1', path: 'src/app.ts', line: 1, column: -1 },
      { id: 'term-1', path: 'src/app.ts', line: 1 },
      { id: 'term-1', path: '', line: null, column: null },
      { id: 'term-1', path: 'a'.repeat(MAX_TERMINAL_LINK_PATH_LENGTH + 1), line: null, column: null },
    ]) send(TERMINAL_CHANNELS.openLink, payload);
    expect(terminal['openLink']!.mock.calls).toEqual([
      [{ id: 'term-1', path: 'src/app.ts', line: 42, column: 7 }],
      [{ id: 'term-1', path: 'src', line: null, column: null }],
    ]);
  });

  it('splits and unsplits by terminal id only, and passes pane sizes only as a group id with finite numbers', () => {
    send(TERMINAL_CHANNELS.split, { id: 'term-1' });
    send(TERMINAL_CHANNELS.split, { id: 'term-1', cwd: 'C:\\' });
    send(TERMINAL_CHANNELS.split, { id: 'term-1', profileId: 'cmd' });
    send(TERMINAL_CHANNELS.split, { id: '../term-1' });
    send(TERMINAL_CHANNELS.unsplit, { id: 'term-2' });
    send(TERMINAL_CHANNELS.unsplit, 'term-2');
    expect(terminal['split']!.mock.calls).toEqual([['term-1']]);
    expect(terminal['unsplit']!.mock.calls).toEqual([['term-2']]);
    send(TERMINAL_CHANNELS.resizePanes, { groupId: 'group-1', sizes: [0.25, 0.75] });
    send(TERMINAL_CHANNELS.resizePanes, { groupId: 'group-10', sizes: [1] });
    for (const payload of [
      { groupId: 'group-0', sizes: [1] },
      { groupId: 'group-01', sizes: [1] },
      { groupId: 'group-1', sizes: [0.5, Number.POSITIVE_INFINITY] },
      { groupId: 'group-1', sizes: ['0.5', 0.5] },
      { groupId: 'group-1', sizes: Array.from({ length: MAX_TERMINAL_GROUP_PANES + 1 }, () => 1 / (MAX_TERMINAL_GROUP_PANES + 1)) },
      { groupId: 'group-1', sizes: [] },
      { groupId: 'term-1', sizes: [1] },
      { groupId: 'group-1x', sizes: [1] },
      { groupId: 'group-1', sizes: [1], paneIds: ['term-1'] },
      { groupId: 'group-1', sizes: { 0: 1, length: 1 } },
    ]) send(TERMINAL_CHANNELS.resizePanes, payload);
    expect(terminal['resizePanes']!.mock.calls).toEqual([['group-1', [0.25, 0.75]], ['group-10', [1]]]);
    expect(lines.filter((line) => line.includes(TERMINAL_CHANNELS.resizePanes))).toHaveLength(1);
  });

  it('renames with a trimmed, bounded name without control or bidi characters, and opens the pickers by id', () => {
    send(TERMINAL_CHANNELS.rename, { id: 'term-1', name: '  build  ' });
    send(TERMINAL_CHANNELS.rename, { id: 'term-1', name: '' });
    for (const name of ['x'.repeat(MAX_TERMINAL_NAME_LENGTH + 1), 'a\nb', 'evil\u202Etxt', 5]) send(TERMINAL_CHANNELS.rename, { id: 'term-1', name });
    send(TERMINAL_CHANNELS.rename, { id: 'term-1', name: 'x', color: 'red' });
    expect(terminal['rename']!.mock.calls).toEqual([['term-1', 'build'], ['term-1', null]]);
    send(TERMINAL_CHANNELS.pickIcon, { id: 'term-1' });
    send(TERMINAL_CHANNELS.pickColor, { id: 'term-1' });
    send(TERMINAL_CHANNELS.pickColor, { id: 'term-1', color: 'red' });
    send(TERMINAL_CHANNELS.selectDefaultProfile, undefined);
    expect(terminal['pickIcon']).toHaveBeenCalledWith('term-1');
    expect(terminal['pickColor']).toHaveBeenCalledOnce();
    expect(terminal['selectDefaultProfile']).toHaveBeenCalledOnce();
  });

  it('passes Add to Chat only as a selection without a command id or a command with one, its text within the cap', () => {
    terminal['addToChat'] = vi.fn();
    const ok = { id: 'term-1', source: 'command', commandId: 3, text: 'FAIL\nsrc/a.test.ts', omittedLines: 12 };
    send(TERMINAL_CHANNELS.addToChat, ok);
    send(TERMINAL_CHANNELS.addToChat, { ...ok, source: 'selection', commandId: null, omittedLines: 0 });
    for (const payload of [
      { ...ok, commandId: null },
      { ...ok, source: 'selection' },
      { ...ok, source: 'file' },
      { ...ok, commandId: 0 },
      { ...ok, commandId: 1.5 },
      { ...ok, text: 'x'.repeat(MAX_TERMINAL_ATTACHMENT_CHARS + 1) },
      { ...ok, omittedLines: -1 },
      { ...ok, omittedLines: MAX_TERMINAL_ATTACHMENT_OMITTED_LINES + 1 },
      { ...ok, id: 'term-x' },
      { ...ok, label: 'Terminal: rm -rf' },
    ]) send(TERMINAL_CHANNELS.addToChat, payload);
    send(TERMINAL_CHANNELS.addToChat, ok, foreign);
    expect(terminal['addToChat']!.mock.calls).toEqual([[ok], [{ ...ok, source: 'selection', commandId: null, omittedLines: 0 }]]);
  });

  it('sends a palette buffer command to its own page after focusing it', () => {
    contents.emit('did-finish-load');
    contents.focus.mockClear();
    contents.send.mockClear();
    shell.runTerminalAction('term-1', 'copyLastCommandOutput');
    expect(contents.focus).toHaveBeenCalledOnce();
    expect(contents.send.mock.calls.at(-1)).toEqual([TERMINAL_CHANNELS.runAction, { id: 'term-1', action: 'copyLastCommandOutput' }]);
  });

  it('focuses its own page before it starts a rename or reveals a folder, and asks for a paste without focusing', () => {
    contents.emit('did-finish-load');
    contents.focus.mockClear();
    shell.startTerminalRename('term-1');
    expect(contents.focus).toHaveBeenCalledOnce();
    expect(contents.send).toHaveBeenLastCalledWith(TERMINAL_CHANNELS.startRename, { id: 'term-1' });
    contents.send.mockClear();
    shell.revealInFiles({ projectKey: 'p', relativePath: 'src' });
    // A hidden sidebar shows first, and the state saying so reaches the shell before the reveal.
    expect(showSidebar).toHaveBeenCalledOnce();
    expect(showSidebar.mock.invocationCallOrder[0]).toBeLessThan(contents.send.mock.invocationCallOrder[0]!);
    expect(contents.send.mock.calls.map(([channel]) => channel)).toEqual([SHELL_CHANNELS.state, TERMINAL_CHANNELS.revealInFiles]);
    expect(contents.send).toHaveBeenLastCalledWith(TERMINAL_CHANNELS.revealInFiles, { projectKey: 'p', relativePath: 'src' });
    contents.focus.mockClear();
    shell.requestTerminalPaste('term-1');
    expect(contents.focus).not.toHaveBeenCalled();
    expect(contents.send).toHaveBeenLastCalledWith(TERMINAL_CHANNELS.requestPaste, { id: 'term-1' });
  });

  it('asks for the terminal state on each page load, and sends the shell state before a focus', () => {
    contents.emit('did-finish-load');
    expect(terminal['shellLoaded']).toHaveBeenCalledOnce();
    contents.send.mockClear();
    shell.focusTerminal('term-1');
    expect(contents.send.mock.calls.map(([channel]) => channel)).toEqual([SHELL_CHANNELS.state, TERMINAL_CHANNELS.focus]);
    expect(contents.send).toHaveBeenLastCalledWith(TERMINAL_CHANNELS.focus, { id: 'term-1' });
  });
});
