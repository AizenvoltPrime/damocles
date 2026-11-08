import * as http from 'node:http';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const webPreferences: unknown[] = vi.hoisted(() => []);
vi.mock('electron', async () => (await import('../../__tests__/fake-views-electron')).fakeViewsElectron(webPreferences));

import type { Disposable } from '../../../../platform/disposable';
import type { Project } from '../../../local-services/confine';
import type { WatchEvent } from '../../../workspace/file-system';
import type { ReadRangeResult } from '../../../workspace/transfer-ops';
import type { FileRef } from '../../../preload/shell-channels';
import { fakeWindow, type FakeView } from '../../__tests__/fake-views-electron';
import type { Location } from '../../documents/document-service';
import { RangedReadsUnsupportedError } from '../../workspace/remote-workspace';
import { NotConnectedError } from '../../workspace/workspaces';
import { hardenWebContents } from '../../security';
import { HtmlPreviews, RELOAD_DEBOUNCE_MS, type HtmlPreviewsDeps } from '../html-previews';
import type { PreviewSessionDeps } from '../preview-session';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const LOCAL: Project = { key: 'C:\\work\\site', fsPath: 'C:\\work\\site', name: 'site' };
const OTHER: Project = { key: 'C:\\work\\docs', fsPath: 'C:\\work\\docs', name: 'docs' };

interface Watch {
  readonly base: string;
  readonly listener: (event: WatchEvent) => void;
  disposed: boolean;
}

interface Harness {
  readonly previews: HtmlPreviews;
  readonly window: ReturnType<typeof fakeWindow>;
  readonly deps: HtmlPreviewsDeps;
  session: PreviewSessionDeps | undefined;
  trusted: Set<string>;
  offline: boolean;
  // the host's daemon reads no byte range
  rangeless: boolean;
  readonly files: { readonly readFileRange: Mock };
  readonly watches: Watch[];
  readonly reads: string[];
  save: ((location: Location) => void) | undefined;
  readonly opened: string[];
  readonly changed: { count: number };
  readonly projects: Project[];
}

function setUp(): Harness {
  webPreferences.length = 0;
  const window = fakeWindow(1600);
  const h = { window, trusted: new Set<string>(), offline: false, rangeless: false, watches: [] as Watch[], reads: [] as string[], opened: [] as string[], changed: { count: 0 }, projects: [LOCAL, OTHER] } as Partial<Harness> as Harness;
  const files = {
    readFileRange: vi.fn(async (_project: Project, relativePath: string, offset: number, length: number): Promise<ReadRangeResult> => {
      if (h.rangeless) throw new RangedReadsUnsupportedError('ssh+box');
      h.reads.push(relativePath);
      const bytes = Buffer.from(`<p>${relativePath}</p>`);
      const start = offset < 0 ? Math.max(0, bytes.length + offset) : Math.min(offset, bytes.length);
      const count = Math.min(length, bytes.length - start);
      return { ok: true, size: bytes.length, offset: start, length: count, resolvedPath: relativePath, chunks: (async function* () { yield bytes.subarray(start, start + count); })() };
    }),
    watch: vi.fn((base: string, _glob: string, listener: (event: WatchEvent) => void) => {
      const watch: Watch = { base, listener, disposed: false };
      h.watches.push(watch);
      return { dispose: () => { watch.disposed = true; }, ready: Promise.resolve() };
    }),
  };
  const deps: HtmlPreviewsDeps = {
    projects: () => h.projects,
    files: () => {
      if (h.offline) throw new NotConnectedError('build-box is not connected.');
      return files;
    },
    authorityOs: () => 'win32',
    isTrusted: (project) => h.trusted.has(project.key),
    requestTrust: vi.fn(async () => true),
    onDidSave: (listener): Disposable => {
      h.save = listener;
      return { dispose: () => { h.save = undefined; } };
    },
    hostName: () => 'build-box',
    openExternal: vi.fn(async (url: string) => {
      h.opened.push(url);
      return true;
    }),
    openInBrowserFailed: vi.fn(),
    changed: () => h.changed.count++,
    createSession: async (session) => {
      h.session = session;
    },
    refusalText: () => 'Open this preview from Damocles.',
    focusAway: vi.fn(),
    focusPart: vi.fn(),
    log: () => undefined,
    platform: 'win32',
  };
  Object.assign(h, { deps, files, previews: new HtmlPreviews(deps) });
  h.previews.attach(window as unknown as Parameters<HtmlPreviews['attach']>[0], vi.fn());
  return h;
}

