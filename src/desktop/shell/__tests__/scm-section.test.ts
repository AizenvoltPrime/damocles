// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { OverlayMenuItem, OverlayRequest } from '../../preload/overlay-channels';
import type { ScmChange, ScmRepoSnapshot, ScmView } from '../../preload/scm-channels';
import { shellI18n } from '../i18n';
import { createScmStore, SCM_STORE, type ScmStore } from '../scm/scm-store';
import { COMMIT_VARIANTS } from '../scm/scm-menus';
import ScmSection from '../scm/ScmSection.vue';
import { FakeResizeObserver, fakeScmApi, fakeShellApi, SCM_SETTINGS, type FakeScmApi, type FakeShellApi } from './fakes';

const change = (path: string, status: ScmChange['status'] = 'MODIFIED'): ScmChange => ({ path, status, letter: 'M', tone: 'modified', strike: false });

const snapshot = (repoId: string, groups: Partial<ScmRepoSnapshot['groups']>): ScmRepoSnapshot => ({
  repoId,
  projectKey: 'p1',
  head: { type: 'branch', name: 'main' },
  commit: { hash: `${repoId}-head`, subject: 'Initial commit' },
  operation: null,
  groups: { merge: [], index: [], workingTree: [], untracked: [], ...groups },
  tooManyChanges: false,
  busy: false,
});

const view = (repoIds: readonly string[], selected: string): ScmView => ({
  projectKey: 'p1',
  state: 'ready',
  repos: repoIds.map((repoId) => ({ repoId, label: repoId, displayPath: repoId, kind: 'nested' as const })),
  selectedRepoId: selected,
  closedCount: 0,
  unsafePaths: [],
  parentCount: 0,
});

const mounted: VueWrapper[] = [];

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

interface Mounted {
  readonly wrapper: VueWrapper;
  readonly scm: FakeScmApi;
  readonly shell: FakeShellApi;
  readonly store: ScmStore;
}

