// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, shallowRef } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import MemoryPanel from '../MemoryPanel.vue';
import { useMemoryStore } from '@/stores/useMemoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { i18n } from '@/i18n';
import type { ChatHost } from '@/composables/useChatHost';
import { useConnectionStore } from '@/stores/useConnectionStore';
import { useContextInjectionStore } from '@/stores/useContextInjectionStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useMemoryAuditStore } from '@/stores/useMemoryAuditStore';
import { createMemoryHandlers } from '@/composables/message-handler/handlers/memory-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';
import type { MemoryEntry } from '@shared/types/memory';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@shared/types/messages';
import type { ChatConnection } from '@shared/host-connection';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';

const posted = vi.hoisted((): WebviewToExtensionMessage[] => []);
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m), getState: () => undefined, setState: () => {} }),
}));

const toasts = vi.hoisted((): string[] => []);
vi.mock('vue-sonner', () => {
  const record = (text: string) => void toasts.push(text);
  return { toast: Object.assign(record, { success: record, error: record, info: record }) };
});

// A remote chat's page is one whose host main named; undefined is a local chat.
const chatHost = shallowRef<ChatHost | undefined>(undefined);
vi.mock('@/composables/useChatHost', async (original) => ({ ...await original<typeof import('@/composables/useChatHost')>(), useChatHost: () => chatHost }));

const REMOTE: ChatHost = { name: 'prod-1', computer: 'ALEXIOS-PC' };

function entry(id: string, over: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id, tier: 'project', kind: 'fact', scope: 'project', content: `content ${id}`, sessionId: null, workspace: null, createdAt: 1, updatedAt: 1, tags: [], ...over };
}
const userRow = (id: string, over: Partial<MemoryEntry> = {}) => entry(id, { tier: 'global', kind: 'preference', scope: 'global', updatedAt: 5, ...over });

const mounted: VueWrapper[] = [];

