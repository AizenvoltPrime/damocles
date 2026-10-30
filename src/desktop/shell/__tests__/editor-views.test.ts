// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ShellDocumentContent, ShellEditorState, ShellEditorTab } from '../../preload/shell-channels';
import CodeEditor from '../editor/CodeEditor.vue';
import DiffEditor from '../editor/DiffEditor.vue';
import ImagePreview from '../editor/ImagePreview.vue';
import MarkdownPreview from '../editor/MarkdownPreview.vue';
import MergeEditor from '../editor/merge/MergeEditor.vue';
import { createEditorStore, EDITOR_STORE, type EditorStore, type ShellMonacoModule } from '../editor/editor-store';
import { createScmStore, SCM_STORE } from '../scm/scm-store';
import { shellI18n } from '../i18n';
import { EDITOR_STATE, fakeScmApi, fakeShellApi, STATE, type FakeShellApi } from './fakes';

vi.mock('../editor/context-menu', () => ({ attachEditorContextMenu: () => ({ dispose: () => {} }) }));
// the merge editor's Result works from its markers alone when its worker aligns nothing
vi.mock('../editor/merge/merge-worker', () => ({ createMergeWorker: () => ({ align: async () => null, markers: async () => null, dispose: () => {} }) }));

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
  // what the git, conflict and keybinding attachments register; none of it acts in these tests
  createDecorationsCollection(): { set(): void; clear(): void } { return { set: () => undefined, clear: () => undefined }; }
  createContextKey(): { set(): void } { return { set: () => undefined }; }
  readonly id = `editor-${Math.random()}`;
  getId(): string { return this.id; }
  hasWidgetFocus(): boolean { return false; }
  readonly actions: string[] = [];
  addAction(action: { id: string }): typeof disposable { this.actions.push(action.id); return { dispose: () => { this.actions.splice(this.actions.indexOf(action.id), 1); } }; }
  onMouseDown(): typeof disposable { return disposable; }
  onMouseLeave(): typeof disposable { return disposable; }
  onMouseMove(): typeof disposable { return disposable; }
  onDidChangeCursorPosition(): typeof disposable { return disposable; }
  onDidChangeModel(): typeof disposable { return disposable; }
  onDidChangeModelContent(): typeof disposable { return disposable; }
  onDidLayoutChange(): typeof disposable { return disposable; }
  onDidChangeConfiguration(): typeof disposable { return disposable; }
  getOption(): number { return 18; }
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
  readonly moves: string[] = [];
  goToDiff(target: string): void { this.moves.push(target); }
  // null until Monaco computed the diff, as its getLineChanges is
  lineChanges: Array<{ originalStartLineNumber: number; originalEndLineNumber: number; modifiedStartLineNumber: number; modifiedEndLineNumber: number }> | null = null;
  readonly diffListeners = new Set<() => void>();
  getLineChanges(): FakeDiffEditor['lineChanges'] { return this.lineChanges; }
  onDidUpdateDiff(listener: () => void): { dispose(): void } {
    this.diffListeners.add(listener);
    return { dispose: () => this.diffListeners.delete(listener) };
  }
  /** Monaco's diff computed again, after a change to either side. */
  updateDiff(changes: NonNullable<FakeDiffEditor['lineChanges']>): void {
    this.lineChanges = changes;
    for (const listener of [...this.diffListeners]) listener();
  }
  dispose(): void {}
}

