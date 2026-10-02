import { chatTab, expect, test } from './support/fixtures';
import { hermeticEnv, writeUserSettings } from './support/hermetic';
import { SecondProcess } from './support/second-process';
import { chatInput } from './support/ui';

test('a login written by another process updates the desktop account display without a reload', async ({ home, launch }) => {
  // An Anthropic model with no credential: the account chip shows the Claude auth mode, "none".
  writeUserSettings(home, { 'damocles.model': 'claude-sonnet-5-5' });
  const { app } = await launch();
  const tab = await chatTab(app);
  await expect(chatInput(tab)).toBeVisible();
  await expect(tab.getByRole('button', { name: 'none', exact: true })).toBeVisible();
  const loadsBefore = await tab.evaluate(() => performance.getEntriesByType('navigation').length + performance.timeOrigin);

  const other = new SecondProcess('-', hermeticEnv(home), { 'damocles.model': 'claude-sonnet-5-5' });
  try {
    await other.ready;
    // pi's FileAuthStorageBackend.withLock: the same locked read-modify-write pi's /login performs.
    await other.call({ cmd: 'writeAuth', provider: 'anthropic', credential: { type: 'api_key', key: 'sk-ant-e2e-not-a-real-key' } });

    await expect(tab.getByRole('button', { name: 'apikey', exact: true })).toBeVisible();
    await expect(tab.getByRole('button', { name: 'none', exact: true })).toHaveCount(0);
    expect(await tab.evaluate(() => performance.getEntriesByType('navigation').length + performance.timeOrigin)).toBe(loadsBefore);
  } finally {
    await other.dispose();
  }
});
