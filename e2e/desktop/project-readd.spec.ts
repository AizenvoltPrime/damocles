import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import type { ShellProject } from '../../src/desktop/preload/shell-channels';
import type { DesktopApp } from './support/app';
import { activeChat, expect, test } from './support/fixtures';
import { git, initRepo } from './support/git';
import { seedStubModel, type HermeticHome } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { recordedToasts, recordToasts, shellState } from './support/shell';
import { addProject, answerDialogs, answerOpenDialog, askedDialogs, clickMenu, sendAndAwaitEcho, TRUST_PROMPT } from './support/ui';

// piSessionDir's encoding of a folder (src/core/pi-session/session-store/session-dir.ts).
const sessionDirName = (folder: string): string => `--${folder.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
const OFFER_TITLE = '\'s chats here?';
const REMOTE = 'https://git.example.invalid/acme/widgets.git';

const projectAt = async (app: ElectronApplication, fsPath: string): Promise<ShellProject | undefined> => (await shellState(app)).projects.find((p) => p.fsPath === fsPath);

/** The session files of `folder`'s session dir, by id. */
const chatIdsIn = (home: HermeticHome, folder: string): string[] => {
  const dir = path.join(home.agentDir, 'sessions', sessionDirName(folder));
  return fs.existsSync(dir) ? fs.readdirSync(dir).flatMap((name) => /^[^_.][^_]*_(.+)\.jsonl$/.exec(name)?.[1] ?? []) : [];
};

const trustedFolders = (home: HermeticHome): string[] => {
  const file = path.join(home.userData, 'trusted-folders.json');
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { folders: string[] }).folders : [];
};

/**
 * A trusted project in a repository of REMOTE with one chat, whose identity core recorded; its folder is deleted after the app
 * closes and `beforeDelete` ran.
 */
async function seedMissingProject(home: HermeticHome, launch: () => Promise<DesktopApp>, beforeDelete?: () => Promise<void>): Promise<{ key: string; chatId: string }> {
  await initRepo(home, home.project);
  await git(home, home.project, 'remote', 'add', 'origin', REMOTE);
  const desktop = await launch();
  const { app } = desktop;
  await addProject(app, home.project, true);
  const key = (await projectAt(app, home.project))!.key;
  await sendAndAwaitEcho(await activeChat(app), 'a chat before the folder went away');
  let chatId: string | undefined;
  await expect.poll(async () => (chatId = (await shellState(app)).selected.chatId)?.startsWith('new:') ?? true).toBe(false);
  const identities = path.join(home.damoclesDir, 'folder-identities.json');
  await expect.poll(() => (fs.existsSync(identities) ? fs.readFileSync(identities, 'utf8') : '')).toContain('git.example.invalid/acme/widgets');
  await desktop.close();
  await beforeDelete?.();
  fs.rmSync(home.project, { recursive: true, force: true });
  return { key, chatId: chatId! };
}

/** A clone of the same repository: a new repository whose origin names REMOTE in its scp-like form. */
async function cloneAt(home: HermeticHome, folder: string, remote = 'git@git.example.invalid:acme/widgets.git'): Promise<void> {
  await initRepo(home, folder);
  await git(home, folder, 'remote', 'add', 'origin', remote);
}

test('adding a clone of a missing project\'s repository asks trust first, and Move Chats merges its chats there, selects the moved chat and moves trust', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const seeded = await seedMissingProject(home, launch);
    const clone = path.join(path.dirname(home.project), 'widgets-clone');
    await cloneAt(home, clone);

    const { app } = await launch();
    await recordToasts(app);
    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder', [OFFER_TITLE]: 'Move Chats' });
    await expect.poll(async () => (await projectAt(app, home.project))?.presence).toBe('missing');
    await answerOpenDialog(app, clone);
    await clickMenu(app, 'damocles.addProject');

    await expect.poll(async () => (await shellState(app)).projects.some((p) => p.fsPath === home.project), { timeout: 60_000 }).toBe(false);
    const project = (await projectAt(app, clone))!;
    expect(project.presence).toBeUndefined();
    await expect.poll(() => chatIdsIn(home, clone)).toEqual([seeded.chatId]);
    expect(chatIdsIn(home, home.project)).toEqual([]);
    await expect.poll(async () => (await shellState(app)).selected).toMatchObject({ projectKey: project.key, chatId: seeded.chatId });

    const asked = await askedDialogs(app);
    const offer = asked.find((dialog) => dialog.message.includes(OFFER_TITLE));
    expect(offer?.message).toBe(`Move ${path.basename(home.project)}'s chats here?`);
    expect(offer?.answered).toBe('Move Chats');
    // core reads the folder's root commits only once it is trusted, so the trust question comes before the match
    const trustAsked = asked.findIndex((dialog) => dialog.message.startsWith(TRUST_PROMPT));
    expect(trustAsked).toBeGreaterThanOrEqual(0);
    expect(trustAsked).toBeLessThan(asked.indexOf(offer!));
    await expect.poll(async () => (await recordedToasts(app)).map((toast) => toast.message)).toContain(`Moved 1 chat of ${path.basename(home.project)} to ${clone}.`);
    await expect.poll(() => trustedFolders(home)).toContain(clone);
    expect(trustedFolders(home)).not.toContain(home.project);
    expect((await recordedToasts(app)).filter((toast) => toast.severity === 'error')).toEqual([]);
  } finally {
    await stub.close();
  }
});

