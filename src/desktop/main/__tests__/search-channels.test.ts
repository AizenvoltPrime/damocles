import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => ipc.listeners.set(channel, listener),
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => ipc.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipc.handlers.delete(channel),
    removeListener: (channel: string) => ipc.listeners.delete(channel),
  },
  WebContentsView: vi.fn(),
  nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  protocol: {},
}));

import { SHELL_CHANNELS } from '../../preload/shell-channels';
import type { OverlayRequest } from '../../preload/overlay-channels';
import { parseOverlayAnswer } from '../overlay';
import { SHELL_PAGE_URL } from '../protocol';
import { parseEditorEdit, ShellHost, type ShellActions } from '../shell';

const QUERY = { pattern: '-x', isRegex: false, matchCase: true, wholeWord: false, include: 'src/**', exclude: '', useExcludeSettingsAndIgnoreFiles: true, onlyOpenEditors: false };
const CONFIG = { query: 'x', isRegex: false, matchCase: false, wholeWord: false, include: '', exclude: '', useExcludeSettingsAndIgnoreFiles: true, onlyOpenEditors: false, contextLines: 2, showIncludesExcludes: false };

describe('search channels', () => {
  const contents = Object.assign(new EventEmitter(), {
    id: 1,
    mainFrame: { url: SHELL_PAGE_URL, parent: null },
    loadURL: vi.fn(async () => undefined),
    getZoomFactor: () => 1,
    isFocused: () => false,
    isDestroyed: () => false,
    isCrashed: () => false,
    send: vi.fn(),
  });
  const window = { webContents: contents, isDestroyed: () => false } as never;
  const own = { sender: contents, senderFrame: contents.mainFrame };
  const foreign = { sender: { id: 2 }, senderFrame: { url: 'app://damocles/webview/x', parent: null } };
  let search: Record<string, ReturnType<typeof vi.fn>>;
  let searchEditor: Record<string, ReturnType<typeof vi.fn>>;
  const SEARCH_CHANNELS = [
    SHELL_CHANNELS.searchStart,
    SHELL_CHANNELS.searchCancel,
    SHELL_CHANNELS.searchClear,
    SHELL_CHANNELS.searchDismiss,
    SHELL_CHANNELS.searchCopy,
    SHELL_CHANNELS.searchConfirmReplace,
    SHELL_CHANNELS.searchReplace,
    SHELL_CHANNELS.searchPreview,
    SHELL_CHANNELS.searchFindInFolder,
    SHELL_CHANNELS.searchEditorOpenNew,
    SHELL_CHANNELS.searchEditorConfig,
    SHELL_CHANNELS.searchEditorRun,
    SHELL_CHANNELS.searchEditorOpenResult,
  ];

  beforeEach(() => {
    ipc.handlers.clear();
    ipc.listeners.clear();
    search = Object.fromEntries(['start', 'cancel', 'clear', 'dismiss', 'copy', 'confirmReplace', 'replace', 'preview', 'findInFolder'].map((name) => [name, vi.fn(() => ({ ok: true }))]));
    searchEditor = Object.fromEntries(['openNew', 'setConfig', 'run', 'openResult'].map((name) => [name, vi.fn(() => ({ ok: true }))]));
    new ShellHost(window, { search, searchEditor } as unknown as ShellActions, () => undefined, () => undefined);
  });

  const call = (channel: string, payload?: unknown, sender: unknown = own): Promise<unknown> => Promise.resolve(ipc.handlers.get(channel)!(sender, payload));

  it('refuses every search and Search Editor channel from another sender', async () => {
    for (const channel of SEARCH_CHANNELS) await expect(call(channel, {}, foreign)).rejects.toThrow('Rejected');
    expect([...Object.values(search), ...Object.values(searchEditor)].every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it('passes a clean copy of a search start on and bounds its query and id', async () => {
    await call(SHELL_CHANNELS.searchStart, { searchId: 4, query: { ...QUERY, extra: 1 }, immediate: true, more: 2 });
    expect(search['start']).toHaveBeenCalledWith({ searchId: 4, query: QUERY, immediate: true });
    const bad = [
      { searchId: -1, query: QUERY, immediate: true },
      { searchId: 1.5, query: QUERY, immediate: true },
      { searchId: 1, query: { ...QUERY, pattern: '' }, immediate: true },
      { searchId: 1, query: { ...QUERY, pattern: 'x'.repeat(2001) }, immediate: true },
      { searchId: 1, query: { ...QUERY, include: 'x'.repeat(4001) }, immediate: true },
      { searchId: 1, query: { ...QUERY, isRegex: 'yes' }, immediate: true },
      { searchId: 1, query: { ...QUERY, onlyOpenEditors: undefined }, immediate: true },
      { searchId: 1, query: QUERY, immediate: 1 },
    ];
    for (const payload of bad) await expect(call(SHELL_CHANNELS.searchStart, payload)).rejects.toThrow(/Malformed/);
    await expect(call(SHELL_CHANNELS.searchClear, { all: true })).rejects.toThrow(/Malformed/);
    await expect(call(SHELL_CHANNELS.searchCancel, { all: true })).rejects.toThrow(/Malformed/);
    expect(search['start']).toHaveBeenCalledTimes(1);
  });

  it('bounds the replace, its confirmation and its preview, Preserve Case included', async () => {
    await call(SHELL_CHANNELS.searchReplace, { searchId: 1, replacement: '$1', preserveCase: true, matchIds: [0, 3], relativePath: 'x' });
    expect(search['replace']).toHaveBeenCalledWith({ searchId: 1, replacement: '$1', preserveCase: true, matchIds: [0, 3] });
    await call(SHELL_CHANNELS.searchConfirmReplace, { occurrences: 3, files: 2, replacement: 'x' });
    expect(search['confirmReplace']).toHaveBeenCalledWith({ occurrences: 3, files: 2, replacement: 'x' });
    await call(SHELL_CHANNELS.searchPreview, { searchId: 1, replacement: 'y', preserveCase: false, matchIds: [2] });
    expect(search['preview']).toHaveBeenCalledWith({ searchId: 1, replacement: 'y', preserveCase: false, matchIds: [2] });
    const bad: Array<[string, unknown]> = [
      [SHELL_CHANNELS.searchReplace, { searchId: 1, replacement: 'x'.repeat(2001), preserveCase: false, matchIds: [0] }],
      [SHELL_CHANNELS.searchReplace, { searchId: 1, replacement: 'x', preserveCase: false, matchIds: [] }],
      [SHELL_CHANNELS.searchReplace, { searchId: 1, replacement: 'x', preserveCase: false, matchIds: [-1] }],
      [SHELL_CHANNELS.searchReplace, { searchId: 1, replacement: 'x', preserveCase: false, matchIds: [5, 5] }],
      [SHELL_CHANNELS.searchReplace, { searchId: 1, replacement: 'x', preserveCase: false, matchIds: Array.from({ length: 20_001 }, (_, i) => i) }],
      [SHELL_CHANNELS.searchReplace, { searchId: 1, replacement: 'x', matchIds: [0] }],
      [SHELL_CHANNELS.searchConfirmReplace, { occurrences: 0, files: 1, replacement: 'x' }],
      [SHELL_CHANNELS.searchConfirmReplace, { occurrences: 1, files: 100_001, replacement: 'x' }],
      [SHELL_CHANNELS.searchPreview, { searchId: 1, replacement: 'y', preserveCase: 'no', matchIds: [0] }],
      [SHELL_CHANNELS.searchPreview, { searchId: 1, replacement: 'y', preserveCase: false }],
    ];
    for (const [channel, payload] of bad) await expect(call(channel, payload)).rejects.toThrow(/Malformed/);
  });

  it('bounds a dismissal and a copy, and takes an untitled buffer only by its document id', async () => {
    await call(SHELL_CHANNELS.searchDismiss, { searchId: 1, matchIds: [1], files: [{ kind: 'file', relativePath: 'src/a.ts', extra: 1 }, { kind: 'untitled', documentId: 'd1' }] });
    expect(search['dismiss']).toHaveBeenCalledWith({ searchId: 1, matchIds: [1], files: [{ kind: 'file', relativePath: 'src/a.ts' }, { kind: 'untitled', documentId: 'd1' }] });
    await call(SHELL_CHANNELS.searchCopy, { searchId: 1, target: { kind: 'all' } });
    await call(SHELL_CHANNELS.searchCopy, { searchId: 1, target: { kind: 'matches', matchIds: [3] } });
    expect(search['copy']).toHaveBeenLastCalledWith({ searchId: 1, target: { kind: 'matches', matchIds: [3] } });
    const bad: Array<[string, unknown]> = [
      [SHELL_CHANNELS.searchDismiss, { searchId: 1, matchIds: [], files: [] }],
      [SHELL_CHANNELS.searchDismiss, { searchId: 1, matchIds: [], files: [{ kind: 'file', relativePath: '../x' }] }],
      [SHELL_CHANNELS.searchDismiss, { searchId: 1, matchIds: [], files: [{ kind: 'untitled', relativePath: 'Untitled-1' }] }],
      [SHELL_CHANNELS.searchDismiss, { searchId: 1, matchIds: [1, 1], files: [] }],
      [SHELL_CHANNELS.searchCopy, { searchId: 1, target: { kind: 'files', files: [] } }],
      [SHELL_CHANNELS.searchCopy, { searchId: 1, target: { kind: 'paths', paths: ['/etc'] } }],
      [SHELL_CHANNELS.searchFindInFolder, { projectKey: 'p', relativePath: '../outside' }],
      [SHELL_CHANNELS.searchFindInFolder, { projectKey: 'p', relativePath: 'C:/x' }],
    ];
    for (const [channel, payload] of bad) await expect(call(channel, payload)).rejects.toThrow(/Malformed/);
    await call(SHELL_CHANNELS.searchFindInFolder, { projectKey: 'p', relativePath: 'src' });
    expect(search['findInFolder']).toHaveBeenCalledWith({ projectKey: 'p', relativePath: 'src' });
  });

  it('bounds every Search Editor request, context lines included, and never takes a path for a result', async () => {
    await call(SHELL_CHANNELS.searchEditorOpenNew, { from: 'blank', config: { include: './src', showIncludesExcludes: true } });
    expect(searchEditor['openNew']).toHaveBeenCalledWith({ from: 'blank', config: { include: './src', showIncludesExcludes: true } });
    await call(SHELL_CHANNELS.searchEditorOpenNew, { from: 'viewResults', searchId: 3 });
    await call(SHELL_CHANNELS.searchEditorConfig, { documentId: 'd', config: { ...CONFIG, extra: 1 } });
    expect(searchEditor['setConfig']).toHaveBeenCalledWith('d', CONFIG);
    await call(SHELL_CHANNELS.searchEditorRun, { documentId: 'd' });
    expect(searchEditor['run']).toHaveBeenCalledWith('d');
    await call(SHELL_CHANNELS.searchEditorOpenResult, { documentId: 'd', line: 4, column: 7, toSide: false, relativePath: '/etc/passwd' });
    expect(searchEditor['openResult']).toHaveBeenCalledWith({ documentId: 'd', line: 4, column: 7, toSide: false });
    const bad: Array<[string, unknown]> = [
      [SHELL_CHANNELS.searchEditorOpenNew, { from: 'blank', config: { contextLines: 101 } }],
      [SHELL_CHANNELS.searchEditorOpenNew, { from: 'blank', config: { contextLines: -1 } }],
      [SHELL_CHANNELS.searchEditorOpenNew, { from: 'blank', config: { path: '/etc' } }],
      [SHELL_CHANNELS.searchEditorOpenNew, { from: 'file', path: 'x' }],
      [SHELL_CHANNELS.searchEditorConfig, { documentId: 'd', config: { ...CONFIG, contextLines: 1.5 } }],
      [SHELL_CHANNELS.searchEditorConfig, { documentId: 'd', config: { ...CONFIG, contextLines: Number.POSITIVE_INFINITY } }],
      [SHELL_CHANNELS.searchEditorConfig, { documentId: 'd', config: { ...CONFIG, query: 'x'.repeat(2001) } }],
      [SHELL_CHANNELS.searchEditorConfig, { documentId: 'd', config: { ...CONFIG, onlyOpenEditors: undefined } }],
      [SHELL_CHANNELS.searchEditorRun, { documentId: '' }],
      [SHELL_CHANNELS.searchEditorOpenResult, { documentId: 'd', line: 0, column: 1, toSide: false }],
      [SHELL_CHANNELS.searchEditorOpenResult, { documentId: 'd', line: 1, column: 1 }],
    ];
    for (const [channel, payload] of bad) await expect(call(channel, payload)).rejects.toThrow(/Malformed/);
  });
});

describe('editor edit reports', () => {
  it('takes the edit counter and the typed-over-reload flag, and refuses a report without them', () => {
    expect(parseEditorEdit({ documentId: 'd', version: 2, seq: 7, text: 'x', overReload: true, extra: 1 })).toEqual({ documentId: 'd', version: 2, seq: 7, text: 'x', overReload: true });
    expect(parseEditorEdit({ documentId: 'd', version: 2, text: 'x' })).toBeUndefined();
    expect(parseEditorEdit({ documentId: 'd', version: 2, seq: -1, text: 'x', overReload: false })).toBeUndefined();
    expect(parseEditorEdit({ documentId: 'd', version: 2, seq: 1, text: 'x', overReload: 'yes' })).toBeUndefined();
  });
});

describe('palette answers', () => {
  const quickOpen: OverlayRequest = { kind: 'quickOpen', mode: 'commands' };

  it('takes a command id as a clean copy, and refuses one with a pick beside it or out of bounds', () => {
    expect(parseOverlayAnswer({ kind: 'quickOpen', command: 'damocles.editor.save', extra: 1 }, quickOpen)).toEqual({ kind: 'quickOpen', command: 'damocles.editor.save' });
    expect(parseOverlayAnswer({ kind: 'quickOpen', command: '' }, quickOpen)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'quickOpen', command: 'x'.repeat(5001) }, quickOpen)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'quickOpen', command: 'a', pick: null }, quickOpen)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'quickOpen', command: 'a' }, { kind: 'notifications', anchor: { x: 0, y: 0, width: 1, height: 1 } })).toBeUndefined();
  });
});
