import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ElectronApplication, Locator, Page, TestInfo } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { git, initRepo, type GitHome } from '../support/git';
import { seedStubModel, writeUserSettings } from '../support/hermetic';
import { overlayMenu } from '../support/overlay';
import { openProjectChat, saveScreenshot, saveWindowScreenshot, settled, THEMES, type Theme } from '../support/screenshots';
import { closeSettingsModal, openSettingsModal, setContentSize } from '../support/settings';
import { overlayPage, shellPage } from '../support/shell';
import { projectKeyOf, projectRow } from '../support/shell-ui';
import { addProject, setThemeSource } from '../support/ui';

// Review captures of source control: Dark and Light, the 13px default and a 16px host font, and a reduced-motion pass.
const WIDTH = 1440;
const HEIGHT = 900;
const FONTS = [13, 16] as const;

test.describe.configure({ mode: 'serial' });
test.setTimeout(900_000);

async function shot(page: Page, testInfo: TestInfo, name: string, target?: Locator): Promise<void> {
  await settled(page);
  await saveScreenshot(page, testInfo, name, target);
}

/** The whole window as the user sees it, once the shell and the overlay have settled. */
async function windowShot(app: ElectronApplication, testInfo: TestInfo, name: string): Promise<void> {
  await settled(await shellPage(app));
  await settled(await overlayPage(app));
  await saveWindowScreenshot(app, testInfo, name);
}

