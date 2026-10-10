import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROVIDER_SECRET_KEYS } from '../../src/core/pi-session/explore-providers';
import { activeChat, expect, test } from './support/fixtures';
import { askHostPassword, chatInput, hostPromptAnswer, postFromWebview } from './support/ui';
import { openSettingsModal, settingsModal, settingsRow, waitForSettingsState } from './support/settings';

const SECRET = 'sk-or-e2e-7f3a91';
const KEY_PROMPT = 'Enter the e2e API key';
const HOOKS = { env: { DAMOCLES_E2E_HOOKS: '1' } };
const CHATGPT_PASTE_PROMPT = 'Complete login in your browser, or paste the final redirect URL here:';

test('host input box renders in the chat webview, accepts a masked value, and an abort closes it', async ({ home, launch }) => {
  const desktop = await launch(HOOKS);
  const { app } = desktop;
  const tab = await activeChat(app);
  await expect(chatInput(tab)).toBeVisible();

  // Main's DialogService.inputBox, the path every host prompt takes, asking for a masked value.
  await askHostPassword(app, KEY_PROMPT);
  const dialog = tab.getByRole('dialog', { name: KEY_PROMPT });
  await expect(dialog).toBeVisible();
  const input = dialog.getByRole('textbox');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('type', 'password');
  await input.fill(SECRET);
  await input.press('Enter');
  await expect(dialog).toBeHidden();
  expect(await hostPromptAnswer(app)).toBe(SECRET);

  // The ChatGPT sign-in asks for the pasted redirect URL; signing out aborts the flow, which withdraws the prompt.
  await app.evaluate(({ shell: electronShell }) => {
    electronShell.openExternal = () => Promise.resolve();
  });
  await postFromWebview(tab, { type: 'startChatGPTOAuth' });
  const codePrompt = tab.getByRole('dialog');
  await expect(codePrompt).toBeVisible();
  await codePrompt.getByRole('textbox').fill('typed but never sent');
  await postFromWebview(tab, { type: 'signOutChatGPT' });
  await expect(codePrompt).toBeHidden();

  // A sink writes a line on a later turn of main's event loop, so the logs are read once the app has quit.
  await desktop.close();
  const logs = path.join(home.userData, 'logs');
  for (const file of fs.readdirSync(logs)) {
    expect(fs.readFileSync(path.join(logs, file), 'utf8')).not.toContain(SECRET);
  }
});

test('with the settings modal open, a host prompt renders in it, takes a masked key that is stored as a secret, and the key reaches no log', async ({ home, launch }) => {
  const desktop = await launch(HOOKS);
  const { app } = desktop;
  const tab = await activeChat(app);
  await expect(chatInput(tab)).toBeVisible();
  const overlay = await openSettingsModal(app, 'accounts');
  await waitForSettingsState(overlay);

  // The modal is attached to the selected chat, so the chat's host prompt is redirected into it. The answer is stored as the
  // OpenRouter key, which core reads back to pick the memory judge.
  await askHostPassword(app, KEY_PROMPT, PROVIDER_SECRET_KEYS.openrouter);
  const dialog = overlay.getByRole('dialog', { name: KEY_PROMPT });
  await expect(dialog).toBeVisible();
  await expect(tab.getByRole('dialog', { name: KEY_PROMPT })).toHaveCount(0);
  const input = dialog.getByRole('textbox');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('type', 'password');
  await input.fill(SECRET);
  await input.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(settingsModal(overlay)).toBeVisible();
  expect(await hostPromptAnswer(app)).toBe(SECRET);
  await settingsRow(overlay, 'account-typesafe').getByRole('button', { name: /Add key|Replace key/ }).click();
  await expect(overlay.getByTestId('memory-judge')).toHaveText('Memory judge: Jev (OpenRouter)');

  // A sink writes a line on a later turn of main's event loop, so the logs are read once the app has quit.
  await desktop.close();
  const logs = path.join(home.userData, 'logs');
  for (const file of fs.readdirSync(logs)) {
    expect(fs.readFileSync(path.join(logs, file), 'utf8'), file).not.toContain(SECRET);
  }
  expect(desktop.output()).not.toContain(SECRET);
});

test('a host prompt raised from the modal\'s ChatGPT sign-in takes clicks, typing and Escape, and the modal stays open', async ({ launch }) => {
  const { app } = await launch();
  const tab = await activeChat(app);
  await expect(chatInput(tab)).toBeVisible();
  await app.evaluate(({ shell: electronShell }) => {
    electronShell.openExternal = () => Promise.resolve();
  });

  const overlay = await openSettingsModal(app, 'accounts');
  const modal = settingsModal(overlay);
  // The OpenAI row expands into its sign-in panel.
  await settingsRow(overlay, 'account-openai').getByRole('button').first().click();
  const signIn = modal.getByRole('button', { name: 'Sign in with ChatGPT' });
  await signIn.click();

  // The ChatGPT sign-in asks for the pasted redirect URL inside the modal, over it.
  const input = overlay.getByRole('textbox', { name: CHATGPT_PASTE_PROMPT });
  const prompt = overlay.getByRole('dialog').filter({ has: input });
  await expect(prompt).toBeVisible();
  await expect(input).toBeFocused();
  await overlay.keyboard.type('typed');
  await input.click();
  await overlay.keyboard.press('End');
  await overlay.keyboard.type(' then clicked');
  await expect(input).toHaveValue('typed then clicked');
  await expect(input).toBeFocused();

  await overlay.keyboard.press('Escape');
  await expect(prompt).toBeHidden();
  await expect(modal).toBeVisible();

  // A second prompt is answered with a click on its own button.
  await expect(signIn).toBeEnabled();
  await signIn.click();
  await expect(prompt).toBeVisible();
  await input.fill('not a redirect url');
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect(modal).toBeVisible();
});
