import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { writeUserSettings, type HermeticHome } from './support/hermetic';
import { overlayPage, pressKeys, PRIMARY, shellPage, shellState } from './support/shell';
import { activeTab, codeEditor, conflictBar, DOCUMENT_END, editorShows, editorTab, filesRow, openInEditor, quickOpen, quickPick, saveWithKeyboard, untilWatchLive } from './support/editor';
import { activeTerminal, openTerminal, runInTerminal, terminalText, waitForOutputLine } from './support/terminal';
import { projectRow } from './support/shell-ui';
import { setReducedMotion, showShellTheme } from './support/screenshots';
import { installPrettierStub } from './support/prettier';
import { answerDialogs, clickMenu } from './support/ui';
import { cleanUp, daemonPid, endLeftoverDaemon, filesUnder, listRuns, LOCAL_DAEMON, LOOPBACK_ENV, LOOPBACK_TAG, openThroughLocalDaemon, pidIn, REVIEW_SHOTS, serverDir, shutdownDaemon } from './support/loopback';

const windows = process.platform === 'win32';
// An integrated shell each leg has for sure.
const INTEGRATED = windows ? 'windows-powershell' : 'bash';
// A date loop, numbered so a gap or a repeat across the relaunch shows.
const DATE_LOOP = windows
  ? '$i = 0; while ($true) { $i++; Write-Output "tick $i $(Get-Date -Format HH:mm:ss)"; Start-Sleep 1 }'
  : 'i=0; while true; do i=$((i+1)); echo "tick $i $(date +%T)"; sleep 1; done';

