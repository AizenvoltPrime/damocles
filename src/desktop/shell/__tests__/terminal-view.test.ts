// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { shallowRef } from 'vue';
import type { IBufferRange, ILink, ILinkHandler, ILinkProvider } from '@xterm/xterm';
import type { ShellHost, ShellPlatform } from '../../preload/shell-channels';
import { OFFLINE_GRACE_MS } from '@shared/host-connection';
import type { TerminalInfo, TerminalSettings, TerminalShellEvent } from '../../preload/terminal-channels';
import TerminalFind from '../terminal/TerminalFind.vue';
import TerminalView from '../terminal/TerminalView.vue';
import { terminalStatusLabel } from '../terminal/terminal-menu';
import { TERMINAL_STORE, type TerminalSink, type TerminalStore } from '../terminal/terminal-store';
import { shellI18n } from '../i18n';
import { TERMINAL_STATE, fakeShellApi, type FakeShellApi } from './fakes';

interface FakeMarker {
  line: number;
  isDisposed: boolean;
  dispose(): void;
}

// A stand-in xterm with what the view reads: its options, markers that Clear disposes, decorations that refuse a disposed
// marker (as xterm's DecorationService does), link providers, the key handler and a buffer of plain text rows.
interface FakeXterm {
  options: Record<string, unknown>;
  modes: { bracketedPasteMode: boolean; mouseTrackingMode: string };
  markers: FakeMarker[];
  decorated: FakeMarker[];
  linkProviders: ILinkProvider[];
  keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
  lines: string[];
  // what the view wrote, in order, since the last reset
  written: string[];
  resets: number;
  buffer: { active: { cursorX: number; type: 'normal' | 'alternate' } };
  typed(data: string): void;
  csi(params: number[]): void;
}
const xterms: FakeXterm[] = [];

vi.mock('@xterm/xterm', () => {
  const disposable = { dispose: () => undefined };
  class Terminal implements FakeXterm {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    element: HTMLElement | undefined;
    modes = { bracketedPasteMode: false, mouseTrackingMode: 'none' };
    unicode = { activeVersion: '' };
    markers: FakeMarker[] = [];
    decorated: FakeMarker[] = [];
    linkProviders: ILinkProvider[] = [];
    keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
    lines: string[] = [];
    written: string[] = [];
    buffer = {
      active: {
        type: 'normal' as 'normal' | 'alternate',
        viewportY: 0,
        baseY: 0,
        cursorX: 10,
        cursorY: 0,
        getNullCell: () => ({}),
        getLine: (y: number) => {
          const text = this.lines[y];
          if (text === undefined) return undefined;
          return { isWrapped: false, getCell: (x: number) => ({ getWidth: () => 1, getChars: () => text[x] ?? '' }) };
        },
      },
    };
    dataListeners: Array<(data: string) => void> = [];
    csiHandlers: Array<(params: number[]) => boolean> = [];
    parser = {
      registerCsiHandler: (_id: unknown, handler: (params: number[]) => boolean) => {
        this.csiHandlers.push(handler);
        return disposable;
      },
    };
    typed(data: string): void {
      for (const listener of this.dataListeners) listener(data);
    }
    csi(params: number[]): void {
      for (const handler of this.csiHandlers) handler(params);
    }
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      xterms.push(this);
    }
    loadAddon(addon: { activate?: (terminal: Terminal) => void }): void {
      addon.activate?.(this);
    }
    registerLinkProvider(provider: ILinkProvider) {
      this.linkProviders.push(provider);
      return disposable;
    }
    // the buffer's base and the cursor's row are 0, so a marker's line is its offset
    registerMarker(offset = 0): FakeMarker {
      const marker: FakeMarker = { line: offset, isDisposed: false, dispose: () => { marker.isDisposed = true; } };
      this.markers.push(marker);
      return marker;
    }
    registerDecoration({ marker }: { marker: FakeMarker }) {
      if (marker.isDisposed) return undefined;
      this.decorated.push(marker);
      return { onRender: () => disposable, onDispose: () => disposable, dispose: () => undefined };
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      this.keyHandler = handler;
    }
    onData = (listener: (data: string) => void) => {
      this.dataListeners.push(listener);
      return disposable;
    };
    onBinary = () => disposable;
    onScroll = () => disposable;
    onResize = () => disposable;
    onWriteParsed = () => disposable;
    open(parent: HTMLElement): void {
      this.element = document.createElement('div');
      const screen = document.createElement('div');
      screen.className = 'xterm-screen';
      this.element.append(screen);
      parent.append(this.element);
    }
    write(data: string, callback?: () => void): void {
      this.written.push(data);
      callback?.();
    }
    resize(cols: number, rows: number): void {
      this.cols = cols;
      this.rows = rows;
    }
    clear(): void {
      for (const marker of this.markers) marker.dispose();
    }
    resets = 0;
    reset(): void {
      this.resets++;
      this.written = [];
      for (const marker of this.markers) marker.dispose();
    }
    focus(): void {}
    hasSelection = () => false;
    selectAll(): void {}
    scrollToBottom(): void {}
    dispose(): void {}
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions = () => undefined; fit(): void {} } }));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    onDidChangeResults = () => ({ dispose: () => undefined });
    findNext(): void {}
    findPrevious(): void {}
    clearDecorations(): void {}
  },
}));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const fontsLoad = vi.fn<(font: string) => Promise<unknown[]>>();

