import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clampToWorkAreas,
  DEFAULT_SHELL_LAYOUT,
  EMPTY_EDITOR,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  parseGridLayout,
  parseGridSizes,
  parsePersistedEditor,
  parsePersistedTab,
  parsePersistedTerminals,
  parseSearchEditorConfig,
  parseSearchHistory,
  parseSearchViewState,
  parseShellLayout,
  parseSidebarLayout,
  WINDOW_LAYOUT_FILE,
  WindowLayoutStore,
} from '../window-layout-store';
import { DEFAULT_GRID_LAYOUT, moveGridPane, toggleGridMaximize, toggleGridPane } from '../../preload/shell-channels';
import { TERMINAL_LIST_DEFAULT_REM, TERMINAL_LIST_MAX_REM, TERMINAL_LIST_MIN_REM } from '../../preload/terminal-channels';
import { DEFAULT_PERSISTED_TERMINALS } from '../terminal/terminal-service';
import { flushAcrossHeldRename } from '../../../__mocks__/held-rename';

let dir: string;
let lines: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-layout-'));
  lines = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const log = (line: string): void => {
  lines.push(line);
};

function writeFile(content: unknown): void {
  fs.writeFileSync(path.join(dir, WINDOW_LAYOUT_FILE), JSON.stringify(content));
}

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };
const RIGHT = { x: 1920, y: 0, width: 2560, height: 1400 };

describe('clampToWorkAreas', () => {
  it('keeps bounds that lie on a display', () => {
    expect(clampToWorkAreas({ x: 100, y: 50, width: 1200, height: 800 }, [PRIMARY, RIGHT])).toEqual({ x: 100, y: 50, width: 1200, height: 800 });
    expect(clampToWorkAreas({ x: 2000, y: 100, width: 1200, height: 800 }, [PRIMARY, RIGHT])).toEqual({ x: 2000, y: 100, width: 1200, height: 800 });
  });

  it('moves a window left on a disconnected display onto the nearest one', () => {
    expect(clampToWorkAreas({ x: 5000, y: 200, width: 1200, height: 800 }, [PRIMARY, RIGHT])).toEqual({ x: 1920 + 2560 - 1200, y: 200, width: 1200, height: 800 });
    expect(clampToWorkAreas({ x: -3000, y: -900, width: 1200, height: 800 }, [PRIMARY, RIGHT])).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
  });

  it('pulls a window hanging off an edge fully onto the display it overlaps most', () => {
    expect(clampToWorkAreas({ x: 1500, y: 900, width: 1200, height: 800 }, [PRIMARY])).toEqual({ x: 1920 - 1200, y: 1040 - 800, width: 1200, height: 800 });
  });

  it('shrinks a window larger than the display, never below the window minimum', () => {
    expect(clampToWorkAreas({ x: 0, y: 0, width: 4000, height: 3000 }, [PRIMARY])).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
    const small = { x: 0, y: 0, width: 800, height: 500 };
    expect(clampToWorkAreas({ x: 0, y: 0, width: 1200, height: 800 }, [small])).toEqual({ x: 0, y: 0, width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT });
  });
});

describe('parseShellLayout', () => {
  it('accepts a complete layout within the minimums', () => {
    expect(parseShellLayout(DEFAULT_SHELL_LAYOUT)).toEqual(DEFAULT_SHELL_LAYOUT);
  });

  it('drops the Chats size an earlier version wrote', () => {
    const older = { ...DEFAULT_SHELL_LAYOUT, sections: { ...DEFAULT_SHELL_LAYOUT.sections, chats: { collapsed: true, size: 400 } } };
    expect(parseShellLayout(older)).toEqual({ ...DEFAULT_SHELL_LAYOUT, sections: { ...DEFAULT_SHELL_LAYOUT.sections, chats: { collapsed: true } } });
  });

  it.each([
    ['a narrow sidebar', { ...DEFAULT_SHELL_LAYOUT, sidebarWidth: 219 }],
    ['a small section', { ...DEFAULT_SHELL_LAYOUT, sections: { ...DEFAULT_SHELL_LAYOUT.sections, projects: { collapsed: false, size: 59 } } }],
    ['a Chats section without its flag', { ...DEFAULT_SHELL_LAYOUT, sections: { ...DEFAULT_SHELL_LAYOUT.sections, chats: {} } }],
    ['a missing section', { ...DEFAULT_SHELL_LAYOUT, sections: { projects: DEFAULT_SHELL_LAYOUT.sections.projects } }],
    ['a string flag', { ...DEFAULT_SHELL_LAYOUT, sidebarVisible: 'yes' }],
    ['an infinite width', { ...DEFAULT_SHELL_LAYOUT, sidebarWidth: Number.POSITIVE_INFINITY }],
    ['an array', []],
  ])('rejects %s', (_name, raw) => {
    expect(parseShellLayout(raw)).toBeUndefined();
  });
});

