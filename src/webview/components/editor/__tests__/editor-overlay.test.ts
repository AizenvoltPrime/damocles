// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { i18n } from '@/i18n';
import { useEditorStore } from '@/stores/useEditorStore';
import { usePermissionStore } from '@/stores/usePermissionStore';
import type { EditorDocument, EditorDocumentBody, ExtensionToWebviewMessage } from '@shared/types/messages';
import EditorOverlayHost from '../EditorOverlayHost.vue';

// Monaco needs a real layout engine and workers, so the lazy module is replaced by a recorder of what the diff view asks of it.
const fake = vi.hoisted(() => {
  class FakeModel {
    readonly dispose = vi.fn();
    readonly value: string;
    readonly languageId: string;
    constructor(value: string, languageId: string) {
      this.value = value;
      this.languageId = languageId;
    }
  }
  class FakeDiffEditor {
    readonly dispose = vi.fn();
    setModel(): void {}
  }
  const state = { models: [] as FakeModel[], editors: [] as FakeDiffEditor[] };
  const monaco = {
    editor: {
      createModel: (value: string, languageId: string) => {
        const model = new FakeModel(value, languageId);
        state.models.push(model);
        return model;
      },
      createDiffEditor: () => {
        const editor = new FakeDiffEditor();
        state.editors.push(editor);
        return editor;
      },
    },
  };
  return { state, monaco };
});

vi.mock('../useMonaco', () => ({
  useMonaco: () => fake.monaco,
  baseEditorOptions: () => ({ readOnly: true }),
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

// A proposal is held until its card's Open diff asks for it, which openProposal stands in for.
function showDiff(overrides: Partial<ShowDiff> = {}): void {
  const store = useEditorStore();
  const msg: ShowDiff = {
    type: 'editorShowDiff', viewId: 'v1', title: 'a.ts', purpose: 'proposal', approvalId: 'tool-1',
    original: doc(text('old')), modified: doc(text('new')), ...overrides,
  };
  store.showDiff(msg);
  store.openProposal(msg.approvalId);
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

  it('hides the decision buttons once the prompt is answered', async () => {
    pendPermission('tool-1');
    showDiff();
    mountHost();
    await nextTick();
    expect(byTestId('editor-approve')).not.toBeNull();

    usePermissionStore().removePermission('tool-1');
    await nextTick();
    expect(byTestId('editor-approve')).toBeNull();
    expect(byTestId('editor-reject')).toBeNull();
    expect(byTestId('editor-overlay')!.textContent).toContain(t('editor.proposalDecided'));
  });

  it('shows no decision buttons for an approval id that is not pending', async () => {
    showDiff();
    mountHost();
    await nextTick();
    expect(byTestId('editor-approve')).toBeNull();
    expect(byTestId('editor-reject')).toBeNull();
    expect(byTestId('editor-overlay')!.textContent).toContain(t('editor.proposalDecided'));
  });

  it('renders a text diff with both sides, and disposes the editor before its models on close', async () => {
    showDiff();
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

  it("replaces the open view with another card's proposal and disposes the old one", async () => {
    showDiff();
    mountHost();
    await nextTick();
    const [diffEditor] = fake.state.editors;

    showDiff({ viewId: 'v2', approvalId: 'tool-2' });
    await nextTick();
    expect(diffEditor!.dispose).toHaveBeenCalled();
    expect(byTestId('editor-overlay')!.dataset['viewId']).toBe('v2');
  });

  it.each([
    ['tooLarge', { kind: 'tooLarge', bytes: 12 * 1024 * 1024, limitBytes: 10 * 1024 * 1024 }, 'editor-body-too-large', () => t('editor.body.tooLarge', { size: '12.0', limit: 10 })],
    ['binary', { kind: 'binary' }, 'editor-body-binary', () => t('editor.body.binary')],
    ['unreadable', { kind: 'unreadable', error: 'EACCES: permission denied' }, 'editor-body-unreadable', () => t('editor.body.unreadable', { error: 'EACCES: permission denied' })],
  ] as const)('states a %s side instead of diffing it', async (_kind, body, testId, message) => {
    showDiff({ modified: doc(body) });
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
});