async function mountSection(snapshots: readonly ScmRepoSnapshot[], viewMode: 'list' | 'tree' = 'list', repoIds: readonly string[] = ['r1']): Promise<Mounted> {
  const scm = fakeScmApi({ views: [view(repoIds, repoIds[0]!)], snapshots, decorations: [], settings: SCM_SETTINGS });
  const shell = fakeShellApi();
  const store = createScmStore(scm);
  await store.start();
  const wrapper = mount(ScmSection, {
    props: { api: shell, projectKey: 'p1', projectName: 'alpha', platform: 'win32', viewMode, sortKey: 'path', collapsed: false },
    global: { plugins: [shellI18n], provide: { [SCM_STORE]: store } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, scm, shell, store };
}

const tree = (wrapper: VueWrapper) => wrapper.get('[data-testid="scm-tree"]');
const focusedKey = (): string | null | undefined => document.activeElement?.getAttribute('data-row-key');

async function press(key: string, init: KeyboardEventInit = {}): Promise<void> {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  await flushPromises();
}

async function focusRow(wrapper: VueWrapper, key: string): Promise<void> {
  (wrapper.get(`[data-row-key="${key}"]`).element as HTMLElement).focus();
  await flushPromises();
}

const lastMenu = (shell: FakeShellApi): Extract<OverlayRequest, { kind: 'menu' }> => {
  const request = shell.overlayRequests.at(-1);
  if (request?.kind !== 'menu') throw new Error('no menu was asked for');
  return request;
};
const submenu = (items: readonly OverlayMenuItem[], id: string): readonly OverlayMenuItem[] => {
  const found = items.find((item) => item.kind === 'submenu' && item.id === id);
  return found?.kind === 'submenu' ? found.items : [];
};

describe('the Source control tree', () => {
  const nested = snapshot('r1', { index: [change('src/b/c.ts', 'INDEX_MODIFIED'), change('src/a.ts', 'INDEX_MODIFIED')], workingTree: [change('x.ts')] });

  it('moves with the arrow keys, Home and End, and folds a folder with Left and unfolds it with Right', async () => {
    const { wrapper } = await mountSection([nested], 'tree');
    await focusRow(wrapper, 'group:index');
    await press('ArrowDown');
    expect(focusedKey()).toBe('folder:index:src');
    await press('ArrowLeft');
    expect(wrapper.find('[data-row-key="index:src/a.ts"]').exists()).toBe(false);
    expect(focusedKey()).toBe('folder:index:src');
    await press('ArrowRight');
    expect(wrapper.find('[data-row-key="index:src/a.ts"]').exists()).toBe(true);
    await press('ArrowRight');
    expect(focusedKey()).toBe('folder:index:src/b');
    await press('ArrowDown');
    expect(focusedKey()).toBe('index:src/b/c.ts');
    await press('ArrowLeft');
    expect(focusedKey()).toBe('folder:index:src/b');
    await press('End');
    expect(focusedKey()).toBe('workingTree:x.ts');
    await press('Home');
    expect(focusedKey()).toBe('group:index');
  });

  it("says each row's position among its siblings, which a virtualized tree must", async () => {
    const { wrapper } = await mountSection([nested], 'tree');
    const at = (key: string) => wrapper.get(`[data-row-key="${key}"]`).attributes();
    expect(at('group:index')).toMatchObject({ 'aria-level': '1', 'aria-posinset': '1', 'aria-setsize': '2' });
    expect(at('group:workingTree')).toMatchObject({ 'aria-posinset': '2', 'aria-setsize': '2' });
    expect(at('folder:index:src')).toMatchObject({ 'aria-posinset': '1', 'aria-setsize': '1' });
    expect(at('folder:index:src/b')).toMatchObject({ 'aria-level': '3', 'aria-posinset': '1', 'aria-setsize': '2' });
    expect(at('index:src/a.ts')).toMatchObject({ 'aria-posinset': '2', 'aria-setsize': '2' });
    expect(at('index:src/a.ts')['aria-label']).toBe('a.ts, Index Modified, src/a.ts');
  });

  it('names a row and the repository picker with the escaped text they show', async () => {
    const { wrapper, shell } = await mountSection([snapshot('r1', { workingTree: [change('evil\u202Etxt.exe')] }), snapshot('r2', {})], 'list', ['r1', 'r2']);
    expect(wrapper.get('[data-testid="scm-change"]').attributes('aria-label')).toBe('evil\\u{202E}txt.exe, Modified, evil\\u{202E}txt.exe');
    await wrapper.get('[data-testid="scm-repo-picker"]').trigger('click');
    await flushPromises();
    const repos = lastMenu(shell).items.flatMap((item) => (item.kind === 'item' && item.id.startsWith('repo:') ? [item] : []));
    expect(repos.map((item) => [item.id, item.checked, item.radio])).toEqual([['repo:r1', true, true], ['repo:r2', false, true]]);
  });

  it("opens a row's menu with Shift+F10 and runs the action it answers on that row's paths", async () => {
    const { wrapper, scm, shell } = await mountSection([nested], 'tree');
    await focusRow(wrapper, 'workingTree:x.ts');
    shell.answerNext({ kind: 'menu', itemId: 'stage' });
    await press('F10', { shiftKey: true });
    expect(lastMenu(shell)).toMatchObject({ label: 'Actions for x.ts', caption: 'x.ts' });
    expect(scm.run).toHaveBeenLastCalledWith({ op: 'stage', repoId: 'r1', paths: ['x.ts'] });

    await focusRow(wrapper, 'folder:index:src');
    shell.answerNext({ kind: 'menu', itemId: 'unstage' });
    await press('ContextMenu');
    expect(lastMenu(shell).items.map((item) => (item.kind === 'item' ? item.id : item.kind))).toEqual(['unstage']);
    expect(scm.run).toHaveBeenLastCalledWith({ op: 'unstage', repoId: 'r1', paths: ['src/b/c.ts', 'src/a.ts'] });
  });

  it('keeps keyboard focus in the tree when the focused row scrolls out of the rendered window', async () => {
    const many = snapshot('r1', { workingTree: Array.from({ length: 80 }, (_, index) => change(`f${String(index).padStart(2, '0')}.ts`)) });
    const { wrapper } = await mountSection([many]);
    const container = tree(wrapper).element as HTMLElement;
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 200 });
    container.dispatchEvent(new Event('scroll'));
    await flushPromises();
    await focusRow(wrapper, 'workingTree:f00.ts');
    expect(focusedKey()).toBe('workingTree:f00.ts');
    container.scrollTop = 1500;
    container.dispatchEvent(new Event('scroll'));
    await flushPromises();
    expect(wrapper.find('[data-row-key="workingTree:f00.ts"]').exists()).toBe(false);
    expect(document.activeElement).toBe(container);
    await press('End');
    expect(container.scrollTop).toBeGreaterThan(1500);
    expect(container.contains(document.activeElement)).toBe(true);
  });

  it('restarts the list fade on each repository switch, across a reflow', async () => {
    const { wrapper, scm } = await mountSection([snapshot('r1', { workingTree: [change('a.ts')] }), snapshot('r2', { workingTree: [change('b.ts')] })], 'list', ['r1', 'r2']);
    const list = tree(wrapper).element.firstElementChild as HTMLElement;
    const seen: boolean[] = [];
    Object.defineProperty(list, 'offsetWidth', { configurable: true, get: () => (seen.push(list.classList.contains('d-fade-in')), 0) });
    scm.pushView(view(['r1', 'r2'], 'r2'));
    await flushPromises();
    expect(seen).toEqual([false]);
    expect(list.classList.contains('d-fade-in')).toBe(true);
  });
});