// Each shell part reports only its own fields, so neither report can carry a stale copy of the other's.
describe('shell reports', () => {
  it('reads the sidebar\'s fields alone from a report', () => {
    const { sidebarWidth, sections, search } = DEFAULT_SHELL_LAYOUT;
    expect(parseSidebarLayout({ ...DEFAULT_SHELL_LAYOUT, sidebarVisible: false })).toEqual({ sidebarWidth, sections, search });
    expect(parseSidebarLayout({ sidebarWidth: 100, sections, search })).toBeUndefined();
  });

  it('reads the grid\'s sash sizes alone from a report and rejects one out of range', () => {
    expect(parseGridSizes({ ...DEFAULT_GRID_LAYOUT, sideWidth: 640, bottomHeight: 300 })).toEqual({ sideWidth: 640, bottomHeight: 300 });
    expect(parseGridSizes({ sideWidth: -1, bottomHeight: 300 })).toBeUndefined();
    expect(parseGridSizes({ sideWidth: 640 })).toBeUndefined();
  });
});

describe('grid layout', () => {
  it('swaps a pane into an occupied slot, shows it, and keeps a maximized pane only while it keeps its slot', () => {
    const terminalSide = moveGridPane(DEFAULT_GRID_LAYOUT, 'terminal', 'side');
    expect(terminalSide.slots).toEqual({ main: 'chat', side: 'terminal', bottom: 'editor' });
    expect(terminalSide.visible).toEqual({ editor: true, terminal: true });
    const maximized = toggleGridMaximize(terminalSide, 'terminal');
    expect(maximized.maximized).toBe('terminal');
    expect(moveGridPane(maximized, 'editor', 'main').maximized).toBe('terminal');
    expect(moveGridPane(maximized, 'chat', 'side').maximized).toBeNull();
    expect(toggleGridPane(maximized, 'terminal')).toMatchObject({ visible: { terminal: false }, maximized: null });
    expect(toggleGridMaximize(maximized, 'terminal').maximized).toBeNull();
    expect(moveGridPane(DEFAULT_GRID_LAYOUT, 'chat', 'main')).toEqual(DEFAULT_GRID_LAYOUT);
  });

  it.each([
    ['a pane in two slots', { ...DEFAULT_GRID_LAYOUT, slots: { main: 'chat', side: 'chat', bottom: 'terminal' } }],
    ['an unknown pane', { ...DEFAULT_GRID_LAYOUT, slots: { main: 'browser', side: 'editor', bottom: 'terminal' } }],
    ['a string flag', { ...DEFAULT_GRID_LAYOUT, visible: { editor: 'yes', terminal: false } }],
    ['a negative size', { ...DEFAULT_GRID_LAYOUT, sideWidth: -1 }],
    ['an unknown maximized pane', { ...DEFAULT_GRID_LAYOUT, maximized: 'sidebar' }],
  ])('rejects %s', (_name, raw) => {
    expect(parseGridLayout(raw)).toBeUndefined();
  });

  it('reads a version 1 file with the Files section and the grid at their defaults', () => {
    const v1Sidebar = { sidebarVisible: false, sidebarWidth: 300, sections: { projects: { collapsed: true, size: 120 }, chats: { collapsed: false } } };
    writeFile({ version: 1, sidebar: v1Sidebar });
    expect(new WindowLayoutStore(dir, log).sidebar()).toEqual({
      ...v1Sidebar,
      sections: { ...v1Sidebar.sections, files: DEFAULT_SHELL_LAYOUT.sections.files, search: DEFAULT_SHELL_LAYOUT.sections.search },
      grid: DEFAULT_GRID_LAYOUT,
      search: {},
    });
    expect(lines).toEqual([]);
  });

  it('resets the grid with Restore default layout and keeps the open editors, while clear drops them too', async () => {
    const store = new WindowLayoutStore(dir, log);
    store.setSidebar({ ...DEFAULT_SHELL_LAYOUT, grid: moveGridPane(DEFAULT_GRID_LAYOUT, 'terminal', 'side') });
    store.setEditor({ tabs: [{ kind: 'log', name: 'Damocles.log' }], active: 0, recent: [] });
    store.reset();
    expect(store.sidebar().grid).toEqual(DEFAULT_GRID_LAYOUT);
    expect(store.editor().tabs).toHaveLength(1);
    store.clear();
    expect(store.editor()).toEqual(EMPTY_EDITOR);
    await store.flush();
  });

  it('flush waits for a write in flight and for one queued while it waits', async () => {
    const store = new WindowLayoutStore(dir, log);
    const onDisk = await flushAcrossHeldRename(path.join(dir, WINDOW_LAYOUT_FILE), {
      first: () => store.setEditor({ tabs: [{ kind: 'log', name: 'first.log' }], active: 0, recent: [] }),
      flush: () => store.flush(),
      second: () => store.setEditor({ tabs: [{ kind: 'log', name: 'second.log' }], active: 0, recent: [] }),
      onDisk: () => new WindowLayoutStore(dir, log).editor().tabs,
    });
    expect(onDisk).toEqual([{ kind: 'log', name: 'second.log' }]);
  });
});

