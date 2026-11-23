// The theme renderer (docs/invariants.md "Desktop themes"): one hidden offscreen sandboxed window with no preload and no bridge,
// loading app://damocles/theme-render/index.html, which draws a job main hands it through window.damoclesRender; main then
// captures the window, or for a wallpaper analysis checks the data the page answers. Jobs run one at a time, each within
// RENDER_TIMEOUT_MS (a video's flash check within VIDEO_ANALYSIS_TIMEOUT_MS); a renderer that dies fails its job and is made
// again for the next one, and a page that decoded a file is closed before any other job. The window itself is
// theme-render-page.ts's.
import { THEME_RENDER_SIZE, type ThemeRenderAnswer, type ThemeRenderJob } from '../../../shared/themes/agent';
import type { ThemeFile } from '../../../shared/themes/schema';
import { LOOK_SEEDS, type LookColors } from '../../../shared/themes/schema';
import {
  isFlashRecord, isImageStats, isWallpaperPalette, MAX_STILL_BYTES, MAX_THUMB_BYTES, STILL_SIDE, THUMB_SIDE, type FlashRecord, type ImageStats, type WallpaperKind, type WallpaperPalette,
} from '../../../shared/themes/wallpapers';
import { MAX_SPRITE_SIDE, SVG_MIME, type CharacterStrip } from '../../../shared/themes/characters';
import { APP_ORIGIN } from '../../app-urls';
import { readImageHeader } from '../../../shared/themes/image-header';

export const RENDER_TIMEOUT_MS = 60_000;
// a video's flash check decodes every frame in software, which for the largest video allowed takes about as long as it plays
export const VIDEO_ANALYSIS_TIMEOUT_MS = 90_000;
// the window's side during an analysis, which draws nothing main captures
export const ANALYZE_WINDOW = 64;
// an analysis answer holds a base64 thumbnail within MAX_THUMB_BYTES, a still frame within MAX_STILL_BYTES and a few hundred
// characters more
const MAX_ANALYSIS_CHARS: number = Math.ceil(((MAX_THUMB_BYTES + MAX_STILL_BYTES) * 4) / 3) + 4096;
const WEBP_URL = 'data:image/webp;base64,';
const PNG_URL = 'data:image/png;base64,';
// a moving image's bytes reach the page in pieces of this many base64 characters
export const FEED_CHARS: number = 4 * 1024 * 1024;
const PROGRESS_POLL_MS = 500;

export interface WallpaperAnalysisResult {
  readonly thumb: Uint8Array;
  readonly stats: ImageStats;
  readonly palette: WallpaperPalette;
  // the decoded size, the header's or, for a JPEG its EXIF orientation turns, the header's swapped
  readonly width: number;
  readonly height: number;
  // a moving wallpaper's first frame as PNG, and its flash check
  readonly still?: Uint8Array;
  readonly flash?: Omit<FlashRecord, 'allowed'>;
}

/**
 * The page's analysis answer, checked and built again from the fields it names: the image decoded at the size its header
 * declares (or turned by its orientation), a still WebP thumbnail of 1 to THUMB_SIDE px a side, stats in range and 8 hex colors
 * per look; a moving one's still frame is a PNG of 1 to STILL_SIDE px a side and its flash check carries no allowance.
 */
