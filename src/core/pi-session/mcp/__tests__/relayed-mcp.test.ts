import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpClient } from '@earendil-works/pi-mcp';
import { clientRelayCalls, relayedServerConfig, relayedServerDescriptors, RelayedMcpTransport, runRelayedMcpRequest } from '../relayed-mcp';
import type { McpClientManager } from '../mcp-client-manager';
import type { McpToolDescriptor } from '../types';
import { createFakeRemoteHost } from '../../../../__mocks__/fake-remote-host';
import { englishText, LocalizedError } from '../../../../shared/localized-text';
import { CREDENTIAL_CLIENT_ABSENT, type RelayedMcpServer } from '../../../../shared/remote-user';
import { relayedMcpClosedReason, relayedMcpElsewhereReason, userScopeReach } from '../../../user-scope';
import { relayedToolNames, setRelayedToolNames } from '../relayed-tool-names';
import { loadableToolNames } from '../../tools/deferred-tools';
import { managerWithFake, specOf } from './fake-server-manager';
import { installPlatform } from '../../../platform-host';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import { runPinnedTurn } from '../../../client-snapshots';

const descriptor = (serverName: string, rawToolName: string, extra: Partial<McpToolDescriptor> = {}): McpToolDescriptor => ({
  piName: `mcp__${serverName}__${rawToolName}`, serverName, serverId: `m/${serverName}`, rawToolName, description: `${rawToolName} it`,
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, readOnly: false, exposure: 'deferred', exposureSource: 'config', configExposure: 'deferred', ...extra,
});

/** A user MCP manager whose resource requests, as the real one's, apply the config's exposure unless told another. */
function fakeUserMcp(servers: Record<string, { tools: McpToolDescriptor[]; resources: boolean; resourceExposure?: 'off' | 'deferred' }>) {
  const configResourceExposureOf = (name: string) => servers[name]?.resourceExposure ?? 'deferred';
  const exposed = <T>(name: string, exposure: string | undefined, answer: T): T => {
    if ((exposure ?? configResourceExposureOf(name)) === 'off') throw new Error(`MCP server "${name}" has its resources turned off`);
    return answer;
  };
  return {
    getAllToolDescriptors: () => Object.values(servers).flatMap((server) => server.tools),
    hasServer: (name: string) => Object.hasOwn(servers, name),
    serverHasResources: (name: string) => servers[name]?.resources,
    configResourceExposureOf,
    callTimeoutMsOf: () => 120_000,
    callTool: vi.fn(async (_piName: string, _args: unknown, _opts?: { signal?: AbortSignal }) => ({ content: [{ type: 'text', text: 'called' }], isError: false })),
    listResourcesPage: vi.fn(async (name: string, _cursor?: string, _opts?: { signal?: AbortSignal }, exposure?: string) => exposed(name, exposure, { resources: [{ uri: 'notes://a', name: 'a' }] })),
    listResourceTemplatesPage: vi.fn(async (name: string, _cursor?: string, _opts?: { signal?: AbortSignal }, exposure?: string) => exposed(name, exposure, { resourceTemplates: [] })),
    readResource: vi.fn(async (name: string, _uri: string, _opts?: { signal?: AbortSignal }, exposure?: string) => exposed(name, exposure, { contents: [{ uri: 'notes://a', text: 'hello' }] })),
  };
}

const notes = (): RelayedMcpServer => ({ name: 'notes', tools: [{ name: 'search', description: 'search it', inputSchema: { type: 'object' } }], resources: true });

const NO_LAYERS = { tools: [], resources: [] };

afterEach(() => {
  setRelayedToolNames('test', new Map());
  installPlatform(createFakePlatform());
});

