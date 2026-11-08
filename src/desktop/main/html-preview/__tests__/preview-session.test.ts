import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const partitions: string[] = [];
const fake = vi.hoisted(() => ({ session: undefined as unknown }));

vi.mock('electron', () => ({
  session: {
    fromPartition: (partition: string) => {
      partitions.push(partition);
      return fake.session;
    },
  },
  protocol: { handle: vi.fn() },
}));

import { answerPreview } from '../preview-reader';
import { createPreviewSession, HTML_PREVIEW_PARTITION, previewResponse } from '../preview-session';
import { SYNTHETIC_CHUNK_BYTES, syntheticFile, type SyntheticFile } from './synthetic-file';

class FakeSession extends EventEmitter {
  handler: ((request: Request) => Promise<Response>) | undefined;
  beforeRequest: ((details: { url: string; webContentsId?: number }, callback: (response: { cancel: boolean }) => void) => void) | undefined;
  completed: ((details: { url: string; webContentsId?: number; statusCode: number }) => void) | undefined;
  // host name -> its addresses; a name not listed does not resolve
  readonly names = new Map<string, string[]>();
  readonly protocol = {
    handle: vi.fn((scheme: string, handler: (request: Request) => Promise<Response>) => {
      expect(scheme).toBe('damocles-preview');
      this.handler = handler;
    }),
  };
  readonly webRequest = {
    onBeforeRequest: vi.fn((listener: FakeSession['beforeRequest']) => {
      this.beforeRequest = listener;
    }),
    onCompleted: vi.fn((listener: FakeSession['completed']) => {
      this.completed = listener;
    }),
  };
  readonly resolveHost = vi.fn(async (host: string) => {
    const addresses = this.names.get(host);
    if (!addresses) throw new Error('net::ERR_NAME_NOT_RESOLVED');
    return { endpoints: addresses.map((address) => ({ address, family: address.includes(':') ? 'ipv6' : 'ipv4' })) };
  });
  readonly setPermissionRequestHandler = vi.fn();
  readonly setPermissionCheckHandler = vi.fn();
  readonly setDevicePermissionHandler = vi.fn();
  readonly setSpellCheckerEnabled = vi.fn();
  readonly setProxy = vi.fn(async () => undefined);
}

// two views of one root share its token; a third view previews another root
const ROOT_A = '0123456789abcdef0123456789abcdef';
const ROOT_B = 'fedcba9876543210fedcba9876543210';
const TOKENS = new Map([[1, ROOT_A], [2, ROOT_A], [3, ROOT_B]]);
// root A's project is trusted, root B's is not
const TRUSTED = new Set([1, 2]);

let session: FakeSession;
let served: Array<[number, string]>;
let logged: string[];
let tokenOf: (id: number) => string | undefined;
let handle: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>>;

beforeEach(() => {
  session = new FakeSession();
  fake.session = session;
  partitions.length = 0;
  served = [];
  logged = [];
  tokenOf = (id) => TOKENS.get(id);
  handle = vi.fn(async () => new Response('x'));
  createPreviewSession({ tokenOf: (id) => tokenOf(id), trustedOf: (id) => TRUSTED.has(id), served: (id, pathname) => served.push([id, pathname]), handle, log: (line) => logged.push(line) });
});

// what the session's request filter answers, which it may do after an await
const cancelled = (url: string, webContentsId?: number): Promise<boolean> => new Promise((resolve) => {
  session.beforeRequest!({ url, ...(webContentsId !== undefined ? { webContentsId } : {}) }, (response) => resolve(response.cancel));
});

