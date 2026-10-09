import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ webContentsOptions: [] as unknown[] }));

vi.mock('electron', async () => (await import('./fake-views-electron')).fakeViewsElectron(H.webContentsOptions));

import type { PanelOptions } from '../../../platform/window-service';
import { PANEL_CHANNELS } from '../../preload/panel-channels';
import type { PanelStateStore } from '../panel-state-store';
import { PanelViews, type DesktopPanel, type PagesHost } from '../views';
import { contentsOf, fakeStates, fakeWindow, viewOf } from './fake-views-electron';

const CHAT: PanelOptions = { kind: 'chat', title: 'Damocles', localResourceRoots: [] };

function pageOptions(owner: unknown): PanelOptions {
  return { kind: 'browser', title: 'page', localResourceRoots: [], owner: owner as DesktopPanel };
}

let states: PanelStateStore;
let gaveUp: DesktopPanel[];
let lines: string[];
let window: ReturnType<typeof fakeWindow>;
let restacks: number;
let revealed: DesktopPanel[];
let savedSessionChanges: DesktopPanel[];
let pageEvents: string[];
let popupOpen: boolean;

// What PanelViews tells the browser tabs, in order; browser-tabs.test.ts covers what they do with it.
const pages: PagesHost = {
  pageAdded: (page) => pageEvents.push(`added:${page.panelId}`),
  pageRemoved: (page) => pageEvents.push(`removed:${page.panelId}`),
  pageChanged: (page) => pageEvents.push(`changed:${page.panelId}`),
  pageRevealed: (page) => pageEvents.push(`revealed:${page.panelId}`),
  chatSelected: (chat) => pageEvents.push(`selected:${chat?.panelId ?? 'none'}`),
  chatClosed: (chat) => pageEvents.push(`closed:${chat.panelId}`),
};

function views(width = 1200): PanelViews {
  window = fakeWindow(width);
  return new PanelViews({
    window: window as never,
    preloadPath: 'preload-panel.js',
    states,
    pages,
    log: (line) => lines.push(line),
    onChange: () => undefined,
    onRestack: () => {
      restacks++;
    },
    onReveal: (chat) => revealed.push(chat),
    onRendererGaveUp: (panel) => gaveUp.push(panel),
    onSavedSessionChange: (chat) => savedSessionChanges.push(chat),
    popupOpen: () => popupOpen,
  }, (p) => p);
}

// A chat as the owner opens one: created hidden, then selected and focused.
function open(tabs: PanelViews, restore?: { panelId: string; state: unknown }): DesktopPanel {
  const chat = tabs.create({ options: CHAT, ...(restore ? { restore } : {}) });
  tabs.show(chat.panelId, { focus: true });
  return chat;
}

beforeEach(() => {
  states = fakeStates();
  gaveUp = [];
  lines = [];
  restacks = 0;
  revealed = [];
  savedSessionChanges = [];
  pageEvents = [];
  popupOpen = false;
  H.webContentsOptions.length = 0;
});

