import * as http from 'node:http';
import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ protocol: {} }));

import type { ReadRangeResult, ReadResult } from '../../../workspace/transfer-ops';
import { NotConnectedError } from '../../workspace/workspaces';
import { answerPreview } from '../../../../core/served-pages/preview-reader';
import { OPEN_TOKEN_TTL_MS, PreviewHttpServer, type PreviewGrant } from '../../../../core/served-pages/preview-http-server';
import { syntheticFile, type SyntheticFile } from './synthetic-file';

// the project root: its files, and those a read refuses
const FILES: Record<string, string> = {
  'index.html': '<link href="/css/abs.css"><p>root</p>',
  'css/abs.css': 'p{}',
  'docs/index.html': '<p>docs</p>',
  'clip.txt': '0123456789',
  '.env': 'SECRET=1',
  'certs/server.key': 'KEY',
};

// 10-byte files whose reads yield this many bytes instead, as a file cut after its stat or a faulty host's would
const MISREAD: Record<string, number> = { 'short.txt': 4, 'long.txt': 30 };

// big.mp4, never held whole
const BIG = 200 * 1024 * 1024;

interface Harness {
  readonly server: PreviewHttpServer;
  // Open in Browser's grant, on 127.0.0.1
  readonly grant: PreviewGrant;
  now: number;
  offline: boolean;
  readonly big: SyntheticFile;
  readonly logged: string[];
}

function read(h: Harness, relativePath: string): Promise<ReadResult | { readonly ok: false; readonly reason: 'notAFile'; readonly folder: boolean }> {
  if (h.offline) return Promise.reject(new NotConnectedError('build-box is not connected.'));
  if (relativePath === 'docs') return Promise.resolve({ ok: false, reason: 'notAFile', folder: true });
  const yielded = MISREAD[relativePath];
  if (yielded !== undefined) return Promise.resolve({ ok: true, size: 10, chunks: (async function* () { yield Buffer.alloc(yielded, 'a'); })() });
  const text = FILES[relativePath];
  if (text === undefined) return Promise.resolve({ ok: false, reason: 'missing' });
  const bytes = Buffer.from(text);
  return Promise.resolve({ ok: true, size: bytes.length, chunks: (async function* () { yield bytes; })() });
}

// the project's files clamped as the workspace's ranged read clamps them
async function readRange(h: Harness, relativePath: string, offset: number, length: number): Promise<ReadRangeResult> {
  if (!h.offline && relativePath === 'big.mp4') return (await h.big.reads.range(relativePath, offset, length))!;
  const whole = await read(h, relativePath);
  if (!whole.ok) return whole.reason === 'notAFile' ? { ok: false, reason: 'notAFile', folder: 'folder' in whole && whole.folder } : { ok: false, reason: whole.reason };
  const start = offset < 0 ? Math.max(0, whole.size + offset) : Math.min(offset, whole.size);
  const count = Math.min(length, whole.size - start);
  const text = FILES[relativePath];
  if (text === undefined) return { ok: true, size: whole.size, offset: start, length: count, resolvedPath: relativePath, chunks: whole.chunks };
  await whole.chunks[Symbol.asyncIterator]().return?.();
  const bytes = Buffer.from(text).subarray(start, start + count);
  return { ok: true, size: whole.size, offset: start, length: count, resolvedPath: relativePath, chunks: (async function* () { yield bytes; })() };
}

let h: Harness;

beforeEach(async () => {
  const harness = { now: 1_000_000, offline: false, big: syntheticFile(BIG), logged: [] as string[] } as Partial<Harness> as Harness;
  const server = await PreviewHttpServer.start({
    serve: (request) => answerPreview({ ...request, trusted: true, target: 'browser' }, { range: (relativePath, offset, length) => readRange(harness, relativePath, offset, length) }, (line) => harness.logged.push(line)),
    trusted: () => true,
    refusalText: () => 'Open this preview from Damocles.',
    log: (line) => harness.logged.push(line),
    now: () => harness.now,
  });
  Object.assign(harness, { server, grant: server.grant('preview', 'loopback') });
  h = harness;
});

afterEach(async () => {
  await h.server.close();
});