describe('the html-preview session', () => {
  it('is one in-memory partition with no permission, download or spellcheck, on the system proxy', () => {
    expect(partitions).toEqual([HTML_PREVIEW_PARTITION]);
    expect(HTML_PREVIEW_PARTITION).toBe('html-preview');
    expect(session.protocol.handle).toHaveBeenCalledOnce();
    expect(session.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(session.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(session.setDevicePermissionHandler).toHaveBeenCalledOnce();
    expect(session.setSpellCheckerEnabled).toHaveBeenCalledWith(false);
    expect(session.setProxy).toHaveBeenCalledWith({ mode: 'system' });
    const download = { preventDefault: vi.fn() };
    session.emit('will-download', download);
    expect(download.preventDefault).toHaveBeenCalledOnce();
  });

  it('lets a trusted view load its own root and the web, loopback included, and cancels everything else', async () => {
    for (const url of [`damocles-preview://${ROOT_A}/index.html`, `damocles-preview://${ROOT_A}/css/a.css`, 'https://cdn.example.com/lib.js', 'http://127.0.0.1:5173/api', 'ws://localhost:9/', 'wss://example.com/socket', 'http://192.168.1.1/']) {
      expect(await cancelled(url, 1), url).toBe(false);
    }
    expect(await cancelled(`damocles-preview://${ROOT_A}/index.html`, 2)).toBe(false);
    for (const url of ['file:///C:/Windows/win.ini', 'file:///etc/passwd', 'app://damocles/shell/index.html', `damocles-design://${ROOT_A}/screens/S1.html`, 'ftp://example.com/', 'chrome://gpu', 'devtools://devtools/x', 'not a url', 'javascript:alert(1)']) {
      expect(await cancelled(url, 1), url).toBe(true);
    }
    expect(session.resolveHost).not.toHaveBeenCalled();
  });

  it("refuses another root's token, an unknown view, a request with no view, and a token carried anywhere but the host", async () => {
    expect(await cancelled(`damocles-preview://${ROOT_B}/index.html`, 1)).toBe(true);
    expect(await cancelled(`damocles-preview://${ROOT_A}/index.html`, 3)).toBe(true);
    expect(await cancelled(`damocles-preview://${ROOT_A}/index.html`, 99)).toBe(true);
    expect(await cancelled(`damocles-preview://${ROOT_A}/index.html`)).toBe(true);
    expect(await cancelled(`damocles-preview://${ROOT_A}:8080/index.html`, 1)).toBe(true);
    expect(await cancelled(`damocles-preview://evil/${ROOT_A}/index.html`, 1)).toBe(true);
    expect(await cancelled(`damocles-preview://${ROOT_A}.evil/index.html`, 1)).toBe(true);
  });

  it('keeps an untrusted view, and a request of no known view, off loopback and private networks, every spelling of them included', async () => {
    session.names.set('cdn.example.com', ['104.20.23.154', '2606:4700::6810:1']);
    session.names.set('router.lan', ['192.168.1.1']);
    session.names.set('mixed.example.com', ['104.20.23.154', '10.0.0.7']);
    session.names.set('rebind.example.com', ['::ffff:127.0.0.1']);
    session.names.set('ula.example.com', ['fd12:3456::1']);
    session.names.set('empty.example.com', []);
    expect(await cancelled(`damocles-preview://${ROOT_B}/index.html`, 3)).toBe(false);
    for (const url of ['https://cdn.example.com/lib.js', 'http://cdn.example.com/a.png', 'wss://cdn.example.com/s', 'http://8.8.8.8/', 'https://[2606:4700::6810:1]/', 'http://172.32.0.1/', 'http://100.128.0.1/', 'http://169.255.0.1/']) {
      expect(await cancelled(url, 3), url).toBe(false);
    }
    const refused = [
      // raw spellings, and the canonical forms Chromium hands the filter
      'http://127.0.0.1:5173/api', 'http://2130706433/', 'http://0x7f.1/', 'http://017700000001/', 'http://127.1/', 'http://127.255.255.254/',
      'http://[::1]/', 'http://[::]/', 'http://0.0.0.0:8080/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:c0a8:101]/',
      'http://10.1.2.3/', 'http://172.16.0.1/', 'http://172.31.255.255/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data',
      'http://100.64.0.1/', 'http://100.127.255.255/', 'http://[fe80::1]/', 'http://[febf::1]/', 'http://[fc00::1]/', 'http://[fd00::1]/',
      'ws://localhost:9/', 'http://LOCALHOST/', 'http://localhost./', 'http://app.localhost/', 'https://a.b.localhost:3000/',
      // names that resolve to a private address, to any, or not at all
      'http://router.lan/', 'https://mixed.example.com/', 'https://rebind.example.com/', 'https://ula.example.com/', 'https://empty.example.com/', 'https://nxdomain.example.com/',
    ];
    for (const url of refused) expect(await cancelled(url, 3), url).toBe(true);
    for (const url of ['http://127.0.0.1/', 'http://router.lan/', 'https://cdn.example.com/']) expect(await cancelled(url, 99), url).toBe(url !== 'https://cdn.example.com/');
    expect(await cancelled('http://192.168.1.1/')).toBe(true);
    // each view logs its first refusal only, naming the origin and never the path
    expect(logged).toEqual([
      '[html-preview] refused an untrusted preview\'s request to "http://127.0.0.1:5173", a private address; this view\'s further ones are not logged',
      '[html-preview] refused an untrusted preview\'s request to "http://127.0.0.1", a private address; this view\'s further ones are not logged',
      '[html-preview] refused an untrusted preview\'s request to "http://192.168.1.1", a private address; this view\'s further ones are not logged',
    ]);
  });

  it('checks each redirect hop as its own request, so a public page cannot redirect a view onto a private address', async () => {
    session.names.set('public.example.com', ['93.184.215.14']);
    // Electron calls onBeforeRequest again with each redirect's location
    expect(await cancelled('https://public.example.com/r', 3)).toBe(false);
    expect(await cancelled('http://127.0.0.2:8080/after-redirect.png', 3)).toBe(true);
  });

  it('cancels a request whose check throws, and logs why, rather than leaving it hanging', async () => {
    tokenOf = () => {
      throw new Error('the view went away');
    };
    expect(await cancelled(`damocles-preview://${ROOT_A}/index.html`, 1)).toBe(true);
    expect(logged).toEqual(["[html-preview] checking a preview's request failed, so it was cancelled: the view went away"]);
  });

  it('records a preview path only once the view was served its file', () => {
    session.completed!({ url: `damocles-preview://${ROOT_A}/index.html`, webContentsId: 1, statusCode: 200 });
    session.completed!({ url: `damocles-preview://${ROOT_A}/media/a.mp4`, webContentsId: 1, statusCode: 206 });
    for (const statusCode of [404, 500, 503, 308]) session.completed!({ url: `damocles-preview://${ROOT_A}/a${statusCode}/x.png`, webContentsId: 1, statusCode });
    session.completed!({ url: 'https://cdn.example.com/a.css', webContentsId: 1, statusCode: 200 });
    session.completed!({ url: `damocles-preview://${ROOT_A}/b.css`, statusCode: 200 });
    expect(served).toEqual([[1, '/index.html'], [1, '/media/a.mp4']]);
  });

  it('streams an answer body and keeps its status and headers', async () => {
    let returned = false;
    const chunks: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => {
        let sent = false;
        return {
          next: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: new TextEncoder().encode('<p>hi</p>') };
          },
          return: async () => {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const response = previewResponse({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }, body: chunks });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe('<p>hi</p>');
    const cancelledBody = previewResponse({ status: 200, headers: {}, body: { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: new Uint8Array(1) }), return: async () => { returned = true; return { done: true, value: undefined }; } }) } });
    await cancelledBody.body!.cancel();
    expect(returned).toBe(true);
  });

  it('errors a file body whose read ends short of its Content-Length, and cuts one that yields more, so the load never completes short', async () => {
    // a 10-byte file whose read yields `yielded` bytes instead
    const misread = (yielded: number) => ({
      range: async (_relativePath: string, offset: number, length: number) => ({ ok: true as const, size: 10, offset, length: Math.min(length, 10 - offset), resolvedPath: 'clip.mp4', chunks: (async function* () { yield new Uint8Array(yielded); })() }),
    });
    const served = async (yielded: number, range: string | undefined): Promise<Response> => previewResponse(await answerPreview({ method: 'GET', pathname: '/clip.mp4', trusted: false, target: 'view', range, ifRange: undefined }, misread(yielded), () => undefined));
    for (const range of [undefined, 'bytes=2-9']) {
      const short = await served(4, range);
      expect(short.headers.get('content-length'), range).toBe(range ? '8' : '10');
      await expect(short.arrayBuffer(), range).rejects.toThrow();
      const long = await served(30, range);
      expect((await long.arrayBuffer()).byteLength, range).toBe(range ? 8 : 10);
    }
  });
});

