import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { overlayPage } from '../../desktop/support/shell';
import { clickMenu } from '../../desktop/support/ui';
import { expect } from './remote';

// The Connect dialog, its timeline, the host key dialogs and the folder browser, as a user reaches them (en locale).

export const CONNECT_TO_HOST_MENU = 'damocles.remote.connectToHost';
export const STEP_LABELS = { connecting: 'Connecting', authenticating: 'Authenticating', checking: 'Checking server', installing: 'Installing', starting: 'Starting' } as const;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const connectDialog = (overlay: Page): Locator => overlay.getByRole('dialog', { name: 'Connect to host' });
export const hostSearch = (overlay: Page): Locator => connectDialog(overlay).getByRole('textbox', { name: 'Search hosts or enter a new one' });
/** A host card: its accessible name starts with the host's name, then its address and state. */
export const hostCard = (overlay: Page, name: string): Locator => connectDialog(overlay).getByRole('button', { name: new RegExp(`^${escapeRegExp(name)}\\b`) });
export const timeline = (overlay: Page, host: string): Locator => overlay.getByRole('progressbar', { name: `Connecting to ${host}` });
export const stepRow = (overlay: Page, step: keyof typeof STEP_LABELS): Locator => overlay.locator(`li[data-step="${step}"]`);
export const failureAlert = (overlay: Page): Locator => overlay.locator('li[data-state="failed"]').getByRole('alert');
export const folderBrowser = (overlay: Page, host: string): Locator => overlay.getByRole('dialog', { name: `Open a folder on ${host}` });
/** The folder browser a core's file or folder picker opens, in that mode. */
export const pickBrowser = (overlay: Page, mode: 'file' | 'folder'): Locator => overlay.locator(`[data-testid="connect-dialog"][data-pick-mode="${mode}"]`);
export const browserEntry = (browser: Locator, name: string): Locator => browser.getByTestId('folder-list').getByRole('option', { name, exact: true });
export const firstConnection = (overlay: Page, host: string): Locator => overlay.getByRole('alertdialog', { name: `First connection to ${host}` });
export const changedKey = (overlay: Page, host: string): Locator => overlay.getByRole('alertdialog', { name: `${host}'s host key has changed` });
/** The trust question main asks for a folder of a host, which stacks over the Connect dialog when its pick added the project. */
export const trustQuestion = (overlay: Page, folder: string, host: string): Locator => overlay.getByRole('alertdialog', { name: `Do you trust the authors of the files in ${folder} on ${host}?` });

/** Opens the Connect dialog from File > Connect to Host... and resolves with the overlay page once it shows. */
export async function openConnect(app: ElectronApplication): Promise<Page> {
  const overlay = await overlayPage(app);
  await clickMenu(app, CONNECT_TO_HOST_MENU);
  await expect(connectDialog(overlay)).toBeVisible();
  return overlay;
}

/**
 * Records, in the overlay page, every value the timeline's progressbar announces (aria-valuetext), so a test can assert the
 * steps and the download progress however fast they pass. Read with `announcedSteps`.
 */
export async function recordTimeline(overlay: Page): Promise<void> {
  await overlay.evaluate(() => {
    const w = window as unknown as { __e2eTimeline?: string[]; __e2eTimelineObserver?: MutationObserver };
    w.__e2eTimeline = [];
    w.__e2eTimelineObserver?.disconnect();
    const seen = (): void => {
      for (const bar of document.querySelectorAll('[role="progressbar"]')) {
        const text = bar.getAttribute('aria-valuetext');
        if (text !== null && w.__e2eTimeline!.at(-1) !== text) w.__e2eTimeline!.push(text);
      }
    };
    w.__e2eTimelineObserver = new MutationObserver(seen);
    w.__e2eTimelineObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-valuetext'] });
    seen();
  });
}

export const announcedSteps = (overlay: Page): Promise<string[]> => overlay.evaluate(() => (window as unknown as { __e2eTimeline?: string[] }).__e2eTimeline ?? []);

/** The download percentages the timeline announced while Installing ("Installing, 42%"). */
export const installPercents = (announced: readonly string[]): number[] =>
  announced.map((text) => /^Installing, (\d+)%$/.exec(text)?.[1]).filter((n): n is string => n !== undefined).map(Number);

/** The step labels the timeline announced, each once, in the order they first showed; "Connected" and failures are not steps. */
export const stepOrder = (announced: readonly string[]): string[] => {
  const labels: readonly string[] = Object.values(STEP_LABELS);
  return [...new Set(announced.map((text) => text.split(',')[0]!.trim()).filter((label) => labels.includes(label)))];
};

/**
 * Walks the folder browser from the root to `folder` (absolute, POSIX) by entering each folder, and resolves with the browser.
 */
export async function browseTo(overlay: Page, host: string, folder: string): Promise<Locator> {
  const browser = folderBrowser(overlay, host);
  await expect(browser).toBeVisible();
  await browser.getByRole('navigation', { name: 'Path' }).getByRole('button').first().click();
  const folders = browser.getByRole('listbox', { name: 'Folders' });
  for (const part of folder.split('/').filter(Boolean)) {
    await folders.getByRole('option', { name: part, exact: true }).dblclick();
    await expect(browser.getByRole('navigation', { name: 'Path' }).getByRole('button').last()).toHaveAccessibleName(part);
  }
  return browser;
}

/** Walks the folder browser to `folder` (absolute, POSIX) and opens it. */
export async function openInBrowser(overlay: Page, host: string, folder: string): Promise<void> {
  const browser = await browseTo(overlay, host, folder);
  await browser.getByRole('button', { name: 'Open', exact: true }).click();
  await connectDialogClosed(overlay);
}

/** Waits until the Connect dialog left the page, which it does once main added the picked project. */
export async function connectDialogClosed(overlay: Page): Promise<void> {
  // a question asked above it only hides it from the accessibility tree, so a role query would pass while main still adds
  await expect(overlay.getByTestId('connect-dialog')).toHaveCount(0);
}