const site = (relativePath: string): FileRef => ({ projectKey: LOCAL.key, relativePath });
const views = (h: Harness): FakeView[] => h.window.children as FakeView[];
const frame = (tabId: string) => ({ tabId, bounds: { x: 300, y: 100, width: 640, height: 400 }, radius: 8 });

/** Opens the tab active, lets its view load and the shell report its card. */
async function shown(h: Harness, tabs: ReadonlyArray<{ tabId: string; file: FileRef }>, tabId: string): Promise<FakeView> {
  h.previews.tabsChanged(tabs, tabId);
  await flush();
  const view = views(h).at(-1)!;
  view.webContents.emit('did-finish-load');
  h.previews.setBounds(frame(tabId));
  return view;
}

const tokenOf = (view: FakeView): string => new URL(view.webContents.getURL()).host;

let h: Harness;
beforeEach(() => {
  h = setUp();
});
afterEach(() => {
  h.previews.dispose();
  vi.useRealTimers();
});

describe('HTML preview views', () => {
  it('builds a sandboxed view with no preload on the html-preview partition, scripts off in an untrusted project', async () => {
    const view = await shown(h, [{ tabId: 't1', file: site('pages/index.html') }], 't1');
    expect(webPreferences).toEqual([{
      partition: 'html-preview',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      javascript: false,
      disableDialogs: true,
      devTools: false,
      spellcheck: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      focusOnNavigation: false,
    }]);
    expect(view.webContents.getURL()).toMatch(/^damocles-preview:\/\/[0-9a-f]{32}\/pages\/index\.html$/);
    expect((view.webContents as unknown as { setWebRTCIPHandlingPolicy: ReturnType<typeof vi.fn> }).setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('default_public_interface_only');
    expect(h.previews.state('t1')).toEqual({ status: 'ready', trusted: false });
    expect(view.getVisible()).toBe(true);
    expect(view.setBorderRadius).toHaveBeenCalledWith(8);
  });

  it('shows a view only while its tab is active, ready and covered by the reported card', async () => {
    const tabs = [{ tabId: 't1', file: site('a.html') }, { tabId: 't2', file: site('b.html') }];
    h.previews.tabsChanged(tabs, 't1');
    await flush();
    const first = views(h)[0]!;
    expect(first.getVisible()).toBe(false);
    first.webContents.emit('did-finish-load');
    expect(first.getVisible()).toBe(false);
    h.previews.setBounds(frame('t2'));
    expect(first.getVisible()).toBe(false);
    h.previews.setBounds(frame('t1'));
    expect(first.getVisible()).toBe(true);
    h.previews.tabsChanged(tabs, 't2');
    expect(first.getVisible()).toBe(false);
    h.previews.setBounds(undefined);
    h.previews.tabsChanged(tabs, 't1');
    expect(first.getVisible()).toBe(false);
  });

  it('focuses a preview\'s page only while its view shows, and F6 and Shift+F6 there move focus a part on or back, unseen by the page', async () => {
    const tabs = [{ tabId: 't1', file: site('a.html') }, { tabId: 't2', file: site('b.html') }];
    h.previews.tabsChanged(tabs, 't1');
    await flush();
    const view = views(h)[0]!;
    expect(h.previews.focusPage('t1')).toBe(false);
    view.webContents.emit('did-finish-load');
    expect(h.previews.focusPage('t1')).toBe(false);
    h.previews.setBounds(frame('t1'));
    expect([h.previews.focusPage('t2'), h.previews.focusPage('t9')]).toEqual([false, false]);
    expect(view.webContents.focus).not.toHaveBeenCalled();
    expect(h.previews.focusPage('t1')).toBe(true);
    expect(view.webContents.focus).toHaveBeenCalledOnce();
    const press = (shift: boolean): boolean => {
      const event = { preventDefault: vi.fn() };
      view.webContents.emit('before-input-event', event, { type: 'keyDown', key: 'F6', shift, control: false, alt: false, meta: false });
      return event.preventDefault.mock.calls.length > 0;
    };
    expect([press(false), press(true)]).toEqual([true, true]);
    expect((h.deps.focusPart as Mock).mock.calls).toEqual([[1], [-1]]);
  });

  it('gives every preview of one root the same origin and another root its own', async () => {
    const a = await shown(h, [{ tabId: 't1', file: site('a.html') }], 't1');
    const b = await shown(h, [{ tabId: 't1', file: site('a.html') }, { tabId: 't2', file: site('sub/b.html') }], 't2');
    const c = await shown(h, [{ tabId: 't1', file: site('a.html') }, { tabId: 't2', file: site('sub/b.html') }, { tabId: 't3', file: { projectKey: OTHER.key, relativePath: 'c.html' } }], 't3');
    expect(tokenOf(a)).toBe(tokenOf(b));
    expect(tokenOf(c)).not.toBe(tokenOf(a));
    expect(h.session!.tokenOf(a.webContents.id)).toBe(tokenOf(a));
    expect(h.session!.tokenOf(c.webContents.id)).toBe(tokenOf(c));
  });

  it('marks a missing page failed and a page whose host dropped offline', async () => {
    h.previews.tabsChanged([{ tabId: 't1', file: site('gone.html') }], 't1');
    await flush();
    const view = views(h)[0]!;
    view.webContents.emit('did-navigate', {}, view.webContents.getURL(), 404);
    view.webContents.emit('did-finish-load');
    expect(h.previews.state('t1').status).toBe('failed');
    h.offline = true;
    h.previews.connectionsChanged();
    expect(h.previews.state('t1').status).toBe('offline');
  });
});

describe('the damocles-preview handler', () => {
  it("serves a root's files with the CSP of its trust, and nothing of a root no preview holds", async () => {
    h.trusted.add(LOCAL.key);
    const view = await shown(h, [{ tabId: 't1', file: site('index.html') }], 't1');
    const page = await h.previews.handle(new Request(`damocles-preview://${tokenOf(view)}/css/a.css`));
    expect(page.status).toBe(200);
    expect(await page.text()).toBe('<p>css/a.css</p>');
    expect(page.headers.get('content-security-policy')).toBe("sandbox allow-scripts allow-same-origin allow-forms allow-popups; object-src 'none'; base-uri 'self'");
    expect((await h.previews.handle(new Request(`damocles-preview://${tokenOf(view)}/.env`))).status).toBe(404);
    expect((await h.previews.handle(new Request(`damocles-preview://${'f'.repeat(32)}/index.html`))).status).toBe(404);
    expect(h.reads).toEqual(['css/a.css']);
  });

  it('serves a media seek\'s byte range as 206 through the root\'s ranged read, and refuses a denied path whatever its Range', async () => {
    const view = await shown(h, [{ tabId: 't1', file: site('index.html') }], 't1');
    const url = `damocles-preview://${tokenOf(view)}/media/clip.mp4`;
    const part = await h.previews.handle(new Request(url, { headers: { Range: 'bytes=3-7' } }));
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('media');
    expect(part.headers.get('content-range')).toBe('bytes 3-7/21');
    expect(part.headers.get('content-length')).toBe('5');
    expect(part.headers.get('accept-ranges')).toBe('bytes');
    expect(part.headers.get('content-type')).toBe('video/mp4');
    expect(part.headers.get('x-content-type-options')).toBe('nosniff');
    expect(part.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    const past = await h.previews.handle(new Request(url, { headers: { Range: 'bytes=21-' } }));
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe('bytes */21');
    expect(h.files.readFileRange).toHaveBeenCalledWith(LOCAL, 'media/clip.mp4', 3, 5);
    expect((await h.previews.handle(new Request(`damocles-preview://${tokenOf(view)}/.env`, { headers: { Range: 'bytes=0-' } }))).status).toBe(404);
    expect(h.reads).toEqual(['media/clip.mp4', 'media/clip.mp4']);
  });

  it('serves nothing from a host whose daemon reads no range with a resolved path, so no file escapes the deny list there', async () => {
    h.rangeless = true;
    const view = await shown(h, [{ tabId: 't1', file: site('index.html') }], 't1');
    const answer = await h.previews.handle(new Request(`damocles-preview://${tokenOf(view)}/media/clip.mp4`));
    expect(answer.status).toBe(500);
    expect(await answer.text()).toBe('');
    expect(h.reads).toEqual([]);
  });
});

describe('reload on save', () => {
  it('watches each served file\'s folder once and reloads once per burst of changes to a served file', async () => {
    const view = await shown(h, [{ tabId: 't1', file: site('index.html') }], 't1');
    for (const pathname of ['/index.html', '/css/a.css', '/css/b.css', '/img/x.png']) h.session!.served(view.webContents.id, pathname);
    expect(h.watches.map((watch) => watch.base)).toEqual(['C:\\work\\site', 'C:\\work\\site\\css', 'C:\\work\\site\\img']);
    vi.useFakeTimers();
    const css = h.watches[1]!;
    css.listener({ kind: 'change', path: 'C:\\work\\site\\css\\A.CSS' });
    css.listener({ kind: 'change', path: 'C:\\work\\site\\css\\b.css' });
    css.listener({ kind: 'create', path: 'C:\\work\\site\\css\\unrelated.css' });
    vi.advanceTimersByTime(RELOAD_DEBOUNCE_MS - 1);
    expect(view.webContents.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(view.webContents.reload).toHaveBeenCalledOnce();
    h.watches[0]!.listener({ kind: 'change', path: 'C:\\work\\site\\other.html' });
    vi.advanceTimersByTime(RELOAD_DEBOUNCE_MS);
    expect(view.webContents.reload).toHaveBeenCalledOnce();
  });

  it('reloads on an editor save of a served file of the same root, and on no other save', async () => {
    const view = await shown(h, [{ tabId: 't1', file: site('index.html') }], 't1');
    h.session!.served(view.webContents.id, '/js/app.js');
    vi.useFakeTimers();
    h.save!({ path: 'C:\\work\\docs\\js\\app.js', projectKey: OTHER.key, relativePath: 'js/app.js' });
    h.save!({ path: 'C:\\work\\site\\js\\other.js', projectKey: LOCAL.key, relativePath: 'js/other.js' });
    vi.advanceTimersByTime(RELOAD_DEBOUNCE_MS);
    expect(view.webContents.reload).not.toHaveBeenCalled();
    h.save!({ path: 'C:\\work\\site\\js\\app.js', projectKey: LOCAL.key, relativePath: 'js/app.js' });
    h.save!({ path: 'C:\\work\\site\\js\\app.js', projectKey: LOCAL.key, relativePath: 'js/app.js' });
    vi.advanceTimersByTime(RELOAD_DEBOUNCE_MS);
    expect(view.webContents.reload).toHaveBeenCalledOnce();
  });

  it('drops the watches while the host is away, and watches again and reloads once it is back', async () => {
    const view = await shown(h, [{ tabId: 't1', file: site('index.html') }], 't1');
    h.session!.served(view.webContents.id, '/index.html');
    h.offline = true;
    h.previews.connectionsChanged();
    expect(h.watches[0]!.disposed).toBe(true);
    h.offline = false;
    h.previews.connectionsChanged();
    expect(h.watches).toHaveLength(2);
    expect(h.watches[1]!.disposed).toBe(false);
    expect(view.webContents.reload).toHaveBeenCalledOnce();
    expect(h.previews.state('t1').status).toBe('loading');
  });
});

describe('trust', () => {
  it('rebuilds a root\'s views with scripts on once it is trusted, with no reopen, and leaves other roots alone', async () => {
    const tabs = [{ tabId: 't1', file: site('index.html') }, { tabId: 't2', file: { projectKey: OTHER.key, relativePath: 'c.html' } }];
    const untrusted = await shown(h, tabs, 't1');
    const other = await shown(h, tabs, 't2');
    await shown(h, tabs, 't1');
    const before = h.changed.count;
    h.previews.trustChanged();
    expect(h.changed.count).toBe(before);
    h.trusted.add(LOCAL.key);
    h.previews.trustChanged();
    expect(untrusted.webContents.close).toHaveBeenCalled();
    expect(other.webContents.close).not.toHaveBeenCalled();
    expect(h.previews.state('t1')).toEqual({ status: 'loading', trusted: true });
    await flush();
    const rebuilt = views(h).at(-1)!;
    expect(webPreferences.at(-1)).toMatchObject({ javascript: true });
    expect(tokenOf(rebuilt)).toBe(tokenOf(untrusted));
  });

  it('asks for trust through the project\'s own trust request, and answers the action once the user answered it', async () => {
    await shown(h, [{ tabId: 't1', file: site('index.html') }], 't1');
    let answer: (trusted: boolean) => void = () => undefined;
    vi.mocked(h.deps.requestTrust).mockReturnValueOnce(new Promise((resolve) => {
      answer = resolve;
    }));
    let settled = false;
    const action = h.previews.action({ tabId: 't1', action: 'trustFolder' }).then(() => {
      settled = true;
    });
    await flush();
    expect(h.deps.requestTrust).toHaveBeenCalledWith(LOCAL);
    expect(settled).toBe(false);
    answer(true);
    await action;
    expect(settled).toBe(true);
  });

  it('closes a root\'s browser port, and with it its cookie secret, once the root is no longer trusted', async () => {
    h.trusted.add(LOCAL.key);
    await shown(h, [{ tabId: 't1', file: site('index.html') }], 't1');
    await h.previews.action({ tabId: 't1', action: 'openInBrowser' });
    const first = new URL(h.opened[0]!);
    h.trusted.delete(LOCAL.key);
    h.previews.trustChanged();
    await flush();
    await expect(new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: Number(first.port), path: '/', agent: false }, resolve).on('error', reject))).rejects.toThrow();
    // the next Open in Browser starts a new server, with a new secret
    await h.previews.action({ tabId: 't1', action: 'openInBrowser' });
    expect(h.opened).toHaveLength(2);
  });

  it('takes the trust a root\'s project has once the project list names it', async () => {
    const late: Project = { key: 'C:\\work\\late', fsPath: 'C:\\work\\late', name: 'late' };
    h.trusted.add(late.key);
    await shown(h, [{ tabId: 't1', file: { projectKey: late.key, relativePath: 'index.html' } }], 't1');
    expect(h.previews.state('t1').trusted).toBe(false);
    h.projects.push(late);
    h.previews.trustChanged();
    expect(h.previews.state('t1').trusted).toBe(true);
  });
});