describe('the descriptors this computer relays', () => {
  it('lists only marked, relayable, enabled servers, with names and schemas and nothing of their config', () => {
    const userMcp = fakeUserMcp({
      notes: { tools: [descriptor('notes', 'search', { serverDescription: 'Personal notes', readOnly: true })], resources: true },
      unmarked: { tools: [descriptor('unmarked', 'x')], resources: false },
      project: { tools: [descriptor('project', 'y')], resources: false },
    });
    const servers = relayedServerDescriptors(userMcp as unknown as McpClientManager, (name) => name !== 'project', ['notes', 'project', 'gone'], NO_LAYERS);
    expect(servers).toEqual([{
      name: 'notes',
      description: 'Personal notes',
      tools: [{ name: 'search', description: 'search it', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }],
      resources: true,
      timeoutMs: 120_000,
    }]);
    expect(JSON.stringify(servers)).not.toMatch(/env|headers|command|url/);
  });

  it('leaves out a tool turned Off in its config or in the user settings, which the user settings can turn on again', () => {
    const userMcp = fakeUserMcp({
      notes: {
        tools: [
          descriptor('notes', 'search'),
          descriptor('notes', 'wipe', { exposure: 'off', configExposure: 'off' }),
          descriptor('notes', 'export'),
          descriptor('notes', 'tag', { exposure: 'off', configExposure: 'off' }),
        ],
        resources: false,
      },
    });
    const layers = { tools: [{ scope: 'user' as const, value: { notes: { export: 'off', tag: 'deferred' } } }], resources: [] };
    const [server] = relayedServerDescriptors(userMcp as unknown as McpClientManager, () => true, ['notes'], layers);
    expect(server!.tools.map((tool) => tool.name)).toEqual(['search', 'tag']);
  });

  it('relays no resources the config or the user settings turned Off', () => {
    const userMcp = fakeUserMcp({ notes: { tools: [], resources: true }, docs: { tools: [], resources: true, resourceExposure: 'off' }, wiki: { tools: [], resources: true } });
    const layers = { tools: [], resources: [{ scope: 'user' as const, value: { wiki: 'off' } }] };
    const servers = relayedServerDescriptors(userMcp as unknown as McpClientManager, () => true, ['notes', 'docs', 'wiki'], layers);
    expect(servers.map((server) => [server.name, server.resources])).toEqual([['docs', false], ['notes', true], ['wiki', false]]);
  });
});

describe('a relayed request on this computer', () => {
  it('runs a listed tool of a relayed server, and refuses an unlisted server or tool', async () => {
    const userMcp = fakeUserMcp({ notes: { tools: [descriptor('notes', 'search')], resources: true }, other: { tools: [descriptor('other', 'z')], resources: false } });
    const manager = userMcp as unknown as McpClientManager;
    await expect(runRelayedMcpRequest(manager, [notes()], NO_LAYERS, { kind: 'call', server: 'notes', tool: 'search', args: { q: 'a' } })).resolves.toMatchObject({ content: [{ text: 'called' }] });
    expect(userMcp.callTool).toHaveBeenCalledWith('mcp__notes__search', { q: 'a' }, {});
    await expect(runRelayedMcpRequest(manager, [notes()], NO_LAYERS, { kind: 'call', server: 'other', tool: 'z', args: {} })).rejects.toThrow('not available on remote hosts');
    await expect(runRelayedMcpRequest(manager, [notes()], NO_LAYERS, { kind: 'call', server: 'notes', tool: 'delete', args: {} })).rejects.toThrow('has no tool');
    // a tool the server has now but the remote host was never told of is refused too
    await expect(runRelayedMcpRequest(manager, [{ ...notes(), tools: [] }], NO_LAYERS, { kind: 'call', server: 'notes', tool: 'search', args: {} })).rejects.toThrow('has no tool');
    expect(userMcp.callTool).toHaveBeenCalledTimes(1);
  });

  it('refuses a call of a tool turned Off and a resource request of resources turned Off, before it reaches the server', async () => {
    const userMcp = fakeUserMcp({ notes: { tools: [descriptor('notes', 'search'), descriptor('notes', 'wipe', { exposure: 'off', configExposure: 'off' })], resources: true, resourceExposure: 'off' } });
    const manager = userMcp as unknown as McpClientManager;
    const relayed = relayedServerDescriptors(manager, () => true, ['notes'], NO_LAYERS);
    await expect(runRelayedMcpRequest(manager, relayed, NO_LAYERS, { kind: 'call', server: 'notes', tool: 'wipe', args: {} })).rejects.toThrow('has no tool');
    await expect(runRelayedMcpRequest(manager, relayed, NO_LAYERS, { kind: 'read', server: 'notes', uri: 'notes://a' })).rejects.toThrow('offers no resources');
    expect(userMcp.callTool).not.toHaveBeenCalled();
    expect(userMcp.readResource).not.toHaveBeenCalled();
  });

  it('lists and reads the resources of a relayed server that offers them, and refuses one that does not', async () => {
    const userMcp = fakeUserMcp({ notes: { tools: [], resources: true } });
    const manager = userMcp as unknown as McpClientManager;
    await expect(runRelayedMcpRequest(manager, [notes()], NO_LAYERS, { kind: 'resources', server: 'notes' })).resolves.toMatchObject({ resources: [{ uri: 'notes://a' }] });
    await expect(runRelayedMcpRequest(manager, [notes()], NO_LAYERS, { kind: 'read', server: 'notes', uri: 'notes://a' })).resolves.toMatchObject({ contents: [{ text: 'hello' }] });
    await expect(runRelayedMcpRequest(manager, [{ ...notes(), resources: false }], NO_LAYERS, { kind: 'read', server: 'notes', uri: 'notes://a' })).rejects.toThrow('offers no resources');
  });
});

