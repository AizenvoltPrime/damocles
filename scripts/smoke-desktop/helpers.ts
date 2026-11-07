import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

type Falsy = false | 0 | '' | null | undefined;

// The shell state of src/desktop/preload/shell-channels.ts ShellState, as far as the helpers read it.
interface ShellStateView {
  revision: number;
  selected: { projectKey?: string; chatId?: string };
  projects: readonly { key: string; fsPath: string }[];
}

// The globals src/desktop/preload/shell.ts and panel.ts expose on the shell and chat pages, as far as the helpers read them.
// Playwright runs an evaluate callback from its source in the page, so each callback names window itself.
interface SmokeWindow {
  damoclesShell: {
    getState(): Promise<ShellStateView>;
    listChats(projectKey: string, stateRevision: number): Promise<{ chats: readonly { id: string; loaded: boolean }[] } | null>;
    selectChat(chatId: string): Promise<unknown>;
  };
  damoclesBridge?: { getState(): { sessionId?: string } | undefined };
}

const SHELL_URL = 'app://damocles/shell/index.html';
const OVERLAY_URL = 'app://damocles/overlay/index.html';
const NOTIFIER_URL = 'app://damocles/notifier/index.html';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function poll<T>(fn: () => T | Falsy | Promise<T | Falsy>, timeout = 30_000, every = 250): Promise<T> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (err) {
      last = err;
    }
    await sleep(every);
  }
  throw new Error(`poll timed out: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

/** The helpers every step receives as `h`. `getApp` returns the running ElectronApplication, `getHome` its hermetic home. */
export function createHelpers(getApp: () => ElectronApplication, dir: string, getHome: () => { home: string } | undefined) {
  const app = () => getApp();
  /** The launched app's home folder (its `~`), which `--quit` deletes. */
  const home = () => {
    const h = getHome();
    if (!h) throw new Error('The app has not been launched; post --launch first.');
    return h.home;
  };
  const pageBy = (url: string): Page | undefined => app().windows().find((p) => !p.isClosed() && p.url() === url);
  const shell = () => poll(() => pageBy(SHELL_URL));
  const overlay = () => poll(() => pageBy(OVERLAY_URL));
  const popup = () => pageBy(NOTIFIER_URL);

  async function state(): Promise<ShellStateView> {
    const s = await shell();
    await s.waitForFunction(() => (window as typeof window & SmokeWindow).damoclesShell !== undefined);
    return s.evaluate(() => (window as typeof window & SmokeWindow).damoclesShell.getState());
  }

  const chatPages = () => app().windows().filter((p) => !p.isClosed() && p.url().includes('/panel/'));
  const sessionIdOf = (p: Page): Promise<string | undefined> => p.evaluate(() => (window as typeof window & SmokeWindow).damoclesBridge?.getState()?.sessionId).catch(() => undefined);

  async function findChat(chatId: string): Promise<Page | undefined> {
    if (chatId.startsWith('new:')) return chatPages().find((p) => p.url().includes(`/panel/${chatId.slice(4)}/`));
    for (const p of chatPages()) if ((await sessionIdOf(p)) === chatId) return p;
    return undefined;
  }

  /** The selected chat's page. */
  const active = () => poll(async () => {
    const id = (await state()).selected.chatId;
    return id && (await findChat(id));
  });

  const input = (t: Page): Locator => t.getByPlaceholder(/Ask Damocles anything|Type to queue/);
  const prompt = (t: Page): Locator => t.getByRole('region', { name: 'Permission request' });
  const modeBtn = (t: Page): Locator => t.getByTestId('composer-mode');
  const yoloBtn = (t: Page): Locator => t.getByTestId('composer-yolo');
  const modelBtn = (t: Page): Locator => t.locator('button[aria-label^="Model for this chat"]');

  async function send(t: Page, text: string): Promise<void> {
    await input(t).click();
    await input(t).fill(text);
    await input(t).press('Enter');
  }

  /** A slash command: the command menu takes the first Enter when it is open. */
  async function slash(t: Page, command: string): Promise<void> {
    await send(t, command);
    await sleep(800);
    if ((await input(t).inputValue()).trim() === command) await input(t).press('Enter');
  }

  /** Whether a turn is running: the composer's send button turns into "Stop (Esc)". */
  const running = (t: Page): Promise<boolean> => t.evaluate(() => Array.from(document.querySelectorAll('button')).some((b) => (b.getAttribute('aria-label') ?? '').startsWith('Stop (')));
  const tail = async (t: Page, n = 2500): Promise<string> => (await t.evaluate(() => document.body.innerText)).slice(-n);

  async function shot(page: Page, name: string): Promise<string> {
    const file = path.join(dir, 'shots', `${name}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file });
    return file;
  }

  async function setMode(t: Page, label: string): Promise<string> {
    for (let i = 0; i < 4; i++) {
      const name = await modeBtn(t).getAttribute('aria-label');
      if (name?.includes(label)) return name;
      await modeBtn(t).click();
      await sleep(400);
    }
    throw new Error(`mode not reached: ${label}`);
  }

  async function setYolo(t: Page, on: boolean): Promise<void> {
    if (((await yoloBtn(t).getAttribute('aria-pressed')) === 'true') !== on) {
      await yoloBtn(t).click();
      await sleep(300);
    }
  }

  /** Picks `model` and `effort` from the model button's dropdown menu. */
  async function setModel(t: Page, model = 'Haiku 5.5', effort = 'Low'): Promise<string> {
    // the locator matches the button by its aria-label, so a found button always has one
    const label = async (): Promise<string> => (await modelBtn(t).getAttribute('aria-label')) ?? '';
    const pick = async (name: string): Promise<void> => {
      if ((await modelBtn(t).getAttribute('data-state')) !== 'open') {
        await modelBtn(t).click();
        await sleep(600);
      }
      const items = t.locator('[role="menu"] [role="menuitemradio"]');
      const names = (await items.allInnerTexts()).map((s) => s.trim());
      if (!names.includes(name)) {
        await t.keyboard.press('Escape');
        throw new Error(`"${name}" is not in the model menu, which offers: ${names.join(', ')}`);
      }
      await items.filter({ hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) }).first().click();
      await sleep(800);
    };
    if (!(await label()).includes(model)) await pick(model);
    // A model without reasoning effort (its label has no "· effort" part) offers no effort items.
    if ((await label()).includes('·') && !(await label()).includes(`· ${effort}`)) await pick(effort);
    if ((await modelBtn(t).getAttribute('data-state')) === 'open') await t.keyboard.press('Escape');
    return label();
  }

  /** Puts a chat in a known state: YOLO off, the given mode, the given model. */
  async function prepare(t: Page, mode = 'Ask before edits', model?: string, effort?: string): Promise<void> {
    await setYolo(t, false);
    await setMode(t, mode);
    await setModel(t, model, effort);
  }

  /** Runs an application menu item by its id from `src/desktop/main/commands.ts`. */
  async function runMenuItem(id: string): Promise<void> {
    await app().evaluate(({ Menu, BrowserWindow }, itemId) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
      if (!item) throw new Error(`The application menu has no item ${itemId}.`);
      item.click(undefined, BrowserWindow.getAllWindows()[0], undefined);
    }, id);
  }

  // File > New Chat: the sidebar's New chat button is hidden until its section header is hovered.
  async function newChat(): Promise<Page> {
    const known = new Set(chatPages().map((p) => p.url()));
    await runMenuItem('damocles.newChat');
    const t = await poll(async () => {
      const p = await active();
      return p && !known.has(p.url()) ? p : undefined;
    });
    await input(t).waitFor();
    await sleep(800);
    return t;
  }

  /** Selects the loaded chat shown in the page with `url`. */
  async function goTo(url: string): Promise<Page> {
    const s = await shell();
    const current = await state();
    for (const project of current.projects) {
      // A list names the state revision its project key came from; null means the project left main's list since.
      const list = await s.evaluate(([k, r]) => (window as typeof window & SmokeWindow).damoclesShell.listChats(k, r), [project.key, current.revision] as const);
      for (const chat of (list?.chats ?? []).filter((c) => c.loaded)) {
        const p = await findChat(chat.id);
        if (p?.url() === url) {
          await s.evaluate((id) => (window as typeof window & SmokeWindow).damoclesShell.selectChat(id), chat.id);
          await sleep(800);
          return p;
        }
      }
    }
    throw new Error(`no loaded chat shows ${url}`);
  }

  /** Adds `folder` as a project through the menu, answering the folder picker and the trust dialog. */
  async function addProject(folder: string, trust = true): Promise<void> {
    const target = path.resolve(folder);
    await app().evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, target);
    await runMenuItem('damocles.addProject');
    const dialog = (await overlay()).getByRole('alertdialog');
    await dialog.waitFor({ timeout: 15_000 });
    await dialog.getByRole('button', { name: trust ? 'Trust Folder' : "Don't Trust" }).click();
    await poll(async () => (await state()).projects.some((p) => path.resolve(p.fsPath).toLowerCase() === target.toLowerCase()), 15_000);
  }

  async function answerQuestion(t: Page, choice: string): Promise<void> {
    await t.getByText(choice, { exact: true }).last().click({ timeout: 4000 });
    await sleep(400);
    const submit = t.getByRole('button', { name: 'Submit' }).last();
    if (await submit.isEnabled().catch(() => false)) await submit.click({ timeout: 3000 });
  }

  /** The newest desktop pop-up card containing `text`. */
  async function waitCard(text: string, timeout = 40_000): Promise<Locator> {
    const cards = (): Locator | undefined => popup()?.getByTestId('overlay-toast').filter({ hasText: text });
    await poll(async () => ((await cards()?.count()) ?? 0) > 0, timeout, 400);
    const found = cards();
    if (!found) throw new Error('The pop-up window closed.');
    return found.last();
  }

  return {
    sleep, poll, app, dir, home, fs, path, pageBy, shell, overlay, popup, state, chatPages, findChat, active, runMenuItem,
    input, prompt, modeBtn, yoloBtn, modelBtn, send, slash, running, tail, shot,
    setMode, setYolo, setModel, prepare, newChat, goTo, addProject, answerQuestion, waitCard,
  };
}

export type Helpers = ReturnType<typeof createHelpers>;