describe('PanelViews teardown', () => {
  it('keeps every persisted chat while states are retained and focuses nothing', () => {
    const tabs = views();
    const [home, alpha, beta, fork] = ['home', 'alpha', 'beta', 'fork'].map((panelId) => tabs.create({ options: CHAT, restore: { panelId, state: null } }));
    tabs.show(beta!.panelId, { focus: true });
    const forkFocus = contentsOf(fork!).focus.mock.calls.length;
    tabs.retainStatesOnClose(true);
    expect(tabs.retainingStates).toBe(true);

    for (const panel of [home!, beta!, alpha!, fork!]) panel.close();

    expect(states.list().map((p) => p.panelId)).toEqual(['home', 'alpha', 'beta', 'fork']);
    expect(contentsOf(fork!).focus.mock.calls.length).toBe(forkFocus);
  });

  it('clears the selection when the selected chat closes and selects no other chat itself', () => {
    const tabs = views();
    const [, beta, fork] = ['alpha', 'beta', 'fork'].map((panelId) => tabs.create({ options: CHAT, restore: { panelId, state: null } }));
    tabs.show(beta!.panelId, { focus: true });
    beta!.close();
    expect(tabs.selected()).toBeUndefined();
    expect(fork!.visible).toBe(false);
    expect(states.get('beta')).toBeUndefined();
    expect(pageEvents.at(-1)).toBe('closed:beta');
  });

  it('opens no chat and no page while the chats close with their states kept', () => {
    const tabs = views();
    const chat = open(tabs);
    tabs.retainStatesOnClose(true);
    const before = states.list().map((saved) => saved.panelId);

    expect(() => tabs.create({ options: CHAT })).toThrow('closing');
    expect(() => tabs.create({ options: pageOptions(chat) })).toThrow('closing');

    expect(tabs.chats()).toEqual([chat]);
    expect(states.list().map((saved) => saved.panelId)).toEqual(before);
    expect(pageEvents.filter((event) => event.startsWith('added:'))).toEqual([]);
  });

  it('refuses to open a panel id that is already open', () => {
    const tabs = views();
    tabs.create({ options: CHAT, restore: { panelId: 'alpha', state: null } });
    expect(() => tabs.create({ options: CHAT, restore: { panelId: 'alpha', state: null } })).toThrow('already open');
  });
});

