import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { ShellDocumentContent, ShellEditorState, ShellEditorTab } from '../../preload/shell-channels';
import { AUTO_SAVE_DELAY_MS, createEditorStore, type ShellMonacoModule } from '../editor/editor-store';
import { EDITOR_STATE, fakeShellApi } from './fakes';

// A Monaco model double: the store only reads and replaces whole text, sets the EOL and listens for changes.
class FakeModel {
  text: string;
  eol = 'LF';
  disposed = false;
  readonly listeners: Array<() => void> = [];
  options = { tabSize: 4, indentSize: 4, insertSpaces: true };
  language: string;
  readonly uri: FakeUri;
  constructor(text: string, language: string, uri: FakeUri) {
    this.text = text;
    this.language = language;
    this.uri = uri;
  }
  getValue(): string { return this.eol === 'CRLF' ? this.text.replace(/\r?\n/g, '\r\n') : this.text; }
  setEOL(eol: number): void { this.eol = eol === 1 ? 'CRLF' : 'LF'; }
  getEndOfLineSequence(): number { return this.eol === 'CRLF' ? 1 : 0; }
  getLanguageId(): string { return this.language; }
  getOptions(): { tabSize: number; indentSize: number; insertSpaces: boolean } { return this.options; }
  onDidChangeContent(listener: () => void): { dispose(): void } {
    this.listeners.push(listener);
    return { dispose: () => {} };
  }
  updateOptions(options: Partial<FakeModel['options']>): void { this.options = { ...this.options, ...options }; }
  detectIndentation(): void {}
  getFullModelRange(): { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } {
    const lines = this.text.split('\n');
    return { startLineNumber: 1, startColumn: 1, endLineNumber: lines.length, endColumn: (lines[lines.length - 1]?.length ?? 0) + 1 };
  }
  // The store either replaces the whole text (a range from 1:1) or appends at the end.
  pushEditOperations(_selections: unknown, [edit]: Array<{ range: { startLineNumber: number; startColumn: number }; text: string }>): void {
    const replace = edit!.range.startLineNumber === 1 && edit!.range.startColumn === 1;
    this.text = replace ? edit!.text : this.text + edit!.text;
    for (const listener of this.listeners) listener();
  }
  /** A keystroke: the user's edit, which the store reports. */
  type(text: string): void {
    this.text = text;
    for (const listener of this.listeners) listener();
  }
  dispose(): void { this.disposed = true; }
  isDisposed(): boolean { return this.disposed; }
}

interface FakeUri { readonly path: string; toString(): string }
const models: FakeModel[] = [];
const monacoModule = {
  useMonaco: () => ({
    Uri: {
      from: (parts: { scheme: string; authority?: string; path: string }): FakeUri => ({ path: parts.path, toString: () => `${parts.scheme}://${parts.authority ?? ''}${parts.path}` }),
      file: (fsPath: string): FakeUri => ({ path: `/${fsPath.replace(/\\/g, '/')}`, toString: () => `file:///${fsPath}` }),
      parse: (value: string): FakeUri => ({ path: value, toString: () => value }),
    },
    editor: {
      EndOfLineSequence: { LF: 0, CRLF: 1 },
      createModel: (text: string, language: string, uri: FakeUri) => {
        // As Monaco's ModelService: one live model per URI.
        if (models.some((other) => !other.disposed && other.uri.toString() === uri.toString())) throw new Error('ModelService: Cannot add model because it already exists!');
        const model = new FakeModel(text, language, uri);
        models.push(model);
        return model;
      },
      setModelLanguage: (model: FakeModel, language: string) => { model.language = language; },
    },
  }),
  settingsModelUri: (scope: string, documentId: string) => `inmemory://damocles/settings/${scope}/${documentId}.json`,
} as unknown as ShellMonacoModule;

const tab = (overrides: Partial<ShellEditorTab> & { id: string }): ShellEditorTab => ({
  kind: 'code', title: 'a.ts', displayPath: 'a.ts', dirty: false, readOnly: false, conflict: false, documentId: `doc-${overrides.id}`, ...overrides,
});
const text = (documentId: string, value: string, version = 1, eol: '\n' | '\r\n' = '\n', editSeq = 0): ShellDocumentContent =>
  ({ kind: 'text', documentId, version, editSeq, text: value, languageId: 'typescript', eol, encoding: 'utf8', bom: false });
