import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { logBeforeQuit, mainLog, type DesktopApp } from './support/app';
import { expect, test } from './support/fixtures';
import { writeUserSettings, type HermeticHome } from './support/hermetic';
import { openProjectChat } from './support/screenshots';
import { answerToast, PRIMARY, pressKeys, recordedToasts, recordToasts, selectedProjectKey, SHELL_URL, shellPage, shellState } from './support/shell';
import { activeTab, bufferText, codeEditor, DOCUMENT_END, editorShows, editorTab, openInEditor, saveWithKeyboard } from './support/editor';
import { installPrettierStub as installStub } from './support/prettier';
import { addProject, answerDialogs, clickMenu, TRUST_PROMPT } from './support/ui';

const FORMAT_ON_SAVE = 'damocles.desktop.editor.formatOnSave';
const HOST_STARTED = '[format] started the formatter';

function write(home: HermeticHome, relativePath: string, content: string): string {
  const file = path.join(home.project, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** Launches with format on save on and the project added (trusted unless said otherwise), and opens a file as a user does. */
async function openFile(home: HermeticHome, launch: (options?: { env?: Record<string, string> }) => Promise<DesktopApp>, relativePath: string, opts: { trusted?: boolean; settings?: Record<string, unknown> } = {}): Promise<{ desktop: DesktopApp; app: ElectronApplication; shell: Page }> {
  writeUserSettings(home, { [FORMAT_ON_SAVE]: true, ...opts.settings });
  const desktop = await launch();
  const { app } = desktop;
  if (opts.trusted === false) await addProject(app, home.project, false);
  else await openProjectChat(app, home.project);
  await recordToasts(app);
  const shell = await shellPage(app);
  expect(await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath })).toMatchObject({ ok: true });
  await expect(editorTab(shell, path.posix.basename(relativePath))).toHaveAttribute('aria-selected', 'true');
  await expect(codeEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
  await expect(codeEditor(shell).locator('.monaco-editor')).toHaveClass(/focused/);
  return { desktop, app, shell };
}

/** Types at the end of the focused editor, as the user does before saving. */
async function typeAtEnd(shell: Page, text: string): Promise<void> {
  await shell.keyboard.press(DOCUMENT_END);
  await shell.keyboard.type(text);
  await expect.poll(async () => (await shell.evaluate(() => window.damoclesShell!.getEditorState())).tabs.find((tab) => tab.dirty) !== undefined).toBe(true);
}

/**
 * Shift+Alt+F through Electron's input path, which reaches the menu accelerator as pressKeys does. pressKeys refuses Alt,
 * whose macOS Option layer it does not model, so on macOS the Edit menu item runs instead.
 */
async function formatDocumentShortcut(app: ElectronApplication): Promise<void> {
  if (process.platform === 'darwin') {
    await clickMenu(app, 'damocles.editor.formatDocument');
    return;
  }
  await app.evaluate(({ webContents }, url) => {
    const target = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!;
    target.focus();
    target.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: ['shift', 'alt'] });
    target.sendInputEvent({ type: 'keyUp', keyCode: 'F', modifiers: ['shift', 'alt'] });
  }, SHELL_URL);
}

async function noticesMatching(app: ElectronApplication, text: string): Promise<Array<{ id: string; message: string; actions: readonly string[] }>> {
  return (await recordedToasts(app)).filter((notice) => notice.message.includes(text));
}

test('a trusted project\'s Prettier 3 formats a .ts file on Ctrl+S, and one Ctrl+Z undoes the format', async ({ home, launch }) => {
  installStub(home.project, '3.3.3');
  fs.writeFileSync(path.join(home.project, '.prettierrc'), JSON.stringify({ semi: false }));
  const file = write(home, 'src/a.ts', 'const a=1\n');
  const { app, shell } = await openFile(home, launch, 'src/a.ts');
  await typeAtEnd(shell, 'let b  =2');
  await saveWithKeyboard(app);
  // The stub honours the project's .prettierrc through resolveConfig: no semicolons.
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('const a = 1\nlet b = 2\n');
  await expect(editorTab(shell, 'a.ts')).not.toHaveAttribute('data-dirty', 'true');
  await expect.poll(() => mainLog(home)).toContain(HOST_STARTED);

  await shell.keyboard.press('ControlOrMeta+Z');
  await expect.poll(() => bufferText(shell)).toBe('const a=1\nlet b  =2');
  await expect(editorTab(shell, 'a.ts')).toHaveAttribute('data-dirty', 'true');
});

