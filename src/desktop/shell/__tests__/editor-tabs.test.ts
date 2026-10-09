// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ShellEditorTab } from '../../preload/shell-channels';
import ConflictBar from '../editor/ConflictBar.vue';
import EditorTabs from '../editor/EditorTabs.vue';
import { createEditorStore, EDITOR_STORE } from '../editor/editor-store';
import { shellI18n } from '../i18n';
import { EDITOR_STATE, FakeResizeObserver, fakeShellApi } from './fakes';

const mounted: VueWrapper[] = [];

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

function codeTab(id: string, title: string, extra: Partial<ShellEditorTab> = {}): ShellEditorTab {
  return { id, kind: 'code', documentId: `d-${id}`, title, projectKey: 'home', relativePath: `src/${title}`, displayPath: `C:\\work\\src\\${title}`, dirty: false, readOnly: false, conflict: false, ...extra };
}

async function mountTabs(tabs: ShellEditorTab[]): Promise<VueWrapper> {
  const api = fakeShellApi([], { getEditorState: vi.fn(async () => ({ ...EDITOR_STATE, tabs, activeTabId: tabs[0]!.id })) });
  const store = createEditorStore(api);
  await store.start();
  const wrapper = mount(EditorTabs, { props: { api, closeShortcut: 'Ctrl+W' }, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store } }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

describe('a deleted file\'s tab', () => {
  it('strikes its name through in the danger color, says Deleted under its path and in its name, and is not dirty', async () => {
    const wrapper = await mountTabs([codeTab('a', 'gone.ts', { deleted: true }), codeTab('b', 'kept.ts')]);
    const [gone, kept] = wrapper.findAll('[data-editor-tab]');
    expect(gone!.get('[data-testid="editor-tab-title"]').classes()).toEqual(expect.arrayContaining(['line-through', 'text-(--d-danger-text)']));
    expect(gone!.attributes('title')).toBe('C:\\work\\src\\gone.ts\nDeleted');
    expect(gone!.attributes('data-deleted')).toBe('true');
    expect(gone!.attributes('data-dirty')).toBeUndefined();
    expect(gone!.find('.sr-only').text()).toBe('Deleted');
    expect(kept!.get('[data-testid="editor-tab-title"]').classes()).not.toContain('line-through');
    expect(kept!.attributes('title')).toBe('C:\\work\\src\\kept.ts');
  });

  it('says Deleted in Greek', async () => {
    shellI18n.global.locale.value = 'el';
    const wrapper = await mountTabs([codeTab('a', 'gone.ts', { deleted: true })]);
    expect(wrapper.get('[data-editor-tab]').attributes('title')).toBe('C:\\work\\src\\gone.ts\nΔιαγράφηκε');
  });
});

describe('a tab whose file changed on disk under unsaved edits', () => {
  it('says Changed on disk under its path and in its name, beside its colour', async () => {
    const wrapper = await mountTabs([codeTab('a', 'app.ts', { conflict: true, dirty: true }), codeTab('b', 'kept.ts')]);
    const [conflicted, kept] = wrapper.findAll('[data-editor-tab]');
    expect(conflicted!.get('[data-testid="editor-tab-title"]').classes()).toContain('text-(--d-warning-text)');
    expect(conflicted!.attributes('title')).toBe('C:\\work\\src\\app.ts\nChanged on disk');
    expect(conflicted!.findAll('.sr-only').map((hint) => hint.text())).toEqual(['Changed on disk', 'unsaved changes']);
    expect(kept!.find('.sr-only').exists()).toBe(false);
  });

  it('says Changed on disk in Greek', async () => {
    shellI18n.global.locale.value = 'el';
    const wrapper = await mountTabs([codeTab('a', 'app.ts', { conflict: true })]);
    expect(wrapper.get('[data-editor-tab]').attributes('title')).toBe('C:\\work\\src\\app.ts\nΆλλαξε στον δίσκο');
  });

  it('keeps its close control out of the accessibility tree, with no name of its own', async () => {
    const wrapper = await mountTabs([codeTab('a', 'app.ts')]);
    const close = wrapper.get('[data-testid="editor-tab-close"]');
    expect([close.attributes('aria-hidden'), close.attributes('aria-label')]).toEqual(['true', undefined]);
  });
});

describe('the conflict bar', () => {
  const bar = (compare: boolean) => {
    const wrapper = mount(ConflictBar, { props: { name: 'app.ts', compare, busy: false }, global: { plugins: [shellI18n] } });
    mounted.push(wrapper);
    return wrapper;
  };

  it('names the file and offers Compare, Revert and Overwrite on the file\'s tab', () => {
    const wrapper = bar(false);
    expect(wrapper.text()).toContain('app.ts changed on disk. Your unsaved edits');
    expect(wrapper.findAll('button').map((button) => button.attributes('data-testid'))).toEqual(['conflict-compare', 'conflict-revert', 'conflict-overwrite']);
  });

  it('offers only Revert and Overwrite on the Compare tab, still naming the file', () => {
    const wrapper = bar(true);
    expect(wrapper.text()).toContain('app.ts changed on disk.');
    expect(wrapper.findAll('button').map((button) => button.attributes('data-testid'))).toEqual(['conflict-revert', 'conflict-overwrite']);
  });

  it('resolves a Compare tab\'s conflict on the document of its modified side', async () => {
    const api = fakeShellApi();
    const store = createEditorStore(api);
    const compare: ShellEditorTab = { id: 'c', kind: 'diff', diff: { originalId: 'disk', modifiedId: 'd-a', added: 1, removed: 1, conflictCompare: true }, title: 'app.ts (On disk ↔ Yours)', displayPath: 'C:\\work\\app.ts', dirty: true, readOnly: false, conflict: true };
    await store.resolveConflict(compare, 'revert');
    await store.resolveConflict(codeTab('a', 'app.ts', { conflict: true }), 'overwrite');
    expect(vi.mocked(api.resolveConflict).mock.calls).toEqual([[{ documentId: 'd-a', action: 'revert' }], [{ documentId: 'd-a', action: 'overwrite' }]]);
  });
});
