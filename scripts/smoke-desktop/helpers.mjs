import fs from 'node:fs';
import path from 'node:path';

const SHELL_URL = 'app://damocles/shell/index.html';
const OVERLAY_URL = 'app://damocles/overlay/index.html';
const NOTIFIER_URL = 'app://damocles/notifier/index.html';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(fn, timeout = 30_000, every = 250) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(every);
  }
  throw new Error(`poll timed out: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

/** The helpers every step receives as `h`. `getApp` returns the running ElectronApplication. */
export function createHelpers(getApp, dir) {
  const app = () => getApp();
  const pageBy = (url) => app().windows().find((p) => !p.isClosed() && p.url() === url);
  const shell = () => poll(() => pageBy(SHELL_URL));
  const overlay = () => poll(() => pageBy(OVERLAY_URL));
  const popup = () => pageBy(NOTIFIER_URL);

  async function state() {
    const s = await shell();
    await s.waitForFunction(() => window.damoclesShell !== undefined);
    return s.evaluate(() => window.damoclesShell.getState());
  }

  const chatPages = () => app().windows().filter((p) => !p.isClosed() && p.url().includes('/panel/'));
  const sessionIdOf = (p) => p.evaluate(() => window.damoclesBridge?.getState()?.sessionId).catch(() => undefined);

  async function findChat(chatId) {
    if (chatId.startsWith('new:')) return chatPages().find((p) => p.url().includes(`/panel/${chatId.slice(4)}/`));
    for (const p of chatPages()) if ((await sessionIdOf(p)) === chatId) return p;
    return undefined;
  }

  /** The selected chat's page. */
  const active = () => poll(async () => {
    const id = (await state()).selected.chatId;
    return id && (await findChat(id));
  });

  const input = (t) => t.getByPlaceholder(/Ask Damocles anything|Type to queue/);
  const prompt = (t) => t.getByRole('region', { name: 'Permission request' });
  const modeBtn = (t) => t.getByTestId('composer-mode');
  const yoloBtn = (t) => t.getByTestId('composer-yolo');
  const modelBtn = (t) => t.locator('button[aria-label^="Model for this chat"]');

  async function send(t, text) {
    await input(t).click();
    await input(t).fill(text);
    await input(t).press('Enter');
  }

  /** A slash command: the command menu takes the first Enter when it is open. */
  async function slash(t, command) {
    await send(t, command);
    await sleep(800);
    if ((await input(t).inputValue()).trim() === command) await input(t).press('Enter');
  }

  /** Whether a turn is running: the composer's send button turns into "Stop (Esc)". */
  const running = (t) => t.evaluate(() => [...document.querySelectorAll('button')].some((b) => (b.getAttribute('aria-label') ?? '').startsWith('Stop (')));
  const tail = async (t, n = 2500) => (await t.evaluate(() => document.body.innerText)).slice(-n);

  async function shot(page, name) {
    const file = path.join(dir, 'shots', `${name}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file });
    return file;
  }

  async function setMode(t, label) {
    for (let i = 0; i < 4; i++) {
      const name = await modeBtn(t).getAttribute('aria-label');
      if (name?.includes(label)) return name;
      await modeBtn(t).click();
      await sleep(400);
    }
    throw new Error(`mode not reached: ${label}`);
  }

  async function setYolo(t, on) {
    if (((await yoloBtn(t).getAttribute('aria-pressed')) === 'true') !== on) {
      await yoloBtn(t).click();
      await sleep(300);
    }
  }

  /** Picks `model` and `effort` from the model button's dropdown menu. */
  async function setModel(t, model = 'Sonnet 5.5', effort = 'Medium') {
    const label = () => modelBtn(t).getAttribute('aria-label');
    const pick = async (name) => {
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
  async function prepare(t, mode = 'Ask before edits', model, effort) {
    await setYolo(t, false);
    await setMode(t, mode);
    await setModel(t, model, effort);
  }

  async function newChat() {
    const known = new Set(chatPages().map((p) => p.url()));
    await (await shell()).getByRole('button', { name: 'New chat', exact: true }).click();
    const t = await poll(async () => {
      const p = await active();
      return p && !known.has(p.url()) ? p : undefined;
    });
    await input(t).waitFor();
    await sleep(800);
    return t;
  }

  /** Selects the loaded chat shown in the page with `url`. */
  async function goTo(url) {
    const s = await shell();
    for (const project of (await state()).projects) {
      const list = await s.evaluate((k) => window.damoclesShell.listChats(k), project.key);
      for (const chat of list.chats.filter((c) => c.loaded)) {
        const p = await findChat(chat.id);
        if (p?.url() === url) {
          await s.evaluate((id) => window.damoclesShell.selectChat(id), chat.id);
          await sleep(800);
          return p;
        }
      }
    }
    throw new Error(`no loaded chat shows ${url}`);
  }

  /** Adds `folder` as a project through the menu, answering the folder picker and the trust dialog. */
  async function addProject(folder, trust = true) {
    const target = path.resolve(folder);
    await app().evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, target);
    await app().evaluate(({ Menu, BrowserWindow }) => {
      Menu.getApplicationMenu().getMenuItemById('damocles.addProject').click(undefined, BrowserWindow.getAllWindows()[0], undefined);
    });
    const dialog = (await overlay()).getByRole('alertdialog');
    await dialog.waitFor({ timeout: 15_000 });
    await dialog.getByRole('button', { name: trust ? 'Trust Folder' : "Don't Trust" }).click();
    await poll(async () => (await state()).projects.some((p) => path.resolve(p.fsPath).toLowerCase() === target.toLowerCase()), 15_000);
  }

  async function answerQuestion(t, choice) {
    await t.getByText(choice, { exact: true }).last().click({ timeout: 4000 });
    await sleep(400);
    const submit = t.getByRole('button', { name: 'Submit' }).last();
    if (await submit.isEnabled().catch(() => false)) await submit.click({ timeout: 3000 });
  }

  /** The newest desktop pop-up card containing `text`. */
  async function waitCard(text, timeout = 40_000) {
    const cards = () => popup()?.getByTestId('overlay-toast').filter({ hasText: text });
    await poll(async () => (await cards()?.count()) > 0, timeout, 400);
    return cards().last();
  }

  return {
    sleep, poll, app, dir, fs, path, pageBy, shell, overlay, popup, state, chatPages, findChat, active,
    input, prompt, modeBtn, yoloBtn, modelBtn, send, slash, running, tail, shot,
    setMode, setYolo, setModel, prepare, newChat, goTo, addProject, answerQuestion, waitCard,
  };
}