function write(root: string, relativePath: string, content: string): void {
  const file = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// A repository stopped on a conflict: `merge` leaves a merge in progress, `rebase` a rebase.
async function conflicted(h: GitHome, dir: string, kind: 'merge' | 'rebase'): Promise<void> {
  await initRepo(h, dir, { 'src/app.ts': "app.listen(3000);\n" }, NO_IDENTITY);
  await git(h, dir, 'checkout', '-b', 'feat/users-docs');
  write(dir, 'src/app.ts', "app.listen(env.PORT ?? 3000);\n");
  await git(h, dir, 'commit', '-am', 'Read the port from env');
  await git(h, dir, 'checkout', 'main');
  write(dir, 'src/app.ts', "app.listen(8080);\n");
  await git(h, dir, 'commit', '-am', 'Move to 8080');
  if (kind === 'rebase') await git(h, dir, 'checkout', 'feat/users-docs');
  await (kind === 'merge' ? git(h, dir, 'merge', 'feat/users-docs') : git(h, dir, 'rebase', 'main')).then(
    () => { throw new Error(`the ${kind} in ${dir} did not stop on a conflict`); },
    () => undefined,
  );
}

/** The main project: a root repository with staged, modified, untracked, deleted and ignored files, three nested repositories and a submodule. */
async function seed(h: GitHome, project: string): Promise<void> {
  await initRepo(h, project, {
    '.gitignore': 'logs/\n',
    'package.json': '{ "name": "acme-api", "version": "1.2.0" }\n',
    'src/app.ts': "import express from 'express';\nconst app = express();\napp.listen(3000);\n",
    'src/routes/auth.ts': "export const login = '/login';\n",
    'docs/old-setup.md': '# Old setup\n',
    'README.md': '# acme-api\n',
  }, NO_IDENTITY);
  const library = path.join(h.root, 'sdk-source');
  await initRepo(h, library, { 'index.ts': 'export {};\n' }, NO_IDENTITY);
  await git(h, project, '-c', 'protocol.file.allow=always', 'submodule', 'add', library, 'vendor/sdk');
  await git(h, project, 'commit', '-m', 'Add the sdk submodule');
  await initRepo(h, path.join(project, 'web'), { 'index.html': '<!doctype html>\n' }, NO_IDENTITY);
  await conflicted(h, path.join(project, 'merging'), 'merge');
  await conflicted(h, path.join(project, 'rebasing'), 'rebase');
  write(project, 'src/app.ts', "import express from 'express';\nimport { rateLimit } from 'express-rate-limit';\nconst app = express();\napp.use(rateLimit({ limit: 5 }));\napp.listen(3000);\n");
  write(project, 'src/routes/users.ts', "export const users = '/users';\n");
  write(project, 'src/middleware/request-id.ts', 'export function requestId() {}\n');
  fs.rmSync(path.join(project, 'docs', 'old-setup.md'));
  write(project, 'package.json', '{ "name": "acme-api", "version": "1.3.0" }\n');
  write(project, 'src/middleware/logger.ts', 'export function logger() {}\n');
  await git(h, project, 'add', 'package.json', 'src/middleware/logger.ts');
  write(project, 'logs/debug.log', 'started\n');
}

/** A loopback model endpoint that holds every request until released, so Generate stays in flight for its capture. */
async function holdingModel(): Promise<{ baseUrl: string; release(): void; close(): Promise<void> }> {
  const held: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    held.push(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const release = (): void => {
    for (const res of held.splice(0)) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'held for a capture' } }));
  };
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    release,
    close: () => new Promise<void>((resolve) => {
      release();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** Sets the host font on every Damocles page the way the theme style does; 13 is the desktop default. */
async function setFont(app: ElectronApplication, px: number): Promise<void> {
  for (const page of [await shellPage(app), await overlayPage(app)]) {
    await page.evaluate((size) => document.documentElement.style.setProperty('--d-font-size', `${size}px`), px);
    await settled(page);
  }
}

/** Switches the app theme and waits until the shell page wears it; a chat page may be unloaded by a project switch. */
async function showShellTheme(app: ElectronApplication, theme: Theme): Promise<void> {
  await setThemeSource(app, theme);
  const shell = await shellPage(app);
  await expect(shell.locator('body')).toHaveClass(new RegExp(`(^| )vscode-${theme}( |$)`));
  await settled(shell);
}

async function setReducedMotion(app: ElectronApplication, on: boolean): Promise<void> {
  for (const page of [await shellPage(app), await overlayPage(app)]) {
    // The OS preference, not data-reduced-motion, which every theme switch rewrites from main's setting.
    await page.emulateMedia({ reducedMotion: on ? 'reduce' : null });
  }
}

async function setSection(shell: Page, testId: string, open: boolean): Promise<void> {
  const toggle = shell.getByTestId(testId).locator('h2 button');
  if ((await toggle.getAttribute('aria-expanded')) !== String(open)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', String(open));
}

async function selectProject(app: ElectronApplication, shell: Page, name: string): Promise<void> {
  await projectRow(shell, await projectKeyOf(app, name)).click();
}

async function selectRepo(shell: Page, overlay: Page, label: string): Promise<void> {
  await shell.getByTestId('scm-repo-picker').click();
  await expect(overlayMenu(overlay)).toBeVisible();
  await overlayMenu(overlay).locator('[role^="menuitem"]').filter({ hasText: label }).first().click();
  await expect(overlayMenu(overlay)).toHaveCount(0);
  await expect(shell.getByTestId('scm-repo-name')).toHaveText(label);
}

const scm = (shell: Page): Locator => shell.getByTestId('scm-section');
const message = (shell: Page): Locator => shell.getByTestId('scm-commit-message');
// No user.name or user.email in these repositories, as on a machine without a git identity.
const NO_IDENTITY = { identity: false } as const;

test('slice 10 captures', async ({ foreground: _foreground, home, launch }, testInfo) => {
  await seed(home, home.project);
  const plain = path.join(home.root, 'scratch-notes');
  write(plain, 'notes.md', '# Notes\n');
  const untrusted = path.join(home.root, 'pi-agent-sdk');
  await initRepo(home, untrusted, { 'README.md': '# pi-agent-sdk\n' }, NO_IDENTITY);
  const huge = path.join(home.root, 'generated-assets');
  fs.mkdirSync(huge, { recursive: true });
  await git(home, huge, 'init', '-b', 'main');
  for (let i = 0; i < 10_050; i++) write(huge, `out/${String(i).padStart(5, '0')}.txt`, `${i}\n`);
  const model = await holdingModel();
  seedStubModel(home, model.baseUrl);
  writeUserSettings(home, { 'damocles.desktop.git.inputValidation': true });

  try {
    const { app } = await launch();
    await openProjectChat(app, home.project);
    await setContentSize(app, WIDTH, HEIGHT);
    const shell = await shellPage(app);
    const overlay = await overlayPage(app);
    const projectName = path.basename(home.project);
    await addProject(app, plain, true);
    await addProject(app, untrusted, false);
    await addProject(app, huge, true);
    await selectProject(app, shell, projectName);
    await expect(shell.locator('[data-testid="scm-group"][data-group="index"]')).toBeVisible({ timeout: 30_000 });

    const pass = async (theme: Theme, font: number, suffix = ''): Promise<void> => {
      await showShellTheme(app, theme);
      await setFont(app, font);
      const t = (name: string): string => `${name}-${theme}-${font}${suffix}`;
      await selectProject(app, shell, projectName);
      await setSection(shell, 'files-section', false);
      await setSection(shell, 'scm-section', true);
      await selectRepo(shell, overlay, projectName);

      // The groups in list view, a change row hovered so its inline actions show.
      await shell.locator('[data-testid="scm-change"][data-group="workingTree"]').first().hover();
      await windowShot(app, testInfo, t('scm-groups-list'));
      await shot(shell, testInfo, t('scm-section-list'), scm(shell));
      await shell.mouse.move(0, 0);

      // Tree view, then back to list.
      await shell.getByTestId('scm-view-mode').click();
      await expect(shell.getByTestId('scm-tree')).toHaveAttribute('data-view-mode', 'tree');
      await shot(shell, testInfo, t('scm-section-tree'), scm(shell));
      await shell.getByTestId('scm-view-mode').click();
      await expect(shell.getByTestId('scm-tree')).toHaveAttribute('data-view-mode', 'list');

      // The picker's menu, and More Actions with View & Sort open.
      await shell.getByTestId('scm-repo-picker').click();
      await expect(overlayMenu(overlay)).toBeVisible();
      await windowShot(app, testInfo, t('scm-picker-menu'));
      await overlay.keyboard.press('Escape');
      await expect(overlayMenu(overlay)).toHaveCount(0);
      await shell.getByTestId('scm-more-actions').click();
      await expect(overlayMenu(overlay)).toBeVisible();
      await overlayMenu(overlay).locator('[role^="menuitem"]').first().hover();
      await windowShot(app, testInfo, t('scm-more-actions'));
      await overlay.keyboard.press('Escape');
      await overlay.keyboard.press('Escape');
      await expect(overlayMenu(overlay)).toHaveCount(0);

      // The commit box: the length warning on a long subject, then Generate in flight.
      await message(shell).fill('Add rate limiting to POST /login and the request id middleware');
      await expect(shell.getByTestId('scm-length-warning')).toBeVisible();
      await shot(shell, testInfo, t('scm-commit-warning'), scm(shell));
      await message(shell).fill('');
      await shell.getByTestId('scm-generate').click();
      await expect(shell.getByTestId('scm-generate')).toHaveAttribute('aria-busy', 'true');
      // The sheen sweeps forever; pinned halfway across so the capture shows it.
      await shell.evaluate(() => {
        for (const animation of document.getAnimations()) {
          if (animation instanceof CSSAnimation && animation.animationName === 'o-sweep') {
            animation.pause();
            animation.currentTime = 700;
          }
        }
      });
      await shot(shell, testInfo, t('scm-commit-generating'), scm(shell));
      model.release();
      await expect(shell.getByTestId('scm-generate')).not.toHaveAttribute('aria-busy', 'true');

      // Nothing to commit, in the clean nested repository.
      await selectRepo(shell, overlay, 'web');
      await message(shell).fill('Update the landing page');
      await shell.getByTestId('scm-commit').click();
      await expect(shell.getByTestId('scm-commit-feedback')).toBeVisible();
      await shot(shell, testInfo, t('scm-commit-feedback'), scm(shell));
      await message(shell).fill('');

      // Merge and rebase in progress.
      await selectRepo(shell, overlay, 'merging');
      await expect(shell.getByTestId('scm-operation')).toHaveAttribute('data-operation', 'merge');
      await shot(shell, testInfo, t('scm-merge-banner'), scm(shell));
      await selectRepo(shell, overlay, 'rebasing');
      await expect(shell.getByTestId('scm-operation')).toHaveAttribute('data-operation', 'rebase');
      await shot(shell, testInfo, t('scm-rebase-banner'), scm(shell));

      // The multi-file diff tab from Changes › Open Changes, with the second file selected.
      await selectRepo(shell, overlay, projectName);
      await shell.locator('[data-testid="scm-group"][data-group="workingTree"]').getByTestId('scm-group-openGroupChanges').click();
      await expect(shell.getByTestId('changes-tab')).toBeVisible();
      await shell.getByTestId('changes-entry').nth(1).click();
      await expect(shell.getByTestId('changes-diff').or(shell.getByTestId('changes-notice'))).toBeVisible();
      await windowShot(app, testInfo, t('changes-tab'));

      // Files decorations (modified, untracked, staged, the submodule's S, the ignored logs folder) and a decorated editor tab.
      await setSection(shell, 'scm-section', false);
      await setSection(shell, 'files-section', true);
      for (const folder of ['src', 'src/middleware', 'logs']) {
        const row = shell.locator(`[data-testid="files-row"][data-tree-path="${folder}"]`);
        if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
      }
      await shell.locator('[data-testid="files-row"][data-tree-path="src/app.ts"]').click();
      await expect(shell.getByTestId('editor-tab-decoration').first()).toBeVisible();
      await windowShot(app, testInfo, t('files-and-tab-decorations'));
      await shot(shell, testInfo, t('files-decorations'), shell.getByTestId('files-section'));
      await setSection(shell, 'files-section', false);
      await setSection(shell, 'scm-section', true);

      // Empty and error states.
      for (const [project, name] of [[untrusted, 'state-untrusted'], [plain, 'state-no-repository'], [huge, 'scm-too-many']] as const) {
        await selectProject(app, shell, path.basename(project));
        await expect(shell.getByTestId(name === 'scm-too-many' ? 'scm-too-many' : 'scm-state')).toBeVisible({ timeout: 60_000 });
        await shot(shell, testInfo, t(name), scm(shell));
      }

      // Settings › Source control.
      const settings = await openSettingsModal(app, 'sourceControl');
      await setFont(app, font);
      await shot(settings, testInfo, t('settings-source-control'));
      await closeSettingsModal(settings);
    };

    for (const theme of THEMES) {
      for (const font of FONTS) await pass(theme, font);
    }
    await setReducedMotion(app, true);
    for (const theme of THEMES) await pass(theme, FONTS[0], '-reduced');
    await setReducedMotion(app, false);
  } finally {
    await model.close();
  }
});

test('slice 10 git missing captures', async ({ foreground: _foreground, home, launch }, testInfo) => {
  const exe = process.platform === 'win32' ? 'git.exe' : 'git';
  const pathWithoutGit = (process.env.PATH ?? '').split(path.delimiter).filter((entry) => entry !== '' && !fs.existsSync(path.join(entry, exe))).join(path.delimiter);
  await initRepo(home, home.project, { 'README.md': '# acme-api\n' }, NO_IDENTITY);
  // probeGit looks only on PATH; a relative SHELL keeps mergeLoginShellEnv from putting the login shell's PATH back.
  const { app } = await launch({ env: { PATH: pathWithoutGit, SHELL: 'sh' } });
  await openProjectChat(app, home.project);
  await setContentSize(app, WIDTH, HEIGHT);
  const shell = await shellPage(app);
  await setSection(shell, 'files-section', false);
  await setSection(shell, 'scm-section', true);
  await expect(shell.getByTestId('scm-state')).toHaveAttribute('data-state', 'gitMissing', { timeout: 30_000 });
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    for (const font of FONTS) {
      await setFont(app, font);
      await shot(shell, testInfo, `state-git-missing-${theme}-${font}`, scm(shell));
    }
  }
});
