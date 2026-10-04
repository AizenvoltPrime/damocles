import { HOST_THEME_STYLE_ID } from '../../shared/host-theme';
import type { PanelTheme } from './panel-channels';

/** Brings a page up to main's theme: the host theme style, the vscode-dark/vscode-light body class and data-reduced-motion. */
export function applyHostTheme(theme: PanelTheme): void {
  const style = document.getElementById(HOST_THEME_STYLE_ID);
  if (style) style.textContent = theme.css;
  document.documentElement.toggleAttribute('data-reduced-motion', theme.reducedMotion);
  document.body.classList.remove('vscode-dark', 'vscode-light');
  document.body.classList.add(`vscode-${theme.kind}`);
  document.body.dataset['vscodeThemeKind'] = `vscode-${theme.kind}`;
}
