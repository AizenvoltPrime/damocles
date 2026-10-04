import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeIpc extends EventEmitter {
    readonly handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void {
      this.handlers.set(channel, handler);
    }
    removeHandler(channel: string): void {
      this.handlers.delete(channel);
    }
  }
  class FakeWebContents extends EventEmitter {
    readonly id = 7;
    readonly ipc = new FakeIpc();
    readonly send = vi.fn();
    readonly close = vi.fn();
    readonly focus = vi.fn();
    readonly setZoomFactor = vi.fn();
    readonly loadURL = vi.fn(async () => undefined);
    isDestroyed(): boolean {
      return false;
    }
    isCrashed(): boolean {
      return false;
    }
    isFocused(): boolean {
      return false;
    }
  }
  class WebContentsView {
    readonly webContents = new FakeWebContents();
    readonly options: unknown;
    readonly setBackgroundColor = vi.fn();
    readonly setVisible = vi.fn();
    constructor(options: unknown) {
      this.options = options;
    }
  }
  return { WebContentsView, nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() }, protocol: {} };
});

import { EventEmitter } from 'node:events';
import { MAX_PANE_ID_LENGTH, MAX_PANE_URL_LENGTH, PANE_CHANNELS } from '../../preload/pane-channels';
import { PANEL_CHANNELS } from '../../preload/panel-channels';
import { SHELL_CHANNELS } from '../../preload/shell-channels';
import { PaneHost, isPaneId, paneAddress, paneHtml, type PaneActions } from '../pane';
import { PANE_PAGE_URL, SHELL_PAGE_URL, panelPageUrl, resolveAppRequest } from '../protocol';

type FakeContents = EventEmitter & {
  ipc: EventEmitter & { handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> };
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setZoomFactor: ReturnType<typeof vi.fn>;
};

const calls: string[] = [];
const actions: PaneActions = new Proxy({} as PaneActions, {
  get: (_target, name: string) => (...args: unknown[]) => {
    calls.push([name, ...args].join(':'));
    return name === 'state' ? { mode: 'collapsed' } : undefined;
  },
});

let lines: string[];
let host: PaneHost;
let contents: FakeContents;

beforeEach(() => {
  calls.length = 0;
  lines = [];
  host = new PaneHost('preload-pane.js', actions, (line) => lines.push(line), vi.fn());
  contents = host.view.webContents as unknown as FakeContents;
});

const own = (): { sender: unknown; senderFrame: { url: string; parent: unknown } } => ({ sender: contents, senderFrame: { url: PANE_PAGE_URL, parent: null } });

// Every invoke channel with arguments that pass validation, so only the sender decides.
const INVOKES: ReadonlyArray<[string, unknown[]]> = [
  [PANE_CHANNELS.getState, []],
  [PANE_CHANNELS.selectPage, ['p1']],
  [PANE_CHANNELS.closePage, ['p1']],
  [PANE_CHANNELS.newPage, []],
  [PANE_CHANNELS.navigate, ['p1', 'https://example.com/']],
  [PANE_CHANNELS.goBack, ['p1']],
  [PANE_CHANNELS.goForward, ['p1']],
  [PANE_CHANNELS.reload, ['p1']],
  [PANE_CHANNELS.openExternal, ['p1']],
  [PANE_CHANNELS.pickElement, ['p1']],
  [PANE_CHANNELS.openDevTools, ['p1']],
  [PANE_CHANNELS.setMaximized, [true]],
  [PANE_CHANNELS.setCollapsed, [true]],
];

describe('pane page', () => {
  it('is served in memory at an exact URL no panel or shell path matches', () => {
    expect(PANE_PAGE_URL).toBe('app://damocles/pane/index.html');
    expect(resolveAppRequest(PANE_PAGE_URL, process.cwd())).toEqual({ kind: 'pane' });
    expect(resolveAppRequest('app://damocles/pane/other.html', process.cwd())).toBeUndefined();
    expect(PANE_PAGE_URL).not.toBe(SHELL_PAGE_URL);
    expect(panelPageUrl('pane')).not.toBe(PANE_PAGE_URL);
  });

  it('locks script-src to a fresh nonce and allows images only as data: URLs', () => {
    const first = paneHtml({ kind: 'dark', css: '', reducedMotion: false });
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(first)?.[1] ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(csp).toBe(`default-src 'none'; style-src app://damocles 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src app://damocles; img-src data:; base-uri 'none'; form-action 'none';`);
    expect(first).toContain(`<script nonce="${nonce}" type="module" src="app://damocles/desktop-shell/assets/pane.js"></script>`);
    expect(first).toContain('<link href="app://damocles/desktop-shell/assets/pane.css" rel="stylesheet">');
    expect(paneHtml({ kind: 'light', css: '', reducedMotion: false })).not.toContain(`'nonce-${nonce}'`);
    expect(paneHtml({ kind: 'light', css: '', reducedMotion: true })).toContain('<html lang="en" data-reduced-motion>');
  });

  it('runs sandboxed and isolated with its own preload, on a transparent background, and loads the pane URL', () => {
    const options = (host.view as unknown as { options: { webPreferences: Record<string, unknown> } }).options.webPreferences;
    expect(options).toMatchObject({ preload: 'preload-pane.js', contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true });
    expect(host.view.setBackgroundColor).toHaveBeenCalledWith('#00000000');
    host.load();
    expect((contents as unknown as { loadURL: ReturnType<typeof vi.fn> }).loadURL).toHaveBeenCalledWith(PANE_PAGE_URL);
  });

  it('registers only pane channels, never a shell or panel one', () => {
    const registered = [...contents.ipc.handlers.keys(), ...contents.ipc.eventNames().map(String)];
    expect(registered.sort()).toEqual(Object.values(PANE_CHANNELS).filter((channel) => channel !== PANE_CHANNELS.state && channel !== PANE_CHANNELS.theme && channel !== PANE_CHANNELS.focus).sort());
    for (const channel of [...Object.values(SHELL_CHANNELS), ...Object.values(PANEL_CHANNELS)]) expect(registered).not.toContain(channel);
  });
});