beforeEach(() => {
  xterms.length = 0;
  fontsLoad.mockReset();
  fontsLoad.mockResolvedValue([]);
  Object.defineProperty(document, 'fonts', { value: { load: fontsLoad }, configurable: true });
  vi.stubGlobal('IntersectionObserver', class {
    observe(): void {}
    disconnect(): void {}
  });
});

let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.unstubAllGlobals();
});

const info: TerminalInfo = {
  id: 'term-1', title: 'bash', name: null, profileId: 'bash', icon: 'bash', customIcon: null, color: null, projectKey: 'alpha', projectName: 'alpha', status: 'running', exitCode: null, description: null, running: null, integrated: true, restoring: false, windowsBuild: null, pathFlavor: 'posix',
};

interface MountOptions {
  platform?: ShellPlatform;
  settings?: Partial<TerminalSettings>;
  screenReader?: boolean;
  windowsBuild?: number | null;
  pathFlavor?: TerminalInfo['pathFlavor'];
  integrated?: boolean;
  restoring?: boolean;
  status?: TerminalInfo['status'];
  // a screen waits in the store for this view
  screenWaits?: () => boolean;
  host?: ShellHost;
}

async function mountView(options: MountOptions = {}): Promise<{ api: FakeShellApi; xterm: FakeXterm | undefined; sinks: TerminalSink[]; requestFocus: ReturnType<typeof vi.fn> }> {
  const api = fakeShellApi();
  const sinks: TerminalSink[] = [];
  const requestFocus = vi.fn();
  const store = {
    state: shallowRef(TERMINAL_STATE),
    focusRequest: shallowRef(null),
    pasteRequest: shallowRef(null),
    actionRequest: shallowRef(null),
    requestFocus,
    screenWaits: options.screenWaits ?? (() => false),
    attach: (_id: string, sink: TerminalSink) => {
      sinks.push(sink);
      return () => undefined;
    },
  } as unknown as TerminalStore;
  wrapper = mount(TerminalView, {
    props: {
      api,
      terminal: { ...info, status: options.status ?? info.status, integrated: options.integrated ?? true, restoring: options.restoring ?? false, windowsBuild: options.windowsBuild ?? null, pathFlavor: options.pathFlavor ?? 'posix' },
      shown: true,
      settings: { ...TERMINAL_STATE.settings, ...options.settings },
      passKeys: [],
      platform: options.platform ?? 'linux',
      splitShortcut: 'Ctrl+Shift+5',
      screenReader: options.screenReader ?? false,
      ...(options.host ? { remoteHost: options.host } : {}),
    },
    global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: store } },
    attachTo: document.body,
  });
  await flushPromises();
  return { api, xterm: xterms.at(-1), sinks, requestFocus };
}