test('Save in the close prompt formats as Ctrl+S does', async ({ home, launch }) => {
  installStub(home.project, '3.3.3');
  const file = write(home, 'a.ts', 'const a=1\n');
  const { app, shell } = await openFile(home, launch, 'a.ts');
  await typeAtEnd(shell, 'const b=2');
  await answerDialogs(app, { 'Do you want to save the changes you made to a.ts?': 'Save' });
  await pressKeys(app, '/shell/', 'W', [PRIMARY]);
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('const a = 1;\nconst b = 2;\n');
  await expect(editorTab(shell, 'a.ts')).toHaveCount(0);
});

test('Prettier 2\'s synchronous format formats on save too', async ({ home, launch }) => {
  installStub(home.project, '2.8.8');
  const file = write(home, 'a.ts', 'const a=1\n');
  const { app, shell } = await openFile(home, launch, 'a.ts');
  await typeAtEnd(shell, 'const b=2');
  await saveWithKeyboard(app);
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('const a = 1;\nconst b = 2;\n');
});

test('in an untrusted project Ctrl+S saves the text unchanged, starts no formatter and says so once with Trust', async ({ home, launch }) => {
  installStub(home.project, '3.3.3');
  const file = write(home, 'a.ts', 'const a=1\n');
  const { app, shell } = await openFile(home, launch, 'a.ts', { trusted: false });
  await typeAtEnd(shell, 'const b=2');
  await saveWithKeyboard(app);
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('const a=1\nconst b=2');
  await expect.poll(async () => (await noticesMatching(app, 'Format on save is off in untrusted folders')).map((notice) => notice.actions)).toEqual([['Trust']]);
  await typeAtEnd(shell, '\nconst c=3');
  await saveWithKeyboard(app);
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('const a=1\nconst b=2\nconst c=3');
  expect(await noticesMatching(app, 'Format on save is off in untrusted folders')).toHaveLength(1);

  // Trust, from the notice, asks the trust question; the grant applies to the next save with no reload.
  await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder' });
  const [notice] = await noticesMatching(app, 'Format on save is off in untrusted folders');
  await answerToast(app, notice!.id, 'Trust');
  await expect.poll(async () => (await shellState(app)).projects.find((project) => project.fsPath === home.project)?.trusted).toBe(true);
  // The log is written in order, so once it holds the grant's line it holds every line logged while the folder was untrusted.
  await expect.poll(() => mainLog(home)).toContain('[trust] granted');
  const log = mainLog(home);
  expect(log.slice(0, log.indexOf('[trust] granted'))).not.toContain(HOST_STARTED);
  await codeEditor(shell).locator('.view-lines').click();
  await typeAtEnd(shell, '\nconst d=4');
  await saveWithKeyboard(app);
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n');
});

test('a Prettier that takes 5 s is stopped after 3 s, the file saves unformatted and Show Output opens the Format log', async ({ home, launch }) => {
  installStub(home.project, '3.3.3', 5000);
  const file = write(home, 'a.ts', 'const a=1\n');
  const { app, shell } = await openFile(home, launch, 'a.ts');
  await typeAtEnd(shell, 'const b=2');
  const started = Date.now();
  await saveWithKeyboard(app);
  await expect(shell.getByTestId('editor-formatting')).toBeVisible();
  await expect.poll(() => fs.readFileSync(file, 'utf8'), { timeout: 10_000 }).toBe('const a=1\nconst b=2');
  expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
  await expect(shell.getByTestId('editor-formatting')).toBeHidden();
  await expect.poll(async () => (await noticesMatching(app, 'took longer than 3 seconds')).length).toBe(1);
  const [notice] = await noticesMatching(app, 'took longer than 3 seconds');
  expect(notice).toMatchObject({ message: 'Prettier took longer than 3 seconds on a.ts and was stopped. The file was saved unformatted.', actions: ['Show Output'] });
  await expect.poll(() => mainLog(home)).toContain('took longer than 3000 ms');

  await answerToast(app, notice!.id, 'Show Output');
  await expect.poll(async () => (await activeTab(app))?.kind).toBe('log');
  expect((await activeTab(app))?.title).toBe('Format.log');
  await editorShows(shell, 'a.ts: Prettier 3.3.3 took longer than 3000 ms and was stopped');
});

