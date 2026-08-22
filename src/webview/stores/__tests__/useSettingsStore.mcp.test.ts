import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useSettingsStore } from '../useSettingsStore';
import type { McpServerStatusInfo } from '../../../shared/types/mcp';

/** An override may set a field to `undefined`, which is how the store sees a payload drop one. */
type ServerOverride = { [K in keyof McpServerStatusInfo]?: McpServerStatusInfo[K] | undefined };

/** A runtime snapshot, as `mcpServerStatus` delivers it. */
function live(over: ServerOverride = {}): McpServerStatusInfo {
  return {
    name: 'ctx7',
    status: 'connected',
    enabled: true,
    source: 'workspace',
    serverInfo: { name: 'Context7', version: '4.0.2' },
    tools: [{ name: 'resolve' }, { name: 'query' }],
    ...over,
  } as McpServerStatusInfo;
}

/** A config-only entry, as `mcpConfigUpdate` delivers it: enabled servers always read `idle`. */
function config(over: ServerOverride = {}): McpServerStatusInfo {
  return { name: 'ctx7', status: 'idle', enabled: true, source: 'workspace', ...over } as McpServerStatusInfo;
}

describe('reconcileMcpServers', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('keeps a surviving server\'s runtime state when a config reload lands', () => {
    const store = useSettingsStore();
    store.setMcpServers([live()]);

    store.reconcileMcpServers([config()]);

    const server = store.mcpServers[0]!;
    expect(server.status).toBe('connected');
    expect(server.serverInfo).toEqual({ name: 'Context7', version: '4.0.2' });
    expect(server.tools).toHaveLength(2);
  });

  it('keeps a failure and its error message', () => {
    const store = useSettingsStore();
    store.setMcpServers([live({ status: 'failed', error: 'MCP error -32000: Connection closed', tools: undefined })]);

    store.reconcileMcpServers([config()]);

    expect(store.mcpServers[0]!.status).toBe('failed');
    expect(store.mcpServers[0]!.error).toBe('MCP error -32000: Connection closed');
  });

  it('takes config fields from the new entry, not the stale one', () => {
    const store = useSettingsStore();
    store.setMcpServers([live({ source: 'claude', readonly: true })]);

    store.reconcileMcpServers([config({ source: 'damocles', readonly: false })]);

    expect(store.mcpServers[0]!.source).toBe('damocles');
    expect(store.mcpServers[0]!.readonly).toBe(false);
    expect(store.mcpServers[0]!.status).toBe('connected');
  });

  it('lets a config-derived status win over a stale runtime one', () => {
    const store = useSettingsStore();
    store.setMcpServers([live()]);

    store.reconcileMcpServers([config({ enabled: false, status: 'disabled' })]);

    expect(store.mcpServers[0]!.status).toBe('disabled');
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

    expect(store.mcpServers[0]!.status).toBe('idle');
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

    expect(store.mcpServers[0]!.editableConfig).toBeUndefined();
    // The runtime state it exists to preserve is still carried.
    expect(store.mcpServers[0]!.status).toBe('connected');
  });

  it('drops supportsOAuth, which would otherwise offer Re-authenticate on a server edited to stdio', () => {
    const store = useSettingsStore();
    store.setMcpServers([config({ status: 'connected', supportsOAuth: true })]);

    store.reconcileMcpServers([config()]);

    expect(store.mcpServers[0]!.supportsOAuth).toBeUndefined();
  });

  it('drops readonly and source from the OLD entry, taking both from the reload', () => {
    const store = useSettingsStore();
    store.setMcpServers([config({ status: 'connected', source: 'damocles', readonly: false })]);

    store.reconcileMcpServers([config({ source: 'claude', readonly: true })]);

    expect(store.mcpServers[0]!.source).toBe('claude');
    expect(store.mcpServers[0]!.readonly).toBe(true);
  });
});

describe('mcpConfigRevision', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('advances on every applied config reload, which is what clears the reload spinner', () => {
    // The panel has no per-request acknowledgement, so this counter is its only evidence that the
    // reload it asked for came back.
    const store = useSettingsStore();
    expect(store.mcpConfigRevision).toBe(0);

    store.reconcileMcpServers([config()]);
    store.reconcileMcpServers([config()]);

    expect(store.mcpConfigRevision).toBe(2);
  });

  it('advances even when the reload changes nothing on screen', () => {
    // The common case: the user presses Reload and the answer is identical to what is displayed.
    const store = useSettingsStore();
    store.setMcpServers([live()]);
    const before = store.mcpConfigRevision;

    store.reconcileMcpServers([config()]);

    expect(store.mcpConfigRevision).toBe(before + 1);
  });

  it('does not advance for a runtime status payload', () => {
    // `mcpServerStatus` is not the reply to a reload, so treating it as one would clear the spinner
    // on an unrelated message.
    const store = useSettingsStore();

    store.setMcpServers([live()]);

    expect(store.mcpConfigRevision).toBe(0);
  });
});

describe('$reset', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('clears every MCP field, not just the server list', () => {
    // Leaving the leak warning behind would put a credential warning about the previous workspace on
    // top of a panel whose server list was just emptied.
    const store = useSettingsStore();
    store.setMcpServers([live()]);
    store.setMcpEnabled(false);
    store.setMcpConfigErrors([
      { path: '/x/mcp.json', displayPath: '~/x/mcp.json', kind: 'parse', line: 1, column: 1 },
    ]);
    store.setMcpLocalUnignored(true);
    store.reconcileMcpServers([config()]);
    store.beginMcpWrite('req-1');
    store.settleMcpWrite('req-1', { code: 'nameExists', params: { name: 'ctx7' } });

    // Every field is dirty here, so none of the assertions below can pass by never having moved.
    expect(store.mcpServers).toHaveLength(1);
    expect(store.mcpEnabled).toBe(false);
    expect(store.mcpConfigErrors).toHaveLength(1);
    expect(store.mcpLocalUnignored).toBe(true);
    expect(store.mcpConfigRevision).toBeGreaterThan(0);
    expect(store.mcpWriteError).not.toBeNull();

    store.$reset();

    expect(store.mcpServers).toEqual([]);
    expect(store.mcpEnabled).toBe(true);
    expect(store.mcpConfigErrors).toEqual([]);
    expect(store.mcpLocalUnignored).toBe(false);
    expect(store.mcpConfigRevision).toBe(0);
    expect(store.mcpWriteError).toBeNull();
  });

  it('clears a write still in flight, which no acknowledgement will ever settle', () => {
    // `settleMcpWrite` clears the id itself, so the only way it survives a reset is a write whose
    // reply belongs to the workspace being left behind. That leaves the form disabled forever.
    const store = useSettingsStore();
    store.beginMcpWrite('req-1');
    expect(store.mcpWriteRequestId).toBe('req-1');

    store.$reset();

    expect(store.mcpWriteRequestId).toBeNull();
  });
});
