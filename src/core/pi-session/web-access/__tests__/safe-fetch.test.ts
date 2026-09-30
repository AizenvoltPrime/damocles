import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * SSRF guard (US-028.2): scheme allowlist, private/loopback/link-local/metadata blocking by resolved IP,
 * per-hop redirect re-validation, redirect cap, and the streamed body-size cap. `fetch` and DNS `lookup`
 * are mocked; `readBodyCapped` runs against real `Response` bodies.
 */

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import { safeFetch, readBodyCapped } from '../safe-fetch';

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

function res(status: number, location?: string): Response {
  return {
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'location' ? (location ?? null) : null) },
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  lookupMock.mockReset();
  lookupMock.mockResolvedValue(PUBLIC);
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('blocks a hostname that resolves to a private IP', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(safeFetch('http://evil.example/', {})).rejects.toThrow(/Blocked private address/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks a hostname resolving to an IPv4-mapped IPv6 loopback', async () => {
    lookupMock.mockResolvedValue([{ address: '::ffff:127.0.0.1', family: 6 }]);
    await expect(safeFetch('http://evil.example/', {})).rejects.toThrow(/Blocked private address/);
  });

  it('allows a public host and passes redirect:manual to fetch', async () => {
    fetchMock.mockResolvedValue(res(200));
    const r = await safeFetch('https://example.com/x', { headers: { a: 'b' } });
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/x', expect.objectContaining({ redirect: 'manual' }));
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
