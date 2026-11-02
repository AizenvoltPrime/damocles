// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import McpStatusPanel from '../McpStatusPanel.vue';
import { i18n, applyLocale } from '@/i18n';
import type { McpServerStatusInfo, McpToolExposureScope } from '@shared/types/mcp';

enableAutoUnmount(afterEach);
afterEach(() => applyLocale('en'));

const PROD = { name: 'prod-1', color: 'danger' } as const;

// A remote core's page passes its host as this computer names it; `hostSettings` is the settings overlay's host tab.
// `host: null`: a remote chat's page before its host label arrived
const mountPanel = (servers: McpServerStatusInfo[], over: { context?: 'chat' | 'hostSettings'; configErrors?: { path: string; displayPath: string; line: number; column: number; kind: 'parse' }[]; host?: null; toolExposureScopes?: McpToolExposureScope[] } = {}) =>
  mount(McpStatusPanel, {
    props: {
      servers,
      configErrors: over.configErrors ?? [],
      mcpWriteInFlight: false,
      mcpWriteError: null,
      mcpEnabled: true,
      localMcpUnignored: false,
      configRevision: 0,
      ...(over.host === null ? {} : { host: PROD }),
      ...(over.context ? { context: over.context } : {}),
      ...(over.toolExposureScopes ? { toolExposureScopes: over.toolExposureScopes } : {}),
    },
    attachTo: document.body,
    global: { plugins: [i18n] },
  });

// As a remote core sends them: relayed from this computer, machine scope on the host, and the project's own file.
const SERVERS: McpServerStatusInfo[] = [
  { name: 'github', status: 'connected', enabled: true, source: 'relayed', readonly: true, placement: 'client' },
  {
    name: 'db', status: 'needs-auth', enabled: true, source: 'damocles', readonly: false, placement: 'host', editableConfig: { command: 'db-mcp' },
    tools: [{ name: 'query', exposure: 'deferred' }], resourceExposure: 'deferred', hasResources: true,
  },
  { name: 'repo-tools', status: 'connected', enabled: true, source: 'workspace', readonly: true, placement: 'project' },
];

type Wrapper = ReturnType<typeof mountPanel>;

const chips = (wrapper: Wrapper) =>
  wrapper.findAll('[data-testid="mcp-server-row"]').map((row) => {
    const chip = row.find('[data-testid="mcp-server-placement"]');
    return chip.exists() ? [chip.attributes('data-placement'), chip.text()] : null;
  });
const rowActions = (wrapper: Wrapper, index: number) => wrapper.findAll('[data-testid="mcp-server-row"]')[index]!.findAll('[data-row-action]').map((action) => action.attributes('data-row-action'));

async function expandAll(wrapper: Wrapper): Promise<void> {
  for (const toggle of wrapper.findAll('button[aria-expanded]').filter((button) => !button.attributes('disabled') && button.attributes('data-testid') === undefined)) {
    if (toggle.attributes('aria-expanded') === 'false') await toggle.trigger('click');
  }
  await nextTick();
}

describe('McpStatusPanel on a remote chat', () => {
  it('marks each row with where it runs, the host named as this computer names it', () => {
    const wrapper = mountPanel(SERVERS);
    expect(chips(wrapper)).toEqual([['client', 'Your computer'], ['host', 'prod-1'], ['project', 'Project']]);
    const host = wrapper.get('[data-placement="host"]');
    expect(host.classes()).toContain('d-tone-danger');
    expect(host.attributes('title')).toBe('Runs on prod-1');
  });

  it('names the host again after a rename on this computer', async () => {
    const wrapper = mountPanel(SERVERS);
    await wrapper.setProps({ host: { name: 'staging', color: 'info' } });
    // the badge swaps the old name out through its leave transition
    await new Promise((resolve) => setTimeout(resolve, 0));
    const host = wrapper.get('[data-placement="host"]');
    expect(host.text()).toBe('staging');
    expect(host.classes()).toContain('d-tone-info');
  });

  it('shows a relayed server read-only, with where to change it', () => {
    const wrapper = mountPanel(SERVERS, { context: 'hostSettings' });
    const relayed = wrapper.findAll('[data-testid="mcp-server-row"]')[0]!;
    expect(rowActions(wrapper, 0)).toEqual([]);
    expect(relayed.find('[data-testid="mcp-remote-available-toggle"]').exists()).toBe(false);
    expect(relayed.get('[data-testid="mcp-relayed-note"]').text()).toBe('Shared from your computer. Change it in the MCP servers of a local chat.');
    expect(relayed.text()).toContain('Personal');
    expect(wrapper.findAll('[data-testid="mcp-relayed-note"]')).toHaveLength(1);
  });

  it('leaves the host\'s edits to the settings overlay\'s host tab, and points there', async () => {
    const wrapper = mountPanel(SERVERS);
    expect(wrapper.find('[data-testid="mcp-add-server"]').exists()).toBe(false);
    expect(rowActions(wrapper, 1)).toEqual(['authenticate', 'browseResources']);
    expect(wrapper.get('[data-testid="mcp-master-toggle"]').attributes('data-disabled')).toBeDefined();
    await expandAll(wrapper);
    expect(wrapper.find('[data-testid="mcp-tool-exposure-scope"]').exists()).toBe(false);
    const options = wrapper.findAll('[data-testid="mcp-tool-exposure"] button, [data-testid="mcp-resource-exposure"] button');
    expect(options).toHaveLength(6);
    for (const option of options) expect(option.attributes('disabled')).toBeDefined();
    // the row's own switch stays: it is the host core's state, which the page may change
    expect(wrapper.findAll('[data-testid="mcp-server-row"]')[1]!.find('[role="switch"]').attributes('data-disabled')).toBeUndefined();
    const note = wrapper.get('[data-testid="mcp-host-settings-note"]');
    expect(note.text()).toContain('Add, edit and delete prod-1\'s MCP servers, turn MCP on or off and choose which tools load in Settings, on the prod-1 tab.');
    await note.get('[data-testid="mcp-open-host-settings"]').trigger('click');
    expect(wrapper.emitted('openHostSettings')).toEqual([[]]);
  });

  it('restricts the page by its rows\' placement before the host label has arrived', async () => {
    const wrapper = mountPanel(SERVERS, { host: null });
    expect(wrapper.find('[data-testid="mcp-add-server"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="mcp-master-toggle"]').attributes('data-disabled')).toBeDefined();
    expect(rowActions(wrapper, 1)).toEqual(['authenticate', 'browseResources']);
    await expandAll(wrapper);
    expect(wrapper.find('[data-testid="mcp-tool-exposure-scope"]').exists()).toBe(false);
    for (const option of wrapper.findAll('[data-testid="mcp-tool-exposure"] button')) expect(option.attributes('disabled')).toBeDefined();
  });

  it('builds the host settings link from the shared Button part', () => {
    const wrapper = mountPanel(SERVERS);
    expect(wrapper.get('[data-testid="mcp-open-host-settings"]').classes()).toEqual(expect.arrayContaining(['focus-visible:ring-2', 'inline-flex']));
  });

  it('counts the relayed source among the sources it draws on', () => {
    mountPanel(SERVERS);
    expect(document.body.textContent).toContain('Servers from 9 sources');
  });

  it('says it in Greek', () => {
    applyLocale('el');
    const wrapper = mountPanel(SERVERS);
    expect(chips(wrapper)).toEqual([['client', 'Ο υπολογιστής σας'], ['host', 'prod-1'], ['project', 'Έργο']]);
    expect(wrapper.get('[data-testid="mcp-open-host-settings"]').text()).toBe('Άνοιγμα ρυθμίσεων');
  });
});

