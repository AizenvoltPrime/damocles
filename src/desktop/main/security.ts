import type { Session, WebContents } from 'electron';
import { webUrlHref } from '../../core/web-url';
import { APP_ORIGIN } from './protocol';

export function isHttpUrl(url: string): boolean {
  return webUrlHref(url) !== undefined;
}

// Renderer-controlled text in a log line: quoted so CR/LF cannot forge lines, and bounded.
export function loggableUrl(url: string): string {
  return JSON.stringify(url.slice(0, 500));
}

export function isAppUrl(url: string): boolean {
  return url.startsWith(`${APP_ORIGIN}/`);
}

// The page URL main itself loaded into each WebContents; renderer-initiated navigation may only reload it.
const loadedPages = new WeakMap<WebContents, string>();

export function loadAppPage(contents: WebContents, url: string): Promise<void> {
  loadedPages.set(contents, url);
  return contents.loadURL(url);
}

// The WebContents of registered panel views, the only ones that may hold a permission.
const panelContents = new WeakSet<WebContents>();

export function registerPanelContents(contents: WebContents): void {
  panelContents.add(contents);
}

function isAppOrigin(urlOrOrigin: string): boolean {
  return urlOrOrigin === APP_ORIGIN || urlOrOrigin.startsWith(`${APP_ORIGIN}/`);
}

export interface PermissionQuery {
  readonly contents: WebContents | null;
  readonly permission: string;
  // the requesting URL or origin
  readonly requester: string;
  readonly isMainFrame: boolean;
}

// The one exception to deny-all: the chat's copy buttons use navigator.clipboard.writeText, which Chromium gates behind clipboard-sanitized-write.
export function isPermissionAllowed(query: PermissionQuery): boolean {
  return query.permission === 'clipboard-sanitized-write'
    && query.contents !== null
    && panelContents.has(query.contents)
    && query.isMainFrame
    && isAppOrigin(query.requester);
}

// Everything else is denied, media included: voice captures audio in the Python sidecar.
export function restrictPermissions(session: Session): void {
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(isPermissionAllowed({ contents, permission, requester: details.requestingUrl, isMainFrame: details.isMainFrame }));
  });
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => (
    isPermissionAllowed({ contents, permission, requester: requestingOrigin, isMainFrame: details.isMainFrame })
  ));
  session.setDevicePermissionHandler(() => false);
}

// Applied to every WebContents the app creates: no popups, no <webview>, no navigation or redirect away from the page main loaded; web links open in the OS browser.
export function hardenWebContents(contents: WebContents, openExternal: (url: string) => Promise<boolean>, log: (line: string) => void): void {
  const openOutside = (url: string): void => {
    openExternal(url).catch((err: unknown) => log(`[security] could not open ${loggableUrl(url)}: ${err instanceof Error ? err.message : String(err)}`));
  };
  contents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) openOutside(url);
    else log(`[security] denied window.open to ${loggableUrl(url)}`);
    return { action: 'deny' };
  });
  const lockNavigation = (event: { readonly url: string; preventDefault(): void }): void => {
    const { url } = event;
    // contents.getURL() already reports the pending URL here, so it cannot be the reference.
    if (isAppUrl(url) && url === loadedPages.get(contents)) return;
    event.preventDefault();
    if (isHttpUrl(url)) openOutside(url);
    else log(`[security] blocked navigation to ${loggableUrl(url)}`);
  };
  contents.on('will-navigate', lockNavigation);
  contents.on('will-redirect', lockNavigation);
  contents.on('will-attach-webview', (event) => event.preventDefault());
}