describe('PanelViews chats', () => {
  it('creates a chat hidden and unselected, and selects and focuses it only when shown', () => {
    const tabs = views();
    const first = open(tabs);
    const created = tabs.create({ options: CHAT, restore: { panelId: 'saved', state: { sessionId: 's' } } });
    created.setHtml('<html></html>');
    expect(tabs.selected()).toBe(first);
    expect(created.visible).toBe(false);
    expect(contentsOf(created).focus).not.toHaveBeenCalled();
    expect(tabs.chats()).toEqual([first, created]);
    tabs.show(created.panelId, { focus: true });
    expect(tabs.selected()).toBe(created);
    expect(created.visible).toBe(true);
    expect(first.visible).toBe(false);
    expect(contentsOf(created).focus).toHaveBeenCalled();
    expect(pageEvents).toEqual([`selected:${first.panelId}`, 'selected:saved']);
  });

  // A renderer drops focus it is given before its page commits, and a chat never takes focus when it navigates.
  it('focuses a chat shown before its page committed once it commits, unless focus went elsewhere first', () => {
    const tabs = views();
    const first = open(tabs);
    first.setHtml('<html></html>');
    const created = tabs.create({ options: CHAT });
    tabs.show(created.panelId, { focus: true });
    expect(contentsOf(created).focus).not.toHaveBeenCalled();
    created.setHtml('<html></html>');
    expect(contentsOf(created).focus).toHaveBeenCalledTimes(1);

    const unfocused = tabs.create({ options: CHAT });
    tabs.show(unfocused.panelId, { focus: true });
    tabs.focused(contentsOf(first));
    unfocused.setHtml('<html></html>');
    expect(contentsOf(unfocused).focus).not.toHaveBeenCalled();

    const replaced = tabs.create({ options: CHAT });
    tabs.show(replaced.panelId, { focus: true });
    tabs.show(first.panelId, { focus: true });
    replaced.setHtml('<html></html>');
    expect(contentsOf(replaced).focus).not.toHaveBeenCalled();
    expect(tabs.selected()).toBe(first);
  });

  // The window's activation focuses the window's own page, so only the user's input or main's own focus drops a launch's.
  it('focuses a chat a launch shows once, when its page is ready in a focused window, whatever focus did meanwhile', () => {
    const tabs = views();
    const other = open(tabs);
    const chat = tabs.create({ options: CHAT });
    tabs.show(chat.panelId, { focus: 'whenReady' });
    tabs.focused(contentsOf(other));
    expect(contentsOf(chat).focus).not.toHaveBeenCalled();
    chat.setHtml('<html></html>');
    expect(contentsOf(chat).focus).toHaveBeenCalledTimes(1);

    window.emit('focus');
    contentsOf(chat).emit('dom-ready');
    expect(contentsOf(chat).focus).toHaveBeenCalledTimes(1);
  });

  it("holds a launch's focus until the window is focused", () => {
    const tabs = views();
    window.isFocused = () => false;
    const chat = tabs.create({ options: CHAT });
    tabs.show(chat.panelId, { focus: 'whenReady' });
    chat.setHtml('<html></html>');
    expect(contentsOf(chat).focus).not.toHaveBeenCalled();

    window.isFocused = () => true;
    window.emit('focus');
    expect(contentsOf(chat).focus).toHaveBeenCalledTimes(1);
  });

  // webContents.focus() activates, and so restores, its window on Linux.
  it("holds a launch's focus while the window is minimized, until it is restored and focused", () => {
    const tabs = views();
    window.isMinimized = () => true;
    const chat = tabs.create({ options: CHAT });
    tabs.show(chat.panelId, { focus: 'whenReady' });
    chat.setHtml('<html></html>');
    window.emit('focus');
    expect(contentsOf(chat).focus).not.toHaveBeenCalled();

    window.isMinimized = () => false;
    window.emit('restore');
    expect(contentsOf(chat).focus).toHaveBeenCalledTimes(1);
  });

  it("drops a launch's focus on the user's first key or click, before the page is ready or the window focused", () => {
    const tabs = views();
    const chat = tabs.create({ options: CHAT });
    tabs.show(chat.panelId, { focus: 'whenReady' });
    tabs.userInput();
    chat.setHtml('<html></html>');
    expect(contentsOf(chat).focus).not.toHaveBeenCalled();

    window.isFocused = () => false;
    const reopened = tabs.create({ options: CHAT });
    tabs.show(reopened.panelId, { focus: 'whenReady' });
    reopened.setHtml('<html></html>');
    tabs.userInput();
    window.isFocused = () => true;
    window.emit('focus');
    expect(contentsOf(reopened).focus).not.toHaveBeenCalled();
  });

  it("drops a launch's focus for another selection, a popup holding focus, or a focus main gives, which takes focus once", () => {
    const tabs = views();
    const chat = tabs.create({ options: CHAT });
    tabs.show(chat.panelId, { focus: 'whenReady' });
    const other = tabs.create({ options: CHAT });
    tabs.show(other.panelId, { focus: false });
    tabs.show(chat.panelId, { focus: false });
    chat.setHtml('<html></html>');
    expect(contentsOf(chat).focus).not.toHaveBeenCalled();

    popupOpen = true;
    tabs.show(other.panelId, { focus: 'whenReady' });
    other.setHtml('<html></html>');
    popupOpen = false;
    window.emit('focus');
    expect(contentsOf(other).focus).not.toHaveBeenCalled();

    const asked = tabs.create({ options: CHAT });
    tabs.show(asked.panelId, { focus: 'whenReady' });
    tabs.focusChat();
    asked.setHtml('<html></html>');
    window.emit('focus');
    expect(contentsOf(asked).focus).toHaveBeenCalledTimes(1);
  });

  it('places the selected chat on the chat slot the shell reports, and hides it under the focus overlay or in an empty slot', () => {
    const tabs = views(1200);
    const chat = open(tabs);
    tabs.setContentBounds({ x: 264, y: 40, width: 936, height: 760 });
    expect(viewOf(chat).bounds).toEqual({ x: 264, y: 40, width: 936, height: 760 });
    tabs.setFocusOverlay(true);
    expect(chat.visible).toBe(false);
    tabs.setFocusOverlay(false);
    expect(chat.visible).toBe(true);
    tabs.setContentBounds({ x: 264, y: 40, width: 0, height: 760 });
    expect(chat.visible).toBe(false);
  });

  it('asks the owner to restack the overlay after every view it adds', () => {
    const tabs = views();
    const chat = tabs.create({ options: CHAT, restore: { panelId: 'chat', state: null } });
    expect(restacks).toBe(1);
    tabs.show(chat.panelId, { focus: false });
    tabs.create({ options: pageOptions(chat) });
    expect(restacks).toBe(2);
  });

  it('hands a chat core reveals to the owner, which selects it', () => {
    const tabs = views();
    const first = open(tabs);
    const second = open(tabs);
    first.reveal();
    expect(revealed).toEqual([first]);
    expect(tabs.selected()).toBe(second);
  });
});

