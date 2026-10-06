import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { OVERLAY_ACK_TIMEOUT_MS, OVERLAY_CHANNELS } from '../../src/desktop/preload/overlay-channels';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { overlayViewState, readyOverlay } from './support/overlay';
import { settingsRow, openSettingsModal, settingsModal } from './support/settings';
import { OVERLAY_URL, shellState } from './support/shell';
import { projectKeyOf, projectRow, readyShell } from './support/shell-ui';
import { addProject, answerMessageBoxes, answerOpenDialog, askedDialogs, chatInput, clickMenu, messageBoxes, sendAndAwaitEcho, setThemeSource, TRUST_PROMPT } from './support/ui';

const SWITCH_PROMPT = 'Switch this panel to beta?';

// Every question must render in the overlay; a native box while the overlay is healthy is a failure, so main records any.
async function forbidNativeBoxes(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __e2eNativeBoxes?: string[] };
    g.__e2eNativeBoxes = [];
    dialog.showMessageBox = ((...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as { message: string };
      g.__e2eNativeBoxes!.push(options.message);
      return Promise.reject(new Error('dialog.showMessageBox called while the overlay is healthy'));
    }) as typeof dialog.showMessageBox;
  });
}

async function nativeBoxes(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { __e2eNativeBoxes?: string[] }).__e2eNativeBoxes ?? []);
}

async function addProjectFromMenu(app: ElectronApplication, dir: string): Promise<void> {
  await answerOpenDialog(app, dir);
  await clickMenu(app, 'damocles.addProject');
}

const dialogIn = (overlay: Page) => overlay.getByRole('alertdialog');

// Whether the overlay still lies over the whole window, as it does while a popup is open.
async function overlayCoversWindow(app: ElectronApplication): Promise<boolean> {
  const view = await overlayViewState(app);
  return view.visible && view.bounds.width === view.content.width && view.bounds.height === view.content.height;
}

test('every question renders as the overlay dialog: the trust question and a folder switch over the settings modal, in Dark and Light, never the OS box', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const beta = path.join(path.dirname(home.project), 'beta');
    fs.mkdirSync(beta, { recursive: true });
    const { app } = await launch();
    const first = await activeChat(app);
    await expect(chatInput(first)).toBeVisible();
    await forbidNativeBoxes(app);
    const overlay = await readyOverlay(app);

    // The trust question: Don't Trust is Cancel and focused first, so neither Enter nor Escape grants trust.
    await addProjectFromMenu(app, home.project);
    const trust = dialogIn(overlay);
    await expect(trust).toBeVisible();
    await expect(trust).toHaveAttribute('aria-modal', 'true');
    await expect(trust.getByRole('heading')).toHaveText(`${TRUST_PROMPT} ${home.project}?`);
    await expect(trust).toContainText('Trusting this folder does not trust its subfolders.');
    await expect(trust.getByRole('button', { name: 'Don\'t Trust' })).toBeFocused();
    await overlay.keyboard.press('Escape');
    await expect(trust).toHaveCount(0);
    await expect.poll(async () => (await shellState(app)).projects.find((p) => p.fsPath === home.project)?.trusted).toBe(false);
    // The overlay answers once the exit has played; main then takes it off the window, and only then can the sidebar be clicked.
    await expect.poll(() => overlayCoversWindow(app)).toBe(false);

    // Asked again from the Untrusted badge; Trust Folder grants it.
    const shell = await readyShell(app);
    const alphaKey = await projectKeyOf(app, 'alpha');
    await projectRow(shell, alphaKey).getByTestId('untrusted-badge').click();
    await expect(trust).toBeVisible();
    await trust.getByRole('button', { name: 'Trust Folder' }).click();
    await expect.poll(async () => (await shellState(app)).projects.find((p) => p.key === alphaKey)?.trusted).toBe(true);

    // A folder switch, asked from the settings modal, stacks above it.
    const alphaChat = await activeChat(app);
    await sendAndAwaitEcho(alphaChat, 'work in alpha');
    const betaOpened = nextChat(app, app.windows());
    await addProjectFromMenu(app, beta);
    await trust.getByRole('button', { name: 'Trust Folder' }).click();
    await expect(chatInput(await betaOpened)).toBeVisible();
    await shell.evaluate(async (key) => window.damoclesShell!.selectProject(key), alphaKey);
    await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(alphaKey);
    const alphaChatId = (await shellState(app)).selected.chatId;

    for (const theme of ['dark', 'light'] as const) {
      await expect.poll(() => overlayCoversWindow(app)).toBe(false);
      await setThemeSource(app, theme);
      await expect(overlay.locator('body')).toHaveClass(new RegExp(`vscode-${theme}`));
      const modal = await openSettingsModal(app, 'chat');
      const folder = settingsRow(modal, 'workspace-folder').getByRole('combobox');
      await folder.click();
      await modal.getByRole('option', { name: /^beta/ }).click();
      const question = dialogIn(modal);
      await expect(question).toBeVisible();
      await expect(question.getByRole('heading')).toContainText(SWITCH_PROMPT);
      await expect(settingsModal(modal)).toBeVisible();
      // The dialog paints above the modal: the point at its centre belongs to the dialog.
      expect(await question.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      })).toBe(true);
      await expect(question.getByRole('button', { name: 'Start new conversation' })).toBeFocused();
      if (theme === 'dark') {
        // Cancel keeps the chat where it was, and focus returns to the row's control.
        await modal.keyboard.press('Escape');
        await expect(question).toHaveCount(0);
        await expect(settingsModal(modal)).toBeVisible();
        await expect(folder).toBeFocused();
        expect((await shellState(app)).selected.projectKey).toBe(alphaKey);
        await modal.keyboard.press('Escape');
        await expect(settingsModal(modal)).toHaveCount(0);
      } else {
        // Enter activates the focused action: the chat starts over in beta.
        await modal.keyboard.press('Enter');
        await expect(question).toHaveCount(0);
        await expect.poll(async () => (await shellState(app)).selected.projectKey).not.toBe(alphaKey);
        await modal.keyboard.press('Escape');
      }
    }
    expect((await shellState(app)).selected.chatId).not.toBe(alphaChatId);
    expect(await nativeBoxes(app)).toEqual([]);
  } finally {
    await stub.close();
  }
});

