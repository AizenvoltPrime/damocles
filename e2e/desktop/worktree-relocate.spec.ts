import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { rootKey } from '../../src/desktop/preload/folder-root';
import type { EditorOpenResult, FileRef, ShellProject } from '../../src/desktop/preload/shell-channels';
import { mainLog, type DesktopApp } from './support/app';
import { editorState, editorTab, openInEditor } from './support/editor';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { graphRow } from './support/forge-history';
import { git } from './support/git';
import type { HermeticHome } from './support/hermetic';
import { agentRequests, type OpenAIStub } from './support/openai-stub';
import { openProjectChat } from './support/screenshots';
import { answerToast, recordedToasts, recordToasts, shellPage, shellState } from './support/shell';
import { cssString, listChats, readyShell } from './support/shell-ui';
import { submenuItem } from './support/scm';
import { addProject, answerDialogs, answerOpenDialog, askedDialogs, clickMenu, TRUST_PROMPT } from './support/ui';
import { chatRow, edit, openRowWorktreeMenu, optIn, send, shownFolder, withStub } from './support/worktree-chat';
import { registryRecords, worktreeRepo, worktreesRoot, type RegistryRecord } from './support/worktree-repo';

// Chat worktrees follow a Locate (docs/invariants.md "Project relocation"): the folders stay where they are, the records
// name the moved project, and `git worktree repair` re-links them once the new folder is trusted.

const CONFIRM_TITLE = '\'s chats to ';
const SKIP_PERMISSIONS = { 'damocles.dangerouslySkipPermissions': true };
// main installs __damoclesE2e only with this set
const E2E_HOOKS = { env: { DAMOCLES_E2E_HOOKS: '1' } };
const INDEX_COMMAND = 'node -e "require(\'fs\').writeFileSync(\'index.txt\',String(process.env.DAMOCLES_WORKTREE_INDEX))"';

async function turn(tab: Page, text: string, done: string): Promise<void> {
  await send(tab, text);
  await expect(tab.getByText(done)).toBeVisible({ timeout: 60_000 });
}

const projectAt = async (app: ElectronApplication, fsPath: string): Promise<ShellProject | undefined> => (await shellState(app)).projects.find((p) => p.fsPath === fsPath);

async function listedAndPresent(app: ElectronApplication, fsPath: string): Promise<boolean> {
  const project = await projectAt(app, fsPath);
  return project !== undefined && project.presence === undefined && project.relocation === undefined;
}

const locateNotice = (shell: Page, key: string) => shell.locator(`[data-testid="project-locate"][data-project-key=${cssString(key)}]`);

async function locate(app: ElectronApplication, key: string, to: string): Promise<void> {
  const shell = await readyShell(app);
  await expect.poll(async () => (await shellState(app)).projects.find((p) => p.key === key)?.presence, { timeout: 30_000 }).toBe('missing');
  await answerOpenDialog(app, to);
  await locateNotice(shell, key).getByTestId('project-locate-button').click();
}

const recordById = (home: HermeticHome, id: string): RegistryRecord | undefined => registryRecords(home).find((record) => record.id === id);

const trustedFolders = (home: HermeticHome): string[] => {
  const file = path.join(home.userData, 'trusted-folders.json');
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { folders: string[] }).folders : [];
};

type Hooks = { __damoclesE2e?: { worktrees: { holdFinish(worktreeId: string): Promise<boolean>; releaseFinish(worktreeId: string): void } } };

/** Takes core's finish hold on the worktree, as Apply does after its last question, once main's e2e hooks are installed. */
async function holdFinish(app: ElectronApplication, worktreeId: string): Promise<boolean> {
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as Hooks).__damoclesE2e !== undefined), { timeout: 30_000 }).toBe(true);
  return app.evaluate((_electron, id) => (globalThis as unknown as Hooks).__damoclesE2e!.worktrees.holdFinish(id), worktreeId);
}

const releaseFinish = (app: ElectronApplication, worktreeId: string): Promise<void> =>
  app.evaluate((_electron, id) => (globalThis as unknown as Hooks).__damoclesE2e!.worktrees.releaseFinish(id), worktreeId);

/** Whether git runs in `folder`: a worktree whose link its repository's move broke fails. */
const gitRuns = (home: HermeticHome, folder: string): Promise<boolean> => git(home, folder, 'status', '--porcelain').then(() => true, () => false);

