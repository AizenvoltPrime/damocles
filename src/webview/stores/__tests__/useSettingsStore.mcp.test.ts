import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useSettingsStore } from '../useSettingsStore';
import type { McpServerStatusInfo } from '../../../shared/types/mcp';

/** A runtime snapshot, as `mcpServerStatus` delivers it. */
function live(over: Partial<McpServerStatusInfo> = {}): McpServerStatusInfo {
  return {
    name: 'ctx7',
    status: 'connected',
    enabled: true,
    source: 'workspace',
    serverInfo: { name: 'Context7', version: '4.0.2' },
    tools: [{ name: 'resolve' }, { name: 'query' }],
    ...over,
  };
}

/** A config-only entry, as `mcpConfigUpdate` delivers it: enabled servers always read `idle`. */
function config(over: Partial<McpServerStatusInfo> = {}): McpServerStatusInfo {
  return { name: 'ctx7', status: 'idle', enabled: true, source: 'workspace', ...over };
}

describe('reconcileMcpServers', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('keeps a surviving server\'s runtime state when a config reload lands', () => {
    const store = useSettingsStore();
    store.setMcpServers([live()]);

    store.reconcileMcpServers([config()]);

    const [server] = store.mcpServers;
    expect(server.status).toBe('connected');
    expect(server.serverInfo).toEqual({ name: 'Context7', version: '4.0.2' });
    expect(server.tools).toHaveLength(2);
  });

  it('keeps a failure and its error message', () => {
    const store = useSettingsStore();
    store.setMcpServers([live({ status: 'failed', error: 'MCP error -32000: Connection closed', tools: undefined })]);

    store.reconcileMcpServers([config()]);

    expect(store.mcpServers[0].status).toBe('failed');
    expect(store.mcpServers[0].error).toBe('MCP error -32000: Connection closed');
  });

  it('takes config fields from the new entry, not the stale one', () => {
    const store = useSettingsStore();
    store.setMcpServers([live({ source: 'claude', readonly: true })]);

    store.reconcileMcpServers([config({ source: 'damocles', readonly: false })]);

    expect(store.mcpServers[0].source).toBe('damocles');
    expect(store.mcpServers[0].readonly).toBe(false);
    expect(store.mcpServers[0].status).toBe('connected');
  });

  it('lets a config-derived status win over a stale runtime one', () => {
    const store = useSettingsStore();
    store.setMcpServers([live()]);

    store.reconcileMcpServers([config({ enabled: false, status: 'disabled' })]);

    expect(store.mcpServers[0].status).toBe('disabled');
  });

  it('does not resurrect a server that the reload removed', () => {
    const store = useSettingsStore();
    store.setMcpServers([live(), live({ name: 'gone' })]);

    store.reconcileMcpServers([config()]);

    expect(store.mcpServers.map(s => s.name)).toEqual(['ctx7']);
  });

  it('carries no runtime state onto a newly added server', () => {
    const store = useSettingsStore();
    store.setMcpServers([live()]);

    store.reconcileMcpServers([config(), config({ name: 'test1', source: 'damocles' })]);

    const added = store.mcpServers.find(s => s.name === 'test1');
    expect(added?.status).toBe('idle');
    expect(added?.tools).toBeUndefined();
    expect(added?.serverInfo).toBeUndefined();
  });

  it('does not carry over a previous config-only status', () => {
    const store = useSettingsStore();
    store.setMcpServers([config({ status: 'idle' })]);

    store.reconcileMcpServers([config()]);

    expect(store.mcpServers[0].status).toBe('idle');
  });
});

describe('reconcileMcpServers — fields the new payload OMITS', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('drops editableConfig when the reload no longer sends it', () => {
    // The extension withholds `editableConfig` the moment a config stops being form-representable —
    // hand-editing a server to add an `oauth` block, say — precisely so Edit stops being offered.
    // Spreading the previous entry underneath cannot express "this is gone", so a stale copy would
    // survive and put the form back in front of a config it cannot represent: the exact "Edit destroys
    // what it cannot show" hole that gate exists to close.
    const store = useSettingsStore();
    store.setMcpServers([
      config({ name: 'docs', source: 'damocles', status: 'connected', editableConfig: { command: 'node' } }),
    ]);

    store.reconcileMcpServers([config({ name: 'docs', source: 'damocles' })]);

    expect(store.mcpServers[0].editableConfig).toBeUndefined();
    // The runtime state it exists to preserve is still carried.
    expect(store.mcpServers[0].status).toBe('connected');
  });

  it('drops supportsOAuth, which would otherwise offer Re-authenticate on a server edited to stdio', () => {
    const store = useSettingsStore();
    store.setMcpServers([config({ status: 'connected', supportsOAuth: true })]);

    store.reconcileMcpServers([config()]);

    expect(store.mcpServers[0].supportsOAuth).toBeUndefined();
  });

  it('drops readonly and source from the OLD entry, taking both from the reload', () => {
    const store = useSettingsStore();
    store.setMcpServers([config({ status: 'connected', source: 'damocles', readonly: false })]);

    store.reconcileMcpServers([config({ source: 'claude', readonly: true })]);

    expect(store.mcpServers[0].source).toBe('claude');
    expect(store.mcpServers[0].readonly).toBe(true);
  });
});
