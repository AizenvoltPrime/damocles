import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamChannel } from '../../../../remote/mux';
import { MAX_AGENT_CONNECTIONS } from '../../../daemon/agent-relay';
import { AgentRelays, localAgentPath, WINDOWS_AGENT_PIPE, type AgentRelayConnection } from '../agent-relay';
import type { ContainerHostRecord, HostRecord, SshHostRecord } from '../host-store';

const KEY = 'ab'.repeat(16);
const AUTHORITY = `container+${KEY}`;
const container = (settings: ContainerHostRecord['settings'], key = KEY): ContainerHostRecord => ({ id: 'h1', kind: 'container', key, engine: 'docker', origin: 'attach', containerName: 'web', user: 'root', name: 'web', recentFolders: [], settings });

describe('this computer\'s agent for the relay', () => {
  it('is main\'s SSH_AUTH_SOCK when set, else on Windows the OpenSSH agent pipe, else none', () => {
    expect(localAgentPath({ SSH_AUTH_SOCK: '/run/user/1000/agent.sock' }, 'linux')).toBe('/run/user/1000/agent.sock');
    expect(localAgentPath({ SSH_AUTH_SOCK: '\\\\.\\pipe\\my-agent' }, 'win32')).toBe('\\\\.\\pipe\\my-agent');
    expect(localAgentPath({ SSH_AUTH_SOCK: '' }, 'win32')).toBe(WINDOWS_AGENT_PIPE);
    expect(localAgentPath({}, 'win32')).toBe('\\\\.\\pipe\\openssh-ssh-agent');
    expect(localAgentPath({}, 'darwin')).toBeUndefined();
    expect(localAgentPath({ SSH_AUTH_SOCK: '' }, 'linux')).toBeUndefined();
  });
});

// A stream main opened: what it wrote, whether it ended, and the daemon's bytes.
function fakeStream(id: number) {
  const data = new Set<(bytes: Uint8Array) => void>();
  const written: string[] = [];
  let ended = false;
  const stream: StreamChannel = {
    id,
    closed: false,
    write: (bytes) => {
      written.push(Buffer.from(bytes).toString('utf8'));
      return true;
    },
    end: () => {
      ended = true;
    },
    onData: (listener) => {
      data.add(listener);
      return { dispose: () => data.delete(listener) };
    },
    onEnd: () => ({ dispose: () => undefined }),
    onDrain: () => ({ dispose: () => undefined }),
    pause: () => undefined,
    resume: () => undefined,
  };
  return { stream, written: () => written.join(''), ended: () => ended, send: (text: string) => data.forEach((listener) => listener(Buffer.from(text))) };
}

type Requests = { method: string; params: Record<string, unknown> };

// The container's connection as the relay uses it: the daemon's agent.request events, and what main answers.
function fakeConnection(options: { features?: string[]; connect?: (params: { request: number; stream: number }) => Promise<{ ok: boolean }> } = {}) {
  const events = new Set<(payload: { request: number }) => void>();
  const lostListeners = new Set<(reason: string) => void>();
  const closeListeners = new Set<(reason: string) => void>();
  const requests: Requests[] = [];
  const streams: ReturnType<typeof fakeStream>[] = [];
  let lost = false;
  const connection = {
    features: options.features ?? ['agent.relay'],
    control: {
      onEvent: (name: string, listener: (payload: { request: number }) => void) => {
        expect(name).toBe('agent.request');
        events.add(listener);
        return { dispose: () => events.delete(listener) };
      },
      request: async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params });
        if (method === 'agent.connect') return (options.connect ?? (async () => ({ ok: true })))(params as { request: number; stream: number });
        return undefined;
      },
    },
    openStream: () => {
      const made = fakeStream(16 + 2 * streams.length);
      streams.push(made);
      return made.stream;
    },
    onLost: (listener: (reason: string) => void) => {
      lostListeners.add(listener);
      return { dispose: () => lostListeners.delete(listener) };
    },
    onClose: (listener: (reason: string) => void) => {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    lost: () => lost,
  } as unknown as AgentRelayConnection;
  return {
    connection,
    requests,
    streams,
    ask: (request: number) => events.forEach((listener) => listener({ request })),
    lose: () => {
      lost = true;
      lostListeners.forEach((listener) => listener('dropped'));
    },
    close: () => closeListeners.forEach((listener) => listener('closed')),
  };
}

