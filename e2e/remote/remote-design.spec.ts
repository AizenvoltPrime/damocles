import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { designTabs, recordOpenExternal, startDesignChat } from '../desktop/support/design';
import { selectChatPage } from '../desktop/support/fixtures';
import { call } from '../desktop/support/openai-stub';
import { menuItem, readyOverlay } from '../desktop/support/overlay';
import { shellPage } from '../desktop/support/shell';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { awaitTurnEnd } from '../desktop/support/ui';
import type { PortsView } from '../../src/desktop/preload/ports-channels';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { newRemoteChat, startTargetStub } from './support/target-agent';

// PD-10, PD-11 through an SSH target: the design lives on the target, the preview tab reads it through the remote chat's own
// core over the wire, and Open in browser serves it from this computer's main, with no listener on the target and no forward.

const APP = '/srv/app';
const DESIGNS = '/home/dev/.damocles/designs';

const DESIGN_MD = ['---', 'app: Vue 3', 'viewports:', '  primary: 1280', '  checked: [1280]', '  journey: []', '---', '# Contacts', ''].join('\n');
const SCREEN = [
  '<!doctype html>',
  '<html lang="en" data-ds-screen="S1" data-ds-states="default empty">',
  '<head><meta charset="utf-8"><title>Contacts</title></head>',
  '<body><main><h1>Contacts on the target</h1><p id="empty" data-ds-state-only="empty">No contacts yet</p></main></body></html>',
  '',
].join('\n');

// The target's listening TCP sockets (local address:port, hex), as `ss -ltn` lists them; the image has no `ss`.
const LISTENERS = `cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '$4 == "0A" { print $2 }' | sort -u`;

function get(url: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    }).on('error', reject);
  });
}

/** The host's forwarded ports, as its Ports section lists them. */
async function forwards(shell: Page, hostId: string): Promise<string[]> {
  const view = await shell.evaluate((id) => window.damoclesShell!.ports.get(id), hostId) as PortsView | null;
  return (view?.rows ?? []).filter((row) => row.state === 'forwarded').map((row) => `${row.remoteHost}:${row.remotePort} -> ${row.localPort}`);
}

test('a remote design chat\'s screen previews through its core, and Open in browser serves it from this computer', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(900_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture);
  try {
    const { app } = await launch({ env: remoteEnv(ssh, mirror) });
    const opened = await recordOpenExternal(app);
    const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
    await openRemoteFolder(app, hostId, APP);
    const key = await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    const parent = await newRemoteChat(app, key);

    const { design, folder } = await startDesignChat(app, parent, stub, home, {
      fidelity: 'Static mockup',
      script: (designFolder) => [
        call('write', { path: `${designFolder}/design.md`, content: DESIGN_MD }),
        call('write', { path: `${designFolder}/screens/S1-contacts.html`, content: SCREEN }),
        { chunks: ['Drafted the screen.'] },
      ],
      findFolder: async () => {
        const designId = (await fixture.sh(`find ${DESIGNS} -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\\n'`, 'dev')).trim();
        expect(designId).toMatch(/^[A-Za-z0-9._-]+$/);
        return `${DESIGNS}/${designId}`;
      },
    });
    await expect(design.getByText('Drafted the screen.')).toBeVisible({ timeout: 120_000 });
    await awaitTurnEnd(design);
    await selectChatPage(app, design);

    // The tab names the target's file and host, and its view loads the screen read through the remote core.
    await expect.poll(async () => (await designTabs(app))[0]?.designPreview.status, { timeout: 60_000 }).toBe('ready');
    const [tab] = await designTabs(app);
    expect(tab!.title).toBe('S1 · Contacts');
    expect(tab!.designPreview).toMatchObject({ relPath: 'screens/S1-contacts.html', path: `${folder}/screens/S1-contacts.html`, hostName: 'prod-1', width: 1280 });
    await expect.poll(() => app.evaluate(({ webContents }) => Promise.all(webContents.getAllWebContents()
      .filter((contents) => contents.getURL().startsWith('damocles-design:'))
      .map((contents) => contents.executeJavaScript('document.querySelector("h1")?.textContent ?? ""', true) as Promise<string>))), { timeout: 60_000 }).toEqual(['Contacts on the target']);

    // A designer edit on the target reloads the view.
    stub.replies.push(call('write', { path: `${folder}/screens/S1-contacts.html`, content: SCREEN.replace('Contacts on the target', 'Edited on the target') }), { chunks: ['Edited.'] });
    await sendPrompt(design, 'Change the heading');
    await expect(design.getByText('Edited.')).toBeVisible({ timeout: 120_000 });
    await expect.poll(() => app.evaluate(({ webContents }) => Promise.all(webContents.getAllWebContents()
      .filter((contents) => contents.getURL().startsWith('damocles-design:'))
      .map((contents) => contents.executeJavaScript('document.querySelector("h1")?.textContent ?? ""', true) as Promise<string>))), { timeout: 60_000 }).toEqual(['Edited on the target']);

    // Open in browser: this computer's loopback serves the target's file with the served headers, through no forward and
    // with no new listener on the target.
    const shell = await shellPage(app);
    const forwardsBefore = await forwards(shell, hostId);
    const listenersBefore = await fixture.sh(LISTENERS, 'dev');
    await shell.getByTestId('design-preview-browser').click();
    await expect.poll(opened).toHaveLength(1);
    const [url] = await opened();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/d\/[A-Za-z0-9_-]{43}\/screens\/S1-contacts\.html$/);
    const served = await get(url!);
    expect(served.status).toBe(200);
    expect(served.body).toContain('Edited on the target');
    expect(served.headers['content-security-policy']).toContain("script-src 'none'");
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(await forwards(shell, hostId)).toEqual(forwardsBefore);
    expect(forwardsBefore.some((row) => row.endsWith(` -> ${new URL(url!).port}`))).toBe(false);
    expect(await fixture.sh(LISTENERS, 'dev')).toBe(listenersBefore);

    // Closed, the preview opens again from the target screen's code tab, from the main chat too, through the remote core.
    const previewTab = shell.locator('[data-testid="editor-tab"][data-kind="designPreview"]');
    await previewTab.click({ button: 'right' });
    await menuItem(await readyOverlay(app), 'close').click();
    await expect(previewTab).toHaveCount(0);
    await design.getByTestId('design-header-folder').click();
    await design.locator('[data-testid="design-file"]', { hasText: 'screens/S1-contacts.html' }).click();
    const codeTab = shell.locator('[data-testid="editor-tab"][data-kind="code"]', { hasText: 'S1-contacts.html' });
    await expect(codeTab).toHaveCount(1);
    await selectChatPage(app, parent);
    await codeTab.click({ button: 'right' });
    await menuItem(await readyOverlay(app), 'openPreview').click();
    await expect(previewTab.getByTestId('editor-tab-title')).toHaveText('S1 · Contacts');
    await expect.poll(async () => (await designTabs(app))[0]?.designPreview.status, { timeout: 60_000 }).toBe('ready');

    // The design lives on the target: this computer's home holds no design.
    const localDesigns = path.join(home.damoclesDir, 'designs');
    expect(fs.existsSync(localDesigns) ? fs.readdirSync(localDesigns) : []).toEqual([]);
  } finally {
    await stub.close();
  }
});
