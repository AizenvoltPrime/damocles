import { activeChat, expect, test } from './support/fixtures';
import { seedSubscriptionPlugin } from './support/hermetic';
import { chatInput } from './support/ui';
import { closeSettingsModal, openSettingsModal, settingsModal, settingsRow } from './support/settings';

test('Claude sign-in starts from its button and waits inline, with paste and cancel, across a modal reopen', async ({ home, launch }) => {
  // Installed as a download leaves it, so signing in fetches nothing; every launch's git is kept off GitHub (hermeticEnv).
  seedSubscriptionPlugin(home);
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  // Records the authorize URL in main instead of launching the OS browser.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { openedUrls?: string[] }).openedUrls = opened;
    shell.openExternal = ((url: string) => {
      opened.push(url);
      return Promise.resolve();
    }) as typeof shell.openExternal;
  });
  const openedUrls = () => app.evaluate(() => (globalThis as { openedUrls?: string[] }).openedUrls ?? []);

  let overlay = await openSettingsModal(app, 'accounts');
  await settingsRow(overlay, 'account-anthropic').getByRole('button', { name: /Sign in/ }).click();
  const panel = () => settingsModal(overlay).getByTestId('claude-auth-panel');
  const signIn = () => panel().getByRole('button', { name: 'Sign in with Claude' });
  const waiting = () => panel().getByTestId('claude-sign-in-waiting');

  // Signed out, the preselected mode signs in from the button; the browser opens and nothing modal asks for a paste.
  await signIn().click();
  await expect(waiting()).toBeVisible();
  await expect.poll(openedUrls).toHaveLength(1);
  expect(new URL((await openedUrls())[0]!).hostname).toBe('claude.ai');
  await expect(overlay.getByRole('dialog').filter({ has: overlay.getByRole('textbox') })).toHaveCount(0);

  // The settings view reopened mid-sign-in shows the same wait.
  await closeSettingsModal(overlay);
  overlay = await openSettingsModal(app, 'accounts');
  await settingsRow(overlay, 'account-anthropic').getByRole('button').first().click();
  await expect(waiting()).toBeVisible();

  // A pasted URL reaches pi: one from another sign-in fails its state check and is reported.
  await waiting().getByRole('button', { name: 'Paste link instead' }).click();
  const field = waiting().getByRole('textbox', { name: 'Redirect URL or code' });
  await expect(field).toBeFocused();
  await field.fill('http://localhost:53692/callback?code=e2e-code&state=not-this-sign-in');
  await field.press('Enter');
  await expect(panel().getByRole('alert')).toHaveText('OAuth state mismatch');
  await expect(waiting()).toBeHidden();

  // Cancel ends the next sign-in with no error and offers the button again.
  await signIn().click();
  await expect(waiting()).toBeVisible();
  await waiting().getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(waiting()).toBeHidden();
  await expect(signIn()).toBeEnabled();
  await expect(panel().getByRole('alert')).toHaveCount(0);
});