// A stand-in for this computer's agent: answers each connection's bytes with "agent:<bytes>", and counts connections.
async function fakeAgent() {
  const file = process.platform === 'win32' ? `\\\\.\\pipe\\damocles-relay-test-${randomBytes(6).toString('hex')}` : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-')), 'agent.sock');
  const open = new Set<net.Socket>();
  let accepted = 0;
  const server = net.createServer((socket) => {
    accepted++;
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => socket.write(`agent:${chunk.toString('utf8')}`));
  });
  await new Promise<void>((resolve) => server.listen(file, resolve));
  return {
    file,
    accepted: () => accepted,
    open: () => open.size,
    close: () => new Promise<void>((resolve) => {
      for (const socket of open) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

describe('the agent relay on this computer', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup(record: { current: HostRecord | undefined }, options: Parameters<typeof fakeConnection>[0] = {}) {
    const agent = await fakeAgent();
    cleanups.push(agent.close);
    const fake = fakeConnection(options);
    let current: AgentRelayConnection | undefined = fake.connection;
    const connectAgent = vi.fn((file: string) => net.connect(file));
    const relays = new AgentRelays({ record: () => record.current, connection: () => current, agentPath: () => agent.file, connectAgent, log: () => undefined });
    relays.attach(AUTHORITY, fake.connection);
    return { agent, fake, relays, connectAgent, replace: (next: AgentRelayConnection | undefined) => { current = next; } };
  }

  const answered = (fake: ReturnType<typeof fakeConnection>, method: string) => fake.requests.filter((request) => request.method === method).map((request) => request.params);

  it('tells the daemon it relays only when the daemon lists the feature', async () => {
    const { fake } = await setup({ current: container({ forwardAgent: true }) });
    expect(fake.requests).toEqual([{ method: 'agent.relay', params: {} }]);
    const old = await setup({ current: container({ forwardAgent: true }) }, { features: [] });
    expect(old.fake.requests).toEqual([]);
  });

  it('connects a request to this computer\'s agent over a stream it opens, and carries the bytes both ways', async () => {
    const { agent, fake } = await setup({ current: container({ forwardAgent: true }) });
    fake.ask(1);
    await vi.waitFor(() => expect(answered(fake, 'agent.connect')).toEqual([{ request: 1, stream: 16 }]));
    const stream = fake.streams[0]!;
    await vi.waitFor(() => expect(agent.open()).toBe(1));
    stream.send('identities?');
    await vi.waitFor(() => expect(stream.written()).toBe('agent:identities?'));
    expect(answered(fake, 'agent.refuse')).toEqual([]);
  });

  it('refuses while the container\'s switch is off, which is its default, and never touches the agent', async () => {
    const { agent, fake, connectAgent } = await setup({ current: container({}) });
    fake.ask(1);
    await vi.waitFor(() => expect(answered(fake, 'agent.refuse')).toEqual([{ request: 1 }]));
    expect(connectAgent).not.toHaveBeenCalled();
    expect(fake.streams).toEqual([]);
    expect(agent.accepted()).toBe(0);
  });

  it('refuses a request whose connection is not the authority\'s, or whose authority the record does not name', async () => {
    const record: { current: HostRecord | undefined } = { current: container({ forwardAgent: true }) };
    const { fake, replace, connectAgent } = await setup(record);
    // another container's record, an SSH host's and none at all for this authority
    record.current = container({ forwardAgent: true }, 'cd'.repeat(16));
    fake.ask(1);
    const ssh: SshHostRecord = { id: 'h1', kind: 'ssh', destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1', platform: { os: 'linux' }, recentFolders: [], settings: { forwardAgent: true } };
    record.current = ssh;
    fake.ask(2);
    record.current = undefined;
    fake.ask(3);
    // the right record, on a connection the authority no longer has
    record.current = container({ forwardAgent: true });
    replace(fakeConnection().connection);
    fake.ask(4);
    await vi.waitFor(() => expect(answered(fake, 'agent.refuse')).toEqual([{ request: 1 }, { request: 2 }, { request: 3 }, { request: 4 }]));
    expect(connectAgent).not.toHaveBeenCalled();
  });

  it('checks the switch again once the agent connected, and refuses without a stream when it went off meanwhile', async () => {
    const record: { current: HostRecord | undefined } = { current: container({ forwardAgent: true }) };
    const { fake, agent } = await setup(record);
    fake.ask(1);
    record.current = container({});
    await vi.waitFor(() => expect(answered(fake, 'agent.refuse')).toEqual([{ request: 1 }]));
    expect(fake.streams).toEqual([]);
    expect(answered(fake, 'agent.connect')).toEqual([]);
    await vi.waitFor(() => expect(agent.open()).toBe(0));
  });

  it('ends the stream and the agent connection when the daemon answers the request is gone', async () => {
    const { fake, agent } = await setup({ current: container({ forwardAgent: true }) }, { connect: async () => ({ ok: false }) });
    fake.ask(1);
    await vi.waitFor(() => expect(fake.streams[0]?.ended()).toBe(true));
    await vi.waitFor(() => expect(agent.open()).toBe(0));
  });

  it('resets every relayed connection at once when the switch turns off, and on a lost or closed connection', async () => {
    const record: { current: HostRecord | undefined } = { current: container({ forwardAgent: true }) };
    const { fake, agent, relays } = await setup(record);
    fake.ask(1);
    fake.ask(2);
    await vi.waitFor(() => expect(answered(fake, 'agent.connect')).toHaveLength(2));
    await vi.waitFor(() => expect(agent.open()).toBe(2));
    // a change that keeps forwarding resets nothing
    relays.policyChanged(AUTHORITY);
    expect(fake.streams.map((stream) => stream.ended())).toEqual([false, false]);
    record.current = container({});
    relays.policyChanged(AUTHORITY);
    expect(fake.streams.map((stream) => stream.ended())).toEqual([true, true]);
    await vi.waitFor(() => expect(agent.open()).toBe(0));

    record.current = container({ forwardAgent: true });
    fake.ask(3);
    await vi.waitFor(() => expect(agent.open()).toBe(1));
    fake.lose();
    expect(fake.streams[2]!.ended()).toBe(true);
    await vi.waitFor(() => expect(agent.open()).toBe(0));

    const other = await setup(record);
    other.fake.ask(1);
    await vi.waitFor(() => expect(other.agent.open()).toBe(1));
    other.fake.close();
    expect(other.fake.streams[0]!.ended()).toBe(true);
    await vi.waitFor(() => expect(other.agent.open()).toBe(0));
  });

  it(`refuses past ${MAX_AGENT_CONNECTIONS} agent connections open on one connection`, async () => {
    const { fake } = await setup({ current: container({ forwardAgent: true }) });
    for (let request = 1; request <= MAX_AGENT_CONNECTIONS + 1; request++) fake.ask(request);
    await vi.waitFor(() => expect(answered(fake, 'agent.refuse')).toEqual([{ request: MAX_AGENT_CONNECTIONS + 1 }]));
    await vi.waitFor(() => expect(answered(fake, 'agent.connect')).toHaveLength(MAX_AGENT_CONNECTIONS));
  });
});
