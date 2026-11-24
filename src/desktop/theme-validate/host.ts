// The theme validator's Electron main process, which dist/theme-validate.js starts under the checkout's own Electron. It runs
// the renderer jobs exactly as the app does: main's ThemeRenderer, its sandboxed offscreen render window and page in their own
// session, whose app:// handler serves the shell build's theme-render assets and the theme's blobs from a work folder.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { app, BrowserWindow, session } from 'electron';
import { englishText, LocalizedError } from '../../shared/localized-text';
import { spriteIsAnimated, spriteStrip } from '../../shared/themes/characters';
import type { AssetMeta } from '../../shared/themes/schema';
import { THUMB_QUALITY, type WallpaperKind } from '../../shared/themes/wallpapers';
import { MAX_ARCHIVE_BYTES, readCappedFile } from '../../core/themes/archive';
import { registerAppScheme, THEME_RENDER_PAGE_URL } from '../main/protocol';
import { hardenWebContents } from '../main/security';
import { openThemeBlob, readThemeBlob } from '../main/themes/theme-blobs';
import { createThemeRenderSession, openThemeRenderPage, themeRenderHtml } from '../main/themes/theme-render-page';
import { ThemeRenderer } from '../main/themes/theme-renderer';
import { STORE_THUMB_WIDTH, validateStoreTheme, type RenderJobs, type Verdict } from './validate';

const USAGE = 'usage: node dist/theme-validate.js <file.damocles-theme> --thumbs <dir>';
// a thumbnail is one small image drawn once
const STORE_THUMB_TIMEOUT_MS = 30_000;
// dist/theme-validate/host.js in a Damocles checkout, whose dist/desktop-shell the app:// handler serves
const CHECKOUT_ROOT = path.join(__dirname, '..', '..');

class UsageError extends Error {}

interface Args {
  readonly file: string;
  readonly thumbs: string;
  // the launcher's own folder: blobs/ for the theme's assets, user-data/ for Electron's
  readonly work: string;
}

function parse(argv: readonly string[]): Args {
  try {
    const { positionals, values } = parseArgs({ args: [...argv], allowPositionals: true, options: { thumbs: { type: 'string' }, work: { type: 'string' } } });
    if (positionals.length !== 1 || values.thumbs === undefined) throw new Error('expected one theme file and --thumbs <dir>');
    if (values.work === undefined) throw new Error('run it through dist/theme-validate.js');
    return { file: path.resolve(positionals[0]!), thumbs: path.resolve(values.thumbs), work: path.resolve(values.work) };
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

/** The renderer's 480 px thumbnail drawn again at the store's width, as WebP, in a sandboxed page of its own. */
async function storeThumb(thumb: Uint8Array): Promise<Uint8Array> {
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, devTools: false, spellcheck: false } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the thumbnail took longer than ${STORE_THUMB_TIMEOUT_MS / 1000} s to draw`)), STORE_THUMB_TIMEOUT_MS);
  });
  try {
    await Promise.race([window.webContents.loadURL('about:blank'), late]);
    const source = `data:image/webp;base64,${Buffer.from(thumb).toString('base64')}`;
    const dataUrl: unknown = await Promise.race([late, window.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = ${JSON.stringify(source)};
      await image.decode();
      const scale = Math.min(1, ${STORE_THUMB_WIDTH} / image.naturalWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/webp', ${THUMB_QUALITY});
    })()`, true)]);
    const prefix = 'data:image/webp;base64,';
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) throw new Error('the thumbnail did not encode as WebP');
    return new Uint8Array(Buffer.from(dataUrl.slice(prefix.length), 'base64'));
  } finally {
    clearTimeout(timer);
    window.destroy();
  }
}

const sized = (asset: AssetMeta): { readonly width: number; readonly height: number } => {
  if (asset.width === undefined || asset.height === undefined) throw new Error('it names no size');
  return { width: asset.width, height: asset.height };
};

