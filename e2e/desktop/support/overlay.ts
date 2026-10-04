import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { OVERLAY_URL, overlayPage } from './shell';

/** The overlay page with its preload ready. */
export async function readyOverlay(app: ElectronApplication): Promise<Page> {
  const overlay = await overlayPage(app);
  await overlay.waitForFunction(() => window.damoclesOverlay !== undefined);
  return overlay;
}

export const overlayMenu = (overlay: Page): Locator => overlay.getByTestId('overlay-menu');
export const menuItem = (overlay: Page, itemId: string): Locator => overlay.locator(`[data-menu-item][data-item-id="${itemId}"]`);
export const confirmDialog = (overlay: Page): Locator => overlay.getByRole('alertdialog');
export const tagPicker = (overlay: Page): Locator => overlay.getByTestId('overlay-tag-picker');
export const overlayToasts = (overlay: Page): Locator => overlay.getByTestId('overlay-toast');

/** The item id the overlay page has keyboard focus on, if any. */
export async function focusedMenuItem(overlay: Page): Promise<string | null> {
  return overlay.evaluate(() => document.activeElement?.getAttribute('data-item-id') ?? null);
}

/** Main's overlay view: its stacking position among the window's views, visibility, bounds and whether it has focus. */
export async function overlayViewState(app: ElectronApplication): Promise<{ topmost: boolean; visible: boolean; bounds: Electron.Rectangle; content: Electron.Rectangle; focused: boolean }> {
  return app.evaluate(({ BrowserWindow }, url) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const children = win.contentView.children as Electron.WebContentsView[];
    const overlay = children.find((view) => view.webContents?.getURL() === url);
    if (!overlay) throw new Error('no overlay view');
    const [width, height] = win.getContentSize();
    return {
      topmost: children.at(-1) === overlay,
      visible: overlay.getVisible(),
      bounds: overlay.getBounds(),
      content: { x: 0, y: 0, width: width!, height: height! },
      focused: overlay.webContents.isFocused(),
    };
  }, OVERLAY_URL);
}

/** Chooses a menu item in the open overlay menu with the mouse. */
export async function chooseMenuItem(app: ElectronApplication, itemId: string): Promise<void> {
  const overlay = await readyOverlay(app);
  await expect(overlayMenu(overlay)).toBeVisible();
  await menuItem(overlay, itemId).click();
}

/** Answers the open confirm dialog. */
export async function answerConfirm(app: ElectronApplication, confirm: boolean): Promise<void> {
  const overlay = await readyOverlay(app);
  const dialog = confirmDialog(overlay);
  await expect(dialog).toBeVisible();
  await dialog.getByTestId(confirm ? 'overlay-confirm-accept' : 'overlay-confirm-cancel').click();
}

/** Types a tag into the open tag picker and saves it. */
export async function answerTagPicker(app: ElectronApplication, tag: string): Promise<void> {
  const overlay = await readyOverlay(app);
  const input = tagPicker(overlay).getByTestId('overlay-tag-input');
  await expect(input).toBeVisible();
  await input.fill(tag);
  await input.press('Enter');
}