interface Answer {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

// raw path, own headers: no client normalizes the path or adds a Host
function request(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.server.port, path, method, headers: { Host: `127.0.0.1:${h.server.port}`, ...headers }, setHost: false, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

interface Exchange {
  readonly status: number;
  readonly body: string;
  // the whole Content-Length arrived before the connection closed
  readonly complete: boolean;
  readonly socket: unknown;
}

// a GET on agent's keep-alive connection that resolves once the response closes, whole or cut
function exchange(agent: http.Agent, path: string, headers: Record<string, string>): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.server.port, path, headers: { Host: `127.0.0.1:${h.server.port}`, ...headers }, setHost: false, agent }, (res) => {
      const socket = res.socket;
      let body = '';
      res.setEncoding('latin1');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('error', () => undefined);
      res.on('close', () => resolve({ status: res.statusCode!, body, complete: res.complete, socket }));
    });
    req.on('error', reject);
    req.end();
  });
}

// The most of big.mp4 read but not yet received: the server's one chunk read ahead and its response's buffer, plus both ends'
// socket buffers, which the OS sizes; far below the file, which an unpaced read would produce whole.
const MAX_UNSENT_BYTES = 16 * 1024 * 1024;

// a GET of big.mp4 whose body the test reads at its own pace
function bigRequest(jar: string, range?: string): Promise<{ readonly req: http.ClientRequest; readonly res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.server.port, path: '/big.mp4', headers: { Host: `127.0.0.1:${h.server.port}`, Cookie: jar, ...(range ? { Range: range } : {}) }, setHost: false, agent: false }, (res) => resolve({ req, res }));
    req.on('error', reject);
    req.end();
  });
}

// the value once two samples 100 ms apart agree
async function steady(sample: () => number): Promise<number> {
  let last = sample();
  for (let tries = 0; tries < 50; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const next = sample();
    if (next === last) return next;
    last = next;
  }
  throw new Error('the value never settled');
}

function openPath(relativePath = 'index.html'): string {
  const url = new URL(h.grant.openUrl(relativePath));
  expect(url.origin).toBe(`http://127.0.0.1:${h.server.port}`);
  return `${url.pathname}${url.search}`;
}

async function cookie(): Promise<string> {
  const exchanged = await request(openPath());
  return exchanged.headers['set-cookie']![0]!.split(';')[0]!;
}

const noCors = (answer: Answer): boolean => Object.keys(answer.headers).every((name) => !name.startsWith('access-control-'));

