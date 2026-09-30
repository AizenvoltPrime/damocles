import * as http from 'node:http';
import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { powerMonitor, type Session } from 'electron';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { powerMonitor: new EventEmitter() };
});

import { installProxyDispatcher, parseProxyList } from '../proxy-dispatcher';

const ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];
const savedEnv: Record<string, string | undefined> = {};
const servers: net.Server[] = [];
const lines: string[] = [];
const log = (line: string): void => {
  lines.push(line);
};

function listen(server: net.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}

function target(body: string): Promise<number> {
  return listen(http.createServer((_req, res) => res.end(body)));
}

/** A CONNECT proxy that records every tunnel it opens. */
async function connectProxy(): Promise<{ port: number; tunnels: string[] }> {
  const tunnels: string[] = [];
  const proxy = http.createServer((_req, res) => {
    res.statusCode = 405;
    res.end();
  });
  proxy.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    tunnels.push(req.url ?? '');
    const [host, port] = (req.url ?? '').split(':');
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  return { port: await listen(proxy), tunnels };
}

function chromium(answer: (origin: string) => string): Session & { resolveProxy: ReturnType<typeof vi.fn> } {
  return { resolveProxy: vi.fn(async (origin: string) => answer(origin)) } as unknown as Session & { resolveProxy: ReturnType<typeof vi.fn> };
}

let disposable: { dispose(): void } | undefined;

beforeEach(() => {
  lines.length = 0;
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  disposable?.dispose();
  disposable = undefined;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    (s as http.Server).closeAllConnections?.();
    s.close(() => resolve());
  })));
});

describe('parseProxyList', () => {
  it('takes the first route undici supports, in Chromium order', () => {
    expect(parseProxyList('DIRECT')).toEqual({ route: { kind: 'direct' }, skipped: [] });
    expect(parseProxyList('PROXY proxy.corp:8080; DIRECT')).toEqual({ route: { kind: 'proxy', uri: 'http://proxy.corp:8080' }, skipped: [] });
    expect(parseProxyList('HTTPS secure.corp:443')).toEqual({ route: { kind: 'proxy', uri: 'https://secure.corp:443' }, skipped: [] });
    expect(parseProxyList('SOCKS old.corp:1080;SOCKS5 socks.corp:1080')).toEqual({
      route: { kind: 'proxy', uri: 'socks5://socks.corp:1080' },
      skipped: ['SOCKS'],
    });
    expect(parseProxyList('QUIC q.corp:443')).toEqual({ route: { kind: 'direct' }, skipped: ['QUIC'] });
  });
});

describe('installProxyDispatcher', () => {
  it('sends an origin through the proxy Chromium names, caches the answer, and asks again after a resume', async () => {
    const proxy = await connectProxy();
    const port = await target('via proxy');
    const session = chromium(() => `PROXY 127.0.0.1:${proxy.port}`);
    disposable = installProxyDispatcher(session, log);

    expect(await (await fetch(`http://127.0.0.1:${port}/a`)).text()).toBe('via proxy');
    expect(await (await fetch(`http://127.0.0.1:${port}/b`)).text()).toBe('via proxy');
    expect(proxy.tunnels).toContain(`127.0.0.1:${port}`);
    expect(session.resolveProxy).toHaveBeenCalledTimes(1);
    expect(session.resolveProxy).toHaveBeenCalledWith(`http://127.0.0.1:${port}`);

    powerMonitor.emit('resume');
    await (await fetch(`http://127.0.0.1:${port}/c`)).text();
    expect(session.resolveProxy).toHaveBeenCalledTimes(2);
  });

  it('connects directly for DIRECT and for a proxy type undici lacks, saying why', async () => {
    const proxy = await connectProxy();
    const direct = await target('direct');
    const socks4 = await target('socks4 fallback');
    const session = chromium((origin) => (origin.endsWith(`:${direct}`) ? 'DIRECT' : `SOCKS 127.0.0.1:${proxy.port}`));
    disposable = installProxyDispatcher(session, log);

    expect(await (await fetch(`http://127.0.0.1:${direct}/`)).text()).toBe('direct');
    expect(await (await fetch(`http://127.0.0.1:${socks4}/`)).text()).toBe('socks4 fallback');
    expect(proxy.tunnels).toEqual([]);
    expect(lines.some((line) => line.includes('skipped unsupported proxy types SOCKS'))).toBe(true);
  });

  it('honors HTTP(S)_PROXY over Chromium, and never logs the proxy credentials', async () => {
    const proxy = await connectProxy();
    const port = await target('env proxy');
    process.env['HTTP_PROXY'] = `http://someone:hunter2@127.0.0.1:${proxy.port}`;
    process.env['HTTPS_PROXY'] = process.env['HTTP_PROXY'];
    const session = chromium(() => 'DIRECT');
    disposable = installProxyDispatcher(session, log);

    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('env proxy');
    expect(proxy.tunnels).toContain(`127.0.0.1:${port}`);
    expect(session.resolveProxy).not.toHaveBeenCalled();
    expect(lines.join('\n')).not.toContain('hunter2');
  });

  it('connects directly to an origin NO_PROXY names, and through HTTP(S)_PROXY to any other', async () => {
    const proxy = await connectProxy();
    const excluded = await target('excluded');
    process.env['HTTP_PROXY'] = `http://127.0.0.1:${proxy.port}`;
    process.env['NO_PROXY'] = `127.0.0.1:${excluded}`;
    disposable = installProxyDispatcher(chromium(() => 'DIRECT'), log);

    expect(await (await fetch(`http://127.0.0.1:${excluded}/`)).text()).toBe('excluded');
    expect(proxy.tunnels).toEqual([]);
    const proxied = await target('proxied');
    expect(await (await fetch(`http://127.0.0.1:${proxied}/`)).text()).toBe('proxied');
    expect(proxy.tunnels).toEqual([`127.0.0.1:${proxied}`]);
  });

  it('drops expired proxy answers, so origins contacted once do not stay cached', async () => {
    const { getGlobalDispatcher } = await import('undici');
    const first = await target('first');
    const second = await target('second');
    disposable = installProxyDispatcher(chromium(() => 'DIRECT'), log);
    const routes = (getGlobalDispatcher() as unknown as { routes: Map<string, unknown> }).routes;
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      await (await fetch(`http://127.0.0.1:${first}/`)).text();
      expect([...routes.keys()]).toEqual([`http://127.0.0.1:${first}`]);

      now.mockReturnValue(1_000_000 + 61_000);
      await (await fetch(`http://127.0.0.1:${second}/`)).text();
      expect([...routes.keys()]).toEqual([`http://127.0.0.1:${second}`]);
    } finally {
      now.mockRestore();
    }
  });

  it('restores the previous global dispatcher on dispose', async () => {
    const { getGlobalDispatcher } = await import('undici');
    const before = getGlobalDispatcher();
    const installed = installProxyDispatcher(chromium(() => 'DIRECT'), log);
    expect(getGlobalDispatcher()).not.toBe(before);
    installed.dispose();
    expect(getGlobalDispatcher()).toBe(before);
    expect(powerMonitor.listenerCount('resume')).toBe(0);
  });
});