describe('the window layout across a quit or a window close', () => {
  it('keeps the layout from before the teardown while sealed, and writes again once unsealed', async () => {
    const store = new WindowLayoutStore(dir, log);
    const placement = { bounds: { x: 10, y: 20, width: 1000, height: 700 }, maximized: false, fullScreen: false };
    store.setWindow(placement);
    store.setEditor({ tabs: [{ kind: 'log', name: 'kept.log' }], active: 0, recent: [] });
    await store.flush();
    const file = path.join(dir, WINDOW_LAYOUT_FILE);
    const before = fs.readFileSync(file, 'utf8');

    store.seal();
    store.setWindow({ ...placement, maximized: true });
    store.setSidebar({ ...DEFAULT_SHELL_LAYOUT, sidebarWidth: 400 });
    store.setEditor({ tabs: [], active: null, recent: [] });
    store.setTerminals({ ...DEFAULT_PERSISTED_TERMINALS, active: 3 });
    store.clearSearchHistory();
    store.reset();
    store.clear();
    await store.flush();
    expect(store.window()).toEqual(placement);
    expect(store.editor().tabs).toEqual([{ kind: 'log', name: 'kept.log' }]);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);

    store.unseal();
    store.setWindow({ ...placement, maximized: true });
    await store.flush();
    expect(new WindowLayoutStore(dir, log).window()?.maximized).toBe(true);
  });
});

