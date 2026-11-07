import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import type { DesktopApp } from '../desktop/support/app';
import { activeTab, filesRow } from '../desktop/support/editor';
import { CLI_SCRIPT } from '../desktop/support/cli';
import { REPO_ROOT, type HermeticHome } from '../desktop/support/hermetic';
import { clickMenu } from '../desktop/support/ui';
import { seedStubModel, writeUserSettings } from '../desktop/support/hermetic';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { overlayPage, shellPage, shellState } from '../desktop/support/shell';
import { listChats, projectRow } from '../desktop/support/shell-ui';
import { browserTabs, chromeEnv, PAGE_TIMEOUT } from '../desktop/support/browser';
import { startOpenAIStub } from '../desktop/support/openai-stub';
import { openTerminal, runInTerminal, terminalText, waitForOutputLine } from '../desktop/support/terminal';
import { browseTo, connectDialog, connectDialogClosed, openConnect, stepRow, trustQuestion } from './support/connect-ui';
import { portMapping, portRow } from './support/ports-ui';
import { exited, requestQuit, closeRemoteDialog } from './support/remote-runs';
import { expect, hostLogs, lastConnectStep, openRemoteFolder, remoteHosts, remoteProjectKey, setInstallFolder, test } from './support/remote';
import { newRemoteChat } from './support/target-agent';
import { ALPINE, apkAdd, clampDistroNode, distroHome, distroState, endCaseDaemon, endDistroDaemon, inDistro, missingDistro, serverProcesses, prepareDistroModel, replaceDistroFile, shutdownDistroDaemon, startDistroModelStub, terminateDistro, UBUNTU, WSL1, WSL_TAG, type DistroModelStub } from './support/wsl';

// The env a WSL launch needs: the e2e hooks; the server packages come from the dev build's cache.
const WSL_ENV = { DAMOCLES_E2E_HOOKS: '1' };
// a file the user makes reaches Files within one 5 s poll and its listing
const POLL_BOUND_MS = 6_000;
// the keep-running turn's tool call, which outlives the app's quit
const WORK = 'sleep 20 && echo finished > done.txt';

type Hooked = { __damoclesE2e: { remote: { addDistro(distro: string): Promise<string> } } };
const addDistro = (app: ElectronApplication, distro: string): Promise<string> => app.evaluate((_electron, name) => (globalThis as unknown as Hooked).__damoclesE2e.remote.addDistro(name), distro);

const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

// The development Electron, which the layout below names Damocles.exe as an installed app's binary
const ELECTRON = createRequire(import.meta.url)('electron') as string;

/**
 * An installed app's layout around this checkout: Electron's files hard-linked beside Damocles.exe, resources/bin/damocles
 * copied, and resources/app.asar.unpacked/dist a junction to the checkout's dist, whose cli.js starts this checkout's main.
 */
