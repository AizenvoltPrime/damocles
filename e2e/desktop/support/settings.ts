import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { SettingsSectionId } from '../../../src/shared/settings-sections';
import { overlayPage, shellPage } from './shell';

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

/** Sets the window's content area, the size every view lays out in. */
export async function setContentSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(w!, h!);
  }, [width, height] as const);
}

/** The modal's footer, "Edit settings.json": it closes the modal and opens `scope` in the selected chat's JSON editor. */
export async function editSettingsFile(app: ElectronApplication, scope: 'user' | 'project' | 'local'): Promise<void> {
  const overlay = await openSettingsModal(app);
  await overlay.getByTestId('settings-footer').click();
  await overlay.getByTestId(`settings-edit-json-${scope}`).click();
  await expect(settingsModal(overlay)).toHaveCount(0);
}