// Every document a tab shows is named after the tab unless documents says otherwise.
const state = (
  tabs: ShellEditorTab[],
  activeTabId: string | null = tabs[0]?.id ?? null,
  settings: Partial<ShellEditorState['settings']> = {},
  documents: ShellEditorState['documents'] = {},
): ShellEditorState => ({
  ...EDITOR_STATE,
  tabs,
  activeTabId,
  settings: { ...EDITOR_STATE.settings, ...settings },
  documents: {
    ...Object.fromEntries(tabs.flatMap((each) => (each.documentId === undefined ? [] : [[each.documentId, { name: each.title, languageId: 'typescript' }]]))),
    ...documents,
  },
});

async function setup(initial: ShellEditorState, documents: Record<string, ShellDocumentContent>) {
  const api = fakeShellApi([], {
    getEditorState: vi.fn(async () => initial),
    getDocument: vi.fn(async (documentId: string) => documents[documentId]!),
  });
  const store = createEditorStore(api, async () => monacoModule);
  await store.start();
  return { api, store };
}

beforeEach(() => {
  models.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('editor store', () => {
  it('reports the first keystroke at once and later ones at most once per throttle window, with the version main gave', async () => {
    const { api, store } = await setup(state([tab({ id: 't1' })]), { 'doc-t1': text('doc-t1', 'a', 7) });
    const model = (await store.model('doc-t1')) as unknown as FakeModel;
    model.type('ab');
    expect(api.reportEdit).toHaveBeenLastCalledWith({ documentId: 'doc-t1', version: 7, seq: 1, text: 'ab', overReload: false });
    model.type('abc');
    model.type('abcd');
    expect(api.reportEdit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(250);
    expect(api.reportEdit).toHaveBeenCalledTimes(2);
    expect(api.reportEdit).toHaveBeenLastCalledWith({ documentId: 'doc-t1', version: 7, seq: 2, text: 'abcd', overReload: false });
  });

  it('flushes the unsent edit before a save and saves the buffer with its EOL, untitled through Save As', async () => {
    const { api, store } = await setup(state([tab({ id: 't1' }), tab({ id: 't2', kind: 'untitled' })]), {
      'doc-t1': text('doc-t1', 'one\ntwo', 3, '\r\n'),
      'doc-t2': text('doc-t2', '', 1),
    });
    const model = (await store.model('doc-t1')) as unknown as FakeModel;
    model.type('one\ntwo\n');
    model.type('one\ntwo\nthree');
    await store.save(store.tabs.value[0]!);
    const order = [vi.mocked(api.reportEdit).mock.invocationCallOrder.at(-1)!, vi.mocked(api.saveDocument).mock.invocationCallOrder[0]!];
    expect(order[0]).toBeLessThan(order[1]!);
    expect(api.saveDocument).toHaveBeenCalledWith({ documentId: 'doc-t1', version: 3, text: 'one\r\ntwo\r\nthree' });

    await store.model('doc-t2');
    await store.save(store.tabs.value[1]!);
    expect(api.saveDocumentAs).toHaveBeenCalledWith({ documentId: 'doc-t2', version: 1, text: '' });
  });

  it('answers a flush request after sending every pending edit', async () => {
    const { api, store } = await setup(state([tab({ id: 't1' })]), { 'doc-t1': text('doc-t1', 'a') });
    const model = (await store.model('doc-t1')) as unknown as FakeModel;
    model.type('ab');
    model.type('abc');
    api.editorFlush({ requestId: 'req-1', format: [] });
    expect(api.reportEdit).toHaveBeenLastCalledWith({ documentId: 'doc-t1', version: 1, seq: 2, text: 'abc', overReload: false });
    expect(vi.mocked(api.reportEdit).mock.invocationCallOrder.at(-1)!).toBeLessThan(vi.mocked(api.editorFlushed).mock.invocationCallOrder[0]!);
    expect(api.editorFlushed).toHaveBeenCalledWith('req-1');
  });

  it('applies main\'s reload of a clean buffer as an edit it does not report back, and takes the new version', async () => {
    const { api, store } = await setup(state([tab({ id: 't1' })]), { 'doc-t1': text('doc-t1', 'old') });
    const model = (await store.model('doc-t1')) as unknown as FakeModel;
    api.documentChanged({ documentId: 'doc-t1', content: text('doc-t1', 'new from disk', 2) });
    expect(model.text).toBe('new from disk');
    expect(api.reportEdit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    model.type('new from disk!');
    expect(api.reportEdit).toHaveBeenLastCalledWith({ documentId: 'doc-t1', version: 2, seq: 1, text: 'new from disk!', overReload: false });
  });

  it('keeps a keystroke that was on its way to main when main reloaded the clean buffer, and reports it as typed over the reload', async () => {
    const { api, store } = await setup(state([tab({ id: 't1' })]), { 'doc-t1': text('doc-t1', 'a') });
    const model = (await store.model('doc-t1')) as unknown as FakeModel;
    model.type('ab');
    expect(api.reportEdit).toHaveBeenLastCalledWith({ documentId: 'doc-t1', version: 1, seq: 1, text: 'ab', overReload: false });
    // main reloaded before that edit arrived: its content covers no edit of the shell's
    api.documentChanged({ documentId: 'doc-t1', content: text('doc-t1', 'disk', 2) });
    expect(model.text).toBe('ab');
    expect(api.reportEdit).toHaveBeenLastCalledWith({ documentId: 'doc-t1', version: 2, seq: 2, text: 'ab', overReload: true });
  });

  it('keeps unsent keystrokes over a reload and reports them as typed over it', async () => {
    const { api, store } = await setup(state([tab({ id: 't1' })]), { 'doc-t1': text('doc-t1', 'a') });
    const model = (await store.model('doc-t1')) as unknown as FakeModel;
    model.type('ab');
    model.type('abc');
    api.documentChanged({ documentId: 'doc-t1', content: text('doc-t1', 'disk', 5, '\n', 1) });
    expect(model.text).toBe('abc');
    expect(api.reportEdit).toHaveBeenLastCalledWith({ documentId: 'doc-t1', version: 5, seq: 2, text: 'abc', overReload: true });
  });

  it('applies a reload main made after it had every keystroke', async () => {
    const { api, store } = await setup(state([tab({ id: 't1' })]), { 'doc-t1': text('doc-t1', 'a', 1, '\n', 4) });
    const model = (await store.model('doc-t1')) as unknown as FakeModel;
    model.type('ab');
    expect(api.reportEdit).toHaveBeenLastCalledWith({ documentId: 'doc-t1', version: 1, seq: 5, text: 'ab', overReload: false });
    model.type('a');
    vi.advanceTimersByTime(250);
    api.documentChanged({ documentId: 'doc-t1', content: text('doc-t1', 'disk', 2, '\n', 6) });
    expect(model.text).toBe('disk');
    expect(api.reportEdit).toHaveBeenCalledTimes(2);
  });

  it('auto saves one second after the last edit when the setting says after delay', async () => {
    const dirty = tab({ id: 't1', dirty: true });
    const { api, store } = await setup(state([dirty], 't1', { autoSave: 'afterDelay' }), { 'doc-t1': text('doc-t1', 'a') });
    const model = (await store.model('doc-t1')) as unknown as FakeModel;
    model.type('ab');
    vi.advanceTimersByTime(AUTO_SAVE_DELAY_MS - 1);
    expect(api.saveDocument).not.toHaveBeenCalled();
    model.type('abc');
    vi.advanceTimersByTime(AUTO_SAVE_DELAY_MS);
    expect(api.saveDocument).toHaveBeenCalledWith({ documentId: 'doc-t1', version: 1, text: 'abc' });
  });

  it('disposes a model once no tab shows its document', async () => {
    const { api, store } = await setup(state([tab({ id: 't1' }), tab({ id: 't2' })]), { 'doc-t1': text('doc-t1', 'a'), 'doc-t2': text('doc-t2', 'b') });
    const first = (await store.model('doc-t1')) as unknown as FakeModel;
    const second = (await store.model('doc-t2')) as unknown as FakeModel;
    api.pushEditorState(state([tab({ id: 't2' })]));
    await nextTick();
    expect(first.disposed).toBe(true);
    expect(second.disposed).toBe(false);
  });

  it('runs the menu commands on the active tab: next and previous wrap, and focus the tab they activate', async () => {
    const tabs = [tab({ id: 't1' }), tab({ id: 't2' }), tab({ id: 't3' })];
    const { api, store } = await setup(state(tabs, 't1'), {});
    api.editorCommand('previous');
    await vi.runAllTimersAsync();
    expect(api.editorTab).toHaveBeenLastCalledWith({ action: 'activate', tabId: 't3' });
    expect(store.focusRequest.value?.tabId).toBe('t3');
    api.editorCommand('close');
    await vi.runAllTimersAsync();
    expect(api.editorTab).toHaveBeenLastCalledWith({ action: 'close', tabId: 't1' });
  });

  it('marks an agent open for no focus: only main\'s focus event requests it', async () => {
    const { api, store } = await setup(state([tab({ id: 't1' })]), {});
    api.pushEditorState(state([tab({ id: 't1' }), tab({ id: 't2' })], 't2'));
    expect(store.focusRequest.value).toBeNull();
    api.editorFocus('t2');
    expect(store.focusRequest.value?.tabId).toBe('t2');
    api.editorReveal({ tabId: 't2', line: 40 });
    expect(store.revealRequest.value).toMatchObject({ tabId: 't2', line: 40 });
  });

  it('moves a renamed document\'s model to its new URI with the unsaved text, EOL, language and indentation, swaps it in its editors and disposes the old one', async () => {
    const first = tab({ id: 't1', title: 'a.js' });
    const before = { 'doc-t1': { name: 'a.js', path: 'C:\\p\\src\\a.js', languageId: 'javascript' } };
    const { api, store } = await setup(state([first], 't1', {}, before), { 'doc-t1': text('doc-t1', 'let a = 1;', 1, '\r\n') });
    const model = (await store.model('doc-t1')) as unknown as FakeModel;
    expect(model.uri.toString()).toBe('damocles-document://doc-t1/C:/p/src/a.js');
    model.options = { tabSize: 2, indentSize: 2, insertSpaces: false };
    model.type('let a: number = 1;');
    const swaps: Array<[string, unknown, unknown]> = [];
    store.onDidReplaceModel((documentId, previous, next) => swaps.push([documentId, previous, next]));

    const after = { 'doc-t1': { name: 'a.ts', path: 'C:\\p\\lib\\a.ts', languageId: 'typescript' } };
    api.pushEditorState(state([{ ...first, title: 'a.ts' }], 't1', {}, after));
    const moved = (await store.model('doc-t1')) as unknown as FakeModel;
    expect(moved).not.toBe(model);
    expect(moved.uri.toString()).toBe('damocles-document://doc-t1/C:/p/lib/a.ts');
    expect([moved.getValue(), moved.eol, moved.language, moved.options]).toEqual(['let a: number = 1;', 'CRLF', 'typescript', { tabSize: 2, indentSize: 2, insertSpaces: false }]);
    expect(swaps).toEqual([['doc-t1', model, moved]]);
    expect(model.disposed).toBe(true);
    expect(models.filter((candidate) => !candidate.disposed)).toEqual([moved]);

    vi.advanceTimersByTime(1000);
    moved.type('let a: number = 2;');
    expect(api.reportEdit).toHaveBeenLastCalledWith(expect.objectContaining({ documentId: 'doc-t1', text: 'let a: number = 2;' }));
    api.pushEditorState(state([{ ...first, title: 'a.ts' }], 't1', {}, after));
    expect(await store.model('doc-t1')).toBe(moved);
  });

  it('keeps the model of a document with no file while its name changes, and moves it once a Save As gives it a path', async () => {
    const untitled = tab({ id: 't1', kind: 'searchEditor', title: 'Search: a' });
    const { api, store } = await setup(state([untitled], 't1', {}, { 'doc-t1': { name: 'a.code-search', languageId: 'search-result' } }), { 'doc-t1': text('doc-t1', 'body') });
    const model = (await store.model('doc-t1')) as unknown as FakeModel;
    api.pushEditorState(state([untitled], 't1', {}, { 'doc-t1': { name: 'ab.code-search', languageId: 'search-result' } }));
    expect(await store.model('doc-t1')).toBe(model);
    api.pushEditorState(state([untitled], 't1', {}, { 'doc-t1': { name: 'ab.code-search', path: 'C:\\p\\ab.code-search', languageId: 'search-result' } }));
    const saved = (await store.model('doc-t1')) as unknown as FakeModel;
    expect(saved).not.toBe(model);
    expect(saved.uri.toString()).toBe('damocles-document://doc-t1/C:/p/ab.code-search');
  });

  it('saves, formats and auto saves the modified side of an editable diff tab, and nothing of a read-only one', async () => {
    const diff: ShellEditorTab = { id: 'd1', kind: 'diff', title: 'a.ts', displayPath: 'a.ts', dirty: true, readOnly: false, conflict: false, diff: { originalId: 'doc-old', modifiedId: 'doc-new', added: 1, removed: 1 } };
    const sides = { 'doc-old': { name: 'a.ts', languageId: 'typescript' }, 'doc-new': { name: 'a.ts', languageId: 'typescript' } };
    const { api, store } = await setup(state([diff], 'd1', { autoSave: 'afterDelay' }, sides), { 'doc-old': text('doc-old', 'a'), 'doc-new': text('doc-new', 'b') });
    const model = (await store.model('doc-new')) as unknown as FakeModel;
    api.editorCommand('save');
    await vi.runAllTimersAsync();
    expect(api.saveDocument).toHaveBeenCalledWith({ documentId: 'doc-new', version: 1, text: 'b' });
    api.editorCommand('formatDocument');
    await vi.runAllTimersAsync();
    expect(api.formatDocument).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'doc-new', reason: 'command' }));
    model.type('bc');
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);
    expect(api.saveDocument).toHaveBeenLastCalledWith({ documentId: 'doc-new', version: 1, text: 'bc' });

    vi.mocked(api.saveDocument).mockClear();
    api.pushEditorState(state([{ ...diff, readOnly: true }], 'd1', {}, sides));
    api.editorCommand('save');
    await vi.runAllTimersAsync();
    expect(api.saveDocument).not.toHaveBeenCalled();
  });

  it('saves a document once per focus change however many tabs show it and however often focus leaves, and one save at a time', async () => {
    const source = tab({ id: 't1', dirty: true, documentId: 'doc-md' });
    const preview = tab({ id: 't2', kind: 'markdownPreview', dirty: true, documentId: 'doc-md' });
    let answer: (result: { ok: true }) => void = () => undefined;
    const { api, store } = await setup(state([source, preview], 't1', { autoSave: 'onFocusChange' }), { 'doc-md': text('doc-md', '# a') });
    vi.mocked(api.saveDocument).mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const model = (await store.model('doc-md')) as unknown as FakeModel;
    store.saveOnFocusChange();
    store.saveOnFocusChange();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.saveDocument).toHaveBeenCalledTimes(1);
    answer({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.saveDocument).toHaveBeenCalledTimes(1);

    // Typed while a save runs: the next save waits for it, then sends the new text.
    store.saveOnFocusChange();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.saveDocument).toHaveBeenCalledTimes(2);
    model.type('# ab');
    const second = store.save(source);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.saveDocument).toHaveBeenCalledTimes(2);
    answer({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.saveDocument).toHaveBeenCalledTimes(3);
    expect(api.saveDocument).toHaveBeenLastCalledWith({ documentId: 'doc-md', version: 1, text: '# ab' });
    answer({ ok: true });
    expect(await second).toEqual({ ok: true });
  });

  it('shows a fixed reason under the tab and logs it when the save call rejects, and still runs the save queued behind it', async () => {
    const { api, store } = await setup(state([tab({ id: 't1', dirty: true })]), { 'doc-t1': text('doc-t1', 'a') });
    const model = (await store.model('doc-t1')) as unknown as FakeModel;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let reject: (err: Error) => void = () => undefined;
    vi.mocked(api.saveDocument).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    model.type('ab');
    const first = store.save(store.tabs.value[0]!);
    await vi.advanceTimersByTimeAsync(0);
    model.type('abc');
    const second = store.save(store.tabs.value[0]!);
    const raw = new Error("Error invoking remote method 'damocles:shell:editor:save': Error: Unknown document C:\\p\\a.ts");
    reject(raw);

    const reason = "Failed to save 'a.ts': Damocles could not finish the save. Try again.";
    expect(await first).toEqual({ ok: false, reason: 'failed', message: reason });
    expect(logged).toHaveBeenCalledWith(expect.any(String), raw);
    expect(await second).toEqual({ ok: true });
    expect(api.saveDocument).toHaveBeenLastCalledWith({ documentId: 'doc-t1', version: 1, text: 'abc' });
    expect(store.saveError.value).toBeNull();

    vi.mocked(api.saveDocument).mockRejectedValueOnce(raw);
    expect(await store.save(store.tabs.value[0]!)).toEqual({ ok: false, reason: 'failed', message: reason });
    expect(store.saveError.value).toEqual({ tabId: 't1', message: reason });
    expect(store.saveError.value?.message).not.toContain('C:');
  });

  it('gives two settings documents of one scope two models, each at its document\'s URI', async () => {
    const first = tab({ id: 's1', kind: 'settings', settingsScope: 'project', title: 'settings.json' });
    const second = tab({ id: 's2', kind: 'settings', settingsScope: 'project', title: 'settings.json' });
    const { store } = await setup(state([first, second]), { 'doc-s1': text('doc-s1', '{ "a": 1 }'), 'doc-s2': text('doc-s2', '{ "b": 2 }') });
    const one = (await store.model('doc-s1')) as unknown as FakeModel;
    const two = (await store.model('doc-s2')) as unknown as FakeModel;
    expect([one.uri.toString(), two.uri.toString()]).toEqual(['inmemory://damocles/settings/project/doc-s1.json', 'inmemory://damocles/settings/project/doc-s2.json']);
    expect([one.getValue(), two.getValue()]).toEqual(['{ "a": 1 }', '{ "b": 2 }']);
  });

  it('keeps each tab\'s view state while the tab is open and forgets it once the tab closes', async () => {
    const { api, store } = await setup(state([tab({ id: 't1' }), tab({ id: 't2', kind: 'image' })]), {});
    const viewState = { cursorState: [], viewState: { scrollTop: 400 }, contributionsState: {} } as unknown as Parameters<typeof store.rememberViewState>[1];
    store.rememberViewState('t1', viewState);
    store.rememberViewState('t2', null);
    api.pushEditorState(state([tab({ id: 't1' }), tab({ id: 't2', kind: 'image' })], 't2'));
    await nextTick();
    expect(store.viewStateOf('t1')).toBe(viewState);
    expect(store.viewStateOf('t2')).toBeUndefined();
    api.pushEditorState(state([tab({ id: 't2', kind: 'image' })], 't2'));
    await nextTick();
    expect(store.viewStateOf('t1')).toBeUndefined();
  });

  it('answers a flush even when a format fails, after sending every pending edit', async () => {
    const { api, store } = await setup(state([tab({ id: 't1' }), tab({ id: 't2', kind: 'image' })]), {
      'doc-t1': text('doc-t1', 'a'),
      'doc-t2': { kind: 'image', documentId: 'doc-t2', dataUrl: 'data:image/png;base64,', bytes: 0 },
    });
    const model = (await store.model('doc-t1')) as unknown as FakeModel;
    model.type('ab');
    model.type('abc');
    api.editorFlush({ requestId: 'req-1', format: ['doc-t2'] });
    await vi.runAllTimersAsync();
    expect(api.reportEdit).toHaveBeenLastCalledWith(expect.objectContaining({ documentId: 'doc-t1', text: 'abc' }));
    expect(api.editorFlushed).toHaveBeenCalledWith('req-1');
  });
});
