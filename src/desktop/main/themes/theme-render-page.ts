// The theme renderer's page, window and session: the built theme-render entry under a fresh nonce, whose page writes a window
// job's appearance into its style elements, in a hidden offscreen sandboxed window with no preload and no bridge, in a session
// of its own.
import { randomBytes } from 'node:crypto';
import { BrowserWindow, session as electronSession, type NativeImage, type Session } from 'electron';
import { THEME_RENDER_SIZE } from '../../../shared/themes/agent';
import { HOST_THEME_STYLE_ID, HOST_THEME_USER_STYLE_ID, HOST_TRUSTED_STYLE_ID } from '../../../shared/host-theme';
import { APP_ORIGIN, handleThemeRenderProtocol, type ThemeRenderPages } from '../protocol';
import { loadAppPage, restrictPermissions } from '../security';
import { freshFrames } from './offscreen-frame';
import { THEME_RENDER_PARTITION } from '../../preload/page-paths';
import type { RenderPage } from './theme-renderer';

/**
 * Builds the theme renderer's session: the app scheme answered by its own handler, which alone serves a blob still under
 * analysis, no permission, no download, and every request cancelled but the app origin's and the page's own data and blob URLs.
 * Call once per process, after `ready` and before the first page opens.
 */
export function createThemeRenderSession(resourceRoot: string, pages: ThemeRenderPages): Session {
  const session = electronSession.fromPartition(THEME_RENDER_PARTITION);
  handleThemeRenderProtocol(session.protocol, resourceRoot, pages);
  restrictPermissions(session);
  session.on('will-download', (event) => event.preventDefault());
  // a compromised renderer does not honour the page's CSP, so the session itself lets nothing reach the network
  session.webRequest.onBeforeRequest((details, answer) => answer({ cancel: !details.url.startsWith(`${APP_ORIGIN}/`) && !/^(data|blob):/.test(details.url) }));
  return session;
}

/**
 * The page's CSP: scripts only by nonce, style elements only by nonce or from app://, images and fonts only from app:// and the
 * job's data URLs, and no media: a video is decoded from fed bytes. Style attributes stay allowed: highlighted code carries them.
 */
export function themeRenderCsp(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src-elem ${APP_ORIGIN} 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src ${APP_ORIGIN} data: blob:; font-src ${APP_ORIGIN}; base-uri 'none'; form-action 'none';`;
}

/** The page under a fresh nonce: the host theme, trusted and user style elements stand empty after the stylesheet, for the job's appearance. */
export function themeRenderHtml(): string {
  const nonce = randomBytes(16).toString('base64');
  const assets = `${APP_ORIGIN}/desktop-shell/assets`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${themeRenderCsp(nonce)}">
  <link href="${assets}/theme-render.css" rel="stylesheet">
  <style id="${HOST_THEME_STYLE_ID}" nonce="${nonce}"></style>
  <style id="${HOST_TRUSTED_STYLE_ID}" nonce="${nonce}"></style>
  <style id="${HOST_THEME_USER_STYLE_ID}" nonce="${nonce}"></style>
  <title>Damocles theme render</title>
</head>
<body>
  <script nonce="${nonce}" type="module" src="${assets}/theme-render.js"></script>
</body>
</html>`;
}

/**
 * The page of the renderer process at `url`, at device scale 1; `gone` hears its renderer end or its window close. The window
 * is this function's: it is destroyed when its page does not load and when its renderer ends, since a hidden window left
 * open keeps the app from quitting.
 */
export async function openThemeRenderPage(url: string, gone: (reason: string) => void): Promise<RenderPage> {
  const window = new BrowserWindow({
    show: false,
    width: THEME_RENDER_SIZE.width,
    height: THEME_RENDER_SIZE.height,
    useContentSize: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      partition: THEME_RENDER_PARTITION,
      offscreen: { deviceScaleFactor: 1 },
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      javascript: true,
      disableDialogs: true,
      devTools: false,
      spellcheck: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      backgroundThrottling: false,
    },
  });
  const contents = window.webContents;
  // WebRTC's sockets bypass CSP; the page needs none
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  // Closing the page closes the window after it, skipping beforeunload. window.destroy() would leave the WebContents a task
  // without its window, and Electron's WebContents.isFocused(), which every menu command calls on all of them, crashes main then.
  const destroy = (): void => {
    if (!contents.isDestroyed()) contents.close();
  };
  contents.on('render-process-gone', (_event, details) => {
    gone(details.reason);
    destroy();
  });
  // until the page loaded, the caller hears a failure as this call's rejection, which says why
  let loaded = false;
  window.on('closed', () => {
    if (loaded) gone('closed');
  });
  const frames = freshFrames<NativeImage>(contents, (width, height) => window.setContentSize(width, height), THEME_RENDER_SIZE);
  try {
    await loadAppPage(contents, url);
  } catch (err) {
    destroy();
    throw err;
  }
  loaded = true;
  return {
    render: (json) => contents.executeJavaScript(`window.damoclesRender(${JSON.stringify(json)})`, true) as Promise<unknown>,
    feed: async (chunk) => {
      await contents.executeJavaScript(`window.damoclesFeed(${JSON.stringify(chunk)})`, true);
    },
    progress: () => contents.executeJavaScript('window.damoclesProgress?.() ?? 0', true) as Promise<unknown>,
    resize: async (width, height) => {
      frames.resize(width, height);
    },
    // a frame from 'paint', Electron's documented offscreen output: capturePage here rejects with UnknownVizError under software compositing
    capture: async (width, height, crop) => {
      const frame = await frames.fresh(width, height);
      return new Uint8Array((crop ? frame.crop(crop) : frame).toPNG());
    },
    // settles on the page's destroyed event: until then it shares the session with whatever job runs next
    close: () => new Promise<void>((resolve) => {
      if (contents.isDestroyed()) {
        resolve();
        return;
      }
      contents.once('destroyed', () => resolve());
      contents.close();
    }),
  };
}
