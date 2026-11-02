// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { applyLocale, i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { settingsViewHandlers, type SettingsHandlerContext } from '@/composables/message-handler/handlers/settings-handlers';
import type { McpServerStatusInfo } from '@shared/types/mcp';
import SettingsModal from '../SettingsModal.vue';
import { NO_HOST_SETTINGS } from '../settings-rows';
import type { SettingsMachineHost } from '../settings-view';

const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  vi.restoreAllMocks();
  applyLocale('en');
});

// As the host tab's core sends them: the host's own mcp.json server is editable, a project server is not.
const SERVERS: McpServerStatusInfo[] = [
  { name: 'db', status: 'connected', enabled: true, source: 'damocles', readonly: false, placement: 'host', editableConfig: { command: 'db-mcp' } },
  { name: 'repo-tools', status: 'connected', enabled: true, source: 'workspace', readonly: true, placement: 'project' },
];
// the host's Codex and Claude imports run there too, but live in other files than the row names
const IMPORTS: McpServerStatusInfo[] = [
  { name: 'linear', status: 'connected', enabled: true, source: 'codex', readonly: true, placement: 'host' },
  { name: 'sentry', status: 'connected', enabled: true, source: 'claude', readonly: true, placement: 'host' },
];

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function openIntegrations(machineHost: SettingsMachineHost | undefined) {
  const post = vi.spyOn(api, 'postMessage');
  mount(SettingsModal, {
    props: { host: NO_HOST_SETTINGS, footer: { kind: 'settingsFiles' }, backdrop: 'dim', target: { section: 'integrations' }, chatHost: machineHost?.name, machineHost },
    attachTo: document.body,
    global: { plugins: [i18n] },
  });
  await nextTick();
  await nextTick();
  return post;
}

type Post = Awaited<ReturnType<typeof openIntegrations>>;
const sent = (post: Post, type: string) => post.mock.calls.map(([message]) => message as { type: string }).filter((message) => message.type === type);
const row = () => document.querySelector<HTMLElement>('[data-testid="settings-row-mcpHostServers"]');

describe('the host tab\'s MCP servers', () => {
  it('is only on a remote chat\'s host tab', async () => {
    await openIntegrations(undefined);
    expect(document.querySelector('[data-testid="settings-row-damocles.mcp.enabled"]')).not.toBeNull();
    expect(row()).toBeNull();
  });

  it('names the host, asks for its servers and counts the ones in its own mcp.json', async () => {
    const post = await openIntegrations({ name: 'prod-1', color: 'danger' });
    expect(row()?.textContent).toContain('MCP servers on prod-1');
    expect(row()?.textContent).toContain('Servers in prod-1\'s ~/.damocles/mcp.json run there for every project, even while Damocles is closed.');
    expect(sent(post, 'requestMcpStatus')).toHaveLength(1);
    useSettingsStore().setMcpServers([...SERVERS, ...IMPORTS]);
    await nextTick();
    expect(document.querySelector('[data-testid="mcp-host-servers-count"]')?.textContent).toBe('1 server');
  });

  it('opens the MCP panel for the host, whose edits go to the host tab\'s core', async () => {
    const post = await openIntegrations({ name: 'prod-1', color: 'danger' });
    useSettingsStore().setMcpServers(SERVERS);
    document.querySelector<HTMLElement>('[data-testid="mcp-host-servers-open"]')!.click();
    await nextTick();
    await flush();
    const panel = document.querySelector<HTMLElement>('[data-testid="mcp-panel"]')!;
    expect(panel.textContent).toContain('MCP servers on prod-1');
    expect(sent(post, 'mcpReloadConfig')).toHaveLength(1);
    expect([...panel.querySelectorAll('[data-testid="mcp-server-placement"]')].map((chip) => chip.textContent?.trim())).toEqual(['prod-1', 'Project']);

    panel.querySelector<HTMLElement>('[data-row-action="delete"]')!.click();
    await nextTick();
    [...panel.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((button) => button.textContent?.trim() === 'Delete')!.click();
    const [write] = sent(post, 'mcpDeleteServer') as Array<{ type: string; requestId: string; serverName: string }>;
    expect(write).toMatchObject({ type: 'mcpDeleteServer', serverName: 'db' });
    expect(useSettingsStore().mcpWriteRequestId).toBe(write!.requestId);
    // the host tab's core answers through the settings view's own handlers
    settingsViewHandlers.mcpWriteResult({ type: 'mcpWriteResult', requestId: write!.requestId, ok: true }, { stores: { settingsStore: useSettingsStore() } } as unknown as SettingsHandlerContext);
    expect(useSettingsStore().mcpWriteRequestId).toBeNull();
  });

  it('says it in Greek', async () => {
    applyLocale('el');
    await openIntegrations({ name: 'prod-1' });
    expect(row()?.textContent).toContain('Διακομιστές MCP στο prod-1');
  });
});