describe('Source control commits', () => {
  it("commits a palette command's repository with that repository's draft, before main's view names it", async () => {
    const { scm, store } = await mountSection([snapshot('r1', { index: [change('a.ts', 'INDEX_MODIFIED')] }), snapshot('r2', { index: [change('b.ts', 'INDEX_MODIFIED')] })], 'list', ['r1', 'r2']);
    store.setDraft('r1', 'For one');
    store.setDraft('r2', 'For two');
    scm.command({ command: 'commit', repoId: 'r2', variant: COMMIT_VARIANTS.commitSigned });
    await flushPromises();
    expect(scm.select).toHaveBeenCalledWith({ projectKey: 'p1', repoId: 'r2' });
    expect(scm.commit).toHaveBeenCalledTimes(1);
    expect(scm.commit).toHaveBeenCalledWith({ repoId: 'r2', message: 'For two', variant: COMMIT_VARIANTS.commitSigned });
  });

  it('amends with every commit action in amend mode, labels each as the amend it runs, and hides the redundant one', async () => {
    const { wrapper, scm, shell, store } = await mountSection([snapshot('r1', { index: [change('a.ts', 'INDEX_MODIFIED')] })]);
    store.setAmending('r1', '');
    store.setDraft('r1', 'Reworded');
    await flushPromises();
    expect(wrapper.get('[data-testid="scm-title-commit"]').attributes('aria-label')).toBe('Commit (Amend) (Ctrl+Enter)');

    shell.answerNext({ kind: 'menu', itemId: 'commitSigned' });
    await wrapper.get('[data-testid="scm-more-actions"]').trigger('click');
    await flushPromises();
    const commit = submenu(lastMenu(shell).items, 'submenu:commit').flatMap((item) => (item.kind === 'item' ? [[item.id, item.label]] : []));
    expect(commit).toContainEqual(['commit', 'Commit (Amend)']);
    expect(commit).toContainEqual(['commitStagedSigned', 'Commit Staged (Amend, Signed Off)']);
    expect(commit.map(([id]) => id)).not.toContain('commitAmend');
    expect(scm.commit).toHaveBeenLastCalledWith({ repoId: 'r1', message: 'Reworded', variant: { ...COMMIT_VARIANTS.commitSigned, amend: true } });
    // the commit's reply emptied the box and left amend mode
    expect(store.draftOf('r1')).toBe('');
    expect(store.amendingIn('r1')).toBe(false);

    store.setAmending('r1', '');
    store.setDraft('r1', 'Reworded');
    await flushPromises();
    scm.command({ command: 'commit', repoId: 'r1', variant: COMMIT_VARIANTS.commitAll });
    await flushPromises();
    expect(scm.commit).toHaveBeenLastCalledWith({ repoId: 'r1', message: 'Reworded', variant: COMMIT_VARIANTS.commitAllAmend });
  });

  it('reports the selected repository\'s amend mode to main on each change: entering, Escape, a repository switch, a commit and an operation', async () => {
    const { wrapper, scm, store } = await mountSection([snapshot('r1', { index: [change('a.ts', 'INDEX_MODIFIED')] }), snapshot('r2', {})], 'list', ['r1', 'r2']);
    const reports = () => vi.mocked(scm.reportAmend).mock.calls.map(([report]) => `${report.repoId}:${report.amending}`);
    expect(reports()).toEqual(['r1:false']);

    store.setAmending('r1', 'Draft');
    await flushPromises();
    await wrapper.get('[data-testid="scm-commit-message"]').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(reports()).toEqual(['r1:false', 'r1:true', 'r1:false']);

    store.setAmending('r1', '');
    await flushPromises();
    scm.pushView(view(['r1', 'r2'], 'r2'));
    await flushPromises();
    scm.pushView(view(['r1', 'r2'], 'r1'));
    await flushPromises();
    expect(reports().slice(3)).toEqual(['r1:true', 'r2:false', 'r1:true']);

    store.applyCommitted('r1', '', undefined);
    await flushPromises();
    store.setAmending('r1', '');
    await flushPromises();
    scm.pushSnapshot({ ...snapshot('r1', {}), operation: 'merge' });
    await flushPromises();
    expect(reports().slice(6)).toEqual(['r1:false', 'r1:true', 'r1:false']);
  });

  it('offers Sort by only in list view, each view and sort a radio choice', async () => {
    for (const viewMode of ['list', 'tree'] as const) {
      const { wrapper, shell } = await mountSection([snapshot('r1', { workingTree: [change('a.ts')] })], viewMode);
      await wrapper.get('[data-testid="scm-more-actions"]').trigger('click');
      await flushPromises();
      const items = submenu(lastMenu(shell).items, 'submenu:viewSort').flatMap((item) => (item.kind === 'item' ? [item] : []));
      expect(items.map((item) => item.id)).toEqual(viewMode === 'list' ? ['viewAsTree', 'viewAsList', 'sortByName', 'sortByPath', 'sortByStatus'] : ['viewAsTree', 'viewAsList']);
      expect(items.every((item) => item.radio === true)).toBe(true);
    }
  });
});
