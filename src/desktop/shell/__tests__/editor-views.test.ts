// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ShellDocumentContent, ShellEditorState, ShellEditorTab } from '../../preload/shell-channels';
import CodeEditor from '../editor/CodeEditor.vue';
import DiffEditor from '../editor/DiffEditor.vue';
import MarkdownPreview from '../editor/MarkdownPreview.vue';
import { createEditorStore, EDITOR_STORE, type EditorStore, type ShellMonacoModule } from '../editor/editor-store';
import { shellI18n } from '../i18n';
import { EDITOR_STATE, fakeShellApi, STATE, type FakeShellApi } from './fakes';

vi.mock('../editor/context-menu', () => ({ attachEditorContextMenu: () => ({ dispose: () => {} }) }));

const disposable = { dispose: () => {} };

// A Monaco model double: whole-text reads and replacements, with the change listeners the store and the preview add.
class FakeModel {
  disposed = false;
  readonly listeners = new Set<() => void>();
  text: string;
  readonly uri: { toString(): string };
  constructor(text: string, uri: { toString(): string }) {
    this.text = text;
    this.uri = uri;
  }
  getValue(): string { return this.text; }
  setEOL(): void {}
  updateOptions(): void {}
  detectIndentation(): void {}
  getLanguageId(): string { return 'markdown'; }
  getOptions(): { tabSize: number; indentSize: number; insertSpaces: boolean } { return { tabSize: 4, indentSize: 4, insertSpaces: true }; }
  onDidChangeContent(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  /** A keystroke in a source tab. */
  type(text: string): void {
    this.text = text;
    for (const listener of [...this.listeners]) listener();
  }
  dispose(): void { this.disposed = true; }
  isDisposed(): boolean { return this.disposed; }
}

// A code editor double whose view state is where it is scrolled to; setModel starts a model at the top, as Monaco's does.
class FakeCodeEditor {
  model: FakeModel | null = null;
  scrollTop = 0;
  disposed = false;
  readonly setModelCalls: Array<{ model: FakeModel | null; disposed: boolean }> = [];
  readonly options: Array<Record<string, unknown>> = [];
  setModel(model: FakeModel | null): void {
    this.setModelCalls.push({ model, disposed: this.disposed });
    this.model = model;
    this.scrollTop = 0;
  }
  getModel(): FakeModel | null { return this.model; }
  saveViewState(): unknown { return { cursorState: [], viewState: { scrollTop: this.scrollTop }, contributionsState: {} }; }
  restoreViewState(state: { viewState: { scrollTop: number } } | null): void { this.scrollTop = state?.viewState.scrollTop ?? 0; }
  updateOptions(options: Record<string, unknown>): void { this.options.push(options); }
  onDidScrollChange(): typeof disposable { return disposable; }
  onDidChangeCursorSelection(): typeof disposable { return disposable; }
  onDidBlurEditorWidget(): typeof disposable { return disposable; }
  getScrollTop(): number { return this.scrollTop; }
  getScrollHeight(): number { return 10_000; }
  getLayoutInfo(): { height: number } { return { height: 500 }; }
  setScrollTop(top: number): void { this.scrollTop = top; }
  getSelection(): null { return null; }
  getPosition(): null { return null; }
  focus(): void {}
  dispose(): void { this.disposed = true; }
}

// A diff editor double: its view state is the modified side's scroll position.
class FakeDiffEditor {
  scrollTop = 0;
  readonly options: Array<Record<string, unknown>> = [];
  readonly sides = [new FakeCodeEditor(), new FakeCodeEditor()];
  setModel(): void { this.scrollTop = 0; }
  getModel(): null { return null; }
  saveViewState(): unknown { return { original: null, modified: { cursorState: [], viewState: { scrollTop: this.scrollTop }, contributionsState: {} } }; }
  restoreViewState(state: { modified: { viewState: { scrollTop: number } } } | null): void { this.scrollTop = state?.modified.viewState.scrollTop ?? 0; }
  updateOptions(options: Record<string, unknown>): void { this.options.push(options); }
  getOriginalEditor(): FakeCodeEditor { return this.sides[0]!; }
  getModifiedEditor(): FakeCodeEditor { return this.sides[1]!; }
  dispose(): void {}
}

const editors: FakeCodeEditor[] = [];
const diffEditors: FakeDiffEditor[] = [];
const models = new Map<string, FakeModel>();
const monacoModule = {
  useMonaco: () => ({
    Uri: {
      from: (parts: { scheme: string; authority?: string; path: string }) => ({ path: parts.path, toString: () => `${parts.scheme}://${parts.authority ?? ''}${parts.path}` }),
      file: (fsPath: string) => ({ path: `/${fsPath}`, toString: () => `file:///${fsPath}` }),
      parse: (value: string) => ({ path: value, toString: () => value }),
    },
    editor: {
      EndOfLineSequence: { LF: 0, CRLF: 1 },
      createModel: (text: string, _language: string, uri: { toString(): string }) => {
        const model = new FakeModel(text, uri);
        models.set(uri.toString(), model);
        return model;
      },
      create: () => {
        const editor = new FakeCodeEditor();
        editors.push(editor);
        return editor;
      },
      createDiffEditor: () => {
        const editor = new FakeDiffEditor();
        diffEditors.push(editor);
        return editor;
      },
    },
  }),
  baseEditorOptions: () => ({}),
  hasGoToProvider: () => false,
} as unknown as ShellMonacoModule;

const text = (documentId: string, value: string): ShellDocumentContent =>
  ({ kind: 'text', documentId, version: 1, editSeq: 0, text: value, languageId: 'markdown', eol: '\n', encoding: 'utf8', bom: false });
const tab = (id: string, extra: Partial<ShellEditorTab> = {}): ShellEditorTab =>
  ({ id, kind: 'code', title: `${id}.md`, displayPath: `${id}.md`, documentId: `doc-${id}`, dirty: false, readOnly: false, conflict: false, ...extra });
const diffTab = (): ShellEditorTab & { diff: NonNullable<ShellEditorTab['diff']> } =>
  ({ id: 'd', kind: 'diff', title: 'a.ts', displayPath: 'a.ts', dirty: false, readOnly: false, conflict: false, diff: { originalId: 'doc-old', modifiedId: 'doc-new', added: 1, removed: 1 } });
const state = (tabs: ShellEditorTab[], settings: Partial<ShellEditorState['settings']> = {}): ShellEditorState => ({
  ...EDITOR_STATE,
  tabs,
  activeTabId: tabs[0]?.id ?? null,
  settings: { ...EDITOR_STATE.settings, ...settings },
  documents: Object.fromEntries(tabs.flatMap((each) => (each.documentId === undefined ? [] : [[each.documentId, { name: each.title, languageId: 'markdown' }]]))),
});

const mounted: VueWrapper[] = [];

async function setup(initial: ShellEditorState, documents: Record<string, ShellDocumentContent | Promise<ShellDocumentContent>>): Promise<{ api: FakeShellApi; store: EditorStore }> {
  const api = fakeShellApi([], {
    getEditorState: vi.fn(async () => initial),
    getDocument: vi.fn(async (documentId: string) => documents[documentId]!),
  });
  const store = createEditorStore(api, async () => monacoModule);
  await store.start();
  return { api, store };
}

function mountWith<T>(component: T, store: EditorStore, props: Record<string, unknown>): VueWrapper {
  const wrapper = mount(component as Parameters<typeof mount>[0], { props, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store } }, attachTo: document.body }) as VueWrapper;
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  editors.length = 0;
  diffEditors.length = 0;
  models.clear();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.useRealTimers();
});

