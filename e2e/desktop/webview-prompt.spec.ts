import * as fs from 'node:fs';
import * as path from 'node:path';
import { chatTab, expect, test } from './support/fixtures';
import { chatInput, clickMenu, postFromWebview } from './support/ui';
import { shellPage } from './support/shell';

const SECRET = 'sk-or-e2e-7f3a91';
const CHATGPT_PASTE_PROMPT = 'Complete login in your browser, or paste the final redirect URL here:';

test('host input box renders in the chat webview, accepts a masked value, and an abort closes it', async ({ home, launch }) => {
  const { app } = await launch();
  const tab = await chatTab(app);
  await expect(chatInput(tab)).toBeVisible();
  const shell = await shellPage(app);

  // Set Explore API Key is a real DialogService.inputBox caller with a password prompt.
  await clickMenu(app, 'damocles.setExploreApiKey');
  const dialog = tab.getByRole('dialog', { name: 'Enter your OpenRouter API key for Explore agents' });
  await expect(dialog).toBeVisible();
  const input = dialog.getByRole('textbox');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('type', 'password');
  await input.fill(SECRET);
  await input.press('Enter');
  await expect(dialog).toBeHidden();
  const toast = shell.getByRole('region', { name: 'Notifications' }).getByText('Damocles: OpenRouter API key saved');
  await expect(toast).toBeVisible();

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

  const logs = path.join(home.userData, 'logs');
  for (const file of fs.readdirSync(logs)) {
    expect(fs.readFileSync(path.join(logs, file), 'utf8')).not.toContain(SECRET);
  }
});

test('a host prompt raised from the open Settings sheet takes clicks, typing and Escape, and the sheet stays open', async ({ launch }) => {
  const { app } = await launch();
  const tab = await chatTab(app);
  await expect(chatInput(tab)).toBeVisible();
  await app.evaluate(({ shell: electronShell }) => {
    electronShell.openExternal = () => Promise.resolve();
  });

  await tab.getByRole('button', { name: 'Settings', exact: true }).click();
  const sheet = tab.getByRole('dialog', { name: 'Settings' });
  const signIn = sheet.getByRole('button', { name: 'Sign in with ChatGPT' });
  await signIn.click();

  // The ChatGPT sign-in asks for the pasted redirect URL over the sheet.
  const input = tab.getByRole('textbox', { name: CHATGPT_PASTE_PROMPT });
  const prompt = tab.getByRole('dialog').filter({ has: input });
  await expect(prompt).toBeVisible();
  await expect(input).toBeFocused();
  await tab.keyboard.type('typed');
  await input.click();
  await tab.keyboard.press('End');
  await tab.keyboard.type(' then clicked');
  await expect(input).toHaveValue('typed then clicked');
  await expect(input).toBeFocused();

  await tab.keyboard.press('Escape');
  await expect(prompt).toBeHidden();
  await expect(sheet).toBeVisible();

  // A second prompt is answered with a click on its own button.
  await expect(signIn).toBeEnabled();
  await signIn.click();
  await expect(prompt).toBeVisible();
  await input.fill('not a redirect url');
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect(sheet).toBeVisible();
});
