import type { LookupAddress, LookupOptions } from 'node:dns';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * SSRF guard (US-028.2): scheme allowlist, private/loopback/link-local/metadata blocking by literal and by every DNS answer at
 * connect time, per-hop redirect re-validation, redirect cap, and the streamed body-size cap. DNS `lookup` is mocked and undici's
 * `fetch` is the real one unless a test answers in its place; `readBodyCapped` runs against real `Response` bodies.
 */

const { lookupMock, fetchMock } = vi.hoisted(() => ({ lookupMock: vi.fn(), fetchMock: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));
vi.mock('undici', async (importOriginal) => ({ ...(await importOriginal<typeof import('undici')>()), fetch: fetchMock }));

import { connectGuardedFetchThroughHost, createGuardedFetch, FetchRefusedError, guardedLookup, readBodyCapped, RedirectRefusedError, safeFetch } from '../safe-fetch';

const { fetch: undiciFetch } = await vi.importActual<typeof import('undici')>('undici');
const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

function res(status: number, location?: string): Response {
  return {
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'location' ? (location ?? null) : null) },
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(undiciFetch);
  lookupMock.mockReset();
  lookupMock.mockResolvedValue(PUBLIC);
});

describe('safeFetch — scheme allowlist', () => {
  it('rejects non-http(s) schemes without fetching', async () => {
    await expect(safeFetch('file:///etc/passwd', {})).rejects.toThrow(/Blocked URL scheme/);
    await expect(safeFetch('ftp://example.com/x', {})).rejects.toThrow(/Blocked URL scheme/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('safeFetch — private address blocking', () => {
  it.each([
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://[::1]/',
    // Alternate encodings the WHATWG URL parser canonicalizes to a blocked address:
    'http://2130706433/', // decimal → 127.0.0.1
    'http://0x7f000001/', // hex → 127.0.0.1
    'http://0177.0.0.1/', // octal → 127.0.0.1
    'http://[::ffff:127.0.0.1]/', // IPv4-mapped IPv6 → ::ffff:7f00:1 loopback
  ])('blocks IP-literal private address %s without fetching', async (url) => {
    await expect(safeFetch(url, {})).rejects.toThrow(/Blocked private address/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks a hostname that resolves to a private IP when it connects', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const refused = safeFetch('http://evil.example/', {});
    await expect(refused).rejects.toBeInstanceOf(FetchRefusedError);
    await expect(refused).rejects.toThrow(/Blocked private address: evil\.example → 127\.0\.0\.1/);
    expect(lookupMock).toHaveBeenCalledWith('evil.example', expect.anything());
  });

  it('blocks a hostname resolving to an IPv4-mapped IPv6 loopback', async () => {
    lookupMock.mockResolvedValue([{ address: '::ffff:127.0.0.1', family: 6 }]);
    await expect(safeFetch('http://evil.example/', {})).rejects.toThrow(/Blocked private address/);
  });

  it('allows a public host and passes redirect:manual and the guard\'s dispatcher to fetch', async () => {
    fetchMock.mockResolvedValue(res(200));
    const r = await safeFetch('https://example.com/x', { headers: { a: 'b' } });
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/x', expect.objectContaining({ redirect: 'manual', dispatcher: expect.anything() }));
  });
});

describe('safeFetch — redirects', () => {
  it('re-validates each hop and blocks a 302 into private space', async () => {
    fetchMock.mockResolvedValueOnce(res(302, 'http://169.254.169.254/'));
    await expect(safeFetch('https://example.com/', {})).rejects.toThrow(/Blocked private address/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows a redirect to a public URL', async () => {
    fetchMock.mockResolvedValueOnce(res(302, 'https://example.org/final')).mockResolvedValueOnce(res(200));
    const r = await safeFetch('https://example.com/', {});
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a redirect loop past the cap', async () => {
    fetchMock.mockResolvedValue(res(302, 'https://example.com/loop'));
    await expect(safeFetch('https://example.com/', {})).rejects.toThrow(/Too many redirects/);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('cancels the body of every redirect it leaves, the one past the cap included', async () => {
    let cancelled = 0;
    fetchMock.mockImplementation(() => Promise.resolve(new Response(new ReadableStream({ cancel: () => { cancelled++; } }), { status: 302, headers: { location: '/loop' } })));
    await expect(safeFetch('https://example.com/', {})).rejects.toThrow(/Too many redirects/);
    expect(cancelled).toBe(6);
  });

  it('stops at a redirect its caller refuses, naming the target, without contacting it', async () => {
    fetchMock.mockResolvedValueOnce(res(301, 'https://other.org/x?y=1'));
    const refused = safeFetch('https://example.com/a', {}, { redirectRefused: (target) => new URL(target).hostname === 'other.org' });
    await expect(refused).rejects.toBeInstanceOf(RedirectRefusedError);
    await expect(refused).rejects.toMatchObject({ from: 'https://example.com/a', location: 'https://other.org/x?y=1', status: 301 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('the guarded connection', () => {
  let server: Server;
  let port: number;
  let served: string[];

  beforeEach(async () => {
    served = [];
    server = createServer((req, response) => {
      served.push(req.url ?? '');
      response.end('reached');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const lookupOnce = (lookup: ReturnType<typeof guardedLookup>, hostname: string, options: LookupOptions): Promise<{ address: string | LookupAddress[]; family?: number }> =>
    new Promise((resolve, reject) => lookup(hostname, options, (err, address, family) => (err ? reject(err) : resolve({ address, ...(family !== undefined ? { family } : {}) }))));

  it('refuses a name whose answer at connect time is private, though an earlier lookup of it was public', async () => {
    let lookups = 0;
    const rebinding = vi.fn(async () => [{ address: lookups++ === 0 ? '93.184.216.34' : '127.0.0.1', family: 4 }]);
    // the earlier lookup, as a check before the request would make it
    expect(await lookupOnce(guardedLookup(rebinding), 'rebind.test', { all: true })).toEqual({ address: [{ address: '93.184.216.34', family: 4 }] });
    const refused = createGuardedFetch(rebinding)(`http://rebind.test:${port}/secret`, {});
    await expect(refused).rejects.toBeInstanceOf(FetchRefusedError);
    await expect(refused).rejects.toThrow(/Blocked private address: rebind\.test → 127\.0\.0\.1/);
    expect(rebinding).toHaveBeenCalledTimes(2);
    expect(served).toEqual([]);
  });

  it('hands the socket a public name\'s checked addresses, in the family it asks for, and refuses a name with any private answer', async () => {
    const answers = [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }];
    const lookup = guardedLookup(async () => answers);
    expect(await lookupOnce(lookup, 'example.test', { all: true })).toEqual({ address: answers });
    expect(await lookupOnce(lookup, 'example.test', {})).toEqual({ address: '93.184.216.34', family: 4 });
    expect(await lookupOnce(lookup, 'example.test', { family: 6 })).toEqual({ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 });
    const mixed = guardedLookup(async () => [...answers, { address: '10.0.0.7', family: 4 }]);
    await expect(lookupOnce(mixed, 'example.test', { all: true })).rejects.toBeInstanceOf(FetchRefusedError);
  });
});

describe("the host's own fetch", () => {
  it('checks the literal and the DNS answers before each hop, then fetches through the host, never its own dispatcher', async () => {
    const host = vi.fn(async () => res(200));
    const undo = connectGuardedFetchThroughHost(host);
    try {
      expect((await safeFetch('https://example.com/x', {})).status).toBe(200);
      expect(host).toHaveBeenCalledWith('https://example.com/x', expect.objectContaining({ redirect: 'manual' }));
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(safeFetch('http://10.0.0.5/', {})).rejects.toThrow(/Blocked private address/);
      lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      await expect(safeFetch('https://evil.example/', {})).rejects.toThrow(/Blocked private address: evil\.example → 127\.0\.0\.1/);
      expect(host).toHaveBeenCalledTimes(1);
    } finally {
      undo();
    }
  });
});

describe('readBodyCapped', () => {
  it('returns the bytes when under the cap', async () => {
    const bytes = await readBodyCapped(new Response('hello'), 1000);
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });

  it('throws once the streamed body exceeds the cap', async () => {
    await expect(readBodyCapped(new Response('x'.repeat(5000)), 100)).rejects.toThrow(/Response too large/);
  });

  it('reads a null body (bodyless response) as empty without buffering', async () => {
    const fake = { body: null, arrayBuffer: async () => new TextEncoder().encode('abc').buffer } as unknown as Response;
    const bytes = await readBodyCapped(fake, 1000);
    expect(bytes.byteLength).toBe(0); // cap-safe: never buffer-before-check, even on the no-stream path
  });
});
