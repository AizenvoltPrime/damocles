// The theme renderer's page, window and session: the built theme-render entry under a fresh script nonce, with Damocles' own
// font faces and nothing of the user's, in a hidden offscreen sandboxed window with no preload and no bridge, in a session of
// its own.
import { randomBytes } from 'node:crypto';
import { BrowserWindow, session as electronSession, type NativeImage, type Session } from 'electron';
import { THEME_RENDER_SIZE } from '../../../shared/themes/agent';
import { APP_ORIGIN, handleThemeRenderProtocol, type ThemeRenderPages } from '../protocol';
import { loadAppPage, restrictPermissions } from '../security';
import { freshFrames } from './offscreen-frame';
import type { RenderPage } from './theme-renderer';

// No `persist:` prefix, so nothing the page caches outlives the run.
export const THEME_RENDER_PARTITION = 'theme-render';

/**
 * Builds the theme renderer's session: the app scheme answered by its own handler, which alone serves a blob still under
 * analysis, no permission and no download. Call once per process, after `ready` and before the first page opens.
 */
export function createThemeRenderSession(resourceRoot: string, pages: ThemeRenderPages): Session {
  const session = electronSession.fromPartition(THEME_RENDER_PARTITION);
  handleThemeRenderProtocol(session.protocol, resourceRoot, pages);
  restrictPermissions(session);
  session.on('will-download', (event) => event.preventDefault());
  return session;
}

/** The page's CSP: scripts only by nonce, images and fonts only from app:// and the job's data URLs, and no media: a video is decoded from fed bytes. */
export function themeRenderCsp(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${APP_ORIGIN} 'unsafe-inline'; img-src ${APP_ORIGIN} data: blob:; font-src ${APP_ORIGIN}; base-uri 'none'; form-action 'none';`;
}

export function themeRenderHtml(fontFaceCss: string): string {
  const nonce = randomBytes(16).toString('base64');
  const assets = `${APP_ORIGIN}/desktop-shell/assets`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${themeRenderCsp(nonce)}">
  <link href="${assets}/theme-render.css" rel="stylesheet">
  <style>${fontFaceCss.replace(/</g, '\\3c ')}</style>
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
  const destroy = (): void => {
    if (!window.isDestroyed()) window.destroy();
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
    capture: async (width, height) => new Uint8Array((await frames.fresh(width, height)).toPNG()),
    close: destroy,
  };
}
