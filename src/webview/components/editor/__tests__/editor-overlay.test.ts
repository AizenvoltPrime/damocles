// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { i18n } from '@/i18n';
import { useEditorStore } from '@/stores/useEditorStore';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { EditorDocument, EditorDocumentBody, ExtensionToWebviewMessage } from '@shared/types/messages';
import EditorOverlayHost from '../EditorOverlayHost.vue';

// Monaco needs a real layout engine and workers, so the lazy module is replaced by a recorder of what the views ask of it.
const fake = vi.hoisted(() => {
  interface Disposable { dispose: () => void }
  class FakeModel {
    readonly listeners: (() => void)[] = [];
    readonly dispose = vi.fn();
    value: string;
    readonly languageId: string;
    readonly uri: { toString(): string } | undefined;
    constructor(value: string, languageId: string, uri: { toString(): string } | undefined) {
      this.value = value;
      this.languageId = languageId;
      this.uri = uri;
    }
    getValue(): string { return this.value; }
    setValue(value: string): void {
      this.value = value;
      for (const listener of this.listeners) listener();
    }
    getLineCount(): number { return this.value.split('\n').length; }
    onDidChangeContent(listener: () => void): Disposable {
      this.listeners.push(listener);
      return { dispose: () => {} };
    }
  }
  class FakeEditor {
    readOnly: boolean;
    readonly dispose = vi.fn();
    readonly decorations: unknown[] = [];
    readonly commands: (() => void)[] = [];
    revealed: number | null = null;
    model: unknown = null;
    constructor(options: { readOnly?: boolean; model?: unknown }) {
      this.readOnly = options.readOnly ?? false;
      this.model = options.model ?? null;
    }
    updateOptions(options: { readOnly?: boolean }): void {
      if (options.readOnly !== undefined) this.readOnly = options.readOnly;
    }
    createDecorationsCollection(decorations: unknown[]): void { this.decorations.push(...decorations); }
    setPosition(): void {}
    revealLineInCenter(line: number): void { this.revealed = line; }
    addCommand(_keybinding: number, handler: () => void): void { this.commands.push(handler); }
    setModel(model: unknown): void { this.model = model; }
    getModifiedEditor(): FakeEditor { return this; }
  }
  const state = {
    models: [] as FakeModel[],
    editors: [] as FakeEditor[],
    markerListeners: [] as ((uris: { toString(): string }[]) => void)[],
    markers: [] as { startLineNumber: number; message: string }[],
    diagnostics: vi.fn(),
  };
  const monaco = {
    Range: class {
      readonly lines: [number, number];
      constructor(startLineNumber: number, _startColumn: number, endLineNumber: number) {
        this.lines = [startLineNumber, endLineNumber];
      }
    },
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    editor: {
      createModel: (value: string, languageId: string, uri?: { toString(): string }) => {
        const model = new FakeModel(value, languageId, uri);
        state.models.push(model);
        return model;
      },
      create: (_el: HTMLElement, options: { readOnly?: boolean; model?: unknown }) => {
        const editor = new FakeEditor(options);
        state.editors.push(editor);
        return editor;
      },
      createDiffEditor: (_el: HTMLElement, options: { readOnly?: boolean }) => {
        const editor = new FakeEditor(options);
        state.editors.push(editor);
        return editor;
      },
      onDidChangeMarkers: (listener: (uris: { toString(): string }[]) => void) => {
        state.markerListeners.push(listener);
        return { dispose: () => {} };
      },
      getModelMarkers: () => state.markers,
    },
  };
  return { state, monaco };
});

vi.mock('../useMonaco', () => ({
  useMonaco: () => fake.monaco,
  baseEditorOptions: () => ({ readOnly: true }),
  jsonDefaults: { setDiagnosticsOptions: fake.state.diagnostics },
}));

const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();
let posted: { type: string; [key: string]: unknown }[] = [];

const mounted: VueWrapper[] = [];
function mountHost(): VueWrapper {
  const wrapper = mount(EditorOverlayHost, { attachTo: document.body, global: { plugins: [i18n] } });
  mounted.push(wrapper as VueWrapper);
  return wrapper as VueWrapper;
}

