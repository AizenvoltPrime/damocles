// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { shallowRef } from 'vue';
import type { TerminalInfo } from '../../preload/terminal-channels';
import TerminalView from '../terminal/TerminalView.vue';
import { TERMINAL_STORE, type TerminalStore } from '../terminal/terminal-store';
import { shellI18n } from '../i18n';
import { TERMINAL_STATE, fakeShellApi } from './fakes';

// A stand-in xterm: 80×24 once fitted, its typed input handed to the test.
const typed: { listeners: Array<(data: string) => void>; send: (data: string) => void } = {
  listeners: [],
  send: (data) => typed.listeners.forEach((listener) => listener(data)),
};
vi.mock('@xterm/xterm', () => {
  const disposable = { dispose: () => undefined };
  class Terminal {
    cols = 40;
    rows = 24;
    options: Record<string, unknown> = {};
    element: HTMLElement | undefined;
    modes = { bracketedPasteMode: false };
    unicode = { activeVersion: '' };
    buffer = { active: { viewportY: 0, baseY: 0 } };
    loadAddon(addon: { activate?: (terminal: Terminal) => void }): void {
      addon.activate?.(this);
    }
    registerLinkProvider = () => disposable;
    registerMarker = () => undefined;
    parser = { registerCsiHandler: () => disposable };
    attachCustomKeyEventHandler(): void {}
    onData = (listener: (data: string) => void) => {
      typed.listeners.push(listener);
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
    write(): void {}
    focus(): void {}
    hasSelection = () => false;
    dispose(): void {}
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    terminal: { cols: number; rows: number } | undefined;
    activate(terminal: { cols: number; rows: number }): void {
      this.terminal = terminal;
    }
    proposeDimensions = () => ({ cols: 80, rows: 24 });
    fit(): void {
      if (this.terminal) this.terminal.cols = 80;
    }
  },
}));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

beforeAll(() => {
  Object.defineProperty(document, 'fonts', { value: { load: async () => [] }, configurable: true });
  // The screen shows as soon as it is observed, as a pane does when its group becomes the shown one.
  vi.stubGlobal('IntersectionObserver', class {
    readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void;
    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
      this.callback = callback;
    }
    observe(): void {
      queueMicrotask(() => this.callback([{ isIntersecting: true }]));
    }
    disconnect(): void {}
  });
});

let wrapper: VueWrapper | undefined;
afterEach(() => wrapper?.unmount());

const info: TerminalInfo = {
  id: 'term-1', title: 'bash', name: null, profileId: 'bash', icon: 'bash', customIcon: null, color: null, projectKey: 'alpha', projectName: 'alpha', status: 'running', exitCode: null, description: null, running: null, integrated: true,
};

describe('terminal view pty size', () => {
  // A pane shown at a new width with the user typing at once: readline would redraw a prompt that wrapped at the old
  // width on the late SIGWINCH and erase the command's output above it.
  it('sends the size on screen before the first keys of input, without waiting for it to settle', async () => {
    const api = fakeShellApi();
    const store = { state: shallowRef(TERMINAL_STATE), focusRequest: shallowRef(null), pasteRequest: shallowRef(null), actionRequest: shallowRef(null), attach: () => () => undefined } as unknown as TerminalStore;
    wrapper = mount(TerminalView, {
      props: { api, terminal: info, shown: true, settings: TERMINAL_STATE.settings, passKeys: [], platform: 'linux', splitShortcut: 'Ctrl+Shift+5', screenReader: false, windowsBuild: 0 },
      global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: store } },
    });
    await flushPromises();
    expect(typed.listeners.length).toBeGreaterThan(0);
    expect(api.terminal.resize).not.toHaveBeenCalled();
    typed.send('e');
    expect(api.terminal.resize).toHaveBeenCalledWith({ id: 'term-1', cols: 80, rows: 24 });
    expect(vi.mocked(api.terminal.resize).mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(api.terminal.input).mock.invocationCallOrder[0]!);
    typed.send('c');
    expect(api.terminal.resize).toHaveBeenCalledTimes(1);
  });
});
