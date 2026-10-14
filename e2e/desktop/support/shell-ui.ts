import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { ShellChat, ShellChatList } from '../../../src/desktop/preload/shell-channels';
import { selectedProjectKey, shellPage, shellState } from './shell';

/** Labels of every application menu item, depth first, with the item's id where it has one. */
export async function menuLabels(app: ElectronApplication): Promise<{ id: string; label: string }[]> {
  return app.evaluate(({ Menu }) => {
    const out: { id: string; label: string }[] = [];
    const walk = (items: Electron.MenuItem[]): void => {
      for (const item of items) {
        out.push({ id: item.id ?? '', label: item.label });
        if (item.submenu) walk(item.submenu.items);
      }
    };
    walk(Menu.getApplicationMenu()?.items ?? []);
    return out;
  });
}

/** The shell page with its preload ready. */
export async function readyShell(app: ElectronApplication): Promise<Page> {
  const shell = await shellPage(app);
  await shell.waitForFunction(() => window.damoclesShell !== undefined);
  return shell;
}

/** The selected project's chats as main lists them (newest first), with each chat's status and loaded flag. */
export async function listChats(app: ElectronApplication, projectKey?: string): Promise<ShellChatList> {
  const key = projectKey ?? (await selectedProjectKey(app));
  const shell = await readyShell(app);
  const list = await shell.evaluate(async (k) => window.damoclesShell!.listChats(k, (await window.damoclesShell!.getState()).revision), key);
  if (!list) throw new Error(`the project ${key} left the project list`);
  return list;
}

export async function chatEntry(app: ElectronApplication, chatId: string): Promise<ShellChat | undefined> {
  return (await listChats(app)).chats.find((chat) => chat.id === chatId);
}

export async function projectKeyOf(app: ElectronApplication, name: string): Promise<string> {
  const project = (await shellState(app)).projects.find((p) => p.name === name);
  if (!project) throw new Error(`no project ${name}`);
  return project.key;
}

/** A CSS attribute-selector string; project keys are paths, whose backslashes would otherwise read as escapes. */
export const cssString = (value: string): string => `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

export const titleBar = (shell: Page): Locator => shell.getByTestId('title-bar');
export const sidebar = (shell: Page): Locator => shell.getByTestId('sidebar');
export const projectsList = (shell: Page): Locator => shell.getByTestId('sidebar-projects').getByRole('listbox');
export const projectRow = (shell: Page, key: string): Locator => shell.locator(`[role="option"][data-project-key=${cssString(key)}]`);
export const chatList = (shell: Page): Locator => shell.getByTestId('chat-list');
export const chatRow = (shell: Page, chatId: string): Locator => shell.locator(`[role="option"][data-chat-id=${cssString(chatId)}]`);
export const chatRows = (shell: Page): Locator => chatList(shell).getByRole('option');

/** The sidebar section that holds `inner`. */
export const sidebarSectionOf = (shell: Page, inner: Locator): Locator => shell.locator('section[data-section]').filter({ has: inner });

/**
 * A sidebar section's title action, shown as a user shows it: VS Code's rule hides the actions until the section is hovered
 * or holds focus, so this hovers the section's header first. The pointer stays there only while this worker holds the
 * OS foreground, so a test calling this takes the `foreground` fixture.
 */
export async function sectionAction(shell: Page, testId: string): Promise<Locator> {
  const action = shell.getByTestId(testId);
  const section = sidebarSectionOf(shell, action);
  await section.getByTestId('sidebar-section-header').hover();
  await expect(action).toBeVisible();
  // the reveal's short entering transform moves the action, so callers measure and click it settled; a cancelled reveal rejects
  await section.getByTestId('sidebar-section-actions').evaluate((actions) => Promise.all(actions.getAnimations({ subtree: true })
    .filter((animation) => animation instanceof CSSAnimation && animation.animationName === 'd-actions-in')
    .map((animation) => animation.finished.catch(() => undefined))));
  return action;
}

/** Clicks a sidebar section's title action after hovering its section. */
export async function clickSectionAction(shell: Page, testId: string): Promise<void> {
  await (await sectionAction(shell, testId)).click();
}

/** Clicks a chat's row as a user does; main may refuse, so callers read the selection afterwards. */
export async function clickChat(shell: Page, chatId: string): Promise<void> {
  await chatRow(shell, chatId).click();
}

/** Hovers a chat row and clicks one of its row actions (rename, tag or delete). */
export async function clickRowAction(shell: Page, chatId: string, action: 'rename' | 'tag' | 'delete'): Promise<void> {
  const row = chatRow(shell, chatId);
  await row.hover();
  await row.getByTestId(`chat-action-${action}`).click();
}

/** Renames a chat through the row's inline editor. */
export async function renameInline(shell: Page, chatId: string, name: string): Promise<void> {
  await clickRowAction(shell, chatId, 'rename');
  const input = shell.getByTestId('chat-rename').getByRole('textbox');
  await input.fill(name);
  await input.press('Enter');
}
