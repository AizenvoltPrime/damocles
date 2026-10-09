import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '../support/fixtures';
import { setWindowContentSize } from '../support/browser';
import { filesRow, filesTree } from '../support/editor';
import { openProjectChat, saveScreenshot, settled, showTheme, THEMES } from '../support/screenshots';
import { popupPage, popupToasts, shellPage } from '../support/shell';

// Review captures of New file in a folder that cannot be listed, saved to DAMOCLES_SCREENSHOT_DIR, dark and light.
test.setTimeout(300_000);

test('New file in an unlistable folder is one toast', async ({ home, launch }, testInfo) => {
  fs.mkdirSync(path.join(home.project, 'src', 'routes'), { recursive: true });
  for (const name of ['app.ts', 'routes/auth.ts', 'routes/users.ts']) fs.writeFileSync(path.join(home.project, 'src', ...name.split('/')), 'export {};\n');
  const outside = path.join(path.dirname(home.project), 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(home.project, 'linked'), 'junction');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  await setWindowContentSize(app, 1440, 900);
  const shell = await shellPage(app);

  for (const theme of THEMES) {
    await showTheme(app, shell, theme);
    await filesRow(shell, 'linked').focus();
    await shell.getByTestId('files-new-file').click();
    const popup = await popupPage(app);
    const toast = popupToasts(popup).filter({ hasText: 'Damocles could not open the folder linked' }).last();
    await expect(toast).toBeVisible();
    await settled(popup);
    await saveScreenshot(popup, testInfo, `files-create-unlistable-toast-${theme}`, toast);
    await settled(shell);
    await saveScreenshot(shell, testInfo, `files-create-unlistable-tree-${theme}`, filesTree(shell));
  }
});