test('another repository asks nothing, and Not Now adds the clone normally and keeps the missing project', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const seeded = await seedMissingProject(home, launch);
    const other = path.join(path.dirname(home.project), 'other-repo');
    await cloneAt(home, other, 'https://git.example.invalid/acme/other.git');
    const plain = path.join(path.dirname(home.project), 'plain-folder');
    fs.mkdirSync(plain, { recursive: true });
    const clone = path.join(path.dirname(home.project), 'widgets-clone');
    await cloneAt(home, clone);

    const { app } = await launch();
    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder', [OFFER_TITLE]: 'Not Now' });
    await expect.poll(async () => (await projectAt(app, home.project))?.presence).toBe('missing');
    for (const folder of [other, plain, clone]) {
      await answerOpenDialog(app, folder);
      await clickMenu(app, 'damocles.addProject');
      await expect.poll(async () => {
        const state = await shellState(app);
        const added = state.projects.find((p) => p.fsPath === folder);
        return added !== undefined && state.selected.projectKey === added.key && state.selected.chatId?.startsWith('new:') === true;
      }, { timeout: 30_000 }).toBe(true);
    }

    const offers = (await askedDialogs(app)).filter((dialog) => dialog.message.includes(OFFER_TITLE));
    expect(offers.map((dialog) => dialog.answered)).toEqual(['Not Now']);
    expect((await projectAt(app, home.project))?.presence).toBe('missing');
    expect(chatIdsIn(home, home.project)).toEqual([seeded.chatId]);
    expect(chatIdsIn(home, clone)).toEqual([]);
  } finally {
    await stub.close();
  }
});

// A clone made from the folder itself names only that local path as its origin, so it shares no network remote with the
// missing project, and only its first commit, which core reads once the clone is trusted, names it the same repository.
test('a local clone of a missing project is offered its chats once trusted at Add Project, and not when its trust is declined', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const declined = path.join(path.dirname(home.project), 'widgets-declined');
    const trusted = path.join(path.dirname(home.project), 'widgets-trusted');
    const seeded = await seedMissingProject(home, launch, async () => {
      const root = await git(home, home.project, 'rev-list', '--max-parents=0', 'HEAD');
      expect(fs.readFileSync(path.join(home.damoclesDir, 'folder-identities.json'), 'utf8')).toContain(root);
      for (const clone of [declined, trusted]) await git(home, path.dirname(home.project), 'clone', '--template=', home.project, clone);
    });

    const { app } = await launch();
    await answerDialogs(app, { [TRUST_PROMPT]: 'Don\'t Trust', [OFFER_TITLE]: 'Move Chats' });
    await expect.poll(async () => (await projectAt(app, home.project))?.presence).toBe('missing');
    await answerOpenDialog(app, declined);
    await clickMenu(app, 'damocles.addProject');
    // declined trust still adds the folder, untrusted, and matches by remotes only, which it shares none of
    await expect.poll(async () => {
      const state = await shellState(app);
      const added = state.projects.find((p) => p.fsPath === declined);
      return added !== undefined && state.selected.projectKey === added.key && state.selected.chatId?.startsWith('new:') === true;
    }, { timeout: 30_000 }).toBe(true);
    expect((await askedDialogs(app)).filter((dialog) => dialog.message.includes(OFFER_TITLE))).toEqual([]);
    expect(trustedFolders(home)).not.toContain(declined);

    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder', [OFFER_TITLE]: 'Move Chats' });
    await answerOpenDialog(app, trusted);
    await clickMenu(app, 'damocles.addProject');
    await expect.poll(() => chatIdsIn(home, trusted), { timeout: 60_000 }).toEqual([seeded.chatId]);
    const asked = await askedDialogs(app);
    const offer = asked.find((dialog) => dialog.message.includes(OFFER_TITLE));
    expect(offer?.message).toBe(`Move ${path.basename(home.project)}'s chats here?`);
    const trustAsked = asked.findIndex((dialog) => dialog.message.startsWith(TRUST_PROMPT) && dialog.message.includes(trusted));
    expect(trustAsked).toBeGreaterThanOrEqual(0);
    expect(trustAsked).toBeLessThan(asked.indexOf(offer!));
    expect(asked[trustAsked]?.answered).toBe('Trust Folder');
    await expect.poll(() => trustedFolders(home)).toContain(trusted);
  } finally {
    await stub.close();
  }
});
