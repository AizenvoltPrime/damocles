import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorFormatReply, ShellDocumentContent, ShellEditorState, ShellEditorTab } from '../../preload/shell-channels';
import { EDITOR_FORMAT_TIMEOUT_MS } from '../../preload/shell-channels';
import { AUTO_SAVE_DELAY_MS, createEditorStore, FORMATTING_INDICATOR_DELAY_MS, type ShellMonacoModule } from '../editor/editor-store';
import { builtinEdits, lineEdits } from '../editor/format-edits';
import { EDITOR_STATE, fakeShellApi } from './fakes';

interface Range { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }

// A Monaco model double that applies line and column edits, and records the undo stops around each edit group.
class FakeModel {
  text: string;
  readonly history: string[] = [];
  disposed = false;
  readonly listeners: Array<() => void> = [];
  readonly uri = { toString: () => 'damocles-document:/doc' };
  private readonly language: string;
  constructor(text: string, language: string) {
    this.text = text;
    this.language = language;
  }
  getValue(): string { return this.text; }
  getValueLength(): number { return this.text.length; }
  getLanguageId(): string { return this.language; }
  getOptions(): { tabSize: number; insertSpaces: boolean } { return { tabSize: 2, insertSpaces: true }; }
  setEOL(): void {}
  updateOptions(): void {}
  detectIndentation(): void {}
  onDidChangeContent(listener: () => void): { dispose(): void } {
    this.listeners.push(listener);
    return { dispose: () => {} };
  }
  offsetOf(line: number, column: number): number {
    const lines = this.text.split('\n');
    return lines.slice(0, line - 1).reduce((sum, value) => sum + value.length + 1, 0) + column - 1;
  }
  getPositionAt(offset: number): { lineNumber: number; column: number } {
    const before = this.text.slice(0, offset).split('\n');
    return { lineNumber: before.length, column: before.at(-1)!.length + 1 };
  }
  getFullModelRange(): Range {
    const lines = this.text.split('\n');
    return { startLineNumber: 1, startColumn: 1, endLineNumber: lines.length, endColumn: lines.at(-1)!.length + 1 };
  }
  pushStackElement(): void { this.history.push('|'); }
  pushEditOperations(_selections: unknown, edits: Array<{ range: Range; text: string }>): void {
    const sorted = [...edits].sort((a, b) => this.offsetOf(b.range.startLineNumber, b.range.startColumn) - this.offsetOf(a.range.startLineNumber, a.range.startColumn));
    for (const { range, text } of sorted) {
      this.text = this.text.slice(0, this.offsetOf(range.startLineNumber, range.startColumn)) + text + this.text.slice(this.offsetOf(range.endLineNumber, range.endColumn));
    }
    this.history.push('edit');
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

let models: FakeModel[];
// The TypeScript worker's edits for the next built-in format.
let builtinSpans: Array<{ span: { start: number; length: number }; newText: string }> = [];
const tsWorker = {
  getFormattingEditsForRange: vi.fn(async (): Promise<typeof builtinSpans> => builtinSpans),
};

const monacoModule = {
  useMonaco: () => ({
    Uri: { from: (parts: { path: string }) => parts },
    editor: {
      EndOfLineSequence: { LF: 0, CRLF: 1 },
      createModel: (text: string, language: string) => {
        const model = new FakeModel(text, language);
        models.push(model);
        return model;
      },
    },
  }),
  builtinEdits,
  lineEdits,
  builtinWorkers: {
    typescript: async () => async () => tsWorker,
    javascript: async () => async () => tsWorker,
    json: async () => async () => ({ format: async () => [] }),
  },
} as unknown as ShellMonacoModule;

const tab = (overrides: Partial<ShellEditorTab> & { id: string }): ShellEditorTab => ({
  kind: 'code', title: 'a.ts', displayPath: 'a.ts', dirty: true, readOnly: false, conflict: false, documentId: `doc-${overrides.id}`, ...overrides,
});
const text = (documentId: string, value: string, version = 1): ShellDocumentContent =>
  ({ kind: 'text', documentId, version, editSeq: 0, text: value, languageId: 'typescript', eol: '\n', encoding: 'utf8', bom: false });
const state = (tabs: ShellEditorTab[], settings: Partial<ShellEditorState['settings']> = {}): ShellEditorState =>
  ({ ...EDITOR_STATE, tabs, activeTabId: tabs[0]?.id ?? null, settings: { ...EDITOR_STATE.settings, formatOnSave: true, ...settings } });

/** The reply main gives, released when the test says so. */
function deferredReply(): { promise: Promise<EditorFormatReply>; resolve: (reply: EditorFormatReply) => void } {
  let resolve!: (reply: EditorFormatReply) => void;
  const promise = new Promise<EditorFormatReply>((done) => (resolve = done));
  return { promise, resolve };
}

async function setup(initial: ShellEditorState, value = 'const a=1') {
  const api = fakeShellApi([], {
    getEditorState: vi.fn(async () => initial),
    getDocument: vi.fn(async (documentId: string) => text(documentId, value)),
  });
  const store = createEditorStore(api, async () => monacoModule);
  await store.start();
  const model = (await store.model('doc-t1')) as unknown as FakeModel;
  return { api, store, model };
}

beforeEach(() => {
  models = [];
  builtinSpans = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('format on save in the shell', () => {
  it('formats before Ctrl+S, as one undo step, and saves the formatted text', async () => {
    const { api, store, model } = await setup(state([tab({ id: 't1' })]));
    vi.mocked(api.formatDocument).mockResolvedValue({ kind: 'formatted', text: 'const a = 1;\n' });
    api.editorCommand('save');
    await vi.runAllTimersAsync();
    expect(api.formatDocument).toHaveBeenCalledWith({ documentId: 'doc-t1', text: 'const a=1', options: { tabSize: 2, insertSpaces: true }, reason: 'save' });
    expect(model.text).toBe('const a = 1;\n');
    expect(model.history).toEqual(['|', 'edit', '|']);
    expect(api.saveDocument).toHaveBeenCalledWith({ documentId: 'doc-t1', version: 1, text: 'const a = 1;\n' });
    expect(vi.mocked(api.formatDocument).mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(api.saveDocument).mock.invocationCallOrder[0]!);
    expect(store.formatting.value.size).toBe(0);
  });

  it('drops a result that arrives after the user typed, and saves the typed text', async () => {
    const { api, store, model } = await setup(state([tab({ id: 't1' })]));
    const reply = deferredReply();
    vi.mocked(api.formatDocument).mockReturnValue(reply.promise);
    const saved = store.save(store.tabs.value[0]!);
    await vi.advanceTimersByTimeAsync(0);
    model.type('const a=12');
    reply.resolve({ kind: 'formatted', text: 'const a = 1;\n' });
    await saved;
    expect(model.text).toBe('const a=12');
    expect(model.history).toEqual([]);
    expect(api.saveDocument).toHaveBeenCalledWith({ documentId: 'doc-t1', version: 1, text: 'const a=12' });
  });

  it('drops a result when main replaced the buffer meanwhile (a reload or revert)', async () => {
    const { api, store, model } = await setup(state([tab({ id: 't1' })]));
    const reply = deferredReply();
    vi.mocked(api.formatDocument).mockReturnValue(reply.promise);
    const saved = store.save(store.tabs.value[0]!);
    await vi.advanceTimersByTimeAsync(0);
    api.documentChanged({ documentId: 'doc-t1', content: text('doc-t1', 'from disk', 2) });
    reply.resolve({ kind: 'formatted', text: 'const a = 1;\n' });
    await saved;
    expect(model.text).toBe('from disk');
  });

  it('formats nothing while the setting is off, and never for auto save after a delay', async () => {
    const off = await setup(state([tab({ id: 't1' })], { formatOnSave: false }));
    await off.store.save(off.store.tabs.value[0]!);
    expect(off.api.formatDocument).not.toHaveBeenCalled();
    off.store.stop();

    const { api, model } = await setup(state([tab({ id: 't1' })], { autoSave: 'afterDelay' }));
    model.type('const a=2');
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);
    expect(api.saveDocument).toHaveBeenCalledWith({ documentId: 'doc-t1', version: 1, text: 'const a=2' });
    expect(api.formatDocument).not.toHaveBeenCalled();
  });

  it('formats and saves a document once when focus leaves twice before main answers, however many tabs show it', async () => {
    const { api, store } = await setup(state([tab({ id: 't1' }), tab({ id: 't2', kind: 'markdownPreview', documentId: 'doc-t1' })], { autoSave: 'onFocusChange' }));
    vi.mocked(api.formatDocument).mockResolvedValue({ kind: 'formatted', text: 'const a = 1;\n' });
    store.saveOnFocusChange();
    store.saveOnFocusChange();
    await vi.runAllTimersAsync();
    expect(api.formatDocument).toHaveBeenCalledTimes(1);
    expect(api.saveDocument).toHaveBeenCalledTimes(1);
    expect(api.saveDocument).toHaveBeenCalledWith({ documentId: 'doc-t1', version: 1, text: 'const a = 1;\n' });
  });

  it('formats before auto save on focus change', async () => {
    const { api, store } = await setup(state([tab({ id: 't1' })], { autoSave: 'onFocusChange' }));
    vi.mocked(api.formatDocument).mockResolvedValue({ kind: 'formatted', text: 'const a = 1;\n' });
    store.saveOnFocusChange();
    await vi.runAllTimersAsync();
    expect(api.formatDocument).toHaveBeenCalledWith(expect.objectContaining({ reason: 'save' }));
    expect(api.saveDocument).toHaveBeenCalledWith({ documentId: 'doc-t1', version: 1, text: 'const a = 1;\n' });
  });

  it('Format Document formats without saving, even with format on save off', async () => {
    const { api, model } = await setup(state([tab({ id: 't1' })], { formatOnSave: false }));
    vi.mocked(api.formatDocument).mockResolvedValue({ kind: 'formatted', text: 'const a = 1;\n' });
    api.editorCommand('formatDocument');
    await vi.runAllTimersAsync();
    expect(api.formatDocument).toHaveBeenCalledWith(expect.objectContaining({ reason: 'command' }));
    expect(model.text).toBe('const a = 1;\n');
    expect(api.saveDocument).not.toHaveBeenCalled();
  });

  it('runs Monaco\'s built-in formatter when main says so, and reports one that runs past the budget', async () => {
    const { api, model } = await setup(state([tab({ id: 't1' })]));
    vi.mocked(api.formatDocument).mockResolvedValue({ kind: 'builtin' });
    builtinSpans = [{ span: { start: 7, length: 1 }, newText: ' = ' }];
    api.editorCommand('formatDocument');
    await vi.runAllTimersAsync();
    expect(model.text).toBe('const a = 1');
    expect(api.reportFormatFailure).not.toHaveBeenCalled();

    tsWorker.getFormattingEditsForRange.mockImplementationOnce(() => new Promise(() => undefined));
    api.editorCommand('save');
    await vi.advanceTimersByTimeAsync(EDITOR_FORMAT_TIMEOUT_MS);
    await vi.runAllTimersAsync();
    expect(api.reportFormatFailure).toHaveBeenCalledWith({ documentId: 'doc-t1', reason: 'save', timedOut: true, message: '' });
    expect(api.saveDocument).toHaveBeenCalledWith({ documentId: 'doc-t1', version: 1, text: 'const a = 1' });
  });

  it('saves unformatted when main fails the request', async () => {
    const { api, store, model } = await setup(state([tab({ id: 't1' })]));
    vi.mocked(api.formatDocument).mockRejectedValue(new Error('Malformed format request from the shell'));
    await store.save(store.tabs.value[0]!);
    expect(model.text).toBe('const a=1');
    expect(api.saveDocument).toHaveBeenCalledWith({ documentId: 'doc-t1', version: 1, text: 'const a=1' });
  });

  it('shows the Formatting… indicator only for a format that takes longer than 300 ms', async () => {
    const { api, store } = await setup(state([tab({ id: 't1' })]));
    const fast = deferredReply();
    vi.mocked(api.formatDocument).mockReturnValueOnce(fast.promise);
    const first = store.save(store.tabs.value[0]!);
    await vi.advanceTimersByTimeAsync(FORMATTING_INDICATOR_DELAY_MS - 1);
    fast.resolve({ kind: 'unchanged' });
    await first;
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.formatting.value.size).toBe(0);

    const slow = deferredReply();
    vi.mocked(api.formatDocument).mockReturnValueOnce(slow.promise);
    const second = store.save(store.tabs.value[0]!);
    await vi.advanceTimersByTimeAsync(FORMATTING_INDICATOR_DELAY_MS);
    expect([...store.formatting.value]).toEqual(['doc-t1']);
    slow.resolve({ kind: 'unchanged' });
    await second;
    expect(store.formatting.value.size).toBe(0);
  });

  it('formats the documents a flush names before it answers, for the Save of the close and quit prompts', async () => {
    const { api, model } = await setup(state([tab({ id: 't1' })]));
    vi.mocked(api.formatDocument).mockResolvedValue({ kind: 'formatted', text: 'const a = 1;\n' });
    api.editorFlush({ requestId: 'r1', format: ['doc-t1'] });
    await vi.runAllTimersAsync();
    expect(model.text).toBe('const a = 1;\n');
    expect(api.reportEdit).toHaveBeenLastCalledWith(expect.objectContaining({ documentId: 'doc-t1', text: 'const a = 1;\n' }));
    expect(vi.mocked(api.reportEdit).mock.invocationCallOrder.at(-1)!).toBeLessThan(vi.mocked(api.editorFlushed).mock.invocationCallOrder[0]!);
    expect(api.editorFlushed).toHaveBeenCalledWith('r1');
  });
});

describe('lineEdits', () => {
  it('changes only the lines that differ, so the caret elsewhere stays', () => {
    expect(lineEdits('a\nb\nc\n', 'a\nB\nc\n')).toEqual([{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 1 }, text: 'B\n' }]);
    expect(lineEdits('a\nb\nc\nd', 'A\nb\nc\nD\n')).toEqual([
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 }, text: 'A\n' },
      { range: { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 2 }, text: 'D\n' },
    ]);
    expect(lineEdits('same\n', 'same\n')).toEqual([]);
  });

  it('compares CRLF text with LF output by its lines, so a CRLF file is not rewritten whole', () => {
    expect(lineEdits('a\r\nb\r\n', 'a\nb\n')).toEqual([]);
    expect(lineEdits('a\r\nb\r\n', 'a\nB\n')).toEqual([{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 1 }, text: 'B\n' }]);
  });

  it('replaces the whole text in one edit when the rewrite is too large to diff', () => {
    const before = Array.from({ length: 6000 }, (_value, index) => `line ${index}`).join('\n');
    const after = Array.from({ length: 6000 }, (_value, index) => `LINE ${index}`).join('\n');
    expect(lineEdits(before, after)).toEqual([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 6000, endColumn: 10 }, text: after }]);
  });

  it('applied to the text, gives the formatted text', () => {
    const model = new FakeModel('let x=1\nlet y  =2\n\n\nexport {x,y}', 'typescript');
    const formatted = 'let x = 1;\nlet y = 2;\n\nexport { x, y };\n';
    model.pushEditOperations([], lineEdits(model.text, formatted));
    expect(model.text).toBe(formatted);
  });
});
