import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { chatRequests, startOpenAIStub } from './support/openai-stub';
import { chatInput, clickMenu } from './support/ui';
import { openSettingsModal, settingsNav } from './support/settings';

// The capabilities the tab's webview received in the handshake, read from its Pinia settings store.
function webviewCapabilities(tab: Page): Promise<Record<string, boolean>> {
  return tab.evaluate(() => {
    const app = (document.getElementById('app') as unknown as { __vue_app__: { config: { globalProperties: { $pinia: { state: { value: { settings: { hostCapabilities: Record<string, boolean> } } } } } } } }).__vue_app__;
    return { ...app.config.globalProperties.$pinia.state.value.settings.hostCapabilities };
  });
}

const micButton = (tab: Page) => tab.getByRole('button', { name: 'Set an API key in Settings to use voice input' });

test('voice controls are absent when the host reports macOS', async ({ launch }) => {
  const { app } = await launch();
  const tab = await activeChat(app);
  await expect(chatInput(tab)).toBeVisible();
  await expect.poll(() => webviewCapabilities(tab)).toMatchObject({ hostSettingsEditor: false, diffReview: true, settingsSources: true, monaco: true, damoclesTheme: true, historyInPanel: false, folderPickerInPanel: false });

  const onMac = process.platform === 'darwin';
  await expect(micButton(tab)).toHaveCount(onMac ? 0 : 1);

  // The desktop voice capability reads process.platform at each handshake, so a new tab sees the mocked value.
  const realPlatform = await app.evaluate(() => {
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    return real;
  });
  try {
    const opened = nextChat(app, [tab]);
    await clickMenu(app, 'damocles.newChat');
    const macTab = await opened;
    await expect(chatInput(macTab)).toBeVisible();
    await expect.poll(() => webviewCapabilities(macTab)).toMatchObject({ voice: false, hostSpeechExtensions: false });
    await expect(micButton(macTab)).toHaveCount(0);

    const overlay = await openSettingsModal(app);
    await expect(settingsNav(overlay, 'application')).toBeVisible();
    await expect(settingsNav(overlay, 'voice')).toHaveCount(0);
  } finally {
    await app.evaluate((_electron, real) => {
      Object.defineProperty(process, 'platform', { value: real, configurable: true });
    }, realPlatform);
  }
});

test('permission prompts approve and deny a write from the model, with the proposal shown in the Monaco diff overlay', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const approved = path.join(home.home, 'approved.txt');
    const denied = path.join(home.home, 'denied.txt');
    const { app } = await launch();
    const tab = await activeChat(app);
    await expect(chatInput(tab)).toBeVisible();
    const prompt = tab.getByRole('region', { name: 'Permission request' });

    stub.replies.push({ chunks: [], toolCalls: [{ name: 'write', arguments: { path: approved, content: 'approved by the user' } }] });
    await chatInput(tab).fill('write the approved file');
    await chatInput(tab).press('Enter');
    await expect(prompt).toBeVisible();
    // The card names the file relative to the chat's folder and keeps the full path as the subtitle's title.
    await expect(prompt.getByTestId('permission-subtitle')).toContainText(path.basename(approved));
    await expect(prompt.getByTestId('permission-subtitle')).toHaveAttribute('title', `${approved} · 1 line`);
    await prompt.getByRole('button', { name: 'Open diff' }).click();
    await expect(tab.getByTestId('editor-overlay')).toHaveAttribute('data-purpose', 'proposal');
    // The overlay's approve is the prompt's own action.
    await tab.getByTestId('editor-approve').click();
    await expect(prompt).toBeHidden();
    await expect(tab.getByTestId('editor-overlay')).toBeHidden();
    // The write may land after the file appears, so the content is what is polled.
    await expect.poll(() => (fs.existsSync(approved) ? fs.readFileSync(approved, 'utf8') : null)).toBe('approved by the user');
    // The title request goes out once the first turn has ended, so the next scripted reply goes to the next turn.
    await expect.poll(() => chatRequests(stub).some((r) => JSON.stringify(r.body).includes('descriptive title'))).toBe(true);

    stub.replies.push({ chunks: [], toolCalls: [{ name: 'write', arguments: { path: denied, content: 'never written' } }] });
    await chatInput(tab).fill('write the denied file');
    await chatInput(tab).press('Enter');
    await expect(prompt).toBeVisible();
    await expect(prompt.getByTestId('permission-subtitle')).toHaveAttribute('title', `${denied} · 1 line`);
    await expect(tab.getByTestId('editor-overlay')).toBeHidden();
    await prompt.getByRole('option', { name: /No$/ }).first().click();
    await expect(prompt).toBeHidden();
    expect(fs.existsSync(denied)).toBe(false);
    expect(fs.existsSync(approved)).toBe(true);
  } finally {
    await stub.close();
  }
});