/** The folders `git worktree list` in `repo` names, resolved. */
async function worktreeList(home: HermeticHome, repo: string): Promise<string[]> {
  const out = await git(home, repo, 'worktree', 'list', '--porcelain');
  return out.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).map((line) => path.resolve(line.slice('worktree '.length)));
}

interface Seeded {
  readonly key: string;
  readonly root: string;
  readonly remote?: string;
  // chat A and the second chat sharing its worktree
  readonly a: RegistryRecord;
  readonly b?: RegistryRecord;
  readonly deleted?: RegistryRecord;
}

/**
 * Adds the repository as a trusted project, then: worktree chat A ("Worktree chat A") and a second chat in A's worktree
 * ("Second chat in A"); with `full`, worktree chat B and worktree chat C, whose worktree is then deleted. Closes the app.
 */
async function seedWorktreeChats(home: HermeticHome, launch: () => Promise<DesktopApp>, options: { readonly full: boolean; readonly remote?: boolean }): Promise<Seeded> {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'), options.remote ? { remoteNewer: 0 } : {});
  const desktop = await launch();
  const { app } = desktop;
  await openProjectChat(app, repo.project);
  const key = (await projectAt(app, repo.project))!.key;
  const shell = await shellPage(app);
  // the Graph's first load repaints the sidebar, which ends the header hover optIn's New menu needs (seen in a trace)
  await expect(graphRow(shell, 'Initial commit')).toBeVisible({ timeout: 30_000 });

  const tabA = await optIn(app);
  await turn(tabA, 'Worktree chat A', 'A ready');
  const a = registryRecords(home).find((record) => record.branch === 'damocles/worktree-chat-a')!;
  expect(a).toBeDefined();
  const row = chatRow(shell, 'Worktree chat A');
  await row.hover();
  await row.getByTestId('chat-action-new-in-worktree').click();
  const shared = await nextChat(app, [tabA]);
  await expect(shared.getByTestId('chat-header-worktree')).toContainText(a.branch!);
  await turn(shared, 'Second chat in A', 'A2 ready');
  if (!options.full) {
    await desktop.close();
    // read after the close, so the records hold what core wrote after the turns (usedAt)
    return { key, root: repo.root, ...(repo.remote !== undefined ? { remote: repo.remote } : {}), a: recordById(home, a.id)! };
  }

  const tabB = await optIn(app);
  await turn(tabB, 'Worktree chat B', 'B ready');
  const b = registryRecords(home).find((record) => record.branch === 'damocles/worktree-chat-b')!;
  const tabC = await optIn(app);
  await turn(tabC, 'Worktree chat C', 'C ready');
  // the turn's checkpoint runs git in the worktree after the reply shows, and Windows refuses to remove a folder git works in
  await expect(tabC.getByTestId('user-message-rewind').first()).toBeVisible();
  const c = registryRecords(home).find((record) => record.branch === 'damocles/worktree-chat-c')!;
  const overlay = await openRowWorktreeMenu(app, chatRow(shell, 'Worktree chat C'));
  await submenuItem(overlay, 'worktree:delete').click();
  await overlay.locator('[data-dialog="delete"] [data-testid="worktree-dialog"]').getByTestId('worktree-dialog-delete').click();
  await expect.poll(() => fs.existsSync(c.worktreeRoot), { timeout: 60_000 }).toBe(false);
  await expect.poll(() => recordById(home, c.id)?.deletedAt).toBeDefined();
  await desktop.close();
  return { key, root: repo.root, a: recordById(home, a.id)!, b: recordById(home, b.id)!, deleted: recordById(home, c.id)! };
}

/** The record names the moved project and keeps its worktree where it was, named for the old path, with its branch and index. */
function expectFollowed(home: HermeticHome, before: RegistryRecord, moved: string): RegistryRecord {
  const after = recordById(home, before.id)!;
  expect(after).toEqual({ ...before, projectPath: moved, repositoryRoot: moved, namedFor: before.projectPath });
  expect(path.dirname(path.dirname(after.worktreeRoot))).toBe(worktreesRoot(home));
  return after;
}

