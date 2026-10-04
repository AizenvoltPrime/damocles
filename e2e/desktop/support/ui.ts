import type { ElectronApplication, Locator, Page } from '@playwright/test';

// Leading text of the desktop trust prompt (src/desktop/main/trust-store.ts).
export const TRUST_PROMPT = 'Do you trust the authors of the files in';

export const CHAT_PLACEHOLDER = 'Ask Damocles anything…';

export function chatInput(tab: Page): Locator {
  return tab.getByPlaceholder(CHAT_PLACEHOLDER);
}

export async function setThemeSource(app: ElectronApplication, source: 'dark' | 'light' | 'system'): Promise<void> {
  await app.evaluate(({ nativeTheme }, s) => {
    nativeTheme.themeSource = s;
  }, source);
}

export interface RecordedBox {
  message: string;
  detail?: string;
  buttons?: string[];
  // shown as a modal of the app window rather than a free-standing box
  parented: boolean;
}

/**
 * Replaces dialog.showMessageBox in main with a recorder that answers with `response` (button index),
 * or with the button whose label matches `answers[message substring]`. Returns nothing; read with `messageBoxes`.
 */
export async function answerMessageBoxes(app: ElectronApplication, answers: Record<string, string> = {}): Promise<void> {
  await app.evaluate(({ dialog }, rules) => {
    const g = globalThis as unknown as { __e2eBoxes?: { message: string; detail?: string; buttons?: string[]; parented: boolean }[] };
    g.__e2eBoxes = g.__e2eBoxes ?? [];
    const box = (...args: unknown[]): Promise<{ response: number; checkboxChecked: boolean }> => {
      const opts = (args.length > 1 ? args[1] : args[0]) as { message: string; detail?: string; buttons?: string[]; cancelId?: number };
      g.__e2eBoxes!.push({ message: opts.message, ...(opts.detail ? { detail: opts.detail } : {}), ...(opts.buttons ? { buttons: opts.buttons } : {}), parented: args.length > 1 });
      const rule = Object.entries(rules).find(([needle]) => opts.message.includes(needle) || (opts.detail ?? '').includes(needle));
      const index = rule ? (opts.buttons ?? []).indexOf(rule[1]) : -1;
      return Promise.resolve({ response: index >= 0 ? index : (opts.cancelId ?? (opts.buttons?.length ? opts.buttons.length - 1 : 0)), checkboxChecked: false });
    };
    dialog.showMessageBox = box as typeof dialog.showMessageBox;
  }, answers);
}

export async function messageBoxes(app: ElectronApplication): Promise<RecordedBox[]> {
  return app.evaluate(() => (globalThis as unknown as { __e2eBoxes?: RecordedBox[] }).__e2eBoxes ?? []);
}

/** Answers the next showOpenDialog with `dir`. */
export async function answerOpenDialog(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [d] })) as typeof dialog.showOpenDialog;
  }, dir);
}

/** Clicks an application menu item by id, as a user choosing it would. */
export async function clickMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu, BrowserWindow }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`no menu item ${itemId}`);
    const win = BrowserWindow.getAllWindows()[0];
    item.click(undefined, win, undefined as never);
  }, id);
}

/** Adds a project through the menu, answering the folder picker and the trust prompt. */
export async function addProject(app: ElectronApplication, dir: string, trust: boolean): Promise<void> {
  await answerOpenDialog(app, dir);
  await answerMessageBoxes(app, { [TRUST_PROMPT]: trust ? 'Trust Folder' : "Don't Trust" });
  await clickMenu(app, 'damocles.addProject');
}

/** Sends `text` from the tab and waits for the stub's echo of it to render. */
export async function sendAndAwaitEcho(tab: Page, text: string): Promise<void> {
  await chatInput(tab).fill(text);
  await chatInput(tab).press('Enter');
  await tab.getByText(`Echo: ${text}`, { exact: true }).waitFor();
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
