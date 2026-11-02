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

// The page posts through the host API vitest.setup.ts installs.
const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();
let app: VueWrapper | null = null;

beforeEach(() => setActivePinia(createPinia()));

afterEach(() => {
  app?.unmount();
  app = null;
  vi.restoreAllMocks();
});

describe('the MCP panel\'s "Available on remote hosts" switch', () => {
  it('asks the core to mark the server', async () => {
    const post = vi.spyOn(api, 'postMessage');
    app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
    // a desktop local core's row for a personal server that may relay
    useSettingsStore().setMcpServers([{ name: 'github', status: 'connected', enabled: true, source: 'damocles', remoteAvailable: false }]);
    useUIStore().openMcpPanel();
    await nextTick();
    await app.get('[data-testid="mcp-remote-available-toggle"]').trigger('click');
    const sent = post.mock.calls.map(([message]) => message).filter((message) => (message as { type: string }).type === 'mcpSetRemoteAvailable');
    expect(sent).toEqual([{ type: 'mcpSetRemoteAvailable', serverName: 'github', available: true }]);
  });
});
