// Staged theme installs (docs/themes.md "Sharing"): every path (Settings Import, Install from link, a damocles:// link, the
// agent's ThemeSet install) reads and checks a file into a staged install the install card lists, and only commit installs it.
import { randomUUID, createHash } from 'node:crypto';
import * as path from 'node:path';
import type { Disposable } from '../../platform/disposable';
import { LocalizedError, type LocalizedText } from '../../shared/localized-text';
import type { ThemeContrastIssue } from '../../shared/themes/agent';
import { characterAssets, spriteStrip } from '../../shared/themes/characters';
import { checkPalette } from '../../shared/themes/contrast';
import type { CssDroppedPart } from '../../shared/themes/css-types';
import { deriveLook } from '../../shared/themes/derive';
import type {
  ThemeInstallAbout, ThemeInstallClash, ThemeInstallCss, ThemeInstallFont, ThemeInstallFrom, ThemeInstallPlacement, ThemeInstallPreview,
  ThemeInstallProgress, ThemeInstallSource, ThemeInstallStore, ThemeInstallWallpaper,
} from '../../shared/themes/install';
import { CSS_REGIONS, PANELS, type AssetMeta, type Panel, type ThemeFile } from '../../shared/themes/schema';
import { LOOK_KINDS } from '../../shared/themes/tokens';
import { isMoving, isWallpaperAsset, type WallpaperKind } from '../../shared/themes/wallpapers';
import { oneLine } from '../pi-session/untrusted-text';
import { FetchRefusedError, RedirectRefusedError, safeFetch } from '../pi-session/web-access/safe-fetch';
import { l, verbatim } from '../l10n';
import { MAX_ARCHIVE_BYTES, readCappedFile } from './archive';
import { E2E_HOST, e2eFileName, readE2eFile } from './e2e-downloads';
import { DOWNLOAD_DEADLINE_MS, DOWNLOAD_STALL_MS, downloadClock, readMovingBody } from './download';
import { readImport, type ImportedTheme } from './import';
import type { ThemeListEntry } from './store';

// A card left open this long without an answer is dropped with its staged data, by its own timer.
export const STAGED_INSTALL_TTL_MS: number = 60 * 60 * 1000;
// Staged installs and those being read or downloaded, together.
export const MAX_STAGED_INSTALLS = 8;
const MAX_FILE_NAME_CHARS = 200;
// The thumbnails a preview carries as data URLs, together at most this many bytes.
const MAX_PREVIEW_THUMB_BYTES: number = 8 * 1024 * 1024;
const OUTSIDE_TEXT = { description: 1000, author: 200, version: 64, license: 64 } as const;

/** A download refused: not https, another host's redirect, too large, or an HTTP error; its text names why. */
export class DownloadRefusedError extends LocalizedError {}

export interface DownloadOptions {
  readonly signal: AbortSignal;
  // CoreInit.e2eThemeDownloads, honored only with the e2e hooks on
  readonly e2eFolder?: string;
  // a caller's own redirect rule: the https hosts the download may follow to, and what a refused one is told (the link's host
  // and the target's); absent, only the URL's own host
  readonly redirect?: { allowed(target: URL): boolean; refusal(host: string, target: string): LocalizedText };
  // a store download's pinned size, past which the body stops; absent, MAX_ARCHIVE_BYTES
  readonly maxBytes?: number;
}

/**
 * The bytes of an https URL: redirects are followed only to https on the same host (or to the hosts the caller's `redirect`
 * rule admits), each hop through safeFetch's SSRF guard; the size cap counts the body as it streams, and `sha256` is hashed
 * chunk by chunk as it does.
 */
