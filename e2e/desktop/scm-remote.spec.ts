import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { logFiles, mainLog } from './support/app';
import { expect, test } from './support/fixtures';
import { git, initRepo, type GitHome } from './support/git';
import { startGitHttpServer, type GitHttpServer } from './support/git-http-server';
import { writeUserSettings, type HermeticHome } from './support/hermetic';
import { menuItem, overlayMenu, readyOverlay } from './support/overlay';
import { answerInput, autofetchNow, bareRepo, commitMessage, gitLog, moreActions, openScmProject, pickItem, quickInput, quickInputField, scmSection } from './support/scm';
import { applyUserSettings } from './support/settings';
import { overlayPage, pressKeys, PRIMARY, recordedToasts, recordToasts, shellState } from './support/shell';
import { clickSectionAction, projectRow } from './support/shell-ui';
import { quickPick } from './support/editor';
import { addProject, answerDialogs, answerOpenDialog, askedDialogs, clickMenu, TRUST_PROMPT } from './support/ui';

// Remotes, sync, clone, askpass and autofetch (slice 11) against bare repositories under the hermetic home and a git
// http-backend on 127.0.0.1 with basic auth, never the network. Core's integration tests cover each operation's argv.
const HOOKS = { DAMOCLES_E2E_HOOKS: '1' };
const USER = 'ada';
// A sentinel no log may hold.
const PASSWORD = 'sentinel-e2e-password-5521';

const syncButton = (shell: Page): Locator => scmSection(shell).getByTestId('scm-sync');
const progress = (shell: Page): Locator => scmSection(shell).getByTestId('scm-progress');

const CONFIRM_SYNC = 'This action will pull and push commits from and to';
const ADD_CLONE = 'Would you like to open the cloned repository?';

/** A clone of `bare` at `dir` with an identity, its origin then pointed at `url` when given. */
async function cloneTo(h: GitHome, bare: string, dir: string, url?: string): Promise<void> {
  await git(h, path.dirname(dir), 'clone', '--quiet', bare, dir);
  await git(h, dir, 'config', 'user.name', 'Scm Tester');
  await git(h, dir, 'config', 'user.email', 'scm@example.com');
  if (url !== undefined) await git(h, dir, 'remote', 'set-url', 'origin', url);
}

/** A commit someone else pushed to `bare`'s main. */
async function commitUpstream(h: GitHome, bare: string, file: string, text: string): Promise<void> {
  const other = fs.mkdtempSync(path.join(h.root, 'other-'));
  await cloneTo(h, bare, path.join(other, 'w'));
  fs.writeFileSync(path.join(other, 'w', file), text);
  await git(h, path.join(other, 'w'), 'add', '-A');
  await git(h, path.join(other, 'w'), 'commit', '-m', `upstream ${file}`);
  await git(h, path.join(other, 'w'), 'push', '--quiet', 'origin', 'HEAD:main');
}

async function commitLocal(h: GitHome, dir: string, file: string, text: string, message: string): Promise<void> {
  fs.writeFileSync(path.join(dir, file), text);
  await git(h, dir, 'add', '-A');
  await git(h, dir, 'commit', '-m', message);
}

