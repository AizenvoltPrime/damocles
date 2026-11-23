import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { homeOf } from './app';
import { writeUserSettings } from './hermetic';
import { readyOverlay } from './overlay';
import { SHELL_URL, shellState } from './shell';

// Leading text of the desktop trust prompt (src/desktop/main/trust-store.ts).
export const TRUST_PROMPT = 'Do you trust the authors of the files in';

export const CHAT_PLACEHOLDER = 'Ask Damocles anything…';

/** The element's box once every finite animation that moves it (its own, its subtree's and its ancestors') has played. */
export async function settledBox(element: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await element.evaluate(async (node) => {
    const moving = [...node.getAnimations({ subtree: true })];
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) moving.push(...ancestor.getAnimations());
    // a cancelled animation rejects finished, and has stopped moving the box all the same
    await Promise.all(moving.filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity).map((animation) => animation.finished.catch(() => undefined)));
  });
  const box = await element.boundingBox();
  if (!box) throw new Error('The element has no box');
  return box;
}

export function chatInput(tab: Page): Locator {
  return tab.getByPlaceholder(CHAT_PLACEHOLDER);
}

/**
 * Picks the dark or light look through damocles.desktop.theme, as Settings does, and waits until main applied it. Main owns
 * nativeTheme.themeSource and writes it again on any theme change, so a test never writes it.
 */
export async function setLook(app: ElectronApplication, kind: 'dark' | 'light'): Promise<void> {
  writeUserSettings(homeOf(app), { 'damocles.desktop.theme': kind });
  await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe(kind);
}

export interface RecordedBox {
  message: string;
  detail?: string;
  buttons?: string[];
  type?: string;
  // shown as a modal of the app window rather than a free-standing box
  parented: boolean;
  // the button a rule chose; absent when the box was cancelled
  answered?: string;
  // Date.now() in main as it asked
  at: number;
}

/**
 * Replaces dialog.showMessageBox in main with a recorder that answers with the button labelled `answers[message or detail
 * substring]`, or cancels when no rule matches. Each call replaces the rules. Read with `messageBoxes`.
 */
export async function answerMessageBoxes(app: ElectronApplication, answers: Record<string, string> = {}): Promise<void> {
  await app.evaluate(({ dialog }, rules) => {
    const g = globalThis as unknown as { __e2eBoxes?: RecordedBox[] };
    g.__e2eBoxes = g.__e2eBoxes ?? [];
    const box = (...args: unknown[]): Promise<{ response: number; checkboxChecked: boolean }> => {
      const opts = (args.length > 1 ? args[1] : args[0]) as { message: string; detail?: string; buttons?: string[]; type?: string; cancelId?: number };
      const rule = Object.entries(rules).find(([needle]) => opts.message.includes(needle) || (opts.detail ?? '').includes(needle));
      const index = rule ? (opts.buttons ?? []).indexOf(rule[1]) : -1;
      g.__e2eBoxes!.push({
        message: opts.message,
        ...(opts.detail ? { detail: opts.detail } : {}),
        ...(opts.buttons ? { buttons: opts.buttons } : {}),
        ...(opts.type ? { type: opts.type } : {}),
        parented: args.length > 1,
        ...(index >= 0 ? { answered: rule![1] } : {}),
        at: Date.now(),
      });
      return Promise.resolve({ response: index >= 0 ? index : (opts.cancelId ?? (opts.buttons?.length ? opts.buttons.length - 1 : 0)), checkboxChecked: false });
    };
    dialog.showMessageBox = box as typeof dialog.showMessageBox;
  }, answers);
}

export async function messageBoxes(app: ElectronApplication): Promise<RecordedBox[]> {
  return app.evaluate(() => (globalThis as unknown as { __e2eBoxes?: RecordedBox[] }).__e2eBoxes ?? []);
}

export interface RecordedDialog {
  // where main asked (D41): the overlay's dialog, or the OS message box it falls back to
  surface: 'overlay' | 'os';
  message: string;
  detail?: string;
  buttons: string[];
  severity: string;
  // the button answerDialogs chose
  answered?: string;
  at: number;
}

/**
 * Answers every question main asks, wherever it asks it (D41), with the button labelled `answers[message or detail
 * substring]`: an overlay dialog once it is drawn, as the user would, and the OS message box main falls back to
 * (`answerMessageBoxes`, which cancels a box no rule matches). An overlay dialog no rule matches is left for the test. Each
 * call replaces the rules, which apply only to questions asked after it. Read with `askedDialogs`.
 */