export async function downloadTheme(url: string, options: DownloadOptions): Promise<{ readonly bytes: Uint8Array; readonly sha256: string; readonly host: string; readonly fileName: string }> {
  if (!URL.canParse(url)) throw new DownloadRefusedError(l('{0} is not a link Damocles can open.', verbatim(url.slice(0, 200))));
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new DownloadRefusedError(l('Damocles installs themes only from https links; {0} is not one.', verbatim(url.slice(0, 200))));
  const host = parsed.host;
  const fileName = lastSegment(parsed.pathname);
  if (options.e2eFolder !== undefined && parsed.hostname === E2E_HOST) {
    const name = e2eFileName(parsed);
    if (name === undefined) throw new DownloadRefusedError(l('{0} is not a link Damocles can open.', verbatim(url.slice(0, 200))));
    const bytes = await readE2eFile(options.e2eFolder, name, MAX_ARCHIVE_BYTES);
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), host, fileName: name };
  }
  const clock = downloadClock(options.signal);
  const max = Math.min(options.maxBytes ?? MAX_ARCHIVE_BYTES, MAX_ARCHIVE_BYTES);
  const tooLarge = (): DownloadRefusedError => (max < MAX_ARCHIVE_BYTES
    ? new DownloadRefusedError(l('The file at {0} is larger than the {1} bytes the store list pins, so nothing was installed.', host, String(max)))
    : new DownloadRefusedError(l('The file at {0} is larger than {1} MB, the most Damocles reads.', host, String(MAX_ARCHIVE_BYTES / 1024 / 1024))));
  try {
    const { redirect } = options;
    const response = await safeFetch(parsed.href, { signal: clock.signal }, {
      httpsOnly: true,
      redirectRefused: (target) => {
        const next = new URL(target);
        return next.protocol !== 'https:' || (redirect ? !redirect.allowed(next) : next.host !== host);
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DownloadRefusedError(l('{0} answered HTTP {1}, so nothing was installed.', host, String(response.status)));
    }
    clock.moved();
    const hash = createHash('sha256');
    const bytes = await readMovingBody(response, max, (chunk) => {
      clock.moved();
      hash.update(chunk);
    }, tooLarge);
    return { bytes, sha256: hash.digest('hex'), host, fileName };
  } catch (err) {
    if (options.signal.aborted || err instanceof DownloadRefusedError) throw err;
    if (err instanceof RedirectRefusedError) {
      const target = URL.canParse(err.location) ? new URL(err.location) : undefined;
      if (target?.protocol !== 'https:') throw new DownloadRefusedError(l('{0} sends the download on to a link that is not https, so nothing was downloaded.', host), { cause: err });
      if (options.redirect) throw new DownloadRefusedError(options.redirect.refusal(host, target.host), { cause: err });
      throw new DownloadRefusedError(l('{0} sends the download on to another host, {1}. Damocles installs only from the host the link names, so nothing was downloaded from {1}.', host, verbatim(target.host)), { cause: err });
    }
    if (clock.ended() === 'stalled') throw new DownloadRefusedError(l('{0} sent nothing for {1} seconds, so the download stopped.', host, String(DOWNLOAD_STALL_MS / 1000)), { cause: err });
    if (clock.ended() === 'deadline') throw new DownloadRefusedError(l('The download from {0} took longer than {1} minutes, so it stopped.', host, String(DOWNLOAD_DEADLINE_MS / 60_000)), { cause: err });
    if (err instanceof FetchRefusedError) throw new DownloadRefusedError(l('Damocles did not download from {0}: {1}', host, verbatim(err.message)), { cause: err });
    throw new DownloadRefusedError(l('Damocles could not download from {0}: {1}', host, verbatim(err instanceof Error ? err.message : String(err))), { cause: err });
  } finally {
    clock.dispose();
  }
}

/**
 * A URL path's last segment for the card: one line, no control or bidi characters; a malformed escape is shown as written rather
 * than refusing the download.
 */
function lastSegment(pathname: string): string {
  const raw = pathname.slice(pathname.lastIndexOf('/') + 1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch (err) {
    if (!(err instanceof URIError)) throw err;
    decoded = raw;
  }
  return oneLine(decoded, MAX_FILE_NAME_CHARS) ?? '';
}

/** A sha256 of a theme's content apart from its origin, with keys sorted, so an edit and a re-save tell apart. */
export function contentHash(theme: ThemeFile): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  };
  const { origin: _origin, ...content } = theme;
  return createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex');
}

const OUTSIDE_ORIGINS: ReadonlySet<string> = new Set(['import', 'vscode', 'link', 'store']);

