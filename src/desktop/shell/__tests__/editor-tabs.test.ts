// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ScmDecorations } from '../../preload/scm-channels';
import type { ShellEditorTab, ShellProject } from '../../preload/shell-channels';
import ConflictBar from '../editor/ConflictBar.vue';
import EditorTabs from '../editor/EditorTabs.vue';
import { tabFileName } from '../editor/editor-place';
import { createEditorStore, EDITOR_STORE } from '../editor/editor-store';
import { createScmStore, SCM_STORE } from '../scm/scm-store';
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

async function mountTabs(tabs: ShellEditorTab[], decorations: ScmDecorations['files'] = {}, projects: readonly ShellProject[] = []): Promise<VueWrapper> {
  const api = fakeShellApi([], { getEditorState: vi.fn(async () => ({ ...EDITOR_STATE, tabs, activeTabId: tabs[0]!.id })) });
  const store = createEditorStore(api);
  await store.start();
  const scm = createScmStore(api.scm);
  await scm.start();
  api.scm.pushDecorations({ projectKey: 'home', files: decorations });
  const wrapper = mount(EditorTabs, { props: { api, closeShortcut: 'Ctrl+W', projects }, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store, [SCM_STORE]: scm } }, attachTo: document.body });
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

describe('a remote file saved while its host is away', () => {
  const remote = (name: string): ShellProject => ({ key: 'ssh+h1|/srv/app', name: 'app', authority: { name } } as unknown as ShellProject);
  const pending = codeTab('p', 'notes.md', { projectKey: 'ssh+h1|/srv/app', relativePath: 'notes.md', pendingUpload: true });
  const uploadedTab = codeTab('p', 'notes.md', { projectKey: 'ssh+h1|/srv/app', relativePath: 'notes.md' });

  it('shows the cloud-off glyph, not the unsaved dot, saying where the save is and naming the host as ShellState names it now', async () => {
    const wrapper = await mountTabs([pending], {}, [remote('prod-1')]);
    const glyph = wrapper.get('[data-testid="editor-tab-pending-upload"]');
    expect(glyph.attributes('title')).toBe('Saved on this computer. Uploads when prod-1 reconnects.');
    expect(glyph.text()).toBe('Saved on this computer. Uploads when prod-1 reconnects.');
    expect(wrapper.get('[data-testid="editor-tab"]').attributes('data-dirty')).toBeUndefined();
    await wrapper.setProps({ projects: [remote('billing-prod')] });
    expect(wrapper.get('[data-testid="editor-tab-pending-upload"]').attributes('title')).toBe('Saved on this computer. Uploads when billing-prod reconnects.');
  });

  it('shows the uploaded glyph once the save uploads, and leaves no timer behind when the tabs unmount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const api = fakeShellApi([], { getEditorState: vi.fn(async () => ({ ...EDITOR_STATE, tabs: [pending], activeTabId: pending.id })) });
      const store = createEditorStore(api);
      await store.start();
      const scm = createScmStore(api.scm);
      await scm.start();
      const wrapper = mount(EditorTabs, { props: { api, closeShortcut: 'Ctrl+W', projects: [remote('prod-1')] }, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store, [SCM_STORE]: scm } }, attachTo: document.body });
      await flushPromises();
      api.pushEditorState({ ...EDITOR_STATE, tabs: [uploadedTab], activeTabId: pending.id });
      api.pushEditorState({ ...EDITOR_STATE, tabs: [pending], activeTabId: pending.id });
      await flushPromises();
      const before = vi.getTimerCount();
      api.pushEditorState({ ...EDITOR_STATE, tabs: [uploadedTab], activeTabId: pending.id });
      await flushPromises();
      expect(wrapper.find('[data-testid="editor-tab-uploaded"]').exists()).toBe(true);
      expect(vi.getTimerCount()).toBe(before + 1);
      wrapper.unmount();
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the uploaded glyph for a tab that was already pending when the tabs mounted', async () => {
    const api = fakeShellApi([], { getEditorState: vi.fn(async () => ({ ...EDITOR_STATE, tabs: [pending], activeTabId: pending.id })) });
    const store = createEditorStore(api);
    await store.start();
    const scm = createScmStore(api.scm);
    await scm.start();
    const wrapper = mount(EditorTabs, { props: { api, closeShortcut: 'Ctrl+W', projects: [remote('prod-1')] }, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store, [SCM_STORE]: scm } }, attachTo: document.body });
    await flushPromises();
    api.pushEditorState({ ...EDITOR_STATE, tabs: [uploadedTab], activeTabId: pending.id });
    await flushPromises();
    expect(wrapper.get('[data-testid="editor-tab-uploaded"]').attributes('title')).toBe('Uploaded to prod-1.');
    wrapper.unmount();
  });

  it('says it in Greek', async () => {
    shellI18n.global.locale.value = 'el';
    const wrapper = await mountTabs([pending], {}, [remote('prod-1')]);
    expect(wrapper.get('[data-testid="editor-tab-pending-upload"]').attributes('title')).toBe('Αποθηκεύτηκε σε αυτόν τον υπολογιστή. Θα ανέβει όταν επανασυνδεθεί το prod-1.');
  });
});

describe('a tab whose path holds a control or bidi character', () => {
  it('shows the path in its tooltip and the conflict bar\'s name with the character escaped', async () => {
    const wrapper = await mountTabs([codeTab('a', 'a\\u{202E}b.ts', { displayPath: 'C:\\work\\src\\a\u202Eb.ts' })]);
    expect(wrapper.get('[data-editor-tab]').attributes('title')).toBe('C:\\work\\src\\a\\u{202E}b.ts');
    expect(tabFileName({ displayPath: 'C:\\work\\src\\a\u202Eb.ts', title: 'x' })).toBe('a\\u{202E}b.ts');
    expect(tabFileName({ displayPath: '', title: 'Untitled-1' })).toBe('Untitled-1');
  });
});

describe("a tab's source control letter", () => {
  it('is hidden from screen readers, which hear the status in words instead', async () => {
    const wrapper = await mountTabs([codeTab('a', 'app.ts')], { 'src/app.ts': { letter: 'M', tone: 'modified', staged: false, strike: false, status: 'MODIFIED' } });
    const tab = wrapper.get('[data-editor-tab]');
    expect(tab.get('[data-testid="editor-tab-decoration"]').attributes('aria-hidden')).toBe('true');
    expect(tab.findAll('.sr-only').map((hint) => hint.text())).toEqual(['Modified']);
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
    const compare: ShellEditorTab = { id: 'c', kind: 'diff', diff: { originalId: 'disk', modifiedId: 'd-a', conflictCompare: true }, title: 'app.ts (On disk ↔ Yours)', displayPath: 'C:\\work\\app.ts', dirty: true, readOnly: false, conflict: true };
    await store.resolveConflict(compare, 'revert');
    await store.resolveConflict(codeTab('a', 'app.ts', { conflict: true }), 'overwrite');
    expect(vi.mocked(api.resolveConflict).mock.calls).toEqual([[{ documentId: 'd-a', action: 'revert' }], [{ documentId: 'd-a', action: 'overwrite' }]]);
  });
});
