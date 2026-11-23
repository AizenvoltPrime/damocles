// ThemeSet's image sources (docs/tools.md "Theme tools"): the permission gate judged each one before anything here reads or
// fetches a byte; the bytes then go to ThemeService.importImage, which holds them to the wallpaper caps and stores a blob.
import type { ThemeAssetSource } from '../../shared/themes/asset-source';
import { MAX_MOVING_BYTES } from '../../shared/themes/wallpapers';
import { AssetRefusedError, readAssetSource, sniffAsset, type AssetKind } from '../design/assets';
import { resolveReadPathAsync, resolveToCwd } from '../pi-session/tools/search-tools';
import { FetchRefusedError, RedirectRefusedError, safeFetch } from '../pi-session/web-access/safe-fetch';
import { DOWNLOAD_DEADLINE_MS, DOWNLOAD_STALL_MS, downloadClock, readMovingBody } from './download';
import { sniffVideo } from '../../shared/themes/video-header';

// a moving wallpaper's cap; importImage holds a still image to its own, lower one
const MAX_WALLPAPER_BYTES = MAX_MOVING_BYTES;
const MAX_MB = MAX_WALLPAPER_BYTES / 1024 / 1024;

/** A source ThemeSet does not use; its message tells the model why. */
export class SourceRefusedError extends Error {}

/** What the sources may use now, read per call. */
export interface ThemeSourceReach {
  readonly webSearch: boolean;
  readonly imageGeneration: 'on' | 'off' | 'noModel' | 'unknownModel' | 'noOpenRouterKey';
}

/** Why `source` cannot be used now, or undefined; the gate blocks with it before asking, and the tool refuses with it. */
export function themeSourceRefusal(source: ThemeAssetSource, reach: ThemeSourceReach): string | undefined {
  if (source.kind === 'url' && !reach.webSearch) {
    return 'ThemeSet downloads a URL only while Web search is on, since this chat could not fetch it otherwise. Ask the user to turn on Web search in Settings, or use a file or an attached image.';
  }
  if (source.kind !== 'generate') return undefined;
  switch (reach.imageGeneration) {
    case 'on': return undefined;
    case 'off': return 'Image generation is off. The user turns it on in Settings (Image generation); until then use a file, a URL or an attached image.';
    case 'noModel': return 'Image generation has no model: the user picks an OpenRouter image model in Settings.';
    case 'unknownModel': return 'The image model chosen in Settings is not one Damocles offers: the user picks another OpenRouter image model in Settings.';
    case 'noOpenRouterKey': return 'Image generation needs an OpenRouter key, which the user adds in Settings.';
  }
}

const SNIFFED_MIME: Readonly<Partial<Record<AssetKind, string>>> = {
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/x-icon',
};

/**
 * Refuses bytes whose sniffed type is not the image type `declared` claims (a response's Content-Type, an attachment's or a
 * generated image's type). A declared type that names no image (`application/octet-stream`) leaves the bytes to decide.
 */
export function checkDeclaredType(bytes: Uint8Array, declared: string | undefined, what: string): void {
  const mime = declared?.split(';', 1)[0]!.trim().toLowerCase().replace(/^image\/jpg$/, 'image/jpeg').replace(/^image\/apng$/, 'image/png');
  if (mime === undefined || !(mime.startsWith('image/') || mime.startsWith('video/'))) return;
  const container = sniffVideo(bytes);
  const kind = container === undefined ? sniffAsset(bytes) : undefined;
  const actual = container !== undefined ? `video/${container}` : kind === undefined ? undefined : SNIFFED_MIME[kind];
  if (actual !== mime) throw new SourceRefusedError(`${what} is declared as ${mime} but holds ${actual ?? 'no image Damocles reads'}, so it was not used.`);
}