/** The Keep both name: the name with the lowest number from 2 that no theme has, cut so it stays within 64 characters. */
export function keepBothName(name: string, taken: readonly string[]): string {
  const names = new Set(taken.map((value) => value.toLowerCase()));
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = `${[...name].slice(0, 64 - suffix.length).join('').trimEnd()}${suffix}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}

/** The installed theme with the same name, case aside; a user theme before a built-in. */
export function clashOf(name: string, entries: readonly ThemeListEntry[]): Omit<ThemeInstallClash, 'keepBothName'> | undefined {
  const same = entries.filter((entry): entry is Extract<ThemeListEntry, { status: 'ok' }> => entry.status === 'ok' && entry.name.toLowerCase() === name.toLowerCase());
  const entry = same.find((candidate) => !candidate.builtin) ?? same[0];
  if (!entry) return undefined;
  const origin = entry.theme.origin;
  const unedited = origin !== undefined && OUTSIDE_ORIGINS.has(origin.kind) && origin.installedHash === contentHash(entry.theme);
  return { themeId: entry.id, name: entry.name, replaceable: !entry.builtin, keepsCopy: !entry.builtin && !unedited };
}

/** The clash an install meets; a store Update never clashes with the theme it updates, and with another one offers Keep both only. */
export function installClash(name: string, entries: readonly ThemeListEntry[], updateThemeId?: string): ThemeInstallClash | undefined {
  const found = clashOf(name, updateThemeId === undefined ? entries : entries.filter((entry) => entry.id !== updateThemeId));
  if (!found) return undefined;
  const taken = entries.flatMap((entry) => (entry.status === 'ok' ? [entry.name] : []));
  return { ...found, ...(updateThemeId !== undefined ? { replaceable: false, keepsCopy: false } : {}), keepBothName: keepBothName(name, taken) };
}

// A theme name, so it stays as written in every UI language, like Keep both's number.
const YOUR_EDITS_SUFFIX = ' (your edits)';

/** The copy name a store Update saves the user's edits of `target` under; undefined when it is as it was installed. */
export function yourEditsNameOf(target: Extract<ThemeListEntry, { status: 'ok' }>, entries: readonly ThemeListEntry[]): string | undefined {
  if (target.theme.origin?.installedHash === contentHash(target.theme)) return undefined;
  const name = `${[...target.name].slice(0, 64 - YOUR_EDITS_SUFFIX.length).join('').trimEnd()}${YOUR_EDITS_SUFFIX}`;
  const taken = entries.flatMap((entry) => (entry.status === 'ok' ? [entry.name] : []));
  return taken.some((other) => other.toLowerCase() === name.toLowerCase()) ? keepBothName(name, taken) : name;
}

/** The installed theme a store Update replaces, while it is still the one installed from that entry. */
export function updateTarget(store: StagedStore, entries: readonly ThemeListEntry[]): Extract<ThemeListEntry, { status: 'ok' }> | undefined {
  const update = store.update;
  if (!update) return undefined;
  const entry = entries.find((candidate) => candidate.id === update.themeId);
  return entry?.status === 'ok' && !entry.builtin && entry.theme.origin?.kind === 'store' && entry.theme.origin.store?.entryId === store.entryId ? entry : undefined;
}

function placementsOf(theme: ThemeFile, sha256: string): ThemeInstallPlacement[] {
  return LOOK_KINDS.flatMap((look) => (theme.looks[look]?.wallpapers ?? []).flatMap((set): ThemeInstallPlacement[] => [
    ...(set.span?.asset === sha256 ? [{ look, panels: [...set.span.panels], span: true }] : []),
    ...(() => {
      const panels = (Object.entries(set.panels ?? {}) as [Panel, { asset: string }][]).filter(([, value]) => value.asset === sha256).map(([panel]) => panel);
      return panels.length > 0 ? [{ look, panels: PANELS.filter((panel) => panels.includes(panel)), span: false }] : [];
    })(),
  ]));
}

const textOf = (value: string | undefined, max: number): string | undefined => (value === undefined ? undefined : oneLine(value, max));

function aboutOf(theme: ThemeFile): ThemeInstallAbout {
  const description = textOf(theme.description, OUTSIDE_TEXT.description);
  const author = textOf(theme.author, OUTSIDE_TEXT.author);
  const version = textOf(theme.version, OUTSIDE_TEXT.version);
  const license = textOf(theme.license, OUTSIDE_TEXT.license);
  return {
    name: oneLine(theme.name, 64) ?? theme.id,
    ...(description !== undefined ? { description } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(license !== undefined ? { license } : {}),
  };
}

function fontsOf(theme: ThemeFile): ThemeInstallFont[] {
  return (['ui', 'mono'] as const).flatMap((role): ThemeInstallFont[] => {
    const choice = theme.style?.fonts?.[role];
    if (!choice) return [];
    if ('installed' in choice) return [{ family: choice.installed, role, source: 'installed', license: {} }];
    const asset = theme.assets?.[choice.asset];
    return [{ family: choice.family, role, source: 'bundled', ...(asset ? { bytes: asset.bytes } : {}), license: { ...(asset?.license ?? {}) } }];
  });
}

function cssOf(theme: ThemeFile, original: ThemeFile['css'], dropped: readonly CssDroppedPart[]): ThemeInstallCss[] {
  return CSS_REGIONS.flatMap((region): ThemeInstallCss[] => {
    const text = original?.[region];
    if (text === undefined && theme.css?.[region] === undefined) return [];
    return [{ region, bytes: new TextEncoder().encode(text ?? theme.css?.[region] ?? '').length, dropped: dropped.filter((part) => part.region === region) }];
  });
}

function contrastOf(theme: ThemeFile): ThemeContrastIssue[] {
  return LOOK_KINDS.flatMap((kind) => {
    const look = theme.looks[kind];
    return look ? checkPalette(deriveLook(look.colors, kind, look.tokens), kind).map((issue) => ({ ...issue, look: kind })) : [];
  });
}

/** What the theme renderer derived from a wallpaper or sprite, as the install needs it. */
export interface StagedAnalysis {
  // allowed: this computer's user allowed the flagged file to flash
  readonly flash?: { readonly flagged: boolean; readonly atMs?: number; readonly allowed?: boolean };
  readonly thumb?: Uint8Array;
  // the decoded size, which a JPEG's EXIF orientation may turn
  readonly width?: number;
  readonly height?: number;
}

/** A store entry's staged file, its pin already checked; update names the installed theme from that entry it replaces. */
export interface StagedStore {
  readonly entryId: string;
  readonly version: string;
  readonly sha256: string;
  readonly update?: { readonly themeId: string; readonly fromVersion: string };
}

/** What a staged install is read from: bytes already downloaded or read, and where from. */
export interface StageInput {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly source: ThemeInstallSource;
  readonly url?: string;
  readonly store?: StagedStore;
}

export interface StagedInstall {
  readonly id: string;
  readonly createdAt: number;
  readonly source: ThemeInstallSource;
  readonly url?: string;
  readonly store?: StagedStore;
  readonly imported: ImportedTheme;
  // blobs this install stored that were not stored before it, each with the write time it had then
  readonly newBlobs: ReadonlyMap<string, number>;
  preview: ThemeInstallPreview;
  // the flash checks and thumbnails still running, by sha256
  readonly analyses: Map<string, Promise<void>>;
  readonly results: Map<string, StagedAnalysis>;
}

export interface ThemeInstallDeps {
  list(): Promise<ThemeListEntry[]>;
  // stores the assets as blobs under the lane; each that was not stored before, with its file's write time
  putBlobs(assets: ReadonlyMap<string, Uint8Array>): Promise<ReadonlyMap<string, number>>;
  // removes the blobs of `staged` that nothing names, the other staged installs included, and that nothing stored again since
  // (a blob whose write time moved on is in use by whoever stored it, the theme editor's unsaved draft included)
  dropBlobs(staged: ReadonlyMap<string, number>): Promise<void>;
  // `signal` ends the check once no staged install waits on that file
  analyzeWallpaper(sha256: string, asset: AssetMeta, signal: AbortSignal): Promise<StagedAnalysis>;
  analyzeSprite(sha256: string, asset: AssetMeta, signal: AbortSignal): Promise<StagedAnalysis>;
  newId(): string;
  now(): number;
  readonly e2eFolder?: string;
  readonly log?: (line: string) => void;
}

/** What commit gets from a staged install: the theme with its assets' flash checks, and how to install it. */
export interface InstallToCommit {
  readonly staged: StagedInstall;
  readonly theme: ThemeFile;
}

export interface ThemeInstalls {
  prepare(from: ThemeInstallFrom, options?: { readonly agent?: boolean; readonly signal?: AbortSignal }): Promise<ThemeInstallPreview>;
  // bytes the caller downloaded and checked, read into a staged install as prepare reads a file
  stage(input: StageInput): Promise<ThemeInstallPreview>;
  // the staged install once its running checks ended, with the assets' flash checks in its theme; undefined when it is gone
  settled(installId: string): Promise<InstallToCommit | undefined>;
  // drops the staged install without touching its blobs (commit made them a theme's)
  forget(installId: string): void;
  // the card's clash (and a store Update's your-edits copy name) as commit found them, told to the card's listeners; the new
  // preview, or undefined when the install is gone
  setClash(installId: string, clash: ThemeInstallClash | undefined, yourEditsName?: string): ThemeInstallPreview | undefined;
  cancel(installId: string): Promise<void>;
  open(installId: string): boolean;
  // drops installs older than STAGED_INSTALL_TTL_MS that their own timers have not dropped yet
  sweep(): Promise<number>;
  // the theme texts the staged installs name, so the blob collector keeps their blobs
  references(): string[];
  // whether the staged install lists `sha256` as a wallpaper its flash check flagged
  flagged(installId: string, sha256: string): boolean;
  // the user allowed `sha256` to flash on this computer: every staged install listing it says so
  flashAllowed(sha256: string): void;
  // the theme renderer's progress on `sha256`, told for each staged install whose check of it runs
  progress(sha256: string, fraction: number): void;
  onUpdated(listener: (preview: ThemeInstallPreview) => void): Disposable;
  onProgress(listener: (progress: ThemeInstallProgress) => void): Disposable;
  // an install that waited past STAGED_INSTALL_TTL_MS was dropped
  onExpired(listener: (installId: string) => void): Disposable;
}

const thumbUrl = (bytes: Uint8Array): string => `data:image/webp;base64,${Buffer.from(bytes).toString('base64')}`;

function flashOf(asset: AssetMeta, analysis: StagedAnalysis | undefined, running: boolean): Pick<ThemeInstallWallpaper, 'flash' | 'atMs' | 'allowed'> {
  if (!isMoving(asset.kind as WallpaperKind)) return { flash: 'none' };
  if (running) return { flash: 'pending' };
  if (!analysis?.flash) return { flash: 'unchecked' };
  if (!analysis.flash.flagged) return { flash: 'clear' };
  return { flash: 'flagged', ...(analysis.flash.atMs !== undefined ? { atMs: analysis.flash.atMs } : {}), ...(analysis.flash.allowed === true ? { allowed: true as const } : {}) };
}

/** What the card asks about besides Install: a name clash, and a store Update's copy of the user's edits. */
interface CardQuestions {
  readonly clash?: ThemeInstallClash;
  readonly yourEditsName?: string;
}

function storeOf(store: StagedStore, yourEditsName: string | undefined): ThemeInstallStore {
  const { update } = store;
  return {
    entryId: store.entryId,
    version: store.version,
    ...(update ? { update: { themeId: update.themeId, fromVersion: update.fromVersion, ...(yourEditsName !== undefined ? { yourEditsName } : {}) } } : {}),
  };
}

export function createThemeInstalls(deps: ThemeInstallDeps): ThemeInstalls {
  const staged = new Map<string, StagedInstall>();
  const listeners = new Set<(preview: ThemeInstallPreview) => void>();
  const progressListeners = new Set<(progress: ThemeInstallProgress) => void>();
  const expiredListeners = new Set<(installId: string) => void>();
  const expiry = new Map<string, ReturnType<typeof setTimeout>>();
  // One check per file, keyed by its kind and SHA-256, shared by every staged install that names the file and ended only
  // when the last of them is dropped: its result is stored by content, so the others still wait on it.
  const checks = new Map<string, { readonly result: Promise<StagedAnalysis>; readonly stop: AbortController; readonly waiting: Set<string> }>();
  // installs being read or downloaded, which hold a place among the staged ones before they are staged
  let reserved = 0;

  // One listener's error never reaches the others, or the change that told them.
  const tell = <T>(heard: ReadonlySet<(value: T) => void>, value: T): void => {
    for (const listener of [...heard]) {
      try {
        listener(value);
      } catch (err) {
        deps.log?.(`[themes] an install listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const previewOf = (install: Omit<StagedInstall, 'preview'>, asked: CardQuestions, totalBytes: number): ThemeInstallPreview => {
    const { clash, yourEditsName } = asked;
    const { theme, droppedCss, warnings, format } = install.imported;
    let thumbBudget = MAX_PREVIEW_THUMB_BYTES;
    const wallpapers = Object.entries(theme.assets ?? {}).filter(([, asset]) => isWallpaperAsset(asset)).map(([sha256, asset]): ThemeInstallWallpaper => {
      const result = install.results.get(sha256);
      const thumb = result?.thumb !== undefined && result.thumb.length <= thumbBudget ? result.thumb : undefined;
      if (thumb) thumbBudget -= thumb.length;
      return {
        sha256,
        kind: asset.kind as ThemeInstallWallpaper['kind'],
        mime: asset.mime,
        bytes: asset.bytes,
        width: result?.width ?? asset.width ?? 0,
        height: result?.height ?? asset.height ?? 0,
        ...(asset.frames !== undefined ? { frames: asset.frames } : {}),
        ...(asset.durationMs !== undefined ? { durationMs: asset.durationMs } : {}),
        placements: placementsOf(theme, sha256),
        ...flashOf(asset, result, install.analyses.has(sha256)),
        ...(thumb ? { thumb: thumbUrl(thumb) } : {}),
      };
    });
    const characters = theme.characters ? { name: oneLine(theme.characters.name, 64) ?? '', count: theme.characters.characters.length } : undefined;
    return {
      installId: install.id,
      source: install.source,
      format,
      about: aboutOf(theme),
      theme,
      wallpapers,
      fonts: fontsOf(theme),
      css: cssOf(theme, install.imported.originalCss, droppedCss),
      ...(install.imported.droppedCssMore > 0 ? { cssDroppedMore: install.imported.droppedCssMore } : {}),
      ...(characters ? { characters } : {}),
      arrangement: theme.layout !== undefined,
      contrast: contrastOf(theme),
      totalBytes,
      warnings: [...warnings],
      ...(clash ? { clash } : {}),
      ...(install.store ? { store: storeOf(install.store, yourEditsName) } : {}),
    };
  };

  const shownQuestions = (install: StagedInstall): CardQuestions => {
    const yourEditsName = install.preview.store?.update?.yourEditsName;
    return { ...(install.preview.clash ? { clash: install.preview.clash } : {}), ...(yourEditsName !== undefined ? { yourEditsName } : {}) };
  };

  const updated = (install: StagedInstall, asked: CardQuestions = shownQuestions(install)): void => {
    install.preview = { ...previewOf(install, asked, install.preview.totalBytes) };
    tell(listeners, install.preview);
  };

  // Each wallpaper and each sprite that moves goes through the theme renderer; the card hears as each check ends.
  const analyzeAll = (install: StagedInstall): void => {
    const { theme } = install.imported;
    const sprites = new Set(characterAssets(theme));
    for (const [sha256, asset] of Object.entries(theme.assets ?? {})) {
      const sprite = asset.kind === 'sprite' && sprites.has(sha256);
      const needs = isWallpaperAsset(asset) || (sprite && (spriteStrip(asset) !== undefined || (asset.frames ?? 1) > 1 || asset.mime === 'image/svg+xml'));
      if (!needs) continue;
      const checkKey = `${sprite ? 'sprite' : 'wallpaper'}:${sha256}`;
      let check = checks.get(checkKey);
      if (!check) {
        const stop = new AbortController();
        const started = { result: sprite ? deps.analyzeSprite(sha256, asset, stop.signal) : deps.analyzeWallpaper(sha256, asset, stop.signal), stop, waiting: new Set<string>() };
        const ended = (): void => {
          if (checks.get(checkKey) === started) checks.delete(checkKey);
        };
        started.result.then(ended, ended);
        checks.set(checkKey, started);
        check = started;
      }
      check.waiting.add(install.id);
      const run = check.result
        .then((result) => {
          install.results.set(sha256, result);
        }, (err: unknown) => {
          deps.log?.(`[themes] the install ${install.id} could not analyze ${sha256}: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          install.analyses.delete(sha256);
          if (staged.get(install.id) === install) updated(install);
        });
      install.analyses.set(sha256, run);
    }
  };

  const unstage = (installId: string): void => {
    staged.delete(installId);
    clearTimeout(expiry.get(installId));
    expiry.delete(installId);
  };

  const drop = async (installId: string): Promise<void> => {
    const install = staged.get(installId);
    if (!install) return;
    unstage(installId);
    // a check another staged install still waits on runs on, and its blob stays, since that install names it
    const ended: Promise<void>[] = [];
    for (const [checkKey, check] of [...checks]) {
      if (!check.waiting.delete(installId) || check.waiting.size > 0) continue;
      // a later install of the same file starts its own check
      checks.delete(checkKey);
      check.stop.abort();
      ended.push(check.result.then(() => undefined, () => undefined));
    }
    await Promise.all(ended);
    await deps.dropBlobs(install.newBlobs);
  };

  const expire = async (installId: string): Promise<void> => {
    if (!staged.has(installId)) return;
    await drop(installId);
    tell(expiredListeners, installId);
  };

  const sweep = async (): Promise<number> => {
    const old = [...staged.values()].filter((install) => deps.now() - install.createdAt > STAGED_INSTALL_TTL_MS);
    for (const install of old) await expire(install.id);
    return old.length;
  };

  // A place among the staged installs, checked and taken with no await between: the returned release gives it back, once.
  const reserve = (): (() => void) => {
    if (staged.size + reserved >= MAX_STAGED_INSTALLS) throw new LocalizedError(l('{0} theme installs are already open. Install or cancel one first.', String(MAX_STAGED_INSTALLS)));
    reserved++;
    let held = true;
    return () => {
      if (held) reserved--;
      held = false;
    };
  };

  // `release` is the caller's reserved place, given back as the install takes its own.
  const stageIn = async ({ bytes, fileName, source, url, store }: StageInput, release: () => void): Promise<ThemeInstallPreview> => {
    const read = await readImport(bytes, fileName, deps.newId());
    if (store && read.format !== 'damocles') throw new LocalizedError(l('The store file of {0} is not a Damocles theme file, so nothing was installed.', verbatim(store.entryId)));
    const entries = await deps.list();
    const target = store?.update ? updateTarget(store, entries) : undefined;
    if (store?.update && !target) throw new LocalizedError(l('The theme this would update is no longer installed. Open Browse and try again.'));
    const newBlobs = read.assets.size > 0 ? await deps.putBlobs(read.assets) : new Map<string, number>();
    let install: StagedInstall;
    let asked: CardQuestions;
    try {
      // the bytes live in blobs from here on
      const imported: ImportedTheme = { ...read, assets: new Map() };
      const clash = installClash(imported.theme.name, entries, target?.id);
      const yourEditsName = target ? yourEditsNameOf(target, entries) : undefined;
      asked = { ...(clash ? { clash } : {}), ...(yourEditsName !== undefined ? { yourEditsName } : {}) };
      const id = randomUUID();
      const base = {
        id, createdAt: deps.now(), source, ...(url !== undefined ? { url } : {}), ...(store ? { store } : {}), imported, newBlobs,
        analyses: new Map<string, Promise<void>>(), results: new Map<string, StagedAnalysis>(),
      };
      install = { ...base, preview: previewOf(base, asked, bytes.length) };
    } catch (err) {
      // nothing names the blobs yet, so a stage that fails here takes them back
      await deps.dropBlobs(newBlobs);
      throw err;
    }
    release();
    staged.set(install.id, install);
    const timer = setTimeout(() => {
      expire(install.id).catch((err: unknown) => deps.log?.(`[themes] the expired install ${install.id} was not dropped: ${err instanceof Error ? err.message : String(err)}`));
    }, STAGED_INSTALL_TTL_MS);
    // never the reason core stays alive
    timer.unref();
    expiry.set(install.id, timer);
    analyzeAll(install);
    install.preview = previewOf(install, asked, bytes.length);
    return install.preview;
  };

  const stage = async (input: StageInput): Promise<ThemeInstallPreview> => {
    await sweep();
    const release = reserve();
    try {
      return await stageIn(input, release);
    } finally {
      release();
    }
  };

  const prepareIn = async (from: ThemeInstallFrom, options: { readonly agent?: boolean; readonly signal?: AbortSignal }, release: () => void): Promise<ThemeInstallPreview> => {
    const signal = options.signal ?? new AbortController().signal;
    let bytes: Uint8Array;
    let source: ThemeInstallSource;
    let url: string | undefined;
    let fileName: string;
    if (from.kind === 'file') {
      bytes = await readCappedFile(from.path, MAX_ARCHIVE_BYTES);
      fileName = path.basename(from.path);
      source = { kind: 'file', fileName: oneLine(fileName, MAX_FILE_NAME_CHARS) ?? '' };
    } else {
      const downloaded = await downloadTheme(from.url, { signal, ...(deps.e2eFolder !== undefined ? { e2eFolder: deps.e2eFolder } : {}) });
      ({ bytes, fileName } = downloaded);
      url = new URL(from.url).href;
      source = { kind: options.agent === true ? 'agent' : from.kind, host: downloaded.host, ...(fileName !== '' ? { fileName } : {}) };
    }
    return stageIn({ bytes, fileName, source, ...(url !== undefined ? { url } : {}) }, release);
  };

  return {
    stage,
    async prepare(from, options = {}) {
      await sweep();
      // one place held across the read or download and the staging
      const release = reserve();
      try {
        return await prepareIn(from, options, release);
      } finally {
        release();
      }
    },
    async settled(installId) {
      const install = staged.get(installId);
      if (!install) return undefined;
      await Promise.allSettled([...install.analyses.values()]);
      if (staged.get(installId) !== install) return undefined;
      const { theme } = install.imported;
      const assets = Object.fromEntries(Object.entries(theme.assets ?? {}).map(([sha256, asset]) => {
        const result = install.results.get(sha256);
        const sized = result?.width !== undefined && result.height !== undefined && isWallpaperAsset(asset) ? { width: result.width, height: result.height } : {};
        const flash = result?.flash ? { flash: { flagged: result.flash.flagged, ...(result.flash.atMs !== undefined ? { atMs: result.flash.atMs } : {}) } } : {};
        return [sha256, { ...asset, ...sized, ...flash }];
      }));
      return { staged: install, theme: Object.keys(assets).length > 0 ? { ...theme, assets } : theme };
    },
    forget(installId) {
      unstage(installId);
    },
    setClash(installId, clash, yourEditsName) {
      const install = staged.get(installId);
      if (!install) return undefined;
      updated(install, { ...(clash ? { clash } : {}), ...(yourEditsName !== undefined ? { yourEditsName } : {}) });
      return install.preview;
    },
    cancel: (installId) => drop(installId),
    open: (installId) => staged.has(installId),
    sweep,
    references: () => [...staged.values()].map((install) => JSON.stringify(install.imported.theme)),
    flagged: (installId, sha256) => staged.get(installId)?.preview.wallpapers.some((wallpaper) => wallpaper.sha256 === sha256 && wallpaper.flash === 'flagged') === true,
    flashAllowed(sha256) {
      for (const install of staged.values()) {
        const result = install.results.get(sha256);
        if (!result?.flash?.flagged || result.flash.allowed === true) continue;
        install.results.set(sha256, { ...result, flash: { ...result.flash, allowed: true } });
        updated(install);
      }
    },
    progress(sha256, fraction) {
      for (const install of staged.values()) {
        if (!install.analyses.has(sha256)) continue;
        tell(progressListeners, { installId: install.id, sha256, fraction });
      }
    },
    onUpdated(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    onProgress(listener) {
      progressListeners.add(listener);
      return { dispose: () => progressListeners.delete(listener) };
    },
    onExpired(listener) {
      expiredListeners.add(listener);
      return { dispose: () => expiredListeners.delete(listener) };
    },
  };
}

/** An origin kind for what was installed: a store entry, a VS Code theme, a file picked on this computer, or a download. */
export function originKind(staged: StagedInstall): 'store' | 'import' | 'vscode' | 'link' {
  if (staged.store) return 'store';
  if (staged.imported.format === 'vscode') return 'vscode';
  return staged.source.kind === 'file' ? 'import' : 'link';
}
