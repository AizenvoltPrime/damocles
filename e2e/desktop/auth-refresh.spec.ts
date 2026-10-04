import { activeChat, expect, test } from './support/fixtures';
import { hermeticEnv, writeUserSettings } from './support/hermetic';
import { SecondProcess } from './support/second-process';
import { chatInput } from './support/ui';
import { openSettingsModal, settingsRow } from './support/settings';
import { shellPage } from './support/shell';

test('a login written by another process updates the account display and the open settings modal without a reload', async ({ home, launch }) => {
  // An Anthropic model with no credential: the chat header shows no billing chip.
  writeUserSettings(home, { 'damocles.model': 'claude-sonnet-5-5' });
  const { app } = await launch();
  const tab = await activeChat(app);
  await expect(chatInput(tab)).toBeVisible();
  // The header shows the chip only at 720px and wider. With the sidebar hidden the chat fills the window, which is never
  // narrower than 900px, whatever the runner's display.
  const shell = await shellPage(app);
  await shell.getByTestId('toggle-sidebar').click();
  await expect(shell.getByTestId('toggle-sidebar')).toHaveAttribute('aria-pressed', 'false');
  await expect(tab.getByTestId('chat-header')).toHaveAttribute('data-width', 'wide');
  const accountChip = tab.getByTestId('account-chip');
  await expect(accountChip).toHaveCount(0);
  const loadsBefore = await tab.evaluate(() => performance.getEntriesByType('navigation').length + performance.timeOrigin);

  const overlay = await openSettingsModal(app, 'accounts');
  const anthropic = settingsRow(overlay, 'account-anthropic');
  await expect(anthropic.getByRole('status')).toHaveText('Not set up');
  await expect(anthropic.getByRole('button', { name: /Sign in/ })).toBeVisible();

  const other = new SecondProcess('-', hermeticEnv(home), { 'damocles.model': 'claude-sonnet-5-5' });
  try {
    await other.ready;
    // pi's FileAuthStorageBackend.withLock: the same locked read-modify-write pi's /login performs.
    await other.call({ cmd: 'writeAuth', provider: 'anthropic', credential: { type: 'api_key', key: 'sk-ant-e2e-not-a-real-key' } });

    await expect(anthropic.getByRole('status')).toHaveText('API key');
    await expect(anthropic.getByRole('button', { name: /Manage/ })).toBeVisible();
    await expect(accountChip).toHaveText('API key');
    await expect(accountChip).toHaveAttribute('title', 'Billed through: API key');
    expect(await tab.evaluate(() => performance.getEntriesByType('navigation').length + performance.timeOrigin)).toBe(loadsBefore);
  } finally {
    await other.dispose();
  }
});

test('an API key entered in the modal reaches the account without ever showing in the page', async ({ launch }) => {
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  const overlay = await openSettingsModal(app, 'accounts');
  const deepseek = settingsRow(overlay, 'account-deepseek');
  await deepseek.getByRole('button', { name: /Add key/ }).click();
  const key = deepseek.getByLabel('API key', { exact: false }).first();
  await expect(key).toHaveAttribute('type', 'password');
  await key.fill('sk-e2e-deepseek-not-real');
  await key.press('Enter');
  await expect(deepseek.getByRole('status').first()).toHaveText('Key saved');
  await expect(key).toHaveValue('');
  expect(await overlay.content()).not.toContain('sk-e2e-deepseek-not-real');
});