export function checkAnalysis(raw: unknown, image: { readonly width: number; readonly height: number }, moving = false): WallpaperAnalysisResult {
  let answer: unknown;
  try {
    answer = typeof raw === 'string' && raw.length <= MAX_ANALYSIS_CHARS ? JSON.parse(raw) : undefined;
  } catch {
    throw new Error('The theme renderer answered with text that is not JSON');
  }
  if (typeof answer !== 'object' || answer === null) throw new Error('The theme renderer did not analyze the wallpaper');
  const { thumb, stats, palette, error, width, height, still, flash } = answer as Record<string, unknown>;
  if (typeof error === 'string') throw new Error(`The wallpaper could not be decoded: ${error.slice(0, 200)}`);
  const same = width === image.width && height === image.height;
  const turned = width === image.height && height === image.width;
  if (!same && !turned) throw new Error(`The wallpaper decoded at ${String(width)}x${String(height)}, but its header says ${image.width}x${image.height}`);
  if (typeof thumb !== 'string' || !thumb.startsWith(WEBP_URL)) throw new Error('The theme renderer gave no WebP thumbnail');
  const bytes = new Uint8Array(Buffer.from(thumb.slice(WEBP_URL.length), 'base64'));
  if (bytes.length === 0 || bytes.length > MAX_THUMB_BYTES) throw new Error('The wallpaper thumbnail is empty or too large');
  let size: { readonly format: string; readonly width: number; readonly height: number; readonly animated: boolean };
  try {
    size = readImageHeader(bytes);
  } catch {
    throw new Error('The wallpaper thumbnail is not a WebP image');
  }
  if (size.format !== 'webp' || size.animated) throw new Error('The wallpaper thumbnail is not a still WebP image');
  if (size.width < 1 || size.height < 1 || size.width > THUMB_SIDE || size.height > THUMB_SIDE) throw new Error('The wallpaper thumbnail is empty or larger than its side cap');
  if (!isImageStats(stats)) throw new Error('The wallpaper stats are out of range');
  if (!isWallpaperPalette(palette)) throw new Error('The wallpaper palette is not 8 hex colors per look');
  const colors = (look: LookColors): LookColors => Object.fromEntries(LOOK_SEEDS.map((seed) => [seed, look[seed]])) as LookColors;
  const result = {
    thumb: bytes, stats: { p10: stats.p10, p90: stats.p90, mean: stats.mean }, palette: { dark: colors(palette.dark), light: colors(palette.light) }, width: width as number, height: height as number,
  };
  if (!moving) return result;
  if (typeof still !== 'string' || !still.startsWith(PNG_URL)) throw new Error('The theme renderer gave no still frame');
  const stillBytes = new Uint8Array(Buffer.from(still.slice(PNG_URL.length), 'base64'));
  const stillSize = pngSize(stillBytes);
  if (!stillSize || stillBytes.length > MAX_STILL_BYTES) throw new Error('The still frame is not a PNG within its size cap');
  if (stillSize.width < 1 || stillSize.height < 1 || stillSize.width > STILL_SIDE || stillSize.height > STILL_SIDE) throw new Error('The still frame is empty or larger than its side cap');
  if (!isFlashRecord(flash) || (flash as { allowed?: unknown }).allowed !== undefined) throw new Error('The theme renderer gave no flash check');
  const { flagged, atMs, kind } = flash;
  return { ...result, still: stillBytes, flash: { flagged, ...(atMs !== undefined ? { atMs } : {}), ...(kind !== undefined ? { kind } : {}) } };
}

export interface SpriteAnalysisResult {
  readonly still?: Uint8Array;
  readonly flash: Omit<FlashRecord, 'allowed'>;
}

// a sprite's still frame is a PNG of at most one frame, MAX_SPRITE_SIDE a side
const MAX_SPRITE_STILL_BYTES: number = MAX_SPRITE_SIDE * MAX_SPRITE_SIDE * 4 + 4096;
const MAX_SPRITE_ANSWER_CHARS: number = Math.ceil((MAX_SPRITE_STILL_BYTES * 4) / 3) + 4096;

/** The page's sprite answer, checked: decoded at its header's size, a still frame (when drawn) a PNG of one frame, a flash check with no allowance. */
export function checkSpriteAnalysis(raw: unknown, image: { readonly width: number; readonly height: number }, wantsStill: boolean): SpriteAnalysisResult {
  let answer: unknown;
  try {
    answer = typeof raw === 'string' && raw.length <= MAX_SPRITE_ANSWER_CHARS ? JSON.parse(raw) : undefined;
  } catch {
    throw new Error('The theme renderer answered with text that is not JSON');
  }
  if (typeof answer !== 'object' || answer === null) throw new Error('The theme renderer did not check the sprite');
  const { error, width, height, still, flash } = answer as Record<string, unknown>;
  if (typeof error === 'string') throw new Error(`The sprite could not be decoded: ${error.slice(0, 200)}`);
  if (width !== image.width || height !== image.height) throw new Error(`The sprite decoded at ${String(width)}x${String(height)}, but its header says ${image.width}x${image.height}`);
  if (!isFlashRecord(flash) || (flash as { allowed?: unknown }).allowed !== undefined) throw new Error('The theme renderer gave no flash check');
  const { flagged, atMs, kind } = flash;
  const verdict = { flagged, ...(atMs !== undefined ? { atMs } : {}), ...(kind !== undefined ? { kind } : {}) };
  if (!wantsStill) return { flash: verdict };
  if (typeof still !== 'string' || !still.startsWith(PNG_URL)) throw new Error('The theme renderer gave no still frame');
  const bytes = new Uint8Array(Buffer.from(still.slice(PNG_URL.length), 'base64'));
  const size = pngSize(bytes);
  if (!size || bytes.length > MAX_SPRITE_STILL_BYTES || size.width < 1 || size.height < 1 || size.width > MAX_SPRITE_SIDE || size.height > MAX_SPRITE_SIDE) throw new Error('The sprite\'s still frame is not a PNG within its caps');
  return { still: bytes, flash: verdict };
}