describe('panel IPC', () => {
  it('carries no panel id to the renderer and listens only on the view\'s own webContents.ipc', async () => {
    const tabs = views();
    const panel = open(tabs);
    expect(H.webContentsOptions.every((options) => !Object.hasOwn(options as object, 'additionalArguments'))).toBe(true);
    panel.setHtml('<html></html>');
    await Promise.resolve();
    const contents = contentsOf(panel);
    const received = vi.fn();
    panel.onMessage(received);

    contents.ipc.emit(PANEL_CHANNELS.post, { sender: contents, senderFrame: contents.mainFrame }, { type: 'ready' });
    expect(received).toHaveBeenCalledWith({ type: 'ready' });

    const other = contentsOf(tabs.create({ options: CHAT }));
    contents.ipc.emit(PANEL_CHANNELS.post, { sender: other, senderFrame: contents.mainFrame }, { type: 'injected' });
    contents.ipc.emit(PANEL_CHANNELS.post, { sender: contents, senderFrame: { url: contents.mainFrame.url, parent: {} } }, { type: 'from a subframe' });
    const init = { sender: contents, senderFrame: { url: 'app://damocles/panel/other/index.html', parent: null }, returnValue: undefined as unknown };
    contents.ipc.emit(PANEL_CHANNELS.init, init);
    expect(received).toHaveBeenCalledTimes(1);
    expect(init.returnValue).toBeNull();
    expect(lines.filter((line) => line.includes(`panel ${panel.panelId}: rejected ${PANEL_CHANNELS.post}`))).toHaveLength(2);

    panel.close();
    expect(contents.ipc.listenerCount(PANEL_CHANNELS.post)).toBe(0);
  });

  it('reads the saved session from the restore state, then from each webview state, and reports only a change of it', () => {
    const tabs = views();
    const chat = tabs.create({ options: CHAT, restore: { panelId: 'saved', state: { sessionId: 's1', workspaceFolderKey: 'k' } } });
    expect(chat.savedSessionId).toBe('s1');
    const contents = contentsOf(chat);
    const setState = (state: unknown): void => {
      contents.ipc.emit(PANEL_CHANNELS.setState, { sender: contents, senderFrame: { url: chat.pageUrl, parent: null } }, state);
    };

    setState({ sessionId: 's1', workspaceFolderKey: 'other' });
    expect(savedSessionChanges).toEqual([]);
    setState({ workspaceFolderKey: 'other' });
    expect(chat.savedSessionId).toBeUndefined();
    expect(savedSessionChanges).toEqual([chat]);
    setState({ sessionId: 's2' });
    expect(chat.savedSessionId).toBe('s2');
    expect(states.get('saved')?.state).toEqual({ sessionId: 's2' });
    expect(savedSessionChanges).toEqual([chat, chat]);
    setState({ sessionId: 42 });
    expect(chat.savedSessionId).toBeUndefined();
    expect(savedSessionChanges).toHaveLength(3);
  });
});

describe('renderer crashes', () => {
  it('reloads a crashed chat until the crash limit, then reports it once and can be restarted', async () => {
    const tabs = views();
    const panel = open(tabs);
    panel.setHtml('<html></html>');
    const contents = contentsOf(panel);
    const crash = (): void => {
      contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    };

    for (let i = 0; i < 3; i++) crash();
    expect(contents.loadURL).toHaveBeenCalledTimes(4);
    expect(gaveUp).toEqual([]);

    crash();
    expect(contents.loadURL).toHaveBeenCalledTimes(4);
    expect(gaveUp).toEqual([panel]);

    panel.restart();
    expect(contents.loadURL).toHaveBeenCalledTimes(5);
  });
});

