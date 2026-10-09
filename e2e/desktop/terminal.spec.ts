import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat, expect, test } from './support/fixtures';
import { openProjectChat } from './support/screenshots';
import { overlayPage, pressKeys, PRIMARY, shellPage, viewFocused } from './support/shell';
import { chatInput, clickMenu } from './support/ui';
import { quickPick } from './support/editor';
import { readUserSettings } from './support/hermetic';
import { menuItem, overlayMenu, readyOverlay } from './support/overlay';
import { closeSettingsModal, openSettingsModal, setContentSize, settingsRow } from './support/settings';
import { TERMINAL_CHANNELS } from '../../src/desktop/preload/terminal-channels';
import {
  activeTerminal,
  echoCommand,
  openTerminal,
  readFromTerminal,
  runInTerminal,
  terminalPane,
  terminalRows,
  terminalText,
  TEST_PROFILE,
  useTestProfile,
  waitForOutputLine,
} from './support/terminal';

const windows = process.platform === 'win32';

async function launchWithTerminal(home: Parameters<typeof useTestProfile>[0], launch: (options?: object) => Promise<{ app: ElectronApplication; close: () => Promise<void> }>): Promise<{ app: ElectronApplication; shell: Page; close: () => Promise<void> }> {
  useTestProfile(home);
  const { app, close } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openTerminal(app);
  return { app, shell, close };
}

/** The shell's own idea of its width: cmd's `mode con`, else `tput cols`, on a cleared screen. */
async function shellColumns(shell: Page): Promise<number> {
  const answer = windows ? /Columns:\s+(\d+)/ : /cols=(\d+)/;
  await runInTerminal(shell, windows ? 'cls' : 'clear');
  // An earlier answer stays on screen until the clear's output arrives, which on a loaded runner is after the next command is typed.
  await expect.poll(async () => answer.test(await terminalText(shell))).toBe(false);
  await runInTerminal(shell, windows ? 'mode con' : 'echo cols=$(tput cols)');
  return Number(await readFromTerminal(shell, answer));
}