describe('Search view state', () => {
  const OLD_VIEW = { pattern: 'fo+', isRegex: true, matchCase: true, wholeWord: false, useExcludeSettingsAndIgnoreFiles: false, replaceOpen: true, include: 'src/**', exclude: '*.md' };
  const HISTORY = { query: ['a', 'fo+'], replace: ['b'], include: ['src/**'], exclude: [] };
  const VIEW = { ...OLD_VIEW, onlyOpenEditors: true, preserveCase: true, detailsOpen: true, viewMode: 'tree' as const, history: HISTORY, replaceText: 'b$1' };

  it('restores each project\'s query, toggles, replace row and globs after a relaunch', async () => {
    const store = new WindowLayoutStore(dir, log);
    store.setSidebar({ ...DEFAULT_SHELL_LAYOUT, sections: { ...DEFAULT_SHELL_LAYOUT.sections, search: { collapsed: false, size: 300 } }, search: { p1: VIEW, p2: { ...VIEW, pattern: 'other' } } });
    await store.flush();
    const sidebar = new WindowLayoutStore(dir, log).sidebar();
    expect(sidebar.search).toEqual({ p1: VIEW, p2: { ...VIEW, pattern: 'other' } });
    expect(sidebar.sections.search).toEqual({ collapsed: false, size: 300 });
    expect(lines).toEqual([]);
  });

  it('reads a Search state written before the open-editors toggle, Preserve Case, details, view mode and history with their defaults', () => {
    expect(parseSearchViewState(OLD_VIEW)).toEqual({ ...OLD_VIEW, onlyOpenEditors: false, preserveCase: false, detailsOpen: false, viewMode: 'list', history: { query: [], replace: [], include: [], exclude: [] }, replaceText: '' });
  });

  it("keeps the replace text within the replace input's bound and refuses one that is too long or not a string", () => {
    expect(parseSearchViewState({ ...VIEW, replaceText: 'x'.repeat(2000) })?.replaceText).toBe('x'.repeat(2000));
    expect(parseSearchViewState({ ...VIEW, replaceText: 'x'.repeat(2001) })).toBeUndefined();
    expect(parseSearchViewState({ ...VIEW, replaceText: 7 })).toBeUndefined();
  });

  it('refuses a history over VS Code\'s 100 entries, an entry longer than its input allows, or a list that is not strings', () => {
    expect(parseSearchHistory(HISTORY)).toEqual(HISTORY);
    expect(parseSearchHistory({ ...HISTORY, query: Array.from({ length: 100 }, (_, i) => String(i)) })).toBeDefined();
    expect(parseSearchHistory({ ...HISTORY, query: Array.from({ length: 101 }, (_, i) => String(i)) })).toBeUndefined();
    expect(parseSearchHistory({ ...HISTORY, query: ['x'.repeat(2001)] })).toBeUndefined();
    expect(parseSearchHistory({ ...HISTORY, include: ['y'.repeat(4001)] })).toBeUndefined();
    expect(parseSearchHistory({ ...HISTORY, replace: [1] })).toBeUndefined();
    expect(parseSearchHistory({ query: [], replace: [], include: [] })).toBeUndefined();
    expect(parseSearchViewState({ ...VIEW, history: { ...HISTORY, exclude: 'x' } })).toBeUndefined();
    expect(parseSearchViewState({ ...VIEW, viewMode: 'grid' })).toBeUndefined();
  });

  it('clears every project\'s history on Clear Search History and keeps the rest of each state', async () => {
    const store = new WindowLayoutStore(dir, log);
    store.setSidebar({ ...DEFAULT_SHELL_LAYOUT, search: { p1: VIEW, p2: { ...VIEW, pattern: 'other' } } });
    store.clearSearchHistory();
    const empty = { query: [], replace: [], include: [], exclude: [] };
    expect(store.sidebar().search).toEqual({ p1: { ...VIEW, history: empty }, p2: { ...VIEW, pattern: 'other', history: empty } });
    await store.flush();
    expect(new WindowLayoutStore(dir, log).sidebar().search['p1']?.history).toEqual(empty);
  });

  it('reads a layout written before Search with the section collapsed and no saved queries', () => {
    const { search: _search, ...older } = DEFAULT_SHELL_LAYOUT;
    const { search: _section, ...sections } = older.sections;
    expect(parseShellLayout({ ...older, sections })).toEqual(DEFAULT_SHELL_LAYOUT);
    expect(DEFAULT_SHELL_LAYOUT.sections.search.collapsed).toBe(true);
  });

  it('drops a malformed or oversized project entry and keeps the rest', () => {
    const parsed = parseShellLayout({
      ...DEFAULT_SHELL_LAYOUT,
      search: { good: VIEW, long: { ...VIEW, pattern: 'x'.repeat(2001) }, globs: { ...VIEW, include: 'y'.repeat(4001) }, flag: { ...VIEW, isRegex: 'yes' }, missing: { pattern: 'a' } },
    });
    expect(parsed?.search).toEqual({ good: VIEW });
    expect(parseShellLayout({ ...DEFAULT_SHELL_LAYOUT, search: [] })).toBeUndefined();
    expect(parseShellLayout({ ...DEFAULT_SHELL_LAYOUT, sections: { ...DEFAULT_SHELL_LAYOUT.sections, search: { collapsed: 'no', size: 100 } } })).toBeUndefined();
  });

  it('keeps the saved queries through Restore default layout and drops them when layouts are not restored', async () => {
    const store = new WindowLayoutStore(dir, log);
    store.setSidebar({ ...DEFAULT_SHELL_LAYOUT, search: { p1: VIEW } });
    store.reset();
    expect(store.sidebar()).toEqual({ ...DEFAULT_SHELL_LAYOUT, search: { p1: VIEW } });
    store.clear();
    expect(store.sidebar()).toEqual(DEFAULT_SHELL_LAYOUT);
    await store.flush();
  });
});