describe('the relayed transport on a daemon\'s core', () => {
  it('serves initialize and tools/list from the descriptor and runs calls and resource reads on the client', async () => {
    const calls = { call: vi.fn(async () => ({ content: [{ type: 'text', text: 'from the client' }] })), resources: vi.fn(async () => ({ resources: [{ uri: 'notes://a', name: 'a' }] })), read: vi.fn(async () => ({ contents: [{ uri: 'notes://a', text: 'hello' }] })) };
    const client = new McpClient({ name: 'test', version: '1' });
    await client.connect(new RelayedMcpTransport(notes(), calls));
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(['search']);
    expect(await client.callTool('search', { q: 'x' })).toMatchObject({ content: [{ text: 'from the client' }] });
    expect(calls.call).toHaveBeenCalledWith('search', { q: 'x' }, expect.any(AbortSignal));
    expect((await client.listResourcesPage()).resources).toEqual([{ uri: 'notes://a', name: 'a' }]);
    expect((await client.readResource('notes://a')).contents).toEqual([{ uri: 'notes://a', text: 'hello' }]);
    await client.close();
  });

  it('answers a call with the server\'s reason while no client is attached', async () => {
    const fake = createFakeRemoteHost();
    fake.set('clientAuth', 'client-a', undefined);
    const calls = clientRelayCalls(fake.remote, 'notes');
    await expect(calls.call('search', {}, new AbortController().signal)).rejects.toThrow(LocalizedError);
    await expect(calls.call('search', {}, new AbortController().signal)).rejects.toThrow(englishText(relayedMcpClosedReason('notes')));
    expect(fake.remote.mcpCall).not.toHaveBeenCalled();
  });

  it('turns a client that left during the call into the same reason', async () => {
    const fake = createFakeRemoteHost();
    fake.set('clientMcp', 'client-a', [notes()]);
    vi.mocked(fake.remote.mcpCall).mockRejectedValueOnce(new Error(CREDENTIAL_CLIENT_ABSENT));
    await expect(clientRelayCalls(fake.remote, 'notes').call('search', {}, new AbortController().signal)).rejects.toThrow(englishText(relayedMcpClosedReason('notes')));
  });

  it('lists a relayed server\'s tools under its own name and shows no server info its host made up', async () => {
    const { manager, connected } = managerWithFake({ notes: [{ name: 'search' }] });
    manager.initialize({ notes: specOf(relayedServerConfig(notes()), { relay: notes() }) });
    await manager.whenReady();
    expect(connected()).toEqual(['notes']);
    expect(manager.getAllToolDescriptors().map((descriptor) => descriptor.piName)).toEqual(['mcp__notes__search']);
    expect(manager.getServerStatus('notes')).not.toHaveProperty('serverInfo');
    await manager.dispose();
  });

  it('has a placeholder config that opens nothing', () => {
    expect(relayedServerConfig(notes())).toEqual({ type: 'http', url: 'relayed://notes', auth: false });
  });

  it('takes relayed tools out of the loadable snapshot while the device they come from is out of reach', () => {
    setRelayedToolNames('test', new Map([['mcp__notes__search', { server: 'notes', tool: 'search' }]]));
    expect(relayedToolNames()).toEqual(['mcp__notes__search']);
    expect(loadableToolNames(['mcp__notes__search', 'mcp__local__x'], { browser: true, forge: true, relayedTool: () => true }, false)).toEqual(['mcp__notes__search', 'mcp__local__x']);
    expect(loadableToolNames(['mcp__notes__search', 'mcp__local__x'], { browser: true, forge: true, relayedTool: () => false }, false)).toEqual(['mcp__local__x']);
  });
});