/** Every log file the app wrote under userData, once it has quit. */
function allLogs(home: HermeticHome): string {
  return logFiles(home).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

let server: GitHttpServer | undefined;
let open: GitHttpServer | undefined;
test.afterEach(async () => {
  await server?.close();
  await open?.close();
  server = undefined;
  open = undefined;
});

test('Push over basic auth asks for the username and then a masked password; the push lands, Push (Follow Tags) takes the annotated tag, and no log holds the answers', async ({ foreground: _foreground, home, launch }) => {
  const root = path.join(home.root, 'served');
  const bare = await bareRepo(home, root, 'auth');
  server = await startGitHttpServer({ root, user: USER, password: PASSWORD });
  await cloneTo(home, bare, home.project, server.url('auth.git'));
  const desktop = await launch({ env: HOOKS });
  const { app } = desktop;
  const shell = await openScmProject(app, home.project);
  await commitLocal(home, home.project, 'b.ts', 'export const b = 1;\n', 'Over http');
  await git(home, home.project, 'tag', '-a', 'v1', '-m', 'Release one');

  await moreActions(app, shell, 'push');
  expect(await answerInput(app, USER)).not.toBe('password');
  expect(await answerInput(app, PASSWORD)).toBe('password');
  await expect.poll(() => git(home, bare, 'log', '-1', '--format=%s', 'main')).toBe('Over http');
  expect(await git(home, bare, 'tag')).toBe('');

  await clickMenu(app, 'damocles.git.pushWithTags');
  await answerInput(app, USER);
  await answerInput(app, PASSWORD);
  await expect.poll(() => git(home, bare, 'tag')).toBe('v1');
  expect(await git(home, bare, 'cat-file', '-t', 'v1')).toBe('tag');
  await expect.poll(() => gitLog(app)).toMatch(/> git push --follow-tags/);

  await desktop.close();
  const logs = allLogs(home);
  expect(logs).not.toContain(PASSWORD);
  expect(logs).not.toContain(`${USER}:${PASSWORD}`);
  expect(logs).not.toContain('DAMOCLES_ASKPASS_NONCE');
});

test('autofetch fetches only the selected project and moves with the selection, updates N↓, logs a repeated failure once, and after a refused credential neither prompts nor fetches there until it starts over', async ({ home, launch }) => {
  const root = path.join(home.root, 'served');
  const bareA = await bareRepo(home, root, 'alpha');
  const bareB = await bareRepo(home, root, 'beta');
  open = await startGitHttpServer({ root });
  server = await startGitHttpServer({ root, user: USER, password: PASSWORD });
  const alpha = path.join(home.root, 'alpha');
  const beta = path.join(home.root, 'beta');
  await cloneTo(home, bareA, alpha, open.url('alpha.git'));
  await cloneTo(home, bareB, beta, open.url('beta.git'));
  const { app } = await launch({ env: HOOKS });
  await openScmProject(app, alpha);
  const shell = await openScmProject(app, beta);
  const before = { alpha: await git(home, alpha, 'rev-parse', 'origin/main'), beta: await git(home, beta, 'rev-parse', 'origin/main') };
  await commitUpstream(home, bareA, 'up.ts', 'export const up = 1;\n');
  await commitUpstream(home, bareB, 'up.ts', 'export const up = 1;\n');

  // beta is selected: its round fetches beta and leaves alpha alone
  await autofetchNow(app);
  await expect.poll(() => git(home, beta, 'rev-parse', 'origin/main')).not.toBe(before.beta);
  await expect(scmSection(shell).getByTestId('scm-sync-behind')).toHaveText('1');
  expect(await git(home, alpha, 'rev-parse', 'origin/main')).toBe(before.alpha);
  await expect(progress(shell)).toHaveCount(0);

  // selecting alpha moves autofetch there, at once; the count follows the fetch's status, so its Git log line is written
  const alphaKey = (await shellState(app)).projects.find((project) => project.fsPath === alpha)!.key;
  await projectRow(shell, alphaKey).click();
  await expect.poll(() => git(home, alpha, 'rev-parse', 'origin/main')).not.toBe(before.alpha);
  await expect(scmSection(shell).getByTestId('scm-sync-behind')).toHaveText('1');

  // a fetch's Git log line is written once git exits, before autofetch logs its failure
  const fetches = async (): Promise<number> => (await gitLog(app)).split('\n').filter((line) => line.startsWith('> git fetch')).length;
  const failures = (): string[] => mainLog(home).split('\n').filter((line) => line.includes('[scm] autofetch failed'));
  expect(failures()).toEqual([]);

  // a failure other than a credential's is logged once, however many rounds repeat it
  await git(home, alpha, 'remote', 'set-url', 'origin', open.url('gone.git'));
  const settled = await fetches();
  for (let round = 1; round <= 3; round++) {
    await autofetchNow(app);
    await expect.poll(fetches).toBe(settled + round);
  }
  expect(failures()).toEqual([expect.stringContaining("gone.git/' not found")]);

  // without stored credentials a background fetch is answered cancel: no prompt, a new failure logged, and no fetch there again
  await git(home, alpha, 'remote', 'set-url', 'origin', server.url('alpha.git'));
  await autofetchNow(app);
  await expect.poll(() => failures().length).toBe(2);
  expect(await fetches()).toBe(settled + 4);
  await expect.poll(() => gitLog(app)).toContain('autofetch runs in the background, so its credential request was answered with a cancel');
  expect(server.requests.refused).toBeGreaterThan(0);
  await expect(quickInput(await overlayPage(app))).toHaveCount(0);
  await autofetchNow(app);
  await autofetchNow(app);
  // a setting change starts autofetch over, which forgets the refusal, so the next fetch and failure there are that round's
  writeUserSettings(home, { 'damocles.desktop.git.autofetchPeriod': 3600 });
  await expect.poll(() => failures().length).toBe(3);
  expect(await fetches()).toBe(settled + 5);
});

test('Add Remote and Remove Remote, Pull (Rebase), Fetch (Prune) and pruneOnFetch, and autoStash off and on work against bare repositories', async ({ foreground: _foreground, home, launch }) => {
  // a space in every remote's path, which Add Remote takes as a local path
  const root = path.join(home.root, 'bare remotes');
  const origin = await bareRepo(home, root, 'origin');
  const extra = await bareRepo(home, root, 'extra');
  await cloneTo(home, origin, home.project);
  const { app } = await launch({ env: HOOKS });
  const shell = await openScmProject(app, home.project);
  await recordToasts(app);

  // Remote › Add Remote...: a URL, then a name the box validates, then a fetch of the new remote
  await moreActions(app, shell, 'addRemote', 'remote');
  const overlay = await overlayPage(app);
  await expect(quickInput(overlay)).toBeVisible();
  await quickInputField(overlay).fill(extra);
  await overlay.keyboard.press('Enter');
  // the name box follows the URL box at once, in the same QuickInput
  await expect(quickInputField(overlay)).toHaveAttribute('placeholder', 'Remote name');
  await expect(quickInputField(overlay)).toHaveValue('');
  await quickInputField(overlay).fill('-x');
  await expect(quickInputField(overlay)).toHaveAttribute('aria-invalid', 'true');
  await overlay.keyboard.press('Enter');
  await expect(quickInput(overlay)).toBeVisible();
  await quickInputField(overlay).fill('extra');
  await overlay.keyboard.press('Enter');
  await expect.poll(() => git(home, home.project, 'remote')).toBe('extra\norigin');
  await expect.poll(() => git(home, home.project, 'branch', '-r')).toContain('extra/main');

  // Remote › Remove Remote picks one
  await moreActions(app, shell, 'removeRemote', 'remote');
  await expect(quickPick(overlay)).toBeVisible();
  await pickItem(overlay, 'extra').click();
  await expect.poll(() => git(home, home.project, 'remote')).toBe('origin');

  // Pull (Rebase): the local commit lands on top of the upstream one, with no merge
  await commitUpstream(home, origin, 'up.ts', 'export const up = 1;\n');
  await commitLocal(home, home.project, 'mine.ts', 'export const mine = 1;\n', 'Mine');
  await moreActions(app, shell, 'pullPush:pullRebase', 'pullPush');
  await expect.poll(() => git(home, home.project, 'log', '--format=%s', '-2')).toBe('Mine\nupstream up.ts');
  expect(await git(home, home.project, 'rev-list', '--merges', '--count', 'HEAD')).toBe('0');

  // Fetch (Prune) drops a remote-tracking branch whose branch is gone; with pruneOnFetch every Fetch passes --prune
  await git(home, home.project, 'update-ref', 'refs/remotes/origin/gone', 'HEAD');
  await moreActions(app, shell, 'pullPush:fetchPrune', 'pullPush');
  await expect.poll(() => git(home, home.project, 'branch', '-r')).not.toContain('origin/gone');
  await applyUserSettings(app, home, { 'damocles.desktop.git.pruneOnFetch': true });
  await git(home, home.project, 'update-ref', 'refs/remotes/origin/gone', 'HEAD');
  await moreActions(app, shell, 'fetch');
  await expect.poll(() => git(home, home.project, 'branch', '-r')).not.toContain('origin/gone');
  // the Git log line is written once git exits, after the ref it deleted is gone
  await expect.poll(async () => (await gitLog(app)).split('\n').filter((line) => line.startsWith('> git fetch --prune')).length).toBeGreaterThanOrEqual(2);

  // autoStash off: git refuses to pull over a local change and the notice offers Show Git Output; on: stash, pull, restore
  await git(home, home.project, 'push', '--quiet', 'origin', 'HEAD:main');
  await commitUpstream(home, origin, 'a.ts', 'export const a = 2;\n');
  fs.writeFileSync(path.join(home.project, 'a.ts'), 'export const a = 3;\n');
  await moreActions(app, shell, 'pull');
  await expect.poll(async () => (await recordedToasts(app)).find((toast) => /local changes/.test(toast.message))?.actions).toEqual(['Show Git Output']);
  await applyUserSettings(app, home, { 'damocles.desktop.git.autoStash': true });
  fs.writeFileSync(path.join(home.project, 'b.ts'), 'export const b = 1;\n');
  await git(home, home.project, 'add', 'b.ts');
  fs.writeFileSync(path.join(home.project, 'mine.ts'), 'export const mine = 2;\n');
  await commitUpstream(home, origin, 'z.ts', 'export const z = 1;\n');
  await git(home, home.project, 'checkout', '--', 'a.ts');
  await moreActions(app, shell, 'pull');
  // git restores the autostash after the merge, so the tree is read once the pull exited and its log line is written
  await expect.poll(() => gitLog(app)).toMatch(/> git pull --autostash/);
  expect(fs.existsSync(path.join(home.project, 'z.ts'))).toBe(true);
  expect(fs.readFileSync(path.join(home.project, 'mine.ts'), 'utf8')).toBe('export const mine = 2;\n');
});

test('Clone works while the selected project is untrusted: a URL, a folder, then the question to add it, which asks for trust; at always it adds the clone unasked; Clone (Recursive) checks out a submodule over the same backend', async ({ home, launch }) => {
  const root = path.join(home.root, 'served');
  await bareRepo(home, root, 'acme-api');
  open = await startGitHttpServer({ root });
  await bareRepo(home, root, 'child', { 'child.ts': 'export const child = 1;\n' });
  const parentSeed = path.join(home.root, 'seed-parent');
  await initRepo(home, parentSeed);
  await git(home, parentSeed, 'submodule', 'add', '--quiet', open.url('child.git'), 'child');
  await git(home, parentSeed, 'commit', '-m', 'Add child');
  await git(home, root, 'clone', '--quiet', '--bare', parentSeed, path.join(root, 'parent.git'));
  await initRepo(home, home.project);
  const clones = path.join(home.root, 'clones');
  fs.mkdirSync(clones);

  const { app } = await launch({ env: HOOKS });
  await addProject(app, home.project, false);
  expect((await shellState(app)).projects.find((project) => project.fsPath === home.project)?.trusted).toBe(false);

  await answerOpenDialog(app, clones);
  await answerDialogs(app, { [ADD_CLONE]: 'Add Project', [TRUST_PROMPT]: "Don't Trust" });
  await clickMenu(app, 'damocles.git.clone');
  await answerInput(app, open.url('acme-api.git'));
  const cloned = path.join(clones, 'acme-api');
  await expect.poll(async () => (await shellState(app)).projects.find((project) => project.fsPath === cloned)?.trusted, { timeout: 30_000 }).toBe(false);
  expect(await git(home, cloned, 'log', '-1', '--format=%s')).toBe('Initial commit');
  const asked = await askedDialogs(app);
  expect(asked.find((dialog) => dialog.message.includes(ADD_CLONE))?.buttons).toEqual(expect.arrayContaining(['Add Project']));
  expect(asked.some((dialog) => (dialog.message + (dialog.detail ?? '')).includes(TRUST_PROMPT) && (dialog.message + (dialog.detail ?? '')).includes('acme-api'))).toBe(true);

  // defaultCloneDirectory is where the folder picker opens, which still asks, as VS Code's does
  await applyUserSettings(app, home, { 'damocles.desktop.git.openAfterClone': 'always', 'damocles.desktop.git.defaultCloneDirectory': clones });
  await app.evaluate(({ dialog }, dir) => {
    const opened: unknown[] = [];
    (globalThis as unknown as { __e2eOpenDialogs: unknown[] }).__e2eOpenDialogs = opened;
    dialog.showOpenDialog = ((...args: unknown[]) => {
      opened.push(args.at(-1));
      return Promise.resolve({ canceled: false, filePaths: [dir] });
    }) as typeof dialog.showOpenDialog;
  }, clones);
  const askedBefore = (await askedDialogs(app)).filter((dialog) => dialog.message.includes(ADD_CLONE)).length;
  await clickMenu(app, 'damocles.git.cloneRecursive');
  await answerInput(app, open.url('parent.git'));
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __e2eOpenDialogs: unknown[] }).__e2eOpenDialogs)).toEqual([
    expect.objectContaining({ defaultPath: clones, buttonLabel: 'Select as Repository Destination' }),
  ]);
  const recursive = path.join(clones, 'parent');
  await expect.poll(async () => (await shellState(app)).projects.some((project) => project.fsPath === recursive), { timeout: 30_000 }).toBe(true);
  expect(fs.readFileSync(path.join(recursive, 'child', 'child.ts'), 'utf8')).toBe('export const child = 1;\n');
  expect((await askedDialogs(app)).filter((dialog) => dialog.message.includes(ADD_CLONE))).toHaveLength(askedBefore);
  await expect.poll(() => gitLog(app)).toMatch(/> git clone --recurse-submodules --/);
  expect(await gitLog(app)).not.toContain('protocol.file.allow');
});