function write(root: string, relativePath: string, content: string): string {
  const file = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// A folder outside the hermetic project, so the loopback project and the local one are told apart in every list.
function remoteFolder(home: HermeticHome): string {
  const folder = path.join(home.root, 'p', 'remote');
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

const ticks = (text: string): number[] => [...text.matchAll(/^tick (\d+) /gm)].map((match) => Number(match[1]));

async function stores(home: HermeticHome): Promise<{ projects: string; trust: string }> {
  const read = (name: string): string => (fs.existsSync(path.join(home.userData, name)) ? fs.readFileSync(path.join(home.userData, name), 'utf8') : '');
  return { projects: read('projects.json'), trust: read('trusted-folders.json') };
}

async function shootBadge(shell: Page, key: string, name: string): Promise<void> {
  if (REVIEW_SHOTS === undefined) return;
  fs.mkdirSync(REVIEW_SHOTS, { recursive: true });
  await projectRow(shell, key).screenshot({ path: path.join(REVIEW_SHOTS, `${name}.png`), animations: 'disabled' });
}

async function typeAtEnd(shell: Page, text: string): Promise<void> {
  await codeEditor(shell).locator('.view-line').first().click();
  await shell.keyboard.press(DOCUMENT_END);
  await shell.keyboard.type(text);
}

test('a folder opened through the local daemon has its host badge, and its files, editor, search, Quick Open, format on save and terminal run through the daemon', { tag: LOOPBACK_TAG }, async ({ foreground: _foreground, home, launch }, testInfo) => {
  test.setTimeout(300_000);
  writeUserSettings(home, {
    'damocles.desktop.terminal.defaultProfile': INTEGRATED,
    'damocles.desktop.terminal.confirmOnKill': 'never',
    'damocles.desktop.editor.formatOnSave': true,
  });
  const folder = remoteFolder(home);
  write(folder, 'src/remote.ts', 'export const remote = "needle";\n');
  write(folder, 'notes.md', '# Notes\n');
  const { app } = await launch(LOOPBACK_ENV);
  let failure: unknown;
  try {
    const shell = await shellPage(app);
    const before = await stores(home);

    const key = await openThroughLocalDaemon(app, folder);
    expect(key.startsWith('loopback|')).toBe(true);
    const project = (await shellState(app)).projects.find((candidate) => candidate.key === key)!;
    expect(project).toMatchObject({ authority: { kind: 'loopback', name: LOCAL_DAEMON }, connection: 'connected', trusted: true });
    // The badge names the host, and the dot's name says its state in words, so it never rests on colour.
    const badge = projectRow(shell, key).getByTestId('host-badge');
    await expect(badge).toContainText(LOCAL_DAEMON);
    await expect(badge.getByRole('img', { name: `${LOCAL_DAEMON}, Connected` })).toHaveAttribute('data-connection', 'connected');
    if (REVIEW_SHOTS !== undefined) {
      for (const theme of ['dark', 'light'] as const) {
        await showShellTheme(app, theme);
        await shootBadge(shell, key, `badge-connected-${theme}`);
      }
      await setReducedMotion(app, true);
      await shootBadge(shell, key, 'badge-connected-reduced-motion');
      await setReducedMotion(app, false);
    }
    // projects.json and trusted-folders.json keep their local entries only; the loopback project and its trust are elsewhere.
    expect(await stores(home)).toEqual(before);
    expect(JSON.parse(fs.readFileSync(path.join(home.userData, 'remote-hosts.json'), 'utf8')).authorities.loopback.trusted).toHaveLength(1);

    // Files: create, rename, and a delete that is permanent after one confirmation saying so.
    await expect(filesRow(shell, 'src')).toBeVisible();
    expect(await shell.evaluate((projectKey) => window.damoclesShell!.createFile({ projectKey, relativeDir: '', name: 'made.txt', kind: 'file' }), key)).toEqual({ ok: true, relativePath: 'made.txt' });
    await expect.poll(() => fs.existsSync(path.join(folder, 'made.txt'))).toBe(true);
    expect(await shell.evaluate((projectKey) => window.damoclesShell!.renameFile({ projectKey, relativePath: 'made.txt', newName: 'renamed.txt' }), key)).toEqual({ ok: true, relativePath: 'renamed.txt' });
    await expect.poll(() => fs.existsSync(path.join(folder, 'renamed.txt'))).toBe(true);
    await expect(filesRow(shell, 'renamed.txt')).toBeVisible();
    const overlay = await overlayPage(app);
    const dialog = overlay.getByRole('alertdialog');
    const deleted = shell.evaluate((projectKey) => window.damoclesShell!.deleteFile({ projectKey, relativePath: 'renamed.txt' }), key);
    await expect(dialog).toContainText(`It is deleted permanently on ${LOCAL_DAEMON}, which has no trash. This action is irreversible.`);
    await expect(dialog.getByRole('button', { name: 'Move to Trash' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Delete Permanently' }).click();
    expect(await deleted).toEqual({ ok: true });
    expect(fs.existsSync(path.join(folder, 'renamed.txt'))).toBe(false);
    await expect(filesRow(shell, 'renamed.txt')).toHaveCount(0);

    // Editor: open, edit, save; a change on disk under a dirty buffer is a conflict; a file deleted on disk leaves its tab Deleted.
    expect(await openInEditor(app, { projectKey: key, relativePath: 'notes.md' })).toMatchObject({ ok: true });
    await editorShows(shell, '# Notes');
    await typeAtEnd(shell, 'more');
    await saveWithKeyboard(app);
    await expect.poll(() => fs.readFileSync(path.join(folder, 'notes.md'), 'utf8')).toBe('# Notes\nmore');
    await typeAtEnd(shell, ' dirty');
    fs.writeFileSync(path.join(folder, 'notes.md'), '# Changed on disk\n');
    await saveWithKeyboard(app);
    await expect(conflictBar(shell)).toBeVisible();
    fs.rmSync(path.join(folder, 'notes.md'));
    await expect(editorTab(shell, 'notes.md')).toHaveAttribute('data-deleted', 'true');

    // Format on save: the project's Prettier, resolved and run by the daemon's formatter host.
    installPrettierStub(folder, '3.3.3');
    const formatted = write(folder, 'fmt.ts', 'const a=1\n');
    expect(await openInEditor(app, { projectKey: key, relativePath: 'fmt.ts' })).toMatchObject({ ok: true });
    await editorShows(shell, 'const a=1');
    await typeAtEnd(shell, 'let b  =2');
    await saveWithKeyboard(app);
    await expect.poll(() => fs.readFileSync(formatted, 'utf8')).toBe('const a = 1;\nlet b = 2;\n');

    // Search and replace, and Quick Open, list the daemon's ripgrep results.
    await pressKeys(app, '/shell/', 'H', [PRIMARY, 'shift']);
    await shell.getByTestId('search-query').fill('needle');
    await shell.getByTestId('search-query').press('Enter');
    await expect(shell.locator('[data-testid="search-row"][data-row-kind="file"][data-path="src/remote.ts"]')).toBeVisible();
    await shell.getByTestId('search-replace').fill('found');
    await shell.getByTestId('search-replace-all').click();
    await overlay.getByRole('alertdialog').getByRole('button', { name: 'Replace', exact: true }).click();
    await expect.poll(() => fs.readFileSync(path.join(folder, 'src', 'remote.ts'), 'utf8')).toBe('export const remote = "found";\n');
    const picker = quickPick(await quickOpen(app, 'remote'));
    await expect(picker.locator('[data-testid="quick-pick-item"]', { hasText: 'remote.ts' })).toBeVisible();
    await overlay.keyboard.press('Escape');

    // A terminal in the loopback project has shell integration, survives a page reload, and control.listRuns lists it.
    const terminalShell = await openTerminal(app);
    const state = await terminalShell.evaluate(() => window.damoclesShell!.terminal.getState());
    const terminal = state.terminals.find((candidate) => candidate.id === state.activeId)!;
    expect(terminal.projectKey).toBe(key);
    expect(terminal.id).toMatch(/^term-[1-9]\d{14}$/);
    // the daemon's Windows build, which its pty host's screen gives xterm too
    expect(terminal.windowsBuild === null).toBe(!windows);
    await expect.poll(async () => (await terminalShell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals.find((candidate) => candidate.id === terminal.id)?.integrated, { timeout: 30_000 }).toBe(true);
    await runInTerminal(terminalShell, windows ? 'Write-Output loopback-ok-1f' : 'echo loopback-ok-1f');
    await waitForOutputLine(terminalShell, 'loopback-ok-1f');
    await terminalShell.reload();
    await expect(activeTerminal(terminalShell)).toHaveAttribute('data-status', 'running');
    await expect.poll(async () => (await terminalText(terminalShell)).split('\n').filter((row) => row === 'loopback-ok-1f')).toHaveLength(1);
    expect((await listRuns(app)).runs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'terminal', id: terminal.id, state: 'running' })]));

    // Show log: the daemon's log read through control logs.read, as a read-only text tab named with the host.
    await clickMenu(app, 'damocles.developer.showLocalDaemonLog');
    await expect(editorTab(shell, `${LOCAL_DAEMON}: daemon.log`)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await activeTab(app))?.readOnlyReason).toBe('outsideProject');
    await expect(codeEditor(shell).locator('.view-line').first()).toBeVisible();

    // Every file the daemon wrote is in the test home under userData; a daemon of the real ~/.damocles, if one runs, is not it.
    expect(filesUnder(serverDir(home)).some((file) => file.endsWith('daemon.pid'))).toBe(true);
    expect(filesUnder(serverDir(home)).some((file) => file.endsWith('daemon.log'))).toBe(true);
    expect(fs.existsSync(path.join(home.damoclesDir, 'server'))).toBe(false);
    expect(await pidIn(os.homedir())).not.toBe(await daemonPid(home));

    // Teardown: no daemon, pty host or formatter process is left; the dot turns red with its own glyph and words.
    await shutdownDaemon(app, home);
    await expect(badge.getByRole('img', { name: `${LOCAL_DAEMON}, Couldn't connect` })).toHaveAttribute('data-connection', 'failed');
    if (REVIEW_SHOTS !== undefined) {
      for (const theme of ['dark', 'light'] as const) {
        await showShellTheme(app, theme);
        await shootBadge(shell, key, `badge-failed-${theme}`);
      }
    }
    // the quit's question about the conflicted buffer, whose text the test leaves unsaved
    await answerDialogs(app, { 'Do you want to save': "Don't Save" });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // a test that failed midway still ends its daemon
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
  }
});

test('a loopback terminal running a date loop survives an app quit and relaunch, with no gap and no line twice', { tag: LOOPBACK_TAG }, async ({ foreground: _foreground, home, launch }, testInfo) => {
  test.setTimeout(300_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': INTEGRATED, 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const folder = remoteFolder(home);
  const first = await launch(LOOPBACK_ENV);
  // the app that can still reach the daemon, for the finally
  let current = first.app;
  let failure: unknown;
  try {
    const key = await openThroughLocalDaemon(first.app, folder);
    const shell = await openTerminal(first.app);
    const id = await activeTerminal(shell).getAttribute('data-terminal-id');
    await runInTerminal(shell, DATE_LOOP);
    await expect.poll(async () => ticks(await terminalText(shell)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    // The quit asks nothing about a terminal on the daemon, and ends neither it nor the daemon.
    await first.close();

    const second = await launch(LOOPBACK_ENV);
    current = second.app;
    const again = await reattached(second.app, key, id!);
    await expect.poll(async () => ticks(await terminalText(again)).at(-1) ?? 0, { timeout: 30_000 }).toBeGreaterThan(8);
    const seen = ticks(await terminalText(again));
    // contiguous and each once: the screen the daemon kept, then live output, with nothing lost or repeated between them
    expect(seen).toEqual(Array.from({ length: seen.length }, (_, n) => seen[0]! + n));
    // the kept screen holds the scrollback: scrolled up to the loop's command, the buffer starts at its first tick
    await expect.poll(async () => {
      await clickMenu(second.app, 'damocles.terminal.scrollToPreviousCommand');
      return ticks(await terminalText(again))[0];
    }, { timeout: 30_000, intervals: [500] }).toBe(1);
    const top = ticks(await terminalText(again));
    expect(top).toEqual(Array.from({ length: top.length }, (_, n) => 1 + n));
    expect((await listRuns(second.app)).runs.map((run) => run.id)).toContain(id);

    // Files watches the project, and an editor holds one of its files, before the connection drops.
    await again.evaluate((projectKey) => window.damoclesShell!.selectProject(projectKey), key);
    await untilWatchLive(again, folder);
    const kept = write(folder, 'kept.md', 'before the drop\n');
    expect(await openInEditor(second.app, { projectKey: key, relativePath: 'kept.md' })).toMatchObject({ ok: true });
    const keptId = (await activeTab(second.app))!.documentId!;
    const keptText = (): Promise<string> => again.evaluate(async (id) => {
      const content = await window.damoclesShell!.getDocument(id);
      return content.kind === 'text' ? content.text : '';
    }, keptId);
    await expect.poll(keptText).toBe('before the drop\n');

    // A dropped connection exits the tab; selecting the project connects again, the terminal, still running on the daemon,
    // comes back live in this window with its screen, Files sees changes again, and the open file takes what changed meanwhile.
    await dropConnection(second.app, key);
    await expect(activeTerminal(again)).toHaveAttribute('data-status', 'exited');
    fs.writeFileSync(kept, 'changed while away\n');
    await again.evaluate((projectKey) => window.damoclesShell!.selectProject(projectKey), key);
    const back = await reattached(second.app, key, id!);
    await expect(activeTerminal(back)).toHaveAttribute('data-status', 'running');
    await untilWatchLive(back, folder);
    await expect.poll(keptText, { timeout: 30_000 }).toBe('changed while away\n');
    const before = ticks(await terminalText(back)).at(-1) ?? 0;
    await expect.poll(async () => ticks(await terminalText(back)).at(-1) ?? 0, { timeout: 30_000 }).toBeGreaterThan(before + 1);
    const resumed = ticks(await terminalText(back));
    expect(resumed).toEqual(Array.from({ length: resumed.length }, (_, n) => resumed[0]! + n));

    // With a split pane beside it, the next drop and reconnect put both terminals back in their group.
    await back.evaluate((terminalId) => window.damoclesShell!.terminal.split(terminalId), id!);
    await expect.poll(async () => (await terminalLayout(back)).statuses, { timeout: 30_000 }).toEqual(['running', 'running']);
    const split = (await terminalLayout(back)).groups;
    await dropConnection(second.app, key);
    await back.evaluate((projectKey) => window.damoclesShell!.selectProject(projectKey), key);
    await expect.poll(() => terminalLayout(back), { timeout: 60_000 }).toEqual({ groups: split, statuses: ['running', 'running'] });
    await shutdownDaemon(second.app, home);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(current, home));
  }
});

interface DropHooks {
  __damoclesE2e: { loopback: { dropConnection(): void } };
}

// Drops the loopback connection and waits until the project no longer shows it connected.
async function dropConnection(app: ElectronApplication, key: string): Promise<void> {
  await app.evaluate(() => (globalThis as unknown as DropHooks).__damoclesE2e.loopback.dropConnection());
  await expect.poll(async () => (await shellState(app)).projects.find((project) => project.key === key)?.connection).not.toBe('connected');
}

// The terminals' groups (without the active pane, which a selection moves) and statuses, in list order.
async function terminalLayout(shell: Page): Promise<{ groups: unknown[]; statuses: string[] }> {
  const state = await shell.evaluate(() => window.damoclesShell!.terminal.getState());
  return { groups: state.groups.map((group) => ({ id: group.id, paneIds: group.paneIds, sizes: group.sizes })), statuses: state.terminals.map((terminal) => terminal.status) };
}

// The relaunched window's terminal with the same id, once its screen is back.
async function reattached(app: ElectronApplication, key: string, id: string): Promise<Page> {
  await expect.poll(async () => (await shellState(app)).projects.find((project) => project.key === key)?.connection, { timeout: 60_000 }).toBe('connected');
  const shell = await shellPage(app);
  await expect.poll(async () => (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals.map((terminal) => terminal.id), { timeout: 30_000 }).toContain(id);
  await shell.evaluate((terminalId) => window.damoclesShell!.terminal.select(terminalId), id);
  const terminals = await shellState(app);
  if (!terminals.layout.grid.visible.terminal) await pressKeys(app, '/shell/', 'J', [PRIMARY]);
  await expect(activeTerminal(shell)).toHaveAttribute('data-terminal-id', id);
  await expect(activeTerminal(shell).locator('.terminal-host')).not.toHaveClass(/invisible/);
  return shell;
}
