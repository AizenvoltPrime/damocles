import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRgPath } from '../../../core/chat-panel/ripgrep';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import type { SearchCommandMessage, SearchDone, SearchEditorHighlights, SearchFocus, SearchResultsBatch } from '../../preload/shell-channels';
import type { Project } from '../documents/confine';
import { DocumentService, type TextDocument } from '../documents/document-service';
import { EditorPane } from '../editor-pane';
import { SEARCH_MODE_SETTING, SEARCH_EDITOR_CONTEXT_LINES_SETTING } from '../desktop-configuration';
import { SearchHost, searchBuffers } from '../search/search-host';

let root: string;
let projectDir: string;
let project: Project;
let other: Project;
let platform: FakePlatform;
let documents: DocumentService;
let pane: EditorPane;
let host: SearchHost;
let reveals: string[];
let highlights: SearchEditorHighlights[];
let batches: SearchResultsBatch[];
let dones: SearchDone[];
let focuses: SearchFocus[];
let commands: SearchCommandMessage[];
let copied: string[];

function write(relativePath: string, text: string, base = projectDir): string {
  const file = path.join(base, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-search-host-')));
  projectDir = path.join(root, 'proj');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(path.join(root, 'other'));
  project = { key: folderKey(projectDir), fsPath: projectDir, name: 'proj' };
  other = { key: folderKey(path.join(root, 'other')), fsPath: path.join(root, 'other'), name: 'other' };
  platform = createFakePlatform();
  reveals = [];
  highlights = [];
  batches = [];
  dones = [];
  focuses = [];
  commands = [];
  copied = [];
  const t = (message: string, ...args: Array<string | number>): string => message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)]));
  documents = new DocumentService({
    projects: () => [project, other],
    watchers: platform.fileWatchers,
    ask: async () => undefined,
    t,
    log: () => undefined,
    pickSavePath: async () => undefined,
    backups: { changed: () => undefined, writeNow: async () => undefined, remove: () => undefined },
    settings: { locate: () => path.join(root, 'settings.json'), save: async () => ({ ok: false, error: 'unused', conflict: false }) },
  });
  pane = new EditorPane({
    documents,
    settings: platform.settings,
    ask: async () => undefined,
    t,
    log: () => undefined,
    restoreLayout: () => true,
    persist: () => undefined,
    flushBackups: async () => undefined,
    logsDir: path.join(root, 'logs'),
    sendState: () => undefined,
    sendDocument: () => undefined,
    sendCommand: () => undefined,
    sendFlush: () => false,
    focusTab: () => undefined,
    revealLine: (tabId, line, range) => reveals.push(`${tabId}:${line}:${range ? range.startColumn : '-'}`),
    showPane: () => undefined,
    showPaneBeside: () => reveals.push('beside'),
    projects: () => [project, other],
    copy: async () => undefined,
    reveal: async () => undefined,
    mention: async () => undefined,
    browser: () => undefined,
    warn: () => undefined,
    searchEditorClosed: (documentId) => host.searchEditorClosed(documentId),
  });
  host = new SearchHost({
    settings: platform.settings,
    documents,
    editorPane: pane,
    projects: () => [project, other],
    selectedFolder: () => ({ projectKey: project.key, fsPath: projectDir }),
    rgPath: () => resolveRgPath({ resourceRoot: process.cwd(), unpackedRoot: process.cwd() }),
    ignoreArgs: () => [],
    excludeSettings: () => [],
    ask: async () => 0,
    t,
    warn: () => undefined,
    copy: async (text) => { copied.push(text); },
    selectedText: () => undefined,
    showSidebar: () => undefined,
    clearSearchHistory: () => undefined,
    sendResults: (batch) => batches.push(batch),
    sendFileUpdate: () => undefined,
    sendDone: (done) => dones.push(done),
    sendHighlights: (pushed) => highlights.push(pushed),
    sendCommand: (message) => commands.push(message),
    focusSearch: (focus) => focuses.push(focus),
    stateChanged: () => undefined,
    log: () => undefined,
    lineDelimiter: '\n',
  });
});