const key = (code: string, init: KeyboardEventInit = {}): KeyboardEvent => new KeyboardEvent('keydown', { code, key: code, ...init });
const shellEvents = (sink: TerminalSink, ...events: TerminalShellEvent[]): void => sink({ data: '', events: events.map((event) => ({ offset: 0, event })) });
const RANGE: IBufferRange = { start: { x: 1, y: 1 }, end: { x: 10, y: 1 } };

describe('a restored remote terminal whose host is not connected', () => {
  it('says Reconnecting until main reattaches it, and its list row and tab read the same state', async () => {
    await mountView({ status: 'reconnecting' });
    const view = wrapper!.get('[data-testid="terminal-view"]');
    expect(view.attributes('data-status')).toBe('reconnecting');
    expect(wrapper!.get('[data-testid="terminal-reconnecting"]').text()).toBe('Reconnecting');
    expect(terminalStatusLabel({ status: 'reconnecting', exitCode: null }, (key) => shellI18n.global.t(key))).toBe('Reconnecting');
    await wrapper!.setProps({ terminal: { ...(wrapper!.props() as { terminal: TerminalInfo }).terminal, status: 'running' } });
    await flushPromises();
    expect(wrapper!.find('[data-testid="terminal-reconnecting"]').exists()).toBe(false);
  });
});

describe('a remote terminal whose host dropped', () => {
  const HOST: ShellHost = { hostId: 'h1', authorityKey: 'ssh+h1', name: 'prod-1', connection: 'offline', signInNeeded: false };

  it('takes no input at once, and shows Reconnecting and dims only once the drop outlasted the grace', async () => {
    const { xterm } = await mountView({ status: 'reconnecting', host: { ...HOST, reconnect: { phase: 'waiting', since: Date.now(), retryAt: Date.now() + 5000 } } });
    expect(xterm!.options.disableStdin).toBe(true);
    expect(wrapper!.find('[data-testid="terminal-reconnecting"]').exists()).toBe(false);
    expect(wrapper!.get('.terminal-host').classes()).not.toContain('opacity-(--d-opacity-disabled)');
    await wrapper!.setProps({ remoteHost: { ...HOST, reconnect: { phase: 'running', since: Date.now() - OFFLINE_GRACE_MS } } });
    await flushPromises();
    expect(wrapper!.get('[data-testid="terminal-reconnecting"]').text()).toBe('Reconnecting');
    expect(wrapper!.get('.terminal-host').classes()).toContain('opacity-(--d-opacity-disabled)');
    await wrapper!.setProps({ terminal: { ...(wrapper!.props() as { terminal: TerminalInfo }).terminal, status: 'running' }, remoteHost: { ...HOST, connection: 'connected' } });
    await flushPromises();
    expect(xterm!.options.disableStdin).toBe(false);
    expect(wrapper!.find('[data-testid="terminal-reconnecting"]').exists()).toBe(false);
  });
});