test('Cancel on the progress row stops a pull against a slow server and a clone: the row names it, its process ends and no lock or folder is left', async ({ foreground: _foreground, home, launch }) => {
  const root = path.join(home.root, 'served');
  const bare = await bareRepo(home, root, 'held');
  await bareRepo(home, root, 'held-clone');
  open = await startGitHttpServer({ root });
  await cloneTo(home, bare, home.project, open.url('held.git'));
  const { app } = await launch({ env: HOOKS });
  const shell = await openScmProject(app, home.project);
  await commitUpstream(home, bare, 'up.ts', 'export const up = 1;\n');

  open.hold();
  const held = open.requests.held;
  await moreActions(app, shell, 'pull');
  await expect(progress(shell)).toHaveAttribute('data-kind', 'pull');
  await expect(scmSection(shell).getByTestId('scm-progress-label')).toHaveText('Pulling…');
  await expect.poll(() => open!.requests.held).toBeGreaterThan(held);
  await expect(syncButton(shell)).toHaveAttribute('data-running', 'pull');
  await scmSection(shell).getByTestId('scm-progress-cancel').click();
  await expect.poll(() => gitLog(app)).toMatch(/> git pull.*cancelled/);
  await expect(progress(shell)).toHaveCount(0);
  open.release();
  const locks = (dir: string): string[] => (fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[]).filter((file) => file.endsWith('.lock'));
  expect(locks(path.join(home.project, '.git'))).toEqual([]);
  expect(fs.existsSync(path.join(home.project, 'up.ts'))).toBe(false);

  // the clone: its row names the folder, and Cancel removes the folder the clone created
  const clones = path.join(home.root, 'clones');
  fs.mkdirSync(clones);
  await answerOpenDialog(app, clones);
  open.hold();
  await moreActions(app, shell, 'clone');
  await answerInput(app, open.url('held-clone.git'));
  await expect(scmSection(shell).getByTestId('scm-progress-label')).toHaveText('Cloning held-clone…');
  await scmSection(shell).getByTestId('scm-progress-cancel').click();
  await expect.poll(() => gitLog(app)).toMatch(/> git clone.*cancelled/);
  await expect(progress(shell)).toHaveCount(0);
  open.release();
  await expect.poll(() => fs.readdirSync(clones)).toEqual([]);
});