export async function answerDialogs(app: ElectronApplication, answers: Record<string, string> = {}): Promise<void> {
  await answerMessageBoxes(app, answers);
  const overlay = await readyOverlay(app);
  await overlay.evaluate((rules) => {
    type Recorded = { surface: 'overlay'; message: string; detail?: string; buttons: string[]; severity: string; answered?: string; at: number };
    const w = window as unknown as { __e2eDialogs?: Recorded[]; __e2eDialogRules?: Record<string, string>; __e2eDialogObserver?: MutationObserver };
    w.__e2eDialogRules = rules;
    if (w.__e2eDialogObserver) return;
    w.__e2eDialogs = [];
    const visit = (dialog: HTMLElement): void => {
      if (dialog.dataset.e2eSeen !== undefined || dialog.closest('[inert]')) return;
      dialog.dataset.e2eSeen = '';
      const seenRules = w.__e2eDialogRules ?? {};
      // Answered once drawn, as a user would: a click in the task that renders it closes it before the page reports it shown.
      requestAnimationFrame(() => {
        // main withdrew it before it was drawn
        if (!dialog.isConnected || dialog.closest('[inert]')) return;
        const message = dialog.querySelector('h2')?.textContent?.trim() ?? '';
        const detail = dialog.querySelector('p')?.textContent?.trim();
        const buttons = [...dialog.querySelectorAll('button')];
        const rule = Object.entries(seenRules).find(([needle]) => message.includes(needle) || (detail ?? '').includes(needle));
        const button = rule ? buttons.find((candidate) => candidate.textContent?.trim() === rule[1]) : undefined;
        w.__e2eDialogs!.push({
          surface: 'overlay',
          message,
          ...(detail ? { detail } : {}),
          buttons: buttons.map((candidate) => candidate.textContent?.trim() ?? ''),
          severity: dialog.dataset.severity ?? '',
          ...(button ? { answered: rule![1] } : {}),
          at: Date.now(),
        });
        button?.click();
      });
    };
    w.__e2eDialogObserver = new MutationObserver(() => {
      for (const dialog of document.querySelectorAll<HTMLElement>('[role="alertdialog"]')) visit(dialog);
    });
    w.__e2eDialogObserver.observe(document.body, { childList: true, subtree: true });
  }, answers);
}

const NATIVE_SEVERITY: Readonly<Record<string, string>> = { info: 'info', warning: 'warning', error: 'danger' };

/** Every question the recorders saw, on either surface, in the order they showed. */
export async function askedDialogs(app: ElectronApplication): Promise<RecordedDialog[]> {
  const overlay = await readyOverlay(app);
  const drawn = await overlay.evaluate(() => (window as unknown as { __e2eDialogs?: RecordedDialog[] }).__e2eDialogs ?? []);
  const boxes = (await messageBoxes(app)).map((box): RecordedDialog => ({
    surface: 'os',
    message: box.message,
    ...(box.detail !== undefined ? { detail: box.detail } : {}),
    buttons: box.buttons ?? [],
    severity: NATIVE_SEVERITY[box.type ?? ''] ?? '',
    ...(box.answered !== undefined ? { answered: box.answered } : {}),
    at: box.at,
  }));
  return [...drawn, ...boxes].sort((a, b) => a.at - b.at);
}

/** Answers the next showOpenDialog with `dir`. */
export async function answerOpenDialog(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [d] })) as typeof dialog.showOpenDialog;
  }, dir);
}

/** Answers the next showSaveDialog with `file`, and records the defaultPath it was asked with. */
export async function answerSaveDialog(app: ElectronApplication, file: string): Promise<void> {
  await app.evaluate(({ dialog }, answer) => {
    const g = globalThis as unknown as { __e2eSaveDefaults?: string[] };
    g.__e2eSaveDefaults ??= [];
    dialog.showSaveDialog = ((...args: unknown[]) => {
      const options = args.at(-1) as Electron.SaveDialogOptions;
      g.__e2eSaveDefaults!.push(options.defaultPath ?? '');
      return Promise.resolve({ canceled: false, filePath: answer });
    }) as typeof dialog.showSaveDialog;
  }, file);
}

/** The defaultPath of every Save dialog answerSaveDialog answered. */
export async function saveDialogDefaults(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { __e2eSaveDefaults?: string[] }).__e2eSaveDefaults ?? []);
}

interface HostPromptGlobals {
  __damoclesE2e: {
    dialogs: { inputBox(opts: { prompt: string; password: boolean }): Promise<string | undefined> };
    secrets: { store(key: string, value: string): Promise<void> };
  };
  __e2eHostPrompt?: Promise<string | undefined>;
}