describe('OSC 8 hyperlinks', () => {
  it('open only on Ctrl+click, through the same window.open web links use, and never ask with window.confirm', async () => {
    const opened = vi.fn();
    const confirm = vi.fn(() => true);
    vi.stubGlobal('open', opened);
    vi.stubGlobal('confirm', confirm);
    const { xterm } = await mountView();
    const handler = xterm!.options.linkHandler as ILinkHandler | undefined;
    expect(handler).toBeDefined();
    expect(handler!.allowNonHttpProtocols).not.toBe(true);
    handler!.activate(new MouseEvent('click'), 'https://gcc.gnu.org/onlinedocs/gcc/Warning-Options.html', RANGE);
    expect(opened).not.toHaveBeenCalled();
    handler!.activate(new MouseEvent('click', { ctrlKey: true }), 'https://gcc.gnu.org/onlinedocs/gcc/Warning-Options.html', RANGE);
    expect(opened).toHaveBeenCalledWith('https://gcc.gnu.org/onlinedocs/gcc/Warning-Options.html');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('show the follow-link hint while hovered, and drop it on leave', async () => {
    const { xterm } = await mountView();
    const handler = xterm!.options.linkHandler as ILinkHandler;
    handler.hover!(new MouseEvent('mousemove'), 'https://example.com', RANGE);
    await flushPromises();
    const hint = wrapper!.find('[data-testid="terminal-link-hint"]');
    expect(hint.exists()).toBe(true);
    expect(hint.attributes('data-kind')).toBe('web');
    handler.leave!(new MouseEvent('mousemove'), 'https://example.com', RANGE);
    await flushPromises();
    expect(wrapper!.find('[data-testid="terminal-link-hint"]').exists()).toBe(false);
  });
});

describe('Linux middle click', () => {
  const middle = (init: MouseEventInit = {}): MouseEvent => new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true, ...init });

  it('pastes the primary selection only while the program tracks no mouse, or with Shift held', async () => {
    const { api, xterm } = await mountView({ platform: 'linux' });
    const host = wrapper!.get('.terminal-host').element;
    xterm!.modes.mouseTrackingMode = 'vt200';
    host.dispatchEvent(middle());
    expect(api.terminal.paste).not.toHaveBeenCalled();
    host.dispatchEvent(middle({ shiftKey: true }));
    expect(api.terminal.paste).toHaveBeenCalledTimes(1);
    xterm!.modes.mouseTrackingMode = 'none';
    host.dispatchEvent(middle());
    expect(api.terminal.paste).toHaveBeenCalledTimes(2);
    expect(api.terminal.paste).toHaveBeenLastCalledWith({ id: 'term-1', bracketedPasteMode: false, source: 'selection' });
  });
});

describe('the terminal menu\'s Clear', () => {
  // xterm.clear keeps the prompt row but disposes every marker, the pending prompt's included (VS Code's clearBuffer).
  it('marks the pending prompt again, so the first command after it gets its mark', async () => {
    const { api, xterm, sinks } = await mountView();
    shellEvents(sinks[0]!, { kind: 'promptStart' }, { kind: 'commandStart' });
    api.answerNext({ kind: 'menu', itemId: 'clear' });
    wrapper!.get('.terminal-host').element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(xterm!.markers.every((marker) => marker.isDisposed)).toBe(false);
    expect(api.terminal.clear).toHaveBeenCalledWith('term-1');
    shellEvents(sinks[0]!, { kind: 'commandExecuted', commandId: 1, commandLine: 'ls', time: 1 });
    expect(xterm!.decorated).toHaveLength(1);
    expect(xterm!.decorated[0]!.isDisposed).toBe(false);
  });
});

