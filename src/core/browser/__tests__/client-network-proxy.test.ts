import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_QUEUED_LOOKUPS, REMOTE_CONTEXT_CHROME_ARGS, sharedResolver, startClientNetworkProxy, type AddressConnector, type ClientNetworkProxy } from '../client-network-proxy';
import { resolveAddresses, type AddressResolver, type ClientNetworkPolicy } from '../client-network-policy';

// A stand-in for an address on the public internet; the recording connector reaches the test service for it.
const PUBLIC = '203.0.113.10';
const CLOSED: ClientNetworkPolicy = { allowedPorts: [], allowLocalNetwork: false };

interface Seen {
  readonly url: string;
  readonly host: string | undefined;
  readonly proxyConnection: string | undefined;
}

let service: Server;
let servicePort: number;
let seen: Seen[];
let connects: Array<{ addresses: readonly string[]; port: number }>;
let proxy: ClientNetworkProxy | undefined;

// Records the addresses the proxy connects to and reaches the test service whatever they are.
const recordingConnector: AddressConnector = (_name, addresses, port) => {
  connects.push({ addresses, port });
  return netConnect({ host: '127.0.0.1', port: servicePort });
};

// Wildcard DNS (127.0.0.1.nip.io) and the public stand-in answer from here; localhost goes to getaddrinfo.
const resolver: AddressResolver = async (hostname) => {
  if (hostname === '127.0.0.1.nip.io') return [{ address: '127.0.0.1', family: 4 }];
  if (hostname === 'public.test') return [{ address: PUBLIC, family: 4 }];
  return resolveAddresses(hostname);
};

beforeEach(async () => {
  seen = [];
  connects = [];
  service = createServer((req, res) => {
    seen.push({ url: req.url ?? '', host: req.headers.host, proxyConnection: req.headers['proxy-connection'] as string | undefined });
    res.end('client-only service');
  });
  service.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    seen.push({ url: req.url ?? '', host: req.headers.host, proxyConnection: req.headers['proxy-connection'] as string | undefined });
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  servicePort = (service.address() as AddressInfo).port;
});

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  service.closeAllConnections();
  await new Promise<void>((resolve) => service.close(() => resolve()));
});

async function start(policy: ClientNetworkPolicy, connect: AddressConnector = recordingConnector): Promise<ClientNetworkProxy> {
  proxy = await startClientNetworkProxy(policy, { resolve: resolver, connect });
  return proxy;
}

function proxyPort(p: ClientNetworkProxy): number {
  return Number(new URL(p.url).port);
}