/** Main's theme renderer over the work folder's blobs, with the arguments core passes it for an import. */
function renderJobs(renderer: ThemeRenderer, blobsDir: string): RenderJobs {
  const store = async (sha256: string, bytes: Uint8Array): Promise<void> => fs.writeFile(path.join(blobsDir, sha256), bytes);
  return {
    async analyze(sha256, asset, bytes) {
      await store(sha256, bytes);
      const result = await renderer.analyze(sha256, asset.mime, sized(asset), asset.kind as WallpaperKind, asset.durationMs);
      const flash = result.flash;
      return { flagged: flash?.flagged ?? false, ...(flash?.atMs !== undefined ? { atMs: flash.atMs } : {}), thumb: await storeThumb(result.thumb) };
    },
    async sprite(sha256, asset, bytes) {
      await store(sha256, bytes);
      const strip = spriteStrip(asset);
      const { flash } = await renderer.analyzeSprite(sha256, { mime: asset.mime, ...sized(asset), ...(strip ? { strip } : {}), animated: spriteIsAnimated(asset) });
      return { flagged: flash.flagged, ...(flash.atMs !== undefined ? { atMs: flash.atMs } : {}) };
    },
  };
}

async function run({ file, thumbs, work }: Args): Promise<number> {
  let bytes: Uint8Array;
  try {
    bytes = await readCappedFile(file, MAX_ARCHIVE_BYTES);
  } catch (err) {
    if (!(err instanceof LocalizedError)) throw err;
    // a file past the archive cap is refused unread, so its verdict has its size and no sha256
    const refused: Verdict = { ok: false, bytes: (await fs.stat(file)).size, errors: [englishText(err.text)] };
    await write(process.stdout, `${JSON.stringify(refused, null, 2)}\n`);
    return 1;
  }
  const root = path.join(work, 'themes');
  const blobsDir = path.join(root, 'blobs');
  await fs.mkdir(blobsDir, { recursive: true });
  const renderer: ThemeRenderer = new ThemeRenderer({
    openPage: (gone) => openThemeRenderPage(THEME_RENDER_PAGE_URL, gone),
    readBlob: async (sha256, mime, kind) => (await readThemeBlob(root, sha256, () => ({ kind, mime })))?.bytes,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  // as main's render session, which lets nothing reach the network: only the blob the running job decodes; no window job runs here, so no still frame is served
  createThemeRenderSession(CHECKOUT_ROOT, {
    themeBlob: (sha256) => openThemeBlob(root, sha256, (sha) => renderer.currentJobBlob(sha)),
    themeCache: async () => undefined,
    themeRender: () => themeRenderHtml(),
  });
  try {
    const verdict = await validateStoreTheme(bytes, file, async () => renderJobs(renderer, blobsDir), async (name, thumb) => {
      await fs.mkdir(thumbs, { recursive: true });
      await fs.writeFile(path.join(thumbs, name), thumb);
    });
    await write(process.stdout, `${JSON.stringify(verdict, null, 2)}\n`);
    return verdict.ok ? 0 : 1;
  } finally {
    renderer.dispose();
  }
}

// stdout is a pipe the launcher's caller reads, and app.exit does not wait for a pending write
const write = (stream: NodeJS.WriteStream, text: string): Promise<void> => new Promise((resolve, reject) => {
  stream.write(text, (err) => (err ? reject(err) : resolve()));
});

function start(): void {
  let args: Args;
  try {
    args = parse(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${USAGE}\n${err instanceof Error ? err.message : String(err)}\n`, () => app.exit(2));
    return;
  }
  app.setPath('userData', path.join(args.work, 'user-data'));
  // the store's CI has no GPU; the same software path on every computer keeps the verdicts alike
  app.disableHardwareAcceleration();
  app.enableSandbox();
  registerAppScheme();
  // the render window closes after each job, which must not end the run
  app.on('window-all-closed', () => undefined);
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  // as the app's windows: no popup and no navigation away from the page the host loaded, and nothing opens outside
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents, async () => false, log));
  // an error nothing caught ends the run as an internal error, never as Electron's dialog
  process.on('uncaughtException', (err) => {
    process.stderr.write(`theme-validate failed: ${err.stack ?? err.message}\n`, () => app.exit(2));
  });
  void app.whenReady().then(async () => {
    // no page loads in the default session, so it serves and allows nothing
    session.defaultSession.webRequest.onBeforeRequest((_details, answer) => answer({ cancel: true }));
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    return run(args);
  }).then((code) => app.exit(code), (err: unknown) => {
    process.stderr.write(`theme-validate failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`, () => app.exit(2));
  });
}

start();