// a capture past this is refused: 4K at four bytes a pixel with no compression at all
export const MAX_RENDER_PNG_BYTES: number = 3840 * 2160 * 4;
// the composite job's side, in pixels
export const MAX_COMPOSITE_SIDE = 8192;

/** One page of the renderer process; every answer it gives is page-influenced. */
export interface RenderPage {
  // window.damoclesRender(json)'s answer
  render(json: string): Promise<unknown>;
  resize(width: number, height: number): Promise<void>;
  // a PNG of the page at width x height, from a frame rendered after the call
  capture(width: number, height: number): Promise<Uint8Array>;
  // window.damoclesFeed(chunk): one piece of a moving image's bytes, as base64, ahead of its analysis
  feed?(chunk: string): Promise<void>;
  // window.damoclesProgress(): how far the running analysis is, 0 to 1
  progress?(): Promise<unknown>;
  close(): void;
}

export interface ThemeRendererDeps {
  // `gone`: the page's renderer process ended or its window closed
  openPage(gone: (reason: string) => void): Promise<RenderPage>;
  // a moving wallpaper's or sprite's bytes, which the page decodes frame by frame; it cannot fetch them itself
  readBlob?(sha256: string, mime: string, kind: 'animated' | 'video' | 'sprite'): Promise<Uint8Array | undefined>;
  // how far a moving wallpaper's analysis is, 0 to 1, while it runs
  progress?(sha256: string, fraction: number): void;
  timeoutMs?: number;
  log(line: string): void;
}

/** A PNG's width and height from its IHDR chunk; undefined for anything that is not a PNG. */
export function pngSize(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, at) => bytes[at] !== byte)) return undefined;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** The page's answer, checked: drawn at exactly the job's size. */
export function checkAnswer(raw: unknown, job: Pick<ThemeRenderJob, 'width' | 'height'>): ThemeRenderAnswer {
  let answer: unknown;
  try {
    answer = typeof raw === 'string' && raw.length <= 1024 ? JSON.parse(raw) : undefined;
  } catch {
    throw new Error('The theme renderer answered with text that is not JSON');
  }
  if (typeof answer !== 'object' || answer === null || (answer as Record<string, unknown>)['drawn'] !== true) throw new Error('The theme renderer did not say it drew the job');
  const { width, height } = answer as Record<string, unknown>;
  if (width !== job.width || height !== job.height) throw new Error(`The theme renderer drew ${String(width)}x${String(height)}, not ${job.width}x${job.height}`);
  return { drawn: true, width, height };
}

/** The capture, checked: a PNG of exactly the job's size and within MAX_RENDER_PNG_BYTES. */
export function checkCapture(png: Uint8Array, job: Pick<ThemeRenderJob, 'width' | 'height'>): Uint8Array {
  if (png.length > MAX_RENDER_PNG_BYTES) throw new Error(`The theme render is ${png.length} bytes, more than ${MAX_RENDER_PNG_BYTES}`);
  const size = pngSize(png);
  if (!size) throw new Error('The theme render is not a PNG');
  if (size.width !== job.width || size.height !== job.height) throw new Error(`The theme render is ${size.width}x${size.height}, not ${job.width}x${job.height}`);
  return png;
}

// the wallpaper or sprite an analysis decodes, which the theme-blob route serves to the page while it runs
export interface RenderImage {
  readonly sha256: string;
  readonly mime: string;
  readonly kind: WallpaperKind | 'sprite';
}

export class ThemeRenderer {
  private page: Promise<RenderPage> | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private job: ThemeRenderJob | undefined;
  private image: RenderImage | undefined;
  private onGone: ((reason: string) => void) | undefined;
  private queued = 0;
  // counts the closes of the main window: a job queued before one died with that window
  private closes = 0;
  private closeReason = '';
  private disposed = false;
  private readonly deps: ThemeRendererDeps;

  constructor(deps: ThemeRendererDeps) {
    this.deps = deps;
  }

  /** A drawn preview: ThemeMiniature of `theme` with sample content, 1280x800. */
  preview(theme: ThemeFile, mode: 'dark' | 'light' | 'split', signal?: AbortSignal): Promise<Uint8Array> {
    return this.draw({ kind: 'preview', theme, mode, width: THEME_RENDER_SIZE.width, height: THEME_RENDER_SIZE.height }, signal);
  }

