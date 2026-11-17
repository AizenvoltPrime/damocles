import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import * as lockfile from 'proper-lockfile';
import type { ShellProject } from '../../src/desktop/preload/shell-channels';
import { mainLog, readyCorePid, type DesktopApp } from './support/app';
import { activeChat, chatById, expect, nextChat, test } from './support/fixtures';
import { seedStubModel, type HermeticHome } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { shownProjectOrder } from './support/projects';
import { recordedToasts, recordToasts, shellState } from './support/shell';
import { clickChat, cssString, listChats, readyShell } from './support/shell-ui';
import { addProject, answerDialogs, answerOpenDialog, askedDialogs, chatInput, clickMenu, sendAndAwaitEcho, TRUST_PROMPT } from './support/ui';

// piSessionDir's encoding of a folder (src/core/pi-session/session-store/session-dir.ts).
const sessionDirName = (folder: string): string => `--${folder.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
// main installs __damoclesE2e only with this set
const E2E_HOOKS = { env: { DAMOCLES_E2E_HOOKS: '1' } };
const CONFIRM_TITLE = '\'s chats to ';
const STOP_TITLE = 'Stop moving ';

interface ChatFile {
  readonly dir: string;
  readonly id: string;
  readonly bytes: string;
}

/** Every chat session file under the home's sessions root, wherever it lies. */
function chatFiles(home: HermeticHome): ChatFile[] {
  const root = path.join(home.agentDir, 'sessions');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((dir) =>
    fs.readdirSync(path.join(root, dir.name)).flatMap((name) => {
      const id = /^[^_.][^_]*_(.+)\.jsonl$/.exec(name)?.[1];
      return id === undefined ? [] : [{ dir: dir.name, id, bytes: fs.readFileSync(path.join(root, dir.name, name), 'latin1') }];
    }));
}

const trustedFolders = (home: HermeticHome): string[] => {
  const file = path.join(home.userData, 'trusted-folders.json');
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { folders: string[] }).folders : [];
};

/** What is left in the old folder's session dir; null once it is gone. */
const leftIn = (home: HermeticHome, folder: string): string[] | null => {
  const dir = path.join(home.agentDir, 'sessions', sessionDirName(folder));
  return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : null;
};

/** Sets core's e2e.relocationPauseAfter once main's e2e hooks are installed, which happens after startup. */
async function pauseAfter(app: ElectronApplication, sessions: number, mode: 'pause' | 'hang'): Promise<void> {
  type Hooks = { __damoclesE2e?: { relocationPauseAfter(sessions: number | null, mode: 'pause' | 'hang'): Promise<void> } };
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as Hooks).__damoclesE2e !== undefined)).toBe(true);
  await app.evaluate((_electron, args) => (globalThis as unknown as Hooks).__damoclesE2e!.relocationPauseAfter(args.sessions, args.mode), { sessions, mode });
}

/** Adds a saved new chat of the project to panels.json while the app is closed, as the project's last viewed chat. */
function addLastSavedChat(home: HermeticHome, projectKey: string, chat: { readonly panelId: string } & Record<string, unknown>): void {
  const file = path.join(home.userData, 'panels.json');
  const panels = JSON.parse(fs.readFileSync(file, 'utf8')) as { chats: unknown[]; lastChats?: { projectKey: string }[] };
  const lastChats = [...(panels.lastChats ?? []).filter((entry) => entry.projectKey !== projectKey), { projectKey, panelId: chat.panelId }];
  fs.writeFileSync(file, JSON.stringify({ ...panels, chats: [...panels.chats, chat], lastChats }));
}

const projectAt = async (app: ElectronApplication, fsPath: string): Promise<ShellProject | undefined> => (await shellState(app)).projects.find((p) => p.fsPath === fsPath);

/** Whether the list holds a project at `fsPath` whose folder is there and that no relocation names. */
async function listedAndPresent(app: ElectronApplication, fsPath: string): Promise<boolean> {
  const project = await projectAt(app, fsPath);
  return project !== undefined && project.presence === undefined && project.relocation === undefined;
}

/** Opens a chat in the selected project (the selected new chat first, then New Chat), sends `prompt` and returns its session id. */
async function chatWith(app: ElectronApplication, prompt: string, known: Page[]): Promise<{ id: string; page: Page }> {
  let page: Page;
  if (known.length === 0) page = await activeChat(app);
  else {
    const next = nextChat(app, known);
    await clickMenu(app, 'damocles.newChat');
    page = await next;
  }
  await sendAndAwaitEcho(page, prompt);
  let id: string | undefined;
  await expect.poll(async () => (id = (await shellState(app)).selected.chatId)?.startsWith('new:') ?? true).toBe(false);
  return { id: id!, page };
}

interface Seeded {
  readonly ids: string[];
  readonly prompts: string[];
  readonly titles: Map<string, string>;
  readonly order: string[];
  readonly key: string;
  // the second project's own chat
  readonly otherId: string;
}

/** Adds the project (trusted) with `count` chats, then a second project after it with one chat; the app is closed afterwards. */
async function seedProject(home: HermeticHome, launch: () => Promise<DesktopApp>, count: number, second: string): Promise<Seeded> {
  fs.mkdirSync(second, { recursive: true });
  const desktop = await launch();
  const { app } = desktop;
  await addProject(app, home.project, true);
  const key = (await projectAt(app, home.project))!.key;
  const pages: Page[] = [];
  const ids: string[] = [];
  const prompts: string[] = [];
  for (let i = 1; i <= count; i++) {
    const prompt = `chat ${i} before the move`;
    const chat = await chatWith(app, prompt, pages);
    pages.push(chat.page);
    ids.push(chat.id);
    prompts.push(prompt);
  }
  await addProject(app, second, true);
  const other = await chatWith(app, 'a chat of the second project', []);
  const titles = new Map((await listChats(app, key)).chats.filter((chat) => ids.includes(chat.id)).map((chat) => [chat.id, chat.title]));
  expect([...titles.keys()].sort()).toEqual([...ids].sort());
  const order = await shownProjectOrder(await readyShell(app));
  await desktop.close();
  return { ids, prompts, titles, order, key, otherId: other.id };
}

const locateNotice = (shell: Page, key: string) => shell.locator(`[data-testid="project-locate"][data-project-key=${cssString(key)}]`);

/** Locate… on the row of the project main shows missing, picking `to`. */
async function locate(app: ElectronApplication, key: string, to: string): Promise<void> {
  const shell = await readyShell(app);
  await expect.poll(async () => (await shellState(app)).projects.find((p) => p.key === key)?.presence).toBe('missing');
  await answerOpenDialog(app, to);
  await locateNotice(shell, key).getByTestId('project-locate-button').click();
}

/** Each id has exactly one chat file, in the session dir of `folder`, holding at least the bytes it had before the move. */
function expectMovedOnce(home: HermeticHome, before: readonly ChatFile[], ids: readonly string[], folder: string): void {
  const files = chatFiles(home);
  for (const id of ids) {
    const copies = files.filter((file) => file.id === id);
    expect(copies.map((file) => file.dir), id).toEqual([sessionDirName(folder)]);
    expect(copies[0]!.bytes.startsWith(before.find((file) => file.id === id)!.bytes), `${id} lost bytes`).toBe(true);
  }
}

test('Locate moves a renamed project\'s chats to the picked untrusted folder: trust is asked, the row keeps its place, the chats keep ids, titles and history, and the old path is no longer trusted', async ({ home, launch }) => {
  test.setTimeout(360_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const beta = path.join(path.dirname(home.project), 'beta');
    const seeded = await seedProject(home, launch, 3, beta);
    const before = chatFiles(home);
    const oldDir = sessionDirName(home.project);
    expect(before.filter((file) => seeded.ids.includes(file.id)).map((file) => file.dir)).toEqual([oldDir, oldDir, oldDir]);
    // agent data beside the first chat's file moves with it
    const subagent = path.join('subagents', '2026-01-01T10-00-00-000Z_5ub00000-0000-4000-8000-000000000001.jsonl');
    const subagentBytes = '{"type":"session","version":3,"id":"5ub00000-0000-4000-8000-000000000001","timestamp":"2026-01-01T10:00:00.000Z","cwd":"x"}\n';
    fs.mkdirSync(path.join(home.agentDir, 'sessions', oldDir, seeded.ids[0]!, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(home.agentDir, 'sessions', oldDir, seeded.ids[0]!, subagent), subagentBytes);
    expect(trustedFolders(home)).toContain(home.project);

    const moved = `${home.project}-renamed`;
    fs.renameSync(home.project, moved);
    const desktop = await launch();
    const { app } = desktop;
    await recordToasts(app);
    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder', [CONFIRM_TITLE]: 'Move Chats' });
    await locate(app, seeded.key, moved);

    await expect.poll(() => listedAndPresent(app, moved), { timeout: 60_000 }).toBe(true);
    const asked = await askedDialogs(app);
    const confirm = asked.find((dialog) => dialog.message.includes(CONFIRM_TITLE));
    expect(confirm?.message).toContain(moved);
    expect(confirm?.answered).toBe('Move Chats');
    expect(asked.some((dialog) => dialog.message.startsWith(TRUST_PROMPT) && `${dialog.message} ${dialog.detail ?? ''}`.includes(path.basename(moved)) && dialog.answered === 'Trust Folder')).toBe(true);
    await expect.poll(async () => (await recordedToasts(app)).map((toast) => toast.message)).toContain(`Moved 3 chats of ${path.basename(home.project)} to ${moved}.`);

    const project = (await projectAt(app, moved))!;
    expect(project.presence).toBeUndefined();
    expect((await shellState(app)).projects.some((p) => p.fsPath === home.project)).toBe(false);
    const shell = await readyShell(app);
    // the sidebar order moves in a write of its own after the list's
    await expect.poll(() => shownProjectOrder(shell)).toEqual(seeded.order.map((key) => (key === seeded.key ? project.key : key)));

    expectMovedOnce(home, before, seeded.ids, moved);
    expectMovedOnce(home, before, [seeded.otherId], path.join(path.dirname(home.project), 'beta'));
    await expect.poll(() => leftIn(home, home.project), { timeout: 15_000 }).toBeNull();
    expect(fs.readFileSync(path.join(home.agentDir, 'sessions', sessionDirName(moved), seeded.ids[0]!, subagent), 'utf8')).toBe(subagentBytes);

    const listed = (await listChats(app, project.key)).chats;
    expect(new Map(listed.filter((chat) => seeded.ids.includes(chat.id)).map((chat) => [chat.id, chat.title]))).toEqual(seeded.titles);
    for (const [i, id] of seeded.ids.entries()) {
      await clickChat(shell, id);
      await expect.poll(async () => (await shellState(app)).selected.chatId).toBe(id);
      await expect((await activeChat(app)).getByText(`Echo: ${seeded.prompts[i]!}`, { exact: true })).toBeVisible();
    }
    await expect.poll(() => trustedFolders(home)).toContain(moved);
    expect(trustedFolders(home)).not.toContain(home.project);
    expect((await recordedToasts(app)).filter((toast) => toast.severity === 'error')).toEqual([]);
  } finally {
    await stub.close();
  }
});

test('Locate reopens the saved chats the missing folder kept closed, one holding its first prompt among them, without opening them from the Chats list', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const seeded = await seedProject(home, launch, 2, path.join(path.dirname(home.project), 'beta'));
    const heldPanel = 'held-across-the-move';
    const held = 'A first prompt held across the move';
    // the project's last viewed chat, which the move selects, so retention keeps it loaded as it does a selected chat
    addLastSavedChat(home, seeded.key, { panelId: heldPanel, state: { workspaceFolderKey: seeded.key }, pages: [], heldPrompt: [{ type: 'text', text: held }] });
    const moved = `${home.project}-renamed`;
    fs.renameSync(home.project, moved);

    const { app } = await launch();
    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder', [CONFIRM_TITLE]: 'Move Chats' });
    await locate(app, seeded.key, moved);
    await expect.poll(() => listedAndPresent(app, moved), { timeout: 60_000 }).toBe(true);
    const project = (await projectAt(app, moved))!;
    const loaded = async (): Promise<string[]> => (await listChats(app, project.key)).chats.filter((chat) => chat.loaded && seeded.ids.includes(chat.id)).map((chat) => chat.id).sort();
    await expect.poll(loaded, { timeout: 30_000 }).toEqual([...seeded.ids].sort());
    await expect(chatInput(await chatById(app, `new:${heldPanel}`))).toHaveValue(held, { timeout: 30_000 });
  } finally {
    await stub.close();
  }
});

test('a relocation stopped after one session finishes at the next launch, with no chat file duplicated or lost', async ({ home, launch }) => {
  test.setTimeout(360_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const seeded = await seedProject(home, launch, 3, path.join(path.dirname(home.project), 'beta'));
    const before = chatFiles(home);
    const moved = `${home.project}-renamed`;
    fs.renameSync(home.project, moved);

    let desktop = await launch(E2E_HOOKS);
    let app = desktop.app;
    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder', [CONFIRM_TITLE]: 'Move Chats' });
    await pauseAfter(app, 1, 'pause');
    await locate(app, seeded.key, moved);
    const shell = await readyShell(app);
    await expect(locateNotice(shell, seeded.key)).toHaveAttribute('data-state', 'paused', { timeout: 60_000 });
    await expect(locateNotice(shell, seeded.key).getByTestId('project-locate-reason')).toHaveAttribute('data-code', 'stopped');
    await expect(locateNotice(shell, seeded.key).getByTestId('project-locate-retry')).toBeVisible();
    const midway = chatFiles(home).filter((file) => seeded.ids.includes(file.id));
    expect(midway.map((file) => file.id).sort()).toEqual([...seeded.ids].sort());
    expect(midway.filter((file) => file.dir === sessionDirName(moved))).toHaveLength(1);
    await desktop.close();

    desktop = await launch();
    app = desktop.app;
    await expect.poll(() => listedAndPresent(app, moved), { timeout: 90_000 }).toBe(true);
    expect((await shellState(app)).projects.some((p) => p.fsPath === home.project)).toBe(false);
    expectMovedOnce(home, before, seeded.ids, moved);
    expectMovedOnce(home, before, [seeded.otherId], path.join(path.dirname(home.project), 'beta'));
    await expect.poll(() => leftIn(home, home.project), { timeout: 15_000 }).toBeNull();
  } finally {
    await stub.close();
  }
});

test('Retry runs a paused move on in the same launch, which says why it paused from outside the listbox, with no chat file duplicated or lost', async ({ home, launch }) => {
  test.setTimeout(360_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const seeded = await seedProject(home, launch, 3, path.join(path.dirname(home.project), 'beta'));
    const before = chatFiles(home);
    const moved = `${home.project}-renamed`;
    fs.renameSync(home.project, moved);

    const { app } = await launch(E2E_HOOKS);
    await recordToasts(app);
    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder', [CONFIRM_TITLE]: 'Move Chats' });
    await pauseAfter(app, 1, 'pause');
    await locate(app, seeded.key, moved);
    const shell = await readyShell(app);
    const notice = locateNotice(shell, seeded.key);
    await expect(notice).toHaveAttribute('data-state', 'paused', { timeout: 60_000 });
    const reason = await notice.getByTestId('project-locate-reason').textContent();
    await expect(shell.locator(`[role="alert"][data-testid="project-locate-alert"][data-project-key=${cssString(seeded.key)}]`)).toHaveText(reason!);

    // pauseAfter fired once, so the retried move runs to the end
    await notice.getByTestId('project-locate-retry').click();
    await expect.poll(() => listedAndPresent(app, moved), { timeout: 60_000 }).toBe(true);
    await expect.poll(async () => (await recordedToasts(app)).map((toast) => toast.message)).toContain(`Moved 3 chats of ${path.basename(home.project)} to ${moved}.`);
    expect((await shellState(app)).projects.some((p) => p.fsPath === home.project)).toBe(false);
    expectMovedOnce(home, before, seeded.ids, moved);
    expectMovedOnce(home, before, [seeded.otherId], path.join(path.dirname(home.project), 'beta'));
    expect((await recordedToasts(app)).filter((toast) => toast.severity === 'error')).toEqual([]);
  } finally {
    await stub.close();
  }
});

test('Stop moving gives up a paused move: the moved chat stays in the new folder, the row offers Locate… again, and locating it there moves the rest, every chat readable', async ({ home, launch }) => {
  test.setTimeout(360_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const seeded = await seedProject(home, launch, 3, path.join(path.dirname(home.project), 'beta'));
    const before = chatFiles(home);
    const moved = `${home.project}-renamed`;
    fs.renameSync(home.project, moved);

    const { app } = await launch(E2E_HOOKS);
    await recordToasts(app);
    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder', [CONFIRM_TITLE]: 'Move Chats', [STOP_TITLE]: 'Stop Moving' });
    await pauseAfter(app, 1, 'pause');
    await locate(app, seeded.key, moved);
    const shell = await readyShell(app);
    const notice = locateNotice(shell, seeded.key);
    await expect(notice).toHaveAttribute('data-state', 'paused', { timeout: 60_000 });

    await notice.getByTestId('project-locate-abandon').click();
    await expect(notice).toHaveAttribute('data-state', 'absent', { timeout: 30_000 });
    await expect(notice.getByTestId('project-locate-button')).toBeVisible();
    const asked = (await askedDialogs(app)).find((dialog) => dialog.message.includes(STOP_TITLE));
    expect(asked?.answered).toBe('Stop Moving');
    expect(asked?.severity).toBe('danger');
    const journal = JSON.parse(fs.readFileSync(path.join(home.damoclesDir, 'project-relocations.json'), 'utf8')) as { relocations: Array<{ state: string }> };
    expect(journal.relocations.map((relocation) => relocation.state)).toEqual(['abandoned']);
    // nothing moved back: one chat in the new folder's dir, the rest in the old one's
    const split = chatFiles(home).filter((file) => seeded.ids.includes(file.id));
    expect(split.map((file) => file.id).sort()).toEqual([...seeded.ids].sort());
    expect(split.filter((file) => file.dir === sessionDirName(moved))).toHaveLength(1);
    expect(split.filter((file) => file.dir === sessionDirName(home.project))).toHaveLength(2);

    await locate(app, seeded.key, moved);
    await expect.poll(() => listedAndPresent(app, moved), { timeout: 60_000 }).toBe(true);
    await expect.poll(async () => (await recordedToasts(app)).map((toast) => toast.message)).toContain(`Moved 2 chats of ${path.basename(home.project)} to ${moved}.`);
    expectMovedOnce(home, before, seeded.ids, moved);
    const project = (await projectAt(app, moved))!;
    expect((await listChats(app, project.key)).chats.map((chat) => chat.id)).toEqual(expect.arrayContaining(seeded.ids));
    for (const [i, id] of seeded.ids.entries()) {
      await clickChat(shell, id);
      await expect.poll(async () => (await shellState(app)).selected.chatId).toBe(id);
      await expect((await activeChat(app)).getByText(`Echo: ${seeded.prompts[i]!}`, { exact: true })).toBeVisible();
    }
    expect((await recordedToasts(app)).filter((toast) => toast.severity === 'error')).toEqual([]);
  } finally {
    await stub.close();
  }
});

test('a relocation whose core is killed mid-run finishes once the restarted core takes over its lock, with no chat file duplicated or lost', async ({ home, launch }) => {
  test.setTimeout(360_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const seeded = await seedProject(home, launch, 3, path.join(path.dirname(home.project), 'beta'));
    const before = chatFiles(home);
    const moved = `${home.project}-renamed`;
    fs.renameSync(home.project, moved);

    const desktop = await launch(E2E_HOOKS);
    const { app } = desktop;
    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder', [CONFIRM_TITLE]: 'Move Chats' });
    const pid = await readyCorePid(app, home);
    await pauseAfter(app, 1, 'hang');
    await locate(app, seeded.key, moved);
    // the run hangs after its first commit, holding the relocation lock
    await expect.poll(() => chatFiles(home).filter((file) => file.dir === sessionDirName(moved)).length, { timeout: 60_000 }).toBe(1);
    await expect.poll(async () => (await shellState(app)).projects.find((p) => p.key === seeded.key)?.relocation?.state).toBe('running');

    // SIGKILL, a real crash, so the lock stays behind until it turns stale
    const since = mainLog(home).length;
    process.kill(pid, 'SIGKILL');
    await readyCorePid(app, home, since);
    await expect.poll(() => listedAndPresent(app, moved), { timeout: 120_000 }).toBe(true);
    expect((await shellState(app)).projects.some((p) => p.fsPath === home.project)).toBe(false);
    expectMovedOnce(home, before, seeded.ids, moved);
    expectMovedOnce(home, before, [seeded.otherId], path.join(path.dirname(home.project), 'beta'));
  } finally {
    await stub.close();
  }
});

test('a finished move whose host part did not run is applied once the engine restarts, with no relaunch', async ({ home, launch }) => {
  test.setTimeout(360_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const seeded = await seedProject(home, launch, 1, path.join(path.dirname(home.project), 'beta'));
    const moved = `${home.project}-renamed`;
    fs.renameSync(home.project, moved);
    let desktop = await launch();
    await answerDialogs(desktop.app, { [TRUST_PROMPT]: 'Trust Folder', [CONFIRM_TITLE]: 'Move Chats' });
    await locate(desktop.app, seeded.key, moved);
    await expect.poll(() => listedAndPresent(desktop.app, moved), { timeout: 60_000 }).toBe(true);
    await desktop.close();

    // as if the host part had stopped before the list changed, and the next launch's core had not read the move's record
    const journalFile = path.join(home.damoclesDir, 'project-relocations.json');
    const journal = fs.readFileSync(journalFile, 'utf8');
    fs.rmSync(journalFile);
    const listFile = path.join(home.userData, 'projects.json');
    const list = JSON.parse(fs.readFileSync(listFile, 'utf8')) as { projects: string[] };
    fs.writeFileSync(listFile, JSON.stringify({ version: 1, projects: list.projects.map((folder) => (folder === moved ? home.project : folder)) }));

    desktop = await launch();
    const { app } = desktop;
    await expect.poll(async () => (await projectAt(app, home.project))?.presence, { timeout: 30_000 }).toBe('missing');
    // the running core reads the record back; its mirror names only the moves it saw pending
    fs.writeFileSync(journalFile, journal);
    const since = mainLog(home).length;
    await clickMenu(app, 'damocles.restartEngine');
    await readyCorePid(app, home, since);
    await expect.poll(() => listedAndPresent(app, moved), { timeout: 60_000 }).toBe(true);
    expect((await shellState(app)).projects.some((p) => p.fsPath === home.project)).toBe(false);
  } finally {
    await stub.close();
  }
});

test('preflight refuses the same folder, a folder inside ~/.damocles, a chat another process holds, and an old folder that still exists, whose refusal ends once main finds the folder back', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const seeded = await seedProject(home, launch, 1, path.join(path.dirname(home.project), 'beta'));
    const before = chatFiles(home);
    const moved = `${home.project}-renamed`;
    fs.renameSync(home.project, moved);
    const inside = path.join(home.damoclesDir, 'inside');
    fs.mkdirSync(inside, { recursive: true });

    const { app } = await launch();
    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder', [CONFIRM_TITLE]: 'Move Chats' });
    const shell = await readyShell(app);
    const expectRefusal = async (to: string, code: string): Promise<void> => {
      await locate(app, seeded.key, to);
      await expect(locateNotice(shell, seeded.key)).toHaveAttribute('data-state', 'refused');
      await expect(locateNotice(shell, seeded.key).getByTestId('project-locate-reason')).toHaveAttribute('data-code', code);
    };
    await expectRefusal(home.project, 'sameFolder');
    await expectRefusal(inside, 'insideDamocles');

    // another process's lease on the chat, as a VS Code window holding it has
    const lease = path.join(home.damoclesDir, 'locks', 'sessions', `${seeded.ids[0]!}.lock`);
    fs.mkdirSync(path.dirname(lease), { recursive: true });
    const release = await lockfile.lock(lease, { lockfilePath: lease, realpath: false, stale: 20_000, update: 2_000 });
    try {
      await expectRefusal(moved, 'chatHeld');
    } finally {
      await release();
    }

    // main still shows the row missing (presence is read again on focus), so core's preflight finds the folder
    fs.mkdirSync(home.project, { recursive: true });
    await expectRefusal(moved, 'fromExists');
    expect(chatFiles(home)).toEqual(before);
    expect(fs.existsSync(path.join(home.damoclesDir, 'project-relocations.json'))).toBe(false);
    expect((await askedDialogs(app)).filter((dialog) => dialog.message.includes(CONFIRM_TITLE))).toEqual([]);

    // a selection checks the folder again
    await shell.evaluate((key) => window.damoclesShell!.selectProject(key), seeded.key);
    await expect.poll(async () => (await shellState(app)).projects.find((p) => p.key === seeded.key)?.presence).toBeUndefined();
    expect((await shellState(app)).projects.find((p) => p.key === seeded.key)?.relocation).toBeUndefined();
    await expect(locateNotice(shell, seeded.key)).toHaveCount(0);
  } finally {
    await stub.close();
  }
});

test('locating a project into another listed project merges its chats there and removes its row', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const beta = path.join(path.dirname(home.project), 'beta');
    const seeded = await seedProject(home, launch, 1, beta);
    const before = chatFiles(home);
    fs.renameSync(home.project, `${home.project}-gone`);

    const desktop = await launch();
    const { app } = desktop;
    const betaKey = (await projectAt(app, beta))!.key;
    await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder', [CONFIRM_TITLE]: 'Move Chats' });
    await locate(app, seeded.key, beta);
    await expect.poll(async () => (await shellState(app)).projects.map((p) => p.key), { timeout: 60_000 }).toEqual(seeded.order.filter((key) => key !== seeded.key));
    expect((await askedDialogs(app)).filter((dialog) => dialog.message.startsWith(TRUST_PROMPT))).toEqual([]);

    expectMovedOnce(home, before, [...seeded.ids, seeded.otherId], beta);
    await expect.poll(async () => (await listChats(app, betaKey)).chats.map((chat) => chat.id).sort(), { timeout: 30_000 }).toEqual([...seeded.ids, seeded.otherId].sort());
    const shell = await readyShell(app);
    await clickChat(shell, seeded.ids[0]!);
    await expect((await activeChat(app)).getByText(`Echo: ${seeded.prompts[0]!}`, { exact: true })).toBeVisible();
    expect(trustedFolders(home)).not.toContain(home.project);
    expect(trustedFolders(home)).toContain(beta);

    // a folder added again at the old path is another project: neither a later change of the mirror nor a relaunch with it
    // missing merges it into beta again
    fs.mkdirSync(home.project, { recursive: true });
    await addProject(app, home.project, true);
    const readded = (await projectAt(app, home.project))!;
    await expect.poll(() => listedAndPresent(app, home.project)).toBe(true);
    await desktop.close();
    // the list's write that merged the row recorded the move as applied
    const journal = JSON.parse(fs.readFileSync(path.join(home.damoclesDir, 'project-relocations.json'), 'utf8')) as { relocations: Array<{ id: string }> };
    const listFile = JSON.parse(fs.readFileSync(path.join(home.userData, 'projects.json'), 'utf8')) as { relocated?: string[] };
    expect(listFile.relocated).toEqual(journal.relocations.map((relocation) => relocation.id));
    fs.rmSync(home.project, { recursive: true, force: true });
    const relaunched = await launch();
    await expect.poll(async () => (await projectAt(relaunched.app, home.project))?.presence, { timeout: 30_000 }).toBe('missing');
    // the launch asks for the moves from a missing folder before its chats reopen, which the window shows
    await expect.poll(async () => (await listChats(relaunched.app, betaKey)).chats.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect((await shellState(relaunched.app)).projects.map((p) => p.key)).toEqual([...seeded.order.filter((key) => key !== seeded.key), readded.key]);
    expect(trustedFolders(home)).toContain(home.project);
  } finally {
    await stub.close();
  }
});