describe('a screen restored after the page loaded again', () => {
  it('stays hidden until the screen is written, puts the marks on the normal buffer before the alternate screen, then shows', async () => {
    const { xterm, sinks } = await mountView({ restoring: true });
    const host = wrapper!.get('.terminal-host');
    expect(host.classes()).toContain('invisible');
    sinks[0]!({
      screen: {
        id: 'term-1',
        data: '$ ls\r\na\r\n$ vim\x1b[?1049h\x1b[Hfull screen',
        cols: 100,
        rows: 30,
        marks: [
          { line: 0, event: { kind: 'promptStart' } },
          { line: 0, event: { kind: 'commandExecuted', commandId: 1, commandLine: 'ls', time: 1 } },
          { line: 2, event: { kind: 'commandFinished', commandId: 1, exitCode: 0, time: 2 } },
        ],
      },
    });
    await flushPromises();
    expect(xterm!.written.slice(0, 2)).toEqual(['$ ls\r\na\r\n$ vim', '\x1b[?1049h\x1b[Hfull screen']);
    expect(xterm!.decorated.map((marker) => marker.line)).toEqual([0]);
    expect(xterm!.markers.map((marker) => marker.line)).toEqual([0, 0, 2]);
    expect(wrapper!.get('.terminal-host').classes()).not.toContain('invisible');
  });

  it('replaces what it shows with a screen a daemon sends unasked, after the live data it held back', async () => {
    const { xterm, sinks } = await mountView({});
    sinks[0]!({ data: 'old output\r\n' });
    await flushPromises();
    sinks[0]!({ screen: { id: 'term-1', data: 'fresh screen', cols: 100, rows: 30, marks: [] } });
    await flushPromises();
    expect(xterm!.resets).toBe(1);
    expect(xterm!.written[0]).toBe('fresh screen');
  });

  it('shows what it has once main stops waiting without a screen', async () => {
    await mountView({ restoring: true });
    expect(wrapper!.get('.terminal-host').classes()).toContain('invisible');
    await wrapper!.setProps({ terminal: { ...info, restoring: false } });
    await flushPromises();
    expect(wrapper!.get('.terminal-host').classes()).not.toContain('invisible');
  });

  it('shows a new terminal at once', async () => {
    await mountView();
    expect(wrapper!.get('.terminal-host').classes()).not.toContain('invisible');
  });

  // The page's first state can come before main asked for the screens.
  it('hides again when main starts waiting for its screen after the view mounted, until the screen is written', async () => {
    const { sinks } = await mountView();
    await wrapper!.setProps({ terminal: { ...info, restoring: true } });
    expect(wrapper!.get('.terminal-host').classes()).toContain('invisible');
    sinks[0]!({ screen: { id: 'term-1', data: '$ ', cols: 80, rows: 24, marks: [] } });
    await flushPromises();
    expect(wrapper!.get('.terminal-host').classes()).not.toContain('invisible');
  });

  it('stays hidden when main stops waiting while its screen still waits in the store for the view to open', async () => {
    let fontLoaded: () => void = () => undefined;
    fontsLoad.mockImplementation(() => new Promise((resolve) => {
      fontLoaded = () => resolve([]);
    }));
    const { sinks } = await mountView({ restoring: true, screenWaits: () => true });
    await wrapper!.setProps({ terminal: { ...info, restoring: false } });
    await flushPromises();
    expect(wrapper!.get('.terminal-host').classes()).toContain('invisible');
    fontLoaded();
    await flushPromises();
    sinks[0]!({ screen: { id: 'term-1', data: '$ ', cols: 80, rows: 24, marks: [] } });
    await flushPromises();
    expect(wrapper!.get('.terminal-host').classes()).not.toContain('invisible');
  });
});

