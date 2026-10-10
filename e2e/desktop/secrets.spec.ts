import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { logBeforeQuit, mainLog, quitLog } from './support/app';
import { activeChat, expect, test } from './support/fixtures';
import { OS_KEYRING_ENV } from './support/hermetic';
import { closeSettingsModal, openSettingsModal, settingsRow, waitForSettingsState } from './support/settings';
import { chatInput } from './support/ui';

// Leading words of the notice in src/core/volatile-secrets-notice.ts.
const KEYRING_WARNING = 'Damocles cannot reach your operating system\'s keyring, so the key or sign-in you just saved';

/** Saves the DeepSeek key through the settings modal, as a user does, and waits for the host's answer to this save. */
async function saveDeepseekKey(app: ElectronApplication, key: string): Promise<void> {
  const overlay = await openSettingsModal(app, 'accounts');
  const row = settingsRow(overlay, 'account-deepseek');
  await row.getByRole('button', { name: /Add key|Replace key/ }).click();
  const input = row.getByLabel('API Key', { exact: true });
  await expect(input).toHaveAttribute('type', 'password');
  await input.fill(key);
  await input.press('Enter');
  // The panel clears the field and says so only on the host's ok for this request; the modal mounts afresh for each save.
  await expect(input).toHaveValue('');
  await expect(row.getByRole('status').filter({ hasText: 'API key saved' })).toBeVisible();
  await expect(row.getByRole('status').first()).toHaveText('Key saved');
  await closeSettingsModal(overlay);
}

/** The settings modal's DeepSeek row status once core has answered, since the reset modal already reads "Not set up". */
async function expectDeepseekStatus(app: ElectronApplication, status: string): Promise<void> {
  const overlay = await openSettingsModal(app, 'accounts');
  await waitForSettingsState(overlay);
  await expect(settingsRow(overlay, 'account-deepseek').getByRole('status').first()).toHaveText(status);
  await closeSettingsModal(overlay);
}

test('with no keyring on Linux, secrets stay in memory and the user is warned once', async ({ home, launch }) => {
  test.skip(process.platform !== 'linux', 'safeStorage has a basic_text backend only on Linux; Windows (DPAPI) and macOS (Keychain) always encrypt.');
  // Chromium's own switch selects the plaintext backend, the state a desktop with no keyring service is in.
  const desktop = await launch({ args: ['--password-store=basic'] });
  const tab = await activeChat(desktop.app);
  await expect(chatInput(tab)).toBeVisible();
  expect(await desktop.app.evaluate(({ safeStorage }) => safeStorage.getSelectedStorageBackend())).toBe('basic_text');
  await expect.poll(() => mainLog(home)).toContain('[secrets] no usable OS encryption; secrets stay in memory for this session');

  await saveDeepseekKey(desktop.app, 'e2e-secret-value');
  await saveDeepseekKey(desktop.app, 'e2e-secret-value-2');
  await expect.poll(() => desktop.output()).toContain(`[notification:warning] ${KEYRING_WARNING}`);
  expect(fs.existsSync(path.join(home.userData, 'secrets.json'))).toBe(false);

  await desktop.close();
  expect(logBeforeQuit(home).split(`[notification:warning] ${KEYRING_WARNING}`).length - 1).toBe(1);
  for (const key of ['e2e-secret-value', 'e2e-secret-value-2']) {
    expect(desktop.output()).not.toContain(key);
    expect(quitLog(home)).not.toContain(key);
  }
  const relaunched = await launch({ args: ['--password-store=basic'] });
  const again = await activeChat(relaunched.app);
  await expect(chatInput(again)).toBeVisible();
  // The in-memory value died with the first process.
  await expectDeepseekStatus(relaunched.app, 'Not set up');
});

test('secrets are encrypted at rest and survive a restart', async ({ home, launch }) => {
  const secret = 'e2e-plaintext-must-not-appear';
  const desktop = await launch();
  const tab = await activeChat(desktop.app);
  await expect(chatInput(tab)).toBeVisible();
  const backend = await desktop.app.evaluate(({ safeStorage }) => (process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os'));
  test.skip(backend === 'basic_text', `No keyring is reachable, so safeStorage cannot encrypt; the in-memory path is covered above. Set ${OS_KEYRING_ENV}=1 to use this machine's keyring.`);

  await saveDeepseekKey(desktop.app, secret);
  const file = path.join(home.userData, 'secrets.json');
  await expect.poll(() => fs.existsSync(file)).toBe(true);
  const atRest = fs.readFileSync(file);
  expect(atRest.includes(secret)).toBe(false);
  expect(atRest.includes(Buffer.from(secret).toString('base64'))).toBe(false);

  await desktop.close();
  expect(desktop.output()).not.toContain(secret);
  expect(quitLog(home)).not.toContain(secret);
  const relaunched = await launch();
  const again = await activeChat(relaunched.app);
  await expect(chatInput(again)).toBeVisible();
  await expectDeepseekStatus(relaunched.app, 'Key saved');
});
