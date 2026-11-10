// ImportAsset (PD-46, D101): copies a font or image into the design's assets/, which the designer cannot write, from a project
// file, a file of the chat's machine or an https URL.
import { constants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import type { ImportAssetDetails } from '../../shared/types/design';
import { FetchRefusedError, readBodyCapped, RedirectRefusedError, safeFetch } from '../pi-session/web-access/safe-fetch';
import { resolveReadPathAsync, resolveToCwd } from '../pi-session/tools/search-tools';
import type { ProjectFiles } from './citations';
import { ASSETS_DIR, MAX_DESIGN_FILES } from './design-paths';
import { writeTextAtomic } from './design-state';

export const MAX_ASSET_BYTES: number = 5 * 1024 * 1024;
export const ASSET_EXTENSIONS: ReadonlySet<string> = new Set(['woff', 'woff2', 'ttf', 'otf', 'png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'svg', 'ico']);
const FETCH_TIMEOUT_MS = 30_000;

/** Thrown for a source ImportAsset refuses; its message tells the model why. */
export class AssetRefusedError extends Error {}

/** A file type `sniffAsset` recognises by its bytes. */
export type AssetKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | 'ico' | 'woff' | 'woff2' | 'sfnt' | 'svg';

/** The extensions each sniffed type may carry, the first one given to a name that has none; each is in ASSET_EXTENSIONS. */
const KIND_EXTENSIONS: Readonly<Record<AssetKind, readonly string[]>> = {
  png: ['png'], jpeg: ['jpg', 'jpeg'], gif: ['gif'], webp: ['webp'], avif: ['avif'], ico: ['ico'], woff: ['woff'], woff2: ['woff2'], sfnt: ['ttf', 'otf'], svg: ['svg'],
};

const ascii = (bytes: Uint8Array, start: number, end: number): string => Buffer.from(bytes.subarray(start, end)).toString('latin1');

/** Whether an ISO BMFF `ftyp` box at the start of `bytes` names an AVIF brand, as its major or a compatible brand. */
function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== 'ftyp') return false;
  const size = Buffer.from(bytes.subarray(0, 4)).readUInt32BE(0);
  const end = Math.min(size, bytes.length);
  // the major brand at 8, the minor version at 12, then the compatible brands
  const brands = [ascii(bytes, 8, 12)];
  for (let at = 16; at + 4 <= end; at += 4) brands.push(ascii(bytes, at, at + 4));
  return brands.some((brand) => brand === 'avif' || brand === 'avis');
}

const SVG_PROLOG_PART = /^(?:\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE\s[^>]*>)/i;

/** Whether `bytes` are UTF-8 XML whose root element is `<svg>`: declarations, comments and a doctype may come first. */
function isSvg(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch (err) {
    if (err instanceof TypeError) return false;
    throw err;
  }
  let rest = text;
  for (let match = SVG_PROLOG_PART.exec(rest); match && match[0].length > 0; match = SVG_PROLOG_PART.exec(rest)) rest = rest.slice(match[0].length);
  return /^<svg[\s/>]/.test(rest);
}

/** The type `bytes` hold by their magic bytes, or undefined for any other content. */
export function sniffAsset(bytes: Uint8Array): AssetKind | undefined {
  const head = ascii(bytes, 0, 12);
  if (bytes.length >= 8 && bytes[0] === 0x89 && head.slice(1, 8) === 'PNG\r\n\x1a\n') return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
  if (isAvif(bytes)) return 'avif';
  // an icon directory with at least one image
  if (bytes.length >= 6 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0 && (bytes[4]! | bytes[5]!) !== 0) return 'ico';
  if (head.startsWith('wOFF')) return 'woff';
  if (head.startsWith('wOF2')) return 'woff2';
  if (head.startsWith('OTTO') || head.startsWith('true') || (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) return 'sfnt';
  return isSvg(bytes) ? 'svg' : undefined;
}

/** A name safe as one file of assets/: letters, digits, `.`, `-` and `_`. */
function assetName(source: string): string {
  const base = path.basename(source).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '');
  return base === '' ? 'asset' : base;
}

/**
 * The assets/ name of `bytes` from source name `name` (named `shown` to the model): their sniffed type must be one of
 * ImportAsset's and match the name's extension, and a name with no extension takes the sniffed type's.
 */
function sniffedName(bytes: Uint8Array, name: string, shown: string): string {
  const kind = sniffAsset(bytes);
  if (!kind) throw new AssetRefusedError(`${shown} holds no font or image ImportAsset copies (${[...ASSET_EXTENSIONS].join(', ')}); its bytes are no such file`);
  const safe = assetName(name);
  const extension = path.extname(safe).slice(1).toLowerCase();
  if (extension === '') return `${safe}.${KIND_EXTENSIONS[kind][0]!}`;
  if (!KIND_EXTENSIONS[kind].includes(extension)) throw new AssetRefusedError(`${shown} is named .${extension} but holds ${kind === 'sfnt' ? 'a TrueType or OpenType font' : `a ${kind.toUpperCase()} file`}, so it was not copied`);
  return safe;
}

/**
 * The bytes of source `source` (named `file` to the model), read through one handle whose identity matches the walked entry:
 * a regular file, not a link, with one hard link and at most MAX_ASSET_BYTES bytes.
 */
async function readAssetSource(source: string, file: string): Promise<Buffer> {
  let linked: BigIntStats;
  try {
    linked = await fs.lstat(source, { bigint: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') throw new AssetRefusedError(`${file} does not exist`);
    throw err;
  }
  if (!linked.isFile()) throw new AssetRefusedError(`${file} is not a regular file`);
  let handle: FileHandle;
  try {
    // O_NOFOLLOW is POSIX only; on win32 the identity check below catches a link swapped in after the lstat.
    handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new AssetRefusedError(`${file} is not a regular file`);
    throw err;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino) throw new AssetRefusedError(`${file} is not a regular file`);
    // A hard link shares its bytes with a name outside the project, which no path check sees.
    if (opened.nlink !== 1n) throw new AssetRefusedError(`${file} has more than one hard link`);
    if (opened.size > BigInt(MAX_ASSET_BYTES)) throw new AssetRefusedError(`${file} is larger than 5 MiB`);
    // At most one byte past the cap, so a file that grew after the stat is refused, never read whole.
    const buffer = Buffer.allocUnsafe(MAX_ASSET_BYTES + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_ASSET_BYTES) throw new AssetRefusedError(`${file} is larger than 5 MiB`);
    }
    return Buffer.from(buffer.subarray(0, total));
  } finally {
    await handle.close();
  }
}

/**
 * Writes `bytes` as `<folder>/assets/<name>`, a `.jpeg` name as `.jpg`, which the serve policy of every app version serves: a file
 * of the same name and bytes is reused, another one gives a numbered name.
 */
async function storeAsset(folder: string, requested: string, bytes: Buffer, source: string): Promise<Required<ImportAssetDetails>> {
  const name = requested.replace(/\.jpeg$/i, '.jpg');
  const stem = name.slice(0, name.length - path.extname(name).length);
  const ext = path.extname(name);
  for (let n = 1; n <= MAX_DESIGN_FILES; n++) {
    const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
    const target = path.join(folder, ASSETS_DIR, candidate);
    let existing: Buffer | undefined;
    try {
      existing = await fs.readFile(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (existing && !existing.equals(bytes)) continue;
    if (!existing) await writeTextAtomic(target, bytes);
    return { asset: `${ASSETS_DIR}/${candidate}`, bytes: bytes.length, source };
  }
  throw new AssetRefusedError(`assets/ already holds ${MAX_DESIGN_FILES} other files named like ${name}`);
}

/**
 * Copies project file `file` (relative to the working folder, resolved through the host's confinement rule) into
 * `<folder>/assets/`. It must be a regular file with one link, of an allowed extension, at most 5 MiB.
 */
export async function importAsset(files: ProjectFiles, file: string, folder: string): Promise<Required<ImportAssetDetails>> {
  const resolved = await files.resolve(file);
  if (!resolved.ok) throw new AssetRefusedError(resolved.reason);
  const extension = path.extname(resolved.path).slice(1).toLowerCase();
  if (!ASSET_EXTENSIONS.has(extension)) throw new AssetRefusedError(`${file} is not a font or image ImportAsset copies (${[...ASSET_EXTENSIONS].join(', ')})`);
  const bytes = await readAssetSource(resolved.path, file);
  return storeAsset(folder, assetName(resolved.path), bytes, file);
}

/**
 * Copies `file`, a path on the chat's machine, into `<folder>/assets/`: a regular file with one link, at most 5 MiB, whose
 * sniffed type is one ImportAsset copies and matches its name.
 */
export async function importAssetFile(file: string, cwd: string, folder: string): Promise<Required<ImportAssetDetails>> {
  // The file pi's Read opens for `file`, which the gate's Read rules judged (D101).
  const source = await resolveReadPathAsync(resolveToCwd(file, cwd));
  const bytes = await readAssetSource(source, file);
  return storeAsset(folder, sniffedName(bytes, source, file), bytes, file);
}

/**
 * Downloads https `url` through the SSRF-guarded fetch, which refuses a private-network address and http at every redirect, into
 * `<folder>/assets/`: at most 5 MiB, whose sniffed type is one ImportAsset copies and matches the URL's name. A redirect off the
 * URL's host to a host `hostRefused` names is not followed (D101). Only `signal` aborts; a refusal or the timeout is refused.
 */
export async function importAssetUrl(url: string, folder: string, signal: AbortSignal, hostRefused: (url: string) => boolean): Promise<Required<ImportAssetDetails>> {
  if (!URL.canParse(url)) throw new AssetRefusedError(`${url} is not a URL`);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new AssetRefusedError(`${url} is not an https URL`);
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const redirectRefused = (target: string): boolean => new URL(target).hostname !== parsed.hostname && hostRefused(target);
  let bytes: Buffer;
  try {
    const response = await safeFetch(parsed.href, { signal: AbortSignal.any([signal, timeout]) }, { httpsOnly: true, redirectRefused });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AssetRefusedError(`${url} answered HTTP ${response.status}`);
    }
    bytes = Buffer.from(await readBodyCapped(response, MAX_ASSET_BYTES));
  } catch (err) {
    if (signal.aborted || err instanceof AssetRefusedError) throw err;
    if (err instanceof RedirectRefusedError) {
      throw new AssetRefusedError(`${url} redirects to ${err.location}, whose host a WebFetch rule in the user's permission settings covers, so it was not followed; import that URL as its own call, which the rules judge`);
    }
    if (err instanceof FetchRefusedError) throw new AssetRefusedError(err.message);
    if (timeout.aborted) throw new AssetRefusedError(`${url} did not answer within ${FETCH_TIMEOUT_MS / 1000} seconds`);
    throw err;
  }
  const name = parsed.pathname.slice(parsed.pathname.lastIndexOf('/') + 1);
  return storeAsset(folder, sniffedName(bytes, name, url), bytes, url);
}
