import { activeChat, expect, test } from './support/fixtures';
import { hermeticEnv, writeUserSettings } from './support/hermetic';
import { SecondProcess } from './support/second-process';
import { chatInput } from './support/ui';
import { openSettingsModal, settingsRow } from './support/settings';

test('a login written by another process updates the billing the chat shows and the open settings modal without a reload', async ({ home, launch }) => {
  // An Anthropic model with no credential bills nothing, so the composer shows its cost as an estimate.
  writeUserSettings(home, { 'damocles.model': 'claude-sonnet-5-5' });
  const { app } = await launch();
  const tab = await activeChat(app);
  await expect(chatInput(tab)).toBeVisible();
  const cost = tab.getByTestId('composer-cost');
  await expect(cost).toHaveText('~$0.00 est.');
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
    await expect(cost).toHaveText('$0.00');
    expect(await tab.evaluate(() => performance.getEntriesByType('navigation').length + performance.timeOrigin)).toBe(loadsBefore);
  } finally {
    await other.dispose();
  }
});

for (const [provider, secret] of [
  ['deepseek', 'sk-e2e-deepseek-not-real'],
  ['minimax', 'sk-cp-e2e-minimax-not-real'],
  ['xai', 'xai-e2e-not-real'],
] as const) {
  test(`a ${provider} API key entered in the modal reaches the account without ever showing in the page`, async ({ launch }) => {
    const { app } = await launch();
    await expect(chatInput(await activeChat(app))).toBeVisible();
    const overlay = await openSettingsModal(app, 'accounts');
    const account = settingsRow(overlay, `account-${provider}`);
    await account.getByRole('button', { name: /Add key/ }).click();
    const key = account.getByLabel('API key', { exact: false }).first();
    await expect(key).toHaveAttribute('type', 'password');
    await key.fill(secret);
    await key.press('Enter');
    await expect(account.getByRole('status').first()).toHaveText('Key saved');
    await expect(key).toHaveValue('');
    expect(await overlay.content()).not.toContain(secret);
  });
}
