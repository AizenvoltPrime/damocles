import type { ElectronApplication } from '@playwright/test';
import { chatTab, expect, nextTab, panelIdOf, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { pressKeys, PRIMARY, shellState } from './support/shell';
import { chatInput, hostMessages, recordHostMessages } from './support/ui';

async function selectedTab(app: ElectronApplication): Promise<string | undefined> {
  return (await shellState(app)).selectedTabId;
}

async function menuItemEnabled(app: ElectronApplication, id: string): Promise<boolean> {
  return app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.enabled ?? false, id);
}

test('menu accelerators: the three contributed keybindings and the tab shortcuts work from a chat tab', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const first = await chatTab(app);
    await expect(chatInput(first)).toBeVisible();
    const firstId = panelIdOf(first);

    // Open Chat: Ctrl+Shift+U (Cmd+Shift+U on macOS) opens a new chat tab.
    const opened = nextTab(app, [first]);
    await pressKeys(app, `/panel/${firstId}/`, 'U', [PRIMARY, 'shift']);
    const second = await opened;
    await expect(chatInput(second)).toBeVisible();
    const secondId = panelIdOf(second);
    await expect.poll(() => selectedTab(app)).toBe(secondId);

    // Next and previous tab, with both key pairs.
    await pressKeys(app, `/panel/${secondId}/`, 'Tab', ['control']);
    await expect.poll(() => selectedTab(app)).toBe(firstId);
    await pressKeys(app, `/panel/${firstId}/`, 'Tab', ['control', 'shift']);
    await expect.poll(() => selectedTab(app)).toBe(secondId);
    await pressKeys(app, `/panel/${secondId}/`, 'PageDown', [PRIMARY]);
    await expect.poll(() => selectedTab(app)).toBe(firstId);
    await pressKeys(app, `/panel/${firstId}/`, 'PageUp', [PRIMARY]);
    await expect.poll(() => selectedTab(app)).toBe(secondId);

    // Prompt navigator: Ctrl+K (Cmd+K) reaches the active chat tab through the same message VS Code's command posts.
    await recordHostMessages(second);
    await pressKeys(app, `/panel/${secondId}/`, 'K', [PRIMARY]);
    await expect.poll(async () => (await hostMessages(second, 'togglePromptNavigator')).length).toBe(1);

    // Browser DevTools (F12) is bound only while the chat's pane shows a page, and the pane toggle only with the browser feature on.
    expect(await menuItemEnabled(app, 'damocles.togglePromptNavigator')).toBe(true);
    expect(await menuItemEnabled(app, 'damocles.browser.toggleDevTools')).toBe(false);
    expect(await menuItemEnabled(app, 'damocles.browser.togglePane')).toBe(false);

    // New tab and close tab.
    const third = nextTab(app, [first, second]);
    await pressKeys(app, `/panel/${secondId}/`, 'T', [PRIMARY]);
    const thirdId = panelIdOf(await third);
    await expect.poll(async () => (await shellState(app)).tabs.map((t) => t.id)).toEqual([firstId, secondId, thirdId]);
    await pressKeys(app, `/panel/${thirdId}/`, 'W', [PRIMARY]);
    await expect.poll(async () => (await shellState(app)).tabs.map((t) => t.id)).toEqual([firstId, secondId]);
  } finally {
    await stub.close();
  }
});

test('copy, paste and select all work in the chat input through the platform shortcuts', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await chatTab(app);
    const input = chatInput(tab);
    await expect(input).toBeVisible();
    const page = `/panel/${panelIdOf(tab)}/`;
    await app.evaluate(({ clipboard }) => clipboard.writeText(''));

    await input.fill('copy me across');
    await input.focus();
    await pressKeys(app, page, 'A', [PRIMARY]);
    await expect.poll(() => tab.evaluate(() => {
      const el = document.activeElement as HTMLTextAreaElement | null;
      return el ? el.value.slice(el.selectionStart, el.selectionEnd) : '';
    })).toBe('copy me across');
    await pressKeys(app, page, 'C', [PRIMARY]);
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('copy me across');

    await input.fill('');
    await input.focus();
    await pressKeys(app, page, 'V', [PRIMARY]);
    await expect(input).toHaveValue('copy me across');
  } finally {
    await stub.close();
  }
});
