// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ScmDecorations } from '../../preload/scm-channels';
import type { ShellEditorTab, ShellHost, ShellProject } from '../../preload/shell-channels';
import ConflictBar from '../editor/ConflictBar.vue';
import EditorTabs from '../editor/EditorTabs.vue';
import EditorPane from '../editor/EditorPane.vue';
import { tabFileName } from '../editor/editor-place';
import { createEditorStore, EDITOR_STORE } from '../editor/editor-store';
import { createScmStore, SCM_STORE } from '../scm/scm-store';
import { createTerminalStore, TERMINAL_STORE } from '../terminal/terminal-store';
import { endTerminalDrag, startTerminalDrag, TERMINAL_DRAG_MIME } from '../terminal/terminal-drag';
import type { TerminalInfo } from '../../preload/terminal-channels';
import { shellI18n } from '../i18n';
import { EDITOR_STATE, FakeResizeObserver, fakeShellApi, STATE, TERMINAL_STATE } from './fakes';

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
  const wrapper = mount(EditorTabs, { props: { api, closeShortcut: 'Ctrl+W', projects, hosts: [] }, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store, [SCM_STORE]: scm, [TERMINAL_STORE as symbol]: createTerminalStore(api) } }, attachTo: document.body });
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

describe('same-named tabs', () => {
  it('title each tab by its file name, tell same-named ones apart with a dimmed description, and name another host in the tooltip', async () => {
    const remoteLog: ShellEditorTab = { id: 'r', kind: 'code', documentId: 'd-r', title: 'x.jsonl', host: 'ssh+h1', displayPath: '/home/me/.damocles/x.jsonl', dirty: false, readOnly: false, conflict: false };
    const localLog: ShellEditorTab = { id: 'l', kind: 'code', documentId: 'd-l', title: 'x.jsonl', displayPath: 'C:\\Users\\me\\x.jsonl', dirty: false, readOnly: false, conflict: false };
    const wrapper = await mountTabs([remoteLog, localLog, codeTab('o', 'other.ts')]);
    await wrapper.setProps({ hosts: [{ authorityKey: 'ssh+h1', name: 'prod-1' } as unknown as ShellHost] });
    const [remote, local, other] = wrapper.findAll('[data-editor-tab]');
    expect(remote!.get('[data-testid="editor-tab-title"]').text()).toBe('x.jsonl');
    expect(remote!.get('[data-testid="editor-tab-description"]').text()).toBe('prod-1');
    expect(remote!.attributes('title')).toBe('prod-1: /home/me/.damocles/x.jsonl');
    expect(local!.get('[data-testid="editor-tab-description"]').text()).toBe('This computer');
    expect(local!.attributes('title')).toBe('C:\\Users\\me\\x.jsonl');
    expect(other!.find('[data-testid="editor-tab-description"]').exists()).toBe(false);
  });
});

describe('a remote file saved while its host is away', () => {
  const remote = (name: string): ShellProject => ({ key: 'ssh+h1|/srv/app', name: 'app', authority: { key: 'ssh+h1', name } } as unknown as ShellProject);
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
      const wrapper = mount(EditorTabs, { props: { api, closeShortcut: 'Ctrl+W', projects: [remote('prod-1')], hosts: [] }, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store, [SCM_STORE]: scm, [TERMINAL_STORE as symbol]: createTerminalStore(api) } }, attachTo: document.body });
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
    const wrapper = mount(EditorTabs, { props: { api, closeShortcut: 'Ctrl+W', projects: [remote('prod-1')], hosts: [] }, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store, [SCM_STORE]: scm, [TERMINAL_STORE as symbol]: createTerminalStore(api) } }, attachTo: document.body });
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

