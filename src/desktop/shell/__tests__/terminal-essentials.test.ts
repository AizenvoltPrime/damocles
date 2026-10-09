// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { IBufferCell } from '@xterm/xterm';
import { MAX_TERMINAL_LINK_PATH_LENGTH, MAX_TERMINAL_LINK_PATHS, MAX_TERMINAL_NAME_LENGTH, type TerminalSettings } from '../../preload/terminal-channels';
import type { OverlayQuickPickItem } from '../../preload/overlay-channels';
import { confirmedLinks, lineCandidates, MAX_LINKS_PER_LINE, MAX_LINK_LINE_LENGTH, rangeOf, readWrappedLine, requestPaths, type LinkLines } from '../terminal/terminal-links';
import { renameRequestName, runTerminalAction, terminalMenuAction, terminalMenuItems } from '../terminal/terminal-menu';
import { isFontList, liveOptions } from '../terminal/terminal-options';
import { isMenuKey, isShiftF10, isXtermInput, terminalKeyAction } from '../terminal/terminal-keys';
import { colorTint, glyphLook, terminalGlyph, TERMINAL_ICON } from '../terminal/terminal-icons';
import { createTerminalStore } from '../terminal/terminal-store';
import { overlayPickModel } from '../overlay/quick-pick';
import { fakeShellApi, TERMINAL_STATE } from './fakes';
import { PASTE_CHORD_CASES } from '../../main/__tests__/paste-chords';

const t = (key: string): string => key;
const ids = (items: ReturnType<typeof terminalMenuItems>): string[] => items.map((item) => (item.kind === 'item' ? item.id : '-'));
const single = { panes: 1, shortcut: 'Ctrl+Shift+5' };

