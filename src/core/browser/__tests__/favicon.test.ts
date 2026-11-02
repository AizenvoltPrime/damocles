// @vitest-environment happy-dom
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as playwrightRequest, type APIRequestContext } from 'patchright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserService } from '../index';
import { connectPinned, fetchIconPinned, fetchIconThroughContext, type IconConnector } from '../favicon';
import { startClientNetworkProxy, type ClientNetworkProxy } from '../client-network-proxy';
import type { AddressResolver } from '../client-network-policy';
import { installFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';

// These suites never launch Chromium: the context is set directly, as in panel-wiring.test.ts.
vi.mock('../launcher', () => ({ launchBrowserContext: vi.fn() }));

// A stand-in for an address on the public internet; the recording connector reaches the test server for it.
const PUBLIC = '203.0.113.10';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let server: Server;
let serverPort: number;
let served: string[];
// the Cookie header of each request the test server got, '' for none
let cookies: string[];
let proxy: ClientNetworkProxy | undefined;
let cacheDir: string;

beforeEach(async () => {
  served = [];
  cookies = [];
  server = createServer((req, res) => {
    served.push(req.url ?? '');
    cookies.push(req.headers.cookie ?? '');
    res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverPort = (server.address() as AddressInfo).port;
  cacheDir = mkdtempSync(join(tmpdir(), 'dam-favicon-'));
});

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('the local context\'s favicon fetch', () => {
  it('connects to the address it checked, even when a second lookup would answer loopback', async () => {
    let lookups = 0;
    const rebinding: AddressResolver = async () => [{ address: lookups++ === 0 ? PUBLIC : '127.0.0.1', family: 4 }];
    const connects: string[][] = [];
    const connector: IconConnector = (_url, addresses) => {
      connects.push(addresses.map((answer) => answer.address));
      return netConnect({ host: '127.0.0.1', port: serverPort });
    };
    const icon = await fetchIconPinned(rebinding, connector)(new URL(`http://rebind.test:${serverPort}/favicon.ico`));
    expect(icon?.bytes).toEqual(PNG);
    expect(lookups).toBe(1);
    expect(connects).toEqual([[PUBLIC]]);
  });

  // a GET over the socket the connector opened, answered by the test server whatever the name
  const viaConnector = (socket: Socket, host: string): Promise<string> => new Promise((resolve, reject) => {
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (text += chunk));
    socket.on('close', () => resolve(text.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
    socket.write(`GET /favicon.ico HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  });

  it('connects a name only to the checked addresses it is given, never resolving it again', async () => {
    // .invalid never resolves, so an answer proves the connection went to the given address
    const url = new URL(`http://pinned.invalid:${serverPort}/favicon.ico`);
    expect(await viaConnector(connectPinned(url, [{ address: '127.0.0.1', family: 4 }]), url.host)).toBe('HTTP/1.1 200 OK');
    // nothing listens on [::1] at the test server's port, so the next checked address is tried
    expect(await viaConnector(connectPinned(url, [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }]), url.host)).toBe('HTTP/1.1 200 OK');
    expect(served).toEqual(['/favicon.ico', '/favicon.ico']);
  });

  it('refuses the hex IPv4-mapped literals of loopback, a private address and the metadata address without connecting', async () => {
    const connector = vi.fn<IconConnector>(() => netConnect({ host: '127.0.0.1', port: serverPort }));
    for (const host of ['[::ffff:127.0.0.1]', '[::ffff:192.168.1.1]', '[::ffff:169.254.169.254]']) {
      expect(await fetchIconPinned(undefined, connector)(new URL(`http://${host}:${serverPort}/favicon.ico`)), host).toBeNull();
    }
    expect(connector).not.toHaveBeenCalled();
    expect(served).toEqual([]);
  });
});

describe('a remote context\'s favicon fetch', () => {
  let platform: FakePlatform;
  beforeEach(() => {
    platform = installFakePlatform({ chatBrowserPane: true, settings: { user: { 'damocles.browser.enabled': true } } });
  });

  // a page that lists `icons` and commits `url` once the scope opened it
  function fakePage(icons: readonly string[]) {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    let frameUrl = 'about:blank';
    const frame = { url: () => frameUrl };
    return {
      on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
      url: () => frameUrl,
      close: vi.fn(async () => {}),
      opener: async () => null,
      mainFrame: () => frame,
      evaluate: async () => JSON.stringify(icons),
      commit: (url: string) => {
        frameUrl = url;
        for (const handler of handlers.get('framenavigated') ?? []) handler(frame);
      },
    };
  }

  it('asks the context\'s own request API, so Node sends no request for http://[::ffff:7f00:1]/', async () => {
    const icon = `http://[::ffff:7f00:1]:${serverPort}/favicon.ico`;
    const page = fakePage([icon]);
    let asked!: (url: string) => void;
    const askedFor = new Promise<string>((resolve) => (asked = resolve));
    const get = vi.fn(async (url: string) => {
      asked(url);
      return { ok: () => false, body: async () => Buffer.alloc(0), headers: () => ({}), dispose: async () => {} };
    });
    const svc = new BrowserService(platform, { profileDir: cacheDir, network: async () => ({ server: 'http://127.0.0.1:1', args: [] }) });
    const priv = svc as unknown as { context: unknown; state: string; iconCacheDir: string };
    priv.context = {
      newCDPSession: async () => ({ on: () => {}, send: vi.fn(async (method: string) => (method === 'Page.navigate' ? { frameId: 'f', loaderId: 'l' } : { currentIndex: 0, entries: [{}] })), detach: vi.fn(async () => {}) }),
      newPage: async () => page,
      close: async () => {},
      request: { get },
    };
    priv.state = 'connected';
    priv.iconCacheDir = cacheDir;
    const chat = platform.window.createPanel({ kind: 'chat', title: 'chat', localResourceRoots: [] });
    await svc.chatScope(chat).open('http://example.test/');
    page.commit('http://example.test/');
    expect(await askedFor).toBe(icon);
    expect(get).toHaveBeenCalledWith(icon, expect.objectContaining({ maxRedirects: 0 }));
    expect(served).toEqual([]);
  });
});

describe('a remote context\'s favicon fetch through its client-network proxy', () => {
  let requests: APIRequestContext;
  afterEach(async () => {
    await requests.dispose();
  });

  it('gets a forwarded dev server\'s /favicon.ico through the proxy without the profile\'s cookies, and nothing from a port the host did not forward', async () => {
    proxy = await startClientNetworkProxy({ allowedPorts: [serverPort], allowLocalNetwork: false });
    // the profile holds a Strict cookie for the dev server, which a favicon request the page chose must not carry
    const storageState = { cookies: [{ name: 'session', value: 'secret', domain: 'localhost', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Strict' as const }], origins: [] };
    requests = await playwrightRequest.newContext({ proxy: { server: proxy.url }, storageState });
    const fetchIcon = fetchIconThroughContext(() => requests);
    const icon = await fetchIcon(new URL(`http://localhost:${serverPort}/favicon.ico`));
    expect(icon).toEqual({ bytes: PNG, contentType: 'image/png' });
    expect(served).toEqual(['/favicon.ico']);
    expect(cookies).toEqual(['']);
    proxy.update({ allowedPorts: [], allowLocalNetwork: false });
    expect(await fetchIcon(new URL(`http://localhost:${serverPort}/favicon.ico`))).toBeNull();
    expect(served).toEqual(['/favicon.ico']);
  });
});