describe('a design preview tab', () => {
  const designTab: ShellEditorTab = {
    id: 'dp1', kind: 'designPreview', title: 'S1 · Contacts', displayPath: '/home/u/.damocles/designs/c-1a2b/screens/S1-contacts.html', dirty: false, readOnly: false, conflict: false,
    designPreview: {
      designId: 'c-1a2b', relPath: 'screens/S1-contacts.html', path: '/home/u/.damocles/designs/c-1a2b/screens/S1-contacts.html', status: 'ready', width: 1280, state: 'default', provenance: false, canGoBack: false, canGoForward: false,
      info: { breakpoints: [{ name: 'xl', width: 1280 }], primary: 1280, checked: [], journey: [], states: [], tweaks: null },
    },
  };

  async function mountDesignTab(itemId?: string) {
    const api = fakeShellApi([], {
      getEditorState: vi.fn(async () => ({ ...EDITOR_STATE, tabs: [designTab], activeTabId: designTab.id })),
      requestOverlay: vi.fn(async () => (itemId ? { kind: 'menu' as const, itemId } : { kind: 'dismissed' as const })),
    });
    const store = createEditorStore(api);
    await store.start();
    const scm = createScmStore(api.scm);
    await scm.start();
    const wrapper = mount(EditorTabs, { props: { api, closeShortcut: 'Ctrl+W', projects: [], hosts: [] }, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store, [SCM_STORE]: scm, [TERMINAL_STORE as symbol]: createTerminalStore(api) } }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    return { wrapper, api };
  }

  it('shows the monitor icon in the design hue and the screen title, and drags no file', async () => {
    const { wrapper } = await mountDesignTab();
    const tab = wrapper.get('[data-testid="editor-tab"]');
    expect(tab.attributes('data-kind')).toBe('designPreview');
    expect(tab.get('[data-testid="editor-tab-title"]').text()).toBe('S1 · Contacts');
    const icon = tab.get('svg');
    expect(icon.classes().join(' ')).toContain('monitor');
    expect(icon.attributes('style')).toContain('var(--d-design)');
    expect(tab.attributes('draggable')).toBe('false');
  });

  it('offers Open in browser, Expand, Mention and Copy path in its menu, and sends Open in browser as the user\'s click', async () => {
    const { wrapper, api } = await mountDesignTab('openInBrowser');
    await wrapper.get('[data-testid="editor-tab"]').trigger('contextmenu', { clientX: 10, clientY: 10 });
    await flushPromises();

    const request = vi.mocked(api.requestOverlay).mock.calls[0]![0];
    if (request.kind !== 'menu') throw new Error('not a menu');
    expect(request.items.filter((item) => item.kind === 'item').map((item) => ('id' in item ? item.id : undefined))).toEqual(['close', 'closeOthers', 'closeRight', 'closeAll', 'openInBrowser', 'focusOverlay', 'mention', 'copyPath']);
    expect(api.designPreviewAction).toHaveBeenCalledWith({ tabId: 'dp1', action: 'openInBrowser' });
  });

  it('copies its path through main', async () => {
    const { wrapper, api } = await mountDesignTab('copyPath');
    await wrapper.get('[data-testid="editor-tab"]').trigger('contextmenu', { clientX: 10, clientY: 10 });
    await flushPromises();
    expect(api.editorTab).toHaveBeenCalledWith({ action: 'copyPath', tabId: 'dp1' });
  });
});

