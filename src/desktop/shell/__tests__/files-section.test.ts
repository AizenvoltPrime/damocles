// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import FilesSection from '../components/FilesSection.vue';
import { shellI18n } from '../i18n';
import { createEditorStore, EDITOR_STORE } from '../editor/editor-store';
import { createScmStore, SCM_STORE } from '../scm/scm-store';
import { FakeResizeObserver, fakeShellApi, type FakeShellApi } from './fakes';

const mounted: VueWrapper[] = [];

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

async function mountFiles(platform: 'win32' | 'linux' = 'win32'): Promise<{ wrapper: VueWrapper; api: FakeShellApi }> {
  const api = fakeShellApi([], {
    listFiles: vi.fn(async () => ({ ok: true as const, entries: [{ name: 'src', kind: 'dir' as const }, { name: 'notes.txt', kind: 'file' as const }, { name: 'todo.md', kind: 'file' as const }] })),
  });
  const wrapper = mount(FilesSection, {
    props: { api, projectKey: 'home', projectName: 'Home', platform, collapsed: false },
    global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: createEditorStore(api), [SCM_STORE]: createScmStore(api.scm) } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, api };
}

const row = (wrapper: VueWrapper, path: string) => wrapper.find(`[data-tree-path="${path}"]`);
const input = (wrapper: VueWrapper) => wrapper.find<HTMLInputElement>('[data-testid="files-edit-input"]');
const message = (wrapper: VueWrapper) => wrapper.find('[data-testid="files-edit-message"]');

async function startRename(wrapper: VueWrapper, path: string): Promise<void> {
  (row(wrapper, path).element as HTMLElement).focus();
  await row(wrapper, path).trigger('keydown', { key: 'F2' });
  await flushPromises();
}

// The user moves focus out of the box, as a click elsewhere does; the box decides a tick later.
async function leaveBox(wrapper: VueWrapper): Promise<HTMLButtonElement> {
  const outside = document.createElement('button');
  document.body.append(outside);
  expect(document.activeElement).toBe(input(wrapper).element);
  outside.focus();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
  return outside;
}

