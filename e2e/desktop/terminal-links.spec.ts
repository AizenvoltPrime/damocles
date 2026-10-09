import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { openProjectChat, settled } from './support/screenshots';
import { activeTab, codeEditor, editorShows, filesRow, quickPick } from './support/editor';
import { readyOverlay } from './support/overlay';
import { shellState, viewFocused } from './support/shell';
import {
  activeTerminal,
  echoCommand,
  hoverTerminalText,
  linkHint,
  linkUnderline,
  openTerminal,
  runInTerminal,
  terminalText,
  useTestProfile,
} from './support/terminal';

const MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';
// The shell draws its prompt last, so once it shows below a command's output no row moves until the next command. cmd.exe
// reports no prompt end (OSC 633 B), so each shell gets a prompt whose text is the sign.
const PROMPT = 'links-e2e>';
const SET_PROMPT = process.platform === 'win32' ? 'prompt links-e2e$G' : `PS1='${PROMPT}'`;

function write(root: string, relative: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), text);
}

async function launchWithTerminal(home: Parameters<typeof useTestProfile>[0], launch: () => Promise<{ app: ElectronApplication }>): Promise<{ app: ElectronApplication; shell: Page }> {
  useTestProfile(home);
  write(home.project, 'src/app.ts', Array.from({ length: 60 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n'));
  write(home.project, 'src/lib/util.ts', 'export {};\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openTerminal(app);
  await runInTerminal(shell, SET_PROMPT);
  await expect.poll(async () => (await shownRows(shell)).at(-1)).toBe(PROMPT);
  return { app, shell };
}

/** The active terminal's rows that hold text, top to bottom. */
async function shownRows(shell: Page): Promise<string[]> {
  return (await terminalText(shell)).split('\n').filter((row) => row !== '');
}

/** Runs `command` and waits until the shell has drawn its prompt right below `output`, the command's last line. */
async function runToPrompt(shell: Page, command: string, output: string): Promise<void> {
  await runInTerminal(shell, command);
  await expect.poll(async () => (await shownRows(shell)).slice(-2)).toEqual([output, PROMPT]);
}

/** Prints `line` in the active terminal and returns once the rows hold still, so a hover lands on the row it measured. */
async function print(shell: Page, line: string): Promise<void> {
  await runToPrompt(shell, echoCommand(line), line);
}

/** The 1-based column Monaco's caret sits at on the line holding `text`, from the caret's offset in that line's glyphs. */
async function caretColumn(shell: Page, text: string): Promise<number> {
  return codeEditor(shell).evaluate((editor, wanted) => {
    const line = [...editor.querySelectorAll<HTMLElement>('.view-line')].find((row) => row.textContent?.replace(/\u00a0/g, ' ').includes(wanted));
    const glyphs = line?.querySelector('span');
    const caret = editor.querySelector<HTMLElement>('.cursors-layer .cursor');
    if (!glyphs || !caret || !glyphs.textContent) return -1;
    const box = glyphs.getBoundingClientRect();
    return Math.round((caret.getBoundingClientRect().left - box.left) / (box.width / glyphs.textContent.length)) + 1;
  }, text);
}

test('a printed path:line:col underlines on hover, shows the Ctrl+click hint, and Ctrl+click opens the file at that line and column', async ({ foreground: _foreground, home, launch }) => {
  const { app, shell } = await launchWithTerminal(home, launch);
  await print(shell, 'src/app.ts:42:7');

  await hoverTerminalText(shell, 'src/app.ts:42:7', 'app.ts');
  await expect(linkUnderline(shell)).toHaveCount(1);
  await expect(linkHint(shell)).toBeVisible();
  await expect(linkHint(shell)).toHaveAttribute('data-kind', 'file');
  await expect(linkHint(shell)).toHaveText(process.platform === 'darwin' ? '⌘+click to open' : 'Ctrl+click to open');
  // The underline spans the whole link, its line and column included, and the hint stays inside the terminal's box.
  const [underline, hint, view] = await Promise.all([linkUnderline(shell).boundingBox(), linkHint(shell).boundingBox(), activeTerminal(shell).boundingBox()]);
  const cell = await activeTerminal(shell).evaluate((element) => element.querySelector('.xterm-screen')!.getBoundingClientRect().width / Number(element.getAttribute('data-cols')));
  expect(Math.round(underline!.width / cell)).toBe('src/app.ts:42:7'.length);
  expect(hint!.x).toBeGreaterThanOrEqual(view!.x);
  expect(hint!.x + hint!.width).toBeLessThanOrEqual(view!.x + view!.width);
  expect(hint!.y + hint!.height).toBeLessThanOrEqual(view!.y + view!.height);

  // The pointer shows only while the modifier is held, as VS Code's links do; a plain click opens nothing.
  await expect(activeTerminal(shell).locator('.xterm-cursor-pointer')).toHaveCount(0);
  await shell.keyboard.down(MODIFIER);
  await expect(activeTerminal(shell).locator('.xterm-cursor-pointer')).toHaveCount(1);
  await shell.keyboard.up(MODIFIER);
  await shell.mouse.down();
  await shell.mouse.up();
  expect(await activeTab(app)).toBeUndefined();

  await hoverTerminalText(shell, 'src/app.ts:42:7', 'app.ts');
  await expect(linkUnderline(shell)).toHaveCount(1);
  await shell.keyboard.down(MODIFIER);
  await shell.mouse.down();
  await shell.mouse.up();
  await shell.keyboard.up(MODIFIER);
  await expect.poll(async () => (await activeTab(app))?.relativePath).toBe('src/app.ts');
  await editorShows(shell, 'line42 = 42');
  const lineTop = await codeEditor(shell).locator('.view-line', { hasText: 'line42 = 42' }).evaluate((line) => (line as HTMLElement).style.top);
  await expect.poll(() => codeEditor(shell).locator('.view-overlays .current-line').first().evaluate((highlight) => (highlight.parentElement as HTMLElement).style.top)).toBe(lineTop);
  await expect.poll(() => caretColumn(shell, 'line42 = 42')).toBe(7);
  // Opening a link is a user action, so the editor takes keyboard focus.
  await expect.poll(() => codeEditor(shell).evaluate((editor) => editor.contains(document.activeElement))).toBe(true);
  expect(await viewFocused(app, shell)).toBe(true);
});

test('a path outside the project, a missing file and a ../ escape are never links, and a folder link reveals it in Files, showing a hidden sidebar', async ({ foreground: _foreground, home, launch }) => {
  const outside = path.join(home.root, 'outside.ts');
  fs.writeFileSync(outside, 'secret\n');
  write(path.dirname(home.project), 'escape.ts', 'secret\n');
  const { shell } = await launchWithTerminal(home, launch);
  // Each non-link prints under the folder link, which resolves: a positive control that main answers this terminal's links.
  for (const line of [`${outside}:1`, 'src/missing.ts:3:1', '../escape.ts:1']) {
    await runInTerminal(shell, process.platform === 'win32' ? 'cls' : 'clear');
    // The last pass's rows stay on screen until the clear's output arrives, which on a loaded runner is after the next command is typed.
    await expect.poll(() => shownRows(shell)).toEqual([PROMPT]);
    await print(shell, 'src/lib');
    await print(shell, line);
    await hoverTerminalText(shell, 'src/lib', 'lib');
    await expect(linkUnderline(shell)).toHaveCount(1);
    await expect(linkHint(shell)).toHaveAttribute('data-kind', 'folder');
    await hoverTerminalText(shell, line, line.slice(2, 6));
    // The line stays plain once main has answered its link request.
    await expect(activeTerminal(shell)).toHaveAttribute('data-links-provided-for', line);
    await expect(linkUnderline(shell)).toHaveCount(0);
    await expect(linkHint(shell)).toHaveCount(0);
  }

  // A hidden sidebar shows for the reveal, as VS Code's reveal opens the side bar.
  const cols = await activeTerminal(shell).getAttribute('data-cols');
  await shell.getByTestId('toggle-sidebar').click();
  await expect(shell.getByTestId('sidebar')).toHaveAttribute('inert', '');
  // The grid widens as the sidebar slides out, and the terminal reflows to it.
  await expect(activeTerminal(shell)).not.toHaveAttribute('data-cols', cols ?? '');
  await settled(shell);
  await hoverTerminalText(shell, 'src/lib', 'lib');
  await expect(linkUnderline(shell)).toHaveCount(1);
  await shell.keyboard.down(MODIFIER);
  await shell.mouse.down();
  await shell.mouse.up();
  await shell.keyboard.up(MODIFIER);
  await expect(shell.getByTestId('sidebar')).not.toHaveAttribute('inert');
  await expect(filesRow(shell, 'src/lib')).toBeFocused();
  await expect(filesRow(shell, 'src')).toHaveAttribute('aria-expanded', 'true');
});

test('a folder link into a project Files does not show opens Quick Open on that folder, and its pick opens in the editor with the chat and Files left as they were', async ({ foreground: _foreground, home, launch }) => {
  write(home.project, 'src/lib/extra.ts', 'export {};\n');
  const { app, shell } = await launchWithTerminal(home, launch);
  const terminalProject = (await shellState(app)).selected.projectKey;
  // Another project's chat is selected, so Files shows that project; the terminal stays in the first one.
  const web = path.join(home.root, 'web');
  write(web, 'index.ts', 'export {};\n');
  await openProjectChat(app, web);
  const selected = (await shellState(app)).selected;
  expect(selected.projectKey).not.toBe(terminalProject);
  await expect(filesRow(shell, 'index.ts')).toBeVisible();

  await print(shell, 'src/lib');
  await hoverTerminalText(shell, 'src/lib', 'lib');
  await expect(linkUnderline(shell)).toHaveCount(1);
  await shell.keyboard.down(MODIFIER);
  await shell.mouse.down();
  await shell.mouse.up();
  await shell.keyboard.up(MODIFIER);

  const overlay = await readyOverlay(app);
  await expect(quickPick(overlay)).toBeVisible();
  await expect(overlay.getByTestId('quick-pick-scope')).toContainText(`${path.basename(home.project)} / src/lib/`);
  await expect(overlay.getByTestId('quick-pick-input')).toBeFocused();
  await expect(quickPick(overlay).getByTestId('quick-pick-item')).toHaveCount(2);
  await expect(quickPick(overlay).getByTestId('quick-pick-item').nth(0)).toContainText('extra.ts');
  await expect(quickPick(overlay).getByTestId('quick-pick-item').nth(1)).toContainText('util.ts');
  await overlay.getByTestId('quick-pick-input').fill('util');
  await expect(quickPick(overlay).getByTestId('quick-pick-item')).toHaveCount(1);
  await overlay.getByTestId('quick-pick-input').press('Enter');

  await expect.poll(async () => {
    const tab = await activeTab(app);
    return tab && `${tab.projectKey}:${tab.relativePath}`;
  }).toBe(`${terminalProject}:src/lib/util.ts`);
  expect((await shellState(app)).selected).toEqual(selected);
  await expect(filesRow(shell, 'index.ts')).toBeVisible();
});

// OSC 8 hyperlinks, as GCC prints its diagnostics' documentation links: the text, not the URL, shows. \x5c is the backslash
// of the string terminator, which a POSIX shell would unescape inside double quotes.
const HYPERLINK_LINE = 'see docs page for more';
const HYPERLINK_COMMAND = 'node -e "process.stdout.write(\'see \\x1b]8;;https://example.com/docs\\x1b\\x5cdocs page\\x1b]8;;\\x1b\\x5c for more\\n\')"';

test('an OSC 8 hyperlink shows the web link hint, and a plain click asks nothing', async ({ foreground: _foreground, home, launch }) => {
  const { shell } = await launchWithTerminal(home, launch);
  const dialogs: string[] = [];
  shell.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await runToPrompt(shell, HYPERLINK_COMMAND, HYPERLINK_LINE);
  await hoverTerminalText(shell, HYPERLINK_LINE, 'docs page');
  await expect(linkHint(shell)).toHaveAttribute('data-kind', 'web');
  await shell.mouse.down();
  await shell.mouse.up();
  await expect(linkHint(shell)).toHaveAttribute('data-kind', 'web');
  expect(dialogs).toEqual([]);
});

test('a web link shows its own hint and only http and https are links', async ({ foreground: _foreground, home, launch }) => {
  const { shell } = await launchWithTerminal(home, launch);
  await print(shell, 'docs https://example.com/guide');
  await print(shell, 'ftp://example.com/file');
  await hoverTerminalText(shell, 'docs https://example.com/guide', 'example');
  await expect(linkHint(shell)).toHaveAttribute('data-kind', 'web');
  await hoverTerminalText(shell, 'ftp://example.com/file', 'example');
  await expect(activeTerminal(shell)).toHaveAttribute('data-links-provided-for', 'ftp://example.com/file');
  await expect(linkHint(shell)).toHaveCount(0);
});