const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const t = (key: string, values?: Record<string, unknown>) => (values ? i18n.global.t(key, values) : i18n.global.t(key));
const doc = (body: EditorDocumentBody, path = '/w/a.ts'): EditorDocument => ({ name: 'a.ts', path, body });
const text = (content: string): EditorDocumentBody => ({ kind: 'text', content, languageId: 'typescript' });
type ShowDiff = Extract<ExtensionToWebviewMessage, { type: 'editorShowDiff' }>;
type OpenFile = Extract<ExtensionToWebviewMessage, { type: 'editorOpenFile' }>;

// A proposal is held until its card's Open diff asks for it, which openProposal stands in for.
function showDiff(overrides: Partial<ShowDiff> = {}): void {
  const store = useEditorStore();
  const msg: ShowDiff = {
    type: 'editorShowDiff', viewId: 'v1', title: 'a.ts', purpose: 'proposal', approvalId: 'tool-1',
    original: doc(text('old')), modified: doc(text('new')), ...overrides,
  };
  store.showDiff(msg);
  if (msg.purpose === 'proposal' && msg.approvalId !== undefined) store.openProposal(msg.approvalId);
}
function openFile(overrides: Partial<OpenFile> = {}): void {
  useEditorStore().openFile({ type: 'editorOpenFile', viewId: 'f1', title: 'a.ts', document: doc(text('1\n2\n3\n4')), ...overrides });
}
function pendPermission(toolUseId: string): void {
  usePermissionStore().addPermission(toolUseId, { toolName: 'Edit', filePath: '/w/a.ts' } as Parameters<ReturnType<typeof usePermissionStore>['addPermission']>[1]);
}

