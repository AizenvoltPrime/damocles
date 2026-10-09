import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, test } from '../support/fixtures';
import { REPO_ROOT, writeUserSettings } from '../support/hermetic';
import { captureWindow, setWindowContentSize } from '../support/browser';
import { captureThemes, openProjectChat, settled, showTheme, THEMES } from '../support/screenshots';
import { overlayPage, pressKeys, shellPage } from '../support/shell';
import { overlayMenu } from '../support/overlay';
import { closeSettingsModal, openSettingsModal, settingsRow } from '../support/settings';
import { chatInput } from '../support/ui';
import { openTerminal, terminalRows } from '../support/terminal';

// Review captures for slice 9c (split terminals and user profiles), saved to DAMOCLES_SCREENSHOT_DIR, dark and light.
const OUT = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(process.env.USERPROFILE ?? REPO_ROOT, '.damocles', 'screenshots', 'slice9c');
const WIDTH = 1440;
const HEIGHT = 900;
const windows = process.platform === 'win32';
const POWERSHELL = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

// A dev server that stays up and a test run that finishes, as the user runs them side by side.
const DEV = `const c=(n,s)=>'\\x1b['+n+'m'+s+'\\x1b[0m';
console.log('');
console.log('  '+c('1;32','VITE v6.2.0')+'  '+c(2,'ready in')+' '+c(1,'412')+' '+c(2,'ms'));
console.log('');
console.log('  '+c(32,'➜')+'  '+c(1,'Local:')+'   '+c(36,'http://localhost:5173/'));
console.log('  '+c(32,'➜')+'  '+c(2,'Network: use --host to expose'));
console.log('  '+c(32,'➜')+'  '+c(2,'press h + enter to show help'));
console.log(c(2,'14:02:11')+' '+c('1;36','[vite]')+' '+c(32,'hmr update')+' '+c(2,'/src/App.vue'));
console.log(c(2,'14:02:19')+' '+c('1;36','[vite]')+' '+c(32,'hmr update')+' '+c(2,'/src/components/Cart.vue'));
setInterval(()=>{},1e6);
`;
const TESTS = `const c=(n,s)=>'\\x1b['+n+'m'+s+'\\x1b[0m';
console.log('');
console.log(' '+c('1;46;30',' RUN ')+' '+c(36,'v3.1.1')+' '+c(2,'C:/work/shop'));
console.log('');
for (const [f,n,t] of [['src/utils/format.test.ts',12,8],['src/stores/cart.test.ts',9,15],['src/components/Button.test.ts',6,31],['src/api/orders.test.ts',14,42]]) console.log(' '+c(32,'✓')+' '+f+' '+c(2,'('+n+' tests) '+t+'ms'));
console.log('');
console.log(c(2,' Test Files ')+' '+c('1;32','4 passed')+c(2,' (4)'));
console.log(c(2,'      Tests ')+' '+c('1;32','41 passed')+c(2,' (41)'));
console.log(c(2,'   Start at ')+' 14:02:24');
console.log(c(2,'   Duration ')+' 1.38s');
`;
const LOGS = `const c=(n,s)=>'\\x1b['+n+'m'+s+'\\x1b[0m';
for (const [t,l,m] of [['14:02:30','info','GET /api/cart 200 12ms'],['14:02:31','info','GET /api/products 200 31ms'],['14:02:34','warn','slow query: orders.list 412ms'],['14:02:36','info','POST /api/orders 201 58ms']]) console.log(c(2,t)+' '+(l==='warn'?c(33,l.padEnd(5)):c(36,l.padEnd(5)))+' '+m);
setInterval(()=>{},1e6);
`;

test.setTimeout(600_000);

async function shoot(app: ElectronApplication, name: string, settle = true): Promise<void> {
  if (settle) for (const page of [await shellPage(app), await overlayPage(app)]) await settled(page);
  await new Promise((resolve) => setTimeout(resolve, settle ? 400 : 150));
  await captureWindow(app, path.join(OUT, `${name}.png`));
}

const state = (shell: Page) => shell.evaluate(() => window.damoclesShell!.terminal.getState());

async function splitActive(app: ElectronApplication, shell: Page): Promise<string> {
  const before = (await state(shell)).terminals.map((terminal) => terminal.id);
  await pressKeys(app, '/shell/', '5', ['control', 'shift']);
  let added: string | undefined;
  await expect.poll(async () => (added = (await state(shell)).terminals.find((terminal) => !before.includes(terminal.id) && terminal.status === 'running')?.id)).toBeDefined();
  return added!;
}

async function run(shell: Page, id: string, name: string, command: string): Promise<void> {
  await shell.evaluate(([terminal, title]) => window.damoclesShell!.terminal.rename({ id: terminal!, name: title! }), [id, name] as const);
  await shell.locator(`[data-testid="terminal-pane-box"][data-terminal-id="${id}"] .xterm-screen`).click();
  await shell.keyboard.type(command);
  await shell.keyboard.press('Enter');
}