/**
 * Asks for a masked value through main's DialogService.inputBox, as a host key prompt does, and with `storeAs` stores the
 * answer under that secret key in the app's secret store, as a key prompt's handler does; needs DAMOCLES_E2E_HOOKS=1.
 */
export async function askHostPassword(app: ElectronApplication, prompt: string, storeAs?: string): Promise<void> {
  await app.evaluate((_electron, [title, secretKey]) => {
    const { dialogs, secrets } = (globalThis as unknown as HostPromptGlobals).__damoclesE2e;
    (globalThis as unknown as HostPromptGlobals).__e2eHostPrompt = dialogs.inputBox({ prompt: title, password: true }).then(async (answer) => {
      if (answer !== undefined && secretKey !== undefined) await secrets.store(secretKey, answer);
      return answer;
    });
  }, [prompt, storeAs] as const);
}

/** The answer to the last askHostPassword, once the prompt has settled and any store has finished; undefined when it was dismissed. */
export function hostPromptAnswer(app: ElectronApplication): Promise<string | undefined> {
  return app.evaluate(() => (globalThis as unknown as HostPromptGlobals).__e2eHostPrompt);
}

/** Clicks an application menu item by id, as a user choosing it would. */
export async function clickMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu, BrowserWindow }, [itemId, shellUrl]) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`no menu item ${itemId}`);
    const win = BrowserWindow.getAllWindows().find((each) => each.webContents.getURL().startsWith(shellUrl));
    item.click(undefined, win, undefined as never);
  }, [id, SHELL_URL] as const);
}

/** An application menu item as main has it now, or undefined when the menu has none of that id. */
export function menuItemState(app: ElectronApplication, id: string): Promise<{ accelerator: string | null; enabled: boolean; visible: boolean } | undefined> {
  return app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    return item ? { accelerator: item.accelerator ?? null, enabled: item.enabled, visible: item.visible } : undefined;
  }, id);
}

/**
 * Adds a project through the menu, answering the folder picker and the trust question wherever main asks it, and returns once
 * main has selected the new chat it opens in the project, which it does only after the question is answered.
 */
export async function addProject(app: ElectronApplication, dir: string, trust: boolean): Promise<void> {
  await answerOpenDialog(app, dir);
  await answerDialogs(app, { [TRUST_PROMPT]: trust ? 'Trust Folder' : "Don't Trust" });
  // The launch's chat, which main selects once core is ready: an empty one in the default folder counts as the first project's
  // until main unloads it, so the new chat is told apart from it only once it is selected.
  let before: string | undefined;
  await expect.poll(async () => (before = (await shellState(app)).selected.chatId), { timeout: 30_000 }).toBeDefined();
  await clickMenu(app, 'damocles.addProject');
  await expect.poll(async () => {
    const state = await shellState(app);
    const project = state.projects.find((candidate) => candidate.fsPath === dir);
    return project !== undefined && state.selected.projectKey === project.key && state.selected.chatId !== undefined && state.selected.chatId !== before;
  }, { timeout: 30_000 }).toBe(true);
}

/** Sends `text` from the tab and waits for the stub's echo of it to render. */
/**
 * Waits until a trusted card takes an answer: it has been shown for its hold and Chromium reports it whole and uncovered
 * (`useTrustedVisibility`). `card` is the element the check observes: a dock prompt's region, a shell banner, the plan
 * overlay's footer. A key pressed before this is swallowed, so every key that answers a card waits here first; a click on
 * a card's control waits by itself, because a held card's controls are aria-disabled and Playwright clicks only an
 * enabled one. Where the dock is taller than the chat pane the page scrolls, and a click Playwright retries scrolls it
 * (each retry aligns the control another way), which cuts the card off and holds it: there a click waits here first too.
 * Chromium reports a cover frames after it shows, so a card answered after something covered it waits to be held
 * (`data-trusted-ready` false) before the cover goes, then here.
 */
export async function promptReady(card: Locator): Promise<void> {
  await expect(card).toHaveAttribute('data-trusted-ready', 'true');
}

/** Clicks `answer`, a control of a trusted card, once its card takes an answer: for a card that can be taller than the chat pane. */
export async function clickAnswer(answer: Locator): Promise<void> {
  await promptReady(answer.locator('xpath=ancestor::*[@data-trusted-ready][1]'));
  await answer.click();
}

/**
 * Waits until the chat's turn has ended. A reply shows while it streams, and pi saves it to the session file only at its
 * message_end, before core lowers the spinner; with an empty composer the send button reads Stop until then.
 */
