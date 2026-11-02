// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import App from '@/App.vue';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

// The page posts through the host API vitest.setup.ts installs; main's init names the remote chat's host.
const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();
window.damoclesBridge = {
  postMessage: () => undefined,
  onMessage: () => () => undefined,
  getState: () => undefined,
  setState: () => undefined,
  getHost: () => ({ hostId: 'h1', name: 'prod-1', color: 'danger', computer: 'ALEXIOS-PC' }),
  onHost: () => () => undefined,
  getHostNames: () => undefined,
  onHostNames: () => () => undefined,
  getOffline: () => undefined,
  hostAction: () => undefined,
  getConnection: () => undefined,
  onConnection: () => () => undefined,
  allowYolo: async () => false,
  queueAction: () => undefined,
};

let app: VueWrapper | null = null;

beforeEach(() => setActivePinia(createPinia()));

afterEach(() => {
  app?.unmount();
  app = null;
  vi.restoreAllMocks();
});

describe('the MCP panel of a remote chat', () => {
  it('names the host on its machine rows and opens Settings on the host\'s tab for its edits', async () => {
    const post = vi.spyOn(api, 'postMessage');
    app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
    useSettingsStore().setMcpServers([{ name: 'db', status: 'connected', enabled: true, source: 'damocles', readonly: false, placement: 'host' }]);
    useUIStore().openMcpPanel();
    await nextTick();
    expect(app.get('[data-placement="host"]').text()).toBe('prod-1');
    await app.get('[data-testid="mcp-open-host-settings"]').trigger('click');
    const sent = post.mock.calls.map(([message]) => message).filter((message) => (message as { type: string }).type === 'openAppSettings');
    expect(sent).toEqual([{ type: 'openAppSettings', section: 'integrations', scope: 'machine' }]);
  });
});
