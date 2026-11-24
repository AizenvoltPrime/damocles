import { HOST_THEME_STYLE_ID, HOST_THEME_USER_STYLE_ID, HOST_TRUSTED_STYLE_ID } from '../../shared/host-theme';
import type { PanelTheme } from './panel-channels';

/**
 * Brings a page up to main's theme: the host theme style, the trusted palette's style right after it, the theme's
 * sanitized CSS after that, the vscode-dark/vscode-light body class, data-reduced-motion, data-file-icon-theme and
 * data-theme-revision. The page paints the change in its next frame: data-theme-switching holds every transition off for
 * the one style flush that takes the new values, so no color fades from the old theme and a capture shows the new one.
 */
export function applyHostTheme(theme: PanelTheme): void {
  const root = document.documentElement;
  root.toggleAttribute('data-theme-switching', true);
  const style = document.getElementById(HOST_THEME_STYLE_ID);
  if (style) style.textContent = theme.css;
  let trusted = document.getElementById(HOST_TRUSTED_STYLE_ID);
  if (!trusted && style) {
    trusted = document.createElement('style');
    trusted.id = HOST_TRUSTED_STYLE_ID;
    style.after(trusted);
  }
  if (trusted) trusted.textContent = theme.trustedCss;
  applyUserCss(theme.customCss, trusted ?? style);
  document.documentElement.toggleAttribute('data-reduced-motion', theme.reducedMotion);
  document.documentElement.dataset['fileIconTheme'] = theme.fileIconTheme;
  if (theme.revision !== undefined) document.documentElement.dataset['themeRevision'] = String(theme.revision);
  document.body.classList.remove('vscode-dark', 'vscode-light');
  document.body.classList.add(`vscode-${theme.kind}`);
  document.body.dataset['vscodeThemeKind'] = `vscode-${theme.kind}`;
  // reading a layout value computes the page's styles now, while transitions are off; the attribute must go only after it
  void document.body.offsetHeight;
  root.removeAttribute('data-theme-switching');
}

// textContent only: the CSS is the sanitizer's output, and it must never be parsed as markup.
function applyUserCss(css: string | undefined, anchor: HTMLElement | null): void {
  let user = document.getElementById(HOST_THEME_USER_STYLE_ID);
  if (css === undefined) {
    if (user) user.textContent = '';
    return;
  }
  if (!user) {
    user = document.createElement('style');
    user.id = HOST_THEME_USER_STYLE_ID;
    if (anchor) anchor.after(user);
    else document.head.append(user);
  }
  user.textContent = css;
}
