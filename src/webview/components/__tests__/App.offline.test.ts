// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import App from '@/App.vue';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

let app: VueWrapper | null = null;

function page(offline: { hostId: string; hostName: string } | undefined): void {
  window.damoclesBridge = {
    postMessage: () => undefined,
    onMessage: () => () => undefined,
    getState: () => undefined,
    setState: () => undefined,
    getHost: () => (offline ? { hostId: offline.hostId, name: offline.hostName, computer: 'ALEXIOS-PC' } : undefined),
    onHost: () => () => undefined,
    getOffline: () => offline,
    hostAction: () => undefined,
    getConnection: () => undefined,
    onConnection: () => () => undefined,
    queueAction: () => undefined,
  };
}

beforeEach(() => setActivePinia(createPinia()));

afterEach(() => {
  app?.unmount();
  app = null;
  delete (window as { damoclesBridge?: unknown }).damoclesBridge;
});

describe('a remote chat shown from its session mirror while its host is offline', () => {
  it('is read-only: the composer gives way to a card that names the host', async () => {
    page({ hostId: 'h1', hostName: 'prod-1' });
    app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
    await nextTick();
    const card = app.get('[data-testid="composer-offline"]');
    expect(card.attributes('role')).toBe('status');
    expect(card.text()).toContain('prod-1 is offline');
    expect(card.text()).toContain('This chat is read-only until prod-1 reconnects.');
    expect(app.find('textarea').exists()).toBe(false);
  });

  it('offers no rewind or fork of the transcript, which no core answers', () => {
    page({ hostId: 'h1', hostName: 'prod-1' });
    expect(useUIStore().historyReadOnly).toBe(true);
    setActivePinia(createPinia());
    page(undefined);
    expect(useUIStore().historyReadOnly).toBe(false);
  });

  it('keeps the composer for a live chat', async () => {
    page(undefined);
    app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
    await nextTick();
    expect(app.find('[data-testid="composer-offline"]').exists()).toBe(false);
    expect(app.find('textarea').exists()).toBe(true);
  });

  // every header control that asks the chat's view for something, which a mirrored transcript's view refuses
  const VIEW_CONTROLS = ['chat-header-consolidation', 'chat-header-plan', 'chat-header-memory', 'chat-header-browser', 'chat-header-mcp', 'chat-header-tools', 'chat-header-terminal', 'chat-header-more', 'chat-settings-button'];
  const shownControls = (wrapper: VueWrapper): string[] => VIEW_CONTROLS.filter((id) => wrapper.find(`[data-testid="${id}"]`).exists());

  it('shows in its header only the title and the controls that work on the page itself', async () => {
    page({ hostId: 'h1', hostName: 'prod-1' });
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, windowLayout: true });
    app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
    await nextTick();
    expect(app.find('[data-testid="chat-header-title"]').exists()).toBe(true);
    expect(shownControls(app)).toEqual([]);
  });

  it('keeps every header control for a live chat', async () => {
    page(undefined);
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, windowLayout: true });
    app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
    await nextTick();
    expect(shownControls(app)).toEqual(VIEW_CONTROLS);
  });
});
