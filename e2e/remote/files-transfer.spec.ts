import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { isAlive, windowsProcessTree } from '../desktop/support/app';
import { filesRow } from '../desktop/support/editor';
import { pidIn } from '../desktop/support/loopback';
import { answerMessage, dropOnRow, partsUnder, tree } from '../desktop/support/file-drops';
import { menuItem, overlayMenu } from '../desktop/support/overlay';
import { overlayPage, recordedToasts, recordToasts, shellPage } from '../desktop/support/shell';
import { answerOpenDialog, answerSaveDialog, saveDialogDefaults } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { expect, test, type ProxiedHost } from './support/flaky';
import { addHost, control, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test as remoteTest, WINDOWS_TARGET_TAG } from './support/remote';
import { runnerTargetEnv } from './support/runner-target';
import type { SshdFixture } from './support/sshd';

const APP = '/srv/app';

const onTarget = (fixture: SshdFixture, script: string): Promise<string> => fixture.sh(script, 'dev');
// the target's parts under APP, which a finished or cancelled transfer leaves none of
const partsOnTarget = async (fixture: SshdFixture): Promise<string> => (await onTarget(fixture, `find ${APP} -name '*.damocles-*.part'`)).trim();

async function openApp(app: ElectronApplication, alias: string): Promise<{ readonly hostId: string; readonly key: string; readonly shell: Page }> {
  const hostId = await addHost(app, { alias, name: alias });
  const key = await openRemoteFolder(app, hostId, APP);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  const shell = await shellPage(app);
  await shell.evaluate((projectKey) => window.damoclesShell!.selectProject(projectKey), key);
  return { hostId, key, shell };
}

async function openMenu(app: ElectronApplication, shell: Page, treePath: string): Promise<Page> {
  await filesRow(shell, treePath).click({ button: 'right' });
  const overlay = await overlayPage(app);
  await expect(overlayMenu(overlay)).toBeVisible();
  return overlay;
}

test('a dropped folder lands on the target with its tree, script and link; a clash asks; Download lands a folder without a link out or a name this computer refuses, and a file through the Save dialog', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, proxied, home }) => {
  test.setTimeout(600_000);
  const host: ProxiedHost = await proxied('prod-1');
  await onTarget(host.fixture, `mkdir -p ${APP}/src && printf 'old' > ${APP}/src/readme.txt`);
  const source = path.join(home.root, 'assets');
  fs.mkdirSync(path.join(source, 'img', 'icons'), { recursive: true });
  fs.writeFileSync(path.join(source, 'img', 'icons', 'logo.svg'), '<svg/>');
  fs.writeFileSync(path.join(source, 'build.sh'), '#!/bin/sh\necho built\n', { mode: 0o755 });
  fs.symlinkSync(path.join('img', 'icons', 'logo.svg'), path.join(source, 'latest.svg'), 'file');
  fs.writeFileSync(path.join(home.root, 'readme.txt'), 'new');
  const before = tree(source);
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  await recordToasts(app);
  const { hostId, shell } = await openApp(app, 'prod-1');
  await expect(filesRow(shell, 'src')).toBeVisible({ timeout: 60_000 });

  expect(await dropOnRow(shell, 'src', [source])).toBe(true);
  await expect.poll(() => onTarget(host.fixture, `readlink ${APP}/src/assets/latest.svg`), { timeout: 60_000 }).toBe('img/icons/logo.svg\n');
  expect(await onTarget(host.fixture, `cat ${APP}/src/assets/img/icons/logo.svg`)).toBe('<svg/>');
  // the target creates the file with the mode bits the client sends (a Windows client's are 0o666) under its own umask, so
  // a script from POSIX stays executable and nothing from Windows lands world-writable
  const umask = Number.parseInt((await onTarget(host.fixture, 'umask')).trim(), 8);
  const mode = Number.parseInt((await onTarget(host.fixture, `stat -c %a ${APP}/src/assets/build.sh`)).trim(), 8);
  expect(mode).toBe((process.platform === 'win32' ? 0o666 : 0o755) & ~umask);
  expect(mode & 0o002).toBe(0);
  expect(tree(source)).toEqual(before);
  expect(await partsOnTarget(host.fixture)).toBe('');

  // a clash on the target asks, and Keep both names the copy
  expect(await dropOnRow(shell, 'src', [path.join(home.root, 'readme.txt')])).toBe(true);
  await answerMessage(app, '\'readme.txt\' already exists in \'src\'', 'Keep both');
  await expect.poll(() => onTarget(host.fixture, `cat '${APP}/src/readme copy.txt'`)).toBe('new');
  expect(await onTarget(host.fixture, `cat ${APP}/src/readme.txt`)).toBe('old');

  // Download of a folder holding a link to /etc/passwd and names this computer refuses
  const refused = process.platform === 'win32' ? ['aux.txt', 'bad:name', 'trail.'] : ['back\\slash'];
  await onTarget(host.fixture, [`mkdir -p ${APP}/logs/deep`, `printf 'log' > ${APP}/logs/app.log`, `printf 'deep' > ${APP}/logs/deep/d.log`, `ln -s /etc/passwd ${APP}/logs/passwd`, `ln -s app.log ${APP}/logs/latest`, ...refused.map((name) => `printf x > '${APP}/logs/${name}'`)].join(' && '));
  await expect(filesRow(shell, 'logs')).toBeVisible();
  const picked = path.join(home.root, 'downloads');
  fs.mkdirSync(picked);
  await answerOpenDialog(app, picked);
  const overlay = await openMenu(app, shell, 'logs');
  await menuItem(overlay, 'download').click();
  await expect.poll(() => fs.existsSync(path.join(picked, 'logs', 'deep', 'd.log')), { timeout: 60_000 }).toBe(true);
  await expect.poll(async () => (await recordedToasts(app)).some((toast) => toast.message.startsWith('Downloaded '))).toBe(true);
  const downloaded = tree(path.join(picked, 'logs'));
  expect(downloaded).toEqual(process.platform === 'win32' ? ['app.log', 'deep/', 'deep/d.log'] : ['app.log', 'deep/', 'deep/d.log', 'latest -> app.log']);
  expect(fs.readdirSync(picked)).toEqual(['logs']);
  expect(partsUnder(picked)).toEqual([]);

  // a file goes through the Save dialog, opened on the last folder with the file's name
  const saved = path.join(home.root, 'saved', 'app copy.log');
  fs.mkdirSync(path.dirname(saved));
  await answerSaveDialog(app, saved);
  await filesRow(shell, 'logs').click();
  const fileMenu = await openMenu(app, shell, 'logs/app.log');
  await menuItem(fileMenu, 'download').click();
  await expect.poll(() => fs.existsSync(saved), { timeout: 60_000 }).toBe(true);
  expect(fs.readFileSync(saved, 'utf8')).toBe('log');
  expect(await saveDialogDefaults(app)).toEqual([path.join(picked, 'app.log')]);
  await shutdownHostDaemon(app, hostId, host.fixture);
});

