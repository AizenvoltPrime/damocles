// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import MemoryPanel from '../MemoryPanel.vue';
import { useMemoryStore } from '@/stores/useMemoryStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n } from '@/i18n';
import type { WorkspaceFolderInfo } from '@shared/types/workspace-folders';

const CLIENT: WorkspaceFolderInfo = { key: 'c:\\work\\client\\app', name: 'app', label: 'app (client)', path: 'C:\\work\\client\\app' };
const SERVER: WorkspaceFolderInfo = { key: 'c:\\work\\server\\app', name: 'app', label: 'app (server)', path: 'C:\\work\\server\\app' };

const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();

const mounted: VueWrapper[] = [];
let posted: { type: string; [key: string]: unknown }[] = [];

function mountPanel(): VueWrapper {
  const wrapper = mount(MemoryPanel, {
    props: { notes: [], observations: [], searchResults: [], hasMoreObservations: false, loadingObservations: false },
    global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

/** What the workspaceFolderUpdate handler does to these two stores on a confirmed switch. */
async function switchFolder(to: WorkspaceFolderInfo): Promise<void> {
  useSettingsStore().setWorkspaceFolders([CLIENT, SERVER], to.key, CLIENT.key);
  useMemoryStore().clearFolderData();
  await nextTick();
}

const tabLabels = (wrapper: VueWrapper) => wrapper.findAll('button').map((b) => b.text()).filter((t) => t.startsWith('Results'));
const textarea = (wrapper: VueWrapper, placeholder: string) => wrapper.find<HTMLTextAreaElement>(`textarea[placeholder="${placeholder}"]`);

beforeEach(() => {
  setActivePinia(createPinia());
  useSettingsStore().setWorkspaceFolders([CLIENT, SERVER], CLIENT.key, CLIENT.key);
  posted = [];
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as { type: string }));
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  vi.restoreAllMocks();
});

describe('MemoryPanel after the panel switches folder', () => {
  it('drops the search it ran in the previous folder', async () => {
    const wrapper = mountPanel();
    const search = wrapper.find<HTMLInputElement>('input[placeholder="Search all memories..."]');
    await search.setValue('deploy');
    await search.trigger('keydown', { key: 'Enter' });
    expect(tabLabels(wrapper)).toHaveLength(1);

    await switchFolder(SERVER);
    await nextTick();

    expect(search.element.value).toBe('');
    expect(tabLabels(wrapper)).toEqual([]);
  });

  it('discards an unsaved project profile draft, so Save cannot write it into the new folder, and keeps a global one', async () => {
    const store = useMemoryStore();
    store.setProfile({ static: 'client profile', dynamic: '' }, { static: 'global profile', dynamic: '' });
    const wrapper = mountPanel();
    await wrapper.findAll('button').find((b) => b.text().includes('User Profile'))!.trigger('click');
    const project = textarea(wrapper, 'Stable facts about the user/project...');
    const global = textarea(wrapper, 'Stable facts that apply everywhere...');
    await project.setValue('client draft');
    await global.setValue('global draft');

    await switchFolder(SERVER);
    store.setProfile({ static: 'server profile', dynamic: '' }, { static: 'global profile', dynamic: '' });
    await nextTick();

    expect(project.element.value).toBe('server profile');
    expect(global.element.value).toBe('global draft');
  });
});
