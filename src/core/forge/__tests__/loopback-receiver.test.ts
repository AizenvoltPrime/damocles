import * as http from 'node:http';
import * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLoopbackReceiver, type LoopbackReceiver } from '../oauth/loopback-receiver';

// every server the receiver creates, so a test can see whether it still listens
const created = vi.hoisted((): http.Server[] => []);
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  const createServer = ((...args: Parameters<typeof actual.createServer>) => {
    const server = actual.createServer(...args);
    created.push(server);
    return server;
  }) as typeof actual.createServer;
  return { ...actual, default: { ...actual, createServer }, createServer };
});

const STATE = 'state-0123456789abcdef0123456789abcdef0123';
const open: LoopbackReceiver[] = [];

async function receiver(options: { timeoutMs?: number; signal?: AbortSignal; log?: (line: string) => void } = {}): Promise<LoopbackReceiver> {
  const started = await startLoopbackReceiver({ state: STATE, signal: options.signal ?? new AbortController().signal, log: options.log ?? (() => undefined), ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) });
  open.push(started);
  return started;
}

function send(port: number, options: { method?: string; path: string; host?: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ agent: false, host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: { host: options.host ?? `127.0.0.1:${port}` } }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => (body += chunk.toString()));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

afterEach(() => {
  for (const item of open.splice(0)) item.close();
});

describe('loopback receiver', () => {
  it('binds 127.0.0.1 only and names its redirect URI', async () => {
    const r = await receiver();
    expect(r.redirectUri).toBe(`http://127.0.0.1:${r.port}/callback`);
    await expect(new Promise((resolve, reject) => {
      const socket = net.connect({ host: '::1', port: r.port }, () => resolve('connected'));
      socket.on('error', reject);
    })).rejects.toThrow();
  });

  it('takes the one callback with the right state, behind a static page under a no-content policy, and logs no code', async () => {
    const log = vi.fn();
    const r = await receiver({ log });
    const answer = await send(r.port, { path: `/callback?code=the-code-123&state=${STATE}` });
    expect(answer.status).toBe(200);
    expect(answer.headers['content-security-policy']).toBe("default-src 'none'");
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
    expect(answer.body).not.toContain('the-code-123');
    await expect(r.code).resolves.toBe('the-code-123');
    expect(JSON.stringify(log.mock.calls)).not.toContain('the-code-123');
    // one callback: the receiver has closed
    await expect(send(r.port, { path: `/callback?code=again&state=${STATE}` })).rejects.toThrow();
  });

  it('refuses another Host, another path, another method and another sign-in\'s state, and keeps waiting', async () => {
    const r = await receiver();
    expect((await send(r.port, { path: `/callback?code=x&state=${STATE}`, host: 'localhost' })).status).toBe(400);
    expect((await send(r.port, { path: `/callback?code=x&state=${STATE}`, host: `evil.example:${r.port}` })).status).toBe(400);
    expect((await send(r.port, { path: `/callback/?code=x&state=${STATE}` })).status).toBe(404);
    expect((await send(r.port, { path: `/other?code=x&state=${STATE}` })).status).toBe(404);
    expect((await send(r.port, { method: 'POST', path: `/callback?code=x&state=${STATE}` })).status).toBe(405);
    expect((await send(r.port, { path: '/callback?code=x&state=wrong' })).status).toBe(400);
    expect((await send(r.port, { path: 'http://[' })).status).toBe(400);
    const good = await send(r.port, { path: `/callback?code=late-code&state=${STATE}` });
    expect(good.status).toBe(200);
    await expect(r.code).resolves.toBe('late-code');
  });

  it('reports a denial from the server as denied', async () => {
    const r = await receiver();
    await send(r.port, { path: `/callback?error=access_denied&state=${STATE}` });
    await expect(r.code).rejects.toMatchObject({ kind: 'denied' });
  });

  it('times out after its limit and cancels on abort', async () => {
    const timed = await receiver({ timeoutMs: 30 });
    await expect(timed.code).rejects.toMatchObject({ kind: 'expired', text: { message: 'The browser sign-in timed out. Start it again.' } });
    const controller = new AbortController();
    const aborted = await receiver({ signal: controller.signal });
    controller.abort();
    await expect(aborted.code).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('closes the server and rejects when the sign-in is cancelled while it starts listening', async () => {
    const controller = new AbortController();
    const starting = startLoopbackReceiver({ state: STATE, signal: controller.signal, log: () => undefined });
    controller.abort();
    await expect(starting).rejects.toMatchObject({ kind: 'cancelled' });
    expect(created.at(-1)!.listening).toBe(false);
  });

  it('fails the sign-in on a server error after it listens', async () => {
    const r = await receiver();
    const broken = new Error('accept failed');
    created.at(-1)!.emit('error', broken);
    await expect(r.code).rejects.toBe(broken);
    expect(created.at(-1)!.listening).toBe(false);
  });
});
