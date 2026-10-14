import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { quickPick } from './editor';
import { git, initRepo, type GitHome } from './git';
import { menuItem, overlayMenu, readyOverlay } from './overlay';
import { openProjectChat } from './screenshots';
import { overlayPage, shellPage } from './shell';
import { clickSectionAction } from './shell-ui';

// main's source control hooks (DAMOCLES_E2E_HOOKS=1, unpackaged only)
type ScmHooks = { __damoclesE2e: { scm: { gitLog(): Promise<string>; autofetchNow(): void; ledgerPath(): string } } };
/** The Git log as main wrote it; a command's line is written once git exits. */
export const gitLog = (app: ElectronApplication): Promise<string> => app.evaluate(() => (globalThis as unknown as ScmHooks).__damoclesE2e.scm.gitLog());
/** One autofetch round of the selected project now, as if the period had elapsed. */
export const autofetchNow = (app: ElectronApplication): Promise<void> => app.evaluate(() => (globalThis as unknown as ScmHooks).__damoclesE2e.scm.autofetchNow());
export const ledgerPath = (app: ElectronApplication): Promise<string> => app.evaluate(() => (globalThis as unknown as ScmHooks).__damoclesE2e.scm.ledgerPath());

export const scmSection = (shell: Page): Locator => shell.getByTestId('scm-section');
export const commitMessage = (shell: Page): Locator => scmSection(shell).getByTestId('scm-commit-message');
export const quickInput = (scope: Page | Locator): Locator => scope.getByTestId('quick-input');
export const quickInputField = (scope: Page | Locator): Locator => scope.getByTestId('quick-input-field');
export const submenuItem = (overlay: Page, itemId: string): Locator => overlay.locator(`[data-submenu-item][data-item-id="${itemId}"]`);
/** The open quick pick's item labelled exactly `label`; main's item ids are indices. */
export const pickItem = (overlay: Page, label: string): Locator =>
  quickPick(overlay).getByTestId('quick-pick-item').filter({ has: overlay.getByText(label, { exact: true }) });

/** Writes `text` at the forward-slash `relativePath` under `root`, creating its folders. */
export function write(root: string, relativePath: string, text: string): void {
  const file = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A bare repository `<root>/<name>.git` cloned from `source`. */
export async function bareClone(h: GitHome, source: string, root: string, name: string): Promise<string> {
  fs.mkdirSync(root, { recursive: true });
  const bare = path.join(root, `${name}.git`);
  await git(h, root, 'clone', '--quiet', '--bare', source, bare);
  return bare;
}

/** A bare repository `<root>/<name>.git` holding one commit of `files`. */
export async function bareRepo(h: GitHome, root: string, name: string, files: Record<string, string> = { 'a.ts': 'export const a = 1;\n' }): Promise<string> {
  const seed = path.join(h.root, `seed-${name}`);
  await initRepo(h, seed, files);
  return bareClone(h, seed, root, name);
}

/** Expands or collapses the sidebar section `testId` through its header. */
export async function setSection(shell: Page, testId: string, open: boolean): Promise<void> {
  const toggle = shell.getByTestId(testId).locator('h2 button');
  if ((await toggle.getAttribute('aria-expanded')) !== String(open)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', String(open));
}

/** Adds `dir` as a trusted project, expands Source control and waits until it shows the repository. */
export async function openScmProject(app: ElectronApplication, dir: string): Promise<Page> {
  await openProjectChat(app, dir);
  const shell = await shellPage(app);
  await setSection(shell, 'scm-section', true);
  await expect(commitMessage(shell)).toBeVisible({ timeout: 30_000 });
  return shell;
}

/** Chooses `label` in Source control's repository picker. */
export async function selectRepo(shell: Page, overlay: Page, label: string): Promise<void> {
  await shell.getByTestId('scm-repo-picker').click();
  await expect(overlayMenu(overlay)).toBeVisible();
  await overlayMenu(overlay).locator('[role^="menuitem"]').filter({ hasText: label }).first().click();
  await expect(overlayMenu(overlay)).toHaveCount(0);
  await expect(shell.getByTestId('scm-repo-name')).toHaveText(label);
}

/** More Actions: a top-level item, or `submenu` then its item. Hovers the section, so its caller holds the foreground. */
export async function moreActions(app: ElectronApplication, shell: Page, itemId: string, submenu?: string): Promise<void> {
  const overlay = await readyOverlay(app);
  // a menu answered a moment ago may still be playing its exit
  await expect(overlayMenu(overlay)).toHaveCount(0);
  await clickSectionAction(shell, 'scm-more-actions');
  await expect(overlayMenu(overlay)).toBeVisible();
  if (submenu === undefined) await menuItem(overlay, itemId).click();
  else {
    await menuItem(overlay, `submenu:${submenu}`).click();
    await submenuItem(overlay, itemId).click();
  }
  await expect(overlayMenu(overlay)).toHaveCount(0);
}

/**
 * Types `value` into the open quick input and presses Enter; resolves the field's type once that request's box has left.
 * A flow that asks again (a tag's message, a password after a username) opens its next box at once, while this one may still
 * be playing its exit, so the box is told apart by main's request id.
 */
export async function answerInput(app: ElectronApplication, value: string): Promise<string | null> {
  const overlay = await overlayPage(app);
  await expect(quickInput(overlay)).toBeVisible();
  const request = await overlay.locator('[data-overlay-id]').filter({ has: quickInput(overlay) }).getAttribute('data-overlay-id');
  const box = overlay.locator(`[data-overlay-id="${request}"]`);
  const type = await quickInputField(box).getAttribute('type');
  await quickInputField(box).fill(value);
  await quickInputField(box).press('Enter');
  await expect(box).toHaveCount(0);
  return type;
}