describe('McpStatusPanel on the settings overlay\'s host tab', () => {
  it('edits the host\'s own servers and offers no chat connection actions', async () => {
    const wrapper = mountPanel(SERVERS, {
      context: 'hostSettings',
      configErrors: [{ path: '/srv/api/.mcp.json', displayPath: '.mcp.json', line: 3, column: 1, kind: 'parse' }],
    });
    expect(wrapper.get('[role="dialog"]').text()).toContain('MCP servers on prod-1');
    expect(wrapper.find('[data-testid="mcp-add-server"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mcp-host-settings-note"]').exists()).toBe(false);
    // needs-auth would offer Authenticate and resources Browse in a chat; machine rows are editable, project rows are not
    expect([rowActions(wrapper, 1), rowActions(wrapper, 2)]).toEqual([['edit', 'delete'], []]);
    expect(wrapper.text()).not.toContain('Open');
    await expandAll(wrapper);
    expect(wrapper.find('[data-testid="mcp-tool-exposure-scope"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="mcp-tool-exposure"] button').attributes('disabled')).toBeUndefined();
  });

  it('saves exposure to the host\'s settings, named after the host, and only for the host\'s own servers', async () => {
    const servers: McpServerStatusInfo[] = [
      { ...SERVERS[1]!, tools: [{ name: 'query', exposure: 'direct', exposureSource: 'machine' }] },
      { ...SERVERS[2]!, tools: [{ name: 'lint', exposure: 'deferred' }] },
    ];
    const wrapper = mountPanel(servers, { context: 'hostSettings', toolExposureScopes: ['machine'] });
    await expandAll(wrapper);
    const scope = wrapper.get('[data-testid="mcp-tool-exposure-scope"]');
    expect(scope.findAll('[data-scope]').map((option) => [option.attributes('data-scope'), option.text()])).toEqual([['machine', 'prod-1 settings']]);
    expect(wrapper.findAll('[data-testid="mcp-tool-exposure-source"]').map((chip) => chip.text())).toEqual(['prod-1 settings', 'Config']);
    const [host, project] = wrapper.findAll('[data-testid="mcp-tool-exposure"]');
    expect(project!.findAll('button').every((option) => option.attributes('disabled') !== undefined)).toBe(true);
    await host!.get('[data-exposure="off"]').trigger('click');
    expect(wrapper.emitted('setToolExposure')).toEqual([['db', 'query', 'off', 'machine']]);
  });

  it('names the host\'s settings in Greek', async () => {
    applyLocale('el');
    const wrapper = mountPanel([{ ...SERVERS[1]!, tools: [{ name: 'query', exposure: 'direct', exposureSource: 'machine' }] }], { context: 'hostSettings', toolExposureScopes: ['machine'] });
    await expandAll(wrapper);
    expect(wrapper.get('[data-testid="mcp-tool-exposure-scope"] [data-scope="machine"]').text()).toBe('Ρυθμίσεις του prod-1');
  });

  it('names the host in the form it opens', async () => {
    const wrapper = mountPanel(SERVERS, { context: 'hostSettings' });
    await wrapper.get('[data-testid="mcp-add-server"]').trigger('click');
    await nextTick();
    expect(document.body.textContent).toContain('Saved to ~/.damocles/mcp.json on prod-1, so this server is available in every project there.');
  });
});
