import * as fs from 'node:fs';
import * as path from 'node:path';
import { mainLog } from './support/app';
import { chatTab, expect, test } from './support/fixtures';
import { OS_KEYRING_ENV } from './support/hermetic';
import { chatInput, hostMessages, postFromWebview, recordHostMessages } from './support/ui';

// Leading words of the notice in src/core/volatile-secrets-notice.ts.
const KEYRING_WARNING = 'Damocles cannot reach your operating system\'s keyring, so the key or sign-in you just saved';

test('with no keyring on Linux, secrets stay in memory and the user is warned once', async ({ home, launch }) => {
  test.skip(process.platform !== 'linux', 'safeStorage has a basic_text backend only on Linux; Windows (DPAPI) and macOS (Keychain) always encrypt.');
  // Chromium's own switch selects the plaintext backend, the state a desktop with no keyring service is in.
  const desktop = await launch({ args: ['--password-store=basic'] });
  const tab = await chatTab(desktop.app);
  await expect(chatInput(tab)).toBeVisible();
  expect(await desktop.app.evaluate(({ safeStorage }) => safeStorage.getSelectedStorageBackend())).toBe('basic_text');
  await expect.poll(() => mainLog(home)).toContain('[secrets] no usable OS encryption; secrets stay in memory for this session');

  await recordHostMessages(tab);
  await postFromWebview(tab, { type: 'setExploreApiKey', apiKey: 'e2e-secret-value' });
  await postFromWebview(tab, { type: 'setExploreApiKey', apiKey: 'e2e-secret-value-2' });
  await expect.poll(async () => (await hostMessages(tab, 'exploreApiKeyUpdate')).at(-1)?.['hasApiKey']).toBe(true);
  await expect.poll(() => desktop.output()).toContain(`[notification:warning] ${KEYRING_WARNING}`);
  expect(desktop.output().split(`[notification:warning] ${KEYRING_WARNING}`).length - 1).toBe(1);
  expect(fs.existsSync(path.join(home.userData, 'secrets.json'))).toBe(false);

  await desktop.close();
  const relaunched = await launch({ args: ['--password-store=basic'] });
  const again = await chatTab(relaunched.app);
  await expect(chatInput(again)).toBeVisible();
  // The handshake reports the explore key; the in-memory value died with the first process.
  await expect.poll(() => relaunched.output()).toContain('[ExploreManager] sendExploreKeyStatus: hasApiKey: false');
});

test('secrets are encrypted at rest and survive a restart', async ({ home, launch }) => {
  const secret = 'e2e-plaintext-must-not-appear';
  const desktop = await launch();
  const tab = await chatTab(desktop.app);
  await expect(chatInput(tab)).toBeVisible();
  const backend = await desktop.app.evaluate(({ safeStorage }) => (process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os'));
  test.skip(backend === 'basic_text', `No keyring is reachable, so safeStorage cannot encrypt; the in-memory path is covered above. Set ${OS_KEYRING_ENV}=1 to use this machine's keyring.`);

  await recordHostMessages(tab);
  await postFromWebview(tab, { type: 'setExploreApiKey', apiKey: secret });
  await expect.poll(async () => (await hostMessages(tab, 'exploreApiKeyUpdate')).at(-1)?.['hasApiKey']).toBe(true);
  const file = path.join(home.userData, 'secrets.json');
  await expect.poll(() => fs.existsSync(file)).toBe(true);
  const atRest = fs.readFileSync(file);
  expect(atRest.includes(secret)).toBe(false);
  expect(atRest.includes(Buffer.from(secret).toString('base64'))).toBe(false);

  await desktop.close();
  const relaunched = await launch();
  const again = await chatTab(relaunched.app);
  await expect(chatInput(again)).toBeVisible();
  await expect.poll(() => relaunched.output()).toContain('[ExploreManager] sendExploreKeyStatus: hasApiKey: true');
});
