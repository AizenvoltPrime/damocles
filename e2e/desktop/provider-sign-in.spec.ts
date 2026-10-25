import * as fs from 'node:fs';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { createTestPki } from './support/certs';
import { startConnectProxy } from './support/connect-proxy';
import { activeChat, expect, test } from './support/fixtures';
import { closeSettingsModal, openSettingsModal, settingsModal, settingsRow } from './support/settings';
import { chatInput } from './support/ui';

// pi's xAI device flow (pi-ai dist/auth/oauth/xai.js) posts here; the test proxy routes the name to a local TLS stub.
const XAI_AUTH = 'auth.x.ai';
const USER_CODE = 'E2E-CODE-7341';
const VERIFICATION_URI = 'https://accounts.x.ai/device';

/** The xAI device authorization endpoints: a code at once, then "pending" on every poll, so the flow waits on the code. */
async function startXaiAuthStub(cert: string, key: string): Promise<{ readonly port: number; close(): Promise<void> }> {
  const server = https.createServer({ cert, key }, (req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/oauth2/device/code') {
        res.end(JSON.stringify({ device_code: 'e2e-device-code', user_code: USER_CODE, verification_uri: VERIFICATION_URI, expires_in: 600, interval: 30 }));
        return;
      }
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'authorization_pending' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

// The settings overlay has no clipboard permission of its own (security.ts grants it only to panel views), so core copies the code.
test('Copy code and open page in the settings overlay puts the xAI device code on the clipboard and opens the page core holds', async ({ clipboard, home, launch }) => {
  const pki = createTestPki([XAI_AUTH]);
  const caFile = path.join(home.root, 'test-ca.pem');
  fs.writeFileSync(caFile, pki.caCertPem);
  const stub = await startXaiAuthStub(pki.leafCertPem, pki.leafKeyPem);
  const proxy = await startConnectProxy({ [`${XAI_AUTH}:443`]: stub.port });
  try {
    const { app } = await launch({ env: { HTTPS_PROXY: proxy.url, NODE_EXTRA_CA_CERTS: caFile } });
    await expect(chatInput(await activeChat(app))).toBeVisible();
    // Records the page core opens instead of launching the OS browser.
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { openedUrls?: string[] }).openedUrls = opened;
      shell.openExternal = ((url: string) => {
        opened.push(url);
        return Promise.resolve();
      }) as typeof shell.openExternal;
    });
    const openedUrls = () => app.evaluate(() => (globalThis as { openedUrls?: string[] }).openedUrls ?? []);

    const overlay = await openSettingsModal(app, 'accounts');
    await settingsRow(overlay, 'account-xai').getByRole('button', { name: /Add key|Replace key/ }).click();
    const field = settingsModal(overlay).getByTestId('provider-sign-in');
    await field.getByTestId('provider-sign-in-start').click();
    await expect(field.getByTestId('provider-sign-in-code')).toHaveText(USER_CODE);

    await clipboard.writeText(app, 'before the copy');
    await field.getByTestId('provider-sign-in-copy').click();
    await expect(field.getByText('Code copied')).toBeVisible();
    expect(await clipboard.readText(app)).toBe(USER_CODE);
    await expect(field.getByRole('alert')).toHaveCount(0);
    await expect.poll(openedUrls).toEqual([VERIFICATION_URI]);
    expect(proxy.connects).toContain(`${XAI_AUTH}:443`);

    await field.getByTestId('provider-sign-in-cancel').click();
    await expect(field.getByTestId('provider-sign-in-error')).toHaveText('Sign-in cancelled.');
    await closeSettingsModal(overlay);
  } finally {
    await proxy.close();
    await stub.close();
  }
});