export async function awaitTurnEnd(tab: Page): Promise<void> {
  await expect(tab.getByTestId('composer-send')).toHaveAttribute('aria-label', 'Send (Enter)');
}

export async function sendAndAwaitEcho(tab: Page, text: string): Promise<void> {
  await chatInput(tab).fill(text);
  await chatInput(tab).press('Enter');
  await tab.getByText(`Echo: ${text}`, { exact: true }).waitFor();
  await awaitTurnEnd(tab);
}

/** Posts a webview message through the tab's own bridge, exactly as a webview control does. */
export async function postFromWebview(tab: Page, message: Record<string, unknown>): Promise<void> {
  await tab.evaluate((m) => {
    if (!window.damoclesBridge) throw new Error('no damoclesBridge in this page');
    window.damoclesBridge.postMessage(m);
  }, message);
}

type HostMessage = { type?: string } & Record<string, unknown>;

/** Starts recording every host message the tab receives, through a second bridge listener. */
export async function recordHostMessages(tab: Page): Promise<void> {
  await tab.evaluate(() => {
    const w = window as unknown as { __e2eHost?: unknown[] };
    if (w.__e2eHost) return;
    w.__e2eHost = [];
    window.damoclesBridge!.onMessage((m) => w.__e2eHost!.push(m));
  });
}

export async function hostMessages(tab: Page, type: string): Promise<HostMessage[]> {
  return tab.evaluate((t) => ((window as unknown as { __e2eHost?: HostMessage[] }).__e2eHost ?? []).filter((m) => m.type === t), type);
}

/**
 * The ids of the first page of stored sessions the host lists for the tab, from the reply to this call's own request.
 * Desktop shows them in the sidebar's Chats list, not in the chat (HostCapabilities.historyInPanel false), so this asks
 * the host as the VS Code history dropdown does.
 */
export async function listedSessionIds(tab: Page): Promise<string[]> {
  await recordHostMessages(tab);
  const before = (await hostMessages(tab, 'storedSessions')).length;
  await postFromWebview(tab, { type: 'requestMoreSessions', offset: 0 });
  await tab.waitForFunction(
    (count) => ((window as unknown as { __e2eHost?: HostMessage[] }).__e2eHost ?? []).filter((m) => m.type === 'storedSessions').length > count,
    before,
  );
  const lists = await hostMessages(tab, 'storedSessions');
  const sessions = (lists.at(-1)?.['sessions'] ?? []) as { id: string }[];
  return sessions.map((session) => session.id);
}

/** Elements of a page reaching past its sides outside a clipping or scrolling box, and a page that scrolls sideways. */
export async function pageOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) found.push(`page scrolls sideways (${root.scrollWidth} > ${root.clientWidth})`);
    for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1 || (rect.left >= -0.5 && rect.right <= root.clientWidth + 0.5)) continue;
      let clipped = false;
      for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
        if (getComputedStyle(up).overflowX !== 'visible') clipped = true;
      }
      if (!clipped) found.push(`${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 4).join('.')} spans ${Math.round(rect.left)}..${Math.round(rect.right)} of ${root.clientWidth}`);
    }
    return found;
  });
}

/**
 * Each element inside a chat column that reaches past the column's sides, and the header and page when they scroll
 * sideways. An element inside its own clipping or scrolling box, and a 1px visually hidden label, do not count.
 */
export async function horizontalOverflow(tab: Page): Promise<string[]> {
  return tab.evaluate(() => {
    const found: string[] = [];
    const name = (el: Element): string => `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}.${[...el.classList].slice(0, 4).join('.')}`;
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) found.push(`page scrolls sideways (${root.scrollWidth} > ${root.clientWidth})`);
    const header = document.querySelector('[data-testid="chat-header"]');
    if (header && header.scrollWidth > header.clientWidth) found.push(`header scrolls sideways (${header.scrollWidth} > ${header.clientWidth})`);
    for (const column of document.querySelectorAll<HTMLElement>('.chat-column')) {
      if (column.getClientRects().length === 0) continue;
      const box = column.getBoundingClientRect();
      for (const el of column.querySelectorAll<HTMLElement>('*')) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) continue;
        if (rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5) continue;
        let clipped = false;
        for (let up = el.parentElement; up && up !== column; up = up.parentElement) {
          if (getComputedStyle(up).overflowX !== 'visible') clipped = true;
        }
        if (!clipped) found.push(`${name(el)} spans ${Math.round(rect.left)}..${Math.round(rect.right)} in a column of ${Math.round(box.left)}..${Math.round(box.right)}`);
      }
    }
    return found;
  });
}
