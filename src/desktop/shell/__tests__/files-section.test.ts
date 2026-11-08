// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import FilesSection from '../components/FilesSection.vue';
import { shellI18n } from '../i18n';
import { createEditorStore, EDITOR_STORE } from '../editor/editor-store';
import { createScmStore, SCM_STORE } from '../scm/scm-store';
import type { ShownFolder } from '../../preload/shell-channels';
import { FILE_DRAG_MIME, FILES_ROW_DRAG_MIME } from '@shared/file-drag';
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

async function mountFiles(options: { platform?: 'win32' | 'linux' | 'darwin'; projectPlatform?: 'win32' | 'linux' | 'darwin'; trash?: boolean; shown?: ShownFolder; projectKey?: string; remote?: boolean; offline?: boolean; transfersUnsupportedOn?: string; files?: readonly string[]; folders?: readonly string[] } = {}): Promise<{ wrapper: VueWrapper; api: FakeShellApi }> {
  const files = options.files ?? ['notes.txt', 'todo.md'];
  const api = fakeShellApi([], {
    listFiles: vi.fn(async () => ({ ok: true as const, entries: [...(options.folders ?? ['src']).map((name) => ({ name, kind: 'dir' as const })), ...files.map((name) => ({ name, kind: 'file' as const }))] })),
  });
  const wrapper = mount(FilesSection, {
    props: { api, projectKey: options.projectKey ?? 'home', projectName: 'Home', platform: options.platform ?? 'win32', projectPlatform: options.projectPlatform ?? options.platform ?? 'win32', trash: options.trash ?? true, collapsed: false, remote: options.remote ?? false, offline: options.offline ?? false, ...(options.shown ? { shown: options.shown } : {}), ...(options.transfersUnsupportedOn !== undefined ? { transfersUnsupportedOn: options.transfersUnsupportedOn } : {}) },
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

  it('follows the project\'s platform, not this computer\'s: a Linux project on Windows takes a:b and tells TODO.md from todo.md', async () => {
    const { wrapper } = await mountFiles({ platform: 'win32', projectPlatform: 'linux' });
    await startRename(wrapper, 'notes.txt');
    await input(wrapper).setValue('a:b');
    expect(message(wrapper).exists()).toBe(false);
    await input(wrapper).setValue('TODO.md');
    expect(message(wrapper).exists()).toBe(false);
    await input(wrapper).setValue('todo.md');
    expect(message(wrapper).text()).toContain('already exists');
    // a separator is never part of a name, whatever the platform
    await input(wrapper).setValue('a/b');
    expect(message(wrapper).text()).toContain('not a valid name');
  });

  it('names Delete for what it does: Delete where the host has a trash, Delete Permanently where it has none', async () => {
    for (const trash of [true, false]) {
      const { wrapper, api } = await mountFiles({ trash });
      await row(wrapper, 'notes.txt').trigger('contextmenu');
      await flushPromises();
      const request = api.overlayRequests.at(-1);
      const items = request?.kind === 'menu' ? request.items : [];
      expect(items.find((item) => item.kind === 'item' && item.id === 'delete')).toMatchObject({ label: trash ? 'Delete' : 'Delete Permanently', danger: true });
    }
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

  it('shows the newest listing of a folder when an older one answers after it', async () => {
    const { wrapper, api } = await mountFiles();
    const answers: Array<(entries: Array<{ name: string; kind: 'file' }>) => void> = [];
    vi.mocked(api.listFiles).mockImplementation(() => new Promise((resolve) => answers.push((entries) => resolve({ ok: true, entries }))));
    api.filesChanged({ projectKey: 'home', relativeDirs: [''] });
    api.filesChanged({ projectKey: 'home', relativeDirs: [''] });
    await flushPromises();
    expect(answers).toHaveLength(2);
    answers[1]!([{ name: 'renamed.txt', kind: 'file' }]);
    await flushPromises();
    answers[0]!([{ name: 'made.txt', kind: 'file' }]);
    await flushPromises();
    expect(row(wrapper, 'renamed.txt').exists()).toBe(true);
    expect(row(wrapper, 'made.txt').exists()).toBe(false);
  });
});

describe('Files names with control and bidi characters', () => {
  it('shows a name, its tooltip, its menu and its name box message with escapes, keeps the real name in the rename box and in the actions', async () => {
    const api = fakeShellApi([], {
      listFiles: vi.fn(async () => ({ ok: true as const, entries: [{ name: 'a\u202Ebc.txt', kind: 'file' as const }, { name: 'x\u2066y.md', kind: 'file' as const }] })),
    });
    const wrapper = mount(FilesSection, {
      props: { api, projectKey: 'home', projectName: 'Home', platform: 'win32', projectPlatform: 'win32', trash: true, collapsed: false },
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
      props: { api, projectKey: worktreeKey, projectName: 'alpha', platform: 'win32', projectPlatform: 'win32', trash: true, collapsed: false, shown: shown(worktreeKey) },
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

describe('Files Open as project', () => {
  const PROJECT: ShownFolder = { projectKey: 'home', root: { projectKey: 'home' }, rootKey: 'home', fsPath: '/w/home', canShowWorktree: false };
  const menuOf = async (wrapper: VueWrapper, api: FakeShellApi, path: string): Promise<string[]> => {
    await row(wrapper, path).trigger('contextmenu', { clientX: 10, clientY: 10 });
    await flushPromises();
    const request = api.overlayRequests.at(-1);
    return request?.kind === 'menu' ? request.items.flatMap((item) => (item.kind === 'item' ? [item.id] : [])) : [];
  };

  it('opens a folder of the project folder as its own project', async () => {
    const { wrapper, api } = await mountFiles({ shown: PROJECT });
    api.answerNext({ kind: 'menu', itemId: 'openAsProject' });
    expect(await menuOf(wrapper, api, 'src')).toContain('openAsProject');
    expect(api.openAsProject).toHaveBeenCalledWith({ projectKey: 'home', relativePath: 'src' });
  });

  it('offers it on folders only, naming the shown folder by its root key', async () => {
    const { wrapper, api } = await mountFiles({ shown: PROJECT });
    expect(await menuOf(wrapper, api, 'notes.txt')).not.toContain('openAsProject');
    const worktree = await mountFiles({ projectKey: 'home|w1', shown: { ...PROJECT, rootKey: 'home|w1', root: { projectKey: 'home', worktreeId: 'w1' } } });
    worktree.api.answerNext({ kind: 'menu', itemId: 'openAsProject' });
    expect(await menuOf(worktree.wrapper, worktree.api, 'src')).toContain('openAsProject');
    expect(worktree.api.openAsProject).toHaveBeenCalledWith({ projectKey: 'home|w1', relativePath: 'src' });
  });
});

describe('Files Open preview for HTML', () => {
  const menuOf = async (wrapper: VueWrapper, api: FakeShellApi, path: string): Promise<string[]> => {
    await row(wrapper, path).trigger('contextmenu', { clientX: 10, clientY: 10 });
    await flushPromises();
    const request = api.overlayRequests.at(-1);
    return request?.kind === 'menu' ? request.items.flatMap((item) => (item.kind === 'item' ? [item.id] : [])) : [];
  };

  it('offers Open preview right after Open on .html and .htm files only, labelled as Markdown\'s', async () => {
    const { wrapper, api } = await mountFiles({ files: ['index.html', 'PAGE.HTM', 'notes.txt', 'todo.md'] });
    for (const path of ['index.html', 'PAGE.HTM']) {
      const items = await menuOf(wrapper, api, path);
      expect(items.slice(0, 3), path).toEqual(['open', 'openPreview', 'focusOverlay']);
    }
    const request = api.overlayRequests.at(-1);
    const label = request?.kind === 'menu' ? request.items.find((item) => item.kind === 'item' && item.id === 'openPreview') : undefined;
    expect(label?.kind === 'item' && label.label).toBe('Open preview');
    expect(await menuOf(wrapper, api, 'notes.txt')).not.toContain('openPreview');
    expect(await menuOf(wrapper, api, 'src')).not.toContain('openPreview');
    // Markdown keeps its own pair, preview first
    expect((await menuOf(wrapper, api, 'todo.md')).slice(0, 2)).toEqual(['openPreview', 'openSource']);
  });

  it('offers no Open preview for a page the preview would not serve: none inside a dot folder but .well-known', async () => {
    const { wrapper, api } = await mountFiles({ folders: ['.vitepress', '.well-known'], files: ['index.html'] });
    for (const folder of ['.vitepress', '.well-known']) {
      await row(wrapper, folder).trigger('click');
      await flushPromises();
    }
    expect(await menuOf(wrapper, api, '.vitepress/index.html')).not.toContain('openPreview');
    expect(await menuOf(wrapper, api, '.well-known/index.html')).toContain('openPreview');
    expect(await menuOf(wrapper, api, 'index.html')).toContain('openPreview');
  });

  it('opens the preview from the menu, while a click on the file opens its code', async () => {
    const { wrapper, api } = await mountFiles({ files: ['index.html'] });
    api.answerNext({ kind: 'menu', itemId: 'openPreview' });
    await menuOf(wrapper, api, 'index.html');
    expect(api.openEditor).toHaveBeenLastCalledWith({ projectKey: 'home', relativePath: 'index.html', as: 'preview' });
    await row(wrapper, 'index.html').trigger('click');
    await flushPromises();
    expect(api.openEditor).toHaveBeenLastCalledWith({ projectKey: 'home', relativePath: 'index.html' });
  });
});

// A drag's DataTransfer as Chromium shows it to dragover: the types, and the data only once dropped.
function dataTransfer(types: string[], data: Record<string, string> = {}, files: File[] = []) {
  return {
    types,
    files,
    dropEffect: 'none' as DataTransfer['dropEffect'],
    effectAllowed: 'uninitialized' as DataTransfer['effectAllowed'],
    set: {} as Record<string, string>,
    getData: (type: string) => data[type] ?? '',
    setData(type: string, value: string) { this.set[type] = value; },
    setDragImage: vi.fn(),
  };
}

type FakeTransfer = ReturnType<typeof dataTransfer>;

function drag(target: Element, type: string, transfer: FakeTransfer, init: { ctrlKey?: boolean; altKey?: boolean; relatedTarget?: Element | null; clientY?: number } = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: transfer },
    ctrlKey: { value: init.ctrlKey ?? false },
    altKey: { value: init.altKey ?? false },
    relatedTarget: { value: init.relatedTarget ?? null },
    clientY: { value: init.clientY ?? 0 },
  });
  target.dispatchEvent(event);
  return event;
}

// Main's Edit menu turns Ctrl+X, C and V (Cmd on macOS), and a menu pick of Cut, Copy or Paste, into these on the focused element.
function clipboard(target: Element, type: 'cut' | 'copy' | 'paste', files: File[] = []): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files } });
  target.dispatchEvent(event);
  return event;
}

const tree = (wrapper: VueWrapper) => wrapper.get('[data-testid="files-tree"]').element;
const rowElement = (wrapper: VueWrapper, path: string) => row(wrapper, path).element;
const highlighted = (wrapper: VueWrapper): string | null => {
  if (wrapper.find('[data-testid="files-drop-root"]').exists()) return '';
  const shown = wrapper.find('[data-testid="files-drop-highlight"]');
  return shown.exists() ? (shown.element.closest('[data-tree-path]')?.getAttribute('data-tree-path') ?? null) : null;
};
const ROW_PAYLOAD = (relativePath: string) => JSON.stringify({ projectKey: 'home', relativePath });

describe('Files drop target', () => {
  it('highlights the folder under an OS file drag, or the project folder over empty space and beside top-level files', async () => {
    const { wrapper } = await mountFiles();
    const files = dataTransfer(['Files']);
    const over = drag(rowElement(wrapper, 'src'), 'dragover', files);
    await wrapper.vm.$nextTick();
    expect(over.defaultPrevented).toBe(true);
    expect(files.dropEffect).toBe('copy');
    expect(highlighted(wrapper)).toBe('src');
    expect(wrapper.get('[data-testid="files-drop-highlight"]').classes()).toContain('d-fade-in');
    expect(wrapper.get('[data-testid="files-drop-hint"]').text()).toBe('Copy to src');

    drag(rowElement(wrapper, 'notes.txt'), 'dragover', files);
    await wrapper.vm.$nextTick();
    expect(highlighted(wrapper)).toBe('');
    drag(tree(wrapper), 'dragover', files);
    await wrapper.vm.$nextTick();
    expect(highlighted(wrapper)).toBe('');
    expect(wrapper.get('[data-testid="files-drop-hint"]').text()).toBe('Copy to Home');

    // leaving one row for another keeps it; leaving the tree clears it
    drag(rowElement(wrapper, 'notes.txt'), 'dragleave', files, { relatedTarget: rowElement(wrapper, 'todo.md') });
    await wrapper.vm.$nextTick();
    expect(highlighted(wrapper)).toBe('');
    drag(tree(wrapper), 'dragleave', files, { relatedTarget: document.body });
    await wrapper.vm.$nextTick();
    expect(highlighted(wrapper)).toBeNull();
  });

  it('opens a closed folder held under a drag for 800 ms, and not one the drag left sooner', async () => {
    const { wrapper, api } = await mountFiles();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vi.mocked(api.listFiles).mockClear();
      const files = dataTransfer(['Files']);
      drag(rowElement(wrapper, 'src'), 'dragover', files);
      vi.advanceTimersByTime(700);
      drag(rowElement(wrapper, 'notes.txt'), 'dragover', files);
      drag(rowElement(wrapper, 'src'), 'dragover', files);
      vi.advanceTimersByTime(799);
      // dragover repeats while the pointer rests there; the wait does not start again
      drag(rowElement(wrapper, 'src'), 'dragover', files);
      expect(api.listFiles).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await flushPromises();
      expect(api.listFiles).toHaveBeenCalledWith({ projectKey: 'home', relativeDir: 'src', report: true });
      expect(row(wrapper, 'src').attributes('aria-expanded')).toBe('true');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never opens a folder held under a drag that cannot drop there, such as a folder over itself', async () => {
    const { wrapper, api } = await mountFiles();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vi.mocked(api.listFiles).mockClear();
      drag(rowElement(wrapper, 'src'), 'dragstart', dataTransfer([]));
      const folder = dataTransfer([FILES_ROW_DRAG_MIME], { [FILES_ROW_DRAG_MIME]: ROW_PAYLOAD('src') });
      for (const ctrlKey of [false, true]) drag(rowElement(wrapper, 'src'), 'dragover', folder, { ctrlKey });
      vi.advanceTimersByTime(800);
      await flushPromises();
      expect(api.listFiles).not.toHaveBeenCalled();
      expect(row(wrapper, 'src').attributes('aria-expanded')).toBe('false');
      // a wait that began where the drop was allowed ends where it is not
      drag(rowElement(wrapper, 'notes.txt'), 'dragstart', dataTransfer([]));
      const file = dataTransfer([FILES_ROW_DRAG_MIME], { [FILES_ROW_DRAG_MIME]: ROW_PAYLOAD('notes.txt') });
      drag(rowElement(wrapper, 'src'), 'dragover', file);
      vi.advanceTimersByTime(700);
      drag(rowElement(wrapper, 'todo.md'), 'dragover', file);
      vi.advanceTimersByTime(800);
      await flushPromises();
      expect(api.listFiles).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('copies dropped OS files into the folder under the pointer, counting the ones with no disk path', async () => {
    const { wrapper, api } = await mountFiles();
    const dropped = [new File(['a'], 'a.png'), new File(['b'], 'cat.png'), new File([], 'assets')];
    vi.mocked(api.pathsForFiles).mockReturnValueOnce(['C:\\Users\\me\\a.png', '', 'C:\\Users\\me\\assets']);
    const files = dataTransfer(['Files'], {}, dropped);
    drag(rowElement(wrapper, 'src'), 'dragover', files);
    const drop = drag(rowElement(wrapper, 'src'), 'drop', files);
    await flushPromises();
    expect(drop.defaultPrevented).toBe(true);
    expect(api.pathsForFiles).toHaveBeenCalledWith(dropped);
    expect(api.copyFilesIn).toHaveBeenCalledWith({ projectKey: 'home', relativeDir: 'src', paths: ['C:\\Users\\me\\a.png', 'C:\\Users\\me\\assets'], withoutPath: 1, origin: 'drop' });
    expect(highlighted(wrapper)).toBeNull();
    // the folder that took the copy opens
    expect(row(wrapper, 'src').attributes('aria-expanded')).toBe('true');
  });

  it('drags a row as a Files row, and a file also as a chat mention, to copy or move', async () => {
    const { wrapper } = await mountFiles();
    const file = dataTransfer([]);
    drag(rowElement(wrapper, 'notes.txt'), 'dragstart', file);
    expect(file.set).toEqual({ [FILES_ROW_DRAG_MIME]: ROW_PAYLOAD('notes.txt'), [FILE_DRAG_MIME]: ROW_PAYLOAD('notes.txt') });
    expect(file.effectAllowed).toBe('copyMove');
    const folder = dataTransfer([]);
    drag(rowElement(wrapper, 'src'), 'dragstart', folder);
    expect(folder.set).toEqual({ [FILES_ROW_DRAG_MIME]: ROW_PAYLOAD('src') });
  });

  it('moves a dropped row into the folder, and copies it with Ctrl held', async () => {
    const { wrapper, api } = await mountFiles();
    for (const ctrlKey of [false, true]) {
      drag(rowElement(wrapper, 'notes.txt'), 'dragstart', dataTransfer([]));
      const transfer = dataTransfer([FILES_ROW_DRAG_MIME, FILE_DRAG_MIME], { [FILES_ROW_DRAG_MIME]: ROW_PAYLOAD('notes.txt') });
      drag(rowElement(wrapper, 'src'), 'dragover', transfer, { ctrlKey });
      expect(transfer.dropEffect).toBe(ctrlKey ? 'copy' : 'move');
      await wrapper.vm.$nextTick();
      expect(wrapper.get('[data-testid="files-drop-hint"]').text()).toBe(ctrlKey ? 'Copy to src' : 'Move to src');
      drag(rowElement(wrapper, 'src'), 'drop', transfer, { ctrlKey });
      await flushPromises();
      expect(api.dropFilesRow).toHaveBeenLastCalledWith({ from: { projectKey: 'home', relativePath: 'notes.txt' }, toDir: { projectKey: 'home', relativePath: 'src' }, copy: ctrlKey });
    }
    expect(api.dropFilesRow).toHaveBeenCalledTimes(2);
  });

  it('takes a row drag that left the tree and came back, since only its dragend ends it', async () => {
    const { wrapper, api } = await mountFiles();
    drag(rowElement(wrapper, 'notes.txt'), 'dragstart', dataTransfer([]));
    const transfer = dataTransfer([FILES_ROW_DRAG_MIME], { [FILES_ROW_DRAG_MIME]: ROW_PAYLOAD('notes.txt') });
    drag(rowElement(wrapper, 'src'), 'dragover', transfer);
    drag(tree(wrapper), 'dragleave', transfer, { relatedTarget: document.body });
    expect(drag(rowElement(wrapper, 'src'), 'dragover', transfer).defaultPrevented).toBe(true);
    drag(rowElement(wrapper, 'src'), 'drop', transfer);
    await flushPromises();
    expect(api.dropFilesRow).toHaveBeenCalledWith({ from: { projectKey: 'home', relativePath: 'notes.txt' }, toDir: { projectKey: 'home', relativePath: 'src' }, copy: false });
  });

  it('copies with Option on macOS, where Ctrl does not', async () => {
    const { wrapper, api } = await mountFiles({ platform: 'darwin' });
    for (const [init, copy] of [[{ ctrlKey: true }, false], [{ altKey: true }, true]] as const) {
      drag(rowElement(wrapper, 'notes.txt'), 'dragstart', dataTransfer([]));
      const transfer = dataTransfer([FILES_ROW_DRAG_MIME], { [FILES_ROW_DRAG_MIME]: ROW_PAYLOAD('notes.txt') });
      drag(rowElement(wrapper, 'src'), 'dragover', transfer, init);
      drag(rowElement(wrapper, 'src'), 'drop', transfer, init);
      await flushPromises();
      expect(api.dropFilesRow).toHaveBeenLastCalledWith(expect.objectContaining({ copy }));
    }
  });

  it('refuses moving a row into the folder it is in and a folder into itself, while Ctrl copies a row beside itself', async () => {
    const { wrapper, api } = await mountFiles();
    drag(rowElement(wrapper, 'notes.txt'), 'dragstart', dataTransfer([]));
    const transfer = dataTransfer([FILES_ROW_DRAG_MIME], { [FILES_ROW_DRAG_MIME]: ROW_PAYLOAD('notes.txt') });
    const over = drag(rowElement(wrapper, 'todo.md'), 'dragover', transfer);
    await wrapper.vm.$nextTick();
    expect(over.defaultPrevented).toBe(false);
    expect(transfer.dropEffect).toBe('none');
    expect(highlighted(wrapper)).toBeNull();
    expect(drag(rowElement(wrapper, 'todo.md'), 'dragover', transfer, { ctrlKey: true }).defaultPrevented).toBe(true);

    drag(rowElement(wrapper, 'src'), 'dragstart', dataTransfer([]));
    const folder = dataTransfer([FILES_ROW_DRAG_MIME], { [FILES_ROW_DRAG_MIME]: ROW_PAYLOAD('src') });
    expect(drag(rowElement(wrapper, 'src'), 'dragover', folder, { ctrlKey: true }).defaultPrevented).toBe(false);
    drag(rowElement(wrapper, 'src'), 'drop', folder, { ctrlKey: true });
    await flushPromises();
    expect(api.dropFilesRow).not.toHaveBeenCalled();
  });

  it('takes no drop while the host\'s Damocles server cannot copy files, and says why under the pointer instead', async () => {
    const { wrapper, api } = await mountFiles({ transfersUnsupportedOn: 'prod-1' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vi.mocked(api.listFiles).mockClear();
      const files = dataTransfer(['Files'], {}, [new File(['a'], 'a.png')]);
      drag(rowElement(wrapper, 'notes.txt'), 'dragstart', dataTransfer([]));
      const ownRow = dataTransfer([FILES_ROW_DRAG_MIME], { [FILES_ROW_DRAG_MIME]: ROW_PAYLOAD('notes.txt') });
      for (const transfer of [files, ownRow]) {
        for (const type of ['dragenter', 'dragover']) expect(drag(rowElement(wrapper, 'src'), type, transfer, { ctrlKey: true }).defaultPrevented).toBe(false);
        expect(transfer.dropEffect).toBe('none');
        await wrapper.vm.$nextTick();
        expect(highlighted(wrapper)).toBeNull();
        const hint = wrapper.get('[data-testid="files-drop-hint"]');
        expect(hint.attributes('data-action')).toBe('refused');
        expect(hint.text()).toBe('The Damocles server on prod-1 is too old to copy files. Reconnect to update it.');
        expect(drag(rowElement(wrapper, 'src'), 'drop', transfer, { ctrlKey: true }).defaultPrevented).toBe(false);
        await wrapper.vm.$nextTick();
        expect(wrapper.find('[data-testid="files-drop-hint"]').exists()).toBe(false);
      }
      // a closed folder held under the refused drag stays closed
      drag(rowElement(wrapper, 'src'), 'dragover', files);
      vi.advanceTimersByTime(800);
      await flushPromises();
      expect(api.listFiles).not.toHaveBeenCalled();
      expect(api.copyFilesIn).not.toHaveBeenCalled();
      expect(api.dropFilesRow).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes no drag of an editor tab, a source control row or page text, which keep their meaning elsewhere', async () => {
    const { wrapper, api } = await mountFiles();
    for (const types of [[FILE_DRAG_MIME], [FILE_DRAG_MIME, 'text/plain'], ['text/plain', 'text/uri-list']]) {
      const transfer = dataTransfer(types, { [FILE_DRAG_MIME]: ROW_PAYLOAD('notes.txt') });
      for (const type of ['dragenter', 'dragover']) expect(drag(rowElement(wrapper, 'src'), type, transfer).defaultPrevented, `${type} ${types.join()}`).toBe(false);
      await wrapper.vm.$nextTick();
      expect(highlighted(wrapper)).toBeNull();
      expect(drag(rowElement(wrapper, 'src'), 'drop', transfer).defaultPrevented).toBe(false);
    }
    await flushPromises();
    expect(api.dropFilesRow).not.toHaveBeenCalled();
    expect(api.copyFilesIn).not.toHaveBeenCalled();
  });

  it('ignores a row drop whose payload is not exactly a valid one, or names another row than the one dragged', async () => {
    const { wrapper, api } = await mountFiles();
    for (const payload of ['', '{"projectKey":"home","relativePath":"../x"}', '{"projectKey":"home"}', 'notes.txt', ROW_PAYLOAD('todo.md'), JSON.stringify({ projectKey: 'other', relativePath: 'notes.txt' })]) {
      drag(rowElement(wrapper, 'notes.txt'), 'dragstart', dataTransfer([]));
      const transfer = dataTransfer([FILES_ROW_DRAG_MIME], { [FILES_ROW_DRAG_MIME]: payload });
      drag(rowElement(wrapper, 'src'), 'dragover', transfer);
      expect(drag(rowElement(wrapper, 'src'), 'drop', transfer).defaultPrevented, payload).toBe(false);
    }
    await flushPromises();
    expect(api.dropFilesRow).not.toHaveBeenCalled();
  });

  it('takes no row drag this tree did not start, such as one another app or a web page made with the same type', async () => {
    const { wrapper, api } = await mountFiles();
    const forged = dataTransfer([FILES_ROW_DRAG_MIME], { [FILES_ROW_DRAG_MIME]: ROW_PAYLOAD('notes.txt') });
    for (const type of ['dragenter', 'dragover']) expect(drag(rowElement(wrapper, 'src'), type, forged, { ctrlKey: true }).defaultPrevented).toBe(false);
    await wrapper.vm.$nextTick();
    expect(highlighted(wrapper)).toBeNull();
    expect(drag(rowElement(wrapper, 'src'), 'drop', forged, { ctrlKey: true }).defaultPrevented).toBe(false);
    // a row drag of this tree that ended no longer vouches for a later one
    drag(rowElement(wrapper, 'notes.txt'), 'dragstart', dataTransfer([]));
    drag(rowElement(wrapper, 'notes.txt'), 'dragend', dataTransfer([]));
    expect(drag(rowElement(wrapper, 'src'), 'dragover', forged).defaultPrevented).toBe(false);
    expect(drag(rowElement(wrapper, 'src'), 'drop', forged).defaultPrevented).toBe(false);
    await flushPromises();
    expect(api.dropFilesRow).not.toHaveBeenCalled();
  });
});

// happy-dom lays nothing out: the tree spans y 100-300 and scrolls 0-800. The edge zones are 35px at the 16px root.
function scrollableTree(wrapper: VueWrapper): { scrollTop: number } {
  const element = tree(wrapper);
  const state = { scrollTop: 400 };
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 200 },
    scrollTop: { configurable: true, get: () => state.scrollTop, set: (value: number) => { state.scrollTop = value; } },
  });
  element.getBoundingClientRect = () => ({ top: 100, bottom: 300, left: 0, right: 200, width: 200, height: 200, x: 0, y: 100, toJSON: () => ({}) });
  return state;
}

// How far the tree scrolled over `frames` animation frames.
function scrolledOver(state: { scrollTop: number }, frames: number): number {
  const before = state.scrollTop;
  for (let i = 0; i < frames; i++) vi.advanceTimersToNextFrame();
  return state.scrollTop - before;
}

describe('Files drag auto-scroll', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('scrolls while a drag is held in the top or bottom edge zone, and not in the middle', async () => {
    const { wrapper } = await mountFiles();
    const state = scrollableTree(wrapper);
    const files = dataTransfer(['Files']);
    drag(tree(wrapper), 'dragover', files, { clientY: 200 });
    expect(scrolledOver(state, 3)).toBe(0);
    drag(tree(wrapper), 'dragover', files, { clientY: 299 });
    expect(scrolledOver(state, 3)).toBeGreaterThan(0);
    drag(tree(wrapper), 'dragover', files, { clientY: 101 });
    expect(scrolledOver(state, 3)).toBeLessThan(0);
  });

  it('scrolls over a spot that takes no drop, so the drag can reach one that does', async () => {
    const { wrapper } = await mountFiles();
    const state = scrollableTree(wrapper);
    drag(rowElement(wrapper, 'notes.txt'), 'dragstart', dataTransfer([]));
    const transfer = dataTransfer([FILES_ROW_DRAG_MIME], { [FILES_ROW_DRAG_MIME]: ROW_PAYLOAD('notes.txt') });
    expect(drag(rowElement(wrapper, 'todo.md'), 'dragover', transfer, { clientY: 299 }).defaultPrevented).toBe(false);
    expect(scrolledOver(state, 3)).toBeGreaterThan(0);
  });

  it('stops on a drop, on leaving the tree and when the row drag ends', async () => {
    const { wrapper } = await mountFiles();
    const state = scrollableTree(wrapper);
    const ends: Array<[string, () => void]> = [
      ['drop', () => drag(tree(wrapper), 'drop', dataTransfer(['Files']), { clientY: 299 })],
      ['dragleave', () => drag(tree(wrapper), 'dragleave', dataTransfer(['Files']), { relatedTarget: document.body })],
      ['dragend', () => drag(rowElement(wrapper, 'notes.txt'), 'dragend', dataTransfer([]))],
    ];
    for (const [name, end] of ends) {
      drag(rowElement(wrapper, 'notes.txt'), 'dragstart', dataTransfer([]));
      const transfer = name === 'dragend' ? dataTransfer([FILES_ROW_DRAG_MIME], { [FILES_ROW_DRAG_MIME]: ROW_PAYLOAD('notes.txt') }) : dataTransfer(['Files']);
      drag(tree(wrapper), 'dragover', transfer, { clientY: 299 });
      expect(scrolledOver(state, 2), name).toBeGreaterThan(0);
      end();
      expect(scrolledOver(state, 3), name).toBe(0);
    }
  });

  it('keeps scrolling when the drag leaves one row for another inside the tree', async () => {
    const { wrapper } = await mountFiles();
    const state = scrollableTree(wrapper);
    const files = dataTransfer(['Files']);
    drag(rowElement(wrapper, 'todo.md'), 'dragover', files, { clientY: 299 });
    drag(rowElement(wrapper, 'todo.md'), 'dragleave', files, { relatedTarget: rowElement(wrapper, 'notes.txt') });
    expect(scrolledOver(state, 3)).toBeGreaterThan(0);
  });

  it('hides the tree\'s overflow only while the drag is in an edge zone, so Chromium\'s own drag scroll stays off and the wheel stays on', async () => {
    const { wrapper } = await mountFiles();
    scrollableTree(wrapper);
    const files = dataTransfer(['Files']);
    const hidden = () => tree(wrapper).classList.contains('overflow-y-hidden!');
    for (const [y, held] of [[200, false], [299, true], [200, false], [101, true]] as const) {
      drag(tree(wrapper), 'dragover', files, { clientY: y });
      await wrapper.vm.$nextTick();
      expect(hidden(), `y ${y}`).toBe(held);
    }
    drag(tree(wrapper), 'dragleave', files, { relatedTarget: document.body });
    await wrapper.vm.$nextTick();
    expect(hidden()).toBe(false);
  });
});

describe('Files cut, copy and paste', () => {
  it('puts the focused row in the Files clipboard on Ctrl+X and Ctrl+C, leaving the OS clipboard empty', async () => {
    const { wrapper, api } = await mountFiles();
    expect(clipboard(rowElement(wrapper, 'notes.txt'), 'cut').defaultPrevented).toBe(true);
    expect(clipboard(rowElement(wrapper, 'src'), 'copy').defaultPrevented).toBe(true);
    expect(vi.mocked(api.setFilesClipboard).mock.calls).toEqual([
      [{ op: 'cut', ref: { projectKey: 'home', relativePath: 'notes.txt' } }],
      [{ op: 'copy', ref: { projectKey: 'home', relativePath: 'src' } }],
    ]);
  });

  it('pastes into the focused folder or the folder of the focused file: OS files through main\'s confirm, else the Files clipboard', async () => {
    const { wrapper, api } = await mountFiles();
    clipboard(rowElement(wrapper, 'src'), 'paste');
    clipboard(rowElement(wrapper, 'notes.txt'), 'paste');
    clipboard(tree(wrapper), 'paste');
    await flushPromises();
    expect(vi.mocked(api.pasteFiles).mock.calls).toEqual([
      [{ toDir: { projectKey: 'home', relativePath: 'src' } }],
      [{ toDir: { projectKey: 'home', relativePath: '' } }],
      [{ toDir: { projectKey: 'home', relativePath: '' } }],
    ]);
    const copied = [new File(['x'], 'report.pdf')];
    vi.mocked(api.pathsForFiles).mockReturnValueOnce(['C:\\Users\\me\\report.pdf']);
    expect(clipboard(rowElement(wrapper, 'src'), 'paste', copied).defaultPrevented).toBe(true);
    await flushPromises();
    expect(api.copyFilesIn).toHaveBeenCalledWith({ projectKey: 'home', relativeDir: 'src', paths: ['C:\\Users\\me\\report.pdf'], withoutPath: 0, origin: 'paste' });
    expect(api.pasteFiles).toHaveBeenCalledTimes(3);
  });

  it('leaves cut, copy and paste in the name box to the box', async () => {
    const { wrapper, api } = await mountFiles();
    await startRename(wrapper, 'notes.txt');
    for (const type of ['cut', 'copy', 'paste'] as const) expect(clipboard(input(wrapper).element, type).defaultPrevented).toBe(false);
    expect(api.setFilesClipboard).not.toHaveBeenCalled();
    expect(api.pasteFiles).not.toHaveBeenCalled();
  });

  it('dims the cut row until main says the cut is over, and Escape on the tree clears it', async () => {
    const { wrapper, api } = await mountFiles();
    (rowElement(wrapper, 'todo.md') as HTMLElement).focus();
    await row(wrapper, 'todo.md').trigger('keydown', { key: 'Escape' });
    expect(api.clearFilesClipboard).not.toHaveBeenCalled();

    api.filesClipboardChanged({ cut: { projectKey: 'home', relativePath: 'notes.txt' } });
    await wrapper.vm.$nextTick();
    expect(row(wrapper, 'notes.txt').attributes('data-cut')).toBeDefined();
    expect(row(wrapper, 'todo.md').attributes('data-cut')).toBeUndefined();
    // another project's cut dims nothing here
    api.filesClipboardChanged({ cut: { projectKey: 'other', relativePath: 'notes.txt' } });
    await wrapper.vm.$nextTick();
    expect(row(wrapper, 'notes.txt').attributes('data-cut')).toBeUndefined();

    api.filesClipboardChanged({ cut: { projectKey: 'home', relativePath: 'notes.txt' } });
    await row(wrapper, 'todo.md').trigger('keydown', { key: 'Escape' });
    expect(api.clearFilesClipboard).toHaveBeenCalledOnce();
    api.filesClipboardChanged({});
    await wrapper.vm.$nextTick();
    expect(row(wrapper, 'notes.txt').attributes('data-cut')).toBeUndefined();
  });
});

describe('Files transfer menu items', () => {
  const itemsOf = async (wrapper: VueWrapper, api: FakeShellApi, path: string | null) => {
    if (path === null) await wrapper.get('[data-testid="files-tree"]').trigger('contextmenu', { clientX: 5, clientY: 300 });
    else await row(wrapper, path).trigger('contextmenu', { clientX: 10, clientY: 10 });
    await flushPromises();
    const request = api.overlayRequests.at(-1);
    return request?.kind === 'menu' ? request.items.flatMap((item) => (item.kind === 'item' ? [item] : [])) : [];
  };

  it('offers Cut, Copy and Paste with their shortcuts, which main runs as the clipboard events, and Copy files here on folders', async () => {
    const { wrapper, api } = await mountFiles();
    const onFile = await itemsOf(wrapper, api, 'notes.txt');
    expect(onFile.filter((item) => item.clipboard)).toEqual([
      { kind: 'item', id: 'cut', label: 'Cut', icon: 'scissors', shortcut: 'Ctrl+X', clipboard: 'cut' },
      { kind: 'item', id: 'copy', label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', clipboard: 'copy' },
      { kind: 'item', id: 'paste', label: 'Paste', icon: 'clipboard-paste', shortcut: 'Ctrl+V', clipboard: 'paste' },
    ]);
    expect(onFile.map((item) => item.id)).not.toContain('copyHere');
    const onFolder = await itemsOf(wrapper, api, 'src');
    expect(onFolder.map((item) => item.id)).toEqual(expect.arrayContaining(['copyHere', 'cut', 'copy', 'paste']));
    const onRoot = await itemsOf(wrapper, api, null);
    expect(onRoot.map((item) => item.id)).toEqual(['newFile', 'newFolder', 'copyHere', 'paste']);
    const mac = await mountFiles({ platform: 'darwin' });
    expect((await itemsOf(mac.wrapper, mac.api, 'notes.txt')).filter((item) => item.clipboard).map((item) => item.shortcut)).toEqual(['⌘X', '⌘C', '⌘V']);
  });

  it('opens the OS picker for Copy files here on a folder and on the project folder', async () => {
    const { wrapper, api } = await mountFiles();
    api.answerNext({ kind: 'menu', itemId: 'copyHere' });
    await itemsOf(wrapper, api, 'src');
    api.answerNext({ kind: 'menu', itemId: 'copyHere' });
    await itemsOf(wrapper, api, null);
    expect(vi.mocked(api.pickFilesToCopyIn).mock.calls).toEqual([[{ projectKey: 'home', relativePath: 'src' }], [{ projectKey: 'home', relativePath: '' }]]);
  });

  it('offers Download only on a remote project, disabled while its host is offline', async () => {
    const local = await mountFiles();
    for (const path of ['notes.txt', 'src']) expect((await itemsOf(local.wrapper, local.api, path)).map((item) => item.id)).not.toContain('download');

    const remote = await mountFiles({ remote: true });
    for (const path of ['notes.txt', 'src']) {
      expect((await itemsOf(remote.wrapper, remote.api, path)).find((item) => item.id === 'download')).toEqual({ kind: 'item', id: 'download', label: 'Download...', icon: 'download' });
    }
    remote.api.answerNext({ kind: 'menu', itemId: 'download' });
    await itemsOf(remote.wrapper, remote.api, 'src');
    expect(remote.api.downloadFile).toHaveBeenCalledWith({ projectKey: 'home', relativePath: 'src' });

    const offline = await mountFiles({ remote: true, offline: true });
    expect((await itemsOf(offline.wrapper, offline.api, 'notes.txt')).find((item) => item.id === 'download')).toMatchObject({ disabled: true, disabledReason: 'Offline' });
  });

  it('turns Paste, Copy files here and Download off, saying why, while the host\'s Damocles server cannot copy files', async () => {
    const { wrapper, api } = await mountFiles({ remote: true, transfersUnsupportedOn: 'prod-1' });
    const reason = { disabled: true, disabledReason: 'Server too old' };
    const onFolder = await itemsOf(wrapper, api, 'src');
    expect(onFolder.find((item) => item.id === 'paste')).toMatchObject({ disabled: true });
    expect(onFolder.find((item) => item.id === 'copyHere')).toMatchObject(reason);
    expect(onFolder.find((item) => item.id === 'download')).toMatchObject(reason);
    const onRoot = await itemsOf(wrapper, api, null);
    expect(onRoot.find((item) => item.id === 'paste')).toMatchObject({ disabled: true });
    expect(onRoot.find((item) => item.id === 'copyHere')).toMatchObject(reason);
    // cut and copy only fill the Files clipboard, which main checks again at paste
    expect(onFolder.filter((item) => item.disabled).map((item) => item.id)).toEqual(['copyHere', 'paste', 'download']);
    const button = wrapper.get('[data-testid="files-copy-here"]');
    expect(button.attributes('disabled')).toBeDefined();
    const explanation = wrapper.get('[data-testid="files-transfers-unsupported"]');
    expect(explanation.text()).toBe('The Damocles server on prod-1 is too old to copy files. Reconnect to update it.');
    expect(button.attributes('title')).toBe(explanation.text());
    expect(button.attributes('aria-describedby')).toBe(explanation.attributes('id'));
    // the tree's description carries the reason for keyboard and screen reader users
    expect(document.getElementById(wrapper.get('[data-testid="files-tree"]').attributes('aria-describedby')!)?.textContent).toContain(explanation.text());
    // offline says Offline, the reason that applies first
    const offline = await mountFiles({ remote: true, offline: true, transfersUnsupportedOn: 'prod-1' });
    expect((await itemsOf(offline.wrapper, offline.api, 'notes.txt')).find((item) => item.id === 'download')).toMatchObject({ disabled: true, disabledReason: 'Offline' });
  });

  it('opens the project folder\'s menu from the keyboard on a tree with no rows', async () => {
    const { wrapper, api } = await mountFiles();
    vi.mocked(api.listFiles).mockResolvedValue({ ok: true, entries: [] });
    api.filesChanged({ projectKey: 'home', relativeDirs: [''] });
    await flushPromises();
    (tree(wrapper) as HTMLElement).focus();
    await wrapper.get('[data-testid="files-tree"]').trigger('keydown', { key: 'F10', shiftKey: true });
    await flushPromises();
    const request = api.overlayRequests.at(-1);
    expect(request?.kind === 'menu' && request.items.flatMap((item) => (item.kind === 'item' ? [item.id] : []))).toEqual(['newFile', 'newFolder', 'copyHere', 'paste']);
  });
});

describe('Files transfer row in the section', () => {
  it('gives focus back to the tree when the row leaves with its Cancel focused', async () => {
    const api = fakeShellApi([], {
      listFiles: vi.fn(async () => ({ ok: true as const, entries: [{ name: 'src', kind: 'dir' as const }, { name: 'todo.md', kind: 'file' as const }] })),
    });
    const wrapper = mount(FilesSection, {
      props: { api, projectKey: 'home', projectName: 'Home', platform: 'win32', projectPlatform: 'win32', trash: true, collapsed: false },
      global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: createEditorStore(api), [SCM_STORE]: createScmStore(api.scm) }, stubs: { transition: false } },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await flushPromises();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      (rowElement(wrapper, 'todo.md') as HTMLElement).focus();
      const base = { transferId: 3, projectKey: 'home', op: 'copy' as const, filesDone: 0, filesTotal: 2, bytesDone: 0, bytesTotal: 10 };
      api.filesTransferProgress({ ...base, state: 'running' });
      vi.advanceTimersByTime(150);
      await flushPromises();
      (wrapper.get('[data-testid="files-transfer-cancel"]').element as HTMLElement).focus();
      api.filesTransferProgress({ ...base, state: 'cancelled' });
      await flushPromises();
      expect(document.activeElement).toBe(rowElement(wrapper, 'todo.md'));
    } finally {
      vi.useRealTimers();
    }
  });
});
