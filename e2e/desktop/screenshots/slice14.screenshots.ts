import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { setWindowContentSize } from '../support/browser';
import { filesRow } from '../support/editor';
import { confirmDialog } from '../support/overlay';
import { setSection } from '../support/scm';
import { openProjectChat, saveScreenshot, setReducedMotion, settled, showShellTheme, THEMES, windowShot } from '../support/screenshots';
import { overlayPage, PRIMARY, pressKeys, selectedProjectKey, shellPage } from '../support/shell';
import { SHELL_CHANNELS, type FilesTransferProgress } from '../../../src/desktop/preload/shell-channels';

// Review captures of copying files in and out of Files (slice 14): the drop highlight on a folder and on the project folder,
// the progress row running and done, a cut row, the move confirm and the conflict prompt, in Dark and Light and with reduced
// motion. Names are listed in the frontend scratchpad section.
const MIB = 1024 * 1024;

test.setTimeout(900_000);

function seed(project: string, incoming: string): void {
  const files = ['src/app.ts', 'src/server.ts', 'src/assets/logo.svg', 'src/assets/icons/check.svg', 'tests/retry.test.ts', 'README.md', 'package.json'];
  for (const file of files) {
    fs.mkdirSync(path.join(project, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(project, file), `${file}\n`);
  }
  fs.mkdirSync(incoming, { recursive: true });
  for (const file of ['hero@2x.png', 'logo.svg', 'banner.jpg']) fs.writeFileSync(path.join(incoming, file), `${file}\n`.repeat(200));
}

/** Dispatches a drag of disk-backed files, read through a temporary file input, over `treePath`'s row; drop ends it there. */
async function dragFiles(shell: Page, paths: readonly string[], treePath: string | null, drop: boolean): Promise<void> {
  await shell.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.id = 'e2e-files';
    document.body.append(input);
  });
  await shell.setInputFiles('#e2e-files', [...paths]);
  await shell.evaluate(([path, end]) => {
    const input = document.getElementById('e2e-files') as HTMLInputElement;
    const transfer = new DataTransfer();
    for (const file of input.files ?? []) transfer.items.add(file);
    input.remove();
    const target = path === null ? document.querySelector('[data-testid="files-tree"]')! : document.querySelector(`[data-tree-path="${path}"]`)!;
    for (const type of ['dragenter', 'dragover', ...(end ? ['drop'] : [])]) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, [treePath, drop] as const);
}

async function endDrag(shell: Page): Promise<void> {
  await shell.evaluate(() => document.querySelector('[data-testid="files-tree"]')!.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: document.body })));
}