  /** The chat view's capture drawn over the shell's at `bounds`, as one PNG of the shell's size. */
  composite(shell: Uint8Array, chat: Uint8Array, bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const size = pngSize(shell);
    if (!size || !pngSize(chat)) return Promise.reject(new Error('A capture of the window is not a PNG'));
    if (size.width > MAX_COMPOSITE_SIDE || size.height > MAX_COMPOSITE_SIDE) return Promise.reject(new Error(`The window capture is ${size.width}x${size.height}, larger than ${MAX_COMPOSITE_SIDE} px`));
    const dataUrl = (png: Uint8Array): string => `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
    return this.draw({ kind: 'composite', shell: dataUrl(shell), chat: dataUrl(chat), bounds, width: size.width, height: size.height }, signal);
  }

  /**
   * A wallpaper decoded in the page: a WebP thumbnail at most THUMB_SIDE on a side, its luminance stats and its proposed palette.
   * Refused when the decoded image is not the size its header declared.
   */
  async analyze(sha256: string, mime: string, image: { readonly width: number; readonly height: number }, kind: WallpaperKind = 'image', durationMs?: number, signal?: AbortSignal): Promise<WallpaperAnalysisResult> {
    const moving = kind === 'image' ? undefined : { kind, mime, ...(durationMs !== undefined ? { durationMs } : {}) };
    const job: ThemeRenderJob = { kind: 'analyze', url: `${APP_ORIGIN}/theme-blob/${sha256}`, image, ...(moving ? { moving } : {}), width: ANALYZE_WINDOW, height: ANALYZE_WINDOW };
    let bytes: Uint8Array | undefined;
    if (kind !== 'image') {
      bytes = await this.deps.readBlob?.(sha256, mime, kind);
      if (!bytes) throw new Error('The moving wallpaper could not be read for its flash check');
    }
    return this.run(job, { sha256, mime, kind }, (_page, answer) => Promise.resolve(checkAnalysis(answer, image, moving !== undefined)), bytes, signal);
  }

  /**
   * A character sprite decoded in the page: a strip's frames or an animated image's checked for flashing, and an animated
   * image's or an SVG's first frame drawn. Refused when the decoded image is not the size its header declared.
   */
  async analyzeSprite(sha256: string, sprite: { readonly mime: string; readonly width: number; readonly height: number; readonly strip?: CharacterStrip; readonly animated: boolean }, signal?: AbortSignal): Promise<SpriteAnalysisResult> {
    const image = { width: sprite.width, height: sprite.height };
    const job: ThemeRenderJob = { kind: 'sprite', url: `${APP_ORIGIN}/theme-blob/${sha256}`, mime: sprite.mime, image, ...(sprite.strip ? { strip: sprite.strip } : {}), animated: sprite.animated, width: ANALYZE_WINDOW, height: ANALYZE_WINDOW };
    let bytes: Uint8Array | undefined;
    if (sprite.animated) {
      bytes = await this.deps.readBlob?.(sha256, sprite.mime, 'sprite');
      if (!bytes) throw new Error('The animated sprite could not be read for its flash check');
    }
    const wantsStill = sprite.strip === undefined && (sprite.animated || sprite.mime === SVG_MIME);
    return this.run(job, { sha256, mime: sprite.mime, kind: 'sprite' }, (_page, answer) => Promise.resolve(checkSpriteAnalysis(answer, image, wantsStill)), bytes, signal);
  }

  /** The theme of the job running now, whose bundled fonts the theme-blob route serves to the page. */
  currentTheme(): ThemeFile | undefined {
    return this.job?.kind === 'preview' ? this.job.theme : undefined;
  }

  /** The wallpaper or sprite the job running now decodes, which the theme-blob route serves to the page. */
  currentImage(): RenderImage | undefined {
    return this.job?.kind === 'analyze' || this.job?.kind === 'sprite' ? this.image : undefined;
  }

  /** Ends the renderer: the running job and every queued one fail, and the page closes. */
  dispose(): void {
    this.disposed = true;
    this.onGone?.('The theme renderer is closed');
    this.recycle();
  }

  /**
   * The main window closed: a page left open would keep the app from quitting on Windows and Linux, so it closes, and the job
   * running on it and every job queued behind that one fail with `reason`. A job asked for afterwards opens a fresh page.
   */
  closePage(reason: string): void {
    this.closes++;
    this.closeReason = reason;
    this.onGone?.(reason);
    this.recycle();
  }

  // A drawing's end: the page said it drew the job, and main captures the window at its size.
  private draw(job: ThemeRenderJob, signal?: AbortSignal): Promise<Uint8Array> {
    return this.run(job, undefined, async (page, answer) => {
      checkAnswer(answer, job);
      return checkCapture(await page.capture(job.width, job.height), job);
    }, undefined, signal);
  }

  // `signal` ends the job: one still queued never starts, and a running one fails, so the page goes to the next job.
  private run<T>(job: ThemeRenderJob, image: RenderImage | undefined, finish: (page: RenderPage, answer: unknown) => Promise<T>, bytes?: Uint8Array, signal?: AbortSignal): Promise<T> {
    this.queued++;
    const closes = this.closes;
    const next = this.tail.then(() => {
      if (closes !== this.closes) throw new Error(`The theme renderer ended: ${this.closeReason}`);
      return this.runNow(job, image, finish, bytes, signal);
    }).finally(() => {
      this.queued--;
      // An idle page is a hidden window, so none stays open between jobs; and a page that decoded a file may be compromised by
      // it, so it gets no later job, whose captures or theme it could read.
      if (this.queued === 0 || job.kind === 'analyze' || job.kind === 'sprite') this.recycle();
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async runNow<T>(job: ThemeRenderJob, image: RenderImage | undefined, finish: (page: RenderPage, answer: unknown) => Promise<T>, bytes?: Uint8Array, signal?: AbortSignal): Promise<T> {
    if (this.disposed) throw new Error('The theme renderer is closed');
    if (signal?.aborted) throw new Error('The theme render was cancelled');
    const timeoutMs = this.deps.timeoutMs ?? (job.kind === 'analyze' && job.moving?.kind === 'video' ? VIDEO_ANALYSIS_TIMEOUT_MS : RENDER_TIMEOUT_MS);
    let fail: (err: Error) => void = () => undefined;
    const failed = new Promise<never>((_, reject) => {
      fail = reject;
    });
    // every step races `failed`, which reports its rejection; this only keeps one after the last step from going unhandled
    failed.catch(() => undefined);
    const timer = setTimeout(() => fail(new Error(`The theme render took longer than ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    this.job = job;
    this.image = image;
    this.onGone = (reason) => fail(new Error(`The theme renderer ended: ${reason}`));
    const cancelled = (): void => fail(new Error('The theme render was cancelled'));
    signal?.addEventListener('abort', cancelled, { once: true });
    let polling: ReturnType<typeof setInterval> | undefined;
    try {
      const page = await Promise.race([this.open(), failed]);
      await Promise.race([page.resize(job.width, job.height), failed]);
      if (bytes) {
        if (!page.feed) throw new Error('The theme renderer cannot take a moving image');
        const base64 = Buffer.from(bytes).toString('base64');
        for (let at = 0; at < base64.length; at += FEED_CHARS) await Promise.race([page.feed(base64.slice(at, at + FEED_CHARS)), failed]);
      }
      const report = this.deps.progress;
      if (job.kind === 'analyze' && job.moving && report && page.progress && image) {
        polling = setInterval(() => {
          page.progress!().then((value) => {
            if (typeof value === 'number' && Number.isFinite(value)) report(image.sha256, Math.min(1, Math.max(0, value)));
          }, () => undefined);
        }, PROGRESS_POLL_MS);
      }
      const answer = await Promise.race([page.render(JSON.stringify(job)), failed]);
      return await Promise.race([finish(page, answer), failed]);
    } catch (err) {
      // a page that timed out or answered wrongly may still be busy, so the next job gets a fresh one
      this.recycle();
      throw err;
    } finally {
      clearInterval(polling);
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancelled);
      this.job = undefined;
      this.image = undefined;
      this.onGone = undefined;
    }
  }

  // The current page, or a new one; its end fails the job running then.
  private open(): Promise<RenderPage> {
    if (this.page) return this.page;
    // a page main closed itself is no longer this.page, so its end fails nothing
    const page = this.deps.openPage((reason) => {
      if (this.page !== page) return;
      this.deps.log(`[themes] the theme renderer ended: ${reason}`);
      // a page whose renderer died still holds its window
      this.recycle();
      this.onGone?.(reason);
    });
    this.page = page;
    page.catch(() => {
      if (this.page === page) this.page = undefined;
    });
    return page;
  }

  private recycle(): void {
    const page = this.page;
    this.page = undefined;
    page?.then((open) => open.close(), () => undefined);
  }
}