describe('browser pages of a chat', () => {
  it('opens a page only in a loaded chat', () => {
    const tabs = views();
    const chat = open(tabs);
    expect(() => tabs.create({ options: pageOptions(undefined) })).toThrow('in a loaded chat');
    expect(() => tabs.create({ options: pageOptions({ panelId: chat.panelId }) })).toThrow('in a loaded chat');
    const page = tabs.create({ options: pageOptions(chat) });
    expect(() => tabs.create({ options: pageOptions(page) })).toThrow('in a loaded chat');
    chat.close();
    expect(() => tabs.create({ options: pageOptions(chat) })).toThrow('in a loaded chat');
  });

  it('creates a page hidden, as a view that never takes focus when it navigates, as no chat does, and never moves focus or the selected chat', () => {
    const tabs = views();
    const chat = open(tabs);
    const focusBefore = contentsOf(chat).focus.mock.calls.length;
    const page = tabs.create({ options: pageOptions(chat) });

    expect(page.visible).toBe(false);
    expect(contentsOf(page).focus).not.toHaveBeenCalled();
    expect(contentsOf(chat).focus.mock.calls.length).toBe(focusBefore);
    expect(tabs.selected()).toBe(chat);
    expect(tabs.chats()).toEqual([chat]);
    expect(page.chat).toBe(chat);
    const [chatPreferences, pagePreferences] = H.webContentsOptions as Array<Record<string, unknown>>;
    expect(pagePreferences).toMatchObject({ preload: 'preload-panel.js', focusOnNavigation: false, sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(chatPreferences).toMatchObject({ focusOnNavigation: false });
  });

  it('tells the browser tabs about each page: added, changed by core, revealed, removed', () => {
    const tabs = views();
    const chat = open(tabs);
    pageEvents.length = 0;
    const page = tabs.create({ options: pageOptions(chat) });
    void page.postMessage({ type: 'urlChanged', url: 'https://a.example/' });
    void page.postMessage({ type: 'urlChanged', url: 'https://a.example/' });
    page.setTitle('A page');
    page.reveal();
    page.close();
    const id = page.panelId;
    expect(pageEvents).toEqual([`added:${id}`, `changed:${id}`, `changed:${id}`, `revealed:${id}`, `removed:${id}`]);
    expect(page.page?.url).toBe('https://a.example/');
    expect(revealed).toEqual([]);
  });

  it('closes every page of a chat that closes, after telling the browser tabs, and forgets them', () => {
    const tabs = views();
    const chat = open(tabs);
    const created = [0, 1].map(() => tabs.create({ options: pageOptions(chat) }));
    pageEvents.length = 0;
    // The browser tabs close a closing chat's pages (browser-tabs.ts chatClosed).
    const closing: PagesHost['chatClosed'] = () => {
      for (const page of created) page.close();
    };
    pages.chatClosed = closing;
    try {
      chat.close();
    } finally {
      pages.chatClosed = (closed) => pageEvents.push(`closed:${closed.panelId}`);
    }
    expect(created.every((page) => page.isDisposed)).toBe(true);
    expect(states.get(chat.panelId)).toBeUndefined();
    expect(tabs.panel(created[0]!.panelId)).toBeUndefined();
    expect(pageEvents).toEqual(created.map((page) => `removed:${page.panelId}`));
  });

  it('persists nothing from the page renderer', () => {
    const tabs = views();
    const chat = open(tabs);
    const page = tabs.create({ options: pageOptions(chat) });
    const contents = contentsOf(page);
    contents.ipc.emit(PANEL_CHANNELS.setState, { sender: contents, senderFrame: { url: page.pageUrl, parent: null } }, { url: 'file:///etc/passwd' });
    expect(states.get(page.panelId)).toBeUndefined();
    expect(states.get(chat.panelId)?.browser).toEqual({ pages: [] });
  });
});