test('a .prettierrc without an installed Prettier formats nothing, and the notice says why', async ({ home, launch }) => {
  fs.writeFileSync(path.join(home.project, '.prettierrc'), '{}');
  const file = write(home, 'data.json', '{"a":1}');
  const { app, shell } = await openFile(home, launch, 'data.json');
  await typeAtEnd(shell, ' ');
  await saveWithKeyboard(app);
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('{"a":1} ');
  await expect.poll(async () => (await noticesMatching(app, 'configured in this project but not installed')).map((notice) => notice.message))
    .toEqual(['Prettier is configured in this project but not installed, so data.json was not formatted. Install the project\'s dependencies to format it.']);
});

test('without Prettier a JSON file formats with Monaco\'s built-in formatter', async ({ home, launch }) => {
  const file = write(home, 'data.json', '{"a":1,"b":[1,2]}');
  const { desktop, app, shell } = await openFile(home, launch, 'data.json');
  await typeAtEnd(shell, ' ');
  await saveWithKeyboard(app);
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('\n');
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 1, b: [1, 2] });
  expect(fs.readFileSync(file, 'utf8')).toMatch(/^\{\r?\n {4}"a": 1,/);
  await desktop.close();
  expect(logBeforeQuit(home)).not.toContain(HOST_STARTED);
});

test('without Prettier a .ts file formats with the TypeScript worker\'s built-in formatter', async ({ home, launch }) => {
  const file = write(home, 'a.ts', 'const a=1\n');
  const { desktop, app, shell } = await openFile(home, launch, 'a.ts');
  await typeAtEnd(shell, 'const b=[1,2]');
  await saveWithKeyboard(app);
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('const a = 1\nconst b = [1, 2]');
  expect(shell.workers().some((worker) => /\/desktop-shell\/assets\/worker-ts\.worker\.js$/.test(worker.url()))).toBe(true);
  await desktop.close();
  expect(logBeforeQuit(home)).not.toContain('the built-in formatter failed');
});

test('a file listed in .prettierignore saves unchanged', async ({ home, launch }) => {
  installStub(home.project, '3.3.3');
  fs.writeFileSync(path.join(home.project, '.prettierignore'), 'skip.ts\n');
  const file = write(home, 'skip.ts', 'const a=1\n');
  const { app, shell } = await openFile(home, launch, 'skip.ts');
  await typeAtEnd(shell, 'const b=2');
  await saveWithKeyboard(app);
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('const a=1\nconst b=2');
  await expect(editorTab(shell, 'skip.ts')).not.toHaveAttribute('data-dirty', 'true');
  await expect.poll(() => mainLog(home)).toContain(HOST_STARTED);
});

test('auto save after delay never formats', async ({ home, launch }) => {
  installStub(home.project, '3.3.3');
  const file = write(home, 'a.ts', 'const a=1\n');
  const { desktop, shell } = await openFile(home, launch, 'a.ts', { settings: { 'damocles.desktop.editor.autoSave': 'afterDelay' } });
  await typeAtEnd(shell, 'const b=2');
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('const a=1\nconst b=2');
  await expect(editorTab(shell, 'a.ts')).not.toHaveAttribute('data-dirty', 'true');
  await desktop.close();
  expect(logBeforeQuit(home)).not.toContain(HOST_STARTED);
});

test('a Prettier in a parent folder of the project is not used, and the notice names its path', async ({ home, launch }) => {
  const parentPrettier = installStub(path.dirname(home.project), '3.3.3');
  const file = write(home, 'a.ts', 'const a=1\n');
  const { desktop, app, shell } = await openFile(home, launch, 'a.ts');
  await typeAtEnd(shell, 'const b=2');
  await saveWithKeyboard(app);
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('const a=1\nconst b=2');
  await expect.poll(async () => (await noticesMatching(app, 'The nearest Prettier is outside the project')).map((notice) => notice.message))
    .toEqual([`Prettier was not run on a.ts. The nearest Prettier is outside the project, at ${parentPrettier}. Add the folder that holds it as a project to use it.`]);
  await desktop.close();
  expect(logBeforeQuit(home)).not.toContain(HOST_STARTED);
});

