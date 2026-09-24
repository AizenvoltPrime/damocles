// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import SessionPicker from '../SessionPicker.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n } from '@/i18n';
import type { StoredSession } from '@shared/types/session';
import type { WorkspaceFolderInfo } from '@shared/types/workspace-folders';

const CLIENT: WorkspaceFolderInfo = { key: 'c:\\work\\client\\app', name: 'app', label: 'app (client)', path: 'C:\\work\\client\\app' };
const SERVER: WorkspaceFolderInfo = { key: 'c:\\work\\server\\app', name: 'app', label: 'app (server)', path: 'C:\\work\\server\\app' };

const SESSIONS: StoredSession[] = [
  { id: 's-server', timestamp: Date.now(), preview: 'Fix the API', workspaceFolder: { key: SERVER.key, label: SERVER.label } },
  { id: 's-client', timestamp: Date.now() - 1000, preview: 'Style the header', workspaceFolder: { key: CLIENT.key, label: CLIENT.label } },
];

const mounted: VueWrapper[] = [];

function mountPicker(sessions: StoredSession[] = SESSIONS): VueWrapper {
  const wrapper = mount(SessionPicker, {
    props: { sessions, selectedSessionId: null, selectedSessionName: null, hasMore: false, loading: false },
    global: { plugins: [i18n] },
  });
  mounted.push(wrapper);
  return wrapper;
}

const badges = (wrapper: VueWrapper) => wrapper.findAll('[data-testid="session-folder-badge"]');

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

describe('SessionPicker folder label', () => {
  it('labels every session with its folder when two or more folders are open', () => {
    useSettingsStore().setWorkspaceFolders([CLIENT, SERVER], CLIENT.key, CLIENT.key);
    const wrapper = mountPicker();

    const found = badges(wrapper);
    expect(found.map((b) => b.text())).toEqual(['app (server)', 'app (client)']);
    expect(found[0]!.attributes('title')).toBe(i18n.global.t('session.folderLabel', { folder: 'app (server)' }));
  });

  it.each([
    ['one folder', [CLIENT]],
    ['no folder update yet', []],
  ])('shows no label with %s open', (_name, folders) => {
    useSettingsStore().setWorkspaceFolders(folders, folders[0]?.key ?? '', folders[0]?.key ?? '');
    const wrapper = mountPicker();

    expect(badges(wrapper)).toHaveLength(0);
  });

  it('follows a folder being added to the window', async () => {
    const settings = useSettingsStore();
    settings.setWorkspaceFolders([CLIENT], CLIENT.key, CLIENT.key);
    const wrapper = mountPicker();
    expect(badges(wrapper)).toHaveLength(0);

    settings.setWorkspaceFolders([CLIENT, SERVER], CLIENT.key, CLIENT.key);
    await nextTick();

    expect(badges(wrapper)).toHaveLength(2);
  });

  it('shows no label on a session the extension did not attribute to a folder', () => {
    useSettingsStore().setWorkspaceFolders([CLIENT, SERVER], CLIENT.key, CLIENT.key);
    const wrapper = mountPicker([{ id: 's-bare', timestamp: Date.now(), preview: 'Bare' }]);

    expect(badges(wrapper)).toHaveLength(0);
  });
});