test('with the overlay crashed, the question falls back to the OS message box and its answer still reaches the caller', async ({ home, launch }) => {
  const desktop = await launch();
  const { app } = desktop;
  await expect(chatInput(await activeChat(app))).toBeVisible();
  const overlay = await readyOverlay(app);
  await answerMessageBoxes(app, { [TRUST_PROMPT]: 'Trust Folder' });

  await addProjectFromMenu(app, home.project);
  await expect(dialogIn(overlay)).toBeVisible();
  await app.evaluate(({ webContents }, url) => {
    webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.forcefullyCrashRenderer();
  }, OVERLAY_URL);

  await expect.poll(async () => (await messageBoxes(app)).filter((box) => box.message.startsWith(TRUST_PROMPT))).toEqual([
    expect.objectContaining({ parented: true, buttons: ['Trust Folder', 'Don\'t Trust'] }),
  ]);
  await expect.poll(async () => (await shellState(app)).projects.find((p) => p.fsPath === home.project)?.trusted).toBe(true);
  expect(desktop.output()).toMatch(/\[dialog\] the overlay could not ask \(The overlay page stopped\); asking with the OS message box/);
  // Main reloads the crashed page; the test ends only once it has read its state, so closing never races that call.
  await expect.poll(() => app.evaluate(async ({ webContents }, url) => {
    const overlay = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
    if (!overlay || overlay.isCrashed() || overlay.isLoading()) return '';
    // Invokes are answered in order, so this one resolves after the page's own first read.
    return overlay.executeJavaScript('window.damoclesOverlay.getState().then((state) => state.locale)') as Promise<string>;
  }, OVERLAY_URL)).toBe('en');
});

test('when main is busy past the acknowledgement deadline right after asking, the overlay dialog\'s answer still counts and no OS box asks again', async ({ home, launch }) => {
  const desktop = await launch();
  const { app } = desktop;
  await expect(chatInput(await activeChat(app))).toBeVisible();
  // Records any OS box and answers it Don't Trust, so a re-asked question shows as an untrusted project.
  await answerMessageBoxes(app);
  // Blocks main once, right after it sends the first overlay request, as building the folder runtime did on a slow runner.
  await app.evaluate(({ webContents }, { url, channel, stallMs }) => {
    const overlay = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!;
    const send = overlay.send.bind(overlay);
    let stalled = false;
    overlay.send = (sent: string, ...args: unknown[]): void => {
      send(sent, ...args);
      if (sent !== channel || stalled) return;
      stalled = true;
      setImmediate(() => {
        const end = Date.now() + stallMs;
        while (Date.now() < end) { /* main is busy */ }
      });
    };
  }, { url: OVERLAY_URL, channel: OVERLAY_CHANNELS.request, stallMs: OVERLAY_ACK_TIMEOUT_MS + 1000 });

  await addProject(app, home.project, true);
  await expect.poll(async () => (await shellState(app)).projects.find((p) => p.fsPath === home.project)?.trusted).toBe(true);
  expect(await askedDialogs(app)).toEqual([expect.objectContaining({ message: expect.stringContaining(TRUST_PROMPT), answered: 'Trust Folder' })]);
  expect(await messageBoxes(app)).toEqual([]);
  expect(desktop.output()).not.toMatch(/did not acknowledge|ignoring an answer to a request that is not open/);
});

test('in Greek, the dialog\'s text and buttons are Greek', async ({ home, launch }) => {
  const { app } = await launch({ args: ['--lang=el-GR'] });
  await expect((await activeChat(app)).getByPlaceholder('Ρωτήστε τον Damocles οτιδήποτε…')).toBeVisible();
  await forbidNativeBoxes(app);
  const overlay = await readyOverlay(app);

  await addProjectFromMenu(app, home.project);
  const trust = dialogIn(overlay);
  await expect(trust).toBeVisible();
  await expect(trust.getByRole('heading')).toHaveText(`Εμπιστεύεστε τους συντάκτες των αρχείων στο ${home.project};`);
  await expect(trust.getByRole('button', { name: 'Χωρίς εμπιστοσύνη' })).toBeFocused();
  await trust.getByRole('button', { name: 'Εμπιστοσύνη φακέλου' }).click();
  await expect.poll(async () => (await shellState(app)).projects.find((p) => p.fsPath === home.project)?.trusted).toBe(true);
  expect(await nativeBoxes(app)).toEqual([]);
});