afterEach(() => {
  host.dispose();
  pane.dispose();
  documents.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}

describe('the open documents Search reads', () => {
  it('reads the project\'s text files and untitled tabs, never a diff side, an outside file, a settings file, another project\'s file or a Search Editor', async () => {
    write('src/a.ts', 'needle');
    write('b.ts', 'needle', other.fsPath);
    write('outside.ts', 'needle', root);
    fs.writeFileSync(path.join(root, 'settings.json'), '{"needle": 1}');
    const own = await documents.openProjectFile(project.key, 'src/a.ts');
    await documents.openProjectFile(other.key, 'b.ts');
    await documents.openPath(path.join(root, 'outside.ts'));
    await documents.openSettingsFile('user');
    documents.openMemory('a.ts', 'needle', { untitled: false });
    const untitled = documents.openMemory('Untitled-1', 'needle', { untitled: true });
    documents.openSearchEditor(project.key, { query: 'needle', isRegex: false, matchCase: false, wholeWord: false, include: '', exclude: '', useExcludeSettingsAndIgnoreFiles: true, onlyOpenEditors: false, contextLines: 0, showIncludesExcludes: false }, 'needle', { dirty: false });
    const buffers = searchBuffers(documents, project.key);
    expect(buffers.map((buffer) => buffer.documentId).sort()).toEqual([own.ok ? own.document.id : '', untitled.id].sort());
    expect(buffers.find((buffer) => buffer.documentId === untitled.id)?.target).toEqual({ kind: 'untitled', title: 'Untitled-1' });
  });

  it('searches only those buffers for Search only in Open Editors', async () => {
    write('src/a.ts', 'needle');
    write('closed.ts', 'needle');
    await documents.openProjectFile(project.key, 'src/a.ts');
    host.start({ searchId: 1, query: { pattern: 'needle', isRegex: false, matchCase: false, wholeWord: false, include: '', exclude: '', useExcludeSettingsAndIgnoreFiles: true, onlyOpenEditors: true }, immediate: true });
    await until(() => dones.length === 1);
    expect(batches.flatMap((batch) => batch.files).map((file) => (file.kind === 'file' ? file.relativePath : file.title))).toEqual(['src/a.ts']);
  });
});

describe('the Search Editor', () => {
  it('runs with context lines in the editor\'s project, writes VS Code\'s body and pushes its highlights', async () => {
    write('src/a.ts', 'one\ntwo needle\nthree\n');
    await platform.settings.update(SEARCH_EDITOR_CONTEXT_LINES_SETTING, 1, 'user');
    const { tabId } = await host.openNew({ from: 'blank', config: { query: 'needle' } });
    await until(() => highlights.length === 1);
    const document = pane.searchEditorDocuments()[0]!;
    expect(pane.searchEditorTab(document.id)).toBe(tabId);
    expect(document.text).toBe(`1 result - 1 file\n\nsrc${path.sep}a.ts:\n  1  one\n  2: two needle\n  3  three\n`);
    expect(highlights[0]).toEqual({ documentId: document.id, version: document.version, ranges: [{ startLine: 5, startColumn: 10, endLine: 5, endColumn: 16 }] });
    expect(document.searchEditor).toMatchObject({ dirty: false, running: false, config: { query: 'needle', contextLines: 1 } });
  });

  it('opens a result through the project only, at the column under the cursor, and refuses a label outside it', async () => {
    write('src/a.ts', 'two needle\n');
    const secret = write('secret.ts', 'x', root);
    const document = documents.openSearchEditor(project.key, { query: 'x', isRegex: false, matchCase: false, wholeWord: false, include: '', exclude: '', useExcludeSettingsAndIgnoreFiles: true, onlyOpenEditors: false, contextLines: 0, showIncludesExcludes: false },
      `src/a.ts:\n  1: two needle\n${secret}:\n  1: x\n../secret.ts:\n  1: x\nlinked/secret.ts:\n  1: x\n`, { dirty: false });
    pane.showSearchEditor(document, { focus: true });
    fs.symlinkSync(root, path.join(projectDir, 'linked'), 'junction');
    const opened = await host.openResult({ documentId: document.id, line: 2, column: 10, toSide: true });
    expect(opened).toMatchObject({ ok: true });
    expect(reveals).toEqual(['beside', `${(opened as { tabId: string }).tabId}:1:5`]);
    expect(await host.openResult({ documentId: document.id, line: 4, column: 6, toSide: false })).toEqual({ ok: false, reason: 'notResult' });
    expect(await host.openResult({ documentId: document.id, line: 6, column: 6, toSide: false })).toEqual({ ok: false, reason: 'notResult' });
    expect(await host.openResult({ documentId: document.id, line: 8, column: 6, toSide: false })).toEqual({ ok: false, reason: 'outside' });
    if (process.platform === 'win32') {
      const stream = documents.openSearchEditor(project.key, { query: 'x', isRegex: false, matchCase: false, wholeWord: false, include: '', exclude: '', useExcludeSettingsAndIgnoreFiles: true, onlyOpenEditors: false, contextLines: 0, showIncludesExcludes: false },
        'src/a.ts:stream:\n  1: x\n', { dirty: false });
      pane.showSearchEditor(stream, { focus: false });
      expect(await host.openResult({ documentId: stream.id, line: 2, column: 6, toSide: false })).toEqual({ ok: false, reason: 'outside' });
    }
    const plain = await documents.openProjectFile(project.key, 'src/a.ts');
    await expect(host.openResult({ documentId: plain.ok ? plain.document.id : '', line: 1, column: 1, toSide: false })).rejects.toThrow('Unknown Search Editor');
  });

  it('saves as VS Code\'s .code-search file and reopens it as a Search Editor with its header', async () => {
    const config = { query: 'a\\b', isRegex: true, matchCase: true, wholeWord: false, include: 'src', exclude: '', useExcludeSettingsAndIgnoreFiles: true, onlyOpenEditors: false, contextLines: 2, showIncludesExcludes: true };
    const saved = write('q.code-search', '');
    const opened = await documents.openProjectFile(project.key, 'q.code-search');
    const document = opened.ok ? (opened.document as TextDocument) : undefined;
    expect(document?.searchEditor).toBeDefined();
    documents.setSearchEditorConfig(document!.id, config);
    expect(document!.searchEditor!.dirty).toBe(true);
    expect(await documents.save(document!.id, document!.version, 'body line\n')).toEqual({ ok: true });
    expect(fs.readFileSync(saved, 'utf8')).toBe('# Query: a\\\\b\n# Flags: CaseSensitive RegExp\n# Including: src\n# ContextLines: 2\n\nbody line\n');
    expect(document!.searchEditor!.dirty).toBe(false);
    documents.release(document!.id, true);
    const again = await documents.openProjectFile(project.key, 'q.code-search');
    expect(again.ok && again.document.kind === 'text' ? again.document.searchEditor?.config : undefined).toEqual(config);
    expect(again.ok && again.document.kind === 'text' ? again.document.text : undefined).toBe('body line\n');
  });

  it('routes Find in Folder to the view as an anchored include, or to a Search Editor by search.mode', async () => {
    await host.findInFolder({ projectKey: project.key, relativePath: 'src/a,b' });
    expect(focuses).toEqual([{ replace: false, include: './src/a[,]b' }]);
    await platform.settings.update(SEARCH_MODE_SETTING, 'newEditor', 'user');
    await host.findInFolder({ projectKey: project.key, relativePath: 'src' });
    expect(pane.searchEditorDocuments()[0]?.searchEditor?.config).toMatchObject({ include: './src', showIncludesExcludes: true });
    await expect(host.findInFolder({ projectKey: 'nope', relativePath: 'src' })).rejects.toThrow('Unknown project');
  });

  it('opens the view\'s results in a Search Editor with no context when the default is 0', async () => {
    write('src/a.ts', 'needle\n');
    await platform.settings.update(SEARCH_EDITOR_CONTEXT_LINES_SETTING, 0, 'user');
    host.start({ searchId: 1, query: { pattern: 'needle', isRegex: false, matchCase: false, wholeWord: false, include: '', exclude: '', useExcludeSettingsAndIgnoreFiles: true, onlyOpenEditors: false }, immediate: true });
    await until(() => dones.length === 1);
    await host.openNew({ from: 'viewResults', searchId: 1 });
    const document = pane.searchEditorDocuments()[0]!;
    expect(document.text).toBe(`1 result - 1 file\n\nsrc${path.sep}a.ts:\n  1: needle\n`);
    expect(document.searchEditor?.config).toMatchObject({ query: 'needle', contextLines: 0 });
    await host.copy({ searchId: 1, target: { kind: 'all' } });
    expect(copied).toEqual([`${path.join(projectDir, 'src', 'a.ts')}\n  1,1: needle`]);
  });
});

describe('the replace preview', () => {
  it('builds the replaced text of a file with thousands of matches in linear time', async () => {
    const count = 8000;
    const line = (word: string): string => `${'x'.repeat(240)} ${word}\n`;
    write('big.txt', line('needle').repeat(count));
    const previews: string[] = [];
    vi.spyOn(pane, 'openReplacePreview').mockImplementation((_file, _original, modified) => { previews.push(modified); });
    host.start({ searchId: 1, query: { pattern: 'needle', isRegex: false, matchCase: false, wholeWord: false, include: '', exclude: '', useExcludeSettingsAndIgnoreFiles: true, onlyOpenEditors: false }, immediate: true });
    await until(() => dones.length === 1);
    const matchIds = batches.flatMap((batch) => batch.files.flatMap((file) => file.matches.map((found) => found.id)));
    expect(matchIds).toHaveLength(count);
    const started = performance.now();
    expect(await host.preview({ searchId: 1, replacement: 'pin', preserveCase: false, matchIds })).toEqual({ ok: true });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(previews).toEqual([line('pin').repeat(count)]);
  });
});

describe('a Search Editor run', () => {
  const editorDocument = (): TextDocument => documents.get(pane.searchEditorDocuments()[0]!.id) as TextDocument;

  it('keeps its results when Query Details toggles during it, and stops running when an edit to the query drops it', async () => {
    write('src/a.ts', 'needle\n');
    await platform.settings.update(SEARCH_EDITOR_CONTEXT_LINES_SETTING, 0, 'user');
    await host.openNew({ from: 'blank', config: { query: 'needle' } });
    const id = editorDocument().id;
    host.setConfig(id, { ...editorDocument().searchEditor!.config, showIncludesExcludes: true });
    await until(() => highlights.length === 1);
    expect(editorDocument().text).toBe(`1 result - 1 file\n\nsrc${path.sep}a.ts:\n  1: needle\n`);
    host.run(id);
    expect(editorDocument().searchEditor!.running).toBe(true);
    host.setConfig(id, { ...editorDocument().searchEditor!.config, query: 'other' });
    await until(() => editorDocument().searchEditor!.running === false);
    expect(highlights).toHaveLength(1);
  });

  it('stops its ripgrep when its tab closes', async () => {
    write('src/a.ts', 'needle\n');
    const discarded = vi.spyOn(host.service, 'discardEditor');
    const { tabId } = await host.openNew({ from: 'blank', config: { query: 'needle' } });
    const id = editorDocument().id;
    await pane.tabAction('close', tabId);
    expect(discarded).toHaveBeenCalledWith(id);
  });
});
