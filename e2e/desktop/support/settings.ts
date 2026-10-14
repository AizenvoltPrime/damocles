import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { SettingsSectionId } from '../../../src/shared/settings-sections';
import { writeUserSettings, type HermeticHome } from './hermetic';
import { readyOverlay } from './overlay';
import { OVERLAY_URL, overlayPage, shellPage } from './shell';

export const settingsModal = (overlay: Page): Locator => overlay.getByTestId('settings-modal');
export const settingsRow = (overlay: Page, id: string): Locator => overlay.getByTestId(`settings-row-${id}`);
export const settingsNav = (overlay: Page, section: SettingsSectionId): Locator => overlay.getByTestId(`settings-nav-${section}`);

/**
 * Opens the desktop settings modal from the title-bar gear, as a user does, and returns the overlay page that draws it.
 * With `section`, the nav then opens that section.
 */
export async function openSettingsModal(app: ElectronApplication, section?: SettingsSectionId): Promise<Page> {
  const shell = await shellPage(app);
  await shell.getByTestId('open-settings').click();
  const overlay = await overlayPage(app);
  await expect(settingsModal(overlay)).toBeVisible();
  if (section) {
    await settingsNav(overlay, section).click();
    await expect(settingsNav(overlay, section)).toHaveAttribute('aria-selected', 'true');
  }
  return overlay;
}

/**
 * Waits on the Accounts page until core has answered the modal's state request. The modal starts from reset stores whose
 * defaults look like real answers; core posts the Memory judge status after the settings and every account but OpenRouter,
 * and only that post fills the TypeSafe row's judge line. Leaves the row collapsed.
 */
export async function waitForSettingsState(overlay: Page): Promise<void> {
  const toggle = settingsRow(overlay, 'account-typesafe').getByRole('button', { name: /Add key|Replace key/ });
  await toggle.click();
  await expect(overlay.getByTestId('memory-judge')).toBeVisible();
  await toggle.click();
  await expect(overlay.getByTestId('memory-judge')).toHaveCount(0);
}

/** Closes the modal with its close button and waits until the exit has played and the modal is gone. */
export async function closeSettingsModal(overlay: Page): Promise<void> {
  await overlay.getByRole('button', { name: 'Close (Esc)' }).first().click();
  await expect(settingsModal(overlay)).toHaveCount(0);
}

/** Chooses `option` in a segmented control inside `row`. */
export async function chooseSegment(row: Locator, option: string): Promise<void> {
  await row.getByRole('button', { name: option, exact: true }).click();
  await expect(row.getByRole('button', { name: option, exact: true })).toHaveAttribute('aria-pressed', 'true');
}

/** Main's value of the damocles.desktop.* setting `key`, as its settings service reads it now. */
export async function desktopSetting(app: ElectronApplication, key: string): Promise<unknown> {
  const overlay = await readyOverlay(app);
  return overlay.evaluate(async (name) => (await window.damoclesOverlay!.getPrefs()).values[name], key);
}

/** Merges `values` (damocles.desktop.* keys) into the user settings file and resolves once main reads each of them. */
export async function applyUserSettings(app: ElectronApplication, h: HermeticHome, values: Record<string, unknown>): Promise<void> {
  writeUserSettings(h, values);
  for (const [key, value] of Object.entries(values)) await expect.poll(() => desktopSetting(app, key), key).toEqual(value);
}

/**
 * Sets the window's content area, the size every view lays out in, and resolves once the shell page and a shown overlay
 * lay out at the size the window took: setContentSize returns before any renderer has it, and the OS may clamp it.
 */
export async function setContentSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(w!, h!);
  }, [width, height] as const);
  await expect.poll(() => app.evaluate(async ({ BrowserWindow }, overlayUrl) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const [contentWidth, contentHeight] = win.getContentSize() as [number, number];
    // Both fill the content area; a hidden overlay keeps the bounds it last had.
    const overlay = (win.contentView.children as Electron.WebContentsView[]).find((view) => view.webContents?.getURL() === overlayUrl && view.getVisible());
    const pages = [win.webContents, ...(overlay ? [overlay.webContents] : [])];
    const behind = await Promise.all(pages.map(async (contents) => {
      const zoom = contents.getZoomFactor();
      const [innerWidth, innerHeight] = await contents.executeJavaScript('[innerWidth, innerHeight]') as [number, number];
      const laidOut = Math.abs(innerWidth - contentWidth / zoom) < 1 && Math.abs(innerHeight - contentHeight / zoom) < 1;
      return laidOut ? [] : [`${contents.getURL()} lays out at ${innerWidth}x${innerHeight} (zoom ${zoom}), the window is ${contentWidth}x${contentHeight}`];
    }));
    return behind.flat();
  }, OVERLAY_URL)).toEqual([]);
}

/** The modal's footer, "Edit settings.json": it closes the modal and opens `scope` in the selected chat's JSON editor. */
export async function editSettingsFile(app: ElectronApplication, scope: 'user' | 'project' | 'local'): Promise<void> {
  const overlay = await openSettingsModal(app);
  await overlay.getByTestId('settings-footer').click();
  await overlay.getByTestId(`settings-edit-json-${scope}`).click();
  await expect(settingsModal(overlay)).toHaveCount(0);
}