describe('HTML previews', () => {
  const previewTab: ShellEditorTab = {
    id: 'html:home/site/index.html', kind: 'htmlPreview', title: 'Preview index.html', projectKey: 'home', relativePath: 'site/index.html', displayPath: 'C:\\work\\site\\index.html',
    dirty: false, readOnly: false, conflict: false, htmlPreview: { status: 'ready', trusted: true },
  };

  async function menuFor(tab: ShellEditorTab, itemId?: string) {
    const api = fakeShellApi([], {
      getEditorState: vi.fn(async () => ({ ...EDITOR_STATE, tabs: [tab], activeTabId: tab.id })),
      requestOverlay: vi.fn(async () => (itemId ? { kind: 'menu' as const, itemId } : { kind: 'dismissed' as const })),
    });
    const store = createEditorStore(api);
    await store.start();
    const scm = createScmStore(api.scm);
    await scm.start();
    const wrapper = mount(EditorTabs, { props: { api, closeShortcut: 'Ctrl+W', projects: [], hosts: [] }, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store, [SCM_STORE]: scm, [TERMINAL_STORE as symbol]: createTerminalStore(api) } }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    await wrapper.get('[data-testid="editor-tab"]').trigger('contextmenu', { clientX: 10, clientY: 10 });
    await flushPromises();
    const request = vi.mocked(api.requestOverlay).mock.calls[0]![0];
    if (request.kind !== 'menu') throw new Error('not a menu');
    const items = request.items.flatMap((item) => (item.kind === 'item' ? [item] : []));
    return { wrapper, api, ids: items.map((item) => item.id), labels: items.map((item) => item.label) };
  }

  it('gives an HTML code tab of a project Open preview, which opens its preview tab', async () => {
    for (const title of ['index.html', 'PAGE.HTM']) {
      const { ids, labels, api } = await menuFor(codeTab(title, title), 'openPreview');
      expect(ids.slice(4, 5), title).toEqual(['openPreview']);
      expect(labels[4]).toBe('Open preview');
      expect(api.editorTab).toHaveBeenCalledWith({ action: 'openPreview', tabId: title });
    }
    expect((await menuFor(codeTab('a.ts', 'a.ts'))).ids).not.toContain('openPreview');
    // a file outside every project has no project folder to serve
    const loose: ShellEditorTab = { id: 'loose', kind: 'code', documentId: 'd-loose', title: 'loose.html', displayPath: 'C:\\elsewhere\\loose.html', dirty: false, readOnly: false, conflict: false };
    expect((await menuFor(loose)).ids).not.toContain('openPreview');
    // a design's screen outside every project previews in its design chat, which main decides
    const screen: ShellEditorTab = { ...loose, id: 'screen', title: 'S2-home.html', displayPath: '/home/a/.damocles/designs/d/screens/S2-home.html', designScreen: true };
    const { ids, api } = await menuFor(screen, 'openPreview');
    expect(ids).toContain('openPreview');
    expect(api.editorTab).toHaveBeenCalledWith({ action: 'openPreview', tabId: 'screen' });
  });

  it('offers Open preview only for a file the preview would serve: none inside a dot folder but .well-known', async () => {
    const at = (relativePath: string) => codeTab(relativePath, 'index.html', { relativePath });
    expect((await menuFor(at('docs/.vitepress/dist/index.html'))).ids).not.toContain('openPreview');
    expect((await menuFor(at('.github/index.html'))).ids).not.toContain('openPreview');
    expect((await menuFor(at('.well-known/index.html'))).ids).toContain('openPreview');
  });

  it('shows the preview tab with its window icon and main\'s title', async () => {
    const { wrapper } = await menuFor(previewTab);
    const tab = wrapper.get('[data-testid="editor-tab"]');
    expect(tab.attributes('data-kind')).toBe('htmlPreview');
    expect(tab.get('[data-testid="editor-tab-title"]').text()).toBe('Preview index.html');
    const icon = tab.get('svg');
    expect(icon.classes().join(' ')).toContain('app-window');
    expect(icon.attributes('style')).toContain('var(--d-accent)');
  });

  it('offers Reload, Open in browser, Open source, Expand, Mention, Copy path, Reveal in Files and Reveal in File Explorer on the preview tab', async () => {
    const { ids } = await menuFor({ ...previewTab, revealable: true });
    expect(ids).toEqual(['close', 'closeOthers', 'closeRight', 'closeAll', 'reloadPreview', 'openInBrowser', 'openSource', 'focusOverlay', 'mention', 'copyPath', 'revealInFiles', 'revealInExplorer']);
    // main publishes no revealable for a preview it cannot reveal
    expect((await menuFor(previewTab)).ids).not.toContain('revealInExplorer');
  });

  it('mentions the previewed file, reveals it in the file explorer and opens the focus overlay, as a code tab does', async () => {
    const revealable: ShellEditorTab = { ...previewTab, revealable: true };
    const mention = await menuFor(revealable, 'mention');
    expect(mention.api.mentionTab).toHaveBeenCalledWith(revealable.id);
    const reveal = await menuFor(revealable, 'revealInExplorer');
    expect(reveal.api.editorTab).toHaveBeenCalledWith({ action: 'revealInExplorer', tabId: revealable.id });
    const focus = await menuFor(revealable, 'focusOverlay');
    expect(focus.wrapper.emitted('focusOverlay')).toEqual([[]]);
  });

  it('sends Reload and Open in browser as the toolbar does, and the rest through the editor or the Files tree', async () => {
    for (const [itemId, action] of [['reloadPreview', 'reload'], ['openInBrowser', 'openInBrowser']] as const) {
      const { api } = await menuFor(previewTab, itemId);
      expect(api.htmlPreviewAction).toHaveBeenCalledWith({ tabId: previewTab.id, action });
      expect(api.designPreviewAction).not.toHaveBeenCalled();
    }
    for (const action of ['openSource', 'copyPath'] as const) {
      const { api } = await menuFor(previewTab, action);
      expect(api.editorTab).toHaveBeenCalledWith({ action, tabId: previewTab.id });
    }
    const { wrapper } = await menuFor(previewTab, 'revealInFiles');
    expect(wrapper.emitted('revealInFiles')).toEqual([[{ projectKey: 'home', relativePath: 'site/index.html' }]]);
  });
});

