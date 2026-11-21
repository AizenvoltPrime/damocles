import * as path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { targetFolderKeyOf } from '../../src/shared/project-location';
import { projectMirrorFolder } from '../../src/shared/remote-mirror';
import { filesUnder } from '../desktop/support/loopback';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { shellPage } from '../desktop/support/shell';
import { chatRow, listChats } from '../desktop/support/shell-ui';
import { awaitTurnEnd, chatInput } from '../desktop/support/ui';
import { optIn } from '../desktop/support/worktree-chat';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { daemonVersions, installOlderServer } from './support/older-server';
import { LINUX_TARGET, SERVER_PACKAGES_DIR, serverPackage } from './support/release-mirror';
import { addHost, expect, hostState, lastConnectStep, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { chatShowing } from './support/remote-runs';
import { TARGET_HOME, TARGET_USER, type SshdFixture } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

// A remote project's offline Chats list is its session mirror's (docs/invariants.md "Remote daemon and wire"): its worktree
// chats' session files live in their working folders' session folders, which mirror.syncProject brings under worktree.<id>,
// and the offline list picks the project's sessions from them as the live list does ("Worktree chats", Ownership).

const REPO = `${TARGET_HOME}/acme`;
const FEATURE = 'mirror.worktreeChats';
const OLD = '3.6.9';
const CURRENT_PACKAGE = path.join(SERVER_PACKAGES_DIR, serverPackage(LINUX_TARGET));
// mirror names of a worktree chat's session file: worktree.<worktree id>/<timestamp>_<session id>.jsonl
const WORKTREE_SESSION = /^worktree\.[0-9a-z]{8}\/[^/]+\.jsonl$/;

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

interface WorktreeRecord {
  readonly kind: 'chat' | 'adopted';
  readonly projectPath?: string;
  readonly workingFolder: string;
  readonly deletedAt?: number;
}

/** The target's worktree registry records (core's registry.json). */
async function targetRegistry(fixture: Pick<SshdFixture, 'sh'>): Promise<WorktreeRecord[]> {
  const text = await fixture.sh(`f=${TARGET_HOME}/.damocles/worktrees/registry.json; [ -f "$f" ] && cat "$f" || true`, TARGET_USER);
  return text.trim() === '' ? [] : (JSON.parse(text) as { records?: WorktreeRecord[] }).records ?? [];
}

// The project's Chats list, loaded chats and stored ones, less the chats with no conversation that opening a project makes;
// offline it is the mirror's stored chats alone.
async function listedChats(app: ElectronApplication, key: string): Promise<string[]> {
  return (await listChats(app, key)).chats.map((chat) => chat.id).filter((id) => !id.startsWith('new:')).sort();
}

/** The chat id the project's list names by `title` (its first prompt). */
async function chatTitled(app: ElectronApplication, key: string, title: string): Promise<string> {
  let id = '';
  await expect.poll(async () => (id = (await listChats(app, key)).chats.find((chat) => chat.title === title)?.id ?? ''), { timeout: 60_000 }).not.toBe('');
  return id;
}

/** One turn in a chat working in its own chat worktree, then one in a plain chat of the project; resolves their ids. */
async function worktreeAndPlainChats(app: ElectronApplication, key: string): Promise<{ readonly worktreeId: string; readonly plainId: string }> {
  const worktreeTab = await optIn(app);
  await sendPrompt(worktreeTab, 'Worktree chat');
  await expect(worktreeTab.getByText('Echo: Worktree chat', { exact: true })).toBeVisible({ timeout: 60_000 });
  await awaitTurnEnd(worktreeTab);
  const plainTab = await newRemoteChat(app, key);
  await sendPrompt(plainTab, 'Plain chat');
  await expect(plainTab.getByText('Echo: Plain chat', { exact: true })).toBeVisible({ timeout: 60_000 });
  await awaitTurnEnd(plainTab);
  return { worktreeId: await chatTitled(app, key, 'Worktree chat'), plainId: await chatTitled(app, key, 'Plain chat') };
}

/** The host goes unreachable and the app launches again with its project selected; resolves the offline app. */
async function launchOffline(relaunch: () => Promise<{ readonly app: ElectronApplication }>, fixture: Pick<SshdFixture, 'stopSshd'>, hostId: string, key: string): Promise<ElectronApplication> {
  await fixture.stopSshd();
  const { app } = await relaunch();
  await expect.poll(async () => (await lastConnectStep(app, hostId))?.step, { timeout: 60_000 }).toBe('failed');
  await (await shellPage(app)).evaluate((projectKey) => window.damoclesShell!.selectProject(projectKey), key);
  return app;
}

test('with the host offline its project lists the worktree chat it lists online, and opening it shows its read-only transcript', { tag: SSH_TAG }, async ({ home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(900_000);
  const fixture = await sshd('prod-1');
  await targetRepo(fixture, REPO);
  const stub = await startTargetStub(home, fixture);
  try {
    const env = remoteEnv(ssh, mirror);
    const first = await launch({ env });
    const hostId = await addHost(first.app, { alias: 'prod-1', name: 'prod-1' });
    const key = await openRemoteFolder(first.app, hostId, REPO);
    await remoteProjectKey(first.app, { authorityKey: `ssh+${hostId}` }, REPO);
    const { worktreeId, plainId } = await worktreeAndPlainChats(first.app, key);
    const online = (await listChats(first.app, key)).chats.map((chat) => chat.id).sort();
    expect(online).toEqual([plainId, worktreeId].sort());
    // the worktree chat's file lands in the project's one mirror folder, under its worktree's folder
    const projectMirror = projectMirrorFolder(path.join(home.userData, 'remote', hostId, 'mirror'), targetFolderKeyOf(key)!);
    await expect.poll(() => filesUnder(projectMirror).filter((file) => WORKTREE_SESSION.test(file) && file.endsWith(`_${worktreeId}.jsonl`)), { timeout: 60_000 }).toHaveLength(1);
    await expect.poll(() => filesUnder(projectMirror).filter((file) => file === path.posix.basename(file) && file.endsWith(`_${plainId}.jsonl`)), { timeout: 60_000 }).toHaveLength(1);
    await shutdownHostDaemon(first.app, hostId, fixture);
    await first.close();

    const app = await launchOffline(() => launch({ env }), fixture, hostId, key);
    await expect.poll(async () => (await listChats(app, key)).chats.map((chat) => chat.id).sort(), { timeout: 60_000 }).toEqual(online);
    expect(await hostState(app, hostId)).not.toBe('connected');
    await chatRow(await shellPage(app), worktreeId).click();
    const transcript = await chatShowing(app, 'Echo: Worktree chat');
    await expect(transcript.getByText('Worktree chat', { exact: true }).first()).toBeVisible();
    await expect(transcript.getByTestId('composer-offline')).toContainText('prod-1 is offline');
    await expect(chatInput(transcript)).toHaveCount(0);
  } finally {
    await stub.close();
  }
});

test('a worktree chat whose working folder is also a project lists under its own project, offline as online, and the folder lists its own chat alone', { tag: SSH_TAG }, async ({ home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(900_000);
  const fixture = await sshd('prod-1');
  await targetRepo(fixture, REPO);
  const stub = await startTargetStub(home, fixture);
  try {
    const env = remoteEnv(ssh, mirror);
    const first = await launch({ env });
    const hostId = await addHost(first.app, { alias: 'prod-1', name: 'prod-1' });
    const key = await openRemoteFolder(first.app, hostId, REPO);
    await remoteProjectKey(first.app, { authorityKey: `ssh+${hostId}` }, REPO);
    const { worktreeId, plainId } = await worktreeAndPlainChats(first.app, key);
    const workingFolder = (await targetRegistry(fixture)).find((record) => record.kind === 'chat' && record.projectPath === REPO && record.deletedAt === undefined)?.workingFolder;
    expect(workingFolder).toBeDefined();
    const mirrorRoot = path.join(home.userData, 'remote', hostId, 'mirror');
    const projectMirror = projectMirrorFolder(mirrorRoot, targetFolderKeyOf(key)!);
    const worktreeCopies = (): string[] => filesUnder(projectMirror).filter((file) => WORKTREE_SESSION.test(file) && file.endsWith(`_${worktreeId}.jsonl`));
    await expect.poll(worktreeCopies, { timeout: 60_000 }).toHaveLength(1);
    const addWorkingFolder = async (): Promise<string> => {
      await openRemoteFolder(first.app, hostId, workingFolder!);
      return remoteProjectKey(first.app, { authorityKey: `ssh+${hostId}` }, workingFolder!);
    };

    const worktreeKey = await addWorkingFolder();
    const ownTab = await newRemoteChat(first.app, worktreeKey);
    await sendPrompt(ownTab, 'Own chat');
    await expect(ownTab.getByText('Echo: Own chat', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(ownTab);
    const ownId = await chatTitled(first.app, worktreeKey, 'Own chat');
    await expect.poll(() => listedChats(first.app, key), { timeout: 60_000 }).toEqual([plainId, worktreeId].sort());
    await expect.poll(() => listedChats(first.app, worktreeKey), { timeout: 60_000 }).toEqual([ownId]);
    // the project's chat working in the worktree stays loaded under its project
    expect((await listChats(first.app, key)).chats.find((chat) => chat.id === worktreeId)?.loaded).toBe(true);
    // the worktree's session folder is mirrored under the project and as the folder's own, each list picking its sessions there
    await expect.poll(worktreeCopies, { timeout: 60_000 }).toHaveLength(1);
    const worktreeMirror = projectMirrorFolder(mirrorRoot, targetFolderKeyOf(worktreeKey)!);
    await expect.poll(() => filesUnder(worktreeMirror).filter((file) => file === path.posix.basename(file) && [worktreeId, ownId].some((id) => file.endsWith(`_${id}.jsonl`))).length, { timeout: 60_000 }).toBe(2);
    const online = { project: await listedChats(first.app, key), worktree: await listedChats(first.app, worktreeKey) };
    await shutdownHostDaemon(first.app, hostId, fixture);
    await first.close();

    const app = await launchOffline(() => launch({ env }), fixture, hostId, key);
    await expect.poll(() => listedChats(app, key), { timeout: 60_000 }).toEqual(online.project);
    await expect.poll(() => listedChats(app, worktreeKey), { timeout: 60_000 }).toEqual(online.worktree);
    expect(online).toEqual({ project: [plainId, worktreeId].sort(), worktree: [ownId] });
    expect(await hostState(app, hostId)).not.toBe('connected');
  } finally {
    await stub.close();
  }
});

test('a daemon without mirror.worktreeChats mirrors only the project\'s own chats, so the offline list stays the plain chats', { tag: SSH_TAG }, async ({ home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(900_000);
  const fixture = await sshd('prod-1');
  await targetRepo(fixture, REPO);
  // this tree's package as an older build whose daemon does not list the feature
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: OLD, withoutFeature: FEATURE });
  const stub = await startTargetStub(home, fixture);
  try {
    const env = { ...remoteEnv(ssh, mirror), DAMOCLES_E2E_APP_VERSION: OLD };
    const first = await launch({ env });
    const hostId = await addHost(first.app, { alias: 'prod-1', name: 'prod-1' });
    const key = await openRemoteFolder(first.app, hostId, REPO);
    await remoteProjectKey(first.app, { authorityKey: `ssh+${hostId}` }, REPO);
    expect(await daemonVersions(fixture)).toEqual([OLD]);
    const { worktreeId, plainId } = await worktreeAndPlainChats(first.app, key);
    expect((await listChats(first.app, key)).chats.map((chat) => chat.id).sort()).toEqual([plainId, worktreeId].sort());
    const projectMirror = projectMirrorFolder(path.join(home.userData, 'remote', hostId, 'mirror'), targetFolderKeyOf(key)!);
    await expect.poll(() => filesUnder(projectMirror).filter((file) => file.endsWith(`_${plainId}.jsonl`)), { timeout: 60_000 }).toHaveLength(1);
    expect(filesUnder(projectMirror).filter((file) => file.startsWith('worktree.'))).toEqual([]);
    await shutdownHostDaemon(first.app, hostId, fixture);
    await first.close();

    const app = await launchOffline(() => launch({ env }), fixture, hostId, key);
    await expect.poll(async () => (await listChats(app, key)).chats.map((chat) => chat.id), { timeout: 60_000 }).toEqual([plainId]);
    expect(await hostState(app, hostId)).not.toBe('connected');
  } finally {
    await stub.close();
  }
});
