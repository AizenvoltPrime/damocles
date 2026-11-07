import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, selectChatPage, test } from './support/fixtures';
import { DESIGN_APP, grounding, recordOpenExternal, startDesignChat } from './support/design';
import { seedStubModel, type HermeticHome } from './support/hermetic';
import { call, startOpenAIStub, type OpenAIStub } from './support/openai-stub';
import { openProjectChat } from './support/screenshots';
import { shellPage } from './support/shell';
import { awaitTurnEnd } from './support/ui';

// PD-35: the preview tab's Browser button serves the design from main's own loopback server, reading each file through the
// chat's core, with the served headers and refusals. Node fetches the served URL; no browser opens.

test.describe.configure({ timeout: 300_000 });

const DESIGN_MD = ['---', 'app: Laravel 11, Inertia, Vue 3, Tailwind 4', 'viewports:', '  primary: xl', '  checked: [xl]', '  journey: []', '---', '# Contacts', ''].join('\n');

const SCREEN = [
  '<!doctype html>',
  '<html lang="en" data-ds-screen="S1" data-ds-states="default empty">',
  '<head><meta charset="utf-8"><title>Contacts</title><link rel="stylesheet" href="../tokens.css"></head>',
  '<body><main><h1>Contacts</h1><button data-ds-component="Button">Add contact</button></main></body></html>',
  '',
].join('\n');

interface Served {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** A GET of `target` (sent verbatim, so `..` and encoded segments reach the server as written) with the given Host. */
function get(port: number, target: string, host = `127.0.0.1:${port}`): Promise<Served> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: target, method: 'GET', headers: { host } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

/** A static design with one screen, whose first write opens its preview tab in the design chat, selected. */
async function staticDesign(home: HermeticHome, stub: OpenAIStub, app: ElectronApplication): Promise<{ design: Page; folder: string }> {
  const parent = await openProjectChat(app, home.project);
  const { design, folder } = await startDesignChat(app, parent, stub, home, {
    fidelity: 'Static mockup',
    script: (designDir) => [
      ...grounding(designDir, DESIGN_MD),
      call('write', { path: path.join(designDir, 'screens', 'S1-contacts.html'), content: SCREEN }),
      { chunks: ['Drafted the screen.'] },
    ],
  });
  await expect(design.getByText('Drafted the screen.')).toBeVisible({ timeout: 60_000 });
  await awaitTurnEnd(design);
  await selectChatPage(app, design);
  return { design, folder };
}

test('Open in browser serves the design from main with the served headers, and refuses a wrong Host, a path outside the folder and a revoked token', async ({ foreground: _foreground, home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    fs.cpSync(DESIGN_APP, home.project, { recursive: true });
    const { app } = await launch();
    const opened = await recordOpenExternal(app);
    const { folder } = await staticDesign(home, stub, app);
    // a file beside the design folder, which no served path may reach
    fs.writeFileSync(path.join(path.dirname(folder), 'outside.html'), '<p>outside</p>');
    const shell = await shellPage(app);

    await shell.getByTestId('design-preview-browser').click();
    await expect.poll(opened).toHaveLength(1);
    const url = new URL((await opened())[0]!);
    expect(url.hostname).toBe('127.0.0.1');
    const port = Number(url.port);
    const [, token] = /^\/d\/([^/]+)\/screens\/S1-contacts\.html$/.exec(url.pathname) ?? [];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The screen, read through the chat's core, with the served headers; a static design runs no script.
    const page = await get(port, url.pathname);
    expect(page.status).toBe(200);
    expect(page.body).toBe(SCREEN);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toContain("script-src 'none'");
    expect(page.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(page.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect((await get(port, `/d/${token}/tokens.css`)).status).toBe(200);

    // A Host no loopback name is, as a rebound DNS name would send.
    expect((await get(port, url.pathname, `attacker.example:${port}`)).status).toBe(421);
    // Paths that leave the folder, encoded or not, and an unknown token.
    for (const target of [`/d/${token}/../outside.html`, `/d/${token}/%2e%2e/outside.html`, `/d/${token}/screens/..%2f..%2foutside.html`, `/d/${token}/screens%5c..%5c..%5coutside.html`]) {
      const refused = await get(port, target);
      expect(refused.status, target).toBe(404);
      expect(refused.body, target).not.toContain('outside');
    }
    expect((await get(port, `/d/${'A'.repeat(43)}/screens/S1-contacts.html`)).status).toBe(404);
    expect((await get(port, `/d/${token}/manifest.json`)).status).toBe(200);
    expect((await get(port, `/d/${token}/screens/S1-contacts.exe`)).status).toBe(404);

    // Closing the design's last tab revokes its token; the server answers nothing for it from then on.
    const tabId = await shell.locator('[data-testid="editor-tab"][data-kind="designPreview"]').getAttribute('data-tab-id');
    await shell.evaluate((id) => window.damoclesShell!.editorTab({ action: 'close', tabId: id! }), tabId);
    await expect(shell.locator('[data-testid="editor-tab"][data-kind="designPreview"]')).toHaveCount(0);
    await expect.poll(async () => {
      try {
        return (await get(port, url.pathname)).status;
      } catch {
        // the server closed with its last token
        return 'closed';
      }
    }).not.toBe(200);
  } finally {
    await stub.close();
  }
});
