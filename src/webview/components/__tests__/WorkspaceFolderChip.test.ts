// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// `vue3-lottie` runs canvas setup at import time, which happy-dom does not provide.
vi.mock('vue3-lottie', () => ({ Vue3Lottie: { name: 'Vue3Lottie', render: () => null } }));
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import App from '@/App.vue';
import WorkspaceFolderChip from '../WorkspaceFolderChip.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n } from '@/i18n';
import { at } from '@/__tests__/helpers';
import type { WorkspaceFolderInfo } from '@shared/types/workspace-folders';

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

const CLIENT: WorkspaceFolderInfo = { key: 'c:\\work\\client\\app', name: 'app', label: 'app (client)', path: 'C:\\work\\client\\app' };
const SERVER: WorkspaceFolderInfo = { key: 'c:\\work\\server\\app', name: 'app', label: 'app (server)', path: 'C:\\work\\server\\app' };

const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();

const mounted: VueWrapper[] = [];
let posted: { type: string }[] = [];

function mountChip(): VueWrapper {
  const wrapper = mount(WorkspaceFolderChip, { attachTo: document.body, global: { plugins: [i18n] } });
  mounted.push(wrapper);
  return wrapper;
}

/** Reka opens the menu across a custom event and its own `nextTick`. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Reka hands focus back to the trigger two timers after the menu unmounts. */
const settleClose = async () => {
  for (let i = 0; i < 3; i++) await flush();
};

function chip(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-testid="workspace-folder-chip"]');
}

function requireChip(): HTMLElement {
  const button = chip();
  if (!button) throw new Error('the workspace folder chip is not rendered');
  return button;
}

const press = (target: Element, key: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

function options(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid="workspace-folder-option"]'));
}

/** Reka's menu trigger opens on pointerdown or Enter, not click; the content is portalled to `document.body`. */
async function openChip(): Promise<HTMLElement[]> {
  requireChip().focus();
  press(requireChip(), 'Enter');
  await flush();
  return options();
}

async function mountMultiRoot(panelKey = SERVER.key): Promise<void> {
  useSettingsStore().setWorkspaceFolders([CLIENT, SERVER], panelKey, CLIENT.key);
  mountChip();
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  posted = [];
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as { type: string }));
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  vi.restoreAllMocks();
});

describe('WorkspaceFolderChip', () => {
  it.each([
    ['one folder', [CLIENT]],
    ['no update received yet', []],
  ])('is not rendered with %s', async (_name, folders) => {
    useSettingsStore().setWorkspaceFolders(folders, folders[0]?.key ?? '', folders[0]?.key ?? '');
    mountChip();
    await nextTick();

    expect(chip()).toBeNull();
  });

  it('shows the panel folder label in a multi-root window', async () => {
    await mountMultiRoot();

    expect(chip()?.textContent).toContain('app (server)');
    expect(chip()?.getAttribute('aria-label')).toBe(i18n.global.t('session.folderLabel', { folder: 'app (server)' }));
    expect(chip()?.getAttribute('aria-haspopup')).toBe('menu');
  });

  it('lists every folder as a radio item and checks the current one', async () => {
    await mountMultiRoot();

    const items = await openChip();

    expect(items.map((o) => o.textContent?.trim())).toEqual(['app (client)', 'app (server)']);
    expect(items.map((o) => o.getAttribute('role'))).toEqual(['menuitemradio', 'menuitemradio']);
    expect(items.map((o) => o.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(items.some((o) => o.hasAttribute('aria-current'))).toBe(false);
    expect(document.body.querySelector('[role="menu"] [role="group"]')?.getAttribute('aria-label')).toBe(i18n.global.t('settings.workspaceFolder'));
  });

  it('moves between folders with the arrow keys, Home and End', async () => {
    await mountMultiRoot();
    const items = await openChip();
    const menu = document.body.querySelector('[role="menu"]')!;

    press(menu, 'Home');
    await flush();
    expect(document.activeElement).toBe(at(items, 0));
    press(document.activeElement!, 'ArrowDown');
    await flush();
    expect(document.activeElement).toBe(at(items, 1));
    press(document.activeElement!, 'Home');
    await flush();
    expect(document.activeElement).toBe(at(items, 0));
    press(document.activeElement!, 'End');
    await flush();
    expect(document.activeElement).toBe(at(items, 1));
  });

  it('sends only the picked key, closes, and returns focus to the chip', async () => {
    await mountMultiRoot();

    at(await openChip(), 0).click();
    await settleClose();

    expect(posted).toEqual([{ type: 'setPanelWorkspaceFolder', folderKey: CLIENT.key }]);
    expect(options()).toEqual([]);
    expect(document.activeElement).toBe(chip());
  });

  it('sends nothing when the current folder is picked, and returns focus to the chip', async () => {
    await mountMultiRoot();

    at(await openChip(), 1).click();
    await settleClose();

    expect(posted).toEqual([]);
    expect(document.activeElement).toBe(chip());
  });

  it('is busy and will not open while the switch is pending, and recovers when the extension answers', async () => {
    await mountMultiRoot();
    at(await openChip(), 0).click();
    await flush();

    expect(chip()?.getAttribute('aria-busy')).toBe('true');
    expect(chip()?.getAttribute('aria-disabled')).toBe('true');
    expect(await openChip()).toEqual([]);

    // A cancelled confirmation answers with the old key and no `switched`.
    useSettingsStore().setWorkspaceFolders([CLIENT, SERVER], SERVER.key, CLIENT.key);
    await nextTick();

    expect(chip()?.hasAttribute('aria-busy')).toBe(false);
    expect(chip()?.hasAttribute('aria-disabled')).toBe(false);
    expect(await openChip()).toHaveLength(2);
  });

  it('follows the store, so it keeps the old label until the extension confirms a switch', async () => {
    const store = useSettingsStore();
    await mountMultiRoot();

    at(await openChip(), 0).click();
    await flush();
    expect(chip()?.textContent).toContain('app (server)');

    store.setWorkspaceFolders([CLIENT, SERVER], CLIENT.key, CLIENT.key);
    await nextTick();
    expect(chip()?.textContent).toContain('app (client)');
  });
});

describe('App header', () => {
  it('carries the chip only in a multi-root window', async () => {
    const store = useSettingsStore();
    const app = mount(App, { global: { plugins: [i18n] } });
    mounted.push(app);
    expect(app.findComponent(WorkspaceFolderChip).find('[data-testid="workspace-folder-chip"]').exists()).toBe(false);

    store.setWorkspaceFolders([CLIENT, SERVER], CLIENT.key, CLIENT.key);
    await nextTick();

    expect(app.findComponent(WorkspaceFolderChip).find('[data-testid="workspace-folder-chip"]').text()).toContain('app (client)');
  });
});
