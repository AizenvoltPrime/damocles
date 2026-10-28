import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentSocketFile } from '../../core-protocol/agent-sockets';
import { createAgentProxy, isAgentSock, type AgentProxy } from '../agent-proxy';

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
    const proxy: AgentProxy = createAgentProxy({ forwarding: (clientId) => policy.get(clientId) === true, uid, log, base: async () => base });
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
    proxy.setClient('laptop', laptop.path);
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
    proxy.setClient('laptop', laptop.path);
    proxy.setClient('desktop', desktop.path);
    await proxy.settled();
    expect(proxy.socketFor('laptop')).not.toBe(proxy.socketFor('desktop'));
    expect(await ask(proxy.socketFor('laptop')!)).toBe('laptop');
    expect(await ask(proxy.socketFor('desktop')!)).toBe('desktop');
    expect(await ask(proxy.socketFor('laptop')!)).toBe('laptop');
  });

  it('refuses every connection while its client does not forward, and stops listening once its bridge names no agent', async () => {
    const policy = new Map([['laptop', false]]);
    const { folder, agents, proxy, log } = await setup(policy);
    const laptop = await fakeAgent(agents, 'laptop');
    cleanups.push(laptop.close);
    proxy.setClient('laptop', laptop.path);
    await proxy.settled();
    // forwarding off: spawned processes get no SSH_AUTH_SOCK, and the socket answers nothing
    expect(proxy.socketFor('laptop')).toBeUndefined();
    expect(await ask(agentSocketFile(folder, 'laptop'))).toBe('');
    expect(log).toHaveBeenCalledWith('[agent] refused a connection: its client does not forward its SSH agent');
    policy.set('laptop', true);
    proxy.setClient('laptop', undefined);
    await proxy.settled();
    expect(proxy.socketFor('laptop')).toBeUndefined();
    expect(fsSync.existsSync(agentSocketFile(folder, 'laptop'))).toBe(false);
    expect(laptop.accepted()).toBe(0);
  });

  it('never proxies to a path that is not a socket, or to another user\'s socket', async () => {
    const { agents, proxy, log } = await setup(new Map([['laptop', true]]));
    const notSocket = path.join(agents, 'plain-file');
    await fs.writeFile(notSocket, 'x');
    proxy.setClient('laptop', notSocket);
    await proxy.settled();
    expect(await ask(proxy.socketFor('laptop')!)).toBe('');
    expect(log).toHaveBeenCalledWith(`[agent] refused a connection: ${notSocket} is not a socket of this user`);
    // a real socket the daemon's uid does not own
    const other = await setup(new Map([['laptop', true]]), process.getuid!() + 1);
    const agent = await fakeAgent(other.agents, 'laptop');
    cleanups.push(agent.close);
    other.proxy.setClient('laptop', agent.path);
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
    proxy.setClient('laptop', laptop.path);
    await proxy.settled();
    expect(proxy.socketFor('laptop')).toBeUndefined();
    expect(log.mock.calls.some(([line]) => String(line).startsWith('[agent] could not listen for laptop: '))).toBe(true);
    await fs.rm(file);
    proxy.setClient('laptop', laptop.path);
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
    proxy.setClient('laptop', file);
    await proxy.settled();
    expect(await ask(proxy.socketFor('laptop')!)).toBe('partial');
  });

  it('removes its sockets and its folder on close, and drops live connections', async () => {
    const { folder, agents, proxy } = await setup(new Map([['laptop', true]]));
    const laptop = await fakeAgent(agents, 'laptop', { hold: true });
    cleanups.push(laptop.close);
    proxy.setClient('laptop', laptop.path);
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
    proxy.setClient('laptop', laptop.path);
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
    proxy.setClient('laptop', laptop.path);
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
});
