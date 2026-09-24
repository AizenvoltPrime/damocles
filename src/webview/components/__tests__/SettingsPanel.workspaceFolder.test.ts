// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import SettingsPanel from '../SettingsPanel.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n } from '@/i18n';
import { at } from '@/__tests__/helpers';
import type { WorkspaceFolderInfo } from '@shared/types/workspace-folders';

const CLIENT: WorkspaceFolderInfo = { key: 'c:\\work\\client\\app', name: 'app', label: 'app (client)', path: 'C:\\work\\client\\app' };
const SERVER: WorkspaceFolderInfo = { key: 'c:\\work\\server\\app', name: 'app', label: 'app (server)', path: 'C:\\work\\server\\app' };

const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();

const mounted: VueWrapper[] = [];
let posted: { type: string }[] = [];

/** The auth panels inside the sheet post their own status requests on mount. */
const folderMessages = () => posted.filter((m) => m.type === 'setPanelWorkspaceFolder' || m.type === 'setDefaultWorkspaceFolder');

async function mountPanel(): Promise<VueWrapper> {
  const store = useSettingsStore();
  const wrapper = mount(SettingsPanel, {
    props: {
      settings: store.currentSettings,
      availableModels: [],
      visible: true,
      activeModel: '',
      defaultModel: '',
      panelThinking: null,
      panelThinkingModel: '',
      defaultThinking: null,
      defaultThinkingModel: '',
      voiceConfig: store.voiceConfig,
      voiceHasApiKey: false,
      exploreHasApiKey: false,
      exploreProvider: '',
      exploreModel: '',
      exploreEffort: '',
    },
    attachTo: document.body,
    global: { plugins: [i18n] },
  });
  mounted.push(wrapper);
  // Reka mounts the sheet's portalled content on the tick after mount.
  await nextTick();
  return wrapper;
}

/** Reka defers open and select across a custom event and its own `nextTick`, so one tick is not enough. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const press = (target: HTMLElement, key: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

/** The sheet renders through a portal, so the rows live on `document.body`, not under the wrapper. */
function trigger(row: 'panel' | 'default'): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[aria-labelledby="${row}-workspace-folder-label"]`);
}

function requireTrigger(row: 'panel' | 'default'): HTMLElement {
  const found = trigger(row);
  if (!found) throw new Error(`no ${row} workspace folder select is rendered`);
  return found;
}

async function pick(row: 'panel' | 'default', index: number): Promise<void> {
  press(requireTrigger(row), 'Enter');
  await flush();
  press(at(Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')), index), 'Enter');
  await flush();
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

describe('SettingsPanel workspace folder rows', () => {
  it.each([
    ['a single-folder window', [CLIENT]],
    ['a no-folder window, which sends only the home entry', [{ key: 'c:\\users\\me', name: 'me', label: 'me', path: 'C:\\Users\\me' }]],
    ['a panel that has not received its first update', []],
  ])('renders neither row in %s', async (_name, folders) => {
    const first = folders[0];
    useSettingsStore().setWorkspaceFolders(folders, first?.key ?? '', first?.key ?? '');
    await mountPanel();

    expect(trigger('panel')).toBeNull();
    expect(trigger('default')).toBeNull();
    expect(document.body.textContent).not.toContain(i18n.global.t('settings.workspaceFolder'));
  });

  it('renders both rows in a multi-root window, each showing the store key', async () => {
    useSettingsStore().setWorkspaceFolders([CLIENT, SERVER], SERVER.key, CLIENT.key);
    await mountPanel();

    expect(requireTrigger('panel').textContent).toContain('app (server)');
    expect(requireTrigger('default').textContent).toContain('app (client)');
  });

  it('lists every folder by label', async () => {
    useSettingsStore().setWorkspaceFolders([CLIENT, SERVER], CLIENT.key, CLIENT.key);
    await mountPanel();

    press(requireTrigger('panel'), 'Enter');
    await flush();
    const labels = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).map((o) => o.textContent?.trim());
    expect(labels).toEqual(['app (client)', 'app (server)']);
  });

  it('sends only the picked key for this panel', async () => {
    useSettingsStore().setWorkspaceFolders([CLIENT, SERVER], CLIENT.key, CLIENT.key);
    await mountPanel();

    await pick('panel', 1);

    expect(folderMessages()).toEqual([{ type: 'setPanelWorkspaceFolder', folderKey: SERVER.key }]);
  });

  it('sends only the picked key for new panels', async () => {
    useSettingsStore().setWorkspaceFolders([CLIENT, SERVER], CLIENT.key, CLIENT.key);
    await mountPanel();

    await pick('default', 1);

    expect(folderMessages()).toEqual([{ type: 'setDefaultWorkspaceFolder', folderKey: SERVER.key }]);
  });

  it('sends nothing when the current folder is picked again', async () => {
    useSettingsStore().setWorkspaceFolders([CLIENT, SERVER], CLIENT.key, CLIENT.key);
    await mountPanel();

    await pick('panel', 0);
    await pick('default', 0);

    expect(folderMessages()).toEqual([]);
  });

  // The extension answers a cancelled confirmation with the old key and no `switched`; the row must show that key.
  it('keeps showing the old folder after a pick until the extension confirms, and after a cancel', async () => {
    const store = useSettingsStore();
    store.setWorkspaceFolders([CLIENT, SERVER], CLIENT.key, CLIENT.key);
    await mountPanel();

    await pick('panel', 1);
    expect(requireTrigger('panel').textContent).toContain('app (client)');

    store.setWorkspaceFolders([CLIENT, SERVER], CLIENT.key, CLIENT.key);
    await flush();
    expect(requireTrigger('panel').textContent).toContain('app (client)');
    expect(requireTrigger('panel').textContent).not.toContain('app (server)');
  });

  it('shows the new folder once the extension confirms the switch', async () => {
    const store = useSettingsStore();
    store.setWorkspaceFolders([CLIENT, SERVER], CLIENT.key, CLIENT.key);
    await mountPanel();

    await pick('panel', 1);
    store.setWorkspaceFolders([CLIENT, SERVER], SERVER.key, CLIENT.key);
    await flush();

    expect(requireTrigger('panel').textContent).toContain('app (server)');
  });

  it('sends no second switch while one is pending, whichever entry point started it', async () => {
    const store = useSettingsStore();
    store.setWorkspaceFolders([CLIENT, SERVER], CLIENT.key, CLIENT.key);
    await mountPanel();

    // The header chip posts through the same store action as this row.
    store.requestPanelWorkspaceFolder(SERVER.key);
    await pick('panel', 1);
    expect(folderMessages()).toEqual([{ type: 'setPanelWorkspaceFolder', folderKey: SERVER.key }]);

    // A cancelled confirmation answers with the old key and ends the pending switch.
    store.setWorkspaceFolders([CLIENT, SERVER], CLIENT.key, CLIENT.key);
    await pick('panel', 1);
    expect(folderMessages()).toHaveLength(2);
  });

  it('hides both rows when the window drops back to one folder', async () => {
    const store = useSettingsStore();
    store.setWorkspaceFolders([CLIENT, SERVER], CLIENT.key, CLIENT.key);
    await mountPanel();
    expect(trigger('panel')).not.toBeNull();

    store.setWorkspaceFolders([CLIENT], CLIENT.key, CLIENT.key);
    await flush();

    expect(trigger('panel')).toBeNull();
    expect(trigger('default')).toBeNull();
  });
});