/** Drags `from`'s row onto `to`'s as the user's own drag does: dragstart on the row, then dragover and drop with one DataTransfer. */
async function dragRow(shell: Page, from: string, to: string): Promise<void> {
  await shell.evaluate(([source, target]) => {
    const transfer = new DataTransfer();
    document.querySelector(`[data-tree-path="${source}"]`)!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    const row = document.querySelector(`[data-tree-path="${target}"]`)!;
    for (const type of ['dragenter', 'dragover', 'drop']) row.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, [from, to] as const);
}

async function progress(app: ElectronApplication, update: FilesTransferProgress): Promise<void> {
  await app.evaluate(({ webContents }, [channel, payload]) => {
    for (const contents of webContents.getAllWebContents()) if (contents.getURL().includes('/shell/')) contents.send(channel, payload);
  }, [SHELL_CHANNELS.filesTransferProgress, update] as const);
}

async function filesShot(shell: Page, testInfo: TestInfo, name: string): Promise<void> {
  await settled(shell);
  await saveScreenshot(shell, testInfo, name, shell.getByTestId('files-section'));
}

test('slice 14 captures', async ({ clipboard: _clipboard, home, launch }, testInfo) => {
  const incoming = path.join(home.root, 'incoming');
  seed(home.project, incoming);
  const { app } = await launch();
  await openProjectChat(app, home.project);
  await setWindowContentSize(app, 1440, 900);
  const shell = await shellPage(app);
  const overlay = await overlayPage(app);
  for (const section of ['sidebar-projects', 'sidebar-chats']) await setSection(shell, section, false);
  for (const folder of ['src', 'src/assets', 'tests']) await filesRow(shell, folder).click();
  await expect(filesRow(shell, 'src/assets/logo.svg')).toBeVisible();
  const key = await selectedProjectKey(app);

  for (const [variant, reduced] of [...THEMES.map((theme) => [theme, false] as const), ['reduced', true] as const]) {
    const theme = variant === 'reduced' ? 'dark' : variant;
    await showShellTheme(app, theme);
    await setReducedMotion(app, reduced);

    // the drop highlight on a folder, then over the project folder
    await dragFiles(shell, [path.join(incoming, 'hero@2x.png')], 'src/assets', false);
    await expect(shell.getByTestId('files-drop-highlight')).toBeVisible();
    await filesShot(shell, testInfo, `files-drop-folder-${variant}`);
    await dragFiles(shell, [path.join(incoming, 'hero@2x.png')], null, false);
    await expect(shell.getByTestId('files-drop-root')).toBeVisible();
    await filesShot(shell, testInfo, `files-drop-root-${variant}`);
    await endDrag(shell);

    // the progress row, running and then done
    const base = { transferId: 9000 + THEMES.indexOf(theme) + (reduced ? 10 : 0), projectKey: key, op: 'copy' as const, filesTotal: 40, bytesTotal: Math.round(9.8 * MIB) };
    await progress(app, { ...base, state: 'running', filesDone: 12, bytesDone: Math.round(3.1 * MIB) });
    await expect(shell.getByTestId('files-transfer')).toBeVisible();
    await filesShot(shell, testInfo, `files-progress-${variant}`);
    await progress(app, { ...base, state: 'done', filesDone: 40, bytesDone: base.bytesTotal });
    await expect(shell.getByTestId('files-transfer')).toHaveAttribute('data-phase', 'done');
    await filesShot(shell, testInfo, `files-progress-done-${variant}`);
    await expect(shell.getByTestId('files-transfer')).toHaveCount(0);

    // a cut row, through the real Ctrl+X: main's Edit menu sends the cut event to the focused row
    await filesRow(shell, 'src/app.ts').focus();
    await pressKeys(app, '/shell/', 'X', [PRIMARY]);
    await expect(filesRow(shell, 'src/app.ts')).toHaveAttribute('data-cut', 'true');
    await filesShot(shell, testInfo, `files-cut-${variant}`);
    await filesRow(shell, 'src/app.ts').press('Escape');
    await expect(filesRow(shell, 'src/app.ts')).not.toHaveAttribute('data-cut', 'true');

    // the move confirm
    await dragRow(shell, 'tests/retry.test.ts', 'src');
    await expect(confirmDialog(overlay)).toBeVisible();
    await windowShot(app, testInfo, `files-move-confirm-${variant}`);
    await saveScreenshot(overlay, testInfo, `files-move-confirm-panel-${variant}`, confirmDialog(overlay));
    await overlay.keyboard.press('Escape');
    await expect(confirmDialog(overlay)).toHaveCount(0);

    // the conflict prompt for a dropped file whose name src/assets already has
    await dragFiles(shell, [path.join(incoming, 'logo.svg')], 'src/assets', true);
    await expect(confirmDialog(overlay)).toBeVisible();
    await windowShot(app, testInfo, `files-conflict-${variant}`);
    await saveScreenshot(overlay, testInfo, `files-conflict-panel-${variant}`, confirmDialog(overlay));
    await overlay.getByTestId('overlay-message-checkbox').click();
    await overlay.keyboard.press('Shift+Tab');
    await overlay.keyboard.press('Tab');
    await saveScreenshot(overlay, testInfo, `files-conflict-checked-${variant}`, confirmDialog(overlay));
    await overlay.keyboard.press('Escape');
    await expect(confirmDialog(overlay)).toHaveCount(0);
  }
});