describe('the scheme\'s file body', () => {
  // big.mp4, never held whole
  const BIG = 200 * 1024 * 1024;
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
  const served = async (big: SyntheticFile, range?: string): Promise<Response> => previewResponse(await answerPreview({ method: 'GET', pathname: '/big.mp4', trusted: false, target: 'view', range, ifRange: undefined }, big.reads, () => undefined));

  it('reads one chunk of a file per pull, at most one ahead of the page, and a cancel releases the read and stops it', async () => {
    const big = syntheticFile(BIG);
    const response = await served(big);
    expect(response.headers.get('content-length')).toBe(String(BIG));
    await settle();
    expect(big.stats.produced).toBeLessThanOrEqual(1);
    const reader = response.body!.getReader();
    for (let reads = 1; reads <= 5; reads++) {
      expect((await reader.read()).done).toBe(false);
      await settle();
      expect(big.stats.produced).toBeLessThanOrEqual(reads + 1);
    }
    await reader.cancel();
    expect(big.stats.returned).toBe(1);
    const produced = big.stats.produced;
    await settle();
    expect(big.stats.produced).toBe(produced);
  });

  // Electron hands a protocol.handle body to its loader through Readable.fromWeb and destroys that stream when Chromium drops the
  // request (a seek, a closed view)
  it('releases the read when the body\'s Node stream is destroyed mid-file', async () => {
    const big = syntheticFile(BIG);
    const body = Readable.fromWeb((await served(big, 'bytes=1000-')).body! as NodeReadableStream<Uint8Array>);
    await new Promise<void>((resolve) => body.once('data', () => resolve()));
    body.pause();
    body.destroy();
    await expect.poll(() => big.stats.returned).toBe(1);
    const produced = big.stats.produced;
    await settle();
    expect(big.stats.produced).toBe(produced);
    expect(big.stats.producedBytes).toBeLessThan(BIG / 100);
  });

  it.each([
    [undefined, 200, BIG],
    ['bytes=0-', 206, BIG],
    ['bytes=1000-', 206, BIG - 1000],
    [`bytes=-${BIG - 5}`, 206, BIG - 5],
  ])('streams all of a 200 MiB file for Range %s, with no more than one chunk read ahead of the page', async (range, status, length) => {
    const big = syntheticFile(BIG);
    const response = await served(big, range);
    expect(response.status).toBe(status);
    expect(response.headers.get('content-length')).toBe(String(length));
    const reader = response.body!.getReader();
    let received = 0;
    let ahead = 0;
    for (let step = await reader.read(); !step.done; step = await reader.read()) {
      received += step.value.byteLength;
      ahead = Math.max(ahead, big.stats.producedBytes - received);
    }
    expect(received).toBe(length);
    expect(ahead).toBeLessThanOrEqual(SYNTHETIC_CHUNK_BYTES);
    expect(big.stats.returned).toBe(1);
  });
});