describe('the markdown preview', () => {
  const heading = (wrapper: VueWrapper): string | undefined => wrapper.find('h1').exists() ? wrapper.get('h1').text() : undefined;

  it('renders main\'s content while no buffer holds the document', async () => {
    const preview = tab('p', { kind: 'markdownPreview', documentId: 'doc-md' });
    const { api, store } = await setup(state([preview]), { 'doc-md': text('doc-md', '# Saved') });
    const wrapper = mountWith(MarkdownPreview, store, { api, tab: preview });
    await flushPromises();
    expect(heading(wrapper)).toBe('Saved');
  });

  it('renders the source tab\'s unsaved text, and follows typing at most once per 300 ms', async () => {
    const source = tab('s', { documentId: 'doc-md' });
    const preview = tab('p', { kind: 'markdownPreview', documentId: 'doc-md' });
    const { api, store } = await setup(state([source, preview]), { 'doc-md': text('doc-md', '# Saved') });
    const model = (await store.model('doc-md')) as unknown as FakeModel;
    model.type('# Typed');
    vi.useFakeTimers();
    const wrapper = mountWith(MarkdownPreview, store, { api, tab: preview });
    await vi.advanceTimersByTimeAsync(0);
    expect(heading(wrapper)).toBe('Typed');

    model.type('# Typed more');
    await vi.advanceTimersByTimeAsync(299);
    expect(heading(wrapper)).toBe('Typed');
    model.type('# Typed most');
    await vi.advanceTimersByTimeAsync(1);
    expect(heading(wrapper)).toBe('Typed most');
  });

  it('follows a buffer created while it shows, as a search replace in the file creates one', async () => {
    const preview = tab('p', { kind: 'markdownPreview', documentId: 'doc-md' });
    const { api, store } = await setup(state([preview]), { 'doc-md': text('doc-md', '# Saved') });
    const wrapper = mountWith(MarkdownPreview, store, { api, tab: preview });
    await flushPromises();
    const model = (await store.model('doc-md')) as unknown as FakeModel;
    vi.useFakeTimers();
    model.type('# Replaced');
    await vi.advanceTimersByTimeAsync(300);
    expect(heading(wrapper)).toBe('Replaced');
  });
});