describe('Files inline name box', () => {
  it('validates as the user types, against the folder\'s names ignoring case on Windows, and Enter does nothing while invalid', async () => {
    const { wrapper, api } = await mountFiles();
    await startRename(wrapper, 'notes.txt');
    expect(message(wrapper).exists()).toBe(false);
    await input(wrapper).setValue('TODO.md');
    expect(message(wrapper).text()).toContain('already exists');
    expect(input(wrapper).attributes('aria-invalid')).toBe('true');
    await input(wrapper).trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(api.renameFile).not.toHaveBeenCalled();
    expect(input(wrapper).exists()).toBe(true);
    await input(wrapper).setValue('a:b');
    expect(message(wrapper).text()).toContain('not a valid name');
    await input(wrapper).setValue('');
    expect(message(wrapper).text()).toContain('must be provided');
    // the entry's own name, whatever its case, is not another entry's
    await input(wrapper).setValue('NOTES.txt');
    expect(message(wrapper).exists()).toBe(false);
  });

  it('cancels an invalid name when the box loses focus, leaving the tree usable', async () => {
    const { wrapper, api } = await mountFiles();
    await startRename(wrapper, 'notes.txt');
    await input(wrapper).setValue('todo.md');
    (await leaveBox(wrapper)).remove();
    expect(input(wrapper).exists()).toBe(false);
    expect(api.renameFile).not.toHaveBeenCalled();
    // F2 opens the box again: the tree takes keys once more
    await startRename(wrapper, 'todo.md');
    expect(input(wrapper).element.value).toBe('todo.md');
  });

  it('commits a valid name when the box loses focus, without moving focus', async () => {
    const { wrapper, api } = await mountFiles();
    await startRename(wrapper, 'notes.txt');
    await input(wrapper).setValue('renamed.txt');
    const outside = await leaveBox(wrapper);
    expect(api.renameFile).toHaveBeenCalledWith({ projectKey: 'home', relativePath: 'notes.txt', newName: 'renamed.txt' });
    expect(input(wrapper).exists()).toBe(false);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('closes the box when main refuses the commit, which main reports, and the tree takes keys again', async () => {
    const { wrapper, api } = await mountFiles();
    vi.mocked(api.renameFile).mockResolvedValueOnce({ ok: false, reason: 'exists' });
    await startRename(wrapper, 'notes.txt');
    await input(wrapper).setValue('hidden.txt');
    await input(wrapper).trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(input(wrapper).exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    await startRename(wrapper, 'notes.txt');
    expect(input(wrapper).exists()).toBe(true);
  });

  it('opens no box in a folder whose listing fails, asks main to report it, and the tree takes keys again', async () => {
    const { wrapper, api } = await mountFiles();
    vi.mocked(api.listFiles).mockResolvedValueOnce({ ok: false, reason: 'failed' });
    (row(wrapper, 'src').element as HTMLElement).focus();
    vi.mocked(api.requestOverlay).mockResolvedValueOnce({ kind: 'menu', itemId: 'newFile' });
    await row(wrapper, 'src').trigger('keydown', { key: 'ContextMenu' });
    await flushPromises();
    expect(api.listFiles).toHaveBeenLastCalledWith({ projectKey: 'home', relativeDir: 'src', report: true });
    expect(input(wrapper).exists()).toBe(false);
    await startRename(wrapper, 'notes.txt');
    expect(input(wrapper).exists()).toBe(true);
  });
});

describe('Files folder expand', () => {
  it('asks main to report a folder the user expands whose listing fails, once per click or key, and collapses it', async () => {
    const { wrapper, api } = await mountFiles();
    vi.mocked(api.listFiles).mockClear();
    vi.mocked(api.listFiles).mockResolvedValue({ ok: false, reason: 'failed' });
    await row(wrapper, 'src').trigger('click');
    await flushPromises();
    expect(api.listFiles).toHaveBeenCalledTimes(1);
    expect(api.listFiles).toHaveBeenLastCalledWith({ projectKey: 'home', relativeDir: 'src', report: true });
    expect(row(wrapper, 'src').attributes('aria-expanded')).toBe('false');
    (row(wrapper, 'src').element as HTMLElement).focus();
    for (const key of ['ArrowRight', 'Enter']) await row(wrapper, 'src').trigger('keydown', { key });
    await flushPromises();
    expect(vi.mocked(api.listFiles).mock.calls).toEqual([0, 1, 2].map(() => [{ projectKey: 'home', relativeDir: 'src', report: true }]));
    expect(row(wrapper, 'src').attributes('aria-expanded')).toBe('false');
  });

  it('reloads an expanded folder after a file change without reporting a failure', async () => {
    const { wrapper, api } = await mountFiles();
    await row(wrapper, 'src').trigger('click');
    await flushPromises();
    vi.mocked(api.listFiles).mockClear();
    vi.mocked(api.listFiles).mockResolvedValue({ ok: false, reason: 'failed' });
    api.filesChanged({ projectKey: 'home', relativeDirs: ['src'] });
    await flushPromises();
    expect(api.listFiles).toHaveBeenCalledWith({ projectKey: 'home', relativeDir: 'src' });
  });
});

describe('Files names with control and bidi characters', () => {
  it('shows a name, its tooltip, its menu and its name box message with escapes, keeps the real name in the rename box and in the actions', async () => {
    const api = fakeShellApi([], {
      listFiles: vi.fn(async () => ({ ok: true as const, entries: [{ name: 'a\u202Ebc.txt', kind: 'file' as const }, { name: 'x\u2066y.md', kind: 'file' as const }] })),
    });
    const wrapper = mount(FilesSection, {
      props: { api, projectKey: 'home', projectName: 'Home', platform: 'win32', collapsed: false },
      global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: createEditorStore(api), [SCM_STORE]: createScmStore(api.scm) } },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await flushPromises();
    const shown = row(wrapper, 'a\u202Ebc.txt');
    expect(shown.find('[data-testid="files-name"]').text()).toBe('a\\u{202E}bc.txt');
    expect(shown.attributes('title')).toBe('a\\u{202E}bc.txt');
    await shown.trigger('contextmenu');
    await flushPromises();
    expect(api.overlayRequests.at(-1)).toMatchObject({ kind: 'menu', caption: 'a\\u{202E}bc.txt' });
    await startRename(wrapper, 'a\u202Ebc.txt');
    expect(input(wrapper).element.value).toBe('a\u202Ebc.txt');
    await input(wrapper).setValue('x\u2066y.md');
    expect(message(wrapper).text()).toContain('x\\u{2066}y.md');
    await input(wrapper).setValue('a\u202Ebcd.txt');
    await input(wrapper).trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(api.renameFile).toHaveBeenCalledWith({ projectKey: 'home', relativePath: 'a\u202Ebc.txt', newName: 'a\u202Ebcd.txt' });
  });
});

describe('Files menu and Reveal in Files', () => {
  it('opens a file\'s menu without Open Timeline when its repository lookup fails, and logs why', async () => {
    const { wrapper, api } = await mountFiles();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.scm.resource).mockRejectedValueOnce(new Error('Source control used before startup finished'));
    await row(wrapper, 'notes.txt').trigger('contextmenu');
    await flushPromises();
    const menu = api.overlayRequests.at(-1);
    expect(menu?.kind).toBe('menu');
    expect(menu?.kind === 'menu' && menu.items.some((item) => item.kind === 'item' && item.id === 'openTimeline')).toBe(false);
    expect(menu?.kind === 'menu' && menu.items.some((item) => item.kind === 'item' && item.id === 'rename')).toBe(true);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('shows the project folder before it reveals one of its files while the worktree shows, and the worktree for one of the worktree\'s', async () => {
    const worktreeKey = 'p1\u0000a1b2c3d4';
    const shown = (rootKey: string) => ({
      projectKey: 'p1',
      root: rootKey === 'p1' ? { projectKey: 'p1' } : { projectKey: 'p1', worktreeId: 'a1b2c3d4' },
      rootKey,
      fsPath: '/w/alpha',
      canShowWorktree: true,
      worktree: { worktreeId: 'a1b2c3d4', chatId: 'w1', branch: 'damocles/fix', behind: 0, targetRewritten: false, place: 'worktree' as const, finish: { busy: false, hasRemote: false, detachedTarget: false } },
    });
    const api = fakeShellApi([], {
      listFiles: vi.fn(async () => ({ ok: true as const, entries: [{ name: 'notes.txt', kind: 'file' as const }] })),
    });
    const wrapper = mount(FilesSection, {
      props: { api, projectKey: worktreeKey, projectName: 'alpha', platform: 'win32', collapsed: false, shown: shown(worktreeKey) },
      global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: createEditorStore(api), [SCM_STORE]: createScmStore(api.scm) } },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await flushPromises();
    // main sends the new shown folder before it answers
    vi.mocked(api.showFolder).mockImplementation(async ({ show }) => {
      const key = show === 'project' ? 'p1' : worktreeKey;
      await wrapper.setProps({ projectKey: key, shown: shown(key) });
    });
    const reveal = (wrapper.vm as unknown as { reveal: (file: { projectKey: string; relativePath: string }) => Promise<void> }).reveal;
    await reveal({ projectKey: 'p1', relativePath: 'notes.txt' });
    await flushPromises();
    expect(api.showFolder).toHaveBeenLastCalledWith({ projectKey: 'p1', show: 'project' });
    expect(document.activeElement).toBe(row(wrapper, 'notes.txt').element);

    await reveal({ projectKey: worktreeKey, relativePath: 'notes.txt' });
    await flushPromises();
    expect(api.showFolder).toHaveBeenLastCalledWith({ projectKey: 'p1', show: 'worktree' });
    // another worktree of the project is no folder this section can show
    vi.mocked(api.showFolder).mockClear();
    await reveal({ projectKey: 'p1\u0000ffffffff', relativePath: 'notes.txt' });
    expect(api.showFolder).not.toHaveBeenCalled();
  });
});