describe('closing', () => {
  it("closes the view and revokes the root's token with its last preview, and closes the root's browser port", async () => {
    const tabs = [{ tabId: 't1', file: site('a.html') }, { tabId: 't2', file: site('b.html') }];
    const a = await shown(h, tabs, 't1');
    await h.previews.action({ tabId: 't1', action: 'openInBrowser' });
    const opened = new URL(h.opened[0]!);
    expect(opened.pathname).toBe('/__damocles_preview/open');
    expect(opened.hostname).toBe('127.0.0.1');
    const token = tokenOf(a);
    h.previews.tabsChanged([tabs[1]!], 't2');
    expect(a.webContents.close).toHaveBeenCalled();
    expect(h.session!.tokenOf(a.webContents.id)).toBeUndefined();
    // the other preview of the root keeps the root's origin and port
    expect((await h.previews.handle(new Request(`damocles-preview://${token}/b.html`))).status).toBe(200);
    h.previews.tabsChanged([], null);
    expect((await h.previews.handle(new Request(`damocles-preview://${token}/b.html`))).status).toBe(404);
    expect(() => h.previews.state('t2')).toThrow();
    await flush();
    await expect(new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: Number(opened.port), path: '/', agent: false }, resolve).on('error', reject))).rejects.toThrow();
  });

  it('drops every view with the window and builds the active one again in the next window', async () => {
    const view = await shown(h, [{ tabId: 't1', file: site('a.html') }], 't1');
    h.previews.detach();
    expect(view.webContents.close).toHaveBeenCalled();
    const next = fakeWindow(1600);
    h.previews.attach(next as unknown as Parameters<HtmlPreviews['attach']>[0], vi.fn());
    expect(next.children).toHaveLength(1);
    expect(h.previews.state('t1').status).toBe('loading');
  });
});

