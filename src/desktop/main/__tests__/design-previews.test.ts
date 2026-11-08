import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignPreviewInfo } from '../../../shared/types/design';
import type { DesignReplayProgress } from '../../preload/shell-channels';

const webPreferences: unknown[] = vi.hoisted(() => []);
vi.mock('electron', async () => (await import('./fake-views-electron')).fakeViewsElectron(webPreferences));

import { nativeImage } from 'electron';
import { MAX_DESIGN_TABS } from '../../preload/shell-channels';
import { DesignPreviews, markupPngForModel, MAX_FREEZE_ELEMENTS, MAX_LIVE_DESIGN_VIEWS, parseFreezeOutput, type DesignChat, type DesignPreviewsDeps, type DesignSupport } from '../design/design-previews';
import { EMPTY_CAPTURE, fakeWindow, type FakeContents, type FakeView } from './fake-views-electron';
import { contactsPage, type FakeJourneyPage } from './fake-journey-page';
import type { JourneyStep } from '../../../shared/types/design';
import contacts from '../../../../e2e/fixtures/design-app/static/contacts.preview-journey.json' with { type: 'json' };

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The ids of the blocks a states sheet hides while the page shows `state`, matched by linkedom's selector engine. */
function hiddenBy(sheet: string, state: string): string[] {
  const { document } = parseHTML(`<html data-damocles-state="${state}"><body><p id="both" data-ds-state-only="default no-results"></p><p id="empty" data-ds-state-only="empty"></p><p id="always"></p></body></html>`) as unknown as { document: { querySelectorAll(selector: string): ArrayLike<{ id: string }> } };
  return sheet.split('\n').flatMap((rule) => Array.from(document.querySelectorAll(rule.slice(0, rule.indexOf(' {'))), (element) => element.id));
}

const info = (relPath: string, overrides: Partial<DesignPreviewInfo> = {}): DesignPreviewInfo => ({
  path: `/home/u/.damocles/designs/contacts-1a2b3c4d/${relPath}`,
  screenId: 'S1',
  title: 'Contacts',
  breakpoints: [{ name: 'sm', width: 640 }, { name: 'xl', width: 1280 }],
  primary: 1280,
  checked: [640, 1280],
  journey: [],
  states: ['default', 'empty'],
  ...overrides,
});

interface Harness {
  readonly previews: DesignPreviews;
  readonly window: ReturnType<typeof fakeWindow>;
  readonly deps: DesignPreviewsDeps;
  active: string | null;
  support: DesignSupport;
  readonly saved: Array<[string, unknown]>;
  readonly revoked: unknown[];
  readonly logged: string[];
  readonly progress: DesignReplayProgress[];
  readonly closed: string[];
}

function setUp(infoOf: (relPath: string) => DesignPreviewInfo | undefined = (relPath) => info(relPath)): Harness {
  webPreferences.length = 0;
  const window = fakeWindow(1600);
  const harness = { active: null as string | null, support: 'yes' as DesignSupport, saved: [] as Array<[string, unknown]>, revoked: [] as unknown[], logged: [] as string[], progress: [] as DesignReplayProgress[], closed: [] as string[] } as Harness;
  const deps: DesignPreviewsDeps = {
    editor: {
      activeTabId: () => harness.active,
      activateBrowserTab: (tabId) => {
        harness.active = tabId;
        harness.previews.activeChanged(tabId);
      },
      leaveBrowserTab: () => {
        harness.active = null;
        harness.previews.activeChanged(null);
      },
      browserTabsChanged: () => undefined,
    },
    window: window as unknown as DesignPreviewsDeps['window'],
    onRestack: vi.fn(),
    support: () => harness.support,
    info: async (_target, relPath) => infoOf(relPath),
    setTabs: (chatPanelId, tabs) => harness.saved.push([chatPanelId, tabs]),
    retainingStates: () => false,
    hostName: (authority) => (authority === 'local' ? undefined : 'build-box'),
    openInBrowser: vi.fn(async () => true),
    revoke: (target) => harness.revoked.push(target),
    copy: vi.fn(async () => undefined),
    mention: vi.fn(async () => undefined),
    openInBrowserFailed: vi.fn(),
    focusAway: vi.fn(),
    focusPart: vi.fn(),
    log: (line) => harness.logged.push(line),
    sessionReady: Promise.resolve(),
    replayProgress: (progress) => harness.progress.push(progress),
    tabClosed: (tabId) => harness.closed.push(tabId),
    replayPauseMs: 0,
    replayReadyMs: 200,
  };
  Object.assign(harness, { window, deps, previews: new DesignPreviews(deps) });
  return harness;
}

const chat: DesignChat = { panelId: 'design-chat', authority: 'local' };
const frame = (tabId: string, zoomFactor = 0.5) => ({ tabId, bounds: { x: 300, y: 100, width: 640, height: 400 }, radius: 6, zoomFactor });

function views(h: Harness): FakeView[] {
  return h.window.children as FakeView[];
}

/** Opens relPath in the selected design chat and lets its info land, its view load and the shell report its frame. */
async function shown(h: Harness, relPath: string): Promise<{ tabId: string; view: FakeView; contents: FakeContents }> {
  h.previews.open(chat, 'contacts-1a2b3c4d', relPath);
  await flush();
  const tabId = h.active!;
  h.previews.setBounds(frame(tabId));
  await flush();
  const view = views(h).find((candidate) => candidate.webContents.getURL().endsWith(relPath))!;
  view.webContents.emit('did-finish-load');
  return { tabId, view, contents: view.webContents };
}

let h: Harness;
beforeEach(() => {
  h = setUp();
  h.previews.chatSelected(chat);
});

