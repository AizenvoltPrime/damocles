// The chat and error pages' HTML. Desktop main builds every page with them (showPage); core builds the VS Code host's page
// with them through setHtml.
import { HOST_THEME_STYLE_ID } from './host-theme';

/** The page a panel shows; main builds it, so no HTML a core produced is ever loaded. */
export type PageSpec = { readonly kind: 'chat' } | { readonly kind: 'error' } | { readonly kind: 'browser'; readonly toolbar: boolean };

export interface ChatPageParts {
  readonly cspSource: string;
  // undefined omits worker-src (the VS Code hosts never set it, so their CSP is unchanged)
  readonly workerSrc?: string;
  readonly nonce: string;
  readonly scriptUri: string;
  readonly styleUri: string;
  readonly logoUri: string;
  // CSS that fills the --d-* design tokens; '' where tokens.css maps the host's own theme variables
  readonly themeCss: string;
}

export interface ErrorPageStrings {
  readonly title: string;
  readonly detail: string;
}

export const ERROR_PAGE_STRINGS: ErrorPageStrings = {
  title: 'Session failed to restore',
  detail: 'Close this tab and open a new Damocles panel.',
};

export interface ErrorPageParts {
  readonly cspSource: string;
  readonly logoUri: string;
  readonly themeCss: string;
  readonly strings: ErrorPageStrings;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Every value goes into an attribute escaped, whoever built it.
export function chatPageHtml(parts: ChatPageParts): string {
  const cspSource = escapeHtml(parts.cspSource);
  const nonce = escapeHtml(parts.nonce);
  // style-src allows 'unsafe-inline', so the element needs no nonce.
  const themeStyle = parts.themeCss === '' ? '' : `\n  <style id="${HOST_THEME_STYLE_ID}">${parts.themeCss}</style>`;
  const workerSrc = parts.workerSrc === undefined ? '' : ` worker-src ${escapeHtml(parts.workerSrc)};`;

  // CSP: `script-src` stays nonce-locked (no inline/remote script — no RCE). `img-src ... https:` is
  // a deliberate widening so WebFetch can render inline images from extracted web pages. The tradeoff
  // is that any rendered markdown can load remote https images (a tracking/IP-leak vector); this is the
  // standard posture for chat webviews that render web content, and the web tools are opt-in.
  // form-action does not fall back to default-src, so it is named; every form in the webview handles submit in script.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; font-src ${cspSource}; img-src ${cspSource} data: https:; form-action 'none';${workerSrc}">
  <link href="${escapeHtml(parts.styleUri)}" rel="stylesheet">${themeStyle}
  <title>Damocles</title>
</head>
<body>
  <div id="app" data-logo-uri="${escapeHtml(parts.logoUri)}"></div>
  <script nonce="${nonce}" type="module" src="${escapeHtml(parts.scriptUri)}"></script>
</body>
</html>`;
}

// Reads the desktop design tokens from the host theme style first and VS Code's theme variables otherwise.
export function errorPageHtml(parts: ErrorPageParts): string {
  const themeStyle = parts.themeCss === '' ? '' : `
  <style id="${HOST_THEME_STYLE_ID}">${parts.themeCss}</style>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${escapeHtml(parts.cspSource)};">
  <title>Damocles</title>
  <style>
    body { display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: var(--d-bg, var(--vscode-editor-background)); color: var(--d-text, var(--vscode-foreground)); font-family: var(--d-font, var(--vscode-font-family, system-ui, sans-serif)); }
    .error-container { text-align: center; max-width: 360px; }
    img { width: 48px; height: 48px; opacity: 0.5; margin-bottom: 16px; }
    h2 { font-size: 14px; font-weight: 600; margin: 0 0 8px; }
    p { font-size: 12px; opacity: 0.7; margin: 0; }
  </style>${themeStyle}
</head>
<body>
  <div class="error-container">
    <img src="${escapeHtml(parts.logoUri)}" alt="">
    <h2>${escapeHtml(parts.strings.title)}</h2>
    <p>${escapeHtml(parts.strings.detail)}</p>
  </div>
</body>
</html>`;
}
