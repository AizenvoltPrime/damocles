import * as fs from 'node:fs';
import * as path from 'node:path';
import { cliAppBinary, runLocalCli } from './support/cli';
import { activeTab, codeEditor, editorShows } from './support/editor';
import { expect, test } from './support/fixtures';
import type { HermeticHome } from './support/hermetic';
import { cleanUp, endLeftoverDaemon, LOCAL_DAEMON, LOOPBACK_ENV, LOOPBACK_TAG, LOOPBACK_TRUST_PROMPT, shutdownDaemon } from './support/loopback';
import { messageDialog } from './support/file-drops';
import { readyOverlay } from './support/overlay';
import { shellPage, shellState } from './support/shell';
import { answerDialogs, clickMenu } from './support/ui';

const CLOSE_EDITOR = 'damocles.editor.close';

function seed(home: HermeticHome): void {
  fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(home.project, 'src', 'app.ts'), Array.from({ length: 60 }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n'));
  fs.writeFileSync(path.join(home.project, 'README.md'), '# alpha\n');
  fs.writeFileSync(path.join(home.userData, 'projects.json'), `${JSON.stringify({ version: 1, projects: [home.project] }, null, 2)}\n`);
}

// the --wait markers dist/cli.js leaves in the hermetic ~/.damocles/cli-wait, which the command and main both resolve
const markerFolder = (home: HermeticHome): string => path.join(home.home, '.damocles', 'cli-wait');
const markers = (home: HermeticHome): string[] => fs.readdirSync(markerFolder(home)).filter((name) => name.startsWith('damocles-wait-'));

test('the damocles command on this computer opens a project file at its line in the running app, and --wait returns once its tab closed', async ({ foreground: _foreground, home, launch }) => {
  seed(home);
  const { app } = await launch();
  const shell = await shellPage(app);
  await expect.poll(async () => (await shellState(app)).projects.map((project) => project.fsPath)).toEqual([home.project]);
  // the command starts this checkout's Electron with the test's own user data, never an installed Damocles
  expect(path.resolve(cliAppBinary()).startsWith(path.resolve(path.join(__dirname, '..', '..', 'node_modules')))).toBe(true);

  const opened = await runLocalCli(home, ['src/app.ts:42'], home.project);
  expect(opened).toEqual({ code: 0, stdout: '', stderr: '' });
  await expect.poll(async () => (await activeTab(app))?.relativePath).toBe('src/app.ts');
  await editorShows(shell, 'const line42 = 42;');
  const lineTop = await codeEditor(shell).locator('.view-line', { hasText: 'const line42 = 42;' }).evaluate((line) => (line as HTMLElement).style.top);
  await expect.poll(() => codeEditor(shell).locator('.view-overlays .current-line').first().evaluate((highlight) => (highlight.parentElement as HTMLElement).style.top)).toBe(lineTop);

  let returned = false;
  const waited = runLocalCli(home, ['--wait', 'README.md'], home.project).then((result) => {
    returned = true;
    return result;
  });
  await expect.poll(async () => (await activeTab(app))?.relativePath, { timeout: 30_000 }).toBe('README.md');
  expect(markers(home)).toHaveLength(1);
  // the running app claimed the marker with its pid, which the command watches
  await expect.poll(() => fs.readFileSync(path.join(markerFolder(home), markers(home)[0]!), 'utf8')).toBe(String(await app.evaluate(() => process.pid)));
  expect(returned).toBe(false);
  await clickMenu(app, CLOSE_EDITOR);
  expect(await waited).toEqual({ code: 0, stdout: '', stderr: '' });
  expect(markers(home)).toEqual([]);

  // the usage and an argument error are the command's own, printed without starting anything
  const help = await runLocalCli(home, ['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('Usage: damocles [options] [paths...]');
  expect(await runLocalCli(home, ['--remote', 'prod-1', '/srv'])).toMatchObject({ code: 1, stderr: 'damocles: prod-1 names no host. Use wsl+<distro>, ssh+<host> or loopback.\n' });
  // a request past the contract's bounds is refused before the app hears of it
  expect(await runLocalCli(home, Array.from({ length: 65 }, (_, index) => `f${index}.log`), home.project)).toEqual({ code: 1, stdout: '', stderr: 'damocles: a request names at most 64 paths.\n' });
  // a switch the command does not know goes to the app, with a warning, when the command carries no path; --wait returns once
  // the running app took the launch, so no second instance is left starting when the app closes
  expect(await runLocalCli(home, ['--wait', '--disable-gpu'])).toEqual({ code: 0, stdout: '', stderr: 'damocles: --disable-gpu is not an option of the command, so it is passed to the app as it is.\n' });
  expect(markers(home)).toEqual([]);
});

test('damocles --remote with a host no saved record names opens Connect to Host with it typed in, and connects nothing', async ({ foreground: _foreground, home, launch }) => {
  seed(home);
  const { app } = await launch({ env: { DAMOCLES_E2E_HOOKS: '1' } });
  await shellPage(app);
  const overlay = await readyOverlay(app);
  expect((await runLocalCli(home, ['--remote', 'ssh+deploy@10.0.7.12:2222', '/srv/app'])).code).toBe(0);
  const dialog = overlay.getByRole('dialog', { name: 'Connect to host' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole('textbox', { name: 'Search hosts or enter a new one' })).toHaveValue('deploy@10.0.7.12:2222');
  await overlay.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  const state = await shellState(app);
  expect(state.hosts).toEqual([]);
  expect(state.projects.map((project) => project.fsPath)).toEqual([home.project]);
});

test('damocles --remote loopback opens a folder through the local daemon after asking to add it', { tag: LOOPBACK_TAG }, async ({ foreground: _foreground, home, launch }, testInfo) => {
  test.setTimeout(300_000);
  seed(home);
  const folder = path.join(home.root, 'p', 'remote');
  fs.mkdirSync(folder, { recursive: true });
  const { app } = await launch(LOOPBACK_ENV);
  let failure: unknown;
  try {
    await shellPage(app);
    const overlay = await readyOverlay(app);
    await answerDialogs(app, { [LOOPBACK_TRUST_PROMPT]: 'Trust Folder' });
    const run = runLocalCli(home, ['--remote', 'loopback', folder]);
    const ask = messageDialog(overlay, `Add ${folder} on ${LOCAL_DAEMON} as a project?`);
    await expect(ask).toBeVisible({ timeout: 60_000 });
    await ask.getByRole('button', { name: 'Add Project', exact: true }).click();
    expect((await run).code).toBe(0);
    await expect.poll(async () => {
      const state = await shellState(app);
      const project = state.projects.find((candidate) => candidate.authority.kind === 'loopback' && candidate.fsPath === folder);
      return project !== undefined && state.selected.projectKey === project.key && project.trusted;
    }, { timeout: 60_000 }).toBe(true);
    await shutdownDaemon(app, home);
  } catch (error) {
    failure = error;
  }
  await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
});