test('force push shows nowhere while allowForcePush is off and asks with Cancel focused once on; postCommitCommand sync follows a commit with Sync, which asks first', async ({ foreground: _foreground, home, launch }) => {
  const root = path.join(home.root, 'bare');
  const origin = await bareRepo(home, root, 'origin');
  await cloneTo(home, origin, home.project);
  writeUserSettings(home, { 'damocles.desktop.git.postCommitCommand': 'sync' });
  const { app } = await launch({ env: HOOKS });
  const shell = await openScmProject(app, home.project);

  const forceIds = ['damocles.git.pushForce', 'damocles.git.pushToForce', 'damocles.git.pushWithTagsForce'];
  const menuHas = (id: string): Promise<boolean> => app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId) != null, id);
  const paletteIds = async (query: string): Promise<string[]> => {
    const overlay = await overlayPage(app);
    await pressKeys(app, '/shell/', 'P', [PRIMARY, 'shift']);
    await expect(quickPick(overlay)).toBeVisible();
    await overlay.getByTestId('quick-pick-input').fill(`>${query}`);
    await expect(overlay.getByTestId('quick-pick-item').first()).toBeVisible();
    const ids = await overlay.getByTestId('quick-pick-item').evaluateAll((items) => items.map((item) => item.getAttribute('data-item-id') ?? ''));
    await overlay.keyboard.press('Escape');
    await expect(quickPick(overlay)).toHaveCount(0);
    return ids;
  };
  const pullPushIds = async (): Promise<string[]> => {
    const overlay = await readyOverlay(app);
    await clickSectionAction(shell, 'scm-more-actions');
    await menuItem(overlay, 'submenu:pullPush').click();
    await expect(overlay.locator('[data-submenu-item][data-item-id="pullPush:push"]')).toBeVisible();
    const ids = await overlay.locator('[data-submenu-item]').evaluateAll((items) => items.map((item) => item.getAttribute('data-item-id') ?? ''));
    await overlay.keyboard.press('Escape');
    await overlay.keyboard.press('Escape');
    await expect(overlayMenu(overlay)).toHaveCount(0);
    return ids;
  };

  for (const id of forceIds) expect(await menuHas(id), id).toBe(false);
  expect((await paletteIds('Push')).filter((id) => forceIds.includes(id))).toEqual([]);
  expect((await pullPushIds()).filter((id) => /Force$/.test(id))).toEqual([]);

  writeUserSettings(home, { 'damocles.desktop.git.postCommitCommand': 'sync', 'damocles.desktop.git.allowForcePush': true });
  await expect.poll(() => menuHas('damocles.git.pushForce')).toBe(true);
  expect(await paletteIds('Push (Force)')).toContain('damocles.git.pushForce');
  expect(await pullPushIds()).toEqual(expect.arrayContaining(['pullPush:pushForce', 'pullPush:pushToForce']));

  await commitLocal(home, home.project, 'b.ts', 'export const b = 1;\n', 'Pushed');
  await git(home, home.project, 'push', '--quiet', 'origin', 'HEAD:main');
  await git(home, home.project, 'commit', '--quiet', '--amend', '-m', 'Rewritten');
  await answerDialogs(app, { 'force push': 'Cancel' });
  await clickMenu(app, 'damocles.git.pushForce');
  await expect.poll(async () => (await askedDialogs(app)).find((dialog) => dialog.message.includes('force push'))).toMatchObject({ severity: 'danger', buttons: expect.arrayContaining(['Force Push', 'Cancel']) });
  expect(await git(home, origin, 'log', '-1', '--format=%s', 'main')).toBe('Pushed');

  // a commit with postCommitCommand sync: confirmSync's question first, then the pull and the push
  await git(home, home.project, 'reset', '--hard', '--quiet', 'origin/main');
  fs.writeFileSync(path.join(home.project, 'c.ts'), 'export const c = 1;\n');
  await git(home, home.project, 'add', 'c.ts');
  await answerDialogs(app, { [CONFIRM_SYNC]: 'OK' });
  await commitMessage(shell).fill('Synced after commit');
  await scmSection(shell).getByTestId('scm-commit').click();
  await expect.poll(() => git(home, origin, 'log', '-1', '--format=%s', 'main')).toBe('Synced after commit');
  const question = (await askedDialogs(app)).find((dialog) => dialog.message.includes(CONFIRM_SYNC));
  expect(question?.message).toBe(`${CONFIRM_SYNC} "origin/main".`);
  expect(question?.buttons).toEqual(expect.arrayContaining(['OK', "OK, Don't Show Again", 'Cancel']));
});
