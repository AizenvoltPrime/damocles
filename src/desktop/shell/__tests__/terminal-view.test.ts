// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { shallowRef } from 'vue';
import type { IBufferRange, ILink, ILinkHandler, ILinkProvider } from '@xterm/xterm';
import type { ShellPlatform } from '../../preload/shell-channels';
import type { TerminalInfo, TerminalSettings, TerminalShellEvent } from '../../preload/terminal-channels';
import TerminalFind from '../terminal/TerminalFind.vue';
import TerminalView from '../terminal/TerminalView.vue';
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
  buffer: { active: { cursorX: number } };
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
    buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
        cursorX: 10,
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
    registerMarker(): FakeMarker {
      const marker: FakeMarker = { line: 0, isDisposed: false, dispose: () => { marker.isDisposed = true; } };
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
    write(_data: string, callback?: () => void): void {
      callback?.();
    }
    clear(): void {
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
  id: 'term-1', title: 'bash', name: null, profileId: 'bash', icon: 'bash', customIcon: null, color: null, projectKey: 'alpha', projectName: 'alpha', status: 'running', exitCode: null, description: null, running: null, integrated: true,
};

interface MountOptions {
  platform?: ShellPlatform;
  settings?: Partial<TerminalSettings>;
  screenReader?: boolean;
  windowsBuild?: number;
  integrated?: boolean;
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
    attach: (_id: string, sink: TerminalSink) => {
      sinks.push(sink);
      return () => undefined;
    },
  } as unknown as TerminalStore;
  wrapper = mount(TerminalView, {
    props: {
      api,
      terminal: { ...info, integrated: options.integrated ?? true },
      shown: true,
      settings: { ...TERMINAL_STATE.settings, ...options.settings },
      passKeys: [],
      platform: options.platform ?? 'linux',
      splitShortcut: 'Ctrl+Shift+5',
      screenReader: options.screenReader ?? false,
      windowsBuild: options.windowsBuild ?? 0,
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
    shellEvents(sinks[0]!, { kind: 'commandExecuted', commandId: 1, commandLine: 'ls', time: 1 });
    expect(xterm!.decorated).toHaveLength(1);
    expect(xterm!.decorated[0]!.isDisposed).toBe(false);
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

  it('tells xterm the Windows build its conpty runs on', async () => {
    const { xterm } = await mountView({ platform: 'win32', windowsBuild: 19045 });
    expect(xterm!.options.windowsPty).toEqual({ backend: 'conpty', buildNumber: 19045 });
  });
});

describe('link resolution', () => {
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
