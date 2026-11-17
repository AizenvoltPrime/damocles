import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { ShellProject } from '../../src/desktop/preload/shell-channels';
import { projectMirrorFolder } from '../../src/desktop/main/remote/session-mirror';
import { targetFolderKeyOf } from '../../src/shared/project-location';
import { hostNoProjectKey } from '../../src/shared/types/usage-stats';
import { nextChat } from '../desktop/support/fixtures';
import { attachDaemonLogs, newLoopbackChat, sendPrompt, startLoopbackStub, targetAgentDir } from '../desktop/support/loopback-agent';
import { cleanUp, endLeftoverDaemon, filesUnder, LOOPBACK_ENV, LOOPBACK_TAG, shutdownDaemon } from '../desktop/support/loopback';
import { menuItem, readyOverlay } from '../desktop/support/overlay';
import { shownProjectOrder } from '../desktop/support/projects';
import { openProjectChat } from '../desktop/support/screenshots';
import { answerToast, overlayPage, recordedToasts, recordToasts, shellPage, shellState } from '../desktop/support/shell';
import { chatRow, cssString, listChats, projectRow, readyShell } from '../desktop/support/shell-ui';
import { answerDialogs, awaitTurnEnd, clickMenu, TRUST_PROMPT } from '../desktop/support/ui';
import { optIn } from '../desktop/support/worktree-chat';
import { browserEntry, pickBrowser } from './support/connect-ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { daemonVersions, installOlderServer } from './support/older-server';
import { LINUX_TARGET, SERVER_PACKAGES_DIR, serverPackage } from './support/release-mirror';
import { addHost, expect, lastConnectStep, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { chatShowing } from './support/remote-runs';
import { secondDevice } from './support/second-device';
import { TARGET_HOME, TARGET_USER, type SshdFixture } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

// Locate for remote projects (docs/invariants.md "Project relocation"): the target's core moves the chats on the target, and
// this computer's main moves the host's list entry, last chat, forge bindings, session mirror and /stats key.

const REPO = `${TARGET_HOME}/acme`;
const MOVED = `${REPO}-moved`;
const FEATURE = 'projects.relocate';
const CONFIRM_TITLE = '\'s chats to ';
const OLD = '3.6.9';
const CURRENT_PACKAGE = path.join(SERVER_PACKAGES_DIR, serverPackage(LINUX_TARGET));
const TARGET_SESSIONS = `${TARGET_HOME}/.damocles/pi/agent/sessions`;

// piSessionDir's encoding of a folder (src/core/pi-session/session-store/session-dir.ts).
const sessionDirName = (folder: string): string => `--${folder.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
const idOfSessionFile = (name: string): string | undefined => /^[^_.][^_]*_(.+)\.jsonl$/.exec(name)?.[1];

interface WorktreeRecord {
  readonly id: string;
  readonly kind: 'chat' | 'adopted';
  readonly projectPath?: string;
  readonly worktreeRoot: string;
  readonly deletedAt?: number;
}

/** The target's chat session files as `<session dir>/<file>`, sorted. */
async function targetSessionFiles(fixture: Pick<SshdFixture, 'sh'>): Promise<string[]> {
  const out = await fixture.sh(`d=${TARGET_SESSIONS}; [ -d "$d" ] || exit 0; cd "$d" && find . -mindepth 2 -maxdepth 2 -name '*.jsonl'`, TARGET_USER);
  return out.split('\n').map((line) => line.trim().replace(/^\.\//, '')).filter(Boolean).sort();
}

async function targetRegistry(fixture: Pick<SshdFixture, 'sh'>): Promise<WorktreeRecord[]> {
  const text = await fixture.sh(`f=${TARGET_HOME}/.damocles/worktrees/registry.json; [ -f "$f" ] && cat "$f" || true`, TARGET_USER);
  return text.trim() === '' ? [] : (JSON.parse(text) as { records?: WorktreeRecord[] }).records ?? [];
}

/** Whether git runs in `folder` on the target: a worktree whose link its repository's move broke fails. */
async function targetGitRuns(fixture: Pick<SshdFixture, 'sh'>, folder: string): Promise<boolean> {
  return (await fixture.sh(`git -C '${folder}' status --porcelain > /dev/null 2>&1 && echo linked || echo broken`, TARGET_USER)).trim() === 'linked';
}

const projectAt = async (app: ElectronApplication, authorityKey: string, fsPath: string): Promise<ShellProject | undefined> =>
  (await shellState(app)).projects.find((project) => project.authority.key === authorityKey && project.fsPath === fsPath);

/** Whether the list holds the project at `fsPath`, its folder there and no relocation naming it. */
async function listedAndPresent(app: ElectronApplication, authorityKey: string, fsPath: string): Promise<boolean> {
  const project = await projectAt(app, authorityKey, fsPath);
  return project !== undefined && project.presence === undefined && project.relocation === undefined;
}

const locateNotice = (shell: Page, key: string): Locator => shell.locator(`[data-testid="project-locate"][data-project-key=${cssString(key)}]`);

/** The chat id the project's list names by `title` (its first prompt). */
async function chatTitled(app: ElectronApplication, key: string, title: string): Promise<string> {
  let id = '';
  await expect.poll(async () => (id = (await listChats(app, key)).chats.find((chat) => chat.title === title)?.id ?? ''), { timeout: 60_000 }).not.toBe('');
  return id;
}

/** Locate… on the row of the project main shows missing, picking the sibling folder `to` in the host's folder browser. */
async function locate(app: ElectronApplication, key: string, to: string): Promise<void> {
  const shell = await readyShell(app);
  await expect.poll(async () => (await shellState(app)).projects.find((project) => project.key === key)?.presence, { timeout: 60_000 }).toBe('missing');
  const overlay = await overlayPage(app);
  await locateNotice(shell, key).getByTestId('project-locate-button').click();
  // the browser opens at the old folder's nearest existing ancestor, which holds `to`
  const browser = pickBrowser(overlay, 'folder');
  await expect(browser).toBeVisible();
  await browserEntry(browser, path.basename(to)).dblclick();
  await expect(browser.getByRole('navigation', { name: 'Path' }).getByRole('button').last()).toHaveAccessibleName(path.basename(to));
  await browser.getByTestId('folder-browser-confirm').click();
  await expect(browser).toHaveCount(0);
}

/** A git repository at `folder` on the target, with one commit, so its chats can opt into a worktree. */
async function targetRepo(fixture: Pick<SshdFixture, 'sh'>, folder: string): Promise<void> {
  await fixture.sh([
    "git config --global user.name 'E2E Dev'",
    'git config --global user.email dev@prod-1.invalid',
    `git init -q -b main '${folder}'`,
    `cd '${folder}'`,
    'mkdir src && echo one > src/a.txt && git add -A && git commit -q -m init',
  ].join(' && '), TARGET_USER);
}

async function openStats(tab: Page): Promise<Locator> {
  await tab.getByTestId('chat-header-more').click();
  await tab.getByRole('menuitem', { name: /Usage statistics/ }).click();
  const overlay = tab.getByTestId('usage-stats-overlay');
  await expect(overlay).toBeVisible();
  return overlay;
}

test('Locate of a renamed SSH project moves its chats on the target and re-points its worktrees, and this computer\'s list, last chat, forge binding, session mirror and /stats follow', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(900_000);
  const fixture = await sshd('prod-1');
  await targetRepo(fixture, REPO);
  const stub = await startTargetStub(home, fixture);
  try {
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    // a local project, whose chat shows this computer's /stats
    await openProjectChat(first.app, home.project);
    const localKey = (await shellState(first.app)).selected.projectKey!;
    const hostId = await addHost(first.app, { alias: 'prod-1', name: 'prod-1' });
    const authority = `ssh+${hostId}`;
    const key = await openRemoteFolder(first.app, hostId, REPO);
    await remoteProjectKey(first.app, { authorityKey: authority }, REPO);

    const worktreeTab = await optIn(first.app);
    await sendPrompt(worktreeTab, 'Worktree chat');
    await expect(worktreeTab.getByText('Echo: Worktree chat', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(worktreeTab);
    const plainTab = await newRemoteChat(first.app, key);
    await sendPrompt(plainTab, 'Plain chat');
    await expect(plainTab.getByText('Echo: Plain chat', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(plainTab);
    const plainId = await chatTitled(first.app, key, 'Plain chat');
    const worktreeId = await chatTitled(first.app, key, 'Worktree chat');
    expect((await shellState(first.app)).selected.chatId).toBe(plainId);

    const [record] = (await targetRegistry(fixture)).filter((each) => each.kind === 'chat' && each.deletedAt === undefined);
    expect(record?.projectPath).toBe(REPO);
    const oldDir = sessionDirName(REPO);
    const allSessionsBefore = await targetSessionFiles(fixture);
    const sessionsBefore = allSessionsBefore.filter((file) => file.startsWith(`${oldDir}/`));
    expect(sessionsBefore.map((file) => idOfSessionFile(path.posix.basename(file)))).toContain(plainId);
    expect(allSessionsBefore.map((file) => idOfSessionFile(path.posix.basename(file)))).toContain(worktreeId);
    const mirrorRoot = path.join(home.userData, 'remote', hostId, 'mirror');
    const oldMirror = projectMirrorFolder(mirrorRoot, targetFolderKeyOf(key)!);
    await expect.poll(() => filesUnder(oldMirror).filter((file) => file.endsWith(`_${plainId}.jsonl`)), { timeout: 60_000 }).toHaveLength(1);
    const mirroredBefore = filesUnder(oldMirror).filter((file) => file.endsWith('.jsonl'));
    const order = await shownProjectOrder(await readyShell(first.app));
    // the daemon ends with the app, so the next launch's attach reads the renamed folder as missing
    await shutdownHostDaemon(first.app, hostId, fixture);
    await first.close();

    const bindingsFile = path.join(home.userData, 'forge', 'bindings.json');
    fs.mkdirSync(path.dirname(bindingsFile), { recursive: true });
    fs.writeFileSync(bindingsFile, JSON.stringify({ version: 1, projects: { [key]: { 'github.com': { account: null, at: 1 } } }, hostDefaults: {} }, null, 2));
    await fixture.sh(`mv '${REPO}' '${MOVED}'`, TARGET_USER);

    const second = await launch(env);
    const { app } = second;
    await recordToasts(app);
    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder', [CONFIRM_TITLE]: 'Move Chats' });
    await remoteProjectKey(app, { authorityKey: authority }, REPO);
    await locate(app, key, MOVED);
    await expect.poll(() => listedAndPresent(app, authority, MOVED), { timeout: 120_000 }).toBe(true);
    const moved = (await projectAt(app, authority, MOVED))!;
    expect(moved.connection).toBe('connected');
    expect(moved.trusted).toBe(true);
    expect(await projectAt(app, authority, REPO)).toBeUndefined();
    await expect.poll(async () => (await recordedToasts(app)).map((toast) => toast.message), { timeout: 60_000 }).toContain(`Moved 2 chats of acme to ${MOVED}.`);
    expect(await shownProjectOrder(await readyShell(app))).toEqual(order.map((each) => (each === key ? moved.key : each)));

    await test.step('the chats moved on the target, once each, and the old session dir is gone', async () => {
      const after = await targetSessionFiles(fixture);
      expect(after.filter((file) => file.startsWith(`${oldDir}/`))).toEqual([]);
      for (const file of sessionsBefore) expect(after, file).toContain(`${sessionDirName(MOVED)}/${path.posix.basename(file)}`);
      // every chat file, the worktree chat's in its own session dir included, is there exactly once
      expect(after.map((file) => path.posix.basename(file)).sort()).toEqual(allSessionsBefore.map((file) => path.posix.basename(file)).sort());
      const listed = (await listChats(app, moved.key)).chats.map((chat) => chat.id);
      expect(listed).toEqual(expect.arrayContaining([plainId, worktreeId]));
    });

    await test.step('the chat worktree stayed where it was, its record names the moved project, and it is re-linked after trust', async () => {
      await expect.poll(async () => (await targetRegistry(fixture)).find((each) => each.id === record!.id)?.projectPath, { timeout: 60_000 }).toBe(MOVED);
      const after = (await targetRegistry(fixture)).find((each) => each.id === record!.id)!;
      expect(after.worktreeRoot).toBe(record!.worktreeRoot);
      await expect.poll(() => targetGitRuns(fixture, after.worktreeRoot), { timeout: 60_000 }).toBe(true);
      expect(await fixture.sh(`git -C '${MOVED}' worktree list --porcelain`, TARGET_USER)).toContain(`worktree ${after.worktreeRoot}\n`);
      await expect(chatRow(await readyShell(app), worktreeId)).toHaveAttribute('data-worktree', 'live');
      // Locate's trust in the new folder reached the host's core before the move's repair step read it
      expect((await recordedToasts(app)).map((toast) => toast.message).filter((message) => message.includes('re-link'))).toEqual([]);
    });

    await test.step('this computer\'s last chat, forge binding, trust and session mirror follow the new key', async () => {
      const lastChats = (): Array<{ projectKey: string; sessionId?: string }> =>
        (JSON.parse(fs.readFileSync(path.join(home.userData, 'remote-state.json'), 'utf8')) as { authorities: Record<string, { lastChats?: Array<{ projectKey: string; sessionId?: string }> }> }).authorities[authority]?.lastChats ?? [];
      await expect.poll(lastChats).toContainEqual({ projectKey: moved.key, sessionId: plainId });
      expect(lastChats().filter((entry) => entry.projectKey === key)).toEqual([]);
      const bindings = JSON.parse(fs.readFileSync(bindingsFile, 'utf8')) as { projects: Record<string, unknown> };
      expect(bindings.projects[moved.key]).toEqual({ 'github.com': { account: null, at: 1 } });
      expect(bindings.projects[key]).toBeUndefined();
      const trusted = (JSON.parse(fs.readFileSync(path.join(home.userData, 'remote-hosts.json'), 'utf8')) as { authorities: Record<string, { trusted: string[] }> }).authorities[authority]!.trusted;
      expect(trusted).toContain(targetFolderKeyOf(moved.key));
      expect(trusted).not.toContain(targetFolderKeyOf(key));
      const newMirror = projectMirrorFolder(mirrorRoot, targetFolderKeyOf(moved.key)!);
      expect(fs.existsSync(oldMirror)).toBe(false);
      expect(filesUnder(newMirror)).toEqual(expect.arrayContaining(mirroredBefore));
    });

    await test.step('/stats shows the host project once, under its new path', async () => {
      const shell = await shellPage(app);
      await shell.evaluate((target) => window.damoclesShell!.selectProject(target), localKey);
      await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(localKey);
      const known = [...app.windows()];
      await clickMenu(app, 'damocles.newChat');
      const localTab = await nextChat(app, known);
      const overlay = await openStats(localTab);
      // the host's no-project row (hostNoProjectKey) holds sub-calls that name no folder, which no relocation re-keys
      const noProject = `project:${hostNoProjectKey(hostId)}`;
      const hostRows = async (): Promise<string[]> => (await overlay.locator('[data-breakdown="project"] tr[data-row^="project:remote:"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row')!))).filter((row) => row !== noProject);
      await expect.poll(async () => {
        const rows = await hostRows();
        if (rows.length === 0) await overlay.getByTestId('stats-refresh').click();
        return rows;
      }, { timeout: 120_000, intervals: [2000] }).toEqual([`project:remote:${hostId}|${MOVED}`]);
    });

    expect((await recordedToasts(app)).filter((toast) => toast.severity === 'error')).toEqual([]);
    await shutdownHostDaemon(app, hostId, fixture);
    await second.close();

    await test.step('offline, the moved project lists its mirrored chats and opens a transcript', async () => {
      await fixture.stopSshd();
      const { app: offline } = await launch(env);
      await expect.poll(async () => (await lastConnectStep(offline, hostId))?.step, { timeout: 60_000 }).toBe('failed');
      const shell = await shellPage(offline);
      await shell.evaluate((target) => window.damoclesShell!.selectProject(target), moved.key);
      // the chats the old project's mirror held before the move
      const mirroredIds = mirroredBefore.filter((file) => !file.includes('/')).flatMap((file) => idOfSessionFile(file) ?? []);
      expect(mirroredIds).toContain(plainId);
      await expect.poll(async () => (await listChats(offline, moved.key)).chats.map((chat) => chat.id), { timeout: 60_000 }).toEqual(expect.arrayContaining(mirroredIds));
      expect(await shell.evaluate((id) => window.damoclesShell!.selectChat(id), plainId)).toEqual({ ok: true });
      await chatShowing(offline, 'Echo: Plain chat');
    });
  } finally {
    await stub.close();
  }
});

test('a Locate whose daemon core is killed mid-run finishes once the daemon\'s restarted core takes over, with no chat file duplicated or lost', { tag: LOOPBACK_TAG }, async ({ home, launch }, testInfo) => {
  test.setTimeout(480_000);
  // server packages refuse e2e.*, so the pause hook reaches only the loopback authority's dev-tree daemon
  const stub = await startLoopbackStub(home);
  const folder = path.join(home.root, 'acme');
  const moved = `${folder}-moved`;
  fs.mkdirSync(folder, { recursive: true });
  const sessionsRoot = path.join(targetAgentDir(home), 'sessions');
  const chatFiles = (): string[] => filesUnder(sessionsRoot).filter((file) => file.split('/').length === 2 && idOfSessionFile(file.split('/')[1]!) !== undefined);
  let app: ElectronApplication | undefined;
  let failure: unknown;
  try {
    ({ app } = await launch(LOOPBACK_ENV));
    const { key, tab } = await newLoopbackChat(app, folder);
    const pages = [tab];
    for (const [index, prompt] of ['First chat', 'Second chat', 'Third chat'].entries()) {
      if (index > 0) {
        const known = [...app.windows()];
        await clickMenu(app, 'damocles.newChat');
        pages.push(await nextChat(app, known));
      }
      await sendPrompt(pages[index]!, prompt);
      await expect(pages[index]!.getByText(`Echo: ${prompt}`, { exact: true })).toBeVisible({ timeout: 60_000 });
      await awaitTurnEnd(pages[index]!);
    }
    const before = new Map(chatFiles().map((file) => [file, fs.readFileSync(path.join(sessionsRoot, ...file.split('/')), 'latin1')]));
    expect([...before.keys()].map((file) => file.split('/')[0])).toEqual(Array<string>(3).fill(sessionDirName(folder)));
    await shutdownDaemon(app, home);
    await app.close();
    fs.renameSync(folder, moved);

    ({ app } = await launch(LOOPBACK_ENV));
    const hooked = app;
    await answerDialogs(hooked, { [TRUST_PROMPT]: 'Trust Folder', [CONFIRM_TITLE]: 'Move Chats' });
    const shell = await shellPage(hooked);
    await shell.evaluate((target) => window.damoclesShell!.selectProject(target), key);
    await expect.poll(async () => (await shellState(hooked)).projects.find((project) => project.key === key)?.connection, { timeout: 60_000 }).toBe('connected');
    type Hooks = { __damoclesE2e: { remote: { relocationPauseAfter(authorityKey: string, sessions: number | null, mode: 'pause' | 'hang'): Promise<void> }; loopback: { coreState(): Promise<{ pid: number | null; epoch: string | null; phase: string }>; engine(): { epoch: string | null } } } };
    // the hook needs main's remote core of the authority, which attaches after the connection
    await expect.poll(() => hooked.evaluate(() => (globalThis as unknown as Hooks).__damoclesE2e.loopback.engine().epoch), { timeout: 60_000 }).not.toBeNull();
    await hooked.evaluate(() => (globalThis as unknown as Hooks).__damoclesE2e.remote.relocationPauseAfter('loopback', 1, 'hang'));
    const core = await hooked.evaluate(() => (globalThis as unknown as Hooks).__damoclesE2e.loopback.coreState());
    expect(core.pid).not.toBeNull();
    await locate(hooked, key, moved);

    // the run hangs after its first commit, holding the relocation lock
    await expect.poll(() => chatFiles().filter((file) => file.startsWith(`${sessionDirName(moved)}/`)).length, { timeout: 60_000 }).toBe(1);
    await expect.poll(async () => (await shellState(hooked)).projects.find((project) => project.key === key)?.relocation?.state).toBe('running');
    process.kill(core.pid!, 'SIGKILL');
    await expect.poll(async () => {
      const next = await hooked.evaluate(() => (globalThis as unknown as Hooks).__damoclesE2e.loopback.coreState());
      return next.phase === 'running' && next.epoch !== core.epoch;
    }, { timeout: 90_000 }).toBe(true);

    await expect.poll(() => listedAndPresent(hooked, 'loopback', moved), { timeout: 120_000 }).toBe(true);
    expect(await projectAt(hooked, 'loopback', folder)).toBeUndefined();
    const after = chatFiles();
    expect(after.map((file) => file.split('/')[0])).toEqual(Array<string>(3).fill(sessionDirName(moved)));
    expect(after.map((file) => file.split('/')[1]).sort()).toEqual([...before.keys()].map((file) => file.split('/')[1]).sort());
    for (const [file, bytes] of before) {
      const now = fs.readFileSync(path.join(sessionsRoot, sessionDirName(moved), file.split('/')[1]!), 'latin1');
      expect(now.startsWith(bytes), `${file} lost bytes`).toBe(true);
    }
    expect(fs.existsSync(path.join(sessionsRoot, sessionDirName(folder)))).toBe(false);
    await shutdownDaemon(hooked, home);
  } catch (error) {
    failure = error;
    await attachDaemonLogs(testInfo, home);
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
    await stub.close();
  }
});

test('a daemon without projects.relocate shows Locate disabled with "Update Damocles on prod-1", offers no Locate in the row menu, and Remove still works', { tag: SSH_TAG }, async ({ launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  // this tree's package as an older build whose daemon does not list the feature
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: OLD, withoutFeature: FEATURE });
  await fixture.sh(`mkdir -p '${REPO}'`, TARGET_USER);
  const env = { env: { ...remoteEnv(ssh, mirror), DAMOCLES_E2E_APP_VERSION: OLD } };
  const first = await launch(env);
  const hostId = await addHost(first.app, { alias: 'prod-1', name: 'prod-1' });
  const authority = `ssh+${hostId}`;
  const key = await openRemoteFolder(first.app, hostId, REPO);
  await remoteProjectKey(first.app, { authorityKey: authority }, REPO);
  expect(await daemonVersions(fixture)).toEqual([OLD]);
  await first.close();
  await fixture.sh(`mv '${REPO}' '${MOVED}'`, TARGET_USER);

  const { app } = await launch(env);
  await remoteProjectKey(app, { authorityKey: authority }, REPO);
  await expect.poll(async () => (await shellState(app)).projects.find((project) => project.key === key)?.presence, { timeout: 60_000 }).toBe('missing');
  const shell = await readyShell(app);
  const notice = locateNotice(shell, key);
  await expect(notice.getByTestId('project-locate-unsupported')).toHaveText('Update Damocles on prod-1 to locate this folder.');
  await expect(notice.getByTestId('project-locate-button')).toBeDisabled();

  // the row's name line: the notice under it stops its own context menu
  await projectRow(shell, key).click({ button: 'right', position: { x: 12, y: 8 } });
  const overlay = await readyOverlay(app);
  await expect(menuItem(overlay, 'remove')).toBeVisible();
  await expect(menuItem(overlay, 'locate')).toHaveCount(0);
  await menuItem(overlay, 'remove').click();
  await expect.poll(async () => (await shellState(app)).projects.some((project) => project.key === key)).toBe(false);
  // nothing moved on the target
  expect(await fixture.sh(`test -d '${MOVED}' && test ! -e '${REPO}' && echo kept`, TARGET_USER)).toContain('kept');
  await shutdownHostDaemon(app, hostId, fixture);
});

test('a second device that lists the old path is told "Chats moved to <path> on prod-1." and Open moves its row there', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }, testInfo) => {
  test.setTimeout(900_000);
  const fixture = await sshd('prod-1');
  await fixture.sh(`mkdir -p '${REPO}/src'`, TARGET_USER);
  const stub = await startTargetStub(home, fixture);
  const other = await secondDevice(fixture, 'prod-1', mirror);
  let failed = true;
  try {
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    const hostId = await addHost(first.app, { alias: 'prod-1', name: 'prod-1' });
    const authority = `ssh+${hostId}`;
    const key = await openRemoteFolder(first.app, hostId, REPO);
    await remoteProjectKey(first.app, { authorityKey: authority }, REPO);
    const tab = await newRemoteChat(first.app, key);
    await sendPrompt(tab, 'Before the move');
    await expect(tab.getByText('Echo: Before the move', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    const chatId = await chatTitled(first.app, key, 'Before the move');

    // the second device lists the old path, then quits
    const otherFirst = await other.launch();
    const otherHostId = await addHost(otherFirst.app, { alias: 'prod-1', name: 'prod-1' });
    const otherAuthority = `ssh+${otherHostId}`;
    const otherKey = await openRemoteFolder(otherFirst.app, otherHostId, REPO);
    await remoteProjectKey(otherFirst.app, { authorityKey: otherAuthority }, REPO);
    await otherFirst.close();

    await shutdownHostDaemon(first.app, hostId, fixture);
    await first.close();
    await fixture.sh(`mv '${REPO}' '${MOVED}'`, TARGET_USER);

    const relocating = await launch(env);
    await answerDialogs(relocating.app, { [TRUST_PROMPT]: 'Trust Folder', [CONFIRM_TITLE]: 'Move Chats' });
    await remoteProjectKey(relocating.app, { authorityKey: authority }, REPO);
    await locate(relocating.app, key, MOVED);
    await expect.poll(() => listedAndPresent(relocating.app, authority, MOVED), { timeout: 120_000 }).toBe(true);
    await shutdownHostDaemon(relocating.app, hostId, fixture);
    await relocating.close();

    const otherAgain = await other.launch();
    const { app } = otherAgain;
    await recordToasts(app);
    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder' });
    const message = `Chats moved to ${MOVED} on prod-1.`;
    await expect.poll(async () => (await recordedToasts(app)).map((toast) => toast.message), { timeout: 120_000 }).toContain(message);
    const toast = (await recordedToasts(app)).find((each) => each.message === message)!;
    expect(toast.actions).toContain('Open');
    expect((await projectAt(app, otherAuthority, REPO))?.presence).toBe('missing');
    await answerToast(app, toast.id, 'Open');
    await expect.poll(() => listedAndPresent(app, otherAuthority, MOVED), { timeout: 120_000 }).toBe(true);
    expect(await projectAt(app, otherAuthority, REPO)).toBeUndefined();
    const movedKey = (await projectAt(app, otherAuthority, MOVED))!.key;
    expect(movedKey).not.toBe(otherKey);
    await expect.poll(async () => (await listChats(app, movedKey)).chats.map((chat) => chat.id), { timeout: 60_000 }).toContain(chatId);
    await shutdownHostDaemon(app, otherHostId, fixture);
    failed = false;
  } finally {
    await other.dispose(testInfo, failed);
    await stub.close();
  }
});
