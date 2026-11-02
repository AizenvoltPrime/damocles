import { describe, expect, it, vi } from 'vitest';
import { FEATURES } from '../../../../remote/protocol-version';
import { CLIENT_MCP_FEATURE, relayedServersOf, UserRelays, type LocalUserScope } from '../user-relays';
import { MCP_REMOTE_AVAILABLE_SETTING } from '../../../../shared/types/mcp';
import { MCP_REMOTE_AVAILABLE_SETTING as DESKTOP_SETTING } from '../../../local-services/desktop-configuration';
import type { RelayedMcpServer } from '../../../../shared/remote-user';

const notes = (): RelayedMcpServer => ({ name: 'notes', tools: [{ name: 'search', description: 'search it', inputSchema: { type: 'object' } }], resources: true });

describe('the relayed servers main publishes', () => {
  it('main rebuilds what crosses field by field, so a stray env or headers never leaves this computer', () => {
    const smuggled = { ...notes(), env: { TOKEN: 'secret' }, headers: { Authorization: 'Bearer x' }, tools: [{ ...notes().tools[0]!, env: { A: 'b' } }] } as unknown as RelayedMcpServer;
    expect(JSON.stringify(relayedServersOf([smuggled]))).not.toMatch(/secret|Bearer|env|headers/);
  });

  it('keeps each tool\'s config exposure and the server\'s timeout, which the remote side applies', () => {
    const server: RelayedMcpServer = { ...notes(), tools: [{ ...notes().tools[0]!, exposure: 'direct' }], timeoutMs: 600_000 };
    expect(relayedServersOf([server])).toEqual([server]);
  });

  it('names the same setting as the desktop configuration', () => {
    expect(MCP_REMOTE_AVAILABLE_SETTING).toBe(DESKTOP_SETTING);
  });
});

describe('main\'s checks of a relayed request', () => {
  const relays = (local: Partial<LocalUserScope>) => new UserRelays({
    resolveCredential: async () => ({ type: 'none' }),
    clientAuth: async () => ({ providers: {} }),
    voice: false,
    homedir: '/home/u',
    userSettingKeys: () => [],
    userValue: () => undefined,
    hostPolicy: () => ({ allowBypass: false }),
    local: { mcpServers: async () => [notes()], mcpCall: vi.fn(async () => ({ content: [] })), ...local } as LocalUserScope,
    log: () => undefined,
  });

  const signal = new AbortController().signal;

  it('forwards a call only of an opted-in server and a tool it lists', async () => {
    const mcpCall = vi.fn(async () => ({ content: [] }));
    const user = relays({ mcpCall });
    await user.mcpChanged();
    await expect(user.mcpCall('ssh+h', 'notes', 'search', {}, signal)).resolves.toEqual({ content: [] });
    await expect(user.mcpCall('ssh+h', 'notes', 'delete', {}, signal)).rejects.toThrow('has no tool');
    await expect(user.mcpCall('ssh+h', 'private', 'search', {}, signal)).rejects.toThrow('not available on remote hosts');
    expect(mcpCall).toHaveBeenCalledTimes(1);
  });

  it('hands the remote caller\'s abort to this computer\'s core, so its Stop ends the call here', async () => {
    const mcpCall = vi.fn(async () => ({ content: [] }));
    const mcpResources = vi.fn(async () => ({ resources: [] }));
    const mcpReadResource = vi.fn(async () => ({ contents: [] }));
    const user = relays({ mcpCall, mcpResources, mcpReadResource });
    await user.mcpChanged();
    const stop = new AbortController();
    await user.mcpCall('ssh+h', 'notes', 'search', {}, stop.signal);
    await user.mcpResources('ssh+h', 'notes', 'resources', undefined, stop.signal);
    await user.mcpReadResource('ssh+h', 'notes', 'notes://a', stop.signal);
    expect(mcpCall).toHaveBeenCalledWith('notes', 'search', {}, stop.signal);
    expect(mcpResources).toHaveBeenCalledWith('notes', 'resources', undefined, stop.signal);
    expect(mcpReadResource).toHaveBeenCalledWith('notes', 'notes://a', stop.signal);
  });

  it('holds a call that arrives before the first read of the servers until that read lands, then forwards it', async () => {
    let answer!: (servers: RelayedMcpServer[]) => void;
    const mcpCall = vi.fn(async () => ({ content: [] }));
    const user = relays({ mcpServers: () => new Promise((resolve) => (answer = resolve)), mcpCall });
    const early = user.mcpCall('ssh+h', 'notes', 'search', {}, signal);
    const read = user.mcpChanged();
    await Promise.resolve();
    expect(mcpCall).not.toHaveBeenCalled();
    answer([notes()]);
    await read;
    await expect(early).resolves.toEqual({ content: [] });
    expect(mcpCall).toHaveBeenCalledTimes(1);
  });

  it('publishes the opted-in servers to every attach', async () => {
    const user = relays({});
    await user.mcpChanged();
    const published: unknown[] = [];
    user.attach((topic, value) => published.push([topic, value]), 'ssh+h', false, FEATURES);
    expect(published).toEqual([['clientMcp', { servers: [notes()] }]]);
  });

  it('publishes an empty list at an attach too, so a reattach replaces the list the core kept from before', async () => {
    let servers: RelayedMcpServer[] = [notes()];
    const user = relays({ mcpServers: async () => servers });
    await user.mcpChanged();
    servers = [];
    await user.mcpChanged();
    const published: unknown[] = [];
    user.attach((topic, value) => published.push([topic, value]), 'ssh+h', false, FEATURES);
    expect(published).toEqual([['clientMcp', { servers: [] }]]);
  });

  // an older daemon's core channel closes the connection on a topic it does not know
  it('publishes nothing of clientMcp, at the attach or after a change, to a daemon whose welcome does not list it', async () => {
    let servers: RelayedMcpServer[] = [];
    const user = relays({ mcpServers: async () => servers });
    await user.mcpChanged();
    const older: unknown[] = [];
    const current: unknown[] = [];
    user.attach((topic, value) => older.push([topic, value]), 'ssh+old', false, FEATURES.filter((feature) => feature !== CLIENT_MCP_FEATURE));
    user.attach((topic, value) => current.push([topic, value]), 'ssh+new', false, FEATURES);
    servers = [notes()];
    await user.mcpChanged();
    expect(older).toEqual([]);
    expect(current).toEqual([['clientMcp', { servers: [] }], ['clientMcp', { servers: [notes()] }]]);
  });
});


