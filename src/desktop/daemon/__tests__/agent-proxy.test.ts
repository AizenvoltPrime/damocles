import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { duplexPair, type Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentSocketFile, agentSocketName } from '../../core-protocol/agent-sockets';
import { agentKeyOf, agentKeyOfSocket, createAgentProxy, isAgentSock, type AgentProxy, type AgentUpstream } from '../agent-proxy';
import type { AgentRelay } from '../agent-relay';

const sock = (path: string): AgentUpstream => ({ kind: 'socket', path });

describe('the agent socket a bridge may name', () => {
  it('is one absolute POSIX line within the socket path bound', () => {
    expect(isAgentSock('/tmp/ssh-XXXXabcd/agent.1234')).toBe(true);
    expect(isAgentSock('relative/agent.sock')).toBe(false);
    expect(isAgentSock('/tmp/a\n/b')).toBe(false);
    expect(isAgentSock(`/${'a'.repeat(200)}`)).toBe(false);
  });
});

interface FakeAgent {
  readonly path: string;
  // connections the agent accepted
  readonly accepted: () => number;
  close(): Promise<void>;
}

// A stand-in for a bridge's forwarded agent: answers every connection with its name, then ends it unless it holds connections.
async function fakeAgent(folder: string, name: string, options: { hold?: boolean } = {}): Promise<FakeAgent> {
  const file = path.join(folder, `${name}.sock`);
  let accepted = 0;
  const open = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    accepted++;
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => undefined);
    if (options.hold) socket.write(name);
    else socket.end(name);
  });
  await new Promise<void>((resolve) => server.listen(file, resolve));
  return {
    path: file,
    accepted: () => accepted,
    close: () => new Promise((resolve) => {
      for (const socket of open) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

function ask(file: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(file);
    let text = '';
    socket.on('data', (chunk) => { text += chunk.toString('utf8'); });
    socket.on('error', () => resolve(`refused:${text}`));
    socket.on('close', () => resolve(text));
  });
}

describe.runIf(process.platform !== 'win32')('the agent proxy (POSIX)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup(policy: Map<string, boolean>, uid: number = process.getuid!()) {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-proxy-'));
    cleanups.push(() => fs.rm(base, { recursive: true, force: true }));
    const log = vi.fn();
    const proxy: AgentProxy = createAgentProxy({ forwarding: (clientId) => policy.get(clientId) === true, policyKnown: (clientId) => policy.has(clientId), uid, log, base: async () => base, reattachUntil: () => 0 });
    cleanups.push(() => proxy.close());
    await proxy.start();
    const agents = path.join(base, 'agents');
    await fs.mkdir(agents);
    return { base, agents, folder: proxy.folder()!, proxy, log };
  }

  it('makes its own 0700 folder and listens there with mode 0600 for each client whose bridge named an agent', async () => {
    const { base, agents, folder, proxy } = await setup(new Map([['laptop', true]]));
    expect(path.dirname(folder)).toBe(base);
    expect((await fs.lstat(folder)).mode & 0o777).toBe(0o700);
    const laptop = await fakeAgent(agents, 'laptop');
    cleanups.push(laptop.close);
    proxy.setClient('laptop', sock(laptop.path));
    await proxy.settled();
    const file = agentSocketFile(folder, 'laptop');
    expect(proxy.socketFor('laptop')).toBe(file);
    const stat = await fs.lstat(file);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('pipes each client\'s socket to that client\'s agent only, whoever else forwards', async () => {
    const { agents, proxy } = await setup(new Map([['laptop', true], ['desktop', true]]));
    const laptop = await fakeAgent(agents, 'laptop');
    const desktop = await fakeAgent(agents, 'desktop');
    cleanups.push(laptop.close, desktop.close);
    proxy.setClient('laptop', sock(laptop.path));
    proxy.setClient('desktop', sock(desktop.path));
    await proxy.settled();
    expect(proxy.socketFor('laptop')).not.toBe(proxy.socketFor('desktop'));
    expect(await ask(proxy.socketFor('laptop')!)).toBe('laptop');
    expect(await ask(proxy.socketFor('desktop')!)).toBe('desktop');
    expect(await ask(proxy.socketFor('laptop')!)).toBe('laptop');
  });

  it('listens only while its client forwards, and closes the socket and every live connection once the policy turns it off', async () => {
    const policy = new Map([['laptop', false]]);
    const { folder, agents, proxy } = await setup(policy);
    const laptop = await fakeAgent(agents, 'laptop', { hold: true });
    cleanups.push(laptop.close);
    proxy.setClient('laptop', sock(laptop.path));
    await proxy.settled();
    // forwarding off: spawned processes get no SSH_AUTH_SOCK, and no socket exists to connect to
    expect(proxy.socketFor('laptop')).toBeUndefined();
    expect(fsSync.existsSync(agentSocketFile(folder, 'laptop'))).toBe(false);
    policy.set('laptop', true);
    proxy.policyChanged();
    await proxy.settled();
    const file = proxy.socketFor('laptop')!;
    expect(file).toBe(agentSocketFile(folder, 'laptop'));
    const client = net.connect(file);
    const closed = new Promise<void>((resolve) => client.on('close', () => resolve()));
    await new Promise<void>((resolve) => client.once('data', () => resolve()));
    // switched off mid-session: the socket goes and the open connection ends, with no new connection or attach
    policy.set('laptop', false);
    proxy.policyChanged();
    await proxy.settled();
    await closed;
    expect(proxy.socketFor('laptop')).toBeUndefined();
    expect(fsSync.existsSync(file)).toBe(false);
  });

  it('stops listening once its bridge names no agent', async () => {
    const { folder, agents, proxy } = await setup(new Map([['laptop', true]]));
    const laptop = await fakeAgent(agents, 'laptop');
    cleanups.push(laptop.close);
    proxy.setClient('laptop', sock(laptop.path));
    await proxy.settled();
    expect(proxy.socketFor('laptop')).toBeDefined();
    proxy.setClient('laptop', undefined);
    await proxy.settled();
    expect(proxy.socketFor('laptop')).toBeUndefined();
    expect(fsSync.existsSync(agentSocketFile(folder, 'laptop'))).toBe(false);
    expect(laptop.accepted()).toBe(0);
  });

  it('pipes a connection a terminal host forwarded under a client\'s key to that client\'s agent, and names the key of its own socket', async () => {
    const { agents, proxy } = await setup(new Map([['laptop', true], ['desktop', true]]));
    const laptop = await fakeAgent(agents, 'laptop');
    const desktop = await fakeAgent(agents, 'desktop');
    cleanups.push(laptop.close, desktop.close);
    proxy.setClient('laptop', sock(laptop.path));
    proxy.setClient('desktop', sock(desktop.path));
    await proxy.settled();
    expect(agentKeyOfSocket(proxy.socketFor('laptop')!)).toBe(agentKeyOf('laptop'));
    expect(agentKeyOfSocket(laptop.path)).toBeUndefined();
    const [mine, theirs] = duplexPair();
    proxy.forwarded(agentKeyOf('laptop'), theirs);
    expect(await new Promise<string>((resolve) => mine.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8'))))).toBe('laptop');
    expect(desktop.accepted()).toBe(0);
  });

  it('hands each connection on a relaying client\'s socket to that client\'s relay only, never another client\'s', async () => {
    const { agents, proxy } = await setup(new Map([['laptop', true], ['desktop', true]]));
    const asked: string[] = [];
    const relayOf = (clientId: string): AgentRelay => ({
      request: (incoming) => {
        asked.push(clientId);
        incoming.end(clientId);
      },
      connect: () => false,
      refuse: () => undefined,
      close: () => undefined,
    });
    const desktop = await fakeAgent(agents, 'desktop');
    cleanups.push(desktop.close);
    proxy.setClient('laptop', { kind: 'relay', relay: relayOf('laptop') });
    proxy.setClient('desktop', sock(desktop.path));
    await proxy.settled();
    expect(await ask(proxy.socketFor('laptop')!)).toBe('laptop');
    expect(await ask(proxy.socketFor('desktop')!)).toBe('desktop');
    expect(asked).toEqual(['laptop']);
    expect(desktop.accepted()).toBe(1);
  });

  it('never proxies to a path that is not a socket, or to another user\'s socket', async () => {
    const { agents, proxy, log } = await setup(new Map([['laptop', true]]));
    const notSocket = path.join(agents, 'plain-file');
    await fs.writeFile(notSocket, 'x');
    proxy.setClient('laptop', sock(notSocket));
    await proxy.settled();
    expect(await ask(proxy.socketFor('laptop')!)).toBe('');
    expect(log).toHaveBeenCalledWith(`[agent] refused a connection: ${notSocket} is not a socket of this user`);
    // a real socket the daemon's uid does not own
    const other = await setup(new Map([['laptop', true]]), process.getuid!() + 1);
    const agent = await fakeAgent(other.agents, 'laptop');
    cleanups.push(agent.close);
    other.proxy.setClient('laptop', sock(agent.path));
    await other.proxy.settled();
    expect(await ask(other.proxy.socketFor('laptop')!)).toBe('');
    expect(other.log).toHaveBeenCalledWith(`[agent] refused a connection: ${agent.path} is not a socket of this user`);
    expect(agent.accepted()).toBe(0);
  });

  it('listens on a later attach when a socket could not listen before', async () => {
    const { folder, agents, proxy, log } = await setup(new Map([['laptop', true]]));
    const laptop = await fakeAgent(agents, 'laptop');
    cleanups.push(laptop.close);
    const file = agentSocketFile(folder, 'laptop');
    await fs.writeFile(file, 'in the way');
    proxy.setClient('laptop', sock(laptop.path));
    await proxy.settled();
    expect(proxy.socketFor('laptop')).toBeUndefined();
    expect(log.mock.calls.some(([line]) => String(line).startsWith('[agent] could not listen for laptop: '))).toBe(true);
    await fs.rm(file);
    proxy.setClient('laptop', sock(laptop.path));
    await proxy.settled();
    expect(await ask(proxy.socketFor('laptop')!)).toBe('laptop');
  });

  it('ends a client\'s connection when its agent ends it mid-reply', async () => {
    const { agents, proxy } = await setup(new Map([['laptop', true]]));
    const file = path.join(agents, 'cut.sock');
    const server = net.createServer((socket) => {
      socket.write('partial');
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(file, resolve));
    cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
    proxy.setClient('laptop', sock(file));
    await proxy.settled();
    expect(await ask(proxy.socketFor('laptop')!)).toBe('partial');
  });

  it('removes its sockets and its folder on close, and drops live connections', async () => {
    const { folder, agents, proxy } = await setup(new Map([['laptop', true]]));
    const laptop = await fakeAgent(agents, 'laptop', { hold: true });
    cleanups.push(laptop.close);
    proxy.setClient('laptop', sock(laptop.path));
    await proxy.settled();
    const client = net.connect(proxy.socketFor('laptop')!);
    const closed = new Promise<void>((resolve) => client.on('close', () => resolve()));
    await new Promise<void>((resolve) => client.once('data', () => resolve()));
    await proxy.close();
    await closed;
    expect(fsSync.existsSync(folder)).toBe(false);
    expect(proxy.folder()).toBeUndefined();
    expect(proxy.kept()).toBeUndefined();
  });

  it('opens no connection to the agent for a connection dropped while its agent socket was checked', async () => {
    const { agents, proxy } = await setup(new Map([['laptop', true]]));
    const laptop = await fakeAgent(agents, 'laptop');
    cleanups.push(laptop.close);
    proxy.setClient('laptop', sock(laptop.path));
    await proxy.settled();
    const socket = proxy.socketFor('laptop')!;
    const realLstat = fs.lstat.bind(fs);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let checking!: () => void;
    const checked = new Promise<void>((resolve) => { checking = resolve; });
    let check: Promise<fsSync.Stats> | undefined;
    vi.spyOn(fs, 'lstat').mockImplementation(((target: fsSync.PathLike) => {
      check = (async () => {
        checking();
        await held;
        return realLstat(target);
      })();
      return check;
    }) as typeof fs.lstat);
    const client = net.connect(socket);
    client.on('error', () => undefined);
    await checked;
    // close drops the connection while its check is in flight
    await proxy.close();
    release();
    await check;
    await new Promise((resolve) => setImmediate(resolve));
    vi.restoreAllMocks();
    // a connection the proxy opened for it would reach the agent before this one
    await new Promise<void>((resolve) => net.connect(laptop.path).on('close', () => resolve()).on('data', () => undefined));
    expect(laptop.accepted()).toBe(1);
  });

  it('moves every socket to a new folder when its folder was removed, and names that folder from then on', async () => {
    const { agents, folder, proxy } = await setup(new Map([['laptop', true]]));
    const laptop = await fakeAgent(agents, 'laptop');
    cleanups.push(laptop.close);
    proxy.setClient('laptop', sock(laptop.path));
    await proxy.settled();
    const kept = proxy.kept()!;
    expect(kept.files).toEqual([folder, agentSocketFile(folder, 'laptop')]);
    await fs.rm(folder, { recursive: true });
    await kept.rebind();
    const moved = proxy.folder()!;
    expect(moved).not.toBe(folder);
    expect(proxy.socketFor('laptop')).toBe(agentSocketFile(moved, 'laptop'));
    expect(await ask(proxy.socketFor('laptop')!)).toBe('laptop');
    // a stale entry's rebind changes nothing
    await kept.rebind();
    expect(proxy.folder()).toBe(moved);
  });

  it('names a client\'s key by its socket\'s form, so a terminal environment made before a rebind or a forwarding toggle still gets the host\'s socket', async () => {
    const policy = new Map([['laptop', true]]);
    const { agents, folder, proxy } = await setup(policy);
    const laptop = await fakeAgent(agents, 'laptop');
    cleanups.push(laptop.close);
    proxy.setClient('laptop', sock(laptop.path));
    await proxy.settled();
    const before = proxy.socketFor('laptop')!;
    await fs.rm(folder, { recursive: true });
    await proxy.kept()!.rebind();
    expect(proxy.socketFor('laptop')).not.toBe(before);
    expect(agentKeyOfSocket(before)).toBe(agentKeyOf('laptop'));
    policy.set('laptop', false);
    proxy.policyChanged();
    await proxy.settled();
    expect(proxy.socketFor('laptop')).toBeUndefined();
    expect(agentKeyOfSocket(before)).toBe(agentKeyOf('laptop'));
  });
});

describe('the key of a daemon\'s agent socket', () => {
  it('is the hex of agent-<24 hex>.sock in a damocles- socket folder, and undefined for a socket of any other form, which a shell keeps', () => {
    const key = agentKeyOf('laptop');
    expect(agentKeyOfSocket(`/tmp/damocles-AbC123/agent-${key}.sock`)).toBe(key);
    expect(agentKeyOfSocket(`/run/user/1000/damocles-xyz789/agent-${key}.sock`)).toBe(key);
    for (const own of ['/tmp/ssh-XXXXabcd/agent.1234', `/tmp/other-AbC123/agent-${key}.sock`, `/tmp/damocles-AbC123/agent-${key.slice(1)}.sock`, `/tmp/damocles-AbC123/agent-${key.toUpperCase()}.sock`, `damocles-AbC123/agent-${key}.sock`, `/tmp/damocles-AbC123/sub/agent-${key}.sock`, '\\\\.\\pipe\\openssh-ssh-agent']) {
      expect(agentKeyOfSocket(own)).toBeUndefined();
    }
  });
});

describe('a connection a terminal host forwarded from its agent socket', () => {
  const proxies: AgentProxy[] = [];
  // the reattach window of a server that started listening now, ending ms from now
  const until = (ms: number): (() => number) => {
    const end = Date.now() + ms;
    return () => end;
  };
  afterEach(async () => {
    for (const proxy of proxies.splice(0)) await proxy.close();
  });

  // relaying clients, each recording the connections it was handed
  function setup(policy: Map<string, boolean>): { proxy: AgentProxy; handed: Map<string, Duplex[]>; lines: string[] } {
    const lines: string[] = [];
    const proxy = createAgentProxy({ forwarding: (clientId) => policy.get(clientId) === true, policyKnown: (clientId) => policy.has(clientId), uid: process.getuid?.(), log: (line) => lines.push(line), reattachUntil: until(200) });
    proxies.push(proxy);
    const handed = new Map<string, Duplex[]>();
    for (const clientId of policy.keys()) {
      handed.set(clientId, []);
      proxy.setClient(clientId, { kind: 'relay', relay: { request: (incoming) => handed.get(clientId)!.push(incoming), connect: () => false, refuse: () => undefined, close: () => undefined } });
    }
    return { proxy, handed, lines };
  }

  it('reaches the client whose key the host names through agentSocketName, and no other client', async () => {
    const { proxy, handed } = setup(new Map([['laptop', true], ['desktop', true]]));
    expect(agentKeyOf('laptop')).toMatch(/^[0-9a-f]{24}$/);
    expect(`agent-${agentKeyOf('laptop')}.sock`).toBe(agentSocketName('laptop'));
    const [, theirs] = duplexPair();
    proxy.forwarded(agentKeyOf('laptop'), theirs);
    expect(handed.get('laptop')).toEqual([theirs]);
    expect(handed.get('desktop')).toEqual([]);
  });

  it('refuses a key no client has, once the wait for one is over', async () => {
    const { proxy, handed, lines } = setup(new Map([['laptop', true]]));
    const [, theirs] = duplexPair();
    proxy.forwarded(agentKeyOf('stranger'), theirs);
    expect(theirs.destroyed).toBe(false);
    await vi.waitFor(() => expect(theirs.destroyed).toBe(true));
    expect(handed.get('laptop')).toEqual([]);
    expect(lines).toContain('[agent] refused a forwarded connection: no client of its key forwards its SSH agent');
  });

  it('refuses a key no client has at once once the clients of a switch had their time to reattach, as a gone computer\'s key', () => {
    const lines: string[] = [];
    const proxy = createAgentProxy({ forwarding: () => true, policyKnown: () => true, uid: process.getuid?.(), log: (line) => lines.push(line), reattachUntil: until(-1) });
    proxies.push(proxy);
    const [, theirs] = duplexPair();
    proxy.forwarded(agentKeyOf('stranger'), theirs);
    expect(theirs.destroyed).toBe(true);
    expect(lines).toContain('[agent] refused a forwarded connection: no client of its key forwards its SSH agent');
  });

  it('refuses at once a client whose policy does not forward its agent, and ends its forwarded connections once its policy turns forwarding off', async () => {
    const policy = new Map([['laptop', false]]);
    const { proxy, handed, lines } = setup(policy);
    const [, refused] = duplexPair();
    proxy.forwarded(agentKeyOf('laptop'), refused);
    expect(refused.destroyed).toBe(true);
    expect(handed.get('laptop')).toEqual([]);
    expect(lines).toContain('[agent] refused a forwarded connection: its client does not forward its SSH agent');
    policy.set('laptop', true);
    proxy.policyChanged();
    await proxy.settled();
    const [, taken] = duplexPair();
    proxy.forwarded(agentKeyOf('laptop'), taken);
    expect(handed.get('laptop')).toEqual([taken]);
    policy.set('laptop', false);
    proxy.policyChanged();
    await proxy.settled();
    expect(taken.destroyed).toBe(true);
  });

  it('holds a connection forwarded before its client reattached, as in a switch, and hands it over once that client forwards its agent', async () => {
    const policy = new Map<string, boolean>();
    const lines: string[] = [];
    const proxy = createAgentProxy({ forwarding: (clientId) => policy.get(clientId) === true, policyKnown: (clientId) => policy.has(clientId), uid: process.getuid?.(), log: (line) => lines.push(line), reattachUntil: until(30_000) });
    proxies.push(proxy);
    const handed: Duplex[] = [];
    const [, early] = duplexPair();
    proxy.forwarded(agentKeyOf('laptop'), early);
    // the client's connection names its upstream, and its attach brings the policy
    proxy.setClient('laptop', { kind: 'relay', relay: { request: (incoming) => handed.push(incoming), connect: () => false, refuse: () => undefined, close: () => undefined } });
    await proxy.settled();
    expect(handed).toEqual([]);
    policy.set('laptop', true);
    proxy.policyChanged();
    await proxy.settled();
    expect(handed).toEqual([early]);
    expect(early.destroyed).toBe(false);
    expect(lines.filter((line) => line.includes('refused'))).toEqual([]);
  });

  it('starts the wait of a connection forwarded before the endpoint listens only once it does, so the window runs from then', async () => {
    // the server's reattach window, unknown until its endpoint listens
    const reattach: { until?: number } = {};
    const lines: string[] = [];
    const proxy = createAgentProxy({ forwarding: () => true, policyKnown: () => true, uid: process.getuid?.(), log: (line) => lines.push(line), reattachUntil: () => reattach.until });
    proxies.push(proxy);
    const [, early] = duplexPair();
    proxy.forwarded(agentKeyOf('laptop'), early);
    // a window that would be over had the wait started before the endpoint listened
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(early.destroyed).toBe(false);
    reattach.until = Date.now();
    proxy.accepting();
    await vi.waitFor(() => expect(early.destroyed).toBe(true));
    expect(lines).toContain('[agent] refused a forwarded connection: no client of its key forwards its SSH agent');
  });

  it('refuses a held connection once its client\'s policy arrives and does not forward its agent', async () => {
    const policy = new Map<string, boolean>();
    const lines: string[] = [];
    const proxy = createAgentProxy({ forwarding: (clientId) => policy.get(clientId) === true, policyKnown: (clientId) => policy.has(clientId), uid: process.getuid?.(), log: (line) => lines.push(line), reattachUntil: until(30_000) });
    proxies.push(proxy);
    const handed: Duplex[] = [];
    const [, early] = duplexPair();
    proxy.forwarded(agentKeyOf('laptop'), early);
    proxy.setClient('laptop', { kind: 'relay', relay: { request: (incoming) => handed.push(incoming), connect: () => false, refuse: () => undefined, close: () => undefined } });
    await proxy.settled();
    expect(early.destroyed).toBe(false);
    policy.set('laptop', false);
    proxy.policyChanged();
    await proxy.settled();
    expect(early.destroyed).toBe(true);
    expect(handed).toEqual([]);
    expect(lines).toContain('[agent] refused a forwarded connection: its client does not forward its SSH agent');
  });

  it('drops a held connection when it closes', async () => {
    const proxy = createAgentProxy({ forwarding: () => true, policyKnown: () => true, uid: process.getuid?.(), log: () => undefined, reattachUntil: until(30_000) });
    const [, early] = duplexPair();
    proxy.forwarded(agentKeyOf('laptop'), early);
    await proxy.close();
    expect(early.destroyed).toBe(true);
  });
});
