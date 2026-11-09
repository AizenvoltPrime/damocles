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

// net::ERR_ABORTED: another navigation replaced the one that failed, and that one loads instead.
const ERR_ABORTED = -3;

/** A did-fail-load that leaves the main frame without its page; Electron emits did-finish-load after it too (electron/electron#5128). */
export function mainFrameLoadFailed(errorCode: number, isMainFrame: boolean): boolean {
  return isMainFrame && errorCode !== ERR_ABORTED;
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

// The WebContents locked to one origin: design preview views (D81) and HTML preview views. opensLink: an HTML preview's
// check that a click or activation key main observed in the view is spent on this popup, or bound to this main-frame
// navigation; a design view, which has none, opens nothing outside.
export type OpensLink = (url: string, kind: 'navigate' | 'popup') => boolean;
interface LockedContents {
  readonly origin: string;
  readonly opensLink?: OpensLink;
}
const lockedContents = new WeakMap<WebContents, LockedContents>();

// Called right after the view is constructed, before its first load; hardenWebContents reads it at each event.
export function registerLockedContents(contents: WebContents, origin: string, opensLink?: OpensLink): void {
  lockedContents.set(contents, opensLink ? { origin, opensLink } : { origin });
}

// A page's script can try to navigate away in a loop, so each locked view logs only its first blocked navigation.
const lockedNavigationLogged = new WeakSet<WebContents>();

/** A URL's origin, spelled from its scheme and host in lower case, since Node's URL reports 'null' for a scheme it does not know. */
export function originOf(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return parsed.host === '' ? undefined : `${parsed.protocol}//${parsed.host}`.toLowerCase();
}

// Applied to every WebContents the app creates: no popups, no <webview>, no navigation or redirect away from the page main
// loaded; web links open in the OS browser. A locked view navigates only within its origin: a design view (PD-7) opens
// nothing outside, an HTML preview opens a main-frame http(s) navigation or popup outside only when the user clicked it.
export function hardenWebContents(contents: WebContents, openExternal: (url: string) => Promise<boolean>, log: (line: string) => void): void {
  const openOutside = (url: string): void => {
    openExternal(url).catch((err: unknown) => log(`[security] could not open ${loggableUrl(url)}: ${err instanceof Error ? err.message : String(err)}`));
  };
  contents.setWindowOpenHandler(({ url }) => {
    const locked = lockedContents.get(contents);
    if (locked) {
      if (locked.opensLink && isHttpUrl(url) && locked.opensLink(url, 'popup')) openOutside(url);
      else log(`[security] denied a locked view's window.open to ${loggableUrl(url)}`);
    } else if (isHttpUrl(url)) openOutside(url);
    else log(`[security] denied window.open to ${loggableUrl(url)}`);
    return { action: 'deny' };
  });
  // navigate: will-navigate, which Electron fires for the main frame only; will-redirect fires for subframes too, and a
  // redirect never opens anything outside
  const lockNavigation = (event: { readonly url: string; preventDefault(): void }, mainFrame: boolean, navigate: boolean): void => {
    const { url } = event;
    const locked = lockedContents.get(contents);
    if (locked !== undefined) {
      // an HTML preview's iframes load the web; its partition refuses every other scheme and another root's token
      if (!mainFrame && locked.opensLink) return;
      if (originOf(url) === locked.origin) return;
      event.preventDefault();
      if (navigate && locked.opensLink && isHttpUrl(url) && locked.opensLink(url, 'navigate')) {
        openOutside(url);
        return;
      }
      if (lockedNavigationLogged.has(contents)) return;
      lockedNavigationLogged.add(contents);
      log(`[security] blocked a locked view's navigation to ${loggableUrl(url)}; this view's further ones are not logged`);
      return;
    }
    // contents.getURL() already reports the pending URL here, so it cannot be the reference.
    if (isAppUrl(url) && url === loadedPages.get(contents)) return;
    event.preventDefault();
    if (isHttpUrl(url)) openOutside(url);
    else log(`[security] blocked navigation to ${loggableUrl(url)}`);
  };
  contents.on('will-navigate', (event) => lockNavigation(event, true, true));
  contents.on('will-redirect', (event) => lockNavigation(event, event.isMainFrame, false));
  contents.on('will-attach-webview', (event) => event.preventDefault());
}