describe('saved editors', () => {
  const BACKUP = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const OUTSIDE_README = path.resolve(os.tmpdir(), 'outside', 'readme.md');

  it('keeps every valid tab and recent file and drops each malformed one with a log line', () => {
    const editor = parsePersistedEditor({
      tabs: [
        { kind: 'code', file: { projectKey: 'p', relativePath: 'src/a.ts' }, backupId: BACKUP },
        { kind: 'code', file: { projectKey: 'p', relativePath: '../escape.ts' } },
        { kind: 'markdownPreview', path: OUTSIDE_README },
        { kind: 'code', path: 'relative.ts' },
        { kind: 'settings', scope: 'user' },
        { kind: 'settings', scope: 'machine' },
        { kind: 'log', name: 'Damocles.log' },
        { kind: 'log', name: '../../secrets.log' },
        { kind: 'untitled', backupId: BACKUP },
        { kind: 'untitled' },
        { kind: 'diff' },
        { kind: 'code', file: { projectKey: 'p', relativePath: 'b.ts' }, backupId: 'not-a-uuid' },
      ],
      active: 6,
      recent: [{ projectKey: 'p', relativePath: 'src/a.ts' }, { projectKey: 'p', relativePath: '/abs' }],
    }, log);
    expect(editor.tabs).toEqual([
      { kind: 'code', file: { projectKey: 'p', relativePath: 'src/a.ts' }, backupId: BACKUP },
      { kind: 'markdownPreview', path: OUTSIDE_README },
      { kind: 'settings', scope: 'user' },
      { kind: 'log', name: 'Damocles.log' },
      { kind: 'untitled', backupId: BACKUP },
    ]);
    expect(editor.active).toBe(3);
    expect(editor.recent).toEqual([{ projectKey: 'p', relativePath: 'src/a.ts' }]);
    expect(lines.filter((line) => line === '[layout] dropping a malformed editor tab')).toHaveLength(7);
    expect(lines).toContain('[layout] dropping a malformed recent file');
  });

  it('keeps a saved Search Editor by its .code-search file or by its header, and drops one out of bounds', () => {
    const config = { query: 'x', isRegex: false, matchCase: true, wholeWord: false, include: '', exclude: '', useExcludeSettingsAndIgnoreFiles: true, onlyOpenEditors: false, contextLines: 2, showIncludesExcludes: false };
    expect(parsePersistedTab({ kind: 'searchEditor', file: { projectKey: 'p', relativePath: 'q.code-search' }, backupId: BACKUP })).toEqual({ kind: 'searchEditor', file: { projectKey: 'p', relativePath: 'q.code-search' }, backupId: BACKUP });
    expect(parsePersistedTab({ kind: 'searchEditor', projectKey: 'p', config })).toEqual({ kind: 'searchEditor', projectKey: 'p', config });
    expect(parsePersistedTab({ kind: 'searchEditor', config })).toEqual({ kind: 'searchEditor', config });
    expect(parsePersistedTab({ kind: 'searchEditor', file: { projectKey: 'p', relativePath: '../q.code-search' } })).toBeUndefined();
    expect(parsePersistedTab({ kind: 'searchEditor', projectKey: 'p', config: { ...config, contextLines: Number.POSITIVE_INFINITY } })).toBeUndefined();
    expect(parsePersistedTab({ kind: 'searchEditor', projectKey: 7, config })).toBeUndefined();
    expect(parseSearchEditorConfig({ ...config, contextLines: 101 })).toBeUndefined();
    expect(parseSearchEditorConfig({ ...config, contextLines: -1 })).toBeUndefined();
    expect(parseSearchEditorConfig({ ...config, query: 'q'.repeat(2001) })).toBeUndefined();
  });

  it('round-trips the editor through the file', async () => {
    const store = new WindowLayoutStore(dir, log);
    const editor = { tabs: [{ kind: 'code' as const, file: { projectKey: 'p', relativePath: 'a.ts' } }], active: 0, recent: [{ projectKey: 'p', relativePath: 'a.ts' }] };
    store.setEditor(editor);
    await store.flush();
    expect(new WindowLayoutStore(dir, log).editor()).toEqual(editor);
  });
});

