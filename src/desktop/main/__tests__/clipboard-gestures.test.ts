import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ WebContentsView: vi.fn(), nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() }, protocol: {} }));

import type { OverlayAnswer, OverlayMenuItem, OverlayRequest } from '../../preload/overlay-channels';
import type { TerminalPaste } from '../../preload/terminal-channels';
import { askShellMenu, GESTURE_GRANT_MS, GestureGrant, type ShellMenuDeps } from '../clipboard-gestures';
import { parseOverlayRequest } from '../overlay';
import { TerminalPasteGate } from '../terminal/terminal-paste';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('gesture grant', () => {
  it('answers one take, is replaced by a newer grant, and ends at its deadline or a clear', () => {
    const grant = new GestureGrant<string>();
    expect(grant.take()).toBeUndefined();
    grant.grant('a');
    grant.grant('b');
    expect(grant.take()).toBe('b');
    expect(grant.take()).toBeUndefined();
    grant.grant('c');
    vi.advanceTimersByTime(GESTURE_GRANT_MS);
    expect(grant.take()).toBeUndefined();
    grant.grant('d');
    grant.clear();
    expect(grant.take()).toBeUndefined();
  });

  it('keeps a newer grant past the deadline of the one it replaced', () => {
    const grant = new GestureGrant<string>();
    grant.grant('old');
    vi.advanceTimersByTime(GESTURE_GRANT_MS - 500);
    grant.grant('new');
    vi.advanceTimersByTime(600);
    expect(grant.take()).toBe('new');
  });
});

const REQUEST = { id: 'term-1', bracketedPasteMode: false, source: 'clipboard' } as const satisfies TerminalPaste;

function gate(options: { active?: string | null; focused?: boolean } = {}) {
  const read = vi.fn(async (source: TerminalPaste['source']) => `text from ${source}`);
  const paste = vi.fn(async () => {});
  const lines: string[] = [];
  const state = { active: options.active === undefined ? 'term-1' : options.active, focused: options.focused ?? true };
  const value = new TerminalPasteGate({ activeTerminal: () => state.active, terminalFocused: () => state.focused, read, paste, log: (line) => lines.push(line) });
  return { gate: value, read, paste, lines, state };
}

describe('terminal paste gate', () => {
  it('reads nothing and writes nothing for a request no gesture allowed, and logs the refusal', async () => {
    const { gate: subject, read, paste, lines } = gate();
    await subject.paste(REQUEST);
    expect(read).not.toHaveBeenCalled();
    expect(paste).not.toHaveBeenCalled();
    expect(lines).toEqual(['[terminal] refusing a paste: no paste key, middle click or menu pick of the user allowed it']);
  });

  it('pastes once per gesture: the grant answers the first request only', async () => {
    const { gate: subject, read, paste } = gate();
    subject.allow('clipboard');
    await subject.paste(REQUEST);
    await subject.paste(REQUEST);
    expect(read.mock.calls).toEqual([['clipboard']]);
    expect(paste.mock.calls).toEqual([['text from clipboard', REQUEST]]);
  });

  it('reads the primary selection only for a selection grant, and a request of the other source spends the grant', async () => {
    const { gate: subject, read, paste } = gate();
    subject.allow('selection');
    await subject.paste(REQUEST);
    await subject.paste({ ...REQUEST, source: 'selection' });
    expect(read).not.toHaveBeenCalled();
    subject.allow('selection');
    await subject.paste({ ...REQUEST, source: 'selection' });
    expect(read.mock.calls).toEqual([['selection']]);
    expect(paste).toHaveBeenCalledOnce();
  });

  it('refuses a grant for another terminal, an expired or cleared grant, and a terminal without keyboard focus', async () => {
    const { gate: subject, read, state, lines } = gate();
    subject.allow('clipboard');
    await subject.paste({ ...REQUEST, id: 'term-2' });
    subject.allow('clipboard');
    vi.advanceTimersByTime(GESTURE_GRANT_MS);
    await subject.paste(REQUEST);
    subject.allow('clipboard');
    subject.clear();
    await subject.paste(REQUEST);
    subject.allow('clipboard');
    state.focused = false;
    await subject.paste(REQUEST);
    state.focused = true;
    subject.allow('clipboard');
    state.active = 'term-2';
    await subject.paste(REQUEST);
    expect(read).not.toHaveBeenCalled();
    expect(lines.at(-1)).toBe('[terminal] refusing a paste: that terminal does not have keyboard focus');
  });

  it('issues no grant without an active terminal', async () => {
    const { gate: subject, read, state } = gate({ active: null });
    subject.allow('clipboard');
    state.active = 'term-1';
    await subject.paste(REQUEST);
    expect(read).not.toHaveBeenCalled();
  });
});

const item = (id: string, extra: Partial<Extract<OverlayMenuItem, { kind: 'item' }>> = {}): OverlayMenuItem => ({ kind: 'item', id, label: id, ...extra });
const SEPARATOR: OverlayMenuItem = { kind: 'separator' };
const menu = (items: OverlayMenuItem[]): OverlayRequest => ({ kind: 'menu', label: 'Menu', anchor: { x: 0, y: 0, width: 0, height: 0 }, items });

function shellMenu(answer: OverlayAnswer, granted: boolean, focused = true) {
  const page = { cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), isFocused: vi.fn(() => focused), isDestroyed: vi.fn(() => false) };
  const shown: OverlayRequest[] = [];
  const lines: string[] = [];
  const deps: ShellMenuDeps = {
    ask: vi.fn(async (request: OverlayRequest) => {
      shown.push(request);
      return answer;
    }),
    takeMenuGrant: vi.fn(() => granted),
    label: (action) => `main ${action}`,
    page,
    allowTerminalPaste: vi.fn(),
    log: (line) => lines.push(line),
  };
  return { deps, page, shown, lines };
}