test('Cancel leaves no part on the target, a cut that resumes finishes the copy, and an offline host disables Download and refuses a drop with nothing queued', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, proxied, home }) => {
  test.setTimeout(600_000);
  const host: ProxiedHost = await proxied('prod-1');
  await onTarget(host.fixture, `mkdir -p ${APP}/src && printf 'x' > ${APP}/notes.md`);
  const big = path.join(home.root, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(24 * 1024 * 1024, 5));
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  await recordToasts(app);
  const { hostId, shell } = await openApp(app, 'prod-1');
  await expect(filesRow(shell, 'src')).toBeVisible({ timeout: 60_000 });

  // slow every chunk so the transfer is still running when it is cancelled
  host.proxy.delay(40);
  expect(await dropOnRow(shell, 'src', [big])).toBe(true);
  await expect(shell.getByTestId('files-transfer')).toHaveAttribute('data-phase', 'running');
  await expect.poll(async () => (await partsOnTarget(host.fixture)).length > 0, { timeout: 60_000 }).toBe(true);
  await shell.getByTestId('files-transfer-cancel').click();
  await expect(shell.getByTestId('files-transfer')).toHaveCount(0);
  await expect.poll(() => partsOnTarget(host.fixture), { timeout: 60_000 }).toBe('');
  expect(await onTarget(host.fixture, `ls -A ${APP}/src`)).toBe('');

  // a cut while the bytes flow: the connection resumes inside the grace and the same transfer finishes
  expect(await dropOnRow(shell, 'src', [big])).toBe(true);
  await expect.poll(async () => (await partsOnTarget(host.fixture)).length > 0, { timeout: 60_000 }).toBe(true);
  host.proxy.cut();
  host.proxy.delay(0);
  await expect.poll(() => onTarget(host.fixture, `stat -c %s ${APP}/src/big.bin 2>/dev/null || true`), { timeout: 240_000 }).toBe(`${24 * 1024 * 1024}\n`);
  expect((await onTarget(host.fixture, `sha256sum ${APP}/src/big.bin`)).split(' ')[0]).toBe(createHash('sha256').update(fs.readFileSync(big)).digest('hex'));
  expect(await partsOnTarget(host.fixture)).toBe('');
  expect((await recordedToasts(app)).filter((toast) => toast.message.includes('stopped'))).toEqual([]);

  // offline: Download is disabled, and a drop is refused with nothing queued
  host.proxy.refuse();
  await expect.poll(async () => (await shell.evaluate(() => window.damoclesShell!.getState())).projects.find((project) => project.fsPath === APP)?.connection, { timeout: 60_000 }).not.toBe('connected');
  const overlay = await openMenu(app, shell, 'notes.md');
  await expect(menuItem(overlay, 'download')).toHaveAttribute('aria-disabled', 'true');
  await overlay.keyboard.press('Escape');
  const small = path.join(home.root, 'small.txt');
  fs.writeFileSync(small, 'small');
  await dropOnRow(shell, 'src', [small]);
  await expect.poll(async () => (await recordedToasts(app)).map((toast) => toast.message)).toContain('prod-1 is offline. Reconnect to copy files.');
  await expect(shell.getByTestId('files-transfer')).toHaveCount(0);
  host.proxy.restore();
  await expect.poll(async () => (await shell.evaluate(() => window.damoclesShell!.getState())).projects.find((project) => project.fsPath === APP)?.connection, { timeout: 120_000 }).toBe('connected');
  expect(await onTarget(host.fixture, `ls -A ${APP}/src`)).toBe('big.bin\n');
  await shutdownHostDaemon(app, hostId, host.fixture);
});