describe('the font family', () => {
  // Chromium: a CSS-wide keyword or var() parses as a font-family, and document.fonts.load rejects either in a font shorthand.
  const chromiumSupports = (property: string, value: string): boolean => {
    if (property === 'font-family') return true;
    return !/^1px (?:inherit|initial|unset|revert)$/.test(value);
  };

  it('falls back to the app mono font for a CSS-wide keyword or var(), which no font list holds', async () => {
    vi.stubGlobal('CSS', { supports: chromiumSupports, escape: (value: string) => value });
    fontsLoad.mockImplementation(async (font) => (/inherit|var\(/.test(font) ? Promise.reject(new SyntaxError('Could not parse')) : []));
    for (const family of ['inherit', 'var(--x)']) {
      wrapper?.unmount();
      xterms.length = 0;
      const { xterm } = await mountView({ settings: { fontFamily: family } });
      expect(xterm, family).toBeDefined();
      expect(xterm!.options.fontFamily, family).not.toBe(family);
    }
  });

  it('opens the terminal even when the font fails to load', async () => {
    fontsLoad.mockRejectedValue(new Error('network'));
    const { xterm } = await mountView();
    expect(xterm).toBeDefined();
  });
});

describe('platform options', () => {
  it('sets screenReaderMode from main\'s accessibility support, and follows its changes', async () => {
    const { xterm } = await mountView({ screenReader: true });
    expect(xterm!.options.screenReaderMode).toBe(true);
    await wrapper!.setProps({ screenReader: false });
    expect(xterm!.options.screenReaderMode).toBe(false);
  });

  it('tells xterm the Windows build of the host whose conpty runs the terminal, whatever this computer runs', async () => {
    const { xterm } = await mountView({ platform: 'linux', windowsBuild: 19045 });
    expect(xterm!.options.windowsPty).toEqual({ backend: 'conpty', buildNumber: 19045 });
    wrapper!.unmount();
    const posix = await mountView({ platform: 'win32', windowsBuild: null });
    expect(posix.xterm!.options.windowsPty).toBeUndefined();
  });
});

describe('link resolution', () => {
  it('reads paths in the path rules of the host the shell runs on, whatever this computer runs', async () => {
    for (const [platform, pathFlavor, line, path] of [
      // a drive path after a word is a Windows link only; a slash after a drive letter starts a POSIX path
      ['linux', 'win32', 'at C:\\x\\y.ts', 'C:\\x\\y.ts'],
      ['win32', 'posix', 'C:/x/y.ts', '/x/y.ts'],
    ] as const) {
      const { api, xterm } = await mountView({ platform, pathFlavor });
      vi.mocked(api.terminal.resolveLinks).mockResolvedValue([]);
      xterm!.lines = [line];
      xterm!.linkProviders[0]!.provideLinks(1, () => undefined);
      await flushPromises();
      expect(vi.mocked(api.terminal.resolveLinks).mock.calls[0]?.[0].paths).toContain(path);
      wrapper!.unmount();
      wrapper = undefined;
    }
  });

  it('treats a failed resolution as no links, without an unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => void rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const { api, xterm } = await mountView();
      vi.mocked(api.terminal.resolveLinks).mockRejectedValue(new Error('Unknown terminal'));
      xterm!.lines = ['see src/app.ts:3 for details'];
      const callback = vi.fn<(links: ILink[] | undefined) => void>();
      xterm!.linkProviders[0]!.provideLinks(1, callback);
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(api.terminal.resolveLinks).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(undefined);
      expect(rejections).toEqual([]);
      expect(wrapper!.get('[data-testid="terminal-view"]').attributes('data-links-provided-for')).toBe('see src/app.ts:3 for details');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('partial command marks', () => {
  // A terminal without shell integration marks each Enter typed after a prompt; a clear screen drops the visible ones.
  it('disposes the marks a clear screen drops', async () => {
    const { xterm } = await mountView({ integrated: false });
    xterm!.typed('\r');
    const marker = xterm!.markers.at(-1)!;
    expect(marker.isDisposed).toBe(false);
    xterm!.csi([2]);
    expect(marker.isDisposed).toBe(true);
  });
});

describe('a clear screen', () => {
  // ConPTY's cls erases the rows with EL and then sends ED 3; ED 2 erases them on other platforms.
  it('drops the command marks on the rows it erased', async () => {
    for (const mode of [2, 3]) {
      wrapper?.unmount();
      xterms.length = 0;
      const { xterm, sinks } = await mountView();
      shellEvents(sinks[0]!, { kind: 'promptStart' }, { kind: 'commandStart' }, { kind: 'commandExecuted', commandId: 1, commandLine: 'cls', time: 1 });
      const marked = xterm!.decorated[0]!;
      xterm!.csi([mode]);
      expect(marked.isDisposed, `ED ${mode}`).toBe(true);
    }
  });

  it('keeps the command marks when a program clears the alternate buffer, whose rows hold none of them', async () => {
    const { xterm, sinks } = await mountView();
    shellEvents(sinks[0]!, { kind: 'commandExecuted', commandId: 1, commandLine: 'vim', time: 1 });
    xterm!.buffer.active.type = 'alternate';
    xterm!.csi([2]);
    expect(xterm!.decorated[0]!.isDisposed).toBe(false);
  });
});

describe('the tab panel', () => {
  it('is labelled by its list row or its single tab', async () => {
    await mountView();
    const panel = wrapper!.get('[data-testid="terminal-view"]');
    expect(panel.attributes('role')).toBe('tabpanel');
    expect(panel.attributes('id')).toBe('terminal-panel-term-1');
    expect(panel.attributes('aria-labelledby')).toBe('terminal-row-term-1 terminal-tab-term-1');
  });
});

describe('Escape while Find is open', () => {
  it('closes Find from the xterm instead of reaching the pty, as VS Code\'s hideFind does', async () => {
    const { xterm } = await mountView();
    expect(xterm!.keyHandler!(key('KeyF', { ctrlKey: true }))).toBe(false);
    await flushPromises();
    expect(wrapper!.find('[data-testid="terminal-find"]').exists()).toBe(true);
    expect(xterm!.keyHandler!(key('Escape'))).toBe(false);
    await flushPromises();
    expect(wrapper!.find('[data-testid="terminal-find"]').exists()).toBe(false);
    // with Find closed, Escape reaches the program
    expect(xterm!.keyHandler!(key('Escape'))).toBe(true);
  });
});

describe('the Find widget', () => {
  // addon-search builds RegExp(term) with no try, as the real addon does.
  function fakeSearch() {
    return {
      findNext: vi.fn((term: string, options?: { regex?: boolean }) => {
        if (options?.regex) new RegExp(term);
        return true;
      }),
      findPrevious: vi.fn(() => true),
      clearDecorations: vi.fn(),
      onDidChangeResults: () => ({ dispose: () => undefined }),
    };
  }

  async function mountFind() {
    const search = fakeSearch();
    wrapper = mount(TerminalFind, { props: { search: search as never }, global: { plugins: [shellI18n] }, attachTo: document.body });
    await flushPromises();
    const input = wrapper.get('[data-testid="terminal-find-input"]');
    await input.setValue('foo');
    search.findNext.mockClear();
    return { search, input };
  }

  it('runs Enter and F3 from the query field only, so Enter on a button activates that button', async () => {
    const { search, input } = await mountFind();
    for (const id of ['terminal-find-previous', 'terminal-find-next', 'terminal-find-close', 'terminal-find-regex']) {
      const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      wrapper!.get(`[data-testid="${id}"]`).element.dispatchEvent(enter);
      expect(enter.defaultPrevented, id).toBe(false);
    }
    expect(search.findNext).not.toHaveBeenCalled();
    await input.trigger('keydown', { key: 'Enter' });
    await input.trigger('keydown', { key: 'F3' });
    expect(search.findNext).toHaveBeenCalledTimes(2);
    await input.trigger('keydown', { key: 'Enter', shiftKey: true });
    expect(search.findPrevious).toHaveBeenCalledTimes(1);
  });

  it('shows an invalid regular expression instead of searching for it', async () => {
    const { search, input } = await mountFind();
    await wrapper!.get('[data-testid="terminal-find-regex"]').trigger('click');
    search.findNext.mockClear();
    await input.setValue('(');
    expect(search.findNext).not.toHaveBeenCalled();
    expect(search.clearDecorations).toHaveBeenCalled();
    expect(input.attributes('aria-invalid')).toBe('true');
    expect(wrapper!.get('[data-testid="terminal-find-status"]').text()).toBe(shellI18n.global.t('terminal.find.invalid'));
    await input.setValue('(foo)');
    expect(search.findNext).toHaveBeenCalledTimes(1);
    expect(input.attributes('aria-invalid')).toBeUndefined();
  });
});