const single = { panes: 1, activePane: 0, sizes: [1] };
const savedTerminal = (profileId: string): Record<string, unknown> => ({ profileId, projectKey: 'p', name: null, customIcon: null, color: null });

describe('saved terminals', () => {
  it('reads the split groups with their active panes and sizes, and gives each terminal its own group in a list saved without them', () => {
    const terminals = [savedTerminal('pwsh'), savedTerminal('cmd'), savedTerminal('bash')];
    const groups = [{ panes: 2, activePane: 1, sizes: [0.6, 0.4] }, single];
    expect(parsePersistedTerminals({ terminals, active: 1, listWidthRem: 12, groups }, log).groups).toEqual(groups);
    expect(parsePersistedTerminals({ terminals, active: 1, listWidthRem: 12 }, log).groups).toEqual([single, single, single]);
    expect(lines).toEqual([]);
  });

  it('gives each terminal its own group, with a log line, when the saved groups do not fit the list', () => {
    const terminals = [savedTerminal('pwsh'), savedTerminal('cmd'), savedTerminal('bash')];
    const broken: unknown[] = [
      'x',
      [{ panes: 2, activePane: 0, sizes: [0.5, 0.5] }],
      [{ panes: 2, activePane: 0, sizes: [0.5, 0.5] }, { panes: 2, activePane: 0, sizes: [0.5, 0.5] }],
      [{ panes: 2, activePane: 2, sizes: [0.5, 0.5] }, single],
      [{ panes: 2, activePane: 0, sizes: [0.9, 0.2] }, single],
      [{ panes: 2, activePane: 0, sizes: [0.99, 0.01] }, single],
      [{ panes: 2, activePane: 0, sizes: [0.5] }, single],
      [{ panes: 0, activePane: 0, sizes: [] }, { panes: 3, activePane: 0, sizes: [0.4, 0.3, 0.3] }],
      [{ panes: 2.5, activePane: 0, sizes: [0.5, 0.5] }, single],
      [{ panes: 2, activePane: 0, sizes: [0.5, '0.5'] }, single],
      ['x', single, single],
    ];
    for (const groups of broken) {
      expect(parsePersistedTerminals({ terminals, active: 0, listWidthRem: 12, groups }, log).groups).toEqual([single, single, single]);
    }
    expect(lines.filter((line) => line === '[layout] the saved terminal groups do not fit the terminal list; giving each terminal its own group')).toHaveLength(broken.length);
    const many = Array.from({ length: 9 }, () => savedTerminal('pwsh'));
    expect(parsePersistedTerminals({ terminals: many, active: 0, listWidthRem: 12, groups: [{ panes: 9, activePane: 0, sizes: Array.from({ length: 9 }, () => 1 / 9) }] }, log).groups).toHaveLength(9);
  });

  it('gives each terminal its own group when a malformed terminal was dropped from a split list', () => {
    const parsed = parsePersistedTerminals({ terminals: [savedTerminal('pwsh'), 'x', savedTerminal('bash')], active: 0, listWidthRem: 12, groups: [{ panes: 3, activePane: 0, sizes: [0.4, 0.3, 0.3] }] }, log);
    expect(parsed.groups).toEqual([single, single]);
  });

  it('round-trips the terminal list, the active terminal and the list width through the file', async () => {
    const store = new WindowLayoutStore(dir, log);
    expect(store.terminals()).toEqual({ terminals: [], active: null, listWidthRem: TERMINAL_LIST_DEFAULT_REM, groups: [] });
    const terminals = {
      terminals: [
        { profileId: 'pwsh', projectKey: 'c:\\work\\alpha', name: 'server', customIcon: 'rocket' as const, color: 'green' as const },
        { profileId: 'wsl:Ubuntu-24.04', projectKey: 'c:\\work\\beta', name: null, customIcon: null, color: null },
      ],
      active: 1,
      listWidthRem: 15,
      groups: [{ panes: 2, activePane: 1, sizes: [0.7, 0.3] }],
    };
    store.setTerminals(terminals);
    await store.flush();
    expect(new WindowLayoutStore(dir, log).terminals()).toEqual(terminals);
  });

  it('drops each malformed terminal, keeps the active one on its terminal, and clamps the list width', () => {
    const parsed = parsePersistedTerminals({
      terminals: [{ profileId: 'pwsh' }, { profileId: '', projectKey: 'p' }, { profileId: 'cmd', projectKey: 'p', cwd: 'C:\\' }, 'x', { profileId: 'bash', projectKey: 'q' }],
      active: 4,
      listWidthRem: 100,
    }, log);
    // a path stored beside a terminal is never read back
    const plain = { name: null, customIcon: null, color: null };
    expect(parsed).toEqual({ terminals: [{ profileId: 'cmd', projectKey: 'p', ...plain }, { profileId: 'bash', projectKey: 'q', ...plain }], active: 1, listWidthRem: TERMINAL_LIST_MAX_REM, groups: [single, single] });
    expect(lines.filter((line) => line === '[layout] dropping a malformed terminal')).toHaveLength(3);
    expect(parsePersistedTerminals({ terminals: [], active: 0, listWidthRem: 0 }, log)).toEqual({ terminals: [], active: null, listWidthRem: TERMINAL_LIST_MIN_REM, groups: [] });
    expect(parsePersistedTerminals('x', log)).toEqual(DEFAULT_PERSISTED_TERMINALS);
  });

  it('drops a stored name, icon or color main would refuse now, and keeps the terminal', () => {
    const parsed = parsePersistedTerminals({
      terminals: [
        { profileId: 'pwsh', projectKey: 'p', name: 'evil\u202Etxt', customIcon: '../../x', color: '#f00' },
        { profileId: 'cmd', projectKey: 'q', name: 'x'.repeat(65), customIcon: 'powershell', color: 7 },
        { profileId: 'bash', projectKey: 'r', name: '  ok  ', customIcon: 'bug', color: 'red' },
        { profileId: 'zsh', projectKey: 's' },
      ],
      active: 0,
      listWidthRem: 12,
    }, log);
    expect(parsed.terminals).toEqual([
      { profileId: 'pwsh', projectKey: 'p', name: null, customIcon: null, color: null },
      { profileId: 'cmd', projectKey: 'q', name: null, customIcon: null, color: null },
      { profileId: 'bash', projectKey: 'r', name: 'ok', customIcon: 'bug', color: 'red' },
      { profileId: 'zsh', projectKey: 's', name: null, customIcon: null, color: null },
    ]);
    expect(lines.filter((line) => line === '[layout] dropping the malformed name of a terminal')).toHaveLength(2);
    expect(lines.filter((line) => line === '[layout] dropping the unknown icon of a terminal')).toHaveLength(2);
    expect(lines.filter((line) => line === '[layout] dropping the unknown color of a terminal')).toHaveLength(2);
  });

  it('reads a layout written before terminals with none, and drops them when layouts are not restored', async () => {
    writeFile({ version: 2, sidebar: DEFAULT_SHELL_LAYOUT });
    const store = new WindowLayoutStore(dir, log);
    expect(store.terminals()).toEqual(DEFAULT_PERSISTED_TERMINALS);
    store.setTerminals({ terminals: [{ profileId: 'cmd', projectKey: 'p', name: null, customIcon: null, color: null }], active: 0, listWidthRem: 10, groups: [single] });
    store.reset();
    expect(store.terminals().terminals).toHaveLength(1);
    store.clear();
    expect(store.terminals()).toEqual(DEFAULT_PERSISTED_TERMINALS);
    await store.flush();
  });
});