/** The pid of the shell running in the active terminal, printed by a child it starts. */
async function shellPid(shell: Page): Promise<number> {
  await runInTerminal(shell, `node -e "console.log('pid='+process.ppid)"`);
  return Number(await readFromTerminal(shell, /pid=(\d+)/));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

test('an echoed marker appears in the xterm, and a pane resize resizes the pty so the shell reports the fitted columns', async ({ home, launch }) => {
  const { app, shell } = await launchWithTerminal(home, launch);
  await expect(terminalPane(shell).getByTestId('terminal-tab')).toBeVisible();
  await expect(terminalRows(shell)).toHaveCount(0);

  await runInTerminal(shell, echoCommand('e2e-marker-7f3a'));
  await expect.poll(() => terminalText(shell)).toContain('e2e-marker-7f3a');

  const before = Number(await activeTerminal(shell).getAttribute('data-cols'));
  expect(await shellColumns(shell)).toBe(before);
  await setContentSize(app, 1000, 720);
  await expect.poll(async () => Number(await activeTerminal(shell).getAttribute('data-cols'))).not.toBe(before);
  const after = Number(await activeTerminal(shell).getAttribute('data-cols'));
  expect(await shellColumns(shell)).toBe(after);
});

// The pane glides open from no height, and every resize makes the shell redraw its prompt.
test('a terminal opening with its pane resizes its pty once, to the size the pane settles at', async ({ home, launch }) => {
  useTestProfile(home);
  const { app } = await launch();
  await openProjectChat(app, home.project);
  await app.evaluate(({ BrowserWindow }, channel) => {
    const resizes: Array<{ id: string; cols: number; rows: number }> = [];
    (globalThis as unknown as { __e2eResizes: typeof resizes }).__e2eResizes = resizes;
    BrowserWindow.getAllWindows()[0]!.webContents.ipc.on(channel, (_event, resize: (typeof resizes)[number]) => resizes.push(resize));
  }, TERMINAL_CHANNELS.resize);
  const resizes = (): Promise<Array<{ id: string; cols: number; rows: number }>> => app.evaluate(() => (globalThis as unknown as { __e2eResizes: Array<{ id: string; cols: number; rows: number }> }).__e2eResizes);

  const shell = await openTerminal(app);
  const view = activeTerminal(shell);
  const id = (await view.getAttribute('data-terminal-id'))!;
  // xterm draws one element per row it was fitted to.
  const fittedRows = (): Promise<number> => view.evaluate((element) => element.querySelectorAll('.xterm-rows > div').length);
  await expect.poll(async () => {
    const last = (await resizes()).filter((resize) => resize.id === id).at(-1);
    return last !== undefined && last.rows === await fittedRows();
  }).toBe(true);
  expect((await resizes()).filter((resize) => resize.id === id)).toHaveLength(1);
});

test('two terminals list vertically, and killing one ends its process and leaves the other', async ({ foreground: _foreground, home, launch }) => {
  const { shell } = await launchWithTerminal(home, launch);
  const firstId = await activeTerminal(shell).getAttribute('data-terminal-id');
  const firstPid = await shellPid(shell);

  // Shift+click starts the default profile in the current project, with no quick pick.
  await shell.getByTestId('terminal-new').click({ modifiers: ['Shift'] });
  await expect(terminalRows(shell)).toHaveCount(2);
  await expect(shell.getByTestId('terminal-list')).toBeVisible();
  await expect(shell.getByTestId('terminal-summary')).toBeVisible();
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running');
  const secondId = await activeTerminal(shell).getAttribute('data-terminal-id');
  expect(secondId).not.toBe(firstId);
  const [top, bottom] = await Promise.all([terminalRows(shell).nth(0).boundingBox(), terminalRows(shell).nth(1).boundingBox()]);
  expect(bottom!.y).toBeGreaterThan(top!.y);
  expect(bottom!.x).toBe(top!.x);

  const firstRow = shell.locator(`[data-testid="terminal-row"][data-terminal-id="${firstId}"]`);
  await firstRow.hover();
  await firstRow.getByTestId('terminal-row-kill').click();
  await expect(terminalRows(shell)).toHaveCount(0);
  await expect(terminalPane(shell).getByTestId('terminal-tab')).toHaveAttribute('data-terminal-id', secondId!);
  await expect.poll(() => processAlive(firstPid)).toBe(false);
  await runInTerminal(shell, echoCommand('still-here-41'));
  await expect.poll(() => terminalText(shell)).toContain('still-here-41');
});

test('50 MB of output keeps the window responsive and its memory bounded', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const { app, shell } = await launchWithTerminal(home, launch);
  // 51,200 lines of 1,025 characters: 52 MB through the pty, xterm and flow control.
  await runInTerminal(shell, `node -e "const s='0123456789abcdef'.repeat(64)+'\\n';for(let i=0;i<51200;i++)process.stdout.write(s)" && ${echoCommand('flood-done-9c')}`);
  await expect.poll(() => terminalText(shell)).toContain('0123456789abcdef0123456789abcdef');

  // While the flood streams, a click on the pane still answers at once and a frame still paints.
  const started = Date.now();
  await shell.getByTestId('terminal-maximize').click();
  await expect(shell.getByTestId('terminal-maximize')).toHaveAttribute('aria-pressed', 'true', { timeout: 2_000 });
  expect(Date.now() - started).toBeLessThan(2_000);
  const frame = await shell.evaluate(() => new Promise<number>((resolve) => {
    const asked = performance.now();
    requestAnimationFrame(() => resolve(performance.now() - asked));
  }));
  expect(frame).toBeLessThan(500);

  await expect.poll(() => terminalText(shell), { timeout: 200_000 }).toContain('flood-done-9c');
  // The scrollback keeps 1,000 lines, so the shell page's heap stays far below the 52 MB that went through it.
  const heap = await shell.evaluate(() => (performance as Performance & { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize);
  expect(heap).toBeLessThan(200 * 1024 * 1024);
  const mainRss = await app.evaluate(() => process.memoryUsage().rss);
  expect(mainRss).toBeLessThan(1024 * 1024 * 1024);
});

/** The highest `tick-<n>` the active terminal shows. */
async function lastTick(shell: Page): Promise<number> {
  return Math.max(-1, ...[...(await terminalText(shell)).matchAll(/tick-(\d+)/g)].map((match) => Number(match[1])));
}

// The pane glides open from no height, so xterm's screen starts out of sight while the shell prints its first lines; a
// resize then must not leave the xterm scrolled away from the output that follows.
test('a terminal resized while its screen cannot be seen keeps following its output', async ({ home, launch }) => {
  const { app, shell } = await launchWithTerminal(home, launch);
  await shell.getByTestId('terminal-maximize').click();
  await expect(shell.getByTestId('terminal-maximize')).toHaveAttribute('aria-pressed', 'true');
  await runInTerminal(shell, `node -e "let i=0;setInterval(()=>console.log('tick-'+(i++)),20)"`);
  await expect.poll(() => lastTick(shell)).toBeGreaterThan(0);

  // A busy page runs no idle callbacks, where xterm resizes a renderer that paused out of sight; held, they stay pending.
  await shell.evaluate(() => {
    const held: IdleRequestCallback[] = [];
    const page = window as Window & { releaseIdle?: () => void };
    const requestIdle = window.requestIdleCallback;
    window.requestIdleCallback = (callback) => held.push(callback);
    page.releaseIdle = () => {
      window.requestIdleCallback = requestIdle;
      for (const callback of held.splice(0)) requestIdle(callback);
    };
  });
  // Out of the viewport: xterm's renderer pauses, while the pane keeps its layout size and so its resizes. xterm's own
  // observer reports in the same task as this one, so its renderer has paused when this resolves.
  const pane = terminalPane(shell);
  await pane.evaluate((element) => new Promise<void>((resolve) => {
    element.style.transform = 'translateY(200vh)';
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(element.querySelector('.xterm-screen')!);
  }));
  const height = await pane.evaluate((element) => element.getBoundingClientRect().height);
  await setContentSize(app, 1000, 560);
  await expect.poll(() => pane.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(height);
  // Lines printed after the shrink scroll the hidden xterm.
  await shell.evaluate(() => new Promise<void>((resolve) => {
    let lines = 0;
    const stop = window.damoclesShell!.terminal.onData(({ data }) => {
      lines += data.split('\n').length - 1;
      if (lines < 40) return;
      stop();
      resolve();
    });
  }));

  await shell.evaluate(() => (window as Window & { releaseIdle?: () => void }).releaseIdle!());
  await pane.evaluate((element) => {
    element.style.transform = '';
  });
  const shown = await lastTick(shell);
  await expect.poll(() => lastTick(shell)).toBeGreaterThan(shown + 20);
  await expect(shell.getByTestId('terminal-scroll-to-end')).toHaveCount(0);
});

test('Ctrl+K reaches the pty while Ctrl+P and Ctrl+Shift+P reach the app', async ({ home, launch }) => {
  const { app, shell } = await launchWithTerminal(home, launch);
  const overlay = await overlayPage(app);
  // A raw-mode reader prints the first byte the pty delivers.
  await runInTerminal(shell, `node -e "process.stdin.setRawMode(true);process.stdin.once('data',(d)=>{console.log('byte='+d[0]);process.exit()})"`);
  await expect.poll(() => terminalText(shell)).toContain('setRawMode');

  await pressKeys(app, '/shell/', 'P', [PRIMARY]);
  await expect(quickPick(overlay)).toBeVisible();
  await overlay.keyboard.press('Escape');
  await expect(quickPick(overlay)).toHaveCount(0);
  await activeTerminal(shell).locator('.xterm-screen').click();

  await pressKeys(app, '/shell/', 'P', [PRIMARY, 'shift']);
  await expect(quickPick(overlay)).toBeVisible();
  await expect(overlay.getByTestId('quick-pick-input')).toHaveValue('>');
  await overlay.keyboard.press('Escape');
  await expect(quickPick(overlay)).toHaveCount(0);
  await activeTerminal(shell).locator('.xterm-screen').click();

  // Neither chord reached the reader: the first byte it gets is Ctrl+K's vertical tab (11).
  await pressKeys(app, '/shell/', 'K', ['control']);
  expect(await readFromTerminal(shell, /byte=(\d+)/)).toBe('11');
});

// VS Code's clipboard keys: on Windows Ctrl+C copies and clears a selection and Ctrl+V pastes; on Linux both reach the pty.
test('Ctrl+C copies a selection on Windows and is ^C without one, and Ctrl+V pastes', async ({ clipboard, home, launch }) => {
  const { app, shell } = await launchWithTerminal(home, launch);
  // A raw-mode reader prints a line to select, then the first byte the pty delivers, which for Ctrl+C is ^C (3). It reports
  // ready once in raw mode, since a Ctrl+C before that would interrupt it instead.
  await runInTerminal(shell, `node -e "process.stdin.setRawMode(true);console.log('e2e-copy-'+'5b1c');console.log('raw-'+'ready');process.stdin.once('data',(d)=>{console.log('byte='+d[0]);process.exit()})"`);
  await expect.poll(() => terminalText(shell)).toContain('raw-ready');
  await clipboard.writeText(app, 'before');
  const line = activeTerminal(shell).locator('.xterm-rows > div', { hasText: 'e2e-copy-5b1c' }).last();
  // xterm's screen layer takes the pointer above its rows, so the triple click lands on the row's position.
  const box = (await line.boundingBox())!;
  await shell.mouse.click(box.x + 4, box.y + box.height / 2, { clickCount: 3 });
  await expect(activeTerminal(shell).locator('.xterm-selection div').first()).toBeAttached();

  await pressKeys(app, '/shell/', 'C', ['control']);
  if (windows) {
    await expect.poll(() => clipboard.readText(app)).toContain('e2e-copy-5b1c');
    await expect(activeTerminal(shell).locator('.xterm-selection div')).toHaveCount(0);
    await pressKeys(app, '/shell/', 'C', ['control']);
  }
  // Off Windows the reader's byte is the Ctrl+C pressed over the selection, so the clipboard is read after it arrived.
  expect(await readFromTerminal(shell, /byte=(\d+)/)).toBe('3');
  if (!windows) expect(await clipboard.readText(app)).toBe('before');

  if (windows) {
    await clipboard.writeText(app, 'pasted-9d2e');
    await pressKeys(app, '/shell/', 'V', ['control']);
    await expect.poll(() => terminalText(shell)).toContain('pasted-9d2e');
  }
});

test('an exited terminal shows its exit code, and Restart starts a new shell in the same row', async ({ home, launch }) => {
  const { shell } = await launchWithTerminal(home, launch);
  const id = await activeTerminal(shell).getAttribute('data-terminal-id');
  await runInTerminal(shell, 'exit 3');
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'exited');
  await expect(shell.getByTestId('terminal-exited')).toContainText('Process exited with code 3');

  await shell.getByTestId('terminal-restart').click();
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running');
  await expect(activeTerminal(shell)).toHaveAttribute('data-terminal-id', id!);
  await expect(shell.getByTestId('terminal-exited')).toHaveCount(0);
  await runInTerminal(shell, echoCommand('restarted-5e'));
  await expect.poll(() => terminalText(shell)).toContain('restarted-5e');
});

test('the new-terminal quick pick lists the profiles with the default marked, and Escape creates nothing', async ({ home, launch }) => {
  const { app, shell } = await launchWithTerminal(home, launch);
  const overlay = await overlayPage(app);
  await shell.getByTestId('terminal-new').click();
  await expect(quickPick(overlay)).toBeVisible();
  const defaultRow = overlay.locator('[data-testid="quick-pick-item"]', { has: overlay.getByTestId('quick-pick-badge') });
  await expect(defaultRow).toHaveCount(1);
  await expect(defaultRow).toHaveAttribute('data-item-id', windows ? 'cmd' : 'bash');
  await overlay.keyboard.press('Escape');
  await expect(quickPick(overlay)).toHaveCount(0);
  await expect(shell.locator('[data-testid="terminal-view"]')).toHaveCount(1);

  // Accepting the default profile with one project open skips the project step and starts it.
  await shell.getByTestId('terminal-new').click();
  await expect(quickPick(overlay)).toBeVisible();
  await defaultRow.click();
  await expect(terminalRows(shell)).toHaveCount(2);
});

test('a relaunch restores the terminal list with live shells, and keyboard focus goes only to the selected chat\'s composer', async ({ foreground: _foreground, home, launch }) => {
  {
    const { shell, close } = await launchWithTerminal(home, launch);
    await shell.getByTestId('terminal-new').click({ modifiers: ['Shift'] });
    await expect(terminalRows(shell)).toHaveCount(2);
    await close();
  }
  const { app } = await launch();
  const shell = await shellPage(app);
  const chat = await activeChat(app);
  await expect(chatInput(chat)).toBeVisible();
  await expect(terminalRows(shell)).toHaveCount(2);
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running');
  // The restored shell's prompt names its project folder: its first output reached the xterm.
  await expect.poll(() => terminalText(shell)).toContain('alpha');
  await expect.poll(() => viewFocused(app, chat)).toBe(true);
  await expect(chatInput(chat)).toBeFocused();
  expect(await viewFocused(app, shell)).toBe(false);
  await expect(activeTerminal(shell).locator('textarea.xterm-helper-textarea')).not.toBeFocused();
});

let readers = 0;

/** A marker no earlier reader printed, and the expression that prints it in two parts so the command's echo never reads as it. */
function readyMarker(): { line: string; printed: string } {
  readers += 1;
  return { line: `rd-ready-${readers}`, printed: `'rd'+'-ready-${readers}'` };
}

// A raw-mode reader that prints exactly what the pty delivers next, as JSON; with `bracketed` it first turns on bracketed
// paste mode, as a shell's line editor does, and reads until the paste's closing marker. It prints `ready` once its modes are on.
function readerCommand(bracketed: boolean, ready: string): string {
  const [setup, read] = bracketed
    ? [`process.stdout.write('\\x1b[?2004h');`, `let s='';process.stdin.on('data',(d)=>{s+=d;if(s.includes('\\x1b[201~')){console.log('got='+JSON.stringify(s));process.stdout.write('\\x1b[?2004l');process.exit()}})`]
    : ['', `process.stdin.once('data',(d)=>{console.log('got='+JSON.stringify(String(d)));process.exit()})`];
  return `node -e "process.stdin.setRawMode(true);${setup}console.log(${ready});${read}"`;
}

async function startReader(shell: Page, bracketed: boolean): Promise<void> {
  const ready = readyMarker();
  await runInTerminal(shell, readerCommand(bracketed, ready.printed));
  // An earlier reader's marker stays on screen until a clear's output arrives, which on a loaded runner is after this command is typed.
  await waitForOutputLine(shell, ready.line);
}

/** What the reader got, decoded from its JSON line. */
async function readerGot(shell: Page): Promise<string> {
  return JSON.parse(await readFromTerminal(shell, /got=(".*")/)) as string;
}

const messageDialog = (overlay: Page): Locator => overlay.getByTestId('overlay-message');

/** The terminal paste key (isTerminalPasteChord): Ctrl+Shift+V, and on macOS Cmd+V, which Edit › Paste carries to the terminal. */
async function pressPasteKey(app: ElectronApplication): Promise<void> {
  await pressKeys(app, '/shell/', 'V', process.platform === 'darwin' ? ['meta'] : ['control', 'shift']);
}

test('a two-line paste asks first with a preview; Paste sends both lines, Paste as One Line one, and Cancel nothing', async ({ clipboard, home, launch }) => {
  const { app, shell } = await launchWithTerminal(home, launch);
  const overlay = await readyOverlay(app);
  await clipboard.writeText(app, 'line-a\nline-b');

  await startReader(shell, false);
  await pressPasteKey(app);
  await expect(messageDialog(overlay)).toBeVisible();
  await expect(messageDialog(overlay)).toContainText('Paste 2 lines of text into the terminal?');
  await expect(overlay.getByTestId('overlay-message-preview').locator('div')).toHaveText(['line-a', 'line-b']);
  await overlay.getByTestId('overlay-message-action-0').click();
  expect(await readerGot(shell)).toBe('line-a\rline-b');

  await runInTerminal(shell, windows ? 'cls' : 'clear');
  await startReader(shell, false);
  await pressPasteKey(app);
  await overlay.getByTestId('overlay-message-action-1').click();
  expect(await readerGot(shell)).toBe('line-aline-b');

  // Cancel sends nothing: the next byte the reader gets is the key typed after it.
  await runInTerminal(shell, windows ? 'cls' : 'clear');
  await startReader(shell, false);
  await pressPasteKey(app);
  await overlay.getByTestId('overlay-message-cancel').click();
  await expect(messageDialog(overlay)).toHaveCount(0);
  await activeTerminal(shell).locator('.xterm-screen').click();
  await shell.keyboard.type('z');
  expect(await readerGot(shell)).toBe('z');
});

test('with the shell\'s bracketed paste mode on, a multi-line paste goes straight in, bracketed', async ({ clipboard, home, launch }) => {
  const { app, shell } = await launchWithTerminal(home, launch);
  const overlay = await readyOverlay(app);
  await clipboard.writeText(app, 'line-a\nline-b');
  await startReader(shell, true);
  await pressPasteKey(app);
  expect(await readerGot(shell)).toBe('\u001b[200~line-a\rline-b\u001b[201~');
  await expect(messageDialog(overlay)).toHaveCount(0);
});

test('a paste event reaching the xterm is never pasted by it, and Linux\'s middle click pastes the selection through main', async ({ clipboard, home, launch }) => {
  const { app, shell } = await launchWithTerminal(home, launch);
  await startReader(shell, false);
  await activeTerminal(shell).locator('textarea.xterm-helper-textarea').evaluate((textarea) => {
    const data = new DataTransfer();
    data.setData('text/plain', 'injected');
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await shell.keyboard.type('k');
  expect(await readerGot(shell)).toBe('k');

  if (process.platform !== 'linux') return;
  await runInTerminal(shell, 'clear');
  await clipboard.writeSelection(app, 'primary-sel');
  await startReader(shell, false);
  await activeTerminal(shell).locator('.xterm-screen').click({ button: 'middle' });
  expect(await readerGot(shell)).toBe('primary-sel');

  // A program that tracks the mouse gets the middle press itself and nothing is pasted; Shift forces the paste, as in xterm.
  // Main writes a paste before it reads the next input, so the Z typed last ends the reader after any paste of either click.
  await runInTerminal(shell, 'clear');
  const ready = readyMarker();
  await runInTerminal(shell, `node -e "process.stdin.setRawMode(true);process.stdout.write('\\x1b[?1000h');console.log(${ready.printed});let s='';process.stdin.on('data',(d)=>{s+=d;if(s.endsWith('Z')){process.stdout.write('\\x1b[?1000l');console.log('got='+JSON.stringify(s));process.exit()}})"`);
  await waitForOutputLine(shell, ready.line);
  await activeTerminal(shell).locator('.xterm-screen').click({ button: 'middle' });
  await activeTerminal(shell).locator('.xterm-screen').click({ button: 'middle', modifiers: ['Shift'] });
  await shell.keyboard.type('Z');
  const got = await readerGot(shell);
  expect(got.startsWith('\u001b[M')).toBe(true);
  expect(got.split('primary-sel')).toHaveLength(2);
});

// Only input main observes (a key, a click, an overlay pick, the application menu) lets the clipboard reach the shell page.
test('page script pastes nothing: a paste request, a synthetic paste key, a paste command or a clipboard menu it opens itself', async ({ clipboard, home, launch }) => {
  useTestProfile(home);
  const desktop = await launch();
  const { app } = desktop;
  await openProjectChat(app, home.project);
  const shell = await openTerminal(app);
  const overlay = await readyOverlay(app);
  await clipboard.writeText(app, 'leak-7q');
  if (process.platform === 'linux') await clipboard.writeSelection(app, 'leak-7q');
  await startReader(shell, false);
  await expect.poll(() => viewFocused(app, shell)).toBe(true);
  const id = (await activeTerminal(shell).getAttribute('data-terminal-id'))!;

  expect(await shell.evaluate(() => 'editorClipboard' in window.damoclesShell!)).toBe(false);
  expect(await shell.evaluate(() => document.execCommand('paste'))).toBe(false);
  for (const source of ['clipboard', 'selection'] as const) {
    await shell.evaluate(([terminalId, from]) => window.damoclesShell!.terminal.paste({ id: terminalId, bracketedPasteMode: false, source: from }), [id, source] as const);
  }
  // On Windows and Linux the shell's own key handler takes it as Ctrl+Shift+V and asks main, which saw no such key. macOS has
  // no terminal paste key (Cmd+V is the Edit menu's, which page script cannot reach), so there nothing asks.
  const keyAsks = process.platform === 'darwin' ? 0 : 1;
  await activeTerminal(shell).locator('textarea.xterm-helper-textarea').evaluate((textarea) => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', key: 'V', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => desktop.output().split('[terminal] refusing a paste: no paste key, middle click or menu pick of the user allowed it').length - 1).toBe(2 + keyAsks);

  // A menu the page opens with no context-menu click or key loses its Paste, so the user's next Enter cannot pick it.
  const answer = shell.evaluate(async (terminalId) => {
    const picked = await window.damoclesShell!.requestOverlay({
      kind: 'menu',
      label: 'Menu',
      anchor: { x: 10, y: 10, width: 0, height: 0 },
      items: [{ kind: 'item', id: 'paste', label: 'Paste', clipboard: 'terminalPaste' }, { kind: 'item', id: 'other', label: 'Other' }],
    });
    window.damoclesShell!.terminal.paste({ id: terminalId, bracketedPasteMode: false, source: 'clipboard' });
    return picked;
  }, id);
  await expect(overlayMenu(overlay)).toBeVisible();
  await expect(overlayMenu(overlay).locator('[data-menu-item]')).toHaveCount(1);
  await expect(menuItem(overlay, 'paste')).toHaveCount(0);
  await overlay.keyboard.press('Enter');
  expect(await answer).toEqual({ kind: 'menu', itemId: 'other' });
  await expect.poll(() => desktop.output()).toContain('[overlay] dropping the clipboard items of a shell menu that no context-menu click or key opened');
  await expect.poll(() => desktop.output().split('[terminal] refusing a paste: no paste key').length - 1).toBe(3 + keyAsks);
  expect(await shell.evaluate(() => window.damoclesShell!.requestOverlay({
    kind: 'menu',
    label: 'Menu',
    anchor: { x: 10, y: 10, width: 0, height: 0 },
    items: [{ kind: 'item', id: 'paste', label: 'Paste', clipboard: 'paste' }],
  }))).toEqual({ kind: 'dismissed' });

  await activeTerminal(shell).locator('.xterm-screen').click();
  await shell.keyboard.type('k');
  expect(await readerGot(shell)).toBe('k');
  expect(await terminalText(shell)).not.toContain('leak-7q');
});

test('the New Terminal dropdown lists the detected shells and Select Default Profile..., and the chevron says it is open', async ({ home, launch }) => {
  const { app, shell } = await launchWithTerminal(home, launch);
  const overlay = await readyOverlay(app);
  const chevron = shell.getByTestId('terminal-new-menu');
  await expect(chevron).toHaveAttribute('aria-haspopup', 'menu');
  await expect(chevron).toHaveAccessibleName('Launch Profile...');
  await chevron.click();
  await expect(overlayMenu(overlay)).toBeVisible();
  await expect(chevron).toHaveAttribute('aria-expanded', 'true');
  await expect(menuItem(overlay, `profile:${TEST_PROFILE}`)).toBeVisible();
  await expect(menuItem(overlay, 'selectDefaultProfile')).toHaveText('Select Default Profile...');
  await menuItem(overlay, `profile:${TEST_PROFILE}`).click();
  await expect(terminalRows(shell)).toHaveCount(2);
  await expect(chevron).toHaveAttribute('aria-expanded', 'false');

  await chevron.click();
  await menuItem(overlay, 'selectDefaultProfile').click();
  await expect(quickPick(overlay)).toHaveAttribute('data-pick', 'list');
  await expect(overlay.locator(`[data-testid="quick-pick-item"][data-item-id="${TEST_PROFILE}"]`)).toHaveAttribute('aria-checked', 'true');
  await overlay.keyboard.press('Escape');
  await expect(quickPick(overlay)).toHaveCount(0);
});

test('Settings › Terminal applies the font family, line height and cursor blinking to open terminals at once', async ({ home, launch }) => {
  const { app, shell } = await launchWithTerminal(home, launch);
  const rows = activeTerminal(shell).locator('.xterm-rows');
  const rowHeight = (): Promise<number> => rows.evaluate((element) => (element.firstElementChild as HTMLElement).getBoundingClientRect().height);
  const before = await rowHeight();
  const overlay = await openSettingsModal(app, 'terminal');
  await expect(settingsRow(overlay, 'damocles.desktop.terminal.macOptionIsMeta')).toHaveCount(process.platform === 'darwin' ? 1 : 0);

  const family = settingsRow(overlay, 'damocles.desktop.terminal.fontFamily').getByRole('textbox');
  await family.fill('"Courier New", monospace');
  await family.press('Enter');
  await expect.poll(() => rows.evaluate((element) => getComputedStyle(element).fontFamily)).toContain('Courier New');

  await settingsRow(overlay, 'damocles.desktop.terminal.lineHeight').locator('input[type="range"]').focus();
  await overlay.keyboard.press('ArrowRight');
  await overlay.keyboard.press('ArrowRight');
  await expect.poll(rowHeight).toBeGreaterThan(before);

  await settingsRow(overlay, 'damocles.desktop.terminal.cursorBlinking').getByRole('switch').click();
  await closeSettingsModal(overlay);
  await activeTerminal(shell).locator('.xterm-screen').click();
  await expect(rows.locator('.xterm-cursor-blink')).toHaveCount(1);
  expect(readUserSettings(home)).toMatchObject({ 'damocles.desktop.terminal.fontFamily': '"Courier New", monospace', 'damocles.desktop.terminal.lineHeight': 1.4, 'damocles.desktop.terminal.cursorBlinking': true });
});

test('the palette focuses the next and previous terminal and kills them all', async ({ home, launch }) => {
  const { app, shell } = await launchWithTerminal(home, launch);
  await shell.getByTestId('terminal-new').click({ modifiers: ['Shift'] });
  await expect(terminalRows(shell)).toHaveCount(2);
  const ids = await terminalRows(shell).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-terminal-id')!));
  await expect(activeTerminal(shell)).toHaveAttribute('data-terminal-id', ids[1]!);
  const overlay = await readyOverlay(app);
  const run = async (query: string, id: string): Promise<void> => {
    await pressKeys(app, '/shell/', 'P', [PRIMARY, 'shift']);
    const input = overlay.getByTestId('quick-pick-input');
    await expect(input).toHaveValue('>');
    await input.fill(`>${query}`);
    await expect(overlay.locator('[data-testid="quick-pick-item"]').first()).toHaveAttribute('data-item-id', id);
    await input.press('Enter');
    await expect(quickPick(overlay)).toHaveCount(0);
  };
  await run('Terminal: Focus Next Terminal Group', 'damocles.terminal.focusNext');
  await expect(activeTerminal(shell)).toHaveAttribute('data-terminal-id', ids[0]!);
  await run('Terminal: Focus Previous Terminal Group', 'damocles.terminal.focusPrevious');
  await expect(activeTerminal(shell)).toHaveAttribute('data-terminal-id', ids[1]!);
  await run('Terminal: Kill All Terminals', 'damocles.terminal.killAll');
  await expect(shell.locator('[data-testid="terminal-view"]')).toHaveCount(0);
  await expect(shell.getByTestId('terminal-empty')).toBeVisible();
});

test('Edit › Paste with focus in the terminal\'s Find box pastes into the box, not into the shell', async ({ clipboard, home, launch }) => {
  const { app, shell } = await launchWithTerminal(home, launch);
  await startReader(shell, false);
  await pressKeys(app, '/shell/', 'F', [PRIMARY]);
  const find = shell.getByTestId('terminal-find-input');
  await expect(find).toBeFocused();
  await clipboard.writeText(app, 'needle-6p');
  await clickMenu(app, 'damocles.edit.paste');
  await expect(find).toHaveValue('needle-6p');
  // The reader got nothing from the paste: the first byte it sees is a key typed in the terminal afterwards.
  await find.press('Escape');
  await shell.keyboard.type('q');
  expect(await readerGot(shell)).toBe('q');
});
