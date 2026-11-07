import * as http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignServer, type DesignServerDeps } from '../design/design-server';

const SCREEN = new TextEncoder().encode('<html><body>S1</body></html>');

function get(url: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

let server: DesignServer | undefined;
afterEach(async () => {
  await server?.dispose();
  server = undefined;
});

function serve(read: DesignServerDeps['read']): { opened: string[]; server: DesignServer } {
  const opened: string[] = [];
  server = new DesignServer({ read, openExternal: async (url) => { opened.push(url); return true; } });
  return { opened, server };
}

describe('main\'s design server (PD-35)', () => {
  it('opens the loopback URL of a design file, reading it through the authority\'s core with the served headers', async () => {
    const read = vi.fn<DesignServerDeps['read']>(async () => ({ bytes: SCREEN, fidelity: 'interactive' }));
    const { opened, server } = serve(read);
    expect(await server.open({ authority: 'wsl:Ubuntu', designId: 'contacts-1a2b3c4d' }, 'screens/S1.html')).toBe(true);
    expect(opened).toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/d\/[A-Za-z0-9_-]{43}\/screens\/S1\.html$/)]);
    const response = await get(opened[0]!);
    expect(response.status).toBe(200);
    expect(response.body).toBe('<html><body>S1</body></html>');
    expect(response.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'");
    expect(read).toHaveBeenCalledWith({ authority: 'wsl:Ubuntu', designId: 'contacts-1a2b3c4d' }, 'screens/S1.html');
  });

  it('answers a file the core refuses or holds no more with 404, and a revoked design with nothing', async () => {
    const { opened, server } = serve(async (_target, relPath) => (relPath === 'screens/S1.html' ? { bytes: SCREEN, fidelity: null } : relPath === 'big.png' ? 'tooLarge' : undefined));
    const target = { authority: 'local', designId: 'contacts-1a2b3c4d' };
    await server.open(target, 'screens/S1.html');
    const base = opened[0]!.replace(/screens\/S1\.html$/, '');
    expect((await get(`${base}missing.html`)).status).toBe(404);
    expect((await get(`${base}big.png`)).status).toBe(404);
    server.revoke(target);
    // the last token went, so the server closed
    expect(server.boundPort()).toBeUndefined();
    await expect(get(opened[0]!)).rejects.toThrow();
  });

  it('keeps one token per authority and design, so another host\'s copy of the same design id is another URL', async () => {
    const { opened, server } = serve(async () => ({ bytes: SCREEN, fidelity: 'static' }));
    await server.open({ authority: 'local', designId: 'contacts-1a2b3c4d' }, 'screens/S1.html');
    await server.open({ authority: 'local', designId: 'contacts-1a2b3c4d' }, 'screens/S2.html');
    await server.open({ authority: 'ssh:host', designId: 'contacts-1a2b3c4d' }, 'screens/S1.html');
    const tokens = opened.map((url) => /\/d\/([^/]+)\//.exec(url)![1]);
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).not.toBe(tokens[0]);
  });
});
