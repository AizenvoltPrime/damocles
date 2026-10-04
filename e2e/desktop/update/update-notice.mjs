// Where the packaged app shows its update notice. drive-update.mjs reads these pages over CDP in the release workflow;
// update-notice.spec.ts runs the same lookup against the dev app, so a move fails the local suite first.

// The window's own page; closing it closes the window.
export const SHELL_URL = 'app://damocles/shell/index.html';
// Notices and their actions render in the overlay view, above every other view.
export const OVERLAY_URL = 'app://damocles/overlay/index.html';

// The notice's English actions, as src/desktop/main/updater.ts offers them (Windows and Linux, then macOS).
export const RESTART_ACTION = 'Restart Now';
export const RELEASE_PAGE_ACTION = 'Open Release Page';

/**
 * The button that answers the notice with `label`.
 * @param {import('playwright-core').Page} overlay
 * @param {string} label
 */
export function noticeAction(overlay, label) {
  return overlay.getByRole('button', { name: label, exact: true });
}