describe('a terminal tab', () => {
  const terminalInfo = (id: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
    id, title: 'dev server', name: null, profileId: 'pwsh', icon: 'powershell', customIcon: null, color: null, projectKey: 'alpha', projectName: 'alpha', status: 'running', exitCode: null, description: null, running: null, integrated: false, restoring: false, windowsBuild: null, pathFlavor: 'win32', placement: 'editor', ...extra,
  });
  // main's tab title lags the terminal's; the tab shows the terminal's own
  const terminalTab = (id: string): ShellEditorTab => ({ id: `terminal:${id}`, kind: 'terminal', terminal: { id }, title: 'stale', displayPath: 'stale', dirty: false, readOnly: false, conflict: false });
  // e1 in the editor; p1 and the Setup task in the panel
  const terminals = (): TerminalInfo[] => [terminalInfo('p1', { title: 'tests', placement: 'panel' }), terminalInfo('task', { title: 'setup', placement: 'panel', task: true }), terminalInfo('e1')];

  async function mountTerminalTabs(answer?: string) {
    const tabs = [codeTab('a', 'app.ts'), terminalTab('e1')];
    const api = fakeShellApi([], {
      getEditorState: vi.fn(async () => ({ ...EDITOR_STATE, tabs, activeTabId: 'terminal:e1' })),
      requestOverlay: vi.fn(async () => (answer ? { kind: 'menu' as const, itemId: answer } : { kind: 'dismissed' as const })),
    });
    api.terminal.getState = vi.fn(async () => ({ ...TERMINAL_STATE, terminals: terminals(), groups: [{ id: 'g1', paneIds: ['p1'], sizes: [1], activePaneId: 'p1' }, { id: 'g2', paneIds: ['task'], sizes: [1], activePaneId: 'task' }], activeId: 'p1' }));
    const store = createEditorStore(api);
    await store.start();
    const scm = createScmStore(api.scm);
    await scm.start();
    const terminalStore = createTerminalStore(api);
    await terminalStore.start();
    const wrapper = mount(EditorTabs, { props: { api, closeShortcut: 'Ctrl+W', projects: [], hosts: [] }, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store, [SCM_STORE]: scm, [TERMINAL_STORE as symbol]: terminalStore } }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    return { wrapper, api, terminalStore };
  }

  const tabOf = (wrapper: VueWrapper) => wrapper.get('[data-tab-id="terminal:e1"]');

  // A drag event whose transfer holds `data`; a dragover may read only its types, as in Chromium.
  function dragEvent(type: string, data: Record<string, string>): DragEvent {
    const entries = new Map(Object.entries(data));
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
    const transfer = {
      get types() { return [...entries.keys()]; },
      getData: (format: string) => (type === 'drop' ? entries.get(format) ?? '' : ''),
      setData: (format: string, value: string) => void entries.set(format, value),
      dropEffect: 'none',
      effectAllowed: 'uninitialized',
    };
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    return event;
  }

  function dragging(id: string): void {
    const start = new Event('dragstart') as DragEvent;
    Object.defineProperty(start, 'dataTransfer', { value: { setData: () => undefined, effectAllowed: 'none' } });
    startTerminalDrag(start, id);
  }

  afterEach(endTerminalDrag);

  it('shows its terminal\'s glyph, colour and title, and its status, a reconnecting one spinning', async () => {
    const { wrapper, api } = await mountTerminalTabs();
    const tab = tabOf(wrapper);
    expect(tab.attributes('data-kind')).toBe('terminal');
    expect(tab.get('[data-testid="editor-tab-title"]').text()).toBe('dev server');
    const icon = tab.get('[data-testid="editor-tab-terminal-icon"]');
    expect(icon.attributes('data-glyph')).toBe('powershell');
    expect(icon.attributes('style')).toContain('var(--d-info)');
    expect(tab.attributes('title')).toBe('dev server · alpha\nRunning');
    expect(tab.findAll('.sr-only').map((hint) => hint.text())).toEqual(['Running']);
    expect(tab.attributes('aria-keyshortcuts')).toBe('F2 Shift+F10');

    api.terminal.pushState({ ...(await api.terminal.getState()), terminals: [...terminals().slice(0, 2), terminalInfo('e1', { title: 'api', status: 'reconnecting', color: 'cyan', customIcon: 'server' })] });
    await flushPromises();
    expect(tab.get('[data-testid="editor-tab-title"]').text()).toBe('api');
    expect(tab.find('[data-testid="editor-tab-loading"]').exists()).toBe(true);
    expect(tab.find('[data-testid="editor-tab-terminal-icon"]').exists()).toBe(false);
    expect(tab.attributes('data-status')).toBe('reconnecting');
    expect(tab.findAll('.sr-only').map((hint) => hint.text())).toEqual(['Reconnecting']);
  });

  it('drags as its terminal, with the id alone, dimmed until the drag ends', async () => {
    const { wrapper } = await mountTerminalTabs();
    const tab = tabOf(wrapper);
    expect(tab.attributes('draggable')).toBe('true');
    const payload: Record<string, string> = {};
    const start = dragEvent('dragstart', {});
    (start.dataTransfer as unknown as { setData: (format: string, value: string) => void }).setData = (format, value) => void (payload[format] = value);
    tab.element.dispatchEvent(start);
    await flushPromises();
    expect(payload).toEqual({ [TERMINAL_DRAG_MIME]: 'e1' });
    expect(tab.attributes('data-dragging')).toBe('true');
    tab.element.dispatchEvent(dragEvent('dragend', {}));
    await flushPromises();
    expect(tab.attributes('data-dragging')).toBeUndefined();
  });

  it('takes a panel terminal dropped on the strip into the editor, a ghost tab showing where it lands', async () => {
    const { wrapper, api } = await mountTerminalTabs();
    const strip = wrapper.get('[data-testid="editor-tabs"]');
    dragging('p1');
    const over = dragEvent('dragover', { [TERMINAL_DRAG_MIME]: '' });
    strip.element.dispatchEvent(over);
    await flushPromises();
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer!.dropEffect).toBe('move');
    const ghost = wrapper.get('[data-testid="editor-tab-drop"]');
    expect(ghost.text()).toBe('tests');
    expect(ghost.attributes('aria-hidden')).toBe('true');
    // at the end of the strip, after every tab
    expect(tabOf(wrapper).element.compareDocumentPosition(ghost.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const drop = dragEvent('drop', { [TERMINAL_DRAG_MIME]: 'p1' });
    strip.element.dispatchEvent(drop);
    await flushPromises();
    expect(drop.defaultPrevented).toBe(true);
    expect(api.terminal.move).toHaveBeenCalledWith({ kind: 'toEditor', id: 'p1' });
    expect(wrapper.find('[data-testid="editor-tab-drop"]').exists()).toBe(false);
  });

  it('refuses a Setup task and a terminal already in the editor, and ignores drags that carry no terminal', async () => {
    const { wrapper, api } = await mountTerminalTabs();
    const strip = wrapper.get('[data-testid="editor-tabs"]');
    for (const id of ['task', 'e1']) {
      dragging(id);
      const over = dragEvent('dragover', { [TERMINAL_DRAG_MIME]: '' });
      strip.element.dispatchEvent(over);
      await flushPromises();
      expect(over.defaultPrevented).toBe(false);
      strip.element.dispatchEvent(dragEvent('drop', { [TERMINAL_DRAG_MIME]: id }));
    }
    endTerminalDrag();
    const files = dragEvent('dragover', { Files: '' });
    strip.element.dispatchEvent(files);
    await flushPromises();
    expect(files.defaultPrevented).toBe(false);
    expect(wrapper.find('[data-testid="editor-tab-drop"]').exists()).toBe(false);
    expect(api.terminal.move).not.toHaveBeenCalled();
  });

  it('drops the ghost when the drag leaves the strip', async () => {
    const { wrapper } = await mountTerminalTabs();
    const strip = wrapper.get('[data-testid="editor-tabs"]');
    dragging('p1');
    strip.element.dispatchEvent(dragEvent('dragover', { [TERMINAL_DRAG_MIME]: '' }));
    await flushPromises();
    expect(wrapper.find('[data-testid="editor-tab-drop"]').exists()).toBe(true);
    strip.element.dispatchEvent(Object.defineProperty(dragEvent('dragleave', { [TERMINAL_DRAG_MIME]: '' }), 'relatedTarget', { value: document.body }));
    await flushPromises();
    expect(wrapper.find('[data-testid="editor-tab-drop"]').exists()).toBe(false);
  });

  it('offers the editor\'s close entries, then Move Terminal into Panel, Rename..., Change Icon..., Change Color... and Kill', async () => {
    const { wrapper, api } = await mountTerminalTabs('moveToPanel');
    await tabOf(wrapper).trigger('contextmenu', { clientX: 10, clientY: 10 });
    await flushPromises();
    const request = vi.mocked(api.requestOverlay).mock.calls[0]![0];
    if (request.kind !== 'menu') throw new Error('not a menu');
    expect(request.items.filter((item) => item.kind === 'item').map((item) => ('id' in item ? item.id : undefined))).toEqual(['close', 'closeOthers', 'closeRight', 'closeAll', 'moveToPanel', 'rename', 'changeIcon', 'changeColor', 'kill']);
    expect(api.terminal.move).toHaveBeenCalledWith({ kind: 'detach', id: 'e1' });
    expect(api.editorTab).not.toHaveBeenCalled();
  });

  it('kills its terminal from the menu, and closes through the editor, where main asks as Kill does', async () => {
    const { wrapper, api } = await mountTerminalTabs('kill');
    await tabOf(wrapper).trigger('contextmenu', { clientX: 10, clientY: 10 });
    await flushPromises();
    expect(api.terminal.kill).toHaveBeenCalledWith('e1');
    await tabOf(wrapper).get('[data-testid="editor-tab-close"]').trigger('click');
    expect(api.editorTab).toHaveBeenCalledWith({ action: 'close', tabId: 'terminal:e1' });
  });

  it('gives each terminal tab one host in the editor pane, kept while its tab is open and shown only while it is active', async () => {
    const tabs = [terminalTab('e1'), terminalTab('e2')];
    const api = fakeShellApi([], { getEditorState: vi.fn(async () => ({ ...EDITOR_STATE, tabs, activeTabId: 'terminal:e1' })) });
    api.terminal.getState = vi.fn(async () => ({ ...TERMINAL_STATE, terminals: [terminalInfo('e1'), terminalInfo('e2', { title: 'logs' })] }));
    const store = createEditorStore(api);
    await store.start();
    const scm = createScmStore(api.scm);
    await scm.start();
    const terminalStore = createTerminalStore(api);
    await terminalStore.start();
    const wrapper = mount(EditorPane, { props: { api, state: STATE }, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store, [SCM_STORE]: scm, [TERMINAL_STORE as symbol]: terminalStore }, stubs: { PaneGrip: true } }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    const host = (id: string) => wrapper.get(`#terminal-editor-host-${id}`);
    const first = host('e1').element;
    expect([...terminalStore.editorHosts.value]).toEqual([['e1', first], ['e2', host('e2').element]]);
    expect(host('e1').attributes('style') ?? '').not.toContain('display: none');
    expect(host('e2').attributes('style')).toContain('display: none');
    expect(terminalStore.editorShown.value).toBe('e1');
    // a terminal tab is no file: no breadcrumbs, no mention, no notice
    expect(wrapper.find('[data-testid="editor-breadcrumbs"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="editor-mention"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-testid="editor-not-displayed"]').exists()).toBe(false);

    api.pushEditorState({ ...EDITOR_STATE, tabs, activeTabId: 'terminal:e2' });
    await flushPromises();
    expect(host('e1').element).toBe(first);
    expect(host('e1').attributes('style')).toContain('display: none');
    expect(terminalStore.editorShown.value).toBe('e2');

    // the editor pane hidden: no terminal of it shows
    await wrapper.setProps({ state: { ...STATE, layout: { ...STATE.layout, grid: { ...STATE.layout.grid, visible: { ...STATE.layout.grid.visible, editor: false } } } } });
    expect(terminalStore.editorShown.value).toBeNull();

    api.pushEditorState({ ...EDITOR_STATE, tabs: [terminalTab('e1')], activeTabId: 'terminal:e1' });
    await flushPromises();
    expect(wrapper.find('#terminal-editor-host-e2').exists()).toBe(false);
    expect([...terminalStore.editorHosts.value.keys()]).toEqual(['e1']);
  });

  it('keeps each terminal tab\'s host mounted while no tab is active', async () => {
    const tabs = [terminalTab('e1')];
    const api = fakeShellApi([], { getEditorState: vi.fn(async () => ({ ...EDITOR_STATE, tabs, activeTabId: 'terminal:e1' })) });
    api.terminal.getState = vi.fn(async () => ({ ...TERMINAL_STATE, terminals: [terminalInfo('e1')] }));
    const store = createEditorStore(api);
    await store.start();
    const scm = createScmStore(api.scm);
    await scm.start();
    const terminalStore = createTerminalStore(api);
    await terminalStore.start();
    const wrapper = mount(EditorPane, { props: { api, state: STATE }, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store, [SCM_STORE]: scm, [TERMINAL_STORE as symbol]: terminalStore }, stubs: { PaneGrip: true } }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    const host = wrapper.get('#terminal-editor-host-e1').element;

    api.pushEditorState({ ...EDITOR_STATE, tabs, activeTabId: null });
    await flushPromises();
    expect(wrapper.find('[data-testid="editor-empty"]').exists()).toBe(true);
    expect(wrapper.get('#terminal-editor-host-e1').element).toBe(host);
    expect(terminalStore.editorHosts.value.get('e1')).toBe(host);
    expect(wrapper.get('#editor-panel').attributes('style')).toContain('display: none');
    expect(terminalStore.editorShown.value).toBeNull();

    api.pushEditorState({ ...EDITOR_STATE, tabs, activeTabId: 'terminal:e1' });
    await flushPromises();
    expect(wrapper.get('#terminal-editor-host-e1').element).toBe(host);
    expect(wrapper.get('#editor-panel').attributes('style') ?? '').not.toContain('display: none');
    expect(wrapper.get('#editor-panel').attributes('aria-labelledby')).toBe('editor-tab-terminal:e1');
  });

  it('renames its terminal in place on F2, and hands focus back to the tab', async () => {
    const { wrapper, api } = await mountTerminalTabs();
    const tab = tabOf(wrapper);
    await tab.trigger('keydown', { key: 'F2' });
    await flushPromises();
    const field = tab.get('[data-testid="terminal-rename-input"]');
    expect(tab.attributes('draggable')).toBe('false');
    await field.setValue('watch');
    await field.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(api.terminal.rename).toHaveBeenCalledWith({ id: 'e1', name: 'watch' });
    expect(tab.find('[data-testid="terminal-rename-input"]').exists()).toBe(false);
    expect(document.activeElement).toBe(tab.element);
  });

  it('keeps a middle-click in the rename field from closing the tab, which would kill its terminal', async () => {
    const { wrapper, api } = await mountTerminalTabs();
    const tab = tabOf(wrapper);
    await tab.trigger('keydown', { key: 'F2' });
    await flushPromises();
    await tab.get('[data-testid="terminal-rename-input"]').trigger('auxclick', { button: 1 });
    expect(api.editorTab).not.toHaveBeenCalled();
    expect(tab.find('[data-testid="terminal-rename-input"]').exists()).toBe(true);
  });

  it('drags the rename field\'s selected text as text, never as its terminal', async () => {
    const { wrapper } = await mountTerminalTabs();
    const tab = tabOf(wrapper);
    await tab.trigger('keydown', { key: 'F2' });
    await flushPromises();
    const payload: Record<string, string> = {};
    const start = dragEvent('dragstart', {});
    (start.dataTransfer as unknown as { setData: (format: string, value: string) => void }).setData = (format, value) => void (payload[format] = value);
    tab.get('[data-testid="terminal-rename-input"]').element.dispatchEvent(start);
    await flushPromises();
    expect(payload).toEqual({});
    expect(start.defaultPrevented).toBe(false);
    expect(tab.attributes('data-dragging')).toBeUndefined();
  });
});