test('slice 9c captures', async ({ home, launch }) => {
  test.skip(!windows, 'The captures use Windows paths for the user profiles.');
  fs.mkdirSync(OUT, { recursive: true });
  for (const [file, text] of [['dev.js', DEV], ['test.js', TESTS], ['logs.js', LOGS]] as const) fs.writeFileSync(path.join(home.project, file), text);
  writeUserSettings(home, {
    'damocles.desktop.terminal.defaultProfile': 'cmd',
    'damocles.desktop.terminal.confirmOnKill': 'never',
    'damocles.desktop.terminal.profiles': {
      'Developer PowerShell': {
        path: POWERSHELL,
        args: ['-NoExit', '-Command', '&{Import-Module "C:/Program Files/Microsoft Visual Studio/2022/Community/Common7/Tools/Microsoft.VisualStudio.DevShell.dll"; Enter-VsDevShell 1a2b3c4d}'],
        icon: 'wrench',
        color: 'magenta',
      },
      Nushell: { path: 'C:/Tools/nu/bin/nu.exe' },
      Fish: { path: 'fish', env: { TERM: 'xterm' } },
      'Command Prompt': null,
    },
  });
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await setWindowContentSize(app, WIDTH, HEIGHT);
  await openProjectChat(app, home.project);
  const shell = await openTerminal(app);
  const overlay = await overlayPage(app);
  await shell.getByTestId('terminal-maximize').click();

  // Two panes: the dev server beside the tests.
  const dev = (await state(shell)).activeId!;
  await run(shell, dev, 'dev server', 'node dev.js');
  const tests = await splitActive(app, shell);
  await run(shell, tests, 'tests', 'node test.js');
  await expect(shell.locator(`[data-testid="terminal-pane-box"][data-terminal-id="${tests}"] .xterm-rows`)).toContainText('41 passed', { timeout: 20_000 });
  await captureThemes(app, OUT, 'split-two-panes-dev-server-beside-tests');

  // Three panes, the first sash held mid-drag.
  const logs = await splitActive(app, shell);
  await run(shell, logs, 'logs', 'node logs.js');
  await expect(shell.locator(`[data-testid="terminal-pane-box"][data-terminal-id="${logs}"] .xterm-rows`)).toContainText('POST /api/orders');
  for (const theme of THEMES) {
    await showTheme(app, shell, theme);
    const handle = (await shell.getByTestId('terminal-pane-sash').first().boundingBox())!;
    await shell.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await shell.mouse.down();
    await shell.mouse.move(handle.x + handle.width / 2 + 90, handle.y + handle.height / 2, { steps: 8 });
    await shoot(app, `split-three-panes-sash-dragging-${theme}`, false);
    await shell.mouse.up();
    await shell.getByTestId('terminal-pane-sash').first().dblclick();
  }

  // The grouped list: the three-pane group and a terminal of its own.
  await shell.getByTestId('terminal-new').click({ modifiers: ['Shift'] });
  await expect(terminalRows(shell)).toHaveCount(4);
  const single = (await state(shell)).activeId!;
  await shell.evaluate((id) => window.damoclesShell!.terminal.rename({ id, name: 'git' }), single);
  await shell.locator(`[data-testid="terminal-row"][data-terminal-id="${tests}"]`).click();
  await captureThemes(app, OUT, 'grouped-terminal-list');

  // The row menu with Split and Unsplit.
  for (const theme of THEMES) {
    await showTheme(app, shell, theme);
    await shell.locator(`[data-testid="terminal-row"][data-terminal-id="${tests}"]`).click({ button: 'right' });
    await expect(overlayMenu(overlay)).toBeVisible();
    await shoot(app, `context-menu-split-${theme}`);
    await overlay.keyboard.press('Escape');
    await expect(overlayMenu(overlay)).toHaveCount(0);
  }

  // The New Terminal dropdown with the user profile in its icon and colour.
  for (const theme of THEMES) {
    await showTheme(app, shell, theme);
    await shell.getByTestId('terminal-new-menu').click();
    await expect(overlayMenu(overlay)).toBeVisible();
    await shoot(app, `profile-dropdown-user-profile-${theme}`);
    await overlay.keyboard.press('Escape');
    await expect(overlayMenu(overlay)).toHaveCount(0);
  }
  await shell.getByTestId('terminal-maximize').click();

  // Settings › Terminal: the user profile, the detected shells with the hidden one, and the entries not loaded.
  const settings = await openSettingsModal(app, 'terminal');
  await expect(settings.getByTestId('terminal-profile-problem')).toHaveCount(2, { timeout: 20_000 });
  await settingsRow(settings, 'damocles.desktop.terminal.profiles').evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await captureThemes(app, OUT, 'settings-terminal-profiles-and-invalid-entries');
  await closeSettingsModal(settings);
});
