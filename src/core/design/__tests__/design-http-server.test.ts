import * as http from 'node:http';
import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installLogSink } from '../../logger';
import { DesignHttpServer, type DesignServeRead, type DesignServeTarget } from '../design-http-server';
import { servedCsp } from '../serve-policy';

const CONTACTS: DesignServeTarget = { authority: 'local', designId: 'contacts-1a2b3c4d' };
const BILLING: DesignServeTarget = { authority: 'local', designId: 'billing-9f8e7d6c' };

interface Reply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** Writes `head` on a raw socket, so the request line and headers are exactly as written; resolves the status code. */
function rawRequest(port: number, head: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(head));
    let reply = '';
    socket.on('data', (chunk: Buffer) => { reply += chunk.toString('latin1'); });
    socket.on('end', () => resolve(Number(/^HTTP\/1\.[01] (\d{3})/.exec(reply)?.[1] ?? 0)));
    socket.on('error', reject);
  });
}

/** Sends `rawPath` exactly as written, with `host` as the Host header. */
function request(port: number, rawPath: string, options: { method?: string; host?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: options.method ?? 'GET', headers: { Host: options.host ?? `127.0.0.1:${port}` }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
};

let files: Map<string, DesignServeRead>;
let reads: { target: DesignServeTarget; relPath: string }[];
// A read of `slow.html` waits for this.
let slowRead: Promise<void>;
let logged: string[];
let server: DesignHttpServer;

/** The port and token of `url`, a URL the server minted. */
function parts(url: string): { port: number; token: string } {
  const parsed = new URL(url);
  return { port: Number(parsed.port), token: parsed.pathname.split('/')[2]! };
}

beforeEach(() => {
  files = new Map<string, DesignServeRead>([
    ['screens/S1-contacts.html', { kind: 'file', bytes: Buffer.from('<h1>Contacts</h1>'), fidelity: 'static' }],
    ['screens/S2 list.html', { kind: 'file', bytes: Buffer.from('<h1>List</h1>'), fidelity: 'interactive' }],
    ['%2e%2e/x.html', { kind: 'file', bytes: Buffer.from('literal'), fidelity: null }],
    ['tokens.css', { kind: 'file', bytes: Buffer.from(':root{}'), fidelity: null }],
    ['assets/link.png', { kind: 'outside' }],
    ['big.png', { kind: 'tooLarge' }],
  ]);
  reads = [];
  slowRead = Promise.resolve();
  logged = [];
  installLogSink({ appendLine: (line) => logged.push(line), show: () => undefined, dispose: () => undefined });
  server = new DesignHttpServer(async (target, relPath) => {
    reads.push({ target, relPath });
    if (relPath === 'boom.html') throw new Error('disk on fire');
    if (relPath === 'slow.html') await slowRead;
    return files.get(relPath) ?? { kind: 'missing' };
  });
});
afterEach(async () => {
  await server.dispose();
});

describe('the design server', () => {
  it('binds 127.0.0.1 on the first open, with one 32-byte token per (authority, designId)', async () => {
    expect(server.boundPort()).toBeUndefined();
    const url = await server.urlOf(CONTACTS, 'screens/S1-contacts.html');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/d\/[A-Za-z0-9_-]{43}\/screens\/S1-contacts\.html$/);
    expect(Buffer.from(parts(url).token, 'base64url')).toHaveLength(32);
    expect(server.boundPort()).toBe(parts(url).port);
    expect(parts(await server.urlOf(CONTACTS, 'tokens.css')).token).toBe(parts(url).token);
    expect(parts(await server.urlOf(BILLING, 'tokens.css')).token).not.toBe(parts(url).token);
    expect(parts(await server.urlOf({ authority: 'ssh-host', designId: CONTACTS.designId }, 'tokens.css')).token).not.toBe(parts(url).token);
    expect(await server.urlOf(CONTACTS, 'screens/S2 list.html')).toMatch(/\/screens\/S2%20list\.html$/);
  });

  it('serves a file with its type, its fidelity\'s CSP and the security headers', async () => {
    const { port, token } = parts(await server.urlOf(CONTACTS, 'screens/S1-contacts.html'));
    const html = await request(port, `/d/${token}/screens/S1-contacts.html`);
    expect(html).toMatchObject({ status: 200, body: '<h1>Contacts</h1>' });
    expect(html.headers).toMatchObject({ ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-length': '17', 'content-security-policy': servedCsp('static') });
    const interactive = await request(port, `/d/${token}/screens/S2%20list.html?x=1`);
    expect(interactive).toMatchObject({ status: 200, body: '<h1>List</h1>' });
    expect(interactive.headers['content-security-policy']).toBe(servedCsp('interactive'));
    const css = await request(port, `/d/${token}/tokens.css`);
    expect(css.headers).toMatchObject({ 'content-type': 'text/css; charset=utf-8', 'content-security-policy': servedCsp(null) });
    expect(reads.map((read) => read.target)).toEqual([CONTACTS, CONTACTS, CONTACTS]);
  });

  it('refuses every method but GET with 405 and Allow: GET, HEAD included, with the headers', async () => {
    const { port, token } = parts(await server.urlOf(CONTACTS, 'screens/S1-contacts.html'));
    for (const method of ['POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
      const reply = await request(port, `/d/${token}/screens/S1-contacts.html`, { method });
      expect(reply.status, method).toBe(405);
      expect(reply.headers).toMatchObject({ ...SECURITY_HEADERS, allow: 'GET', 'content-security-policy': servedCsp(null) });
    }
    expect(reads).toEqual([]);
  });

  it('answers 404 for an unknown token, a part of one, and a token with more after it', async () => {
    const { port, token } = parts(await server.urlOf(CONTACTS, 'screens/S1-contacts.html'));
    for (const rawPath of [`/d/${'A'.repeat(43)}/screens/S1-contacts.html`, `/d/${token.slice(0, -1)}/screens/S1-contacts.html`, `/d/${token}x/screens/S1-contacts.html`, `/d/${token.toLowerCase()}/screens/S1-contacts.html`]) {
      const reply = await request(port, rawPath);
      expect(reply.status, rawPath).toBe(404);
      expect(reply.headers).toMatchObject(SECURITY_HEADERS);
    }
    expect(reads).toEqual([]);
  });

  it('answers 404 for no file path, a directory path, and paths outside /d/<token>/', async () => {
    const { port, token } = parts(await server.urlOf(CONTACTS, 'screens/S1-contacts.html'));
    for (const rawPath of [`/d/${token}/`, `/d/${token}`, `/d/${token}/screens/`, '/', '/d/', `/x/${token}/screens/S1-contacts.html`, `//d/${token}/screens/S1-contacts.html`]) {
      expect((await request(port, rawPath)).status, rawPath).toBe(404);
    }
  });

  it('decodes the path once and answers 404 for invalid encoding, a decoded \\, NUL or dot segment, before any read', async () => {
    const { port, token } = parts(await server.urlOf(CONTACTS, 'screens/S1-contacts.html'));
    for (const rel of ['../x.html', 'screens/../tokens.css', '%2e%2e/x.html', '%2E%2E/x.html', '%2e%2e%2fx.html', 'screens/%2e/S1-contacts.html', 'screens%5cS1-contacts.html', 'S1%00.html', 'S1.html%00', '%zz.html', 'S1%E0%A4%A.html', 'screens//S1-contacts.html', '%2fetc%2fpasswd.txt', 'C:%5cx.txt', 'a.html%3astream.html', 'S1.html.']) {
      expect((await request(port, `/d/${token}/${rel}`)).status, rel).toBe(404);
    }
    expect(reads).toEqual([]);
    const literal = await request(port, `/d/${token}/%252e%252e/x.html`);
    expect(literal).toMatchObject({ status: 200, body: 'literal' });
    expect(reads.map((read) => read.relPath)).toEqual(['%2e%2e/x.html']);
  });

  it('answers 404 for an absolute-form target and 421 for an HTTP/1.0 request with no Host', async () => {
    const { port, token } = parts(await server.urlOf(CONTACTS, 'screens/S1-contacts.html'));
    const crlf = '\r\n';
    expect(await rawRequest(port, [`GET http://127.0.0.1:${port}/d/${token}/screens/S1-contacts.html HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close', '', ''].join(crlf))).toBe(404);
    expect(await rawRequest(port, [`GET /d/${token}/screens/S1-contacts.html HTTP/1.0`, '', ''].join(crlf))).toBe(421);
    expect(reads).toEqual([]);
  });

  it('hands the reader a percent-encoded UTF-8 name decoded once', async () => {
    const { port, token } = parts(await server.urlOf(CONTACTS, 'screens/S1-contacts.html'));
    expect((await request(port, `/d/${token}/assets/%C3%A9.png`)).status).toBe(404);
    expect(reads.map((read) => read.relPath)).toEqual(['assets/é.png']);
  });

  it('answers 404 for a type it does not serve, without reading it', async () => {
    const { port, token } = parts(await server.urlOf(CONTACTS, 'screens/S1-contacts.html'));
    for (const rel of ['design.md', 'screens/S1.journey.spec.ts', 'a.exe', 'noextension']) {
      expect((await request(port, `/d/${token}/${rel}`)).status, rel).toBe(404);
    }
    expect(reads).toEqual([]);
  });

  it('answers 404 for a refused read (a link, a missing or a too large file) and 500 for a failed one', async () => {
    const { port, token } = parts(await server.urlOf(CONTACTS, 'screens/S1-contacts.html'));
    expect((await request(port, `/d/${token}/assets/link.png`)).status).toBe(404);
    expect((await request(port, `/d/${token}/missing.html`)).status).toBe(404);
    expect((await request(port, `/d/${token}/big.png`)).status).toBe(404);
    const failed = await request(port, `/d/${token}/boom.html`);
    expect(failed.status).toBe(500);
    expect(failed.headers).toMatchObject(SECURITY_HEADERS);
    expect(logged.some((line) => line.includes('boom.html of design contacts-1a2b3c4d failed'))).toBe(true);
  });

  it('answers 421 for a Host that is not the loopback authority or one the host added', async () => {
    const { port, token } = parts(await server.urlOf(CONTACTS, 'screens/S1-contacts.html'));
    const path = `/d/${token}/screens/S1-contacts.html`;
    expect((await request(port, path, { host: `localhost:${port}` })).status).toBe(200);
    expect((await request(port, path, { host: `LOCALHOST:${port}` })).status).toBe(200);
    for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', 'localhost', `[::1]:${port}`, 'localhost:54321']) {
      const reply = await request(port, path, { host });
      expect(reply.status, host).toBe(421);
      expect(reply.headers).toMatchObject(SECURITY_HEADERS);
    }
    server.allowHost('localhost:54321');
    server.allowHost('Abc-54321.app.github.dev');
    expect((await request(port, path, { host: 'localhost:54321' })).status).toBe(200);
    expect((await request(port, path, { host: 'abc-54321.app.github.dev' })).status).toBe(200);
    expect(reads).toHaveLength(4);
  });

  it('stops serving a revoked design at once and closes once no token remains, forgetting the hosts it added', async () => {
    const contacts = parts(await server.urlOf(CONTACTS, 'screens/S1-contacts.html'));
    const billing = parts(await server.urlOf(BILLING, 'tokens.css'));
    server.allowHost('localhost:54321');
    server.revoke(CONTACTS);
    expect((await request(contacts.port, `/d/${contacts.token}/screens/S1-contacts.html`)).status).toBe(404);
    expect((await request(billing.port, `/d/${billing.token}/tokens.css`)).status).toBe(200);
    server.revoke(BILLING);
    expect(server.boundPort()).toBeUndefined();
    await expect(request(billing.port, `/d/${billing.token}/tokens.css`)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    const reopened = parts(await server.urlOf(CONTACTS, 'screens/S1-contacts.html'));
    expect(reopened.token).not.toBe(contacts.token);
    expect((await request(reopened.port, `/d/${reopened.token}/screens/S1-contacts.html`, { host: 'localhost:54321' })).status).toBe(421);
  });

  it('refuses a file whose design was revoked while it was read', async () => {
    const { port, token } = parts(await server.urlOf(CONTACTS, 'screens/S1-contacts.html'));
    await server.urlOf(BILLING, 'tokens.css');
    let release!: () => void;
    slowRead = new Promise<void>((resolve) => { release = resolve; });
    files.set('slow.html', { kind: 'file', bytes: Buffer.from('slow'), fidelity: null });
    const pending = request(port, `/d/${token}/slow.html`);
    await expect.poll(() => reads.length).toBe(1);
    server.revoke(CONTACTS);
    release();
    expect((await pending).status).toBe(404);
  });

  it('closes at dispose, and opens nothing after it', async () => {
    const { port, token } = parts(await server.urlOf(CONTACTS, 'screens/S1-contacts.html'));
    await server.dispose();
    expect(server.boundPort()).toBeUndefined();
    await expect(request(port, `/d/${token}/screens/S1-contacts.html`)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await expect(server.urlOf(CONTACTS, 'screens/S1-contacts.html')).rejects.toThrow('disposed');
  });

  it('never logs a token', async () => {
    const contacts = parts(await server.urlOf(CONTACTS, 'screens/S1-contacts.html'));
    const billing = parts(await server.urlOf(BILLING, 'tokens.css'));
    for (const rel of ['screens/S1-contacts.html', 'missing.html', 'assets/link.png', 'design.md', '%zz.html', 'boom.html', '../x.html']) {
      await request(contacts.port, `/d/${contacts.token}/${rel}`);
    }
    await request(contacts.port, `/d/${contacts.token}x/a.html`);
    await request(contacts.port, `/d/${contacts.token}/a.html`, { host: 'evil.example' });
    await request(contacts.port, `/d/${contacts.token}/a.html`, { method: 'POST' });
    server.revoke(CONTACTS);
    server.revoke(BILLING);
    expect(logged.length).toBeGreaterThan(5);
    for (const line of logged) {
      expect(line).not.toContain(contacts.token);
      expect(line).not.toContain(billing.token);
    }
  });
});