describe('a relayed request on this computer, against the real MCP client', () => {
  const notesResources = { notes: { resources: [{ uri: 'notes://a', name: 'a' }], contents: { 'notes://a': [{ uri: 'notes://a', text: 'hello' }] } } };

  it('serves the resources of a server its config turns Off and the user settings turn On', async () => {
    const { manager } = managerWithFake({ notes: [] }, undefined, notesResources);
    manager.initialize({ notes: specOf({ command: 'notes', exposeResources: false }) });
    await manager.whenReady();
    const exposure = { tools: [], resources: [{ scope: 'user' as const, value: { notes: 'deferred' } }] };
    const relayed = relayedServerDescriptors(manager, () => true, ['notes'], exposure);
    expect(relayed[0]?.resources).toBe(true);
    await expect(runRelayedMcpRequest(manager, relayed, exposure, { kind: 'resources', server: 'notes' })).resolves.toMatchObject({ resources: [{ uri: 'notes://a' }] });
    await expect(runRelayedMcpRequest(manager, relayed, exposure, { kind: 'read', server: 'notes', uri: 'notes://a' })).resolves.toMatchObject({ contents: [{ text: 'hello' }] });
    await manager.dispose();
  });

  it('hands the remote caller\'s abort to the call and the resource request, so a Stop there ends them here', async () => {
    const { manager, fake } = managerWithFake({ notes: [{ name: 'search' }] }, undefined, notesResources);
    manager.initialize({ notes: specOf({ command: 'notes' }) });
    await manager.whenReady();
    const relayed = relayedServerDescriptors(manager, () => true, ['notes'], NO_LAYERS);
    const stop = new AbortController();
    await runRelayedMcpRequest(manager, relayed, NO_LAYERS, { kind: 'call', server: 'notes', tool: 'search', args: {} }, stop.signal);
    expect(fake.callTool).toHaveBeenCalledWith('notes', 'search', {}, expect.objectContaining({ signal: stop.signal }));
    await runRelayedMcpRequest(manager, relayed, NO_LAYERS, { kind: 'read', server: 'notes', uri: 'notes://a' }, stop.signal);
    expect(fake.readResource).toHaveBeenCalledWith('notes', 'notes://a', expect.objectContaining({ signal: stop.signal }));
    await runRelayedMcpRequest(manager, relayed, NO_LAYERS, { kind: 'resources', server: 'notes' }, stop.signal);
    expect(fake.listResourcesPage).toHaveBeenCalledWith('notes', undefined, expect.objectContaining({ signal: stop.signal }));
    await manager.dispose();
  });

  it('carries the server\'s own timeout, which the remote side waits for', async () => {
    const { manager } = managerWithFake({ notes: [{ name: 'search' }] });
    manager.initialize({ notes: specOf({ command: 'notes', timeout: 600 }) });
    await manager.whenReady();
    const [server] = relayedServerDescriptors(manager, () => true, ['notes'], NO_LAYERS);
    expect(server!.timeoutMs).toBe(600_000);
    const remote = managerWithFake({ notes: [{ name: 'search' }] });
    remote.manager.initialize({ notes: specOf(relayedServerConfig(server!), { relay: server! }) });
    expect(remote.manager.callTimeoutMsOf('notes')).toBe(600_000);
    await manager.dispose();
    await remote.manager.dispose();
  });

  it('relays a tool its config always loads as Always loaded, which the remote side loads so too', async () => {
    const tools = { notes: [{ name: 'search' }, { name: 'tag' }] };
    const { manager } = managerWithFake(tools);
    manager.initialize({ notes: specOf({ command: 'notes', toolExposure: { search: 'direct' } }) });
    await manager.whenReady();
    const [server] = relayedServerDescriptors(manager, () => true, ['notes'], NO_LAYERS);
    expect(server!.tools.map((tool) => [tool.name, tool.exposure])).toEqual([['search', 'direct'], ['tag', undefined]]);
    const remote = managerWithFake(tools);
    remote.manager.initialize({ notes: specOf(relayedServerConfig(server!), { relay: server! }) });
    await remote.manager.whenReady();
    expect(remote.manager.getAllToolDescriptors().map((descriptor) => [descriptor.rawToolName, descriptor.exposure])).toEqual([['search', 'direct'], ['tag', 'deferred']]);
    await manager.dispose();
    await remote.manager.dispose();
  });
});