describe('design preview views (PD-7)', () => {
  it('builds each view with no preload on the design-preview partition, sandboxed, with dialogs and DevTools off', async () => {
    await shown(h, 'screens/S1.html');
    expect(webPreferences).toEqual([{
      partition: 'design-preview',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      javascript: true,
      disableDialogs: true,
      devTools: false,
      spellcheck: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      focusOnNavigation: false,
    }]);
    const contents = views(h)[0]!.webContents as FakeContents & { setWebRTCIPHandlingPolicy: ReturnType<typeof vi.fn> };
    expect(contents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp');
    expect(h.deps.onRestack).toHaveBeenCalled();
  });

  it('loads each view on an origin of its own, damocles-design://<32 lowercase hex>/, and maps the token back to the design', async () => {
    const first = await shown(h, 'screens/S1.html');
    const second = await shown(h, 'screens/S2.html');
    const origin = (contents: FakeContents): string => /^damocles-design:\/\/([0-9a-f]{32})\//.exec(contents.getURL())![1]!;
    expect(origin(first.contents)).not.toBe(origin(second.contents));
    expect(h.previews.targetOf(origin(first.contents))).toEqual({ authority: 'local', designId: 'contacts-1a2b3c4d' });
    expect(h.previews.targetOf('0'.repeat(32))).toBeUndefined();
  });

  it('opens a screen at its primary width with its title, and shows the view over the frame at the zoom factor only once ready', async () => {
    h.previews.open(chat, 'contacts-1a2b3c4d', 'screens/S1.html');
    await flush();
    const [tab] = h.previews.tabs();
    expect(tab).toMatchObject({ kind: 'designPreview', title: 'S1 · Contacts', readOnly: true, designPreview: { relPath: 'screens/S1.html', path: info('screens/S1.html').path, width: 1280, state: 'default', provenance: false, status: 'loading' } });
    h.previews.setBounds(frame(tab!.id, 0.5));
    await flush();
    const view = views(h)[0]!;
    expect(view.getVisible()).toBe(false);
    view.webContents.emit('did-finish-load');
    expect(h.previews.tabs()[0]!.designPreview!.status).toBe('ready');
    expect(view.getVisible()).toBe(true);
    expect(view.bounds).toEqual({ x: 300, y: 100, width: 640, height: 400 });
    expect(view.setBorderRadius).toHaveBeenLastCalledWith(6);
    expect(view.webContents.setZoomFactor).toHaveBeenLastCalledWith(0.5);
    // a report for a tab that is not the active one shows nothing
    h.previews.setBounds(frame('another-tab'));
    expect(view.getVisible()).toBe(false);
  });

  it('focuses a design only while its view shows, and F6 and Shift+F6 there move focus a part on or back, unseen by the page', async () => {
    h.previews.open(chat, 'contacts-1a2b3c4d', 'screens/S1.html');
    await flush();
    const tabId = h.active!;
    h.previews.setBounds(frame(tabId));
    await flush();
    const view = views(h)[0]!;
    expect(h.previews.focusPage(tabId)).toBe(false);
    view.webContents.emit('did-finish-load');
    expect([h.previews.focusPage('another-tab'), h.previews.focusPage(tabId)]).toEqual([false, true]);
    expect(view.webContents.focus).toHaveBeenCalledOnce();
    const press = (shift: boolean): boolean => {
      const event = { preventDefault: vi.fn() };
      view.webContents.emit('before-input-event', event, { type: 'keyDown', key: 'F6', shift, control: false, alt: false, meta: false });
      return event.preventDefault.mock.calls.length > 0;
    };
    expect([press(false), press(true)]).toEqual([true, true]);
    expect(vi.mocked(h.deps.focusPart).mock.calls).toEqual([[1], [-1]]);
  });

  it('keeps at most four live views and rebuilds the least recently shown one when it shows again (PD-31)', async () => {
    const tabs: string[] = [];
    for (let index = 1; index <= MAX_LIVE_DESIGN_VIEWS + 1; index++) tabs.push((await shown(h, `screens/S${index}.html`)).tabId);
    expect(views(h)).toHaveLength(MAX_LIVE_DESIGN_VIEWS);
    expect(views(h).some((view) => view.webContents.getURL().endsWith('S1.html'))).toBe(false);
    h.deps.editor.activateBrowserTab(tabs[0]!);
    h.previews.setBounds(frame(tabs[0]!));
    await flush();
    expect(views(h)).toHaveLength(MAX_LIVE_DESIGN_VIEWS);
    expect(views(h).some((view) => view.webContents.getURL().endsWith('S1.html'))).toBe(true);
    // S2 was shown least recently of the others
    expect(views(h).some((view) => view.webContents.getURL().endsWith('S2.html'))).toBe(false);
  });

  it('adds one sheet naming every declared state per document and switches states by an attribute, refusing an undeclared one (PD-44)', async () => {
    const { tabId, contents } = await shown(h, 'screens/S1.html');
    contents.emit('dom-ready');
    await flush();
    const insert = contents.insertCSS as unknown as ReturnType<typeof vi.fn>;
    expect(insert).toHaveBeenCalledWith([
      'html[data-damocles-state="default"] [data-ds-state-only]:not([data-ds-state-only~="default"]) { display: none !important; }',
      'html[data-damocles-state="empty"] [data-ds-state-only]:not([data-ds-state-only~="empty"]) { display: none !important; }',
    ].join('\n'), { cssOrigin: 'user' });
    const world = contents.executeJavaScriptInIsolatedWorld as unknown as ReturnType<typeof vi.fn>;
    expect(world.mock.lastCall![1][0].code).toContain('"data-damocles-state", "default"');
    const sheets = insert.mock.calls.length;
    h.previews.set(tabId, { state: 'empty' });
    expect(world.mock.lastCall![0]).toBe(1001);
    expect(world.mock.lastCall![1][0].code).toContain('"data-damocles-state", "empty"');
    // a switch adds no sheet and removes none
    expect(insert.mock.calls.length).toBe(sheets);
    expect(contents.removeInsertedCSS).not.toHaveBeenCalled();
    expect(() => h.previews.set(tabId, { state: 'loading' })).toThrow('Not a state of the screen');
    expect(h.saved.at(-1)).toEqual(['design-chat', [{ designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', state: 'empty' }]]);
  });

  it('shows a block in every state its data-ds-state-only lists, and hides it in the others', async () => {
    h = setUp((relPath) => info(relPath, { states: ['default', 'empty', 'no-results'] }));
    h.previews.chatSelected(chat);
    const { contents } = await shown(h, 'screens/S1.html');
    contents.emit('dom-ready');
    await flush();
    const sheet = (contents.insertCSS as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([css]) => String(css).includes('data-ds-state-only'))![0] as string;
    expect(hiddenBy(sheet, 'default')).toEqual(['empty']);
    expect(hiddenBy(sheet, 'no-results')).toEqual(['empty']);
    expect(hiddenBy(sheet, 'empty')).toEqual(['both']);
  });

  it('keeps only states and screen ids of the design alphabet from a core, so no selector carries its text', async () => {
    h = setUp((relPath) => info(relPath, { states: ['default', 'x"] , * { display: none } [a="', 'empty'], screenId: 'S1"><' }));
    h.previews.chatSelected(chat);
    h.previews.open(chat, 'contacts-1a2b3c4d', 'screens/S1.html');
    await flush();
    const tab = h.previews.tabs()[0]!;
    expect(tab.designPreview!.info!.states).toEqual(['default', 'empty']);
    expect(tab.title).toBe('Contacts');
  });

  it('shows a screen title\'s control and bidi characters as escapes, since a core\'s text names the tab', async () => {
    h = setUp((relPath) => info(relPath, { screenId: null, title: 'Contacts\u202Etxt.exe\u0007' }));
    h.previews.chatSelected(chat);
    h.previews.open(chat, 'contacts-1a2b3c4d', 'screens/S1.html');
    await flush();
    expect(h.previews.tabs()[0]!.title).toBe('Contacts\\u{202E}txt.exe\\u{7}');
  });

  it('adds no sheet when the facts are read again with the same states, and only the new states\' sheet when they change', async () => {
    let states = ['default', 'empty'];
    h = setUp((relPath) => info(relPath, { states }));
    h.previews.chatSelected(chat);
    const { contents } = await shown(h, 'screens/S1.html');
    await flush();
    const insert = vi.mocked(contents.insertCSS);
    const sheets = insert.mock.calls.length;
    for (let index = 0; index < 5; index++) h.previews.designChanged('local', 'contacts-1a2b3c4d', []);
    await flush();
    expect(insert.mock.calls.length).toBe(sheets);
    states = ['default', 'empty', 'error'];
    h.previews.designChanged('local', 'contacts-1a2b3c4d', []);
    await flush();
    expect(insert.mock.calls.length).toBe(sheets + 1);
    expect(String(insert.mock.lastCall![0])).toContain('data-damocles-state="error"');
  });

  it('outlines the grounded elements and runs the hover label in its own world, reading nothing back', async () => {
    const { tabId, contents } = await shown(h, 'screens/S1.html');
    contents.emit('dom-ready');
    await flush();
    expect(contents.insertCSS).toHaveBeenCalledWith(expect.stringContaining('html[data-damocles-provenance] :is([data-ds-component],[data-ds-variant],[data-ds-bind],[data-ds-decision],[data-ds-new])'), { cssOrigin: 'user' });
    h.previews.set(tabId, { provenance: true });
    const world = contents.executeJavaScriptInIsolatedWorld as unknown as ReturnType<typeof vi.fn>;
    expect(world).toHaveBeenLastCalledWith(1001, [{ code: expect.stringContaining('textContent') }]);
    expect(world.mock.lastCall![1][0].code).not.toContain('innerHTML');
    expect(world.mock.lastCall![1][0].code).toContain('if (true) root.setAttribute("data-damocles-provenance"');
  });

  it('shows the update message and builds no view when the daemon lacks design.read or design.info', async () => {
    h.support = 'updateServer';
    h.previews.open({ panelId: 'remote-chat', authority: 'ssh:host' }, 'contacts-1a2b3c4d', 'screens/S1.html');
    h.previews.chatSelected({ panelId: 'remote-chat', authority: 'ssh:host' });
    await flush();
    expect(h.previews.tabs()).toEqual([]);
    const remote = { panelId: 'remote-chat-2', authority: 'ssh:host' };
    h.previews.chatSelected(remote);
    h.previews.open(remote, 'contacts-1a2b3c4d', 'screens/S1.html');
    await flush();
    expect(h.previews.tabs()[0]!.designPreview).toMatchObject({ status: 'updateServer', hostName: 'build-box' });
    expect(views(h)).toHaveLength(0);
  });

  it('keeps the last frame for the shell on a drop, hides the view, and reloads it once the connection is back', async () => {
    const remote = { panelId: 'remote-chat', authority: 'ssh:host' };
    h.previews.chatSelected(remote);
    h.previews.open(remote, 'contacts-1a2b3c4d', 'screens/S1.html');
    await flush();
    h.previews.setBounds(frame(h.active!));
    await flush();
    const view = views(h)[0]!;
    view.webContents.emit('did-finish-load');
    expect(view.getVisible()).toBe(true);
    let shownAtCapture: boolean | undefined;
    const capture = vi.mocked(view.webContents.capturePage);
    capture.mockImplementationOnce(async () => {
      shownAtCapture = view.getVisible();
      return { isEmpty: () => false, getSize: () => ({ width: 640, height: 400 }), toJPEG: () => Buffer.from('jpeg') } as never;
    });
    h.support = 'offline';
    h.previews.connectionChanged('ssh:host', false);
    await flush();
    // asked while the view still showed, then hidden
    expect(shownAtCapture).toBe(true);
    expect(view.getVisible()).toBe(false);
    const tabId = h.previews.tabs()[0]!.id;
    // the publish names the frame; only the shell's fetch carries it
    expect(h.previews.tabs()[0]!.designPreview).toMatchObject({ status: 'reconnecting', lastFrameId: expect.any(Number) });
    expect(JSON.stringify(h.previews.tabs())).not.toContain('data:image/jpeg');
    expect(h.previews.lastFrame(tabId)).toBe(`data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`);
    h.support = 'yes';
    h.previews.connectionChanged('ssh:host', true);
    await flush();
    expect(view.webContents.reload).toHaveBeenCalledOnce();
    view.webContents.emit('did-finish-load');
    expect(h.previews.tabs()[0]!.designPreview!.status).toBe('ready');
    expect(h.previews.tabs()[0]!.designPreview!.lastFrameId).toBeUndefined();
    expect(h.previews.lastFrame(tabId)).toBeNull();
  });

  it('keeps no last frame when the capture of a dropped connection comes back empty', async () => {
    const remote = { panelId: 'remote-chat', authority: 'ssh:host' };
    h.previews.chatSelected(remote);
    h.previews.open(remote, 'contacts-1a2b3c4d', 'screens/S1.html');
    await flush();
    h.previews.setBounds(frame(h.active!));
    await flush();
    const view = views(h)[0]!;
    view.webContents.emit('did-finish-load');
    vi.mocked(view.webContents.capturePage).mockResolvedValueOnce(EMPTY_CAPTURE as never);
    h.support = 'offline';
    h.previews.connectionChanged('ssh:host', false);
    await flush();
    expect(h.previews.tabs()[0]!.designPreview).toMatchObject({ status: 'reconnecting' });
    expect(h.previews.tabs()[0]!.designPreview!.lastFrameId).toBeUndefined();
    expect(h.previews.lastFrame(h.previews.tabs()[0]!.id)).toBeNull();
    expect(h.logged.some((line) => line.includes('was empty'))).toBe(true);
  });

  it('keeps a failed load failed though Electron finishes it, and reloads the view when the user shows the tab again', async () => {
    const { tabId, view, contents } = await shown(h, 'screens/S1.html');
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'damocles-design://x/screens/S1.html', true);
    contents.emit('did-finish-load');
    expect(h.previews.tabs()[0]!.designPreview!.status).toBe('failed');
    expect(view.getVisible()).toBe(false);
    h.previews.activeChanged(tabId);
    expect(contents.reload).toHaveBeenCalledOnce();
    expect(h.previews.tabs()[0]!.designPreview!.status).toBe('loading');
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    contents.emit('did-finish-load');
    expect(h.previews.tabs()[0]!.designPreview!.status).toBe('ready');
    expect(view.getVisible()).toBe(true);
  });

  it('reloads the views of a design the designer wrote, and only reads the facts again when a chat only began to hold it', async () => {
    const { contents } = await shown(h, 'screens/S1.html');
    h.previews.designChanged('local', 'contacts-1a2b3c4d', []);
    expect(contents.reload).not.toHaveBeenCalled();
    h.previews.designChanged('ssh:host', 'contacts-1a2b3c4d', ['screens/S1.html']);
    expect(contents.reload).not.toHaveBeenCalled();
    h.previews.designChanged('local', 'contacts-1a2b3c4d', ['screens/S1.html']);
    expect(contents.reload).toHaveBeenCalledOnce();
  });

  it('closes a chat\'s tabs and views with the chat, revoking its design\'s URLs, and hides them while another chat is selected (PD-33)', async () => {
    const { view } = await shown(h, 'screens/S1.html');
    h.previews.chatSelected({ panelId: 'other-chat', authority: 'local' });
    expect(h.previews.tabs()).toEqual([]);
    expect(view.getVisible()).toBe(false);
    h.previews.chatSelected(chat);
    expect(h.previews.tabs()).toHaveLength(1);
    h.previews.chatClosed(chat);
    expect(h.previews.tabs()).toEqual([]);
    expect(view.webContents.close).toHaveBeenCalled();
    expect(h.revoked).toEqual([{ authority: 'local', designId: 'contacts-1a2b3c4d' }]);
    expect(h.previews.targetOf(/^damocles-design:\/\/([0-9a-f]+)\//.exec(view.webContents.getURL())![1]!)).toBeUndefined();
  });

  it('opens in the browser and copies or mentions the screen\'s real path only through the tab, and refuses past the tab cap', async () => {
    const { tabId } = await shown(h, 'screens/S1.html');
    await h.previews.openInBrowser(tabId);
    expect(h.deps.openInBrowser).toHaveBeenCalledWith({ authority: 'local', designId: 'contacts-1a2b3c4d' }, 'screens/S1.html');
    await h.previews.copyPath(tabId);
    expect(h.deps.copy).toHaveBeenCalledWith(info('screens/S1.html').path);
    await h.previews.mention(tabId);
    expect(h.deps.mention).toHaveBeenCalledWith(chat, info('screens/S1.html').path);
    (h.deps.openInBrowser as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    await h.previews.openInBrowser(tabId);
    expect(h.deps.openInBrowserFailed).toHaveBeenCalledOnce();
    expect(() => h.previews.set('unknown', { width: 900 })).toThrow('Unknown design tab');
    for (let index = 2; index <= MAX_DESIGN_TABS + 1; index++) h.previews.open(chat, 'contacts-1a2b3c4d', `screens/S${index}.html`);
    expect(h.previews.tabs()).toHaveLength(MAX_DESIGN_TABS);
    expect(h.logged.some((line) => line.includes('refused a preview'))).toBe(true);
  });

  it('revokes every design it holds when the window goes, and restores saved tabs without taking the active tab', async () => {
    h.previews.restore(chat, [{ designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', width: 900, state: 'empty', provenance: true }, { designId: 'other-2b3c4d5e', relPath: 'screens/S1.html' }]);
    await flush();
    expect(h.active).toBeNull();
    expect(h.previews.tabs().map((tab) => [tab.designPreview!.width, tab.designPreview!.state, tab.designPreview!.provenance])).toEqual([[900, 'empty', true], [1280, 'default', false]]);
    h.previews.dispose();
    expect(h.revoked).toEqual([{ authority: 'local', designId: 'contacts-1a2b3c4d' }, { authority: 'local', designId: 'other-2b3c4d5e' }]);
  });
});

describe('tweaks on the live preview (PD-13)', () => {
  const TWEAKS: DesignPreviewInfo['tweaks'] = {
    toolCallId: 'call-1',
    controls: [
      { id: 'radius', label: 'Corner radius', property: '--radius', kind: 'segment', stops: [{ token: '--radius-sm', value: '4px' }, { token: '--radius-lg', value: '12px' }], locked: null },
      { id: 'accent', label: 'Accent', property: '--accent', kind: 'swatch', stops: [{ token: '--accent-blue', value: '#2563eb' }, { token: '--accent-green', value: 'url(x)' }], locked: null },
      { id: 'shadow', label: 'Shadow', property: '--shadow', kind: 'segment', stops: [{ token: '--shadow-sm', value: 'x' }, { token: '--shadow-lg', value: 'y' }], locked: { decisionId: 'D1', value: '--shadow-sm' } },
    ],
  };
  const tweakSheets = (contents: FakeContents): string[] => vi.mocked(contents.insertCSS).mock.calls.map(([css]) => String(css)).filter((css) => css.startsWith(':root'));

  beforeEach(() => {
    h = setUp((relPath) => info(relPath, { tweaks: TWEAKS }));
    h.previews.chatSelected(chat);
  });

  it('applies a stop as one user sheet of token names, replacing the property\'s earlier one, and Reset removes them (acceptance)', async () => {
    const { tabId, contents } = await shown(h, 'screens/S1.html');
    contents.emit('dom-ready');
    await flush();
    h.previews.applyTweak(tabId, '--radius', '--radius-sm');
    await flush();
    expect(contents.insertCSS).toHaveBeenLastCalledWith(':root { --radius: var(--radius-sm) !important; }', { cssOrigin: 'author' });
    const firstKey = await vi.mocked(contents.insertCSS).mock.results.at(-1)!.value;
    h.previews.applyTweak(tabId, '--radius', '--radius-lg');
    await flush();
    expect(contents.removeInsertedCSS).toHaveBeenCalledWith(firstKey);
    expect(contents.insertCSS).toHaveBeenLastCalledWith(':root { --radius: var(--radius-lg) !important; }', { cssOrigin: 'author' });
    expect(h.previews.tabs()[0]!.designPreview!.tweaks).toEqual({ '--radius': '--radius-lg' });
    expect(contents.reload).not.toHaveBeenCalled();
    h.previews.resetTweaks(tabId);
    await flush();
    expect(contents.removeInsertedCSS).toHaveBeenCalledTimes(2);
    expect(h.previews.tabs()[0]!.designPreview!.tweaks).toBeUndefined();
  });

  it('never builds a sheet from a name that is no token, a stop not offered, or a locked control', async () => {
    const { tabId, contents } = await shown(h, 'screens/S1.html');
    contents.emit('dom-ready');
    await flush();
    for (const [property, token] of [['--radius', '--x);}body{display:none'], ['--radius', 'var(--radius-lg)'], ['radius', '--radius-lg'], ['--radius', '--radius-md'], ['--other', '--radius-lg'], ['--shadow', '--shadow-lg']]) {
      expect(() => h.previews.applyTweak(tabId, property!, token!)).toThrow(/Not a stop of a tweak/);
    }
    await flush();
    expect(tweakSheets(contents)).toEqual([]);
    h.previews.markupEnter(tabId);
    expect(() => h.previews.applyTweak(tabId, '--radius', '--radius-lg')).toThrow(/Markup is on/);
    expect(tweakSheets(contents)).toEqual([]);
  });

  it('applies the tab\'s tweaks again on every new document, and drops one the next declaration no longer offers', async () => {
    let tweaks = TWEAKS;
    h = setUp((relPath) => info(relPath, { tweaks }));
    h.previews.chatSelected(chat);
    const { tabId, contents } = await shown(h, 'screens/S1.html');
    contents.emit('dom-ready');
    await flush();
    h.previews.applyTweak(tabId, '--radius', '--radius-lg');
    await flush();
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    h.previews.applyTweak(tabId, '--radius', '--radius-sm');
    await flush();
    expect(tweakSheets(contents)).toEqual([':root { --radius: var(--radius-lg) !important; }']);
    contents.emit('dom-ready');
    await flush();
    expect(tweakSheets(contents).at(-1)).toBe(':root { --radius: var(--radius-sm) !important; }');
    // a decision that locks the applied value keeps it on the page; one at another value takes it off
    tweaks = { ...TWEAKS!, controls: TWEAKS!.controls.map((control) => (control.id === 'radius' ? { ...control, locked: { decisionId: 'D2', value: '--radius-sm' } } : control)) };
    h.previews.designChanged('local', 'contacts-1a2b3c4d', []);
    await flush();
    expect(h.previews.tabs()[0]!.designPreview!.tweaks).toEqual({ '--radius': '--radius-sm' });
    expect(contents.removeInsertedCSS).not.toHaveBeenCalled();
    tweaks = { ...TWEAKS!, controls: TWEAKS!.controls.map((control) => (control.id === 'radius' ? { ...control, locked: { decisionId: 'D3', value: '--radius-lg' } } : control)) };
    h.previews.designChanged('local', 'contacts-1a2b3c4d', []);
    await flush();
    expect(h.previews.tabs()[0]!.designPreview!.tweaks).toBeUndefined();
    expect(contents.removeInsertedCSS).toHaveBeenCalled();
  });

  it('keeps only well-formed controls from a core, and a swatch only over literal colors', async () => {
    const hostile: DesignPreviewInfo['tweaks'] = {
      toolCallId: 'call-2',
      controls: [
        ...TWEAKS!.controls,
        { id: 'bad id"', label: 'x', property: '--a', kind: 'segment', stops: [{ token: '--a-1', value: '1' }, { token: '--a-2', value: '2' }], locked: null },
        { id: 'dup', label: 'x', property: '--radius', kind: 'segment', stops: [{ token: '--r-1', value: '1' }, { token: '--r-2', value: '2' }], locked: null },
        { id: 'lock', label: 'x', property: '--b', kind: 'segment', stops: [{ token: '--b-1', value: '1' }, { token: '--b-2', value: '2' }], locked: { decisionId: 'D1;', value: '--b-1' } },
        { id: 'css', label: 'x', property: '--c', kind: 'segment', stops: [{ token: '--c-1}', value: '1' }, { token: '--c-2', value: '2' }], locked: null },
      ],
    };
    h = setUp((relPath) => info(relPath, { tweaks: hostile }));
    h.previews.chatSelected(chat);
    h.previews.open(chat, 'contacts-1a2b3c4d', 'screens/S1.html');
    await flush();
    const declared = h.previews.tabs()[0]!.designPreview!.info!.tweaks!;
    expect(declared.controls.map((control) => [control.id, control.kind])).toEqual([['radius', 'segment'], ['accent', 'segment'], ['shadow', 'segment']]);
  });
});

describe('the Screenshot of the preview (PD-40, PD-41)', () => {
  it('captures the live view as the user sees it, for its own design chat', async () => {
    const { tabId } = await shown(h, 'screens/S1.html');
    expect(await h.previews.screenshot(tabId)).toEqual({ chat, image: { mimeType: 'image/png', data: Buffer.from('png').toString('base64'), width: 640, height: 400 } });
  });

  it('shrinks a capture past 1950 px to fit', async () => {
    const { tabId, contents } = await shown(h, 'screens/S1.html');
    const resize = vi.fn(() => ({ getSize: () => ({ width: 1950, height: 975 }), toPNG: () => Buffer.from('small') }));
    vi.mocked(contents.capturePage).mockResolvedValueOnce({ getSize: () => ({ width: 3900, height: 1950 }), resize, toPNG: () => Buffer.from('big') } as never);
    const { image } = await h.previews.screenshot(tabId);
    expect(resize).toHaveBeenCalledWith({ width: 1950, height: 975, quality: 'best' });
    expect(image).toMatchObject({ width: 1950, height: 975, data: Buffer.from('small').toString('base64') });
  });

  it('keeps both sides of an extreme aspect ratio at least 1 px when it shrinks', async () => {
    const { tabId, contents } = await shown(h, 'screens/S1.html');
    const resize = vi.fn(() => ({ getSize: () => ({ width: 1950, height: 1 }), toPNG: () => Buffer.from('thin') }));
    vi.mocked(contents.capturePage).mockResolvedValueOnce({ getSize: () => ({ width: 40_000, height: 10 }), resize, toPNG: () => Buffer.from('big') } as never);
    await h.previews.screenshot(tabId);
    expect(resize).toHaveBeenCalledWith({ width: 1950, height: 1, quality: 'best' });
  });

  it('refuses a tab that is not showing its page, and a tab of another chat', async () => {
    h.previews.open(chat, 'contacts-1a2b3c4d', 'screens/S2.html');
    await expect(h.previews.screenshot(h.active!)).rejects.toThrow(/not showing/);
    await expect(h.previews.screenshot('design-unknown')).rejects.toThrow(/Unknown design tab/);
  });
});

describe('markup on a frozen capture (PD-12, PD-41)', () => {
  // the view shows at zoom 0.5 on a 1.5 device-scale screen, so the page's devicePixelRatio is 0.75
  const page = (width: number, els: unknown[] = []): string => JSON.stringify({ w: width, h: 720, dpr: 0.75, els });
  const TABLE = ['table', 'ui/Table', 'compact', null, 'D3', false, 0, 120.04, 1280, 300];
  const CELL = ['td', null, null, 'Contact.name', null, true, 16, 136, 200, 24];

  function pngOf(width: number, height: number): string {
    const bytes = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(bytes);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes.toString('base64');
  }

  /** The view's debugger: Page.captureScreenshot renders the clip at its scale, times `extra` (a renderer's own device scale). */
  function captures(contents: FakeContents, extra = 1): { commands: Array<[string, Record<string, unknown>]>; attached: () => boolean } {
    let attached = false;
    const commands: Array<[string, Record<string, unknown>]> = [];
    Object.assign(contents, {
      debugger: {
        isAttached: () => attached,
        attach: () => { attached = true; },
        detach: () => { attached = false; },
        sendCommand: async (method: string, params: Record<string, unknown>) => {
          commands.push([method, params]);
          const clip = params['clip'] as { width: number; height: number; scale: number };
          return { data: pngOf(Math.round(clip.width * clip.scale * extra), Math.round(clip.height * clip.scale * extra)) };
        },
      },
    });
    return { commands, attached: () => attached };
  }

  async function frozenTab(extra = 1): Promise<{ tabId: string; view: FakeView; contents: FakeContents; debug: ReturnType<typeof captures> }> {
    const tab = await shown(h, 'screens/S1.html');
    tab.contents.zoom = 0.5;
    vi.mocked(tab.contents.executeJavaScriptInIsolatedWorld).mockResolvedValueOnce(page(1280, [TABLE, CELL]) as never);
    return { ...tab, debug: captures(tab.contents, extra) };
  }

  it('captures the live view at PD-41\'s scale whatever its zoom, with its data-ds elements in viewport CSS px, and records zoom and pixel ratio', async () => {
    const { tabId, contents, debug } = await frozenTab();
    const frozen = await h.previews.freeze(tabId);
    // the largest scale up to 2 that keeps 1280 × 720 CSS px at or below 1950 px, through the live view's own debugger; the clip
    // is the viewport in the view's DIP (zoom 0.5), so its scale is 1.523 ÷ 0.5
    expect(debug.commands).toEqual([['Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, clip: { x: 0, y: 0, width: 640, height: 360, scale: 3.046 } }]]);
    expect(debug.attached()).toBe(false);
    expect(contents.capturePage).not.toHaveBeenCalled();
    expect(frozen).toEqual({
      png: `data:image/png;base64,${pngOf(1949, 1097)}`,
      imageWidth: 1949,
      imageHeight: 1097,
      width: 1280,
      height: 720,
      breakpoint: 'xl',
      zoom: 0.5,
      pixelRatio: 1.5,
      scale: 1.523,
      state: 'default',
      screen: 'S1',
      file: 'screens/S1.html',
      elements: [
        { element: 'ui/Table', rect: [0, 120, 1280, 300], facts: ['variant compact', 'decision D3'] },
        { element: 'td', rect: [16, 136, 200, 24], facts: ['bind Contact.name', 'new'] },
      ],
    });
    // the read runs in the freeze world, never the page's or the preview's own
    expect(vi.mocked(contents.executeJavaScriptInIsolatedWorld).mock.calls.at(-1)![0]).toBe(1003);
  });

  it('takes the capture again smaller when the renderer scaled it past 1950 px, and refuses a view another debugger holds', async () => {
    const { tabId, debug } = await frozenTab(2);
    const frozen = await h.previews.freeze(tabId);
    expect(debug.commands).toHaveLength(2);
    expect(Math.max(frozen.imageWidth, frozen.imageHeight)).toBeLessThanOrEqual(1950);
    h.previews.markupExit(tabId);
    const held = await frozenTab();
    held.contents.debugger.attach('1.3');
    await expect(h.previews.freeze(held.tabId)).rejects.toThrow(/Another debugger/);
    expect(held.view.getVisible()).toBe(true);
  });

  it('keeps the view hidden while markup is on, whatever frame the shell reports, until markup exits', async () => {
    const { tabId, view } = await frozenTab();
    await h.previews.freeze(tabId);
    expect(view.getVisible()).toBe(false);
    h.previews.setBounds(frame(tabId));
    expect(view.getVisible()).toBe(false);
    h.previews.markupExit(tabId);
    expect(view.getVisible()).toBe(true);
    h.previews.markupEnter(tabId);
    expect(view.getVisible()).toBe(false);
    // a reloaded shell page holds no markup, so the view shows again
    h.previews.shellLoaded();
    expect(view.getVisible()).toBe(true);
  });

  it('ends markup for a tab of a chat the user left meanwhile, so its view shows when the chat comes back', async () => {
    const { tabId, view } = await frozenTab();
    await h.previews.freeze(tabId);
    h.previews.chatSelected(undefined);
    h.previews.markupExit(tabId);
    h.previews.chatSelected(chat);
    h.previews.setBounds(frame(tabId));
    expect(view.getVisible()).toBe(true);
    expect(() => h.previews.markupExit('design-unknown')).not.toThrow();
  });

  it('refuses a freeze while a tweak is applied, and a tweak while a freeze captures', async () => {
    const radius = { id: 'radius', label: 'Radius', property: '--radius', kind: 'segment' as const, stops: [{ token: '--radius-sm', value: '4px' }, { token: '--radius-lg', value: '12px' }], locked: null };
    h = setUp((relPath) => info(relPath, { tweaks: { toolCallId: 'call-1', controls: [radius] } }));
    h.previews.chatSelected(chat);
    const { tabId, contents, view } = await frozenTab();
    h.previews.applyTweak(tabId, '--radius', '--radius-lg');
    await expect(h.previews.freeze(tabId)).rejects.toThrow(/Tweaks are applied/);
    expect(view.getVisible()).toBe(true);
    h.previews.resetTweaks(tabId);

    let answer!: (value: string) => void;
    vi.mocked(contents.executeJavaScriptInIsolatedWorld).mockReset().mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }) as never);
    const frozen = h.previews.freeze(tabId);
    expect(() => h.previews.applyTweak(tabId, '--radius', '--radius-sm')).toThrow(/Markup is on/);
    answer(page(1280));
    await frozen;
    expect(h.previews.tabs()[0]!.designPreview!.tweaks).toBeUndefined();
    expect(view.getVisible()).toBe(false);
  });

  it('refuses a freeze during the width glide, of a screen outside screens/, and of a view not showing', async () => {
    const { tabId, contents, view } = await shown(h, 'screens/S1.html');
    captures(contents);
    vi.mocked(contents.executeJavaScriptInIsolatedWorld).mockResolvedValueOnce(page(1000) as never);
    await expect(h.previews.freeze(tabId)).rejects.toThrow(/changing width/);
    expect(view.getVisible()).toBe(true);
    const variant = await shown(h, 'variants/a/screens/S1.html');
    await expect(h.previews.freeze(variant.tabId)).rejects.toThrow(/screens\/ only/);
    h.previews.open(chat, 'contacts-1a2b3c4d', 'screens/S2.html');
    await expect(h.previews.freeze(h.active!)).rejects.toThrow(/not showing/);
  });

  it('tells the shell a tab closed for good on its close and its chat\'s close, never on a chat switch', async () => {
    const first = await shown(h, 'screens/S1.html');
    const second = await shown(h, 'screens/S2.html');
    h.previews.chatSelected(undefined);
    h.previews.chatSelected(chat);
    expect(h.closed).toEqual([]);
    h.previews.close(first.tabId);
    expect(h.closed).toEqual([first.tabId]);
    h.previews.chatClosed(chat);
    expect(h.closed).toEqual([first.tabId, second.tabId]);
  });

  it('parses the freeze world\'s answer as hostile', () => {
    expect(() => parseFreezeOutput(42)).toThrow(/malformed/);
    expect(() => parseFreezeOutput('{')).toThrow(/malformed/);
    expect(() => parseFreezeOutput(page(1280, [['td', null]]))).toThrow(/malformed/);
    expect(() => parseFreezeOutput(page(1280, [['td', null, null, null, null, 'yes', 0, 0, 1, 1]]))).toThrow(/malformed/);
    expect(() => parseFreezeOutput(page(1280, [['td', null, null, null, null, false, 'x', 0, 1, 1]]))).toThrow(/malformed/);
    expect(() => parseFreezeOutput(JSON.stringify({ w: 1280, h: 720, dpr: Number.NaN, els: [] }))).toThrow(/malformed/);
    expect(() => parseFreezeOutput(JSON.stringify({ w: 1280, h: 720, els: [] }))).toThrow(/malformed/);
    expect(() => parseFreezeOutput(page(1280, Array.from({ length: MAX_FREEZE_ELEMENTS + 1 }, () => CELL)))).toThrow(/malformed/);
    expect(() => parseFreezeOutput('x'.repeat(512 * 1024 + 1))).toThrow(/malformed/);
    const [odd] = parseFreezeOutput(page(1280, [['o:p', '\u202eevil\u0000', 'v'.repeat(400), null, null, false, -1e12, 1e12, -5, 1e12]])).elements;
    expect(odd!.element.includes('\u202e') || odd!.element.includes('\u0000')).toBe(false);
    expect(odd!.facts[0]!.length).toBeLessThanOrEqual(200);
    expect(odd!.rect).toEqual([-100_000, 100_000, 0, 100_000]);
    expect(parseFreezeOutput(page(1280, [['o:p', '  ', null, null, null, false, 0, 0, 1, 1]])).elements[0]!.element).toBe('element');
    expect(parseFreezeOutput(page(1280, [['td', 'ui/\tTable', null, 'Contact\tname', null, false, 0, 0, 1, 1]])).elements[0]).toMatchObject({ element: 'ui/ Table', facts: ['bind Contact name'] });
  });

  it('fits the flattened markup for the model: longest side at most 1950 px', () => {
    const resize = vi.fn(() => ({ getSize: () => ({ width: 1950, height: 975 }), toPNG: () => Buffer.from('small') }));
    vi.mocked(nativeImage.createFromDataURL).mockReturnValueOnce({ isEmpty: () => false, getSize: () => ({ width: 2560, height: 1280 }), resize, toPNG: () => Buffer.from('big') } as never);
    expect(markupPngForModel(`data:image/png;base64,${pngOf(2560, 1280)}`)).toBe(Buffer.from('small').toString('base64'));
    expect(resize).toHaveBeenCalledWith({ width: 1950, height: 975, quality: 'best' });
    expect(() => markupPngForModel('data:image/jpeg;base64,AAAA')).toThrow(/not a PNG/);
  });

  it('refuses a PNG whose header declares more than 4096 px a side before decoding it', () => {
    const decode = vi.mocked(nativeImage.createFromDataURL);
    decode.mockClear();
    expect(() => markupPngForModel(`data:image/png;base64,${pngOf(4097, 10)}`)).toThrow(/4097 × 10 px, over 4096 px/);
    expect(() => markupPngForModel(`data:image/png;base64,${pngOf(10, 100_000)}`)).toThrow(/over 4096 px/);
    expect(() => markupPngForModel('data:image/png;base64,AAAA')).toThrow(/not a PNG/);
    expect(decode).not.toHaveBeenCalled();
  });

  it('ends a freeze whose element read the page never answers, and keeps markup off', async () => {
    const { tabId, contents, view } = await shown(h, 'screens/S1.html');
    captures(contents);
    vi.useFakeTimers();
    try {
      vi.mocked(contents.executeJavaScriptInIsolatedWorld).mockReturnValueOnce(new Promise(() => undefined) as never);
      const frozen = h.previews.freeze(tabId).catch((err: unknown) => err as Error);
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await frozen as Error).message).toBe('The preview did not answer the element read');
    } finally {
      vi.useRealTimers();
    }
    expect(view.getVisible()).toBe(true);
  });
});

describe('a journey replay in the live preview (D93)', () => {
  const STEPS = contacts.steps as JourneyStep[];

  /** The view's debugger over a fake page; it records whether it is attached and every attach and detach. */
  function debuggee(contents: FakeContents, page: FakeJourneyPage): { attaches: number; detaches: number; attached: () => boolean } {
    let attached = false;
    const record = { attaches: 0, detaches: 0, attached: () => attached };
    const listeners = new Set<() => void>();
    Object.assign(contents, {
      debugger: {
        isAttached: () => attached,
        attach: () => {
          attached = true;
          record.attaches++;
        },
        detach: () => {
          attached = false;
          record.detaches++;
        },
        on: (_event: string, listener: () => void) => listeners.add(listener),
        off: (_event: string, listener: () => void) => listeners.delete(listener),
        sendCommand: (method: never, params: Record<string, unknown>) => (attached ? page.send(method, params) : Promise.reject(new Error('detached'))),
      },
    });
    return record;
  }

  it('drives the view through its debugger only for the replay, outlines each target, posts each step, and reloads after', async () => {
    const { tabId, contents } = await shown(h, 'screens/S1.html');
    const page = contactsPage(1280);
    const record = debuggee(contents, page);
    await h.previews.replayJourney(chat, 'contacts-1a2b3c4d', 'screens/S1.html', null, STEPS, false, new AbortController().signal);
    expect(record).toMatchObject({ attaches: 1, detaches: 1 });
    expect(record.attached()).toBe(false);
    expect(page.highlighted).toEqual([2, 3, 5, 6, 7, 7, 8, 8, 7, 4]);
    expect(page.events).toEqual(['click 5', 'change 8', 'key Escape']);
    expect(vi.mocked(contents.insertCSS).mock.calls.some(([css]) => String(css).includes('[data-damocles-replay]'))).toBe(true);
    expect(contents.reload).toHaveBeenCalledTimes(1);
    expect(h.progress[0]).toEqual({ tabId, steps: STEPS, active: null, results: [], done: false, reducedMotion: false });
    expect(h.progress.filter((progress) => progress.active !== null).map((progress) => progress.active)).toEqual(STEPS.map((_step, index) => index));
    expect(h.progress.at(-1)).toEqual({ tabId, steps: STEPS, active: null, results: STEPS.map(() => ({ ok: true })), done: true, reducedMotion: false });
  });

  it('shows the results at once under reduced motion: no outline and no pause', async () => {
    const { contents } = await shown(h, 'screens/S1.html');
    const page = contactsPage(1280);
    debuggee(contents, page);
    await h.previews.replayJourney(chat, 'contacts-1a2b3c4d', 'screens/S1.html', null, STEPS, true, new AbortController().signal);
    expect(page.highlighted).toEqual([]);
    expect(h.progress.at(-1)).toMatchObject({ done: true, reducedMotion: true });
  });

  it('ends at a failed step, detaches, restores the state of the tab and reloads', async () => {
    const { tabId, contents } = await shown(h, 'screens/S1.html');
    const record = debuggee(contents, contactsPage(1280, { stuckDialog: true }));
    await h.previews.replayJourney(chat, 'contacts-1a2b3c4d', 'screens/S1.html', 'empty', STEPS, true, new AbortController().signal);
    const last = h.progress.at(-1)!;
    expect(last.results).toHaveLength(10);
    expect(last.results[9]).toMatchObject({ ok: false, failure: 'expectation' });
    expect(record).toMatchObject({ attaches: 1, detaches: 1 });
    expect(h.previews.tabs().find((tab) => tab.id === tabId)!.designPreview!.state).toBe('default');
    expect(contents.reload).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('refuses a second replay of the tab and a view another debugger holds', async () => {
    const { contents } = await shown(h, 'screens/S1.html');
    debuggee(contents, contactsPage(1280));
    const first = h.previews.replayJourney(chat, 'contacts-1a2b3c4d', 'screens/S1.html', null, STEPS, true, new AbortController().signal);
    await expect(h.previews.replayJourney(chat, 'contacts-1a2b3c4d', 'screens/S1.html', null, STEPS, true, new AbortController().signal)).rejects.toThrow('A journey is already replaying in this preview');
    await first;
    contents.emit('did-finish-load');
    (contents as unknown as { debugger: { attach(): void } }).debugger.attach();
    await expect(h.previews.replayJourney(chat, 'contacts-1a2b3c4d', 'screens/S1.html', null, STEPS, true, new AbortController().signal)).rejects.toThrow('Another debugger holds the preview');
  });

  it('shows the journey\'s state on the page only, so neither the replay nor its end writes panels.json', async () => {
    const { tabId, contents } = await shown(h, 'screens/S1.html');
    debuggee(contents, contactsPage(1280));
    const saved = h.saved.length;
    await h.previews.replayJourney(chat, 'contacts-1a2b3c4d', 'screens/S1.html', 'empty', STEPS, true, new AbortController().signal);
    const world = vi.mocked(contents.executeJavaScriptInIsolatedWorld).mock.calls.filter(([id]) => id === 1001).map(([, scripts]) => (scripts as { code: string }[])[0]!.code);
    expect(world.some((code) => code.includes('"data-damocles-state", "empty"'))).toBe(true);
    expect(h.previews.tabs().find((tab) => tab.id === tabId)!.designPreview!.state).toBe('default');
    expect(h.saved).toHaveLength(saved);
  });

  it('leaves the tab\'s state and panels.json alone when the debugger cannot attach', async () => {
    const { tabId, contents } = await shown(h, 'screens/S1.html');
    debuggee(contents, contactsPage(1280));
    Object.assign((contents as unknown as { debugger: object }).debugger, { attach: () => { throw new Error('Debugger is already attached to the target'); } });
    const saved = h.saved.length;
    const scripts = vi.mocked(contents.executeJavaScriptInIsolatedWorld).mock.calls.length;
    await expect(h.previews.replayJourney(chat, 'contacts-1a2b3c4d', 'screens/S1.html', 'empty', STEPS, true, new AbortController().signal)).rejects.toThrow('already attached');
    expect(h.previews.tabs().find((tab) => tab.id === tabId)!.designPreview!.state).toBe('default');
    expect(h.saved).toHaveLength(saved);
    expect(vi.mocked(contents.executeJavaScriptInIsolatedWorld).mock.calls).toHaveLength(scripts);
    // the tab is free for the next replay
    debuggee(contents, contactsPage(1280));
    await h.previews.replayJourney(chat, 'contacts-1a2b3c4d', 'screens/S1.html', null, STEPS, true, new AbortController().signal);
  });

  /** A page whose renderer a script holds: no CDP command is ever answered. */
  function hungDebuggee(contents: FakeContents): { attached: () => boolean } {
    let attached = false;
    Object.assign(contents, {
      debugger: {
        isAttached: () => attached,
        attach: () => { attached = true; },
        detach: () => { attached = false; },
        on: () => undefined,
        off: () => undefined,
        sendCommand: () => new Promise(() => undefined),
      },
    });
    return { attached: () => attached };
  }

  it('ends a replay on a page that never answers at its deadline, detaches, and builds the view again', async () => {
    const { tabId, contents, view } = await shown(h, 'screens/S1.html');
    const record = hungDebuggee(contents);
    vi.useFakeTimers();
    try {
      const replay = h.previews.replayJourney(chat, 'contacts-1a2b3c4d', 'screens/S1.html', null, STEPS, true, new AbortController().signal).catch((err: unknown) => err as Error);
      // every step's 5 s deadline plus 10 s of slack
      await vi.advanceTimersByTimeAsync(STEPS.length * 5_000 + 10_000);
      expect((await replay as Error).message).toMatch(/The replay took longer than \d+ s/);
    } finally {
      vi.useRealTimers();
    }
    expect(record.attached()).toBe(false);
    expect(contents.close).toHaveBeenCalled();
    expect(contents.reload).not.toHaveBeenCalled();
    expect(views(h)).not.toContain(view);
    expect(h.progress.at(-1)).toMatchObject({ tabId, done: true });
    // the active tab gets a new view, and nothing still counts it as replaying
    expect(views(h)).toHaveLength(1);
    const rebuilt = views(h)[0]!;
    await flush();
    rebuilt.webContents.emit('did-finish-load');
    debuggee(rebuilt.webContents, contactsPage(1280));
    await h.previews.replayJourney(chat, 'contacts-1a2b3c4d', 'screens/S1.html', null, STEPS, true, new AbortController().signal);
  });

  it('ends a replay on a page that never answers at once on Stop', async () => {
    const { contents } = await shown(h, 'screens/S1.html');
    const record = hungDebuggee(contents);
    const stop = new AbortController();
    const replay = h.previews.replayJourney(chat, 'contacts-1a2b3c4d', 'screens/S1.html', null, STEPS, true, stop.signal);
    await flush();
    stop.abort(new Error('Stop'));
    await expect(replay).rejects.toThrow('Stop');
    expect(record.attached()).toBe(false);
    expect(contents.close).toHaveBeenCalled();
  });

  it('drives nothing while the view of the screen is not showing', async () => {
    h.previews.chatSelected(undefined);
    await expect(h.previews.replayJourney(chat, 'contacts-1a2b3c4d', 'screens/S1.html', null, STEPS, true, new AbortController().signal)).rejects.toThrow(/The preview is not showing/);
    expect(h.progress).toEqual([]);
  });
});