const editors: FakeCodeEditor[] = [];
const diffEditors: FakeDiffEditor[] = [];
const models = new Map<string, FakeModel>();
const monacoModule = {
  useMonaco: () => ({
    KeyMod: { chord: () => 0, CtrlCmd: 0, Alt: 0, Shift: 0 },
    KeyCode: {},
    languages: { registerCodeLensProvider: () => disposable },
    Uri: {
      from: (parts: { scheme: string; authority?: string; path: string }) => ({ path: parts.path, toString: () => `${parts.scheme}://${parts.authority ?? ''}${parts.path}` }),
      file: (fsPath: string) => ({ path: `/${fsPath}`, toString: () => `file:///${fsPath}` }),
      parse: (value: string) => ({ path: value, toString: () => value }),
    },
    editor: {
      EndOfLineSequence: { LF: 0, CRLF: 1 },
      EditorOption: { lineHeight: 75 },
      // the merge editor's input panes pass no URI
      createModel: (text: string, _language: string, uri: { toString(): string } = { toString: () => `inmemory://${models.size}` }) => {
        const model = new FakeModel(text, uri);
        models.set(uri.toString(), model);
        return model;
      },
      create: (_host: unknown, options: Record<string, unknown> = {}) => {
        const editor = new FakeCodeEditor();
        editor.options.push(options);
        editors.push(editor);
        return editor;
      },
      registerCommand: () => disposable,
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
  ({ id: 'd', kind: 'diff', title: 'a.ts', displayPath: 'a.ts', dirty: false, readOnly: false, conflict: false, diff: { originalId: 'doc-old', modifiedId: 'doc-new' } });
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
  const wrapper = mount(component as Parameters<typeof mount>[0], { props, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store, [SCM_STORE]: createScmStore(fakeScmApi()) } }, attachTo: document.body }) as VueWrapper;
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

describe('a document main could not load', () => {
  // main answers the first read with a failure and every later one with the content
  async function failingOnce(shown: ShellEditorTab, content: ShellDocumentContent): Promise<{ api: FakeShellApi; store: EditorStore }> {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let failed = false;
    const api = fakeShellApi([], {
      getEditorState: vi.fn(async () => state([shown])),
      getDocument: vi.fn(async () => {
        if (failed) return content;
        failed = true;
        throw new Error('main could not read it');
      }),
    });
    const store = createEditorStore(api, async () => monacoModule);
    await store.start();
    return { api, store };
  }
  const failure = (wrapper: VueWrapper): string | undefined => {
    const notice = wrapper.find('[data-testid="editor-load-failed"]');
    return notice.exists() ? `${notice.attributes('role')}: ${notice.text()}` : undefined;
  };

  it.each([
    ['markdown preview', MarkdownPreview, tab('p', { kind: 'markdownPreview', title: 'notes.md', displayPath: '/srv/notes.md', documentId: 'doc-p' }), text('doc-p', '# Saved'), (wrapper: VueWrapper) => wrapper.find('h1').text() === 'Saved'],
    ['image preview', ImagePreview, tab('i', { kind: 'image', title: 'logo.png', displayPath: '/srv/logo.png', documentId: 'doc-i' }), { kind: 'image', documentId: 'doc-i', dataUrl: 'data:image/png;base64,AAAA', bytes: 3 } as ShellDocumentContent, (wrapper: VueWrapper) => wrapper.find('img').exists()],
  ])('says so in its %s, and the next one of it asks main again', async (_name, component, shown, content, rendered) => {
    const { api, store } = await failingOnce(shown, content);
    const first = mountWith(component, store, { api, tab: shown });
    await flushPromises();
    expect(failure(first)).toBe(`alert: Damocles could not open '${shown.displayPath.split('/').at(-1)}'.`);
    const second = mountWith(component, store, { api, tab: shown });
    await flushPromises();
    expect(failure(second)).toBeUndefined();
    expect(rendered(second)).toBe(true);
    expect(api.getDocument).toHaveBeenCalledTimes(2);
  });

  it('says so in the code editor, which shows the text once a later show of the tab loads it', async () => {
    const code = tab('a', { title: 'a.ts', displayPath: '/srv/a.ts' });
    const { api, store } = await failingOnce(code, text('doc-a', 'const a = 1;'));
    const wrapper = mountWith(CodeEditor, store, { api, tab: code, menuShortcuts: STATE.shortcuts.editorMenu });
    await flushPromises();
    expect(failure(wrapper)).toBe("alert: Damocles could not open 'a.ts'.");
    expect(editors[0]!.model).toBeNull();
    await wrapper.setProps({ tab: { ...code, id: 'a2' } });
    await flushPromises();
    expect(failure(wrapper)).toBeUndefined();
    expect(editors[0]!.model?.getValue()).toBe('const a = 1;');
  });

  // main fails the first read of `failing` and answers every read after it from `documents`
  async function failingFirst(shown: ShellEditorTab, failing: string, documents: Record<string, ShellDocumentContent>): Promise<{ api: FakeShellApi; store: EditorStore }> {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let failed = false;
    const api = fakeShellApi([], {
      getEditorState: vi.fn(async () => state([shown])),
      getDocument: vi.fn(async (documentId: string) => {
        if (documentId !== failing || failed) return documents[documentId]!;
        failed = true;
        throw new Error('main could not read it');
      }),
    });
    const store = createEditorStore(api, async () => monacoModule);
    await store.start();
    return { api, store };
  }
  const remount = (wrapper: VueWrapper): void => {
    wrapper.unmount();
    mounted.splice(mounted.indexOf(wrapper), 1);
  };

  it('says so in a diff tab whose side could not load, which shows the diff once a later show of the tab loads it', async () => {
    const diff = { ...diffTab(), title: 'a.ts (Working Tree)', displayPath: '/srv/a.ts' };
    const { api, store } = await failingFirst(diff, 'doc-new', { 'doc-old': text('doc-old', 'a'), 'doc-new': text('doc-new', 'b') });
    const first = mountWith(DiffEditor, store, { api, tab: diff, menuShortcuts: STATE.shortcuts.editorMenu });
    await flushPromises();
    expect(failure(first)).toBe("alert: Damocles could not open 'a.ts'.");
    expect(diffEditors).toEqual([]);
    remount(first);

    const second = mountWith(DiffEditor, store, { api, tab: diff, menuShortcuts: STATE.shortcuts.editorMenu });
    await flushPromises();
    expect(failure(second)).toBeUndefined();
    expect(diffEditors).toHaveLength(1);
    expect(second.get('[data-testid="diff-editor"]').attributes('data-monaco-ready')).toBe('true');
  });

  it('says so in a diff tab whose one text side could not load beside a side main does not display', async () => {
    const diff = { ...diffTab(), displayPath: '/srv/a.ts', diff: { ...diffTab().diff, sides: { original: { kind: 'notDisplayed' as const, reason: 'binary' as const, bytes: 4, openable: false }, modified: { kind: 'text' as const } } } };
    const { api, store } = await failingFirst(diff, 'doc-new', { 'doc-new': text('doc-new', 'b') });
    const first = mountWith(DiffEditor, store, { api, tab: diff, menuShortcuts: STATE.shortcuts.editorMenu });
    await flushPromises();
    expect(failure(first)).toBe("alert: Damocles could not open 'a.ts'.");
    expect(editors).toEqual([]);
    remount(first);

    mountWith(DiffEditor, store, { api, tab: diff, menuShortcuts: STATE.shortcuts.editorMenu });
    await flushPromises();
    expect(editors[0]!.model?.getValue()).toBe('b');
  });

  it('says so in a merge tab whose Result could not load, which shows the merge once a later show of the tab loads it', async () => {
    const merge = tab('m', { kind: 'merge', title: 'a.ts', displayPath: '/srv/a.ts', documentId: 'doc-m', merge: { upload: true, path: 'src/a.ts', documentId: 'doc-m' } }) as ShellEditorTab & { merge: NonNullable<ShellEditorTab['merge']> };
    const { api, store } = await failingFirst(merge, 'doc-m', { 'doc-m': text('doc-m', 'resolved\n') });
    const label = { title: 'side', marker: 'side' };
    vi.mocked(api.uploadMergeInputs).mockResolvedValue({ ok: true, base: 'a\n', current: 'b\n', incoming: 'c\n', labels: { current: label, incoming: label, base: label }, operation: 'merge' });
    const first = mountWith(MergeEditor, store, { api, tab: merge });
    await flushPromises();
    expect(failure(first)).toBe("alert: Damocles could not open 'a.ts'.");
    expect(first.find('[data-testid="merge-failure"]').exists()).toBe(false);
    expect(first.find('[role="progressbar"]').exists()).toBe(false);
    expect(editors).toEqual([]);
    remount(first);

    const second = mountWith(MergeEditor, store, { api, tab: merge });
    await flushPromises();
    expect(failure(second)).toBeUndefined();
    expect(editors).toHaveLength(3);
    expect(editors[2]!.options[0]).toMatchObject({ model: store.bufferModel('doc-m') });
    expect(second.get('[data-testid="merge-status"]').text()).toBe('All conflicts resolved');
  });

  it('says the merge inputs could not be read, and stops its bar, when main throws on the request', async () => {
    const merge = tab('m', { kind: 'merge', title: 'a.ts', displayPath: '/srv/a.ts', documentId: 'doc-m', merge: { upload: true, path: 'src/a.ts', documentId: 'doc-m' } }) as ShellEditorTab & { merge: NonNullable<ShellEditorTab['merge']> };
    const { api, store } = await failingFirst(merge, 'none', { 'doc-m': text('doc-m', 'resolved\n') });
    vi.mocked(api.uploadMergeInputs).mockRejectedValue(new Error('main threw'));
    const wrapper = mountWith(MergeEditor, store, { api, tab: merge });
    await flushPromises();
    expect(wrapper.get('[data-testid="merge-failure"]').text()).toBe("Couldn't read the versions to merge. See the Git output.");
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false);
    expect(editors).toEqual([]);
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
  it('shows a side main sends no text for as its placeholder beside the text side, with Open Anyway only for the file on disk', async () => {
    const binaryHead: ShellEditorTab & { diff: NonNullable<ShellEditorTab['diff']> } = {
      ...diffTab(),
      diff: { ...diffTab().diff, sides: { original: { kind: 'notDisplayed', reason: 'binary', bytes: 2048, openable: false }, modified: { kind: 'text' } } },
    };
    const { api, store } = await setup(state([binaryHead]), { 'doc-old': { kind: 'notDisplayed', documentId: 'doc-old', reason: 'binary', bytes: 2048 }, 'doc-new': text('doc-new', 'b') });
    const wrapper = mountWith(DiffEditor, store, { api, tab: binaryHead, menuShortcuts: STATE.shortcuts.editorMenu });
    await flushPromises();
    const original = wrapper.get('[data-side="original"]');
    expect(original.get('[data-testid="diff-not-displayed"]').text()).toContain('This file is not displayed');
    expect(original.text()).toContain('It is a binary file. 2 kB');
    expect(original.find('[data-testid="diff-open-anyway"]').exists()).toBe(false);
    expect(wrapper.get('[data-side="modified"]').find('[data-testid="diff-text-side"]').exists()).toBe(true);
    expect(diffEditors).toEqual([]);
    expect(editors).toHaveLength(1);
    expect(editors[0]!.model).toBe(models.get('damocles-document://doc-new/untitled'));
    expect(editors[0]!.options[0]).toMatchObject({ readOnly: false });
    expect(wrapper.get('[data-testid="diff-editor"]').attributes('data-monaco-ready')).toBe('true');
    expect(api.getDocument).not.toHaveBeenCalledWith('doc-old');
    // a diff with a side that is not text counts no lines
    expect(store.diffStats.value.has('d')).toBe(false);

    const largeFile: ShellEditorTab & { diff: NonNullable<ShellEditorTab['diff']> } = {
      ...diffTab(),
      id: 'd2',
      diff: { ...diffTab().diff, originalId: 'doc-new', modifiedId: 'doc-big', sides: { original: { kind: 'text' }, modified: { kind: 'notDisplayed', reason: 'tooLarge', bytes: 12 * 1024 * 1024, openable: true } } },
    };
    const large = mountWith(DiffEditor, store, { api, tab: largeFile, menuShortcuts: STATE.shortcuts.editorMenu });
    await flushPromises();
    const modified = large.get('[data-side="modified"]');
    expect(modified.text()).toContain('It is too large to open in the editor. 12 MB');
    expect(editors[1]!.options[0]).toMatchObject({ readOnly: true });
    expect(store.diffStats.value.has('d2')).toBe(false);
    await modified.get('[data-testid="diff-open-anyway"]').trigger('click');
    expect(api.editorTab).toHaveBeenCalledWith({ action: 'openFile', tabId: 'd2' });
  });

  it('moves between the changes of a diff with no git behind it, from the palette and from either side\'s keys', async () => {
    const diff = diffTab();
    const { api, store } = await setup(state([diff]), { 'doc-old': text('doc-old', 'a'), 'doc-new': text('doc-new', 'b') });
    const wrapper = mountWith(DiffEditor, store, { api, tab: diff, menuShortcuts: STATE.shortcuts.editorMenu });
    await flushPromises();
    await store.runCommand('nextChange');
    await store.runCommand('previousChange');
    expect(diffEditors[0]!.moves).toEqual(['next', 'previous']);
    for (const side of diffEditors[0]!.sides) expect(side.actions).toContain('damocles.git.nextChange');
    wrapper.unmount();
    mounted.splice(mounted.indexOf(wrapper), 1);
    for (const side of diffEditors[0]!.sides) expect(side.actions).toEqual([]);
  });

  it('counts the lines of the diff its editor shows, each time Monaco computes it again, and drops the count once unmounted', async () => {
    const diff = diffTab();
    const { api, store } = await setup(state([diff]), { 'doc-old': text('doc-old', 'a'), 'doc-new': text('doc-new', 'b') });
    const wrapper = mountWith(DiffEditor, store, { api, tab: diff, menuShortcuts: STATE.shortcuts.editorMenu });
    await flushPromises();
    expect(store.diffStats.value.get('d')).toBeUndefined();

    // an insertion of two lines after line 3, a change of lines 5-6 into one line, a deletion of line 9
    diffEditors[0]!.updateDiff([
      { originalStartLineNumber: 3, originalEndLineNumber: 0, modifiedStartLineNumber: 4, modifiedEndLineNumber: 5 },
      { originalStartLineNumber: 5, originalEndLineNumber: 6, modifiedStartLineNumber: 7, modifiedEndLineNumber: 7 },
      { originalStartLineNumber: 9, originalEndLineNumber: 9, modifiedStartLineNumber: 9, modifiedEndLineNumber: 0 },
    ]);
    expect(store.diffStats.value.get('d')).toEqual({ added: 3, removed: 3 });

    // the index side caught up with the working file after a stage
    diffEditors[0]!.updateDiff([]);
    expect(store.diffStats.value.get('d')).toEqual({ added: 0, removed: 0 });

    wrapper.unmount();
    mounted.splice(mounted.indexOf(wrapper), 1);
    expect(store.diffStats.value.has('d')).toBe(false);
  });

  it('shows the count of the newest diff editor of a tab still mounted, whichever of its editors unmounts first', async () => {
    const diff = diffTab();
    const { api, store } = await setup(state([diff]), { 'doc-old': text('doc-old', 'a'), 'doc-new': text('doc-new', 'b') });
    const editorOf = () => mountWith(DiffEditor, store, { api, tab: diff, menuShortcuts: STATE.shortcuts.editorMenu });
    const unmount = (wrapper: ReturnType<typeof editorOf>): void => {
      wrapper.unmount();
      mounted.splice(mounted.indexOf(wrapper), 1);
    };
    const changed = (lines: number) => [{ originalStartLineNumber: 1, originalEndLineNumber: lines, modifiedStartLineNumber: 1, modifiedEndLineNumber: lines }];
    const first = editorOf();
    const second = editorOf();
    await flushPromises();
    diffEditors[0]!.updateDiff(changed(1));
    diffEditors[1]!.updateDiff(changed(2));
    expect(store.diffStats.value.get('d')).toEqual({ added: 2, removed: 2 });
    unmount(first);
    expect(store.diffStats.value.get('d')).toEqual({ added: 2, removed: 2 });

    const third = editorOf();
    await flushPromises();
    diffEditors[2]!.updateDiff(changed(3));
    expect(store.diffStats.value.get('d')).toEqual({ added: 3, removed: 3 });
    unmount(third);
    expect(store.diffStats.value.get('d')).toEqual({ added: 2, removed: 2 });
    unmount(second);
    expect(store.diffStats.value.has('d')).toBe(false);
  });

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