describe('a text tab\'s view state', () => {
  const props = (api: FakeShellApi, shown: ShellEditorTab) => ({ api, tab: shown, menuShortcuts: STATE.shortcuts.editorMenu });

  it('comes back after another kind of tab showed in between, which unmounts the editor', async () => {
    const code = tab('a', { title: 'a.ts' });
    const { api, store } = await setup(state([code, tab('img', { kind: 'image' })]), { 'doc-a': text('doc-a', 'const a = 1;\n'.repeat(900)) });
    const first = mountWith(CodeEditor, store, props(api, code));
    await flushPromises();
    editors[0]!.scrollTop = 4_000;
    first.unmount();
    mounted.splice(mounted.indexOf(first), 1);

    mountWith(CodeEditor, store, props(api, code));
    await flushPromises();
    expect(editors[1]!.model).toBe(models.get('damocles-document://doc-a/a.ts'));
    expect(editors[1]!.scrollTop).toBe(4_000);
  });

  it('is not given a model by a show that resolves after the editor unmounted', async () => {
    const code = tab('a', { title: 'a.ts' });
    let resolve: (content: ShellDocumentContent) => void = () => {};
    const slow = new Promise<ShellDocumentContent>((settle) => { resolve = settle; });
    const { api, store } = await setup(state([code]), { 'doc-a': slow });
    const wrapper = mountWith(CodeEditor, store, props(api, code));
    await flushPromises();
    wrapper.unmount();
    mounted.splice(mounted.indexOf(wrapper), 1);
    resolve(text('doc-a', 'late'));
    await flushPromises();
    expect(editors[0]!.disposed).toBe(true);
    expect(editors[0]!.setModelCalls.filter((call) => call.model !== null)).toEqual([]);
  });

  it('comes back for a diff tab, which is keyed by its tab and unmounts whenever another tab shows', async () => {
    const diff = diffTab();
    const { api, store } = await setup(state([diff]), { 'doc-old': text('doc-old', 'a'), 'doc-new': text('doc-new', 'b') });
    const first = mountWith(DiffEditor, store, props(api, diff));
    await flushPromises();
    diffEditors[0]!.scrollTop = 2_500;
    first.unmount();
    mounted.splice(mounted.indexOf(first), 1);

    mountWith(DiffEditor, store, props(api, diff));
    await flushPromises();
    expect(diffEditors[1]!.scrollTop).toBe(2_500);
  });
});

describe('a diff tab', () => {
  it('takes the editor settings live, as every other editor does', async () => {
    const diff = diffTab();
    const { api, store } = await setup(state([diff]), { 'doc-old': text('doc-old', 'a'), 'doc-new': text('doc-new', 'b') });
    mountWith(DiffEditor, store, { api, tab: diff, menuShortcuts: STATE.shortcuts.editorMenu });
    await flushPromises();
    api.pushEditorState(state([diff], { fontSize: 18, wordWrap: 'on', renderWhitespace: 'all' }));
    await flushPromises();
    expect(diffEditors[0]!.options.at(-1)).toEqual({ fontSize: 18, wordWrap: 'on', renderWhitespace: 'all' });
  });
});