function appInstallLayout(home: HermeticHome): { readonly script: string; readonly binary: string; remove(): void } {
  fs.mkdirSync(path.join(home.root, 'install'));
  // the long form: a distro's /mnt/c names no 8.3 short name
  const root = fs.realpathSync.native(path.join(home.root, 'install'));
  const electronDir = path.dirname(ELECTRON);
  const link = (from: string, to: string): void => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name);
      const target = path.join(to, entry.name === path.basename(ELECTRON) ? 'Damocles.exe' : entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(target, { recursive: true });
        link(source, target);
      } else fs.linkSync(source, target);
    }
  };
  fs.mkdirSync(root, { recursive: true });
  link(electronDir, root);
  fs.mkdirSync(path.join(root, 'resources', 'bin'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'resources', 'bin', 'damocles'), path.join(root, 'resources', 'bin', 'damocles'));
  fs.mkdirSync(path.join(root, 'resources', 'app.asar.unpacked'), { recursive: true });
  fs.symlinkSync(path.dirname(CLI_SCRIPT), path.join(root, 'resources', 'app.asar.unpacked', 'dist'), 'junction');
  const mnt = `/mnt/${root[0]!.toLowerCase()}${root.slice(2).replaceAll('\\', '/')}`;
  return {
    script: `${mnt}/resources/bin/damocles`,
    binary: `${mnt}/Damocles.exe`,
    // the junction first, so the removal never walks into the checkout's dist
    remove: () => {
      fs.unlinkSync(path.join(root, 'resources', 'app.asar.unpacked', 'dist'));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Skips the case, with the reason, unless wsl.exe lists every distro it needs. */
async function needDistros(...distros: string[]): Promise<void> {
  for (const distro of distros) {
    const missing = await missingDistro(distro);
    test.skip(missing !== undefined, missing);
  }
}

/** Writes a probe file from inside the distro until Files shows one, so the folder's watch is live before a case measures it. */
async function untilDistroWatchLive(shell: Page, distro: string, folder: string): Promise<void> {
  const prefix = `watch-probe-${process.pid}-${Date.now()}-`;
  let written = 0;
  await expect.poll(async () => {
    await inDistro(distro, `touch ${quote(`${folder}/${prefix}${written++}`)}`);
    return shell.locator(`[data-testid="files-row"][data-tree-path^="${prefix}"]`).count();
  }, { timeout: 90_000, intervals: [2_000] }).toBeGreaterThan(0);
  await inDistro(distro, `rm -f ${quote(folder)}/${prefix}*`);
}

/** Removes what a case left in a distro: its folders and, unless it was there before, ~/.damocles. */
async function cleanDistro(distro: string, folders: readonly string[], damoclesBefore: boolean): Promise<void> {
  const remove = [...folders, ...(damoclesBefore ? [] : ['$HOME/.damocles'])].map((folder) => (folder.startsWith('$HOME') ? `"${folder}"` : quote(folder))).join(' ');
  if (remove !== '') await inDistro(distro, `rm -rf ${remove}`);
}

// A test distro starts each case with no Damocles state, which an earlier failed run may have left, a running daemon included:
// Playwright interrupts a case at an uncaught error and closes its app while the case's own teardown still runs. Resolves
// false, as it holds no ~/.damocles of anyone's.
async function freshTestDistro(distro: string): Promise<boolean> {
  await endDistroDaemon(distro);
  await inDistro(distro, 'rm -rf "$HOME/.damocles"');
  return false;
}

// a row shows its actions while the pointer rests on it
async function clickRowAction(shell: Page, port: number, action: string): Promise<void> {
  await portRow(shell, port).hover();
  await portRow(shell, port).getByTestId(action).click();
}

// Whether nothing on this computer listens on 127.0.0.1:port. WSL's relay keeps a stopped server's port for up to about 1 s,
// accepting connections and dropping them, so only a refusal means a Windows program can take the port.
function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'ECONNREFUSED'));
  });
}

const hasDamocles = async (distro: string): Promise<boolean> => (await inDistro(distro, 'if [ -e "$HOME/.damocles" ]; then echo yes; fi')).trim() === 'yes';