beforeEach(() => {
  setActivePinia(createPinia());
  posted = [];
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as { type: string }));
  fake.state.models.length = 0;
  fake.state.editors.length = 0;
  fake.state.markerListeners.length = 0;
  fake.state.markers = [];
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('editor view overlay', () => {
  it('decides a pending proposal through the emitted toolUseId, which App routes to the inline prompt handler', async () => {
    pendPermission('tool-1');
    showDiff();
    const wrapper = mountHost();
    await nextTick();

    byTestId('editor-approve')!.click();
    byTestId('editor-reject')!.click();
    expect(wrapper.emitted('decide')).toEqual([['tool-1', true], ['tool-1', false]]);
  });

  it.each([
    ['the close button', () => byTestId('editor-overlay-close')!.click()],
    ['Escape', () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))],
  ])('closes on %s without deciding the proposal', async (_name, close) => {
    pendPermission('tool-1');
    showDiff();
    const wrapper = mountHost();
    await nextTick();

    close();
    await nextTick();

    expect(useEditorStore().view).toBeNull();
    expect(byTestId('editor-overlay')).toBeNull();
    expect(wrapper.emitted('decide')).toBeUndefined();
    expect(posted).toEqual([]);
    expect(usePermissionStore().pendingPermissions['tool-1']).toBeDefined();
  });

  it('shows no decision buttons once the prompt is answered, for a checkpoint diff, or for an unknown approval id', async () => {
    showDiff();
    mountHost();
    await nextTick();
    expect(byTestId('editor-approve')).toBeNull();
    expect(byTestId('editor-overlay')!.textContent).toContain(t('editor.proposalDecided'));

    pendPermission('tool-1');
    showDiff({ viewId: 'v2', purpose: 'checkpoint', approvalId: 'tool-1' });
    await nextTick();
    expect(byTestId('editor-overlay')!.dataset['purpose']).toBe('checkpoint');
    expect(byTestId('editor-approve')).toBeNull();
    expect(byTestId('editor-reject')).toBeNull();
  });

  it('renders a text diff with both sides, and disposes the editor before its models on close', async () => {
    showDiff({ purpose: 'checkpoint' });
    mountHost();
    await nextTick();

    expect(byTestId('editor-diff-view')!.dataset['monacoReady']).toBe('true');
    expect(fake.state.models.map((m) => [m.value, m.languageId])).toEqual([['old', 'typescript'], ['new', 'typescript']]);
    const [editor] = fake.state.editors;

    useEditorStore().closeView('v1');
    await nextTick();
    expect(editor!.dispose).toHaveBeenCalled();
    for (const model of fake.state.models) {
      expect(model.dispose).toHaveBeenCalled();
      expect(editor!.dispose.mock.invocationCallOrder[0]!).toBeLessThan(model.dispose.mock.invocationCallOrder[0]!);
    }
  });

  it('replaces the open view with a new request and disposes the old one', async () => {
    showDiff({ purpose: 'checkpoint' });
    mountHost();
    await nextTick();
    const [diffEditor] = fake.state.editors;

    openFile();
    await nextTick();
    expect(diffEditor!.dispose).toHaveBeenCalled();
    expect(byTestId('editor-overlay')!.dataset['viewKind']).toBe('file');
    expect(byTestId('editor-diff-view')).toBeNull();
  });

  it.each([
    ['tooLarge', { kind: 'tooLarge', bytes: 12 * 1024 * 1024, limitBytes: 10 * 1024 * 1024 }, 'editor-body-too-large', () => t('editor.body.tooLarge', { size: '12.0', limit: 10 })],
    ['binary', { kind: 'binary' }, 'editor-body-binary', () => t('editor.body.binary')],
    ['unreadable', { kind: 'unreadable', error: 'EACCES: permission denied' }, 'editor-body-unreadable', () => t('editor.body.unreadable', { error: 'EACCES: permission denied' })],
  ] as const)('states a %s side instead of diffing it', async (_kind, body, testId, message) => {
    showDiff({ purpose: 'checkpoint', modified: doc(body) });
    mountHost();
    await nextTick();

    const state = byTestId(testId)!;
    expect(state.dataset['side']).toBe('modified');
    expect(state.textContent).toContain(message());
    expect(byTestId('editor-diff-view')).toBeNull();
    expect(fake.state.models).toEqual([]);
  });

  it('reads the tooLarge sizes as written, in binary units', () => {
    expect(t('editor.body.tooLarge', { size: '12.0', limit: 10 })).toBe('Too large to display (12.0 MiB, limit 10 MiB)');
    expect(t('editor.body.binary')).toBe('Binary file not shown');
  });

  it('opens a file read-only at the requested line, clamped to the file, and highlights it', async () => {
    openFile({ line: 99 });
    mountHost();
    await nextTick();

    const view = byTestId('editor-file-view')!;
    expect(view.dataset['revealedLine']).toBe('4');
    expect(view.dataset['untitled']).toBeUndefined();
    const [editor] = fake.state.editors;
    expect(editor!.readOnly).toBe(true);
    expect(editor!.revealed).toBe(4);
    expect(editor!.decorations).toEqual([expect.objectContaining({ options: { isWholeLine: true, className: 'damocles-editor-highlight-line' } })]);
  });

  it('renders a file over 1 MB as text', async () => {
    const content = 'x'.repeat(1_500_000);
    openFile({ document: doc(text(content)) });
    mountHost();
    await nextTick();

    expect(byTestId('editor-file-view')!.dataset['monacoReady']).toBe('true');
    expect(fake.state.models[0]!.value).toHaveLength(1_500_000);
  });

  it('shows an untitled buffer read-only and says so', async () => {
    openFile({ untitled: true, document: { name: 'context.md', body: { kind: 'text', content: '# ctx', languageId: 'markdown' } } });
    mountHost();
    await nextTick();

    expect(byTestId('editor-file-view')!.dataset['untitled']).toBe('true');
    expect(fake.state.editors[0]!.readOnly).toBe(true);
    expect(byTestId('editor-overlay')!.textContent).toContain(t('editor.untitled'));
  });

  it('states an unreadable file instead of opening an editor', async () => {
    openFile({ document: doc({ kind: 'unreadable', error: 'EISDIR' }) });
    mountHost();
    await nextTick();

    expect(byTestId('editor-body-unreadable')!.dataset['side']).toBe('document');
    expect(fake.state.editors).toEqual([]);
  });
});

