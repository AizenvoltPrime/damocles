import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { chatTab, expect, nextTab, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { chatRequests, startOpenAIStub } from './support/openai-stub';
import { chatInput, clickMenu } from './support/ui';

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
  const tab = await chatTab(app);
  await expect(chatInput(tab)).toBeVisible();
  await expect.poll(() => webviewCapabilities(tab)).toMatchObject({ hostSettingsEditor: false, diffReview: true, settingsSources: true, monaco: true });

  const onMac = process.platform === 'darwin';
  await expect(micButton(tab)).toHaveCount(onMac ? 0 : 1);

  // The desktop voice capability reads process.platform at each handshake, so a new tab sees the mocked value.
  const realPlatform = await app.evaluate(() => {
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    return real;
  });
  try {
    const opened = nextTab(app, [tab]);
    await clickMenu(app, 'damocles.newTab');
    const macTab = await opened;
    await expect(chatInput(macTab)).toBeVisible();
    await expect.poll(() => webviewCapabilities(macTab)).toMatchObject({ voice: false, hostSpeechExtensions: false });
    await expect(micButton(macTab)).toHaveCount(0);

    await macTab.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(macTab.getByText('Language', { exact: true })).toBeVisible();
    await expect(macTab.getByText('Voice Input', { exact: true })).toHaveCount(0);
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
    const tab = await chatTab(app);
    await expect(chatInput(tab)).toBeVisible();
    const prompt = tab.getByRole('region', { name: 'Permission request' });

    stub.replies.push({ chunks: [], toolCalls: [{ name: 'write', arguments: { path: approved, content: 'approved by the user' } }] });
    await chatInput(tab).fill('write the approved file');
    await chatInput(tab).press('Enter');
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText(approved);
    await expect(tab.getByTestId('editor-overlay')).toHaveAttribute('data-purpose', 'proposal');
    // The overlay's approve is the prompt's own action.
    await tab.getByTestId('editor-approve').click();
    await expect(prompt).toBeHidden();
    await expect(tab.getByTestId('editor-overlay')).toBeHidden();
    await expect.poll(() => fs.existsSync(approved)).toBe(true);
    expect(fs.readFileSync(approved, 'utf8')).toBe('approved by the user');
    // The session title request follows the first turn; queuing the next tool call before it lands would hand it the title call.
    await expect.poll(() => chatRequests(stub).some((r) => JSON.stringify(r.body).includes('descriptive title'))).toBe(true);

    stub.replies.push({ chunks: [], toolCalls: [{ name: 'write', arguments: { path: denied, content: 'never written' } }] });
    await chatInput(tab).fill('write the denied file');
    await chatInput(tab).press('Enter');
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText(denied);
    await tab.getByTestId('editor-overlay-close').click();
    await expect(tab.getByTestId('editor-overlay')).toBeHidden();
    await prompt.getByRole('option', { name: /No$/ }).first().click();
    await expect(prompt).toBeHidden();
    expect(fs.existsSync(denied)).toBe(false);
    expect(fs.existsSync(approved)).toBe(true);
  } finally {
    await stub.close();
  }
});
