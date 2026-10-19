import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { writeUserSettings } from '../support/hermetic';
import { setWindowContentSize } from '../support/browser';
import { openProjectChat, showShellTheme, shot, THEMES } from '../support/screenshots';
import { selectedProjectKey, shellPage } from '../support/shell';
import { editorTab, filesRow, filesTree, openInEditor } from '../support/editor';

// Review captures of the Files tree and the editor tabs in each file icon theme, dark and light.
const FILES = [
  '.github/workflows/ci.yml',
  '.idea/workspace.xml',
  'docs/guide.md',
  'public/logo.svg',
  'src/components/App.vue',
  'src/app.ts',
  'src/app.spec.ts',
  'src/types.d.ts',
  'src/styles.css',
  'src/main.py',
  '.env',
  '.gitignore',
  'Dockerfile',
  'package.json',
  'README.md',
  'tsconfig.json',
  'vite.config.ts',
];

// settled() does not wait for images, and a theme switch or a scroll gives icons a new src or new rows.
const iconsDecoded = (page: Page): Promise<unknown> =>
  page.evaluate(() => Promise.all([...document.querySelectorAll<HTMLImageElement>('img[src*="/file-icons/"]')].map((image) => image.decode())));

test.setTimeout(600_000);

for (const iconTheme of ['material', 'minimal'] as const) {
  test(`the Files tree and editor tabs with ${iconTheme} file icons`, async ({ home, launch }) => {
    for (const file of FILES) {
      fs.mkdirSync(path.join(home.project, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(home.project, file), '\n');
    }
    writeUserSettings(home, { 'damocles.desktop.fileIconTheme': iconTheme });
    const { app } = await launch();
    await openProjectChat(app, home.project);
    await setWindowContentSize(app, 1440, 900);
    const shell = await shellPage(app);
    await expect(shell.locator('html')).toHaveAttribute('data-file-icon-theme', iconTheme);
    for (const folder of ['.github', '.github/workflows', 'src', 'src/components']) await filesRow(shell, folder).click();
    await expect(filesRow(shell, 'src/components/App.vue')).toBeVisible();
    const projectKey = await selectedProjectKey(app);
    for (const relativePath of ['package.json', 'src/app.ts', 'src/components/App.vue']) {
      expect(await openInEditor(app, { projectKey, relativePath })).toMatchObject({ ok: true });
    }
    await expect(editorTab(shell, 'App.vue')).toHaveAttribute('aria-selected', 'true');
    for (const theme of THEMES) {
      await showShellTheme(app, theme);
      // The tree renders only the rows in view, so it scrolls its container rather than to a row.
      for (const [end, top] of [['top', true], ['bottom', false]] as const) {
        await filesTree(shell).evaluate((tree, toTop) => { tree.scrollTop = toTop ? 0 : tree.scrollHeight; }, top);
        await iconsDecoded(shell);
        await shot(shell, test.info(), `files-${end}-${iconTheme}-${theme}`, shell.getByTestId('files-section'));
      }
      await iconsDecoded(shell);
      await shot(shell, test.info(), `tabs-${iconTheme}-${theme}`, shell.getByTestId('editor-tabs'));
    }
  });
}