/** The bytes of `file` as Read opens it from `cwd`: a regular file with one link, within the wallpaper size cap. */
export async function readFileSource(file: string, cwd: string): Promise<{ readonly bytes: Uint8Array; readonly name: string }> {
  // the file pi's Read opens for `file`, which the gate's Read rules judged
  const source = await resolveReadPathAsync(resolveToCwd(file, cwd));
  try {
    return { bytes: await readAssetSource(source, file, MAX_WALLPAPER_BYTES), name: source };
  } catch (err) {
    if (err instanceof AssetRefusedError) throw new SourceRefusedError(`${err.message}, so it was not used.`);
    throw err;
  }
}

// A failed fetch's own words, with its cause's: fetch says only "fetch failed" and keeps the reason (DNS, a reset) in the cause.
function failureText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
}

/**
 * The body of https `url` through the SSRF-guarded fetch, within the wallpaper size cap. No redirect is followed: its target is
 * named for a call of its own, which the gate judges. Only `signal` aborts; any other failure is a SourceRefusedError. The
 * bytes carry no file name: their type is what the response declares and the bytes hold, never the URL's path.
 */
export async function fetchUrlSource(url: string, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly declared?: string }> {
  if (!URL.canParse(url)) throw new SourceRefusedError(`${url} is not a URL.`);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new SourceRefusedError(`${url} is not an https URL; ThemeSet fetches https only.`);
  const clock = downloadClock(signal);
  const tooLarge = (): SourceRefusedError => new SourceRefusedError(`${url} is larger than ${MAX_MB} MB, the most a wallpaper may be.`);
  try {
    const response = await safeFetch(parsed.href, { signal: clock.signal }, { httpsOnly: true, redirectRefused: () => true });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceRefusedError(`${url} answered HTTP ${response.status}.`);
    }
    clock.moved();
    const declared = response.headers.get('content-type') ?? undefined;
    const bytes = await readMovingBody(response, MAX_WALLPAPER_BYTES, clock.moved, tooLarge);
    return { bytes, ...(declared !== undefined ? { declared } : {}) };
  } catch (err) {
    if (signal.aborted || err instanceof SourceRefusedError) throw err;
    if (err instanceof RedirectRefusedError) {
      throw new SourceRefusedError(`${url} redirects to ${err.location}. ThemeSet follows no redirect, so nothing was fetched from there; call again with that URL, which the user's permission rules judge.`);
    }
    if (clock.ended() === 'stalled') throw new SourceRefusedError(`${url} sent nothing for ${DOWNLOAD_STALL_MS / 1000} seconds, so the download stopped.`);
    if (clock.ended() === 'deadline') throw new SourceRefusedError(`The download of ${url} took longer than ${DOWNLOAD_DEADLINE_MS / 60_000} minutes, so it stopped.`);
    if (err instanceof FetchRefusedError) throw new SourceRefusedError(err.message);
    throw new SourceRefusedError(`${url} could not be fetched: ${failureText(err)}.`);
  } finally {
    clock.dispose();
  }
}

/** The n-th image the user attached in this chat, counting from 1; its base64 is bounded before it is decoded. */
export function attachmentSource(attached: ReadonlyArray<{ readonly data: string; readonly mimeType: string }>, index: number): { readonly bytes: Uint8Array; readonly declared: string } {
  if (!Number.isInteger(index) || index < 1 || index > attached.length) {
    throw new SourceRefusedError(attached.length === 0 ? 'The user attached no image in this chat.' : `The user attached ${attached.length} image${attached.length === 1 ? '' : 's'} in this chat; attachment ${index} is not one of them.`);
  }
  const image = attached[index - 1]!;
  // base64 carries 3 bytes in 4 characters
  if (image.data.length > Math.ceil(MAX_WALLPAPER_BYTES / 3) * 4) throw new SourceRefusedError(`Attachment ${index} is larger than ${MAX_MB} MB, the most a wallpaper may be.`);
  return { bytes: new Uint8Array(Buffer.from(image.data, 'base64')), declared: image.mimeType };
}
