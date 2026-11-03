// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import App from '@/App.vue';
import ToolsStatusPanel from '../ToolsStatusPanel.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import type { ToolsSnapshot } from '@shared/types/tools';
import { i18n } from '@/i18n';

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

let app: VueWrapper | null = null;
let posted: { type: string }[] = [];

// CompassFind is off by its own switch, so turning the group on must not turn it on.
const SNAPSHOT: ToolsSnapshot = {
  groups: [{ group: 'compass', enabled: true, available: true }, { group: 'web', enabled: true, available: true }],
  tools: [
    { name: 'CompassSearch', label: 'Compass search', group: 'compass', toggleable: true, enabled: true },
    { name: 'CompassFind', label: 'Compass find', group: 'compass', toggleable: true, enabled: false },
    { name: 'web_search', label: 'Web search', group: 'web', toggleable: true, enabled: true },
  ],
};

beforeEach(() => {
  setActivePinia(createPinia());
  posted = [];
  const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as { type: string }));
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function openTools(): Promise<VueWrapper> {
  app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
  await flushPromises();
  useSettingsStore().setToolsSnapshot(structuredClone(SNAPSHOT));
  useUIStore().openToolsPanel();
  await flushPromises();
  return app.findComponent(ToolsStatusPanel) as VueWrapper;
}

async function report(data: Record<string, unknown>): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'settingWriteResult', ...data } }));
  await flushPromises();
}

const failed = (key: string) => report({ key, ok: false, error: { message: 'EACCES: permission denied' } });
const group = (name: string) => useSettingsStore().toolsSnapshot.groups.find((entry) => entry.group === name)?.enabled;
const tool = (name: string) => useSettingsStore().toolsSnapshot.tools.find((entry) => entry.name === name)?.enabled;

const status = async (data: ToolsSnapshot): Promise<void> => {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'toolStatus', data } }));
  await flushPromises();
};
const statusRequests = () => posted.filter((message) => message.type === 'requestToolStatus');

describe('a Tools panel switch whose write fails', () => {
  it('puts the group back, changes no tool of it, and asks core for its status', async () => {
    const panel = await openTools();
    posted = [];
    panel.vm.$emit('toggleGroup', 'compass', false);
    await flushPromises();
    expect(posted).toContainEqual({ type: 'toggleToolGroup', group: 'compass', enabled: false });
    expect([group('compass'), tool('CompassSearch'), tool('CompassFind')]).toEqual([false, true, false]);

    await failed('damocles.compass.enabled');

    expect([group('compass'), tool('CompassSearch'), tool('CompassFind')]).toEqual([true, true, false]);
    expect(tool('web_search')).toBe(true);
    expect(statusRequests()).toHaveLength(1);
  });

  it('puts a single tool back', async () => {
    const panel = await openTools();
    panel.vm.$emit('toggle', 'web_search', false);
    await flushPromises();
    expect(posted).toContainEqual({ type: 'toggleTool', toolName: 'web_search', enabled: false });
    expect(tool('web_search')).toBe(false);

    await failed('damocles.tools.disabled');

    expect(tool('web_search')).toBe(true);
  });

  it('puts back each of several tools switched at once when every write fails', async () => {
    const panel = await openTools();
    for (const name of ['CompassSearch', 'web_search']) panel.vm.$emit('toggle', name, false);
    panel.vm.$emit('toggle', 'CompassFind', true);
    await flushPromises();
    expect([tool('CompassSearch'), tool('web_search'), tool('CompassFind')]).toEqual([false, false, true]);

    await failed('damocles.tools.disabled');
    // the first failure reverts only its own tool; the others keep showing their own writes
    expect([tool('CompassSearch'), tool('web_search'), tool('CompassFind')]).toEqual([true, false, true]);
    await failed('damocles.tools.disabled');
    await failed('damocles.tools.disabled');

    expect([tool('CompassSearch'), tool('web_search'), tool('CompassFind')]).toEqual([true, true, false]);
  });

  it('shows the status core posted while it was in flight, not the value it had when clicked', async () => {
    const panel = await openTools();
    panel.vm.$emit('toggle', 'web_search', false);
    await flushPromises();
    // another window turned it off meanwhile
    await status({ ...SNAPSHOT, tools: SNAPSHOT.tools.map((entry) => (entry.name === 'web_search' ? { ...entry, enabled: false } : entry)) });

    await failed('damocles.tools.disabled');

    expect(tool('web_search')).toBe(false);
  });
});

describe('a Tools panel switch whose write is in flight', () => {
  it('keeps its own value over a toolStatus that arrives first, and takes the rest of that status', async () => {
    const panel = await openTools();
    panel.vm.$emit('toggle', 'web_search', false);
    panel.vm.$emit('toggleGroup', 'compass', false);
    await flushPromises();

    await status({
      groups: SNAPSHOT.groups.map((entry) => (entry.group === 'web' ? { ...entry, enabled: false } : entry)),
      tools: SNAPSHOT.tools.map((entry) => (entry.name === 'CompassFind' ? { ...entry, enabled: true } : entry)),
    });

    expect([tool('web_search'), group('compass')]).toEqual([false, false]);
    expect([group('web'), tool('CompassFind')]).toEqual([false, true]);
  });

  it('keeps the new value when the write is saved, until core posts its status', async () => {
    const panel = await openTools();
    panel.vm.$emit('toggle', 'web_search', false);
    await flushPromises();
    await report({ key: 'damocles.tools.disabled', ok: true, scope: 'user' });
    expect(tool('web_search')).toBe(false);

    await status(SNAPSHOT);
    expect(tool('web_search')).toBe(true);
  });

  it('turns a group on without turning on a tool its own switch keeps off', async () => {
    const panel = await openTools();
    await status({
      groups: SNAPSHOT.groups.map((entry) => (entry.group === 'compass' ? { ...entry, enabled: false } : entry)),
      tools: SNAPSHOT.tools.map((entry) => (entry.group === 'compass' ? { ...entry, enabled: false } : entry)),
    });

    panel.vm.$emit('toggleGroup', 'compass', true);
    await flushPromises();

    expect([group('compass'), tool('CompassSearch'), tool('CompassFind')]).toEqual([true, false, false]);
  });
});