describe('WindowLayoutStore', () => {
  it('round-trips the window placement and the sidebar layout', async () => {
    const store = new WindowLayoutStore(dir, log);
    expect(store.window()).toBeUndefined();
    expect(store.sidebar()).toEqual(DEFAULT_SHELL_LAYOUT);
    store.setWindow({ bounds: { x: 10, y: 20, width: 1300, height: 900 }, maximized: true, fullScreen: false });
    const sidebar = { ...DEFAULT_SHELL_LAYOUT, sidebarVisible: false, sidebarWidth: 300, sections: { ...DEFAULT_SHELL_LAYOUT.sections, projects: { collapsed: true, size: 120 } } };
    store.setSidebar(sidebar);
    await store.flush();

    expect(JSON.parse(fs.readFileSync(path.join(dir, WINDOW_LAYOUT_FILE), 'utf8'))).toEqual({
      version: 2,
      window: { x: 10, y: 20, width: 1300, height: 900, maximized: true, fullScreen: false },
      sidebar,
      editor: EMPTY_EDITOR,
      terminals: DEFAULT_PERSISTED_TERMINALS,
    });
    const next = new WindowLayoutStore(dir, log);
    expect(next.window()).toEqual({ bounds: { x: 10, y: 20, width: 1300, height: 900 }, maximized: true, fullScreen: false });
    expect(next.sidebar()).toEqual(sidebar);
  });

  it('drops malformed window bounds and a malformed sidebar with a log line, keeping the defaults', () => {
    writeFile({ version: 1, window: { x: 0, y: 0, width: 100, height: 900, maximized: false, fullScreen: false }, sidebar: { sidebarVisible: true } });
    const store = new WindowLayoutStore(dir, log);
    expect(store.window()).toBeUndefined();
    expect(store.sidebar()).toEqual(DEFAULT_SHELL_LAYOUT);
    expect(lines).toEqual(['[layout] dropping malformed window bounds', '[layout] dropping a malformed sidebar layout']);
  });

  // Raw JSON text: JSON.stringify writes NaN and Infinity as null, and 1e999 parses to Infinity.
  it.each([
    '"x": null, "y": 0',
    '"x": 1e999, "y": 0',
    '"x": 1e9, "y": 0',
    '"x": 0, "y": "0"',
  ])('rejects a window position %s', (position) => {
    fs.writeFileSync(path.join(dir, WINDOW_LAYOUT_FILE), `{"version": 1, "window": {${position}, "width": 1200, "height": 800, "maximized": false, "fullScreen": false}}`);
    expect(new WindowLayoutStore(dir, log).window()).toBeUndefined();
    expect(lines).toEqual(['[layout] dropping malformed window bounds']);
  });

  it('ignores an unknown schema and unreadable JSON', () => {
    writeFile({ version: 3, window: {} });
    expect(new WindowLayoutStore(dir, log).window()).toBeUndefined();
    fs.writeFileSync(path.join(dir, WINDOW_LAYOUT_FILE), '{not json');
    expect(new WindowLayoutStore(dir, log).sidebar()).toEqual(DEFAULT_SHELL_LAYOUT);
    expect(lines[0]).toBe(`[layout] ignoring ${WINDOW_LAYOUT_FILE}: unknown schema`);
    expect(lines[1]).toMatch(/^\[layout\] ignoring unreadable /);
  });
});