test('Cut on one host and Paste on another moves the file, deleting the source only once the copy landed', { tag: SSH_TAG }, async ({ clipboard, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const one = await sshd('prod-1');
  const two = await sshd('prod-2');
  await onTarget(one, `mkdir -p ${APP}/src && printf 'moving' > ${APP}/src/app.ts`);
  await onTarget(two, `mkdir -p ${APP}/lib`);
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  // the OS clipboard is the machine's: an image or files left on it would be pasted as OS files ahead of the Files clipboard
  await clipboard.writeText(app, '');
  const first = await openApp(app, 'prod-1');
  const second = await openApp(app, 'prod-2');
  const { shell } = first;
  await shell.evaluate((projectKey) => window.damoclesShell!.selectProject(projectKey), first.key);
  await expect(filesRow(shell, 'src')).toBeVisible({ timeout: 60_000 });
  await filesRow(shell, 'src').click();
  const cutMenu = await openMenu(app, shell, 'src/app.ts');
  await menuItem(cutMenu, 'cut').click();
  await expect(filesRow(shell, 'src/app.ts')).toHaveAttribute('data-cut', /.*/);
  await shell.evaluate((projectKey) => window.damoclesShell!.selectProject(projectKey), second.key);
  await expect(filesRow(shell, 'lib')).toBeVisible({ timeout: 60_000 });
  const pasteMenu = await openMenu(app, shell, 'lib');
  await menuItem(pasteMenu, 'paste').click();
  await expect.poll(() => onTarget(two, `cat ${APP}/lib/app.ts 2>/dev/null || true`), { timeout: 60_000 }).toBe('moving');
  await expect.poll(() => onTarget(one, `ls -A ${APP}/src`)).toBe('');
  expect(await partsOnTarget(two)).toBe('');
  await shutdownHostDaemon(app, first.hostId, one);
  await shutdownHostDaemon(app, second.hostId, two);
});

// The nightly workflow's Windows runner is the target and the client: a Windows host makes no link, so the drop lists it skipped.
remoteTest('a dropped folder lands on a Windows target without its link, which the summary lists', { tag: WINDOWS_TARGET_TAG }, async ({ foreground: _foreground, home, launch }) => {
  test.setTimeout(600_000);
  const folder = path.join(home.root, 'target-project');
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  const source = path.join(home.root, 'assets');
  fs.mkdirSync(path.join(source, 'img'), { recursive: true });
  fs.writeFileSync(path.join(source, 'img', 'logo.svg'), '<svg/>');
  fs.symlinkSync(path.join('img', 'logo.svg'), path.join(source, 'latest.svg'), 'file');
  const { app } = await launch({ env: await runnerTargetEnv(home) });
  await recordToasts(app);
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, folder);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, folder);
  const shell = await shellPage(app);
  await shell.evaluate((projectKey) => window.damoclesShell!.selectProject(projectKey), key);
  await expect(filesRow(shell, 'src')).toBeVisible({ timeout: 60_000 });
  expect(await dropOnRow(shell, 'src', [source])).toBe(true);
  await expect.poll(async () => (await recordedToasts(app)).map((toast) => toast.message), { timeout: 60_000 }).toContain('Copied 1 of 2 items to prod-1. 1 skipped');
  expect(tree(path.join(folder, 'src', 'assets'))).toEqual(['img/', 'img/logo.svg']);
  expect(partsUnder(folder)).toEqual([]);
  // the runner's account is the target's, so its daemon's pid file is in this computer's real home
  const pid = await pidIn(os.homedir());
  expect(pid).toBeDefined();
  const daemonTree = await windowsProcessTree(pid!);
  await control(app, hostId, 'shutdownNow');
  await expect.poll(() => daemonTree.filter(isAlive), { timeout: 30_000 }).toEqual([]);
});