describe('terminal context menu', () => {
  it('lists VS Code\'s groups in the terminal, with Copy enabled only by a selection', () => {
    const items = terminalMenuItems({ target: 'terminal', hasSelection: false, platform: 'win32', group: single }, t);
    expect(ids(items)).toEqual(['copy', 'paste', 'selectAll', 'clear', '-', 'copyLastCommand', 'copyLastCommandOutput', 'addToChat', '-', 'split', '-', 'rename', 'changeIcon', 'changeColor', '-', 'kill']);
    expect(items[0]).toMatchObject({ id: 'copy', disabled: true });
    expect(terminalMenuItems({ target: 'terminal', hasSelection: true, platform: 'darwin', group: single }, t)[0]).toMatchObject({ disabled: false, shortcut: '⌘C' });
    expect(items.find((item) => item.kind === 'item' && item.id === 'kill')).toMatchObject({ danger: true });
  });

  // VS Code's menus show each platform's primary terminal keys: Ctrl+C with a selection and Ctrl+V on Windows.
  it('labels Copy and Paste with the keys this platform\'s terminal uses', () => {
    const keys = (platform: 'win32' | 'linux' | 'darwin') => terminalMenuItems({ target: 'terminal', hasSelection: true, platform, group: single }, t).slice(0, 2).map((item) => (item.kind === 'item' ? item.shortcut : undefined));
    expect(keys('win32')).toEqual(['Ctrl+C', 'Ctrl+V']);
    expect(keys('linux')).toEqual(['Ctrl+Shift+C', 'Ctrl+Shift+V']);
    expect(keys('darwin')).toEqual(['⌘C', '⌘V']);
  });

  it('drops the clipboard group on a list row or the tab, which name F2 and Delete', () => {
    const items = terminalMenuItems({ target: 'tab', hasSelection: true, platform: 'linux', group: single }, t);
    expect(ids(items)).toEqual(['split', '-', 'rename', 'changeIcon', 'changeColor', '-', 'kill']);
    expect(items[2]).toMatchObject({ shortcut: 'F2' });
    expect(items[items.length - 1]).toMatchObject({ shortcut: 'Del' });
  });

  it('maps only offered ids to actions', () => {
    expect(terminalMenuAction('selectAll')).toBe('selectAll');
    expect(terminalMenuAction('split')).toBe('split');
    expect(terminalMenuAction('join')).toBeUndefined();
  });

  // VS Code's tab menu: Split Terminal leads; Unsplit only on a pane of a multi-pane group.
  it('offers Split with the shortcut main publishes, Unsplit only in a split group, and no Split once the group is full', () => {
    const items = terminalMenuItems({ target: 'tab', hasSelection: false, platform: 'win32', group: single }, t);
    expect(items[0]).toMatchObject({ id: 'split', shortcut: 'Ctrl+Shift+5', disabled: false });
    expect(ids(terminalMenuItems({ target: 'tab', hasSelection: false, platform: 'win32', group: { panes: 2, shortcut: 'Ctrl+Shift+5' } }, t)).slice(0, 3)).toEqual(['split', 'unsplit', '-']);
    expect(ids(terminalMenuItems({ target: 'terminal', hasSelection: false, platform: 'win32', group: { panes: 3, shortcut: 'Ctrl+Shift+5' } }, t))).toContain('unsplit');
    expect(terminalMenuItems({ target: 'tab', hasSelection: false, platform: 'win32', group: { panes: 8, shortcut: '' } }, t)[0]).toMatchObject({ id: 'split', disabled: true });
  });

  it('splits and unsplits the pane the menu was opened on', () => {
    const api = { pickIcon: vi.fn(), pickColor: vi.fn(), kill: vi.fn(), split: vi.fn(), unsplit: vi.fn() };
    runTerminalAction('split', 'term-2', { api, store: { startRename: vi.fn() }, returnTo: 'tab' });
    runTerminalAction('unsplit', 'term-3', { api, store: { startRename: vi.fn() }, returnTo: 'tab' });
    expect(api.split).toHaveBeenCalledWith('term-2');
    expect(api.unsplit).toHaveBeenCalledWith('term-3');
  });

  it('opens on Shift+F10 and the context menu key, not with another modifier', () => {
    const key = (code: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent => ({ code, key: code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods }) as KeyboardEvent;
    expect(isMenuKey(key('F10', { shiftKey: true }))).toBe(true);
    expect(isMenuKey(key('ContextMenu'))).toBe(true);
    expect(isMenuKey(key('F10'))).toBe(false);
    expect(isMenuKey(key('F10', { shiftKey: true, ctrlKey: true }))).toBe(false);
    expect(terminalKeyAction(key('F10', { shiftKey: true }), 'win32', false, [])).toBe('menu');
    expect(isShiftF10(key('F10', { shiftKey: true }))).toBe(true);
    expect(isShiftF10(key('ContextMenu'))).toBe(false);
  });

  // shell-host.test.ts holds main's before-input-event to the same chords, so main grants exactly the pastes this handler asks for.
  it.each(PASTE_CHORD_CASES)('on %s, V with control %s, shift %s, alt %s, meta %s pastes: %s', (platform, ctrlKey, shiftKey, altKey, metaKey, pastes) => {
    const event = { code: 'KeyV', key: 'v', ctrlKey, shiftKey, altKey, metaKey } as KeyboardEvent;
    expect(terminalKeyAction(event, platform, false, []) === 'paste').toBe(pastes);
  });
});

describe('inline rename', () => {
  const automatic = { title: 'cmd', name: null };
  const named = { title: 'build', name: 'build' };

  it('sends the trimmed name, bounded, and nothing when it is the title the field opened with', () => {
    expect(renameRequestName('  server  ', automatic)).toBe('server');
    expect(renameRequestName('cmd', automatic)).toBeUndefined();
    expect(renameRequestName('build ', named)).toBeUndefined();
    expect(renameRequestName('x'.repeat(MAX_TERMINAL_NAME_LENGTH + 5), automatic)).toHaveLength(MAX_TERMINAL_NAME_LENGTH);
  });

  // An automatic title runs to MAX_TERMINAL_TITLE_CHARS, past the name bound.
  it('sends nothing for a long automatic title left as it was', () => {
    const long = { title: `npm run build -- --watch ${'x'.repeat(70)}`, name: null };
    expect(long.title.length).toBeGreaterThan(MAX_TERMINAL_NAME_LENGTH);
    expect(renameRequestName(long.title, long)).toBeUndefined();
    expect(renameRequestName(` ${long.title} `, long)).toBeUndefined();
  });

  it('never cuts a surrogate pair at the bound', () => {
    const name = renameRequestName(`${'x'.repeat(MAX_TERMINAL_NAME_LENGTH - 1)}\u{1F680}`, automatic)!;
    expect(name).toBe('x'.repeat(MAX_TERMINAL_NAME_LENGTH - 1));
  });

  it('restores the automatic title when emptied, and sends nothing when there was no name', () => {
    expect(renameRequestName('   ', named)).toBe('');
    expect(renameRequestName('', automatic)).toBeUndefined();
  });
});

describe('terminal link candidates', () => {
  it('reads a path with its line and column, and sends the path without them', () => {
    const candidates = lineCandidates('error at src/app.ts:42:7 here', 'posix');
    expect(candidates.parsed).toHaveLength(1);
    expect(candidates.parsed[0]).toMatchObject({ paths: ['src/app.ts'], start: 9, end: 24, line: 42, column: 7 });
    expect(requestPaths(candidates)).toContain('src/app.ts');
  });

  it('reads Windows paths with either separator, and every form the parser knows', () => {
    expect(lineCandidates('C:\\proj\\src\\app.ts(42,7): error', 'windows').parsed[0]).toMatchObject({ paths: ['C:\\proj\\src\\app.ts'], line: 42, column: 7 });
    expect(lineCandidates('  --> src/main.rs:3:9', 'windows').parsed[0]).toMatchObject({ paths: ['src/main.rs'], line: 3, column: 9 });
    expect(lineCandidates('"src/app.py", line 42', 'posix').parsed[0]).toMatchObject({ paths: ['src/app.py'], line: 42, column: null });
  });

  it('tries the path without trailing punctuation, and shortens the underline when that one resolves', () => {
    const candidates = lineCandidates('see src/app.ts.', 'posix');
    expect(candidates.parsed[0]?.paths).toEqual(['src/app.ts.', 'src/app.ts']);
    const paths = requestPaths(candidates);
    const links = confirmedLinks(candidates, paths, paths.map((path) => (path === 'src/app.ts' ? 'file' : null)));
    expect(links).toEqual([{ kind: 'file', path: 'src/app.ts', start: 4, end: 14, line: null, column: null }]);
  });

  it('keeps web links to http and https, and never asks main about a path inside one', () => {
    const candidates = lineCandidates('docs https://example.com/a/b.md and ftp://x/y', 'posix');
    expect(candidates.web.map((link) => link.url)).toEqual(['https://example.com/a/b.md']);
    expect(candidates.parsed.some((link) => link.paths.some((path) => path.includes('example.com')))).toBe(false);
  });

  it('bounds what it asks: no search past the line length cap, ten parsed links, path length and request size', () => {
    expect(lineCandidates(`src/a.ts:1 ${'x'.repeat(MAX_LINK_LINE_LENGTH)}`, 'posix').parsed).toEqual([]);
    const many = Array.from({ length: 30 }, (_, index) => `d/f${index}.ts:1`).join(' ');
    expect(lineCandidates(many, 'posix').parsed).toHaveLength(MAX_LINKS_PER_LINE);
    expect(lineCandidates(`a/${'p'.repeat(MAX_TERMINAL_LINK_PATH_LENGTH)}.ts:3`, 'posix').parsed).toEqual([]);
    const paths = requestPaths({ web: [], parsed: Array.from({ length: 80 }, (_, index) => ({ paths: [`p${index}`], start: 0, end: 1, trimmed: new Map(), line: null, column: null })), fallback: [] });
    expect(paths).toHaveLength(MAX_TERMINAL_LINK_PATHS);
  });

  it('drops a line or column outside the editor\'s range rather than sending it', () => {
    expect(lineCandidates('src/a.ts:0:99999999999', 'posix').parsed[0]).toMatchObject({ line: null, column: null });
  });

  it('uses VS Code\'s fallback matches for paths with spaces only when no parsed link resolves', () => {
    const candidates = lineCandidates('  File "my dir/app.py", line 7, in run', 'posix');
    const paths = requestPaths(candidates);
    expect(paths).toContain('my dir/app.py');
    const only = confirmedLinks(candidates, paths, paths.map((path) => (path === 'my dir/app.py' ? 'file' : null)));
    expect(only).toEqual([expect.objectContaining({ path: 'my dir/app.py', line: 7 })]);
    const both = confirmedLinks(candidates, paths, paths.map((path) => (path === 'my dir/app.py' || path === 'dir/app.py' ? 'file' : null)));
    expect(both.map((link) => link.path)).toEqual(['dir/app.py']);
  });

  it('makes no link of a path main did not confirm', () => {
    const candidates = lineCandidates('../outside/secret.ts:1 /etc/passwd', 'posix');
    const paths = requestPaths(candidates);
    expect(paths).toEqual(expect.arrayContaining(['../outside/secret.ts', '/etc/passwd']));
    expect(confirmedLinks(candidates, paths, paths.map(() => null))).toEqual([]);
  });
});

describe('wrapped lines and link ranges', () => {
  // A row of cells: a 'W' is a wide character followed by its empty right half.
  function lines(rows: Array<{ text: string; wrapped: boolean }>): LinkLines {
    const cell = (chars: string, width: number): IBufferCell => ({ getChars: () => chars, getWidth: () => width }) as IBufferCell;
    return {
      getLine: (y) => {
        const row = rows[y];
        if (!row) return undefined;
        const cells = [...row.text].flatMap((char) => (char === 'W' ? [cell('\u4e2d', 2), cell('', 0)] : [cell(char === ' ' ? '' : char, 1)]));
        return { isWrapped: row.wrapped, getCell: (x: number) => cells[x] };
      },
    };
  }

  it('joins a wrapped line and maps text back to cells across the wrap', () => {
    const buffer = lines([{ text: 'xx src/ap', wrapped: false }, { text: 'p.ts:4   ', wrapped: true }]);
    const line = readWrappedLine(buffer, 1, 9, {} as IBufferCell);
    expect(line.text).toBe('xx src/app.ts:4');
    const link = lineCandidates(line.text, 'posix').parsed[0]!;
    expect(rangeOf(line, link.start, link.end)).toEqual({ start: { x: 4, y: 1 }, end: { x: 6, y: 2 } });
  });

  it('counts a wide character as two cells', () => {
    const buffer = lines([{ text: 'W a/b.ts', wrapped: false }]);
    const line = readWrappedLine(buffer, 0, 9, {} as IBufferCell);
    expect(line.text).toBe('\u4e2d a/b.ts');
    expect(rangeOf(line, 2, 8)).toEqual({ start: { x: 4, y: 1 }, end: { x: 9, y: 1 } });
  });
});

describe('icon and colour', () => {
  it('draws the custom icon, tinted by the colour, else the profile\'s own glyph and hue', () => {
    expect(terminalGlyph({ icon: 'powershell', customIcon: null, color: null })).toEqual(TERMINAL_ICON.powershell);
    expect(terminalGlyph({ icon: 'cmd', customIcon: 'rocket', color: 'red' }).color).toBe('var(--terminal-tint-1)');
    expect(glyphLook('rocket').color).toBe('var(--d-muted)');
    expect(colorTint('white')).toBe('var(--terminal-tint-7)');
  });

  it('lists main\'s picker items with glyphs, the current one checked and active first', () => {
    const items: OverlayQuickPickItem[] = [
      { id: 'default', label: 'Default', glyph: 'cmd' },
      { id: 'red', label: 'Red', glyph: 'cmd', color: 'red' },
      { id: 'blue', label: 'Blue', glyph: 'cmd', color: 'blue', current: true },
    ];
    const model = overlayPickModel(items, '');
    expect(model.activeId).toBe('blue');
    const blue = model.rows[2];
    expect(blue?.kind === 'item' && blue.item).toMatchObject({ checked: true, iconColor: 'var(--terminal-tint-4)' });
    expect(overlayPickModel(items, 're').rows.map((row) => (row.kind === 'item' ? row.item.id : ''))).toEqual(['red']);
    expect(overlayPickModel([{ id: 'pwsh', label: 'PowerShell', description: 'C:/pwsh.exe' }], 'pwsh.exe').rows).toHaveLength(1);
  });
});

describe('live terminal options', () => {
  const settings: TerminalSettings = { fontSize: 13, scrollback: 1000, cursorStyle: 'bar', fontFamily: '', lineHeight: 1.4, cursorBlinking: true, macOptionIsMeta: true, decorationsEnabled: true };
  const valid = (): boolean => true;

  it('maps Settings › Terminal onto xterm, an empty family to the app mono font', () => {
    expect(liveOptions(settings, 'darwin', 'JetBrains Mono', 13, valid)).toEqual({
      fontFamily: 'JetBrains Mono', fontSize: 13, lineHeight: 1.4, scrollback: 1000, cursorStyle: 'bar', cursorBlink: true, macOptionIsMeta: true,
    });
    expect(liveOptions({ ...settings, fontFamily: ' Cascadia Code, monospace ' }, 'win32', 'mono', 13, valid)).toMatchObject({ fontFamily: 'Cascadia Code, monospace', macOptionIsMeta: false });
  });

  it('keeps the app mono font for a family CSS cannot parse', () => {
    expect(liveOptions({ ...settings, fontFamily: '"unclosed' }, 'linux', 'mono', 13, () => false).fontFamily).toBe('mono');
  });

  it('counts as a font list only what parses in the font shorthand and substitutes nothing', () => {
    const asked: string[] = [];
    const supports = (property: string, value: string): boolean => {
      asked.push(`${property}: ${value}`);
      return value !== '1px inherit';
    };
    expect(isFontList('"Cascadia Code", monospace', supports)).toBe(true);
    expect(isFontList('inherit', supports)).toBe(false);
    for (const family of ['var(--d-mono)', 'Fira Code, VAR (--x)', 'env(safe-area-inset-top)', 'attr(data-font)']) expect(isFontList(family, supports), family).toBe(false);
    expect(asked).toEqual(['font: 1px "Cascadia Code", monospace', 'font: 1px inherit']);
  });
});

describe('Edit menu paste in the terminal pane', () => {
  // The pane reports which focus it holds; main sends Edit › Paste to the pty only for the xterm's own input.
  it('counts only the xterm\'s helper textarea as its input, not the Find box, another textarea or a row', () => {
    const xterm = document.createElement('textarea');
    xterm.className = 'xterm-helper-textarea';
    const rename = document.createElement('textarea');
    const find = document.createElement('input');
    const row = document.createElement('div');
    expect(isXtermInput(xterm)).toBe(true);
    expect(isXtermInput(rename)).toBe(false);
    expect(isXtermInput(find)).toBe(false);
    expect(isXtermInput(row)).toBe(false);
    expect(isXtermInput(null)).toBe(false);
  });
});

describe('terminal store', () => {
  it('starts the palette\'s rename, routes main\'s paste request, and ends a rename whose terminal left', async () => {
    const api = fakeShellApi();
    const info = { id: 'term-1', title: 'cmd', name: null, profileId: 'cmd', icon: 'cmd' as const, customIcon: null, color: null, projectKey: 'a', projectName: 'a', status: 'running' as const, exitCode: null, description: null, running: null, integrated: false };
    api.terminal.getState = async () => ({ ...TERMINAL_STATE, terminals: [info], activeId: 'term-1' });
    const store = createTerminalStore(api);
    await store.start();
    api.terminal.startRename('term-1');
    expect(store.renaming.value).toEqual({ id: 'term-1', returnTo: 'terminal' });
    api.terminal.startRename('term-9');
    expect(store.renaming.value?.id).toBe('term-1');
    api.terminal.requestPaste('term-1');
    expect(store.pasteRequest.value?.id).toBe('term-1');
    api.terminal.pushState({ ...TERMINAL_STATE, terminals: [] });
    expect(store.renaming.value).toBeNull();
    store.stop();
  });

  it('hands a view each batch with its shell events, held until it attaches, and routes the palette\'s buffer commands', async () => {
    const api = fakeShellApi();
    const store = createTerminalStore(api);
    await store.start();
    const events = [{ offset: 2, event: { kind: 'promptStart' as const } }];
    api.terminal.data({ id: 'term-1', data: 'ab$ ', events });
    api.terminal.data({ id: 'term-1', data: 'x' });
    const batches: unknown[] = [];
    store.attach('term-1', (batch) => batches.push(batch));
    expect(batches).toEqual([{ data: 'ab$ ', events }, { data: 'x' }]);
    api.terminal.runAction({ id: 'term-1', action: 'copyLastCommandOutput' });
    expect(store.actionRequest.value).toMatchObject({ id: 'term-1', action: 'copyLastCommandOutput' });
    store.stop();
  });
});