test('a Prettier config found only in a parent folder never runs, and the notice names it', async ({ home, launch }) => {
  installStub(home.project, '3.3.3');
  const marker = path.join(path.dirname(home.project), 'config-ran');
  const parentConfig = path.join(path.dirname(home.project), 'prettier.config.js');
  fs.writeFileSync(parentConfig, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); module.exports = {};`);
  const file = write(home, 'a.ts', 'const a=1\n');
  const { desktop, app, shell } = await openFile(home, launch, 'a.ts');
  await typeAtEnd(shell, 'const b=2');
  await saveWithKeyboard(app);
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('const a=1\nconst b=2');
  await expect.poll(async () => (await noticesMatching(app, 'Its nearest config is outside the project')).map((notice) => notice.message))
    .toEqual([`Prettier was not run on a.ts. Its nearest config is outside the project, at ${parentConfig}. Add a Prettier config to this project, or add the folder that holds that config as a project.`]);
  expect(fs.existsSync(marker)).toBe(false);
  await desktop.close();
  expect(logBeforeQuit(home)).not.toContain(HOST_STARTED);
});

test('a folder named .prettierrc is no config, so a parent folder\'s config behind it is refused and never runs', async ({ home, launch }) => {
  installStub(home.project, '3.3.3');
  fs.mkdirSync(path.join(home.project, '.prettierrc'));
  const marker = path.join(path.dirname(home.project), 'config-ran');
  const parentConfig = path.join(path.dirname(home.project), 'prettier.config.js');
  fs.writeFileSync(parentConfig, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); module.exports = {};`);
  const file = write(home, 'a.ts', 'const a=1\n');
  const { app, shell } = await openFile(home, launch, 'a.ts');
  await typeAtEnd(shell, 'const b=2');
  await saveWithKeyboard(app);
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('const a=1\nconst b=2');
  await expect.poll(async () => (await noticesMatching(app, 'Its nearest config is outside the project')).length).toBe(1);
  expect(fs.existsSync(marker)).toBe(false);
});

for (const version of ['2.8.8', '3.3.3']) {
  test(`Prettier ${version}: a plugin the project's config names that resolves outside the project never loads, and the notice names it`, async ({ home, launch }) => {
    installStub(home.project, version);
    const parent = path.dirname(home.project);
    const pluginDir = path.join(parent, 'node_modules', 'prettier-plugin-outside');
    const marker = path.join(parent, 'plugin-ran');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'prettier-plugin-outside', main: 'index.js' }));
    fs.writeFileSync(path.join(pluginDir, 'index.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); module.exports = {};`);
    fs.writeFileSync(path.join(home.project, '.prettierrc'), JSON.stringify({ plugins: ['prettier-plugin-outside'] }));
    const file = write(home, 'a.ts', 'const a=1\n');
    const { app, shell } = await openFile(home, launch, 'a.ts');
    await typeAtEnd(shell, 'const b=2');
    await saveWithKeyboard(app);
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('const a=1\nconst b=2');
    const plugin = fs.realpathSync.native(path.join(pluginDir, 'index.js'));
    await expect.poll(async () => (await noticesMatching(app, 'so it was not loaded')).map((notice) => notice.message))
      .toEqual([`Prettier could not format a.ts: it needs ${plugin}, which is outside the project, so it was not loaded. Install it in this project, or add the folder that holds it as a project.`]);
    expect(fs.existsSync(marker)).toBe(false);
  });
}

test('Format Document (Shift+Alt+F) formats the buffer without saving it', async ({ home, launch }) => {
  installStub(home.project, '3.3.3');
  const file = write(home, 'a.ts', 'const a=1\n');
  const { app, shell } = await openFile(home, launch, 'a.ts', { settings: { [FORMAT_ON_SAVE]: false } });
  await formatDocumentShortcut(app);
  await expect.poll(() => bufferText(shell)).toBe('const a = 1;\n');
  await expect(editorTab(shell, 'a.ts')).toHaveAttribute('data-dirty', 'true');
  expect(fs.readFileSync(file, 'utf8')).toBe('const a=1\n');
  // With format on save off, Ctrl+S then saves the buffer as it is.
  await pressKeys(app, '/shell/', 'S', [PRIMARY]);
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('const a = 1;\n');
});