test.describe('WSL', () => {
  // one distro serves several cases, and each ends its daemon, so the cases run one after another
  test.describe.configure({ mode: 'default' });
  test.skip(process.platform !== 'win32', 'WSL distros run only on a Windows computer');

  test('an Alpine distro connects from its card, with no Authenticating step, installs from the app\'s cache, and serves Files and a terminal', { tag: WSL_TAG }, async ({ foreground: _foreground, home, launch }) => {
    test.setTimeout(600_000);
    await needDistros(ALPINE);
    // the bare minirootfs gets what the suite's agent and npm cases need; nodejs brings the libstdc++ the server needs
    await apkAdd(ALPINE, 'nodejs npm git');
    writeUserSettings(home, { 'damocles.desktop.terminal.confirmOnKill': 'never' });
    const damoclesBefore = await freshTestDistro(ALPINE);
    const folder = `${await distroHome(ALPINE)}/wsl-e2e-${process.pid}`;
    await inDistro(ALPINE, `mkdir -p ${quote(folder)}/src && printf '# App\\n' > ${quote(folder)}/README.md`);
    let hostId: string | undefined;
    const { app } = await launch({ env: WSL_ENV });
    try {
      const overlay = await openConnect(app);
      const card = connectDialog(overlay).locator(`[data-testid="distro-card"][data-distro="${ALPINE}"]`);
      await expect(card).toBeVisible();
      await card.click();
      // a distro's first connect names it, prefilled with the distro's name
      const dialog = overlay.getByTestId('connect-dialog');
      await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue(ALPINE);
      await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
      const browser = await browseTo(overlay, ALPINE, folder);
      await expect(stepRow(overlay, 'authenticating')).toHaveCount(0);
      await browser.getByRole('button', { name: 'Open', exact: true }).click();
      await trustQuestion(overlay, folder, ALPINE).getByRole('button', { name: 'Trust Folder' }).click();
      await connectDialogClosed(overlay);

      const host = (await remoteHosts(app)).find((candidate) => candidate.authorityKey === `wsl+${ALPINE}`)!;
      hostId = host.hostId;
      const step = await lastConnectStep(app, hostId);
      expect(step?.visited).toEqual(['connecting', 'checking', 'installing', 'starting']);
      // the stage copied the package from the cache through wslpath, and downloaded nothing
      const logs = await hostLogs(app, hostId);
      expect(logs.bridgeStderr).not.toMatch(/curl|wget/);
      const key = await remoteProjectKey(app, host, folder);
      const shell = await shellPage(app);
      await expect(filesRow(shell, 'README.md')).toBeVisible();

      const terminal = await openTerminal(app);
      await runInTerminal(terminal, 'echo "in-$(cat /etc/alpine-release | cut -c1-1)-$(pwd)" && touch made-in-terminal.txt');
      await waitForOutputLine(terminal, `in-3-${folder}`);
      await expect(filesRow(shell, 'made-in-terminal.txt')).toBeVisible();
      expect(await serverProcesses(ALPINE)).not.toEqual([]);
      expect((await shellState(app)).projects.find((project) => project.key === key)?.trusted).toBe(true);
    } finally {
      if (hostId !== undefined) await shutdownDistroDaemon(app, hostId, ALPINE);
      await cleanDistro(ALPINE, [folder], damoclesBefore);
    }
  });

  test(`${UBUNTU} installs into a test install folder; its own folder keeps the inotify tree while a /mnt/c folder polls and shows a change made from Windows within 6 s, and runs an agent turn`, { tag: WSL_TAG }, async ({ foreground: _foreground, home, launch }) => {
    test.setTimeout(600_000);
    await needDistros(UBUNTU);
    const damoclesBefore = await hasDamocles(UBUNTU);
    const run = `/tmp/damocles-wsl-e2e-${process.pid}-${Date.now()}`;
    const native = `${run}/proj`;
    await inDistro(UBUNTU, `mkdir -p ${quote(native)} ${quote(`${run}/install`)} && printf 'x\\n' > ${quote(native)}/native.txt`);
    const windowsFolder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-wsl-mnt-')));
    fs.writeFileSync(path.join(windowsFolder, 'seen.txt'), 'x');
    const mnt = (await inDistro(UBUNTU, `wslpath -u ${quote(windowsFolder)}`)).trim();
    let model: { readonly port: number; readonly restore: () => Promise<void> } | undefined;
    let stub: DistroModelStub | undefined;
    let hostId: string | undefined;
    let launched: ElectronApplication | undefined;
    try {
      model = await prepareDistroModel(UBUNTU, home);
      const { app } = await launch({ env: WSL_ENV });
      launched = app;
      hostId = await addDistro(app, UBUNTU);
      await setInstallFolder(app, hostId, `${run}/install`);
      const key = await openRemoteFolder(app, hostId, native);
      const shell = await shellPage(app);
      await expect(filesRow(shell, 'native.txt')).toBeVisible();
      expect((await inDistro(UBUNTU, `ls ${quote(`${run}/install`)}`)).trim()).not.toBe('');
      await untilDistroWatchLive(shell, UBUNTU, native);
      // an agent turn on the distro, its model stub run by the installed package's own Node
      const node = (await inDistro(UBUNTU, `ls -d ${quote(`${run}/install`)}/*/*-linux-x64/node/node`)).trim();
      stub = await startDistroModelStub(UBUNTU, model.port, `${run}/stub`, [{ chunks: ['Hello from Ubuntu.'] }], node);
      const tab = await newRemoteChat(app, key);
      await sendPrompt(tab, 'hello');
      await expect(tab.getByText('Hello from Ubuntu.', { exact: false })).toBeVisible({ timeout: 60_000 });
      expect(await stub.turns()).toBe(1);

      const mntKey = await openRemoteFolder(app, hostId, mnt);
      await shell.evaluate((projectKey) => window.damoclesShell!.selectProject(projectKey), mntKey);
      await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(mntKey);
      await expect(filesRow(shell, 'seen.txt')).toBeVisible();
      // one poll has to have run before a change counts: the watch is live once its first snapshot is written
      await untilDistroWatchLive(shell, UBUNTU, mnt);
      fs.writeFileSync(path.join(windowsFolder, 'from-windows.txt'), 'x');
      await expect(filesRow(shell, 'from-windows.txt')).toBeVisible({ timeout: POLL_BOUND_MS });
      const daemon = (await hostLogs(app, hostId)).daemon;
      expect(daemon).toContain(`[watcher] ${mnt} is polled every 5000 ms`);
      expect(daemon).not.toContain(`[watcher] ${native} is polled`);
      expect(key).not.toBe(mntKey);
    } finally {
      await stub?.stop();
      if (hostId !== undefined && launched) await shutdownDistroDaemon(launched, hostId, UBUNTU);
      await model?.restore();
      await cleanDistro(UBUNTU, [run], damoclesBefore);
      fs.rmSync(windowsFolder, { recursive: true, force: true });
    }
  });

  // The property under test is microsoft/WSL#3395: WSL 1 refuses to rename a folder that holds a live inotify watch, so a
  // Files rename and an npm install that replaces a package folder fail under the inotify tree, and succeed while polled.
  test('a WSL 1 distro connects and installs from the cache; renaming a folder in Files and an npm install that replaces a package succeed, and a file made in its terminal appears in Files within 6 s', { tag: WSL_TAG }, async ({ foreground: _foreground, home, launch }) => {
    test.setTimeout(600_000);
    await needDistros(WSL1);
    // the server needs libstdc++; nodejs and npm are the user's own, which the terminal's npm runs
    await apkAdd(WSL1, 'libstdc++ nodejs npm');
    expect(await clampDistroNode(WSL1)).toMatch(/^v\d+\./);
    writeUserSettings(home, { 'damocles.desktop.terminal.confirmOnKill': 'never' });
    const damoclesBefore = await freshTestDistro(WSL1);
    const npmCacheBefore = (await inDistro(WSL1, 'if [ -e "$HOME/.npm" ]; then echo yes; fi')).trim() === 'yes';
    const folder = `${await distroHome(WSL1)}/wsl1-e2e-${process.pid}`;
    const deps = `${folder}-deps`;
    // two versions of a local package, 8 folders deep with 40 files, as tarballs: the e2e reaches no registry
    await inDistro(WSL1, [
      `mkdir -p ${quote(`${folder}/lib/a/b`)} ${quote(deps)} && printf 'c\\n' > ${quote(`${folder}/lib/a/b/c.txt`)}`,
      `printf '%s' ${quote(JSON.stringify({ name: 'wsl1-app', version: '1.0.0', dependencies: { 'local-dep': `file:${deps}/local-dep-1.0.0.tgz` } }))} > ${quote(`${folder}/package.json`)}`,
      `cd ${quote(deps)} && for v in 1.0.0 2.0.0; do rm -rf package && mkdir package && printf '{"name":"local-dep","version":"%s"}' "$v" > package/package.json && for d in 1 2 3 4 5 6 7 8; do mkdir -p "package/lib$d/sub" && for f in 1 2 3 4 5; do echo "$v" > "package/lib$d/sub/f$f.js"; done; done && tar -czf "local-dep-$v.tgz" package; done && rm -rf package`,
    ].join(' && '));
    let hostId: string | undefined;
    const { app } = await launch({ env: WSL_ENV });
    try {
      hostId = await addDistro(app, WSL1);
      await openRemoteFolder(app, hostId, folder);
      expect((await lastConnectStep(app, hostId))?.visited).toEqual(['connecting', 'checking', 'installing', 'starting']);
      // the stage copied the package from the cache through wslpath, and downloaded nothing
      expect((await hostLogs(app, hostId)).bridgeStderr).not.toMatch(/curl|wget/);
      expect(await serverProcesses(WSL1)).not.toEqual([]);
      const shell = await shellPage(app);
      await untilDistroWatchLive(shell, WSL1, folder);
      expect((await hostLogs(app, hostId)).daemon).toContain(`[watcher] ${folder} is polled every 5000 ms`);

      // a folder Files lists open, renamed from Files
      await filesRow(shell, 'lib').focus();
      await shell.keyboard.press('ArrowRight');
      await expect(filesRow(shell, 'lib/a')).toBeVisible();
      await filesRow(shell, 'lib').focus();
      await shell.keyboard.press('F2');
      await shell.getByTestId('files-edit-input').fill('lib-renamed');
      await shell.getByTestId('files-edit-input').press('Enter');
      await expect(filesRow(shell, 'lib-renamed')).toBeVisible();
      await expect(filesRow(shell, 'lib')).toHaveCount(0);
      expect(await inDistro(WSL1, `cat ${quote(`${folder}/lib-renamed/a/b/c.txt`)}`)).toBe('c\n');

      // the second install renames the first one's package folder out of the way
      const terminal = await openTerminal(app);
      const install = 'npm install --offline --no-audit --no-fund --no-update-notifier';
      await runInTerminal(terminal, `${install} && ${install} ${deps}/local-dep-2.0.0.tgz; echo "npm-exit-$?"`);
      let exit: string | undefined;
      await expect.poll(async () => (exit = /^npm-exit-(\d+)$/m.exec(await terminalText(terminal))?.[1]), { timeout: 180_000 }).toBeDefined();
      expect(exit, await terminalText(terminal)).toBe('0');
      expect(JSON.parse(await inDistro(WSL1, `cat ${quote(`${folder}/node_modules/local-dep/package.json`)}`))).toEqual({ name: 'local-dep', version: '2.0.0' });
      expect((await inDistro(WSL1, `find ${quote(`${folder}/node_modules/local-dep`)} -name '*.js' -exec cat {} + | sort -u`)).trim()).toBe('2.0.0');
      expect((await inDistro(WSL1, `find ${quote(`${folder}/node_modules/local-dep`)} -name '*.js' | wc -l`)).trim()).toBe('40');

      await runInTerminal(terminal, 'touch made-in-wsl1.txt');
      await expect(filesRow(shell, 'made-in-wsl1.txt')).toBeVisible({ timeout: POLL_BOUND_MS });
    } finally {
      if (hostId !== undefined) await shutdownDistroDaemon(app, hostId, WSL1);
      await cleanDistro(WSL1, [folder, deps, ...(npmCacheBefore ? [] : ['$HOME/.npm'])], damoclesBefore);
    }
  });

  test('a dev server in WSL 2 opens on its own port with no tunnel, and with a Windows program on that port it gets a tunnel on another port showing the WSL server', { tag: WSL_TAG }, async ({ foreground: _foreground, home, launch }) => {
    test.setTimeout(600_000);
    await needDistros(ALPINE);
    await apkAdd(ALPINE, 'nodejs npm git');
    writeUserSettings(home, { 'damocles.desktop.terminal.confirmOnKill': 'never', 'damocles.browser.enabled': true });
    const damoclesBefore = await freshTestDistro(ALPINE);
    const folder = `${await distroHome(ALPINE)}/wsl-ports-${process.pid}`;
    // the dev server runs in a terminal of the distro, which the daemon keeps, as a user starts one
    const devServer = `node -e "require('http').createServer((q,s)=>s.end('wsl-5173')).listen(5173,'127.0.0.1')"`;
    await inDistro(ALPINE, `mkdir -p ${quote(folder)}`);
    let hostId: string | undefined;
    let windows: net.Server | undefined;
    const { app } = await launch({ env: { ...WSL_ENV, ...chromeEnv() } });
    const appProcess = app.process();
    try {
      hostId = await addDistro(app, ALPINE);
      const key = await openRemoteFolder(app, hostId, folder);
      const shell = await shellPage(app);
      // Open in pane shows the page in a chat of the distro
      await newRemoteChat(app, key);
      const terminal = await openTerminal(app);
      await runInTerminal(terminal, devServer);
      // WSL's relay reaches it on 5173 itself: no tunnel and no shifted port
      const row = portRow(shell, 5173);
      await expect(row).toHaveAttribute('data-via-wsl', 'true', { timeout: 60_000 });
      await expect(row.getByTestId('port-via-wsl')).toBeVisible();
      await expect(portMapping(row)).toContainText('5173');
      expect(await (await fetch('http://127.0.0.1:5173/')).text()).toBe('wsl-5173');
      await clickRowAction(shell, 5173, 'port-open-pane');
      await expect.poll(async () => (await browserTabs(app)).map((tab) => tab.browser.url), { timeout: PAGE_TIMEOUT }).toContain('http://localhost:5173/');

      // the server stops; a Windows program takes 5173; the WSL server starts again and gets a tunnel on another port
      // the pane holds the keyboard now, so the server is stopped from the distro
      await inDistro(ALPINE, "pkill -f '[l]isten[(]5173'");
      await expect(row).toHaveCount(0, { timeout: 60_000 });
      await expect.poll(() => refused(5173), { timeout: 30_000 }).toBe(true);
      const held = net.createServer((socket) => socket.end('windows'));
      windows = held;
      await new Promise<void>((resolve) => held.listen(5173, '127.0.0.1', resolve));
      await runInTerminal(terminal, devServer);
      await expect(row).toBeVisible({ timeout: 60_000 });
      await expect(row).not.toHaveAttribute('data-via-wsl', 'true');
      let local: number | undefined;
      await expect.poll(async () => (local = (await shell.evaluate((id) => window.damoclesShell!.ports.get(id), hostId!))?.rows.find((candidate) => candidate.remotePort === 5173)?.localPort), { timeout: 30_000 }).toBeDefined();
      expect(local).not.toBe(5173);
      expect(await (await fetch(`http://127.0.0.1:${local}/`)).text()).toBe('wsl-5173');
      // the pane shows the WSL server through the tunnel, with the target's own address beside it
      await clickRowAction(shell, 5173, 'port-open-pane');
      await expect.poll(async () => (await browserTabs(app)).map((tab) => [tab.browser.url, tab.browser.forwardedFrom?.targetUrl]), { timeout: PAGE_TIMEOUT }).toContainEqual([`http://localhost:${local}/`, 'http://localhost:5173/']);
    } finally {
      const held = windows;
      if (held) await new Promise<void>((resolve) => held.close(() => resolve()));
      await inDistro(ALPINE, "pkill -f '[l]isten[(]5173'; true");
      if (hostId !== undefined) await endCaseDaemon(app, appProcess, hostId, ALPINE);
      await cleanDistro(ALPINE, [folder], damoclesBefore);
    }
  });

  test('Reopen in WSL opens a \\\\wsl.localhost project in its distro, trusted, keeping the local project\'s chats, and a Windows folder through /mnt after the confirmation', { tag: WSL_TAG }, async ({ foreground: _foreground, home, launch }) => {
    test.setTimeout(600_000);
    await needDistros(ALPINE);
    await apkAdd(ALPINE, 'nodejs npm git');
    const damoclesBefore = await freshTestDistro(ALPINE);
    const folder = `${await distroHome(ALPINE)}/reopen-${process.pid}`;
    await inDistro(ALPINE, `mkdir -p ${quote(folder)} && printf 'x\\n' > ${quote(folder)}/in-wsl.txt`);
    const unc = `\\\\wsl.localhost\\${ALPINE}${folder.replaceAll('/', '\\')}`;
    const windowsFolder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-reopen-')));
    // both as local projects, the WSL one trusted, as projects.json and trusted-folders.json keep them
    fs.writeFileSync(path.join(home.userData, 'projects.json'), JSON.stringify({ version: 1, projects: [unc, windowsFolder] }));
    fs.writeFileSync(path.join(home.userData, 'trusted-folders.json'), JSON.stringify({ version: 1, folders: [unc] }));
    // the local project's chat runs on this computer's core, which reaches the stub on this computer
    const stub = await startOpenAIStub();
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch({ env: WSL_ENV });
    let hostId: string | undefined;
    try {
      const shell = await shellPage(app);
      const local = (await shellState(app)).projects.find((project) => project.fsPath === unc)!;
      expect(local.wsl).toEqual({ distro: ALPINE, path: folder });
      stub.replies.push({ chunks: ['Local answer.'] });
      const tab = await newRemoteChat(app, local.key);
      await sendPrompt(tab, 'a local chat');
      await expect(tab.getByText('Local answer.', { exact: false })).toBeVisible({ timeout: 60_000 });
      let localChats: string[] = [];
      await expect.poll(async () => (localChats = (await listChats(app, local.key)).chats.filter((chat) => !chat.id.startsWith('new:')).map((chat) => chat.id)).length, { timeout: 30_000 }).toBeGreaterThan(0);
      const notice = shell.locator(`[data-testid="wsl-notice"][data-place="row"]`);
      await expect(notice).toBeVisible();
      await notice.getByTestId('wsl-notice-reopen').click();
      const reopened = `wsl+${ALPINE}|${folder}`;
      await expect.poll(async () => (await shellState(app)).selected.projectKey, { timeout: 180_000 }).toBe(reopened);
      const state = await shellState(app);
      expect(state.projects.find((project) => project.key === reopened)?.trusted).toBe(true);
      expect(state.projects.some((project) => project.key === local.key)).toBe(true);
      // the chat stays on the local entry, and the distro's project starts without it
      expect((await listChats(app, local.key)).chats.map((chat) => chat.id)).toEqual(expect.arrayContaining(localChats));
      expect((await listChats(app, reopened)).chats.map((chat) => chat.id).filter((id) => localChats.includes(id))).toEqual([]);
      hostId = (await remoteHosts(app)).find((candidate) => candidate.authorityKey === `wsl+${ALPINE}`)?.hostId;

      // a Windows folder: Reopen in WSL..., the distro, then the /mnt confirmation
      const windowsProject = state.projects.find((project) => project.fsPath === windowsFolder)!;
      const overlay = await overlayPage(app);
      await projectRow(shell, windowsProject.key).click({ button: 'right' });
      await overlay.getByRole('menuitem', { name: 'Reopen in WSL...' }).click();
      await overlay.getByRole('menuitem', { name: new RegExp(`^${ALPINE}`) }).click();
      await overlay.getByTestId('overlay-confirm-accept').click();
      const mnt = (await inDistro(ALPINE, `wslpath -u ${quote(windowsFolder)}`)).trim();
      await expect.poll(async () => (await shellState(app)).projects.find((project) => project.key === `wsl+${ALPINE}|${mnt}`)?.connection, { timeout: 180_000 }).toBe('connected');
    } finally {
      if (hostId !== undefined) await shutdownDistroDaemon(app, hostId, ALPINE);
      await cleanDistro(ALPINE, [folder], damoclesBefore);
      // the app read the local project through \\wsl.localhost, whose connection would hold the distro for the next case
      await terminateDistro(ALPINE);
      fs.rmSync(windowsFolder, { recursive: true, force: true });
      await stub.close();
    }
  });

  test('from a WSL shell, damocles . opens the folder in its distro after asking to add it, and damocles --wait README.md returns once the tab closed', { tag: WSL_TAG }, async ({ foreground: _foreground, home, launch }) => {
    test.setTimeout(600_000);
    await needDistros(ALPINE);
    await apkAdd(ALPINE, 'nodejs npm git');
    const damoclesBefore = await freshTestDistro(ALPINE);
    const folder = `${await distroHome(ALPINE)}/cli-${process.pid}`;
    await inDistro(ALPINE, `mkdir -p ${quote(folder)} && printf '# notes\\n' > ${quote(folder)}/README.md`);
    const install = appInstallLayout(home);
    const { app } = await launch({ env: WSL_ENV });
    let hostId: string | undefined;
    try {
      await shellPage(app);
      const overlay = await overlayPage(app);
      // the command as an installed app's resources/bin/damocles, run from the distro. The Windows process it starts gets the
      // environment of the wsl.exe session, the runner's, with what WSLENV names on top: the app's profile, so that it puts
      // --wait's marker in the ~/.damocles/cli-wait main reads, and the app's temp folder
      const temp = path.join(home.root, 'tmp');
      const damocles = (args: string): Promise<string> => inDistro(ALPINE, `cd ${quote(folder)} && USERPROFILE=${quote(home.home)} TEMP=${quote(temp)} TMP=${quote(temp)} WSLENV=USERPROFILE/w:TEMP/w:TMP/w ${quote(install.script)} --user-data-dir ${quote(home.userData)} ${args}; echo "status=$?"`);

      const opened = damocles('.');
      const ask = overlay.locator('[role="alertdialog"]', { has: overlay.locator('h2', { hasText: `Add ${folder} on ${ALPINE} as a project?` }) });
      await expect(ask).toBeVisible({ timeout: 180_000 });
      await ask.getByRole('button', { name: 'Add Project', exact: true }).click();
      await trustQuestion(overlay, folder, ALPINE).getByRole('button', { name: 'Trust Folder' }).click();
      expect(await opened).toContain('status=0');
      const key = `wsl+${ALPINE}|${folder}`;
      await expect.poll(async () => (await shellState(app)).selected.projectKey, { timeout: 180_000 }).toBe(key);
      hostId = (await remoteHosts(app)).find((candidate) => candidate.authorityKey === `wsl+${ALPINE}`)?.hostId;

      let returned = false;
      const waited = damocles('--wait README.md').then((output) => {
        returned = true;
        return output;
      });
      await expect.poll(async () => { const tab = await activeTab(app); return tab && `${tab.projectKey}|${tab.relativePath}`; }, { timeout: 60_000 }).toBe(`${key}|README.md`);
      expect(returned).toBe(false);
      await clickMenu(app, 'damocles.editor.close');
      expect(await waited).toContain('status=0');
      expect(fs.readdirSync(path.join(home.home, '.damocles', 'cli-wait')).filter((name) => name.startsWith('damocles-wait-'))).toEqual([]);
    } finally {
      // a command still waiting holds the distro, and its Windows process the layout's files; ending its proxy in the distro ends it
      await inDistro(ALPINE, `pkill -f ${quote(`${path.posix.dirname(install.binary)}/[D]amocles.exe`)}; true`);
      if (hostId !== undefined) await shutdownDistroDaemon(app, hostId, ALPINE);
      await cleanDistro(ALPINE, [folder], damoclesBefore);
      install.remove();
    }
  });

  test('after a quit with Keep running and every wsl.exe client gone, the agent finishes inside WSL; the distro runs while the daemon works and idles out after it exits', { tag: WSL_TAG }, async ({ foreground: _foreground, home, launch }) => {
    test.setTimeout(900_000);
    await needDistros(ALPINE);
    await apkAdd(ALPINE, 'nodejs npm git');
    const damoclesBefore = await freshTestDistro(ALPINE);
    const folder = `${await distroHome(ALPINE)}/keep-${process.pid}`;
    await inDistro(ALPINE, `mkdir -p ${quote(folder)}`);
    writeUserSettings(home, { 'damocles.desktop.remote.closeWithRunningAgents': 'ask' });
    const restores: Array<() => Promise<void>> = [];
    let stub: DistroModelStub | undefined;
    let desktop: DesktopApp | undefined;
    let appProcess: ChildProcess | undefined;
    let hostId: string | undefined;
    try {
      const model = await prepareDistroModel(ALPINE, home);
      restores.push(model.restore);
      const started = await startDistroModelStub(ALPINE, model.port, `${folder}-stub`, [
        { chunks: ['Working.'], toolCalls: [{ name: 'bash', arguments: { command: WORK } }] },
        { chunks: ['All done.'] },
      ]);
      stub = started;
      // the turn's command runs unasked (the distro user's Claude settings), so it goes on with no device attached
      restores.push(await replaceDistroFile(ALPINE, '.claude/settings.json', JSON.stringify({ permissions: { allow: [`Bash(${WORK})`] } })));
      desktop = await launch({ env: WSL_ENV });
      // read now: Playwright's handle answers nothing once the app has closed
      appProcess = desktop.app.process();
      hostId = await addDistro(desktop.app, ALPINE);
      const key = await openRemoteFolder(desktop.app, hostId, folder);
      const tab = await newRemoteChat(desktop.app, key);
      await sendPrompt(tab, 'finish later');
      await expect(tab.getByText('Working.', { exact: false })).toBeVisible({ timeout: 60_000 });
      await requestQuit(desktop.app);
      const { dialog } = await closeRemoteDialog(desktop.app);
      await dialog.getByRole('button', { name: 'Keep running' }).click();
      await exited(desktop);
      // the app and its wsl.exe clients are gone; the daemon keeps the distro running and the turn goes on
      expect(await distroState(ALPINE)).toBe('Running');
      await expect.poll(() => inDistro(ALPINE, `cat ${quote(`${folder}/done.txt`)} 2>/dev/null; true`), { timeout: 120_000 }).toContain('finished');
      await expect.poll(() => started.turns(), { timeout: 60_000 }).toBe(2);
      expect(await serverProcesses(ALPINE)).not.toEqual([]);
      // the daemon exits; with nothing of Damocles left WSL lets the instance go, which only the list observes
      await started.stop();
      await endDistroDaemon(ALPINE);
      await expect.poll(() => distroState(ALPINE), { timeout: 180_000, intervals: [5_000] }).toBe('Stopped');
    } finally {
      await stub?.stop();
      // the daemon outlives the app by design, so a case that failed after the quit ends it in the distro
      if (hostId !== undefined && desktop && appProcess) await endCaseDaemon(desktop.app, appProcess, hostId, ALPINE);
      for (const restore of restores.reverse()) await restore();
      await cleanDistro(ALPINE, [folder, `${folder}-stub`], damoclesBefore);
    }
  });
});
