import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const partitions: string[] = [];
const fake = vi.hoisted(() => ({ session: undefined as unknown }));

vi.mock('electron', () => ({
  session: {
    fromPartition: (partition: string) => {
      partitions.push(partition);
      return fake.session;
    },
    defaultSession: { name: 'default' },
  },
  protocol: { handle: vi.fn() },
}));

import { createDesignSession, DESIGN_PARTITION, serveDesignRequest, type DesignSessionDeps } from '../design/design-session';

class FakeSession extends EventEmitter {
  handler: ((request: Request) => Promise<Response>) | undefined;
  beforeRequest: ((details: { url: string }, callback: (response: { cancel: boolean }) => void) => void) | undefined;
  readonly protocol = {
    handle: vi.fn((scheme: string, handler: (request: Request) => Promise<Response>) => {
      expect(scheme).toBe('damocles-design');
      this.handler = handler;
    }),
  };
  readonly webRequest = {
    onBeforeRequest: vi.fn((listener: FakeSession['beforeRequest']) => {
      this.beforeRequest = listener;
    }),
  };
  readonly setPermissionRequestHandler = vi.fn();
  readonly setPermissionCheckHandler = vi.fn();
  readonly setDevicePermissionHandler = vi.fn();
  readonly setSpellCheckerEnabled = vi.fn();
  readonly setProxy = vi.fn(async () => undefined);
}

const TOKEN = '0123456789abcdef0123456789abcdef';
const SCREEN = new TextEncoder().encode('<html><body>S1</body></html>');

let session: FakeSession;
let read: ReturnType<typeof vi.fn<DesignSessionDeps['read']>>;
const logged: string[] = [];

beforeEach(() => {
  session = new FakeSession();
  fake.session = session;
  partitions.length = 0;
  logged.length = 0;
  read = vi.fn<DesignSessionDeps['read']>(async (_target, relPath) => (relPath === 'screens/S1.html' ? { bytes: SCREEN, fidelity: 'static' } : relPath === 'big.png' ? 'tooLarge' : undefined));
  const deps: DesignSessionDeps = {
    targetOf: (token) => (token === TOKEN ? { authority: 'ssh:host', designId: 'contacts-1a2b3c4d' } : undefined),
    read,
    log: (line) => logged.push(line),
  };
  createDesignSession((request) => serveDesignRequest(request, deps));
});

const get = (url: string, method = 'GET'): Promise<Response> => session.handler!(new Request(url, { method }));

describe('the design-preview session', () => {
  it('is one in-memory partition with no permission, download, spellcheck or reachable proxy', () => {
    expect(partitions).toEqual([DESIGN_PARTITION]);
    expect(DESIGN_PARTITION).not.toMatch(/^persist:/);
    expect(session.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(session.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(session.setDevicePermissionHandler).toHaveBeenCalledOnce();
    expect(session.setSpellCheckerEnabled).toHaveBeenCalledWith(false);
    expect(session.setProxy).toHaveBeenCalledWith({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:1', proxyBypassRules: '<-loopback>' });
    const download = { preventDefault: vi.fn() };
    session.emit('will-download', download);
    expect(download.preventDefault).toHaveBeenCalledOnce();
  });

  it('cancels every request on the partition that is not the design scheme', () => {
    const verdict = (url: string): boolean => {
      let cancel: boolean | undefined;
      session.beforeRequest!({ url }, (response) => {
        cancel = response.cancel;
      });
      return cancel!;
    };
    for (const url of ['https://example.com/', 'http://127.0.0.1:8080/', 'ws://127.0.0.1:9/', 'wss://example.com/', 'file:///C:/Windows/win.ini', 'app://damocles/shell/index.html', 'blob:damocles-design://x/y']) {
      expect(verdict(url), url).toBe(true);
    }
    expect(verdict(`damocles-design://${TOKEN}/screens/S1.html`)).toBe(false);
  });

  it('serves a live view\'s file through the chat\'s core with the served headers, read by the design its token names', async () => {
    const response = await get(`damocles-design://${TOKEN}/screens/S1.html`);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(SCREEN);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toContain("script-src 'none'");
    // no modals flag, so Blink refuses the page's print() and execCommand('print'), whose dialog would stall main (D85)
    expect(response.headers.get('content-security-policy')).toMatch(/; sandbox allow-scripts allow-same-origin$/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(read).toHaveBeenCalledWith({ authority: 'ssh:host', designId: 'contacts-1a2b3c4d' }, 'screens/S1.html');
  });

  it('refuses another method, an unknown token, a path out of the folder, an unserved type and a file over the cap, reading none of the first four', async () => {
    expect((await get(`damocles-design://${TOKEN}/screens/S1.html`, 'POST')).status).toBe(405);
    expect((await get(`damocles-design://${'f'.repeat(32)}/screens/S1.html`)).status).toBe(404);
    expect((await get(`damocles-design://${TOKEN}/screens%5c..%5c..%5coutside.html`)).status).toBe(404);
    expect((await get(`damocles-design://${TOKEN}/%E0%A4%A.html`)).status).toBe(404);
    expect((await get(`damocles-design://${TOKEN}/screens/S1.exe`)).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
    const big = await get(`damocles-design://${TOKEN}/big.png`);
    expect(big.status).toBe(404);
    expect(big.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(big.headers.get('content-security-policy')).toContain('sandbox allow-scripts allow-same-origin');
  });

  it("reads a dot segment only below the folder, since the URL parser resolves it against the origin's root", async () => {
    await get(`damocles-design://${TOKEN}/screens/%2e%2e/%2e%2e/screens/S1.html`);
    expect(read).toHaveBeenCalledWith(expect.anything(), 'screens/S1.html');
  });

  it('answers 500 and logs the design, never the token, when the core read fails', async () => {
    read.mockRejectedValueOnce(new Error('The core of ssh:host is not connected'));
    expect((await get(`damocles-design://${TOKEN}/screens/S1.html`)).status).toBe(500);
    expect(logged.join('\n')).toContain('contacts-1a2b3c4d');
    expect(logged.join('\n')).not.toContain(TOKEN);
  });
});