describe('two devices attached to one daemon\'s core, relaying different servers', () => {
  const diary = (): RelayedMcpServer => ({ name: 'diary', tools: [{ name: 'write' }], resources: false });

  function twoDevices() {
    const fake = createFakeRemoteHost();
    fake.set('clientAuth', 'client-b', { providers: {} });
    fake.set('clientMcp', 'client-a', [notes()]);
    fake.set('clientMcp', 'client-b', [diary()]);
    installPlatform({ ...createFakePlatform(), remote: fake.remote });
    setRelayedToolNames('test', new Map([['mcp__notes__search', { server: 'notes', tool: 'search' }], ['mcp__diary__write', { server: 'diary', tool: 'write' }]]));
    return fake;
  }

  it('gives a turn only its own device\'s relayed tools, whoever acts during it', async () => {
    const fake = twoDevices();
    const both = ['mcp__notes__search', 'mcp__diary__write'];
    fake.setActing('client-a');
    await runPinnedTurn(fake.remote, 'panel-a', async () => {
      expect(loadableToolNames(both, userScopeReach(), false)).toEqual(['mcp__notes__search']);
      fake.setActing('client-b');
      await Promise.resolve();
      expect(loadableToolNames(both, userScopeReach(), false)).toEqual(['mcp__notes__search']);
    });
    await runPinnedTurn(fake.remote, 'panel-b', async () => {
      expect(loadableToolNames(both, userScopeReach(), false)).toEqual(['mcp__diary__write']);
    });
  });

  it('sends a turn\'s call to the device it is pinned to, and refuses a server only the other device relays', async () => {
    const fake = twoDevices();
    fake.setActing('client-a');
    await runPinnedTurn(fake.remote, 'panel-a', async () => {
      fake.setActing('client-b');
      await clientRelayCalls(fake.remote, 'notes').call('search', {}, new AbortController().signal);
      await expect(clientRelayCalls(fake.remote, 'diary').call('write', {}, new AbortController().signal)).rejects.toThrow(englishText(relayedMcpElsewhereReason('diary')));
    });
    expect(vi.mocked(fake.remote.mcpCall).mock.calls.map((call) => call.slice(0, 2))).toEqual([['client-a', 'notes']]);
  });
});