describe('main\'s checks of a global profile answer', () => {
  const memory = (kind: 'fact' | 'preference' | 'note') => ({ id: 'm1', kind, content: 'c', contentHash: 'h', createdAt: 1, updatedAt: 1 });
  const relaysWith = (answer: unknown) => new UserRelays({
    resolveCredential: async () => ({ type: 'none' }),
    clientAuth: async () => ({ providers: {} }),
    voice: false,
    homedir: '/home/u',
    userSettingKeys: () => [],
    userValue: () => undefined,
    hostPolicy: () => ({ allowBypass: false }),
    local: { memoryProfile: async () => answer } as unknown as LocalUserScope,
    log: () => undefined,
  });

  it('passes pinned globals and preferences of their own kinds, and refuses any other kind', async () => {
    const good = { profile: { static: '', dynamic: '' }, pinned: [memory('fact')], preferences: [memory('preference')] };
    await expect(relaysWith(good).memoryProfile()).resolves.toEqual(good);
    await expect(relaysWith({ ...good, preferences: [memory('fact')] }).memoryProfile()).rejects.toThrow('wrong kind');
    await expect(relaysWith({ ...good, pinned: [memory('note')] }).memoryProfile()).rejects.toThrow('wrong kind');
  });
});

describe('main\'s relay of a global memory apply and search', () => {
  const relaysWith = (local: Partial<LocalUserScope>) => new UserRelays({
    resolveCredential: async () => ({ type: 'none' }),
    clientAuth: async () => ({ providers: {} }),
    voice: false,
    homedir: '/home/u',
    userSettingKeys: () => [],
    userValue: () => undefined,
    hostPolicy: () => ({ allowBypass: false }),
    local: local as LocalUserScope,
    log: () => undefined,
  });
  const write = (uuid: string) => ({ uuid, kind: 'fact' as const, content: uuid });

  it('passes the row each applied write is in, and refuses an answer naming more or fewer rows than it applied', async () => {
    const entries = [{ end: 10, write: write('u1') }, { end: 20, write: write('u2') }];
    await expect(relaysWith({ memoryApply: async () => ({ applied: 2, ids: ['u1', 'older-row'] }) }).memoryApply('ssh+h', entries)).resolves.toEqual({ through: 20, ids: ['u1', 'older-row'] });
    await expect(relaysWith({ memoryApply: async () => ({ applied: 2, ids: ['u1'] }) }).memoryApply('ssh+h', entries)).rejects.toThrow('1 rows for 2 writes');
  });

  it('asks this computer\'s core for an injection search when the remote core asked for one', async () => {
    const memorySearch = vi.fn(async () => []);
    await relaysWith({ memorySearch }).memorySearch('ssh+h', 'prompt', 4, ['global'], true);
    expect(memorySearch).toHaveBeenCalledWith('prompt', 4, ['global'], true, {});
  });
});