const EDITOR_MENU = menu([item('go'), SEPARATOR, item('cut', { clipboard: 'cut' }), item('copy', { clipboard: 'copy' }), item('paste', { clipboard: 'paste', label: 'Open settings', icon: 'trash-2', danger: true }), SEPARATOR, item('palette')]);

describe('shell menu clipboard items', () => {
  it.each(['cut', 'copy', 'paste'] as const)('run %s on the focused shell page when the user picks it in a menu a context-menu gesture opened', async (action) => {
    const { deps, page } = shellMenu({ kind: 'menu', itemId: action }, true);
    await expect(askShellMenu(EDITOR_MENU, deps)).resolves.toEqual({ kind: 'menu', itemId: action });
    expect(page[action]).toHaveBeenCalledOnce();
    for (const other of (['cut', 'copy', 'paste'] as const).filter((name) => name !== action)) expect(page[other]).not.toHaveBeenCalled();
  });

  it('runs nothing for another pick, a dismissal or a page that lost focus', async () => {
    for (const [answer, focused] of [[{ kind: 'menu', itemId: 'go' }, true], [{ kind: 'dismissed' }, true], [{ kind: 'menu', itemId: 'paste' }, false]] as const) {
      const { deps, page, lines } = shellMenu(answer, true, focused);
      await askShellMenu(EDITOR_MENU, deps);
      expect(page.cut).not.toHaveBeenCalled();
      expect(page.copy).not.toHaveBeenCalled();
      expect(page.paste).not.toHaveBeenCalled();
      expect(deps.allowTerminalPaste).not.toHaveBeenCalled();
      if (!focused) expect(lines).toEqual(['[overlay] not running paste: the shell page lost keyboard focus']);
    }
  });

  it('shows a clipboard item with main\'s label and look, whatever the page sent', async () => {
    const { deps, shown } = shellMenu({ kind: 'dismissed' }, true);
    await askShellMenu(EDITOR_MENU, deps);
    expect(shown[0]!.kind === 'menu' && shown[0]!.items[4]).toEqual({ kind: 'item', id: 'paste', clipboard: 'paste', label: 'main paste' });
  });

  it('drops the clipboard items of a menu no context-menu gesture opened, runs nothing on a forged pick, and logs it', async () => {
    const { deps, page, shown, lines } = shellMenu({ kind: 'menu', itemId: 'paste' }, false);
    await askShellMenu(EDITOR_MENU, deps);
    expect(shown[0]).toEqual(menu([item('go'), SEPARATOR, item('palette')]));
    expect(page.paste).not.toHaveBeenCalled();
    expect(lines).toEqual(['[overlay] dropping the clipboard items of a shell menu that no context-menu click or key opened']);
  });

  it('shows nothing for a menu of clipboard items alone without the gesture', async () => {
    const { deps, shown } = shellMenu({ kind: 'menu', itemId: 'paste' }, false);
    await expect(askShellMenu(menu([item('paste', { clipboard: 'terminalPaste' })]), deps)).resolves.toEqual({ kind: 'dismissed' });
    expect(shown).toEqual([]);
    expect(deps.allowTerminalPaste).not.toHaveBeenCalled();
  });

  it('allows one terminal paste on a pick of the terminal menu\'s Paste, labelled and drawn by main', async () => {
    const { deps, page, shown } = shellMenu({ kind: 'menu', itemId: 'paste' }, true);
    await askShellMenu(menu([item('copy'), item('paste', { clipboard: 'terminalPaste', shortcut: 'Ctrl+Shift+V' })]), deps);
    expect(deps.allowTerminalPaste).toHaveBeenCalledOnce();
    expect(page.paste).not.toHaveBeenCalled();
    expect(shown[0]!.kind === 'menu' && shown[0]!.items[1]).toEqual({ kind: 'item', id: 'paste', clipboard: 'terminalPaste', label: 'main terminalPaste', icon: 'clipboard-paste', shortcut: 'Ctrl+Shift+V' });
  });

  it('takes the context-menu grant with every shell menu, so a later page menu cannot reuse it', async () => {
    const { deps } = shellMenu({ kind: 'dismissed' }, true);
    await askShellMenu(menu([item('rename')]), deps);
    expect(deps.takeMenuGrant).toHaveBeenCalledOnce();
    await askShellMenu({ kind: 'confirm', title: 't', message: 'm', confirmLabel: 'OK', cancelLabel: 'Cancel', danger: false }, deps);
    expect(deps.takeMenuGrant).toHaveBeenCalledOnce();
  });

  it('refuses a menu holding two items of one clipboard action, or an unknown one', () => {
    const raw = (items: unknown[]): unknown => ({ kind: 'menu', label: 'Menu', anchor: { x: 0, y: 0, width: 0, height: 0 }, items });
    expect(parseOverlayRequest(raw([item('a', { clipboard: 'paste' }), item('b', { clipboard: 'paste' })]))).toBeUndefined();
    expect(parseOverlayRequest(raw([{ kind: 'item', id: 'a', label: 'a', clipboard: 'selectAll' }]))).toBeUndefined();
    expect(parseOverlayRequest(raw([item('a', { clipboard: 'paste' }), item('b', { clipboard: 'terminalPaste' })]))).toEqual(raw([item('a', { clipboard: 'paste' }), item('b', { clipboard: 'terminalPaste' })]));
  });
});