describe('pane IPC sender checks', () => {
  const senders: ReadonlyArray<[string, () => unknown]> = [
    ['another webContents', () => ({ sender: { id: 99 }, senderFrame: { url: PANE_PAGE_URL, parent: null } })],
    ['a subframe', () => ({ sender: contents, senderFrame: { url: PANE_PAGE_URL, parent: {} } })],
    ['another URL', () => ({ sender: contents, senderFrame: { url: `${PANE_PAGE_URL}#x`, parent: null } })],
    ['a page URL', () => ({ sender: contents, senderFrame: { url: 'https://evil.example/', parent: null } })],
    ['a destroyed frame', () => ({ sender: contents, senderFrame: null })],
  ];

  for (const [channel, args] of INVOKES) {
    it.each(senders)(`rejects ${channel} from %s`, async (_name, event) => {
      await expect(contents.ipc.handlers.get(channel)!(event(), ...args)).rejects.toThrow('Rejected');
      expect(calls).toEqual([]);
      expect(lines.some((line) => line.startsWith(`[pane] rejected ${channel}`))).toBe(true);
    });
  }

  it.each(senders)('rejects a width request from %s', (_name, event) => {
    contents.ipc.emit(PANE_CHANNELS.requestWidth, event(), 500, true);
    expect(calls).toEqual([]);
  });

  it('accepts each channel from the pane page main frame', async () => {
    for (const [channel, args] of INVOKES) await contents.ipc.handlers.get(channel)!(own(), ...args);
    contents.ipc.emit(PANE_CHANNELS.requestWidth, own(), 500, true);
    expect(calls).toEqual([
      'state', 'selectPage:p1', 'closePage:p1', 'newPage', 'navigate:p1:https://example.com/', 'goBack:p1', 'goForward:p1',
      'reload:p1', 'openExternal:p1', 'pickElement:p1', 'openDevTools:p1', 'setMaximized:true', 'setCollapsed:true', 'requestWidth:500:true',
    ]);
  });
});

describe('pane payload bounds', () => {
  it('bounds page ids', async () => {
    expect(isPaneId('a')).toBe(true);
    expect(isPaneId('x'.repeat(MAX_PANE_ID_LENGTH))).toBe(true);
    expect(isPaneId('x'.repeat(MAX_PANE_ID_LENGTH + 1))).toBe(false);
    expect(isPaneId('')).toBe(false);
    expect(isPaneId(3)).toBe(false);
    for (const channel of [PANE_CHANNELS.selectPage, PANE_CHANNELS.closePage, PANE_CHANNELS.reload, PANE_CHANNELS.openExternal]) {
      await expect(contents.ipc.handlers.get(channel)!(own(), { id: 'p1' })).rejects.toThrow('Malformed page id');
    }
    expect(calls).toEqual([]);
  });

  it('normalizes and bounds addresses, refusing every non-web scheme', async () => {
    expect(paneAddress('example.com')).toBe('https://example.com');
    expect(paneAddress('  http://a.example/  ')).toBe('http://a.example/');
    expect(paneAddress('about:blank')).toBe('about:blank');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'chrome://settings', '', '   ', 42, null, `https://a.example/${'x'.repeat(MAX_PANE_URL_LENGTH)}`]) {
      expect(paneAddress(bad)).toBeUndefined();
    }
    expect(await contents.ipc.handlers.get(PANE_CHANNELS.navigate)!(own(), 'p1', 'file:///c:/x')).toBe(false);
    expect(calls).toEqual([]);
  });

  it('accepts only boolean flags and a finite in-range width with a boolean commit', async () => {
    await expect(contents.ipc.handlers.get(PANE_CHANNELS.setMaximized)!(own(), 1)).rejects.toThrow('Malformed flag');
    for (const [width, commit] of [[Number.NaN, true], [Number.POSITIVE_INFINITY, false], [-1, true], [100_001, true], ['500', true], [500, 1]]) {
      contents.ipc.emit(PANE_CHANNELS.requestWidth, own(), width, commit);
    }
    expect(calls).toEqual([]);
  });

  it('removes its handlers and closes its page on dispose', () => {
    host.dispose();
    expect(contents.ipc.handlers.size).toBe(0);
    expect(contents.ipc.eventNames()).toEqual([]);
    expect(contents.close).toHaveBeenCalled();
  });

  it('sends state only once the page loaded, at zoom factor 1', async () => {
    host.stateChanged();
    await new Promise((resolve) => setImmediate(resolve));
    expect(contents.send).not.toHaveBeenCalled();
    contents.emit('did-finish-load');
    expect(contents.setZoomFactor).toHaveBeenCalledWith(1);
    expect(contents.send).toHaveBeenCalledWith(PANE_CHANNELS.state, { mode: 'collapsed' });
  });
});
