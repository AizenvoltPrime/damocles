// Where the packaged app shows its update notice, title-bar pill and Settings › About. drive-update.mjs reads these pages
// over CDP in the release workflow; update-notice.spec.ts and about.spec.ts run the same lookups against the dev app, so a
// move fails the local suite first.

// The window's own page; closing it closes the window.
export const SHELL_URL = 'app://damocles/shell/index.html';
// Notices and their actions render in the desktop popup window's page, which main opens with the first popup.
export const NOTIFIER_URL = 'app://damocles/notifier/index.html';
// Menus, dialogs and the settings modal render in the overlay view's page.
export const OVERLAY_URL = 'app://damocles/overlay/index.html';

// The notice's English actions, as src/desktop/main/updater.ts offers them (Windows and Linux, then macOS).
export const RESTART_ACTION = 'Restart Now';
export const RELEASE_PAGE_ACTION = 'Open Release Page';

// The pill's English labels; its data-state is the update state's kind.
export const PILL_READY = 'Restart to update';
export const PILL_AVAILABLE = 'Update available';

/**
 * The button that answers the notice with `label`.
 * @param {import('playwright-core').Page} popup
 * @param {string} label
 */
export function noticeAction(popup, label) {
  return popup.getByRole('button', { name: label, exact: true });
}

/**
 * The title-bar update pill, present only while an update is downloading, ready or (macOS) available.
 * @param {import('playwright-core').Page} shell
 */
export function updatePill(shell) {
  return shell.getByTestId('update-pill');
}

/**
 * Settings › About's update status chip; its data-state is the update state's kind.
 * @param {import('playwright-core').Page} overlay
 */
export function aboutUpdateStatus(overlay) {
  return overlay.getByTestId('about-update-status');
}

/**
 * Settings › About's Restart button, shown while an update is ready.
 * @param {import('playwright-core').Page} overlay
 */
export function aboutRestart(overlay) {
  return overlay.getByTestId('about-restart');
}
