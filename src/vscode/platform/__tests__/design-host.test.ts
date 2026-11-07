import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A remote window's forward: the browser reaches the extension host's port as localhost:54321.
const H = vi.hoisted(() => ({
  asExternalUri: vi.fn(async (uri: { toString(): string }) => {
    const external = uri.toString().replace(/^http:\/\/127\.0\.0\.1:\d+/, 'http://localhost:54321');
    return { authority: 'localhost:54321', toString: () => external };
  }),
}));

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vscode') & Record<string, unknown>>();
  return {
    ...actual,
    Uri: { ...actual.Uri, parse: (value: string) => ({ toString: () => value }) },
    env: { ...actual.env, asExternalUri: H.asExternalUri },
  };
});

import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createVsCodeDesignHost } from '../design-host';
import { servedCsp } from '../../../core/design/serve-policy';

function get(url: string, host: string): Promise<{ status: number; csp: string | undefined; body: string }> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: parsed.hostname, port: parsed.port, path: parsed.pathname, headers: { Host: host }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, csp: res.headers['content-security-policy'] as string | undefined, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

let root: string;
let folder: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-host-'));
  folder = path.join(root, 'contacts-1a2b3c4d');
  fs.mkdirSync(path.join(folder, 'screens'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'screens', 'S1-contacts.html'), '<h1>Contacts</h1><script>document.title = "ran"</script>');
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ schemaVersion: 1, designId: 'contacts-1a2b3c4d', plan: null, fidelity: 'static', status: 'draft', version: null, screens: [], updatedAt: '2026-01-01T00:00:00.000Z' }));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the VS Code design host', () => {
  it('opens the loopback URL, which VS Code forwards itself, and answers the forwarded URL the browser gets, whose Host it accepts', async () => {
    const shell = createFakePlatform().shell;
    const host = createVsCodeDesignHost(shell);
    try {
      const url = await host.openInBrowser('contacts-1a2b3c4d', folder, 'screens/S1-contacts.html');
      expect(url).toMatch(/^http:\/\/localhost:54321\/d\/[A-Za-z0-9_-]{43}\/screens\/S1-contacts\.html$/);
      expect(shell.openedExternal).toHaveLength(1);
      const local = shell.openedExternal[0]!;
      expect(local).toBe(url!.replace('localhost:54321', new URL(local).host));
      expect(new URL(local).hostname).toBe('127.0.0.1');

      const served = await get(local, 'localhost:54321');
      expect(served).toMatchObject({ status: 200, body: '<h1>Contacts</h1><script>document.title = "ran"</script>' });
      // A static design's inline script never runs.
      expect(served.csp).toBe(servedCsp('static'));
      expect((await get(local, 'elsewhere.example:54321')).status).toBe(421);

      host.closeDesign('contacts-1a2b3c4d');
      await expect(get(local, 'localhost:54321')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    } finally {
      host.dispose();
    }
  });

  it('accepts the Host a browser sends for the forwarded URL: no default port, punycode', async () => {
    H.asExternalUri.mockImplementationOnce(async (uri) => {
      const external = uri.toString().replace(/^http:\/\/127\.0\.0\.1:\d+/, 'https://bücher-54321.example:443');
      return { authority: 'bücher-54321.example:443', toString: () => external };
    });
    const shell = createFakePlatform().shell;
    const host = createVsCodeDesignHost(shell);
    try {
      expect(await host.openInBrowser('contacts-1a2b3c4d', folder, 'screens/S1-contacts.html')).toMatch(/^https:\/\/bücher-54321\.example:443\/d\//);
      const local = shell.openedExternal[0]!;
      expect((await get(local, 'xn--bcher-54321-thb.example')).status).toBe(200);
    } finally {
      host.dispose();
    }
  });

  it('answers undefined when VS Code declines to open the URL', async () => {
    const shell = { ...createFakePlatform().shell, openExternal: async () => false };
    const host = createVsCodeDesignHost(shell);
    try {
      expect(await host.openInBrowser('contacts-1a2b3c4d', folder, 'screens/S1-contacts.html')).toBeUndefined();
    } finally {
      host.dispose();
    }
  });
});
