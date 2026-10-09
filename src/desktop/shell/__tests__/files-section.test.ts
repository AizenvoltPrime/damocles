// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import FilesSection from '../components/FilesSection.vue';
import { shellI18n } from '../i18n';
import { createEditorStore, EDITOR_STORE } from '../editor/editor-store';
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
    global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: createEditorStore(api) } },
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