describe('the preview loopback server', () => {
  it('logs an error its listening socket raises (an accept failing with EMFILE) instead of throwing in main', () => {
    const listening = (h.server as unknown as { readonly server: http.Server }).server;
    expect(() => listening.emit('error', Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' }))).not.toThrow();
    expect(h.logged).toEqual(["[html-preview] a preview's browser port failed: accept EMFILE"]);
  });

  it('swaps a one-time token for a per-port HttpOnly SameSite=Strict cookie and redirects to the page', async () => {
    const path = openPath();
    expect(path).toMatch(/^\/__damocles_preview\/open\?t=[A-Za-z0-9_-]{43}&p=index.html$/);
    const exchanged = await request(path);
    expect(exchanged.status).toBe(303);
    expect(exchanged.headers.location).toBe('/index.html');
    expect(exchanged.headers['set-cookie']).toEqual([expect.stringMatching(new RegExp(`^damocles_preview_${h.server.port}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=/$`))]);
    expect(noCors(exchanged)).toBe(true);
    // spent on its first use
    expect((await request(path)).status).toBe(403);
    expect(h.logged.join('\n')).not.toContain(new URLSearchParams(path.split('?')[1]).get('t')!);
  });

  it('serves the root with the cookie: root-absolute paths, a folder\'s index.html, and no CORS header', async () => {
    const jar = await cookie();
    const page = await request('/index.html', { Cookie: jar });
    expect(page.status).toBe(200);
    expect(page.body).toBe(FILES['index.html']);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toContain('sandbox allow-scripts allow-same-origin allow-forms allow-modals allow-popups');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(page.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(noCors(page)).toBe(true);
    expect((await request('/css/abs.css', { Cookie: `other=1; ${jar}` })).body).toBe('p{}');
    expect((await request('/', { Cookie: jar })).body).toBe(FILES['index.html']);
    expect((await request('/docs/', { Cookie: jar })).body).toBe('<p>docs</p>');
    const folder = await request('/docs', { Cookie: jar });
    expect(folder.status).toBe(308);
    expect(folder.headers.location).toBe('/docs/');
    const head = await request('/index.html', { Cookie: jar }, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it('answers 404 with no bytes for denied paths and traversal, 503 offline', async () => {
    const jar = await cookie();
    for (const path of ['/.env', '/.git/config', '/certs/server.key', '/%2e%2e/secret', '/..%2fsecret', '/../secret', '/GIT~1/config', '/missing.html', '/__damocles_preview/other']) {
      const answer = await request(path, { Cookie: jar });
      expect(answer.status, path).toBe(404);
      expect(answer.body, path).toBe('');
    }
    h.offline = true;
    const offline = await request('/index.html', { Cookie: jar });
    expect(offline.status).toBe(503);
    expect(offline.body).toBe('build-box is not connected.');
  });

  it('serves one byte range as 206, a range past the end as 416, and several ranges or an If-Range as the whole file', async () => {
    const jar = await cookie();
    const whole = await request('/clip.txt', { Cookie: jar });
    expect(whole.status).toBe(200);
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.headers['content-length']).toBe('10');
    const part = await request('/clip.txt', { Cookie: jar, Range: 'bytes=2-4' });
    expect(part.status).toBe(206);
    expect(part.body).toBe('234');
    expect(part.headers['content-range']).toBe('bytes 2-4/10');
    expect(part.headers['content-length']).toBe('3');
    expect(part.headers['accept-ranges']).toBe('bytes');
    expect(part.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(part.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(part.headers['x-content-type-options']).toBe('nosniff');
    expect(part.headers['referrer-policy']).toBe('no-referrer');
    expect(part.headers['cache-control']).toBe('no-store');
    expect(part.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(part.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(noCors(part)).toBe(true);
    expect((await request('/clip.txt', { Cookie: jar, Range: 'bytes=7-' })).body).toBe('789');
    expect((await request('/clip.txt', { Cookie: jar, Range: 'bytes=-2' })).body).toBe('89');
    const past = await request('/clip.txt', { Cookie: jar, Range: 'bytes=10-' });
    expect(past.status).toBe(416);
    expect(past.headers['content-range']).toBe('bytes */10');
    expect(past.body).toBe('');
    expect(past.headers['content-security-policy']).toContain('sandbox');
    for (const headers of [{ Range: 'bytes=0-1,4-5' }, { Range: 'bytes=4-1' }, { Range: 'bytes=0-1', 'If-Range': '"v1"' }]) {
      const answer = await request('/clip.txt', { Cookie: jar, ...headers });
      expect(answer.status, JSON.stringify(headers)).toBe(200);
      expect(answer.body).toBe('0123456789');
    }
    const head = await request('/clip.txt', { Cookie: jar, Range: 'bytes=2-4' }, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe('10');
    expect(head.body).toBe('');
  });

  it('cuts a read that yields more at its Content-Length, so the next response on the connection stays in step', async () => {
    const jar = await cookie();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const long = await exchange(agent, '/long.txt', { Cookie: jar });
      expect(long).toMatchObject({ status: 200, body: 'a'.repeat(10), complete: true });
      const part = await exchange(agent, '/long.txt', { Cookie: jar, Range: 'bytes=2-4' });
      expect(part).toMatchObject({ status: 206, body: 'aaa', complete: true });
      const next = await exchange(agent, '/clip.txt', { Cookie: jar });
      expect(next).toMatchObject({ status: 200, body: '0123456789', complete: true });
      expect(next.socket).toBe(long.socket);
    } finally {
      agent.destroy();
    }
  });

  it('aborts a response whose read ends short of its Content-Length instead of completing it', async () => {
    const jar = await cookie();
    for (const range of [undefined, 'bytes=0-7']) {
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      try {
        const short = await exchange(agent, '/short.txt', { Cookie: jar, ...(range ? { Range: range } : {}) });
        expect(short.status, range).toBe(range ? 206 : 200);
        expect(short.complete, range).toBe(false);
        expect(short.body.length, range).toBeLessThan(range ? 8 : 10);
      } finally {
        agent.destroy();
      }
    }
  });

  it.each([
    [undefined, 200, BIG, undefined],
    ['bytes=0-', 206, BIG, `bytes 0-${BIG - 1}/${BIG}`],
    ['bytes=1000-', 206, BIG - 1000, `bytes 1000-${BIG - 1}/${BIG}`],
    [`bytes=-${BIG - 5}`, 206, BIG - 5, `bytes 5-${BIG - 1}/${BIG}`],
  ])('streams all of a 200 MiB file for Range %s, read no faster than the browser takes it', async (range, status, length, contentRange) => {
    const { res } = await bigRequest(await cookie(), range);
    expect(res.statusCode).toBe(status);
    expect(res.headers['content-length']).toBe(String(length));
    expect(res.headers['content-range']).toBe(contentRange);
    let received = 0;
    let ahead = 0;
    await new Promise<void>((resolve, reject) => {
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        ahead = Math.max(ahead, h.big.stats.producedBytes - received);
      });
      res.on('end', resolve);
      res.on('error', reject);
    });
    expect(received).toBe(length);
    expect(res.complete).toBe(true);
    expect(h.big.stats.producedBytes).toBe(length);
    expect(ahead).toBeLessThan(MAX_UNSENT_BYTES);
    await expect.poll(() => h.big.stats.returned).toBe(1);
  });

  it('stops reading while the browser reads nothing, and releases the read when its connection goes mid-file', async () => {
    const { req, res } = await bigRequest(await cookie());
    res.pause();
    res.on('error', () => undefined);
    const stalled = await steady(() => h.big.stats.producedBytes);
    expect(stalled).toBeGreaterThan(0);
    expect(stalled).toBeLessThan(MAX_UNSENT_BYTES);
    expect(h.big.stats.returned).toBe(0);
    req.destroy();
    await expect.poll(() => h.big.stats.returned).toBe(1);
    const produced = h.big.stats.produced;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.big.stats.produced).toBe(produced);
  });

  it('refuses a ranged request as any other: 404 for a denied path, 403 without the cookie, 421 for another Host', async () => {
    const jar = await cookie();
    for (const path of ['/.env', '/certs/server.key', '/%2e%2e/secret', '/GIT~1/config']) {
      const answer = await request(path, { Cookie: jar, Range: 'bytes=0-' });
      expect(answer.status, path).toBe(404);
      expect(answer.body, path).toBe('');
      expect(answer.headers['content-range'], path).toBeUndefined();
    }
    expect((await request('/clip.txt', { Range: 'bytes=0-1' })).status).toBe(403);
    expect((await request('/clip.txt', { Cookie: jar, Range: 'bytes=0-1', Host: 'attacker.example' })).status).toBe(421);
    expect((await request('/clip.txt', { Cookie: jar, Range: 'bytes=0-1', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'video' })).status).toBe(403);
  });

  it('refuses in order: Host (421), then method (405), then Fetch Metadata (403), then the cookie (403)', async () => {
    const jar = await cookie();
    for (const host of ['attacker.example', `attacker.example:${h.server.port}`, '127.0.0.1', `127.0.0.1:${h.server.port + 1}`, `[::1]:${h.server.port}`]) {
      expect((await request('/index.html', { Cookie: jar, Host: host })).status, host).toBe(421);
    }
    expect((await request('/index.html', { Cookie: jar, Host: `LOCALHOST:${h.server.port}` })).status).toBe(200);
    expect((await request('/index.html', { Host: 'attacker.example' }, 'POST')).status).toBe(421);
    const post = await request('/index.html', { Cookie: jar, 'Sec-Fetch-Site': 'cross-site' }, 'POST');
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
    expect((await request('/index.html', { Cookie: jar }, 'OPTIONS')).status).toBe(405);
    const refused = await request('/index.html');
    expect(refused.status).toBe(403);
    expect(refused.body).toBe('Open this preview from Damocles.');
    expect(refused.headers['content-security-policy']).toContain('sandbox');
    expect((await request('/index.html', { Cookie: `damocles_preview_${h.server.port}=wrong` })).status).toBe(403);
    // another port's cookie name, and a name this one's port prefixes, carry nothing here
    const secret = jar.split('=')[1]!;
    expect((await request('/index.html', { Cookie: `damocles_preview_${h.server.port}1=${secret}` })).status).toBe(403);
    expect((await request('/index.html', { Cookie: `x_damocles_preview_${h.server.port}=${secret}` })).status).toBe(403);
  });

  it.each([
    [{ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' }, 403],
    [{ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }, 403],
    [{ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' }, 403],
    // a page on another port or site could have planted the cookie, since cookies ignore ports
    [{ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }, 403],
    [{ 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }, 403],
    [{ 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }, 403],
    [{ 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' }, 200],
    [{ 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }, 200],
    [{}, 200],
  ])('Fetch Metadata %o with the cookie answers %i', async (headers, status) => {
    const jar = await cookie();
    expect((await request('/index.html', { Cookie: jar, ...headers })).status).toBe(status);
  });

  it('tells a user who followed a link from another site why, and refuses a subresource with no body', async () => {
    const jar = await cookie();
    for (const site of ['cross-site', 'same-site']) {
      const navigation = await request('/index.html', { Cookie: jar, 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
      expect(navigation.status, site).toBe(403);
      expect(navigation.body, site).toBe('Open this preview from Damocles.');
      expect(navigation.headers['content-type'], site).toBe('text/plain; charset=utf-8');
    }
    for (const headers of [{ 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' }, { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' }, { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }]) {
      const subresource = await request('/index.html', { Cookie: jar, 'Sec-Fetch-Site': 'cross-site', ...headers });
      expect(subresource.status).toBe(403);
      expect(subresource.body).toBe('');
    }
  });

  it('carries the query the opener added into the redirect, and refuses one no URL serializer writes', async () => {
    const withQuery = (query: string): string => `${openPath('docs/index.html')}&${new URLSearchParams({ q: query }).toString()}`;
    expect((await request(withQuery('tab=2&x=%20y'))).headers.location).toBe('/docs/index.html?tab=2&x=%20y');
    expect((await request(openPath('docs/index.html'))).headers.location).toBe('/docs/index.html');
    for (const query of ['a b', 'a#b', 'a\r\nSet-Cookie: x=1', 'é']) expect((await request(withQuery(query))).status, query).toBe(403);
  });

  it('falls to the cookie check when a browser sends no Fetch Metadata, and refuses a cross-site subresource before spending a token', async () => {
    expect((await request('/index.html')).status).toBe(403);
    const path = openPath();
    expect((await request(path, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' })).status).toBe(403);
    expect((await request(path)).status).toBe(303);
  });

  it('expires a token after 60 s, refuses one for another path or a HEAD, and spends one used with a wrong path', async () => {
    const late = openPath();
    h.now += OPEN_TOKEN_TTL_MS;
    expect((await request(late)).status).toBe(403);
    const inTime = openPath();
    h.now += OPEN_TOKEN_TTL_MS - 1;
    expect((await request(inTime)).status).toBe(303);
    const head = openPath();
    expect((await request(head, {}, 'HEAD')).status).toBe(403);
    expect((await request(head)).status).toBe(303);
    const swapped = openPath('docs/index.html').replace('p=docs%2Findex.html', 'p=index.html');
    expect((await request(swapped)).status).toBe(403);
    expect((await request(swapped.replace('p=index.html', 'p=docs%2Findex.html'))).status).toBe(403);
    expect((await request('/__damocles_preview/open?t=&p=index.html')).status).toBe(403);
  });

  it('never redirects to another origin, whatever the path holds', async () => {
    const answer = await request(openPath('evil.com/x y.html'));
    expect(answer.headers.location).toBe('/evil.com/x%20y.html');
  });

  it("refuses a cookie of an earlier server on the same root, and closes its port and every connection", async () => {
    const jar = await cookie();
    const port = h.server.port;
    await h.server.close();
    await expect(new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/', agent: false }, resolve).on('error', reject))).rejects.toThrow(/ECONNREFUSED/);
    const next = await PreviewHttpServer.start({ serve: async () => ({ status: 200, headers: {} }), trusted: () => true, refusalText: () => 'Open this preview from Damocles.', log: () => undefined });
    next.grant('preview', 'loopback');
    const stale = jar.replace(`damocles_preview_${port}=`, `damocles_preview_${next.port}=`);
    const answer = await new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: next.port, path: '/index.html', headers: { Cookie: stale }, agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      }).on('error', reject);
    });
    await next.close();
    expect(answer).toBe(403);
    // the afterEach closes it again
    h = { ...h, server: { close: async () => undefined } as unknown as PreviewHttpServer };
  });
});

describe('grants of one served root', () => {
  // the token exchange on a grant's own host: the cookie it sets
  async function grantCookie(grant: PreviewGrant): Promise<string> {
    const open = new URL(grant.openUrl('index.html'));
    const exchanged = await request(`${open.pathname}${open.search}`, { Host: open.host });
    expect(exchanged.status).toBe(303);
    expect(exchanged.headers['set-cookie']![0]).not.toMatch(/domain=/i);
    return exchanged.headers['set-cookie']![0]!.split(';')[0]!;
  }

  it('answers each holder only on its own host, with its own token and cookie', async () => {
    const a = h.server.grant('view:a', 'own');
    const b = h.server.grant('view:b', 'own');
    for (const grant of [a, b]) expect(new URL(grant.origin).hostname).toMatch(/^[0-9a-f]{32}\.localhost$/);
    expect(new URL(a.origin).port).toBe(String(h.server.port));
    expect(b.origin).not.toBe(a.origin);
    expect(h.server.grant('view:a', 'own').origin).toBe(a.origin);
    const aHost = new URL(a.origin).host;
    const bHost = new URL(b.origin).host;
    // a token opens only on the host it was minted for
    const minted = new URL(a.openUrl('index.html'));
    for (const host of [bHost, `127.0.0.1:${h.server.port}`]) expect((await request(`${minted.pathname}${minted.search}`, { Host: host })).status, host).toBe(403);
    expect((await request(`${minted.pathname}${minted.search}`, { Host: aHost })).status).toBe(303);
    const aCookie = await grantCookie(a);
    const bCookie = await grantCookie(b);
    const preview = await cookie();
    expect((await request('/index.html', { Host: aHost, Cookie: aCookie })).status).toBe(200);
    expect((await request('/index.html', { Host: aHost.toUpperCase(), Cookie: aCookie })).status).toBe(200);
    for (const jar of [bCookie, preview]) expect((await request('/index.html', { Host: aHost, Cookie: jar })).status).toBe(403);
    for (const jar of [aCookie, bCookie]) expect((await request('/index.html', { Cookie: jar })).status).toBe(403);
    // the same label on another port, with a trailing dot, or under another name answers nothing
    const label = aHost.split('.')[0]!;
    for (const host of [`${label}.localhost:${h.server.port + 1}`, `${label}.localhost.:${h.server.port}`, `${label}.example:${h.server.port}`, `${label}.localhost`]) {
      expect((await request('/index.html', { Host: host, Cookie: aCookie })).status, host).toBe(421);
    }
    expect(() => h.server.grant('preview:other', 'loopback')).toThrow('one loopback grant');
  });

  it('refuses a revoked holder\'s host at once, on a connection it already holds too, and mints no token for it', async () => {
    const a = h.server.grant('view:a', 'own');
    const b = h.server.grant('view:b', 'own');
    const aCookie = await grantCookie(a);
    const bCookie = await grantCookie(b);
    const host = new URL(a.origin).host;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const before = await exchange(agent, '/index.html', { Host: host, Cookie: aCookie });
    expect(before.status).toBe(200);
    h.server.revoke('view:a');
    const after = await exchange(agent, '/index.html', { Host: host, Cookie: aCookie });
    agent.destroy();
    expect(after.socket).toBe(before.socket);
    expect(after.status).toBe(421);
    expect(() => a.openUrl('index.html')).toThrow('revoked');
    expect((await request('/index.html', { Host: new URL(b.origin).host, Cookie: bCookie })).status).toBe(200);
    // a holder granted again gets a new host
    expect(h.server.grant('view:a', 'own').origin).not.toBe(a.origin);
  });

  it.runIf(Object.values(os.networkInterfaces()).flat().some((info) => info?.address === '::1'))('holds its port on ::1 too, where Chrome connects a *.localhost name first', async () => {
    const grant = h.server.grant('view:a', 'own');
    const jar = await grantCookie(grant);
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ host: '::1', port: h.server.port, path: '/index.html', headers: { Host: new URL(grant.origin).host, Cookie: jar }, agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      }).on('error', reject);
    });
    expect(status).toBe(200);
  });
});