describe('links out of a preview', () => {
  // the view hardened as app.on('web-contents-created') hardens every WebContents, recording what opens outside
  function hardened(view: FakeView): { readonly opened: string[]; readonly popup: (url: string) => unknown } {
    let handler: ((details: { url: string }) => unknown) | undefined;
    Object.assign(view.webContents, { setWindowOpenHandler: (next: typeof handler) => { handler = next; } });
    const opened: string[] = [];
    hardenWebContents(view.webContents as unknown as WebContents, async (url) => {
      opened.push(url);
      return true;
    }, () => undefined);
    return { opened, popup: (url) => handler!({ url }) };
  }
  const click = (view: FakeView): void => {
    view.webContents.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left', modifiers: [] });
  };
  // a main-frame navigation as Electron reports it: did-start-navigation, then will-navigate
  const navigate = (view: FakeView, url: string): { preventDefault: Mock } => {
    view.webContents.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false });
    const event = { url, preventDefault: vi.fn() };
    view.webContents.emit('will-navigate', event);
    return event;
  };

  it('opens a clicked http(s) link outside once, and a script\'s navigation after it never', async () => {
    const view = await shown(h, [{ tabId: 't1', file: site('index.html') }], 't1');
    const links = hardened(view);
    click(view);
    expect(navigate(view, 'https://example.com/docs').preventDefault).toHaveBeenCalled();
    expect(navigate(view, 'https://example.com/again').preventDefault).toHaveBeenCalled();
    expect(links.opened).toEqual(['https://example.com/docs']);
  });

  it('spends a click on the same-origin page it loads, so that page\'s script cannot open a link with it', async () => {
    const view = await shown(h, [{ tabId: 't1', file: site('index.html') }], 't1');
    const links = hardened(view);
    click(view);
    expect(navigate(view, `damocles-preview://${tokenOf(view)}/next.html`).preventDefault).not.toHaveBeenCalled();
    expect(navigate(view, 'https://example.com/').preventDefault).toHaveBeenCalled();
    expect(links.popup('https://example.com/popup')).toEqual({ action: 'deny' });
    expect(links.opened).toEqual([]);
  });

  it('spends a click on a navigation that was refused, so an http(s) one after it opens nothing', async () => {
    const view = await shown(h, [{ tabId: 't1', file: site('index.html') }], 't1');
    const links = hardened(view);
    for (const refused of ['about:blank', 'data:text/html,x', `damocles-preview://${'f'.repeat(32)}/a.html`]) {
      click(view);
      expect(navigate(view, refused).preventDefault, refused).toHaveBeenCalled();
      expect(navigate(view, 'https://example.com/').preventDefault, refused).toHaveBeenCalled();
    }
    expect(links.opened).toEqual([]);
  });

  it('opens a clicked popup outside, and nothing once the view lost focus', async () => {
    const view = await shown(h, [{ tabId: 't1', file: site('index.html') }], 't1');
    const links = hardened(view);
    click(view);
    expect(links.popup('https://example.com/popup')).toEqual({ action: 'deny' });
    click(view);
    view.webContents.emit('blur');
    expect(links.popup('https://example.com/blurred')).toEqual({ action: 'deny' });
    click(view);
    view.webContents.emit('blur');
    expect(navigate(view, 'https://example.com/blurred').preventDefault).toHaveBeenCalled();
    expect(links.opened).toEqual(['https://example.com/popup']);
  });
});