describe('settings JSON editor', () => {
  const READY = { scope: 'user', status: 'ready', path: '/h/.damocles/settings.json', exists: true, content: '{}', version: 'v1' } as const;

  async function openEditor(scope: 'user' | 'project' | 'local' = 'user'): Promise<VueWrapper> {
    useEditorStore().openSettingsEditor(scope);
    const wrapper = mountHost();
    await nextTick();
    return wrapper;
  }
  async function deliver(file: Parameters<ReturnType<typeof useEditorStore>['setSettingsFile']>[0]): Promise<void> {
    useEditorStore().setSettingsFile(file);
    await nextTick();
    await nextTick();
  }
  const saveButton = () => byTestId('settings-json-save') as HTMLButtonElement;
  const saves = () => posted.filter((m) => m.type === 'settingsFileSave');
  const loads = () => posted.filter((m) => m.type === 'settingsFileLoad');

  it('loads its file from the host and validates user and project files against their schema variants', async () => {
    await openEditor('project');
    expect(loads()).toEqual([{ type: 'settingsFileLoad', scope: 'project' }]);
    expect(byTestId('settings-json-editor')!.textContent).toContain(t('settingsEditor.loading'));

    const options = fake.state.diagnostics.mock.calls.at(-1)![0] as { allowComments: boolean; trailingCommas: string; enableSchemaRequest: boolean; schemas: { fileMatch: string[]; schema: unknown }[] };
    expect(options).toMatchObject({ allowComments: false, trailingCommas: 'error', enableSchemaRequest: false });
    expect(options.schemas.map((s) => s.fileMatch)).toEqual([
      ['inmemory://damocles/settings/user.json'],
      ['inmemory://damocles/settings/project.json', 'inmemory://damocles/settings/local.json'],
    ]);

    await deliver({ ...READY, scope: 'project', path: '/w/.damocles/settings.json' });
    expect(fake.state.models[0]!.uri!.toString()).toBe('inmemory://damocles/settings/project.json');
    expect(byTestId('settings-json-editor-monaco')!.dataset['monacoReady']).toBe('true');
  });

  it('saves the edited text against the version it loaded, and reports success', async () => {
    await openEditor();
    await deliver(READY);
    expect(saveButton().disabled).toBe(true);

    fake.state.models[0]!.setValue('{ "damocles.maxTurns": 5 }');
    await nextTick();
    expect(byTestId('settings-json-editor')!.dataset['dirty']).toBe('true');
    saveButton().click();
    expect(saves()).toEqual([{ type: 'settingsFileSave', scope: 'user', content: '{ "damocles.maxTurns": 5 }', baseVersion: 'v1' }]);

    useEditorStore().setSaveResult({ type: 'settingsFileSaveResult', scope: 'user', ok: true, version: 'v2' });
    await nextTick();
    expect(byTestId('settings-json-editor')!.dataset['dirty']).toBe('false');
    expect(byTestId('settings-json-editor')!.textContent).toContain(t('settingsEditor.saved'));

    fake.state.models[0]!.setValue('{}');
    await nextTick();
    saveButton().click();
    expect(saves().at(-1)).toMatchObject({ baseVersion: 'v2' });
  });

  it('shows a refused save inline, and a conflict with no file to compare with a reload offer', async () => {
    await openEditor();
    await deliver(READY);
    fake.state.models[0]!.setValue('{ bad');
    await nextTick();
    saveButton().click();
    useEditorStore().setSaveResult({ type: 'settingsFileSaveResult', scope: 'user', ok: false, error: 'Unexpected token b in JSON at position 2' });
    await nextTick();
    expect(byTestId('settings-json-error')!.textContent?.trim()).toBe('Unexpected token b in JSON at position 2');
    expect(byTestId('settings-json-reload-prompt')).toBeNull();

    saveButton().click();
    useEditorStore().setSaveResult({ type: 'settingsFileSaveResult', scope: 'user', ok: false, error: 'The default project changed', conflict: true });
    await nextTick();
    expect(byTestId('settings-json-error')!.textContent).toContain('The default project changed');
    expect(byTestId('settings-json-conflict')).toBeNull();
    expect(byTestId('settings-json-reload-prompt')).not.toBeNull();

    byTestId('settings-json-reload')!.click();
    expect(loads().at(-1)).toEqual({ type: 'settingsFileLoad', scope: 'user' });
    await deliver({ ...READY, content: '{ "fromDisk": 1 }', version: 'v3' });
    expect(fake.state.models[0]!.value).toBe('{ "fromDisk": 1 }');
    expect(byTestId('settings-json-editor')!.dataset['dirty']).toBe('false');
    expect(byTestId('settings-json-error')).toBeNull();
  });

  it('opens a file that does not parse read-only with the parse error, and never saves it', async () => {
    await openEditor();
    await deliver({ ...READY, content: '{ oops', parseError: 'Expected property name at position 2' });

    expect(byTestId('settings-json-parse-error')!.textContent).toContain('Expected property name at position 2');
    expect(fake.state.editors[0]!.readOnly).toBe(true);
    expect(saveButton().disabled).toBe(true);

    byTestId('settings-json-reveal')!.click();
    expect(posted.at(-1)).toEqual({ type: 'revealSettingsFile', scope: 'user' });
  });

  it('states a path the host cannot read and offers no editor', async () => {
    await openEditor('project');
    await deliver({ scope: 'project', status: 'unavailable', reason: 'unreadable', path: '/w/.damocles/settings.json', error: 'EISDIR: illegal operation on a directory, read' });

    expect(byTestId('settings-json-unavailable')!.textContent).toContain(t('settingsEditor.unreadable', { path: '/w/.damocles/settings.json', error: 'EISDIR: illegal operation on a directory, read' }));
    expect(byTestId('settings-json-unavailable')!.textContent).toContain('EISDIR');
    expect(byTestId('settings-json-editor')!.textContent).not.toContain(t('settingsEditor.loading'));
    expect(fake.state.editors).toEqual([]);
  });

  it('reloads silently on an external change while clean, and offers a reload over unsaved edits', async () => {
    await openEditor();
    await deliver(READY);
    const loadsBefore = loads().length;

    useEditorStore().noteSettingsFileChanged('user', 'v1');
    await nextTick();
    expect(loads()).toHaveLength(loadsBefore);

    useEditorStore().noteSettingsFileChanged('user', 'v2');
    await nextTick();
    expect(loads()).toHaveLength(loadsBefore + 1);
    await deliver({ ...READY, content: '{ "a": 1 }', version: 'v2' });
    expect(fake.state.models[0]!.value).toBe('{ "a": 1 }');
    expect(byTestId('settings-json-reload-prompt')).toBeNull();

    fake.state.models[0]!.setValue('{ "mine": true }');
    await nextTick();
    useEditorStore().noteSettingsFileChanged('user', 'v3');
    await nextTick();
    expect(loads()).toHaveLength(loadsBefore + 1);
    expect(byTestId('settings-json-reload-prompt')).not.toBeNull();
    expect(fake.state.models[0]!.value).toBe('{ "mine": true }');
  });

  it('holds a change notice that arrives during its own save until the result names the new version', async () => {
    await openEditor();
    await deliver(READY);
    fake.state.models[0]!.setValue('{ "a": 2 }');
    await nextTick();
    saveButton().click();

    useEditorStore().noteSettingsFileChanged('user', 'v2');
    await nextTick();
    useEditorStore().setSaveResult({ type: 'settingsFileSaveResult', scope: 'user', ok: true, version: 'v2' });
    await nextTick();

    expect(byTestId('settings-json-reload-prompt')).toBeNull();
    expect(loads()).toHaveLength(1);
  });

  it('states why a project file is unavailable', async () => {
    await openEditor('local');
    await deliver({ scope: 'local', status: 'unavailable', reason: 'untrusted' });

    expect(byTestId('settings-json-editor')!.textContent).toContain(t('settings.jsonFiles.untrusted'));
    expect(fake.state.editors).toEqual([]);
  });

  it('lists the diagnostics Monaco reports for its model', async () => {
    await openEditor('project');
    await deliver({ ...READY, scope: 'project', path: '/w/.damocles/settings.json' });
    fake.state.markers = [{ startLineNumber: 2, message: 'Property damocles.bogus is not allowed.' }];
    for (const listener of fake.state.markerListeners) listener([{ toString: () => 'inmemory://damocles/settings/project.json' }]);
    await nextTick();

    expect(byTestId('settings-json-editor-monaco')!.dataset['markerCount']).toBe('1');
    expect(byTestId('settings-json-diagnostics')!.textContent).toContain('Property damocles.bogus is not allowed.');
  });

  it('asks before discarding unsaved edits on close', async () => {
    await openEditor();
    await deliver(READY);
    fake.state.models[0]!.setValue('{ "x": 1 }');
    await nextTick();

    byTestId('settings-json-close')!.click();
    await nextTick();
    expect(useEditorStore().settingsEditorScope).toBe('user');
    expect(document.body.textContent).toContain(t('settingsEditor.discardPrompt'));

    const discard = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === t('settingsEditor.discard'))!;
    discard.click();
    await nextTick();
    expect(useEditorStore().settingsEditorScope).toBeNull();
    const [editor] = fake.state.editors;
    const [model] = fake.state.models;
    expect(editor!.dispose.mock.invocationCallOrder[0]!).toBeLessThan(model!.dispose.mock.invocationCallOrder[0]!);
  });

  it('saves with Ctrl+S', async () => {
    await openEditor();
    await deliver(READY);
    fake.state.models[0]!.setValue('{ "x": 1 }');
    await nextTick();

    for (const command of fake.state.editors[0]!.commands) command();

    expect(saves()).toEqual([{ type: 'settingsFileSave', scope: 'user', content: '{ "x": 1 }', baseVersion: 'v1' }]);
  });

  describe('when a settings file is asked for while it is open', () => {
    async function dirtyUserEditor(): Promise<void> {
      await openEditor('user');
      await deliver(READY);
      fake.state.models[0]!.setValue('{ "mine": true }');
      await nextTick();
    }

    it('keeps the open editor and its edits for the same file', async () => {
      await dirtyUserEditor();
      const loadsBefore = loads().length;

      useEditorStore().openSettingsEditor('user');
      await nextTick();

      expect(fake.state.models[0]!.value).toBe('{ "mine": true }');
      expect(fake.state.models[0]!.dispose).not.toHaveBeenCalled();
      expect(byTestId('settings-json-editor')!.textContent).not.toContain(t('settingsEditor.loading'));
      expect(byTestId('settings-json-discard-prompt')).toBeNull();
      expect(saveButton().disabled).toBe(false);
      expect(loads()).toHaveLength(loadsBefore);
    });

    it('asks before another file replaces unsaved edits, and keeps them when the user says so', async () => {
      await dirtyUserEditor();

      useEditorStore().openSettingsEditor('project');
      await nextTick();
      expect(byTestId('settings-json-discard-prompt')!.textContent).toContain(t('settingsEditor.switchPrompt', { file: t('settingsEditor.title.project') }));
      expect(byTestId('settings-json-editor')!.dataset['scope']).toBe('user');

      byTestId('settings-json-keep-editing')!.click();
      await nextTick();
      expect(byTestId('settings-json-discard-prompt')).toBeNull();
      expect(useEditorStore().requestedSettingsScope).toBeNull();
      expect(fake.state.models[0]!.value).toBe('{ "mine": true }');

      useEditorStore().openSettingsEditor('project');
      await nextTick();
      byTestId('settings-json-discard')!.click();
      await nextTick();
      expect(byTestId('settings-json-editor')!.dataset['scope']).toBe('project');
      expect(loads().at(-1)).toEqual({ type: 'settingsFileLoad', scope: 'project' });
    });

    it('switches straight to another file when nothing would be lost', async () => {
      await openEditor('user');
      await deliver(READY);

      useEditorStore().openSettingsEditor('local');
      await nextTick();

      expect(byTestId('settings-json-discard-prompt')).toBeNull();
      expect(byTestId('settings-json-editor')!.dataset['scope']).toBe('local');
    });
  });

  describe('after a save conflicts with a newer file on disk', () => {
    const ON_DISK = { exists: true, content: '{ "theirs": 1 }', version: 'v9' };

    async function conflicted(): Promise<void> {
      await openEditor();
      await deliver(READY);
      fake.state.models[0]!.setValue('{ "mine": true }');
      await nextTick();
      useEditorStore().noteSettingsFileChanged('user', 'v9');
      await nextTick();
      expect(byTestId('settings-json-reload-prompt')).not.toBeNull();
      saveButton().click();
      useEditorStore().setSaveResult({ type: 'settingsFileSaveResult', scope: 'user', ok: false, error: 'changed', conflict: true, onDisk: ON_DISK });
      await nextTick();
    }

    it('offers Compare and Overwrite and keeps the user text', async () => {
      await conflicted();

      expect(byTestId('settings-json-conflict')!.textContent).toContain(t('settingsEditor.conflict'));
      expect(byTestId('settings-json-compare')).not.toBeNull();
      expect(byTestId('settings-json-overwrite')).not.toBeNull();
      expect(byTestId('settings-json-reload-prompt')).toBeNull();
      expect(fake.state.models[0]!.value).toBe('{ "mine": true }');
    });

    it('compares the newer file with the user text in an editable diff and saves the merge over the newer version', async () => {
      await conflicted();

      byTestId('settings-json-compare')!.click();
      await nextTick();

      expect(byTestId('settings-json-editor')!.dataset['comparing']).toBe('true');
      const diff = fake.state.editors[1]!;
      const [userModel, diskModel] = fake.state.models;
      expect(diff.readOnly).toBe(false);
      expect(diff.model).toEqual({ original: diskModel, modified: userModel });
      expect(diskModel!.value).toBe('{ "theirs": 1 }');
      expect(byTestId('settings-json-conflict')).toBeNull();

      userModel!.setValue('{ "theirs": 1, "mine": true }');
      await nextTick();
      for (const command of diff.commands) command();
      expect(saves().at(-1)).toEqual({ type: 'settingsFileSave', scope: 'user', content: '{ "theirs": 1, "mine": true }', baseVersion: 'v9' });

      useEditorStore().setSaveResult({ type: 'settingsFileSaveResult', scope: 'user', ok: true, version: 'v10' });
      await nextTick();
      expect(byTestId('settings-json-editor')!.dataset['comparing']).toBe('false');
      expect(byTestId('settings-json-editor')!.dataset['dirty']).toBe('false');
      expect(diff.dispose.mock.invocationCallOrder[0]!).toBeLessThan(diskModel!.dispose.mock.invocationCallOrder[0]!);
      expect(userModel!.dispose).not.toHaveBeenCalled();
    });

    it('overwrites the newer file with the user text only after the user confirms', async () => {
      await conflicted();
      const savesBefore = saves().length;

      byTestId('settings-json-overwrite')!.click();
      await nextTick();
      expect(byTestId('settings-json-overwrite-confirm')).not.toBeNull();
      byTestId('settings-json-overwrite-cancel')!.click();
      await nextTick();
      expect(byTestId('settings-json-overwrite-confirm')).toBeNull();
      expect(saves()).toHaveLength(savesBefore);
      expect(byTestId('settings-json-conflict')).not.toBeNull();

      byTestId('settings-json-overwrite')!.click();
      await nextTick();
      byTestId('settings-json-overwrite-confirm-button')!.click();
      await nextTick();

      expect(saves().at(-1)).toEqual({ type: 'settingsFileSave', scope: 'user', content: '{ "mine": true }', baseVersion: 'v9' });
      expect(byTestId('settings-json-overwrite-confirm')).toBeNull();
    });

    it('names the whole path of the file it overwrites in text, not only in a tooltip', async () => {
      useSettingsStore().setWorkspaceFolders([{ key: '/h', name: 'h', label: 'h', path: '/h' }], '/h', '/h');
      await conflicted();
      byTestId('settings-json-overwrite')!.click();
      await nextTick();

      expect(byTestId('settings-json-overwrite-path')!.textContent).toBe(READY.path);
    });

    it('closes the overwrite confirmation on Escape and leaves the editor open', async () => {
      await conflicted();
      byTestId('settings-json-overwrite')!.click();
      await nextTick();

      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await nextTick();

      expect(byTestId('settings-json-overwrite-confirm')).toBeNull();
      expect(useEditorStore().settingsEditorScope).toBe('user');
    });
  });
});