/** The moved repository and its worktrees, which stay in place, are linked both ways: git runs in each and `worktree list` names them. */
async function expectRelinked(home: HermeticHome, repo: string, roots: readonly string[]): Promise<void> {
  for (const root of roots) await expect.poll(() => gitRuns(home, root), { timeout: 60_000 }).toBe(true);
  expect((await worktreeList(home, repo)).sort()).toEqual([repo, ...roots].map((p) => path.resolve(p)).sort());
}

test('after Locate and trust, worktree chats live, shared and deleted follow the moved repository: they resume in their worktrees, git and Apply work, the index stays, and isolation guards the new project folder', async ({ foreground: _foreground, home, launch }) => {
  test.setTimeout(480_000);
  await withStub(home, SKIP_PERMISSIONS, async (stub: OpenAIStub) => {
    stub.replies.push({ chunks: ['A ready'] }, { chunks: ['A2 ready'] }, { chunks: ['B ready'] }, { chunks: ['C ready'] });
    const seeded = await seedWorktreeChats(home, launch, { full: true });
    const moved = `${seeded.root}-moved`;
    fs.renameSync(seeded.root, moved);

    const { app } = await launch();
    await recordToasts(app);
    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder', [CONFIRM_TITLE]: 'Move Chats' });
    await locate(app, seeded.key, moved);
    await expect.poll(() => listedAndPresent(app, moved), { timeout: 120_000 }).toBe(true);

    const a = expectFollowed(home, seeded.a, moved);
    const b = expectFollowed(home, seeded.b!, moved);
    const c = expectFollowed(home, seeded.deleted!, moved);
    expect(fs.existsSync(c.worktreeRoot)).toBe(false);
    for (const record of [a, b]) expect(fs.readFileSync(path.join(record.workingFolder, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    await expectRelinked(home, moved, [a.worktreeRoot, b.worktreeRoot]);

    const shell = await readyShell(app);
    await test.step('chat A resumes in its worktree and DAMOCLES_WORKTREE_INDEX is the index it had', async () => {
      await chatRow(shell, 'Worktree chat A').click();
      const tab = await activeChat(app);
      await expect(tab.getByText('A ready')).toBeVisible();
      await expect(tab.getByTestId('chat-header-worktree')).toContainText(a.branch!);
      await expect.poll(async () => (await shownFolder(app))?.root.worktreeId).toBe(a.id);
      stub.replies.push({ chunks: [], toolCalls: [{ name: 'bash', arguments: { command: INDEX_COMMAND } }] }, { chunks: ['Index written'] });
      await turn(tab, 'Write the worktree index', 'Index written');
      expect(fs.readFileSync(path.join(a.workingFolder, 'index.txt'), 'utf8')).toBe(String(seeded.a.index));
    });

    await test.step('an Edit lands in the worktree and Apply copies it into the moved project folder', async () => {
      const tab = await activeChat(app);
      stub.replies.push(edit(path.join(a.workingFolder, 'a.ts'), 'a = 1', 'a = 2'), { chunks: ['Raised a'] });
      await turn(tab, 'Raise a in the worktree', 'Raised a');
      expect(fs.readFileSync(path.join(a.workingFolder, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
      await clickMenu(app, 'damocles.worktree.apply');
      await expect.poll(() => fs.readFileSync(path.join(moved, 'a.ts'), 'utf8'), { timeout: 60_000 }).toBe('export const a = 2;\n');
      expect(await git(home, moved, 'status', '--porcelain')).toContain('a.ts');
    });

    await test.step('isolation still blocks an Edit into the new project folder', async () => {
      const tab = await activeChat(app);
      const before = agentRequests(stub).length;
      stub.replies.push(edit(path.join(moved, 'a.ts'), 'a = 2', 'a = 9'), { chunks: ['Isolation checked'] });
      await turn(tab, 'Edit the project folder', 'Isolation checked');
      expect(fs.readFileSync(path.join(moved, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
      expect(JSON.stringify(agentRequests(stub).slice(before).map((request) => request.body))).toContain('blocked automatically');
    });

    await test.step('the chat sharing A\'s worktree resumes there, and the deleted worktree\'s chat stays read-only', async () => {
      await chatRow(shell, 'Second chat in A').click();
      const shared = await activeChat(app);
      await expect(shared.getByText('A2 ready')).toBeVisible();
      await expect(shared.getByTestId('chat-header-worktree')).toContainText(a.branch!);
      await expect(chatRow(shell, 'Worktree chat B')).toHaveAttribute('data-worktree', 'live');
      await expect(chatRow(shell, 'Worktree chat C').getByTestId('chat-worktree-line')).toHaveText('Worktree deleted');
    });
    expect((await recordedToasts(app)).filter((toast) => toast.severity === 'error')).toEqual([]);
  });
});

test('declining trust at Locate moves the worktree chats unlinked, a toast offers Trust, and granting it re-links them without a restart', async ({ foreground: _foreground, home, launch }) => {
  test.setTimeout(420_000);
  await withStub(home, SKIP_PERMISSIONS, async (stub: OpenAIStub) => {
    stub.replies.push({ chunks: ['A ready'] }, { chunks: ['A2 ready'] });
    const seeded = await seedWorktreeChats(home, launch, { full: false });
    const moved = `${seeded.root}-moved`;
    fs.renameSync(seeded.root, moved);

    const { app } = await launch();
    await recordToasts(app);
    await answerDialogs(app, { [TRUST_PROMPT]: 'Don\'t Trust', [CONFIRM_TITLE]: 'Move Chats' });
    await locate(app, seeded.key, moved);
    await expect.poll(() => listedAndPresent(app, moved), { timeout: 120_000 }).toBe(true);
    const a = expectFollowed(home, seeded.a, moved);
    expect(fs.readFileSync(path.join(a.workingFolder, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(trustedFolders(home)).not.toContain(moved);

    // named as before the move, as the Moved toast names it
    const message = `Trust ${path.basename(seeded.root)} to re-link its chat worktree.`;
    await expect.poll(async () => (await recordedToasts(app)).map((toast) => toast.message), { timeout: 60_000 }).toContain(message);
    const toast = (await recordedToasts(app)).find((each) => each.message === message)!;
    expect(toast).toMatchObject({ severity: 'warning', actions: ['Trust'] });
    // git never ran in the untrusted folder, so the worktree is still unlinked
    expect(await gitRuns(home, a.worktreeRoot)).toBe(false);

    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder' });
    await answerToast(app, toast.id, 'Trust');
    await expect.poll(() => trustedFolders(home), { timeout: 30_000 }).toContain(moved);
    await expectRelinked(home, moved, [a.worktreeRoot]);

    const shell = await readyShell(app);
    await chatRow(shell, 'Worktree chat A').click();
    const tab = await activeChat(app);
    await expect(tab.getByText('A ready')).toBeVisible();
    await expect(tab.getByTestId('chat-header-worktree')).toContainText(a.branch!);
  });
});

test('Locate onto a fresh clone names the worktrees it cannot re-link, lists them with Retry, and Delete removes them', async ({ foreground: _foreground, home, launch }) => {
  test.setTimeout(420_000);
  await withStub(home, SKIP_PERMISSIONS, async (stub: OpenAIStub) => {
    stub.replies.push({ chunks: ['A ready'] }, { chunks: ['A2 ready'] });
    const seeded = await seedWorktreeChats(home, launch, { full: false, remote: true });
    // the old repository goes away and a clone of its remote, which has no admin dirs for the worktrees, takes its place
    fs.mkdirSync(path.join(home.root, 'attic'), { recursive: true });
    fs.renameSync(seeded.root, path.join(home.root, 'attic', 'acme'));
    const clone = `${seeded.root}-clone`;
    await git(home, home.root, 'clone', seeded.remote!, clone);

    const { app } = await launch();
    await recordToasts(app);
    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder', [CONFIRM_TITLE]: 'Move Chats' });
    await locate(app, seeded.key, clone);
    await expect.poll(() => listedAndPresent(app, clone), { timeout: 120_000 }).toBe(true);
    const confirm = (await askedDialogs(app)).find((dialog) => dialog.message.includes(CONFIRM_TITLE));
    expect(`${confirm?.message} ${confirm?.detail ?? ''}`).toContain(`can't be linked to it: ${seeded.a.branch!}`);
    const a = expectFollowed(home, seeded.a, clone);

    const failed = `A chat worktree of ${path.basename(seeded.root)} could not be re-linked to its repository. Chat worktrees: ${a.branch!}.`;
    const notices = async () => (await recordedToasts(app)).filter((toast) => toast.message === failed);
    await expect.poll(async () => (await recordedToasts(app)).map((toast) => toast.message), { timeout: 60_000 }).toContain(failed);
    const [first] = await notices();
    expect(first).toMatchObject({ severity: 'warning', actions: ['Retry'] });
    expect(await gitRuns(home, a.worktreeRoot)).toBe(false);
    // Retry runs the repair again, which fails the same way and says so again
    await answerToast(app, first!.id, 'Retry');
    await expect.poll(async () => (await notices()).length, { timeout: 60_000 }).toBe(2);

    const shell = await readyShell(app);
    const overlay = await openRowWorktreeMenu(app, chatRow(shell, 'Worktree chat A'));
    await submenuItem(overlay, 'worktree:delete').click();
    const question = overlay.getByTestId('overlay-message');
    await expect(question).toContainText(`The folder of the worktree "${a.worktreeRoot}" is no longer a git worktree. Delete it and everything in it?`);
    await question.getByTestId('overlay-message-action-0').click();
    await expect.poll(() => fs.existsSync(a.worktreeRoot), { timeout: 60_000 }).toBe(false);
    await expect.poll(() => recordById(home, a.id)?.deletedAt).toBeDefined();
    await expect(chatRow(shell, 'Worktree chat A').getByTestId('chat-worktree-line')).toHaveText('Worktree deleted', { timeout: 30_000 });
    expect((await recordedToasts(app)).filter((toast) => toast.severity === 'error')).toEqual([]);
  });
});

/** Adds chat A's worktree as a project of its own, with a chat of its own ("Own chat of the worktree"); closes the app. */
async function openWorktreeAsProject(launch: () => Promise<DesktopApp>, seeded: Seeded, chat: boolean): Promise<string> {
  const desktop = await launch();
  const known = [await activeChat(desktop.app)];
  await addProject(desktop.app, seeded.a.workingFolder, true);
  const key = (await shellState(desktop.app)).selected.projectKey!;
  if (chat) await turn(await nextChat(desktop.app, known), 'Own chat of the worktree', 'W ready');
  await desktop.close();
  return key;
}

test('a chat worktree open as a project whose folder was moved is never offered Locate, and a Locate of it is refused, naming its project, changing nothing', async ({ foreground: _foreground, home, launch }) => {
  test.setTimeout(360_000);
  await withStub(home, SKIP_PERMISSIONS, async (stub: OpenAIStub) => {
    stub.replies.push({ chunks: ['A ready'] }, { chunks: ['A2 ready'] });
    const seeded = await seedWorktreeChats(home, launch, { full: false });
    const worktreeKey = await openWorktreeAsProject(launch, seeded, false);
    const elsewhere = path.join(home.root, 'elsewhere', seeded.a.id);
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
    fs.renameSync(seeded.a.worktreeRoot, elsewhere);

    const { app } = await launch();
    const shell = await readyShell(app);
    await expect.poll(async () => (await shellState(app)).projects.find((p) => p.key === worktreeKey)?.presence, { timeout: 30_000 }).toBe('missing');
    const notice = locateNotice(shell, worktreeKey);
    await expect(notice).toHaveAttribute('data-state', 'notLocatable');
    const reason = notice.getByTestId('project-locate-reason');
    await expect(reason).toHaveAttribute('data-code', 'chatWorktree');
    await expect(reason).toHaveText(`${seeded.a.workingFolder} is a chat worktree of ${seeded.a.projectPath!}, which Damocles keeps in place, so it can't be located. Move the folder back if you moved it, or remove this project.`);
    await expect(notice.getByTestId('project-locate-button')).toHaveCount(0);

    // Locate asked for anyway runs to core's preflight, which refuses it: nothing is journaled, moved or asked
    await app.evaluate(({ dialog }, picked) => {
      const g = globalThis as unknown as { __e2ePicks?: number };
      dialog.showOpenDialog = (() => {
        g.__e2ePicks = (g.__e2ePicks ?? 0) + 1;
        return Promise.resolve({ canceled: false, filePaths: [picked] });
      }) as typeof dialog.showOpenDialog;
    }, elsewhere);
    await shell.evaluate((key) => window.damoclesShell!.locateProject(key), worktreeKey);
    expect(await app.evaluate(() => (globalThis as unknown as { __e2ePicks?: number }).__e2ePicks)).toBe(1);
    // the row shows notLocatable over the refusal, so main's log says what preflight answered
    await expect.poll(() => mainLog(home)).toContain(`[projects] Locate of ${worktreeKey}: refused (chatWorktree)`);
    await expect(notice).toHaveAttribute('data-state', 'notLocatable');
    expect(fs.existsSync(path.join(home.damoclesDir, 'project-relocations.json'))).toBe(false);
    expect(recordById(home, seeded.a.id)).toMatchObject({ projectPath: seeded.a.projectPath, worktreeRoot: seeded.a.worktreeRoot, workingFolder: seeded.a.workingFolder });
    expect((await askedDialogs(app)).filter((dialog) => dialog.message.includes(CONFIRM_TITLE))).toEqual([]);
    expect((await projectAt(app, seeded.a.workingFolder))?.key).toBe(worktreeKey);
    expect(await projectAt(app, elsewhere)).toBeUndefined();
    expect(fs.readFileSync(path.join(elsewhere, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    const projectKey = (await projectAt(app, seeded.a.projectPath!))!.key;
    expect((await listChats(app, projectKey)).chats.map((chat) => chat.title).sort()).toEqual(['Second chat in A', 'Worktree chat A']);
  });
});

test('Locate while a chat worktree is open as a project leaves the worktree, its row and its open chat where they are, and the project\'s chats in it resume there', async ({ foreground: _foreground, home, launch }) => {
  test.setTimeout(480_000);
  await withStub(home, SKIP_PERMISSIONS, async (stub: OpenAIStub) => {
    stub.replies.push({ chunks: ['A ready'] }, { chunks: ['A2 ready'] }, { chunks: ['W ready'] });
    const seeded = await seedWorktreeChats(home, launch, { full: false });
    const worktreeKey = await openWorktreeAsProject(launch, seeded, true);
    const moved = `${seeded.root}-moved`;
    fs.renameSync(seeded.root, moved);

    // the relaunch reopens the worktree's own chat, which stays open through the move
    const { app } = await launch();
    await recordToasts(app);
    const own = await activeChat(app);
    await expect(own.getByText('W ready')).toBeVisible();
    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder', [CONFIRM_TITLE]: 'Move Chats' });
    await locate(app, seeded.key, moved);
    await expect.poll(() => listedAndPresent(app, moved), { timeout: 120_000 }).toBe(true);
    const a = expectFollowed(home, seeded.a, moved);
    expect(await listedAndPresent(app, seeded.a.workingFolder)).toBe(true);
    expect((await projectAt(app, seeded.a.workingFolder))?.key).toBe(worktreeKey);
    const confirm = (await askedDialogs(app)).find((dialog) => dialog.message.includes(CONFIRM_TITLE));
    expect(`${confirm?.message} ${confirm?.detail ?? ''}`).toContain('Its chat worktree stays where it is and follows it.');
    await expectRelinked(home, moved, [a.worktreeRoot]);

    const shell = await readyShell(app);
    await test.step('the worktree\'s own chat stayed open, lists under its row alone and is no chat of the worktree', async () => {
      await expect(own.getByText('W ready')).toBeVisible();
      await expect(own.getByTestId('chat-header-worktree')).toHaveCount(0);
      await expect.poll(async () => (await listChats(app, worktreeKey)).chats.map((chat) => chat.title)).toEqual(['Own chat of the worktree']);
    });
    await test.step('the project\'s chats in the worktree list under the moved project and resume in the worktree', async () => {
      const projectKey = (await projectAt(app, moved))!.key;
      await shell.evaluate((key) => window.damoclesShell!.selectProject(key), projectKey);
      for (const [title, reply] of [['Worktree chat A', 'A ready'], ['Second chat in A', 'A2 ready']] as const) {
        await chatRow(shell, title).click();
        const tab = await activeChat(app);
        await expect(tab.getByText(reply)).toBeVisible();
        await expect(tab.getByTestId('chat-header-worktree')).toContainText(a.branch!);
        await expect.poll(async () => (await shownFolder(app))?.root.worktreeId).toBe(a.id);
      }
    });
    expect((await recordedToasts(app)).filter((toast) => toast.severity === 'error')).toEqual([]);
  });
});

test('a chat worktree\'s file tab stays open through Locate, the same tab under the moved project\'s worktree root, which the saved layout names', async ({ foreground: _foreground, home, launch }) => {
  test.setTimeout(420_000);
  await withStub(home, SKIP_PERMISSIONS, async (stub: OpenAIStub) => {
    stub.replies.push({ chunks: ['A ready'] }, { chunks: ['A2 ready'] });
    const seeded = await seedWorktreeChats(home, launch, { full: false });
    const moved = `${seeded.root}-moved`;
    fs.renameSync(seeded.root, moved);
    const savedTabs = (): FileRef[] => {
      const layout = JSON.parse(fs.readFileSync(path.join(home.userData, 'window-layout.json'), 'utf8')) as { editor: { tabs: Array<{ file?: FileRef }> } };
      return layout.editor.tabs.flatMap((tab) => (tab.file ? [tab.file] : []));
    };

    const desktop = await launch();
    const oldRoot = rootKey({ projectKey: seeded.key, worktreeId: seeded.a.id });
    // the root resolves once core published its worktree records
    let tabId: string | undefined;
    await expect.poll(async () => {
      const opened: EditorOpenResult = await openInEditor(desktop.app, { projectKey: oldRoot, relativePath: 'a.ts' });
      tabId = opened.ok ? opened.tabId : undefined;
      return opened.ok;
    }, { timeout: 30_000 }).toBe(true);
    await expect.poll(savedTabs).toContainEqual({ projectKey: oldRoot, relativePath: 'a.ts' });
    await answerDialogs(desktop.app, { [TRUST_PROMPT]: 'Trust Folder', [CONFIRM_TITLE]: 'Move Chats' });
    await locate(desktop.app, seeded.key, moved);
    await expect.poll(() => listedAndPresent(desktop.app, moved), { timeout: 120_000 }).toBe(true);
    const newRoot = rootKey({ projectKey: (await projectAt(desktop.app, moved))!.key, worktreeId: seeded.a.id });
    await expect.poll(async () => (await editorState(desktop.app)).tabs.map((tab) => [tab.id, tab.projectKey, tab.relativePath]), { timeout: 30_000 }).toEqual([[tabId, newRoot, 'a.ts']]);
    await expect(editorTab(await readyShell(desktop.app), 'a.ts')).toBeVisible();
    await expect.poll(savedTabs, { timeout: 30_000 }).toContainEqual({ projectKey: newRoot, relativePath: 'a.ts' });
    await desktop.close();
    // what the next launch reads
    expect(savedTabs().filter((file) => file.projectKey === oldRoot || file.projectKey === newRoot)).toEqual([{ projectKey: newRoot, relativePath: 'a.ts' }]);
  });
});

test('a finish action holding a worktree of the project refuses Locate, and Locate goes through once it ends', async ({ foreground: _foreground, home, launch }) => {
  test.setTimeout(360_000);
  await withStub(home, SKIP_PERMISSIONS, async (stub: OpenAIStub) => {
    stub.replies.push({ chunks: ['A ready'] }, { chunks: ['A2 ready'] });
    const seeded = await seedWorktreeChats(home, launch, { full: false });
    const moved = `${seeded.root}-moved`;
    fs.renameSync(seeded.root, moved);

    const { app } = await launch(E2E_HOOKS);
    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder', [CONFIRM_TITLE]: 'Move Chats' });
    expect(await holdFinish(app, seeded.a.id)).toBe(true);
    await locate(app, seeded.key, moved);
    const shell = await readyShell(app);
    await expect(locateNotice(shell, seeded.key)).toHaveAttribute('data-state', 'refused', { timeout: 60_000 });
    await expect(locateNotice(shell, seeded.key).getByTestId('project-locate-reason')).toHaveAttribute('data-code', 'worktreeFinishing');
    expect(recordById(home, seeded.a.id)).toEqual(seeded.a);
    expect(fs.existsSync(path.join(home.damoclesDir, 'project-relocations.json'))).toBe(false);
    expect((await askedDialogs(app)).filter((dialog) => dialog.message.includes(CONFIRM_TITLE))).toEqual([]);

    await releaseFinish(app, seeded.a.id);
    await locate(app, seeded.key, moved);
    await expect.poll(() => listedAndPresent(app, moved), { timeout: 120_000 }).toBe(true);
    const a = expectFollowed(home, seeded.a, moved);
    await expectRelinked(home, moved, [a.worktreeRoot]);
  });
});
