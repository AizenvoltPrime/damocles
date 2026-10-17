import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat, expect, nextChat } from './fixtures';
import { seedStubModel, writeUserSettings, type HermeticHome } from './hermetic';
import { startOpenAIStub, type OpenAIStub, type StubReply } from './openai-stub';
import { menuItem, readyOverlay } from './overlay';
import { submenuItem } from './scm';
import { shellPage, shellState } from './shell';
import { clickSectionAction } from './shell-ui';
import { chatInput } from './ui';
import { registryRecords, type RegistryRecord } from './worktree-repo';

// What the worktree chat specs (slice 12a) share: the New menu, the opt-in, the stub model, the registry's live records.

// Waits for a `release` file in the project folder, then records the worktree's index: setup that holds the first prompt
// until the test lets it finish (D32). It exits once its shell is gone or after 5 minutes, so a kill that never reaches it
// leaves no process holding a folder in the hermetic root. Quoted to run the same in PowerShell and in a POSIX shell.
export const HELD_SETUP = `node -e "const fs=require('fs');const p=require('path');const s=Date.now();const t=setInterval(()=>{if(fs.existsSync(p.join(process.env.DAMOCLES_PROJECT_FOLDER,'release'))){clearInterval(t);fs.writeFileSync('setup-ran.txt',String(process.env.DAMOCLES_WORKTREE_INDEX))}else if(Date.now()-s>300000){process.exit(1)}else{try{process.kill(process.ppid,0)}catch{process.exit(1)}}},100)"`;
export const QUICK_SETUP = `node -e "require('fs').writeFileSync('setup-ran.txt',String(process.env.DAMOCLES_WORKTREE_INDEX))"`;

export const newMenu = (overlay: Page): Locator => overlay.getByTestId('new-chat-menu');
export const setupReview = (overlay: Page): Locator => overlay.locator('[data-dialog="setupReview"] [data-testid="worktree-dialog"]');
export const chatRow = (shell: Page, title: string): Locator => shell.locator('[data-testid="chat-list"] [role="option"]', { hasText: title });
export const chatRows = (shell: Page): Locator => shell.locator('[data-testid="chat-list"] [role="option"]');
// Source control's header shows the same chip, so the Files one is named by its section.
export const filesChip = (shell: Page): Locator => shell.getByTestId('files-section').getByTestId('files-branch-chip');
// The Files chip's start (its icon and slug): the section's title actions lie over its tail while they show.
export const CHIP_START = { x: 12, y: 9 };
export const edit = (file: string, from: string, to: string): StubReply => ({ chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: from, new_string: to } }] });
// Chat: New Chat in This Worktree's key on this platform (VS Code's per-OS pattern).
export const NEW_IN_WORKTREE_KEYS: Array<'control' | 'shift' | 'alt' | 'meta'> = process.platform === 'darwin' ? ['meta', 'alt'] : process.platform === 'linux' ? ['control', 'alt'] : ['shift', 'alt'];

export async function openNewMenu(app: ElectronApplication): Promise<Page> {
  const shell = await shellPage(app);
  await clickSectionAction(shell, 'new-chat-options');
  const overlay = await readyOverlay(app);
  await expect(newMenu(overlay)).toBeVisible();
  return overlay;
}

export async function closeNewMenu(overlay: Page): Promise<void> {
  await overlay.keyboard.press('Escape');
  await expect(newMenu(overlay)).toHaveCount(0);
}

/** Opts a new chat in through the menu, from `start` (a full refname) or the current branch, and returns its page. */
export async function optIn(app: ElectronApplication, options: { start?: string; bring?: boolean } = {}): Promise<Page> {
  const known = [await activeChat(app)];
  const overlay = await openNewMenu(app);
  await overlay.getByTestId('new-chat-menu-worktree').click();
  await expect(overlay.getByTestId('new-chat-menu-options')).toBeVisible();
  if (options.start) {
    await overlay.getByTestId('new-chat-menu-start').click();
    await overlay.locator(`[data-testid="new-chat-menu-branch"][data-ref="${options.start}"]`).click();
  }
  if (options.bring === false) await overlay.getByTestId('new-chat-menu-bring').click();
  await overlay.getByTestId('new-chat-menu-create').click();
  await expect(newMenu(overlay)).toHaveCount(0);
  const tab = await nextChat(app, known);
  await expect(tab.getByTestId('worktree-chip')).toBeVisible();
  return tab;
}

/** Opens a chat row's context menu and its Worktree submenu; returns the overlay page. */
export async function openRowWorktreeMenu(app: ElectronApplication, row: Locator): Promise<Page> {
  await row.click({ button: 'right' });
  const overlay = await readyOverlay(app);
  await menuItem(overlay, 'submenu:worktree').click();
  await expect(submenuItem(overlay, 'newChatInWorktree').or(submenuItem(overlay, 'worktree:delete')).first()).toBeVisible();
  return overlay;
}

export async function send(tab: Page, text: string): Promise<void> {
  await chatInput(tab).fill(text);
  await chatInput(tab).press('Enter');
}

export const liveRecords = (h: HermeticHome): RegistryRecord[] => registryRecords(h).filter((record) => record.kind === 'chat' && record.deletedAt === undefined);

export async function withStub(h: HermeticHome, settings: Record<string, unknown>, run: (stub: OpenAIStub) => Promise<void>): Promise<void> {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(h, stub.baseUrl);
    writeUserSettings(h, settings);
    await run(stub);
  } finally {
    await stub.close();
  }
}

export async function shownFolder(app: ElectronApplication) {
  const state = await shellState(app);
  return state.shownFolders[state.selected.projectKey!];
}