/** Wires the panel the way App.vue does: props from the memory store. */
function mountPanel(): VueWrapper {
  const store = useMemoryStore();
  const Host = defineComponent({
    setup: () => () => h(MemoryPanel, {
      notes: store.notes,
      observations: store.observations,
      searchResults: [],
      hasMoreObservations: store.hasMoreObservations,
      loadingObservations: store.loadingObservations,
    }),
  });
  const wrapper = mount(Host, { global: { plugins: [i18n], stubs: { MarkdownRenderer: true } }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

/** Delivers a core's reply through the page's own handler, as the message dispatcher does. */
async function deliver(msg: ExtensionToWebviewMessage): Promise<void> {
  const ctx = {
    stores: { memoryStore: useMemoryStore(), contextInjectionStore: useContextInjectionStore(), uiStore: useUIStore(), memoryAuditStore: useMemoryAuditStore(), settingsStore: useSettingsStore() },
    bridge: { postMessage: (m: WebviewToExtensionMessage) => posted.push(m) },
  } as unknown as HandlerContext;
  (createMemoryHandlers()[msg.type] as (m: ExtensionToWebviewMessage, c: HandlerContext) => void)(msg, ctx);
  await nextTick();
}

const action = (wrapper: VueWrapper, id: string, name: string) => wrapper.get(`[data-memory-id="${id}"] [data-memory-action="${name}"]`).trigger('click');
// the audit banner's own summary request is not a memory list's
const sent = () => posted.filter((m) => m.type !== 'requestMemoryAuditSummary');
const types = () => sent().map((m) => m.type);

const tierOption = (wrapper: VueWrapper, label: string) =>
  wrapper.get('[aria-label="Where the new memory goes"]').findAll('button').find((b) => b.text() === label)!;
const dialogContents = () => Array.from(document.body.querySelectorAll('[role="dialog"]'))
  .filter((dialog) => dialog.textContent?.includes('Earlier versions of this memory'))
  .flatMap((dialog) => Array.from(dialog.querySelectorAll('markdown-renderer-stub')).map((el) => el.getAttribute('content')));
// a Transition's leave ends on its own timer in happy-dom
const flushTransitions = () => new Promise((resolve) => setTimeout(resolve, 0)).then(() => nextTick());

async function saveProfile(wrapper: VueWrapper, key: string, text: string): Promise<void> {
  await wrapper.findAll('button').find((b) => b.text().includes('User Profile'))!.trigger('click');
  const area = wrapper.get(`#memory-profile-${key}`);
  await area.setValue(text);
  (area.element.parentElement!.querySelector('button') as HTMLButtonElement).click();
}

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
  toasts.length = 0;
  chatHost.value = undefined;
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

describe('MemoryPanel in a local chat', () => {
  it('asks only its own core, and sends a global row\'s actions and profile save there', async () => {
    useMemoryStore().setMemories([userRow('g1')]);
    const wrapper = mountPanel();
    await nextTick();
    expect(types()).toEqual(['requestMemories']);

    await action(wrapper, 'g1', 'forget');
    await action(wrapper, 'g1', 'history');
    await action(wrapper, 'g1', 'pin');
    await action(wrapper, 'g1', 'delete');
    await saveProfile(wrapper, 'globalStatic', 'prefers short answers');

    expect(sent().slice(1)).toEqual([
      { type: 'forgetMemory', id: 'g1', scope: 'chain' },
      { type: 'getMemoryHistory', id: 'g1' },
      { type: 'pinMemory', id: 'g1' },
      { type: 'deleteMemory', id: 'g1' },
      { type: 'getProfile' },
      { type: 'setProfileSection', scope: 'global', section: 'static', content: 'prefers short answers' },
    ]);
    expect(wrapper.find('[data-testid="memory-on-this-computer"]').exists()).toBe(false);
  });
});

describe('MemoryPanel in a remote chat', () => {
  it('asks the chat core for its list and this computer\'s core for its list and global profile', async () => {
    chatHost.value = REMOTE;
    mountPanel();
    await nextTick();
    expect(types()).toEqual(['requestMemories', 'requestUserMemories', 'getUserProfile']);
  });

  it('asks this computer\'s core once main names the host after the panel opened', async () => {
    mountPanel();
    await nextTick();
    expect(types()).toEqual(['requestMemories']);

    chatHost.value = REMOTE;
    await nextTick();
    expect(types()).toEqual(['requestMemories', 'requestUserMemories', 'getUserProfile']);
  });

  it('asks both cores again when focus is set on the open panel', async () => {
    chatHost.value = REMOTE;
    mountPanel();
    await nextTick();
    posted.length = 0;

    useUIStore().openMemoryPanel({ id: 'h1', kind: 'fact' });
    await nextTick();
    expect(types()).toEqual(['requestMemories', 'requestUserMemories', 'getUserProfile']);
  });

  it('sends a row\'s actions to the core whose list holds it', async () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    store.setMemories([entry('h1')]);
    store.setUserMemories([userRow('u1'), userRow('u2', { forgotten: true })], true);
    store.setShowForgotten(true);
    const wrapper = mountPanel();
    await nextTick();
    posted.length = 0;

    await action(wrapper, 'u1', 'forget');
    await action(wrapper, 'u2', 'restore');
    await action(wrapper, 'u1', 'history');
    await action(wrapper, 'u1', 'related');
    await action(wrapper, 'u1', 'pin');
    await action(wrapper, 'u2', 'delete');
    await action(wrapper, 'h1', 'forget');
    await action(wrapper, 'h1', 'history');
    await action(wrapper, 'h1', 'pin');
    await action(wrapper, 'h1', 'delete');

    expect(posted).toEqual([
      { type: 'forgetUserMemory', id: 'u1', scope: 'chain' },
      { type: 'unforgetUserMemory', id: 'u2', scope: 'chain' },
      { type: 'getUserMemoryHistory', id: 'u1' },
      { type: 'getUserRelatedMemories', id: 'u1' },
      { type: 'pinUserMemory', id: 'u1' },
      { type: 'deleteUserMemory', id: 'u2' },
      { type: 'forgetMemory', id: 'h1', scope: 'chain' },
      { type: 'getMemoryHistory', id: 'h1' },
      { type: 'pinMemory', id: 'h1' },
      { type: 'deleteMemory', id: 'h1' },
    ]);
  });

  it('marks this computer\'s rows, and its notes in the Notes tab', async () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    store.setMemories([entry('h1')]);
    store.setUserMemories([userRow('u1'), userRow('n1', { tier: 'note', kind: 'note' })], true);
    const wrapper = mountPanel();
    await nextTick();

    const marked = () => wrapper.findAll('[data-testid="memory-on-this-computer"]').map((chip) => chip.element.closest<HTMLElement>('[data-memory-id]')!.dataset.memoryId);
    expect(marked()).toEqual(['u1']);
    await wrapper.get('[data-tab="note"]').trigger('click');
    expect(marked()).toEqual(['n1']);
  });

  it('shows this computer\'s content on a card whose id a host row also uses, and acts on it by the *User* types', async () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    store.setMemories([entry('u1', { content: 'outdated, delete me' })]);
    store.setUserMemories([userRow('u1', { content: 'my preference' })], true);
    const wrapper = mountPanel();
    await nextTick();
    posted.length = 0;

    const cards = wrapper.findAll('[data-memory-id="u1"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.find('markdown-renderer-stub').attributes('content')).toBe('my preference');
    expect(cards[0]!.find('[data-testid="memory-on-this-computer"]').exists()).toBe(true);
    await action(wrapper, 'u1', 'forget');
    expect(sent()).toEqual([{ type: 'forgetUserMemory', id: 'u1', scope: 'chain' }]);
  });

  it('saves the global profile on this computer and the project profile on the chat core', async () => {
    chatHost.value = REMOTE;
    const wrapper = mountPanel();
    await nextTick();
    posted.length = 0;

    await saveProfile(wrapper, 'globalDynamic', 'working on the release');
    await wrapper.get('#memory-profile-projectStatic').setValue('a monorepo');
    (wrapper.get('#memory-profile-projectStatic').element.parentElement!.querySelector('button') as HTMLButtonElement).click();

    expect(posted).toEqual([
      { type: 'getProfile' },
      { type: 'getUserProfile' },
      { type: 'setUserProfileSection', section: 'dynamic', content: 'working on the release' },
      { type: 'setProfileSection', scope: 'project', section: 'static', content: 'a monorepo' },
    ]);
  });

  it('says memory is off on this computer from its core\'s real answers, still lists the host\'s rows, and toasts nothing', async () => {
    chatHost.value = REMOTE;
    const wrapper = mountPanel();
    await nextTick();
    const region = wrapper.get('[data-testid="memory-user-status"]');
    expect(region.attributes('role')).toBe('status');
    expect(region.text()).toBe('');

    await deliver({ type: 'memoriesUpdate', memories: [entry('h1')], observationCursor: null });
    await deliver({ type: 'userMemoriesUpdate', memories: [], available: false });
    await deliver({ type: 'userProfileData', global: { static: '', dynamic: '' }, available: false });

    expect(wrapper.get('[data-testid="memory-user-status"]').element).toBe(region.element);
    expect(region.text()).toContain('Memory is off on this computer.');
    expect(region.text()).toContain('Turn memory on here to see and manage your notes and global memories in this chat.');
    expect(wrapper.get('[data-testid="memory-user-off"]').attributes('role')).toBeUndefined();
    expect(wrapper.find('[data-memory-id="h1"]').exists()).toBe(true);
    await wrapper.get('[data-tab="note"]').trigger('click');
    expect(wrapper.text()).not.toContain('No notes yet.');
    expect(toasts).toEqual([]);
  });

  it('updates the notice and the controls when memory turns on here while the panel is open', async () => {
    chatHost.value = REMOTE;
    const wrapper = mountPanel();
    await deliver({ type: 'userMemoriesUpdate', memories: [], available: false });
    await deliver({ type: 'userProfileData', global: { static: '', dynamic: '' }, available: false });
    expect(wrapper.find('[data-testid="memory-user-off"]').exists()).toBe(true);

    await deliver({ type: 'userMemoriesUpdate', memories: [userRow('u1')], available: true });
    await deliver({ type: 'userProfileData', global: { static: 'mine', dynamic: '' }, available: true });
    await flushTransitions();

    expect(wrapper.find('[data-testid="memory-user-off"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="memory-user-status"]').attributes('role')).toBe('status');
    expect(wrapper.find('[data-memory-id="u1"]').exists()).toBe(true);
    expect(tierOption(wrapper, 'Global').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-testid="memory-tier-off"]').exists()).toBe(false);
  });

  it('keeps a pending global profile draft when the chat core claims to have saved the global section', async () => {
    chatHost.value = REMOTE;
    const wrapper = mountPanel();
    await deliver({ type: 'userProfileData', global: { static: 'saved here', dynamic: '' }, available: true });
    await saveProfile(wrapper, 'globalStatic', 'my draft');

    await deliver({ type: 'profileData', project: { static: '', dynamic: '' }, global: { static: 'host text', dynamic: '' }, savedSection: { scope: 'global', section: 'static' } });
    expect((wrapper.get('#memory-profile-globalStatic').element as HTMLTextAreaElement).value).toBe('my draft');

    await deliver({ type: 'userProfileSectionError', section: 'static', message: { message: 'Saving failed' } });
    await deliver({ type: 'userProfileData', global: { static: 'saved here', dynamic: '' }, available: true });
    expect((wrapper.get('#memory-profile-globalStatic').element as HTMLTextAreaElement).value).toBe('my draft');
  });

  it('disables Global and Note and the global profile while memory is off here, pointing to the notice', async () => {
    chatHost.value = REMOTE;
    const wrapper = mountPanel();
    await deliver({ type: 'userMemoriesUpdate', memories: [], available: false });

    expect(tierOption(wrapper, 'Global').attributes('disabled')).toBeDefined();
    expect(tierOption(wrapper, 'Note').attributes('disabled')).toBeDefined();
    expect(tierOption(wrapper, 'Project').attributes('disabled')).toBeUndefined();
    const hint = wrapper.get('[data-testid="memory-tier-off"]');
    expect(hint.text()).toContain('See the notice above.');
    expect(tierOption(wrapper, 'Project').element.closest('[aria-describedby]')?.getAttribute('aria-describedby')).toBe(hint.attributes('id'));

    await wrapper.get('[data-testid="memory-profile-toggle"]').trigger('click');
    for (const key of ['globalStatic', 'globalDynamic']) {
      const area = wrapper.get(`#memory-profile-${key}`);
      expect(area.attributes('disabled')).toBeDefined();
      expect(wrapper.get(`#${area.attributes('aria-describedby')}`).text()).toBe('Memory is off on this computer. See the notice above.');
      expect((area.element.parentElement!.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    }
    expect(wrapper.get('#memory-profile-projectStatic').attributes('disabled')).toBeUndefined();
  });

  it('keeps every create option and the global profile in a local chat', async () => {
    const wrapper = mountPanel();
    await nextTick();
    expect(tierOption(wrapper, 'Global').attributes('disabled')).toBeUndefined();
    expect(tierOption(wrapper, 'Note').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-testid="memory-profile-toggle"]').trigger('click');
    expect(wrapper.get('#memory-profile-globalStatic').attributes('disabled')).toBeUndefined();
  });

  it('shows the Notes tab loading until this computer\'s list arrives, and unavailable when its read failed, never empty', async () => {
    chatHost.value = REMOTE;
    const wrapper = mountPanel();
    await nextTick();
    await wrapper.get('[data-tab="note"]').trigger('click');
    expect(wrapper.find('[data-testid="memory-notes-loading"]').text()).toBe('Loading your notes from this computer...');
    expect(wrapper.text()).not.toContain('No notes yet.');

    await deliver({ type: 'userMemoryError', request: 'requestUserMemories', message: { message: 'The engine is not running' } });
    expect(wrapper.find('[data-testid="memory-notes-loading"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="memory-notes-unavailable"]').text()).toContain('could not be loaded');
    expect(wrapper.text()).not.toContain('No notes yet.');

    await deliver({ type: 'userMemoriesUpdate', memories: [], available: true });
    expect(wrapper.find('[data-testid="memory-notes-unavailable"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('No notes yet.');
  });

  it('shows the history and related answers of this computer\'s core for its row, never the chat core\'s', async () => {
    chatHost.value = REMOTE;
    const store = useMemoryStore();
    store.setMemories([entry('h1')]);
    store.setUserMemories([userRow('u1')], true);
    const wrapper = mountPanel();
    await nextTick();

    await action(wrapper, 'u1', 'history');
    await deliver({ type: 'memoryHistory', id: 'u1', entries: [userRow('u1', { content: 'host text' })] });
    expect(dialogContents()).toEqual([]);
    await deliver({ type: 'userMemoryHistory', id: 'u1', entries: [userRow('u1', { content: 'my first version' })] });
    expect(dialogContents()).toEqual(['my first version']);
  });

  it('reveals this computer\'s row for a relayed id once its list arrives, whatever the chat core answers', async () => {
    chatHost.value = REMOTE;
    useUIStore().openMemoryPanel({ id: 'global:client-1:u1', kind: 'preference' });
    const wrapper = mountPanel();
    await nextTick();

    await deliver({ type: 'memoriesUpdate', memories: [entry('h1'), userRow('global:client-1:u1')], observationCursor: null });
    expect(toasts).toEqual([]);
    expect(useUIStore().memoryPanelFocus).not.toBeNull();

    await deliver({ type: 'userMemoriesUpdate', memories: [userRow('u1')], available: true });
    await nextTick();
    expect(wrapper.get('[data-memory-id="u1"]').attributes('data-focused')).toBe('true');
    expect(useUIStore().memoryPanelFocus).toBeNull();
    expect(toasts).toEqual([]);
  });

  it('says a relayed id is not in the panel once this computer\'s list lacks it', async () => {
    chatHost.value = REMOTE;
    useUIStore().openMemoryPanel({ id: 'global:client-1:gone', kind: 'fact' });
    mountPanel();
    await nextTick();
    await deliver({ type: 'userMemoriesUpdate', memories: [userRow('u1')], available: true });
    expect(toasts).toEqual(['This memory is not in the memory panel. It may belong to another workspace, or it was removed.']);
  });

  it('asks the chat core for its list again when its view joins anew, which opens with hostCapabilities, only in a remote chat', async () => {
    const settings = useSettingsStore();
    mountPanel();
    await nextTick();
    posted.length = 0;
    settings.setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES });
    await nextTick();
    expect(sent()).toEqual([]);

    chatHost.value = REMOTE;
    await nextTick();
    posted.length = 0;
    settings.setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES });
    await nextTick();
    expect(sent()).toEqual([{ type: 'requestMemories' }]);
  });

  it('asks the chat core for its list again when the host reconnects', async () => {
    let push: ((next: ChatConnection) => void) | undefined;
    window.damoclesBridge = { getOffline: () => undefined, getHost: () => undefined, onHost: () => () => undefined, getConnection: () => undefined, onConnection: (listener: (next: ChatConnection) => void) => { push = listener; return () => undefined; } } as unknown as NonNullable<typeof window.damoclesBridge>;
    try {
      chatHost.value = REMOTE;
      useConnectionStore().attach();
      mountPanel();
      await nextTick();
      posted.length = 0;

      push!({ state: { phase: 'offline' }, queued: [] });
      await nextTick();
      expect(sent()).toEqual([]);
      push!({ state: { phase: 'connected' }, queued: [] });
      await nextTick();
      expect(sent()).toEqual([{ type: 'requestMemories' }]);
    } finally {
      delete (window as { damoclesBridge?: unknown }).damoclesBridge;
    }
  });
});