// A plain http request in absolute form, as Chrome sends one to its proxy.
function get(p: ClientNetworkProxy, absoluteUrl: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxyPort(p), path: absoluteUrl, headers: { host: new URL(absoluteUrl).host, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// CONNECT, as Chrome sends one for https, ws and wss; an established tunnel carries one GET to the service.
function connectThrough(p: ClientNetworkProxy, authority: string): Promise<{ status: number; body: string; socket?: Socket }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxyPort(p), method: 'CONNECT', path: authority });
    req.on('connect', (res: IncomingMessage, socket: Socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        resolve({ status: res.statusCode ?? 0, body: '' });
        return;
      }
      let body = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        body += chunk;
        if (body.includes('client-only service')) resolve({ status: 200, body, socket });
      });
      socket.write(`GET /through HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    req.on('error', reject);
    req.end();
  });
}

const BYPASS_HOSTS = ['localhost', '127.0.0.1', '2130706433', '0x7f.1', '[::1]', '[::ffff:7f00:1]', '[::ffff:127.0.0.1]', '0.0.0.0', '127.0.0.1.nip.io'];
const PRIVATE_HOSTS = ['10.0.0.5', '172.16.4.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '[fe80::1]', '[fd00::1]', '[::]'];

describe('client network proxy, host switch off', () => {
  it('refuses every loopback form over plain http and CONNECT, and connects nowhere', async () => {
    const p = await start(CLOSED);
    for (const host of BYPASS_HOSTS) {
      expect((await get(p, `http://${host}:${servicePort}/`)).status, host).toBe(403);
      expect((await connectThrough(p, `${host}:${servicePort}`)).status, host).toBe(403);
    }
    expect(connects).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('refuses private, link-local, shared and unique-local addresses', async () => {
    const p = await start(CLOSED);
    for (const host of PRIVATE_HOSTS) {
      expect((await get(p, `http://${host}:80/`)).status, host).toBe(403);
      expect((await connectThrough(p, `${host}:443`)).status, host).toBe(403);
    }
    expect(connects).toEqual([]);
  });

  it('passes a public address, connecting to the address it resolved, with the hop-by-hop headers dropped', async () => {
    const p = await start(CLOSED);
    const answer = await get(p, `http://public.test:${servicePort}/a/b?c=1`, { 'proxy-connection': 'keep-alive' });
    expect(answer).toEqual({ status: 200, body: 'client-only service' });
    expect(connects).toEqual([{ addresses: [PUBLIC], port: servicePort }]);
    expect(seen).toEqual([{ url: '/a/b?c=1', host: `public.test:${servicePort}`, proxyConnection: undefined }]);
    expect((await connectThrough(p, `public.test:${servicePort}`)).status).toBe(200);
  });

  it('checks the address once: a name that rebinds from public to loopback reaches only the public answer', async () => {
    let calls = 0;
    let now = 0;
    const rebinding: AddressResolver = async () => (calls++ === 0 ? [{ address: PUBLIC, family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
    proxy = await startClientNetworkProxy(CLOSED, { resolve: rebinding, connect: recordingConnector, now: () => now });
    expect((await get(proxy, `http://rebind.test:${servicePort}/`)).status).toBe(200);
    expect(calls).toBe(1);
    expect(connects).toEqual([{ addresses: [PUBLIC], port: servicePort }]);
    now = 10_000;
    expect((await get(proxy, `http://rebind.test:${servicePort}/`)).status).toBe(403);
    expect((await connectThrough(proxy, `rebind.test:${servicePort}`)).status).toBe(403);
    expect(connects).toEqual([{ addresses: [PUBLIC], port: servicePort }]);
  });

  it('refuses a name with any loopback answer, even beside a public one', async () => {
    proxy = await startClientNetworkProxy(CLOSED, { resolve: async () => [{ address: PUBLIC, family: 4 }, { address: '::ffff:7f00:1', family: 6 }], connect: recordingConnector });
    expect((await get(proxy, `http://mixed.test:${servicePort}/`)).status).toBe(403);
    expect(connects).toEqual([]);
  });

  it('refuses a websocket upgrade sent in absolute form to loopback and passes one to a public address', async () => {
    const p = await start(CLOSED);
    const upgrade = (host: string): Promise<string> => new Promise((resolve, reject) => {
      const socket = netConnect({ host: '127.0.0.1', port: proxyPort(p) }, () => {
        socket.write(`GET http://${host}:${servicePort}/ws?x=1 HTTP/1.1\r\nHost: ${host}:${servicePort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nProxy-Connection: keep-alive\r\n\r\n`);
      });
      let text = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => (text += chunk));
      socket.on('close', () => resolve(text.split('\r\n')[0] ?? ''));
      socket.on('error', reject);
    });
    expect(await upgrade('localhost')).toBe('HTTP/1.1 403 Forbidden');
    expect(connects).toEqual([]);
    expect(await upgrade('public.test')).toBe('HTTP/1.1 101 Switching Protocols');
    expect(seen).toEqual([{ url: '/ws?x=1', host: `public.test:${servicePort}`, proxyConnection: undefined }]);
  });

  it('answers 400 to what is not a proxy request', async () => {
    const p = await start(CLOSED);
    const origin = await new Promise<number>((resolve) => {
      request({ host: '127.0.0.1', port: proxyPort(p), path: '/' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).end();
    });
    expect(origin).toBe(400);
    expect((await connectThrough(p, `public.test:${servicePort}/path`)).status).toBe(400);
    expect((await connectThrough(p, `user@public.test:${servicePort}`)).status).toBe(400);
    expect(connects).toEqual([]);
  });
});

describe('client network proxy, forwarded ports', () => {
  it('passes localhost:<forwarded> end to end with the real resolver and connector, and only that port', async () => {
    proxy = await startClientNetworkProxy({ allowedPorts: [servicePort], allowLocalNetwork: false });
    expect(await get(proxy, `http://localhost:${servicePort}/hmr`)).toEqual({ status: 200, body: 'client-only service' });
    expect((await connectThrough(proxy, `localhost:${servicePort}`)).status).toBe(200);
    expect((await get(proxy, `http://localhost:${servicePort + 1}/`)).status).toBe(403);
  });

  it('reaches a forwarded port on 127.0.0.1 for each loopback alias, and refuses the other loopback forms', async () => {
    const p = await start({ allowedPorts: [servicePort], allowLocalNetwork: false });
    for (const host of ['localhost', '127.0.0.1', '2130706433', '[::1]', '[::ffff:7f00:1]']) {
      expect((await get(p, `http://${host}:${servicePort}/`)).status, host).toBe(200);
    }
    expect(connects.every((target) => target.addresses.join() === '127.0.0.1' && target.port === servicePort)).toBe(true);
    connects = [];
    for (const host of ['0.0.0.0', '127.0.0.2', '[::]', '10.0.0.5']) {
      expect((await get(p, `http://${host}:${servicePort}/`)).status, host).toBe(403);
    }
    expect(connects).toEqual([]);
  });

  it('closes an open tunnel once its port is no longer forwarded', async () => {
    const p = await start({ allowedPorts: [servicePort], allowLocalNetwork: false });
    const { socket } = await connectThrough(p, `localhost:${servicePort}`);
    const closed = new Promise<void>((resolve) => socket!.on('close', () => resolve()));
    p.update({ allowedPorts: [servicePort + 1], allowLocalNetwork: false });
    await closed;
    expect((await get(p, `http://localhost:${servicePort}/`)).status).toBe(403);
  });
});

describe('client network proxy, host switch on', () => {
  it('passes every form, connecting to the canonical address', async () => {
    const p = await start({ allowedPorts: [], allowLocalNetwork: true });
    for (const host of [...BYPASS_HOSTS, ...PRIVATE_HOSTS]) {
      expect((await get(p, `http://${host}:${servicePort}/`)).status, host).toBe(200);
    }
    const canonical: Record<string, string> = { '2130706433': '127.0.0.1', '0x7f.1': '127.0.0.1', '[::ffff:127.0.0.1]': '::ffff:7f00:1', '0.0.0.0': '0.0.0.0', '127.0.0.1.nip.io': '127.0.0.1', '[fe80::1]': 'fe80::1' };
    for (const [host, address] of Object.entries(canonical)) {
      connects = [];
      expect((await get(p, `http://${host}:${servicePort}/`)).status, host).toBe(200);
      expect(connects, host).toEqual([{ addresses: [address], port: servicePort }]);
    }
  });

  it('closes the tunnels to this computer when the switch turns off, and keeps public ones', async () => {
    const p = await start({ allowedPorts: [], allowLocalNetwork: true });
    const local = await connectThrough(p, `127.0.0.1:${servicePort}`);
    const remote = await connectThrough(p, `public.test:${servicePort}`);
    const closed = new Promise<void>((resolve) => local.socket!.on('close', () => resolve()));
    p.update(CLOSED);
    await closed;
    expect(remote.socket!.destroyed).toBe(false);
    remote.socket!.destroy();
  });
});

describe('client network proxy, a name still resolving', () => {
  // slow.test answers 127.0.0.1 only once released, so the test acts while the proxy awaits it
  // asked: settles once `lookups` lookups of slow.test are waiting
  function slowResolver(lookups: number): { resolve: AddressResolver; release: () => void; asked: Promise<void> } {
    let release!: () => void;
    let asked!: () => void;
    let waiting = 0;
    const released = new Promise<void>((done) => (release = done));
    const askedPromise = new Promise<void>((done) => (asked = done));
    const resolve: AddressResolver = async (hostname) => {
      if (hostname !== 'slow.test') return resolver(hostname);
      if (++waiting === lookups) asked();
      await released;
      return [{ address: '127.0.0.1', family: 4 }];
    };
    return { resolve, release, asked: askedPromise };
  }

  it('connects nowhere when the policy refused the address while the name resolved', async () => {
    const slow = slowResolver(1);
    proxy = await startClientNetworkProxy({ allowedPorts: [servicePort], allowLocalNetwork: false }, { resolve: slow.resolve, connect: recordingConnector });
    const pending = get(proxy, `http://slow.test:${servicePort}/`);
    const tunnel = connectThrough(proxy, `slow.test:${servicePort}`);
    await slow.asked;
    proxy.update({ allowedPorts: [], allowLocalNetwork: false });
    slow.release();
    expect((await pending).status).toBe(403);
    expect((await tunnel).status).toBe(403);
    expect(connects).toEqual([]);
  });

  it('opens nothing for a client that went away while the name resolved', async () => {
    const slow = slowResolver(1);
    proxy = await startClientNetworkProxy({ allowedPorts: [servicePort], allowLocalNetwork: false }, { resolve: slow.resolve, connect: recordingConnector });
    const plain = request({ host: '127.0.0.1', port: proxyPort(proxy), path: `http://slow.test:${servicePort}/`, headers: { host: `slow.test:${servicePort}` } });
    plain.on('error', () => undefined);
    plain.end();
    const raw = netConnect({ host: '127.0.0.1', port: proxyPort(proxy) });
    raw.on('error', () => undefined);
    raw.write(`CONNECT slow.test:${servicePort} HTTP/1.1\r\nHost: slow.test:${servicePort}\r\n\r\n`);
    await slow.asked;
    // both requests reached the proxy before they go: a request after them on a new connection is answered first
    expect((await get(proxy, `http://[2001:db8::1]:${servicePort}/`)).status).toBe(200);
    const gone = Promise.all([new Promise((done) => plain.on('close', done)), new Promise((done) => raw.on('close', done))]);
    plain.destroy();
    raw.destroy();
    await gone;
    // the proxy heard the closes: a request on a new connection after them is answered after it handled them
    expect((await get(proxy, `http://[2001:db8::2]:${servicePort}/`)).status).toBe(200);
    connects = [];
    slow.release();
    // a later request settles after the released ones resumed, so their connects would be recorded by now
    expect((await get(proxy, `http://public.test:${servicePort}/`)).status).toBe(200);
    expect(connects).toEqual([{ addresses: [PUBLIC], port: servicePort }]);
  });
});

describe('client network proxy, its lookups', () => {
  it('runs one lookup per name for its requests until the answers expire, then looks the name up again', async () => {
    const asked: string[] = [];
    let now = 0;
    const counting: AddressResolver = async (hostname) => {
      asked.push(hostname);
      return [{ address: PUBLIC, family: 4 }];
    };
    proxy = await startClientNetworkProxy(CLOSED, { resolve: counting, connect: recordingConnector, now: () => now });
    const together = await Promise.all([get(proxy, `http://cached.test:${servicePort}/a`), connectThrough(proxy, `cached.test:${servicePort}`)]);
    together[1].socket?.destroy();
    expect((await get(proxy, `http://cached.test:${servicePort}/b`)).status).toBe(200);
    expect(together.map((answer) => answer.status)).toEqual([200, 200]);
    expect(asked).toEqual(['cached.test']);
    now = 9_999;
    expect((await get(proxy, `http://cached.test:${servicePort}/c`)).status).toBe(200);
    expect(asked).toEqual(['cached.test']);
    now = 10_000;
    expect((await get(proxy, `http://cached.test:${servicePort}/d`)).status).toBe(200);
    expect(asked).toEqual(['cached.test', 'cached.test']);
    expect(connects.every((target) => target.addresses.join() === PUBLIC)).toBe(true);
  });

  it('runs at most two lookups at once, whatever the page asks for', async () => {
    let running = 0;
    let most = 0;
    const releases: Array<() => void> = [];
    const slow: AddressResolver = async () => {
      running++;
      most = Math.max(most, running);
      await new Promise<void>((done) => releases.push(done));
      running--;
      return [{ address: PUBLIC, family: 4 }];
    };
    proxy = await startClientNetworkProxy(CLOSED, { resolve: slow, connect: recordingConnector });
    const p = proxy;
    const answers = Promise.all(['a', 'b', 'c', 'd', 'e'].map((name) => get(p, `http://${name}.slow.test:${servicePort}/`)));
    // every request reached the proxy: a literal needing no lookup, on a new connection after them, is answered after them
    expect((await get(p, `http://[2001:db8::1]:${servicePort}/`)).status).toBe(200);
    expect(running).toBe(2);
    while (releases.length > 0) {
      releases.shift()!();
      await new Promise((settle) => setImmediate(settle));
      expect(running).toBeLessThanOrEqual(2);
    }
    expect((await answers).map((answer) => answer.status)).toEqual([200, 200, 200, 200, 200]);
    expect(most).toBe(2);
  });
});

describe('client network proxy, lookups nobody waits for', () => {
  // each name's lookup waits until the test answers it; asked lists the names in the order their lookups ran
  function heldResolver(): { resolve: AddressResolver; asked: string[]; answer: (name: string) => void } {
    const asked: string[] = [];
    const answers = new Map<string, () => void>();
    const resolve: AddressResolver = async (hostname) => {
      asked.push(hostname);
      await new Promise<void>((done) => answers.set(hostname, done));
      return [{ address: PUBLIC, family: 4 }];
    };
    return { resolve, asked, answer: (name) => answers.get(name)!() };
  }
  const flush = (): Promise<void> => new Promise((settle) => setImmediate(settle));

  it('refuses a name past MAX_QUEUED_LOOKUPS waiting lookups at once, and queues one again once a place frees', async () => {
    const held = heldResolver();
    const resolve = sharedResolver(held.resolve, () => 0);
    const live = new AbortController().signal;
    const waiting = Array.from({ length: 2 + MAX_QUEUED_LOOKUPS }, (_, i) => resolve(`name-${i}.test`, live));
    await expect(resolve('one-too-many.test', live)).rejects.toThrow('too many names');
    expect(held.asked).toEqual(['name-0.test', 'name-1.test']);
    held.answer('name-0.test');
    await waiting[0];
    await flush();
    expect(held.asked.at(-1)).toBe('name-2.test');
    const queued = resolve('after-a-place-freed.test', live);
    for (let i = 1; i < 2 + MAX_QUEUED_LOOKUPS; i++) {
      await flush();
      held.answer(`name-${i}.test`);
    }
    await flush();
    expect(held.asked.at(-1)).toBe('after-a-place-freed.test');
    held.answer('after-a-place-freed.test');
    await expect(queued).resolves.toEqual([{ address: PUBLIC, family: 4 }]);
  });

  it('drops a waiting lookup once every request for its name went away, and runs the next one in its place', async () => {
    const held = heldResolver();
    const resolve = sharedResolver(held.resolve, () => 0);
    const live = new AbortController().signal;
    void resolve('a.test', live);
    void resolve('b.test', live);
    const leftC = new AbortController();
    const stillC = resolve('c.test', new AbortController().signal);
    const goneC = resolve('c.test', leftC.signal).catch((err: Error) => err.message);
    const leftD = new AbortController();
    const goneD = resolve('d.test', leftD.signal).catch((err: Error) => err.message);
    const e = resolve('e.test', live);
    leftC.abort();
    leftD.abort();
    await expect(goneD).resolves.toBe('every request for the name went away');
    held.answer('a.test');
    await flush();
    held.answer('b.test');
    await flush();
    // c still had a request, d had none left
    expect(held.asked).toEqual(['a.test', 'b.test', 'c.test', 'e.test']);
    held.answer('c.test');
    held.answer('e.test');
    await expect(stillC).resolves.toHaveLength(1);
    await expect(goneC).resolves.toHaveLength(1);
    await expect(e).resolves.toHaveLength(1);
    // a name whose lookup was dropped is looked up again for its next request
    const again = resolve('d.test', live);
    await flush();
    expect(held.asked.at(-1)).toBe('d.test');
    held.answer('d.test');
    await expect(again).resolves.toHaveLength(1);
  });

  it('takes a client\'s share of a waiting lookup when the client goes away', async () => {
    const held = heldResolver();
    proxy = await startClientNetworkProxy(CLOSED, { resolve: held.resolve, connect: recordingConnector });
    const p = proxy;
    const busy = [get(p, `http://busy-1.test:${servicePort}/`), get(p, `http://busy-2.test:${servicePort}/`)];
    await vi.waitFor(() => expect(held.asked).toHaveLength(2));
    const plain = request({ host: '127.0.0.1', port: proxyPort(p), path: `http://plain-gone.test:${servicePort}/`, headers: { host: `plain-gone.test:${servicePort}` } });
    plain.on('error', () => undefined);
    plain.end();
    const raw = netConnect({ host: '127.0.0.1', port: proxyPort(p) });
    raw.on('error', () => undefined);
    raw.write(`CONNECT raw-gone.test:${servicePort} HTTP/1.1\r\nHost: raw-gone.test:${servicePort}\r\n\r\n`);
    const kept = get(p, `http://kept.test:${servicePort}/`);
    const closed = Promise.all([new Promise((done) => plain.on('close', done)), new Promise((done) => raw.on('close', done))]);
    // both requests reached the proxy before they go: a request after them on a new connection is answered first
    expect((await get(p, `http://[2001:db8::1]:${servicePort}/`)).status).toBe(200);
    plain.destroy();
    raw.destroy();
    await closed;
    // the proxy heard the closes: a request on a new connection after them is answered after it handled them
    expect((await get(p, `http://[2001:db8::2]:${servicePort}/`)).status).toBe(200);
    held.answer('busy-1.test');
    held.answer('busy-2.test');
    await Promise.all(busy);
    await vi.waitFor(() => expect(held.asked).toContain('kept.test'));
    held.answer('kept.test');
    expect((await kept).status).toBe(200);
    expect(held.asked).toEqual(['busy-1.test', 'busy-2.test', 'kept.test']);
  });
});

describe('client network proxy, a name with several answers', () => {
  it('connects to the next checked answer when the first refuses the connection', async () => {
    // ::1 has nothing listening on the service's port, so its connection is refused and 127.0.0.1 is tried next
    const dual: AddressResolver = async () => [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }];
    proxy = await startClientNetworkProxy({ allowedPorts: [], allowLocalNetwork: true }, { resolve: dual });
    expect(await get(proxy, `http://dual.test:${servicePort}/`)).toEqual({ status: 200, body: 'client-only service' });
    expect((await connectThrough(proxy, `dual.test:${servicePort}`)).status).toBe(200);
  });

  it('checks every answer, connecting to none when the policy refuses one', async () => {
    const dual: AddressResolver = async () => [{ address: PUBLIC, family: 4 }, { address: '192.168.1.1', family: 4 }];
    proxy = await startClientNetworkProxy(CLOSED, { resolve: dual, connect: recordingConnector });
    expect((await get(proxy, `http://dual.test:${servicePort}/`)).status).toBe(403);
    expect(connects).toEqual([]);
  });
});

describe('client network proxy, a plain http body still streaming', () => {
  it('ends the client response when update() closes its upstream mid-body', async () => {
    const streaming = createServer((_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('first part');
    });
    await new Promise<void>((resolve) => streaming.listen(0, '127.0.0.1', resolve));
    const port = (streaming.address() as AddressInfo).port;
    try {
      proxy = await startClientNetworkProxy({ allowedPorts: [], allowLocalNetwork: true });
      const p = proxy;
      const ended = await new Promise<string>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: proxyPort(p), path: `http://127.0.0.1:${port}/`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
          res.once('data', () => p.update(CLOSED));
          res.on('error', () => undefined);
          res.on('close', () => resolve(res.complete ? 'complete' : 'cut'));
        });
        req.on('error', reject);
        req.end();
      });
      expect(ended).toBe('cut');
    } finally {
      streaming.closeAllConnections();
      await new Promise<void>((resolve) => streaming.close(() => resolve()));
    }
  });
});

it('remote contexts keep loopback behind the proxy and send no traffic around it', () => {
  expect(REMOTE_CONTEXT_CHROME_ARGS).toEqual(['--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']);
});
