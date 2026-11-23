// Settings' theme sharing (Import, Install from link, Export) and the damocles:// links, which end at the same install card;
// main checks what the overlay sends and reaches core only through these CoreClient calls.
import { APP_ORIGIN } from '../../app-urls';
import type { LocalizedText } from '../../../shared/localized-text';
import { FONT_NAME, MAX_FONT_BYTES } from '../../../shared/themes/fonts';
import { THEME_ID } from '../../../shared/themes/limits';
import { MAX_EXPORT_FONTS } from '../../../shared/themes/install';
import type { ThemeExportFontBytes, ThemeExportPlanned, ThemeExportWritten, ThemeInstallClashChoice, ThemeInstallCommit, ThemeInstallCommitted, ThemeInstallFrom, ThemeInstallPrepared, ThemeInstallPreview, ThemeInstallProgress } from '../../../shared/themes/install';
import { STORE_ENTRY_ID, type StoreThumb, type StoreView } from '../../../shared/themes/store';
import {
  OVERLAY_CHANNELS, type OverlayInstallCurrent, type OverlayStoreEntry, type OverlayStoreResult, type OverlayStoreThumb, type OverlayStoreView, type ThemeExportPlanResult, type ThemeExportSaveResult,
  type ThemeInstallCommitResult, type ThemeInstallStart,
} from '../../preload/overlay-channels';
import { MAX_WAITING_LINKS, ThemeLinkQueue, type CardClaim } from './link-queue';
import { parsePastedInstallUrl, parseThemeLink } from '../../../shared/themes/theme-links';
import { themeLinkInArgv } from './theme-links';

/** The core calls sharing makes (CoreClient's). */
export interface ThemeSharingCore {
  themesInstallPrepare(params: { readonly from: ThemeInstallFrom }, signal?: AbortSignal): Promise<ThemeInstallPrepared>;
  themesInstallCommit(params: ThemeInstallCommit): Promise<ThemeInstallCommitted>;
  themesInstallCancel(installId: string): Promise<void>;
  themesInstallAllowFlash(installId: string, sha256: string): Promise<boolean>;
  themesExportPlan(params: { readonly themeId: string; readonly installedFonts?: readonly ThemeExportFontBytes[] }): Promise<ThemeExportPlanned>;
  themesExportWrite(params: { readonly themeId: string; readonly path: string; readonly installedFonts: readonly ThemeExportFontBytes[] }): Promise<ThemeExportWritten>;
  themesStoreList(refresh: boolean): Promise<StoreView>;
  themesStoreInstall(entryId: string, signal?: AbortSignal): Promise<ThemeInstallPrepared>;
}

/** A kept store thumbnail as the overlay loads it: main serves it from the store's thumbs folder by its sha256. */
export const storeThumbUrl = (sha256: string): string => `${APP_ORIGIN}/store-thumb/${sha256}`;

/** Core's store view as Browse shows it: the reason in the UI's language, each verified thumbnail as its app:// URL. */
export function overlayStoreView(view: StoreView, render: (text: LocalizedText) => string): OverlayStoreView {
  const thumbs = (list: readonly StoreThumb[] | undefined): OverlayStoreThumb[] | undefined => list?.map((thumb) => ({ panel: thumb.panel, url: storeThumbUrl(thumb.sha256) }));
  return {
    state: view.state,
    ...(view.fetchedAt !== undefined ? { fetchedAt: view.fetchedAt } : {}),
    ...(view.refusedReason !== undefined ? { refusedReason: render(view.refusedReason) } : {}),
    entries: view.entries.map((entry): OverlayStoreEntry => {
      const dark = thumbs(entry.thumbnails.dark);
      const light = thumbs(entry.thumbnails.light);
      return { ...entry, thumbnails: { ...(dark ? { dark } : {}), ...(light ? { light } : {}) } };
    }),
  };
}

/** The part of the overlay sharing answers on: its handlers act only while Settings is open. */
export interface SharingOverlay {
  handleWhileOpen<T>(channel: string, isOpen: () => boolean, handler: (...args: unknown[]) => T | Promise<T>): void;
  send(channel: string, payload: unknown): void;
}

export interface ThemeSharingDeps {
  // this computer's core; undefined while it is not running
  readonly core: () => ThemeSharingCore | undefined;
  // opens Settings › Appearance and hands its modal the card once it shows; false when Settings could not open
  readonly openInstallCard: (preview: ThemeInstallPreview) => Promise<boolean>;
  // main's file dialog for Import; undefined on cancel
  readonly pickImportFile: () => Promise<string | undefined>;
  // main's save dialog proposing fileName; undefined on cancel
  readonly pickExportPath: (fileName: string) => Promise<string | undefined>;
  // a warning toast in the UI's language
  readonly notify: (message: string) => void;
  readonly t: (message: string, ...args: string[]) => string;
  readonly render: (text: LocalizedText) => string;
  readonly log: (line: string) => void;
  // a store list was read: the installed cards' update badges come from core's theme list, which Settings reads again; a theme
  // change reaches Settings through themes.changed, so the store view that follows one does not call this
  readonly storeChanged: () => void;
}

const INSTALL_ID = /^[0-9A-Za-z_-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_URL_CHARS = 4096;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const keysOf = (value: Record<string, unknown>): string => Object.keys(value).sort().join(',');
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// A failure whose message is already the user's: rendered in the UI's language. Any other error's text goes to the log only.
class UserError extends Error {}
const hostOf = (url: string): string => (URL.canParse(url) ? new URL(url).host : url);

/** installedFonts exactly as the overlay may send them; undefined for anything else. */
export function parseInstalledFonts(raw: unknown): ThemeExportFontBytes[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_EXPORT_FONTS) return undefined;
  const fonts: ThemeExportFontBytes[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || keysOf(entry) !== 'bytes,family') return undefined;
    const { family, bytes } = entry;
    if (typeof family !== 'string' || !FONT_NAME.test(family) || !(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_FONT_BYTES) return undefined;
    if (fonts.some((font) => font.family === family)) return undefined;
    fonts.push({ family, bytes });
  }
  return fonts;
}

/** An install commit exactly as the overlay may send it; undefined for anything else. */
export function parseInstallCommit(raw: unknown): ThemeInstallCommit | undefined {
  if (!isRecord(raw)) return undefined;
  const keys = keysOf(raw);
  const { installId, useArrangement, onClash } = raw;
  if (keys !== 'installId,useArrangement' && keys !== 'installId,onClash,useArrangement') return undefined;
  if (typeof installId !== 'string' || !INSTALL_ID.test(installId) || typeof useArrangement !== 'boolean') return undefined;
  if (onClash !== undefined && onClash !== 'keepBoth' && onClash !== 'replace') return undefined;
  return { installId, useArrangement, ...(onClash !== undefined ? { onClash: onClash as ThemeInstallClashChoice } : {}) };
}

/**
 * One install card at a time, whichever way it came: Settings' Import and Install from link answer the overlay with the
 * preview, a link opens Settings on it. A link waits for the window and core, never installs, and only the card's Install,
 * the overlay's commit of the open card, writes a theme.
 */
export class ThemeSharing {
  private readonly deps: ThemeSharingDeps;
  private readonly queue: ThemeLinkQueue<ThemeInstallPreview>;
  private overlay: SharingOverlay | undefined;
  // ends every prepare when the app quits
  private readonly quit = new AbortController();
  // the prepare Settings started (Import, Install from link, Browse), which ends when Settings closes or the page cancels it
  private preparing: AbortController | undefined;
  // The open card as the page reads it (themesInstallCurrent): its newest preview, and the id of an install that expired while
  // its card was open. Main holds it, so the page shows the same card whenever it mounts and in whatever order pushes land.
  private card: OverlayInstallCurrent = {};
  // the install whose commit core has not answered yet
  private committing: string | undefined;

  constructor(deps: ThemeSharingDeps) {
    this.deps = deps;
    this.queue = new ThemeLinkQueue<ThemeInstallPreview>({
      prepare: (url) => this.prepare({ kind: 'link', url }),
      show: (preview, url) => this.showLinkCard(preview, url),
      cancel: async (installId) => this.requireCore().themesInstallCancel(installId),
      refused: () => deps.notify(deps.t('Damocles opens one theme install at a time, and {0} more theme links are already waiting, so it ignored the newest ones.', String(MAX_WAITING_LINKS))),
      failed: (url, err) => deps.notify(err instanceof UserError ? deps.t('Damocles could not open the theme from {0}: {1}', hostOf(url), err.message) : deps.t('Damocles could not open the theme from {0}.', hostOf(url))),
      log: deps.log,
    });
  }

  /** A command line, a first launch's or a second instance's: the theme link themeLinkInArgv reads from it, if any, joins the queue. */
  takeArgv(argv: readonly string[]): void {
    const found = themeLinkInArgv(argv);
    if (found.kind === 'none') return;
    if (!found.ok) {
      this.deps.log(`[themes] a theme link on the command line opened nothing: ${found.reason}`);
      return;
    }
    this.queue.offer(found.url);
  }

  /** macOS open-url: a link of any scheme the app registered. */
  takeOpenUrl(raw: string): void {
    const parsed = parseThemeLink(raw);
    if (!parsed.ok) {
      this.deps.log(`[themes] a link the OS opened opened nothing: ${parsed.reason}`);
      return;
    }
    this.queue.offer(parsed.url);
  }

  /** The window and this computer's core are ready: waiting links open. */
  markReady(): void {
    this.queue.markReady();
  }

  /** Registers the overlay's sharing channels; returns the detach for the window's close. */
  attach(overlay: SharingOverlay, settingsOpen: () => boolean): () => void {
    this.overlay = overlay;
    overlay.handleWhileOpen(OVERLAY_CHANNELS.themesImport, settingsOpen, (raw) => {
      if (!isRecord(raw) || keysOf(raw) !== '') throw new Error('Malformed theme import request');
      return this.startInstall(undefined, settingsOpen);
    });
    overlay.handleWhileOpen(OVERLAY_CHANNELS.themesInstallUrl, settingsOpen, (raw) => {
      if (!isRecord(raw) || keysOf(raw) !== 'url' || typeof raw['url'] !== 'string' || raw['url'].length > MAX_URL_CHARS) throw new Error('Malformed theme link request');
      return this.startInstall(raw['url'], settingsOpen);
    });
    overlay.handleWhileOpen(OVERLAY_CHANNELS.themesInstallCommit, settingsOpen, (raw) => {
      const commit = parseInstallCommit(raw);
      if (commit === undefined) throw new Error('Malformed theme install commit');
      return this.commit(commit);
    });
    overlay.handleWhileOpen(OVERLAY_CHANNELS.themesInstallCancel, settingsOpen, (raw) => {
      const installId = isRecord(raw) && keysOf(raw) === 'installId' ? raw['installId'] : undefined;
      if (typeof installId !== 'string' || !INSTALL_ID.test(installId)) throw new Error('Malformed theme install cancel');
      this.cancelCard(installId);
    });
    overlay.handleWhileOpen(OVERLAY_CHANNELS.themesInstallCurrent, settingsOpen, (raw) => {
      if (!isRecord(raw) || keysOf(raw) !== '') throw new Error('Malformed theme install read');
      return this.card;
    });
    overlay.handleWhileOpen(OVERLAY_CHANNELS.themesInstallAllowFlash, settingsOpen, (raw) => {
      const installId = isRecord(raw) && keysOf(raw) === 'installId,sha256' ? raw['installId'] : undefined;
      const sha256 = isRecord(raw) ? raw['sha256'] : undefined;
      if (typeof installId !== 'string' || !INSTALL_ID.test(installId) || typeof sha256 !== 'string' || !SHA256.test(sha256)) throw new Error('Malformed theme install allow flashing');
      // only the open card's install, whose wallpaper core checks again
      if (!this.queue.isOpen(installId)) return false;
      return this.requireCore().themesInstallAllowFlash(installId, sha256);
    });
    overlay.handleWhileOpen(OVERLAY_CHANNELS.themesStoreList, settingsOpen, (raw) => {
      if (!isRecord(raw) || keysOf(raw) !== 'refresh' || typeof raw['refresh'] !== 'boolean') throw new Error('Malformed store list request');
      return this.storeList(raw['refresh']);
    });
    overlay.handleWhileOpen(OVERLAY_CHANNELS.themesStoreInstall, settingsOpen, (raw) => {
      const entryId = isRecord(raw) && keysOf(raw) === 'entryId' ? raw['entryId'] : undefined;
      if (typeof entryId !== 'string' || !STORE_ENTRY_ID.test(entryId)) throw new Error('Malformed store install request');
      return this.startStoreInstall(entryId, settingsOpen);
    });
    overlay.handleWhileOpen(OVERLAY_CHANNELS.themesPrepareCancel, settingsOpen, (raw) => {
      if (!isRecord(raw) || keysOf(raw) !== '') throw new Error('Malformed theme prepare cancel');
      this.preparing?.abort();
    });
    overlay.handleWhileOpen(OVERLAY_CHANNELS.themesExportPlan, settingsOpen, (raw) => {
      const keys = isRecord(raw) ? keysOf(raw) : '';
      const themeId = isRecord(raw) ? raw['themeId'] : undefined;
      const fonts = isRecord(raw) && keys === 'installedFonts,themeId' ? parseInstalledFonts(raw['installedFonts']) : undefined;
      if (typeof themeId !== 'string' || !THEME_ID.test(themeId) || (keys !== 'themeId' && fonts === undefined)) throw new Error('Malformed theme export plan request');
      return this.exportPlan(themeId, fonts);
    });
    overlay.handleWhileOpen(OVERLAY_CHANNELS.themesExportSave, settingsOpen, (raw) => {
      const themeId = isRecord(raw) && keysOf(raw) === 'installedFonts,themeId' ? raw['themeId'] : undefined;
      const fonts = isRecord(raw) ? parseInstalledFonts(raw['installedFonts']) : undefined;
      if (typeof themeId !== 'string' || !THEME_ID.test(themeId) || fonts === undefined) throw new Error('Malformed theme export request');
      return this.exportSave(themeId, fonts);
    });
    return () => {
      if (this.overlay === overlay) this.overlay = undefined;
    };
  }

  /** Core's update of a staged install: only the open card's is kept, and the page told to read it. */
  installUpdated(preview: ThemeInstallPreview): void {
    if (!this.queue.isOpen(preview.installId)) return;
    this.card = { preview };
    this.cardChanged();
  }

  /** Core dropped a staged install that waited too long: the open card's closes, and the page says why. */
  installExpired(installId: string): void {
    if (!this.queue.isOpen(installId)) return;
    // before the queue moves on: a waiting link's card replaces this one as it shows
    this.card = { expired: installId };
    this.queue.closed(installId);
    this.cardChanged();
  }

  /** A flash check's progress of a staged install: only the open card's reaches the overlay. */
  installProgress(progress: ThemeInstallProgress): void {
    if (this.queue.isOpen(progress.installId)) this.overlay?.send(OVERLAY_CHANNELS.themesInstallProgress, progress);
  }

  /** Core's store view after a list was read (listRead) or an installed theme changed, for an open Browse and the installed cards. */
  storeUpdated(view: StoreView, listRead: boolean): void {
    this.overlay?.send(OVERLAY_CHANNELS.themesStoreUpdated, overlayStoreView(view, this.deps.render));
    if (listRead) this.deps.storeChanged();
  }

  /** The Settings modal closed: a prepare it started ends, and a card it showed is answered as cancelled. */
  settingsClosed(): void {
    this.preparing?.abort();
    const installId = this.queue.openInstall();
    if (installId !== undefined) this.cancelCard(installId);
  }

  /** The app quits: every prepare ends, waiting links go, and an open card's install is cancelled in core. */
  dispose(): void {
    this.quit.abort();
    const installId = this.queue.dispose();
    if (installId !== undefined) this.cancelInCore(installId);
  }

  private requireCore(): ThemeSharingCore {
    const core = this.deps.core();
    if (!core) throw new UserError(this.deps.t("This computer's Damocles engine is not running."));
    return core;
  }

  private async prepare(from: ThemeInstallFrom): Promise<ThemeInstallPreview> {
    const prepared = await this.requireCore().themesInstallPrepare({ from }, this.quit.signal);
    if ('refused' in prepared) throw new UserError(this.deps.render(prepared.refused));
    return prepared.preview;
  }

  // What a failed action answers the page: the failure's own words when they are the user's, else `generic`.
  private failureText(err: unknown, generic: string): string {
    return err instanceof UserError ? err.message : generic;
  }

  private cardChanged(): void {
    this.overlay?.send(OVERLAY_CHANNELS.themesInstallChanged, {});
  }

  // The card of `installId` closed, or never showed: the queue's slot is free; true when it was the open one.
  private closeCard(installId: string): boolean {
    if (!this.queue.isOpen(installId)) return false;
    // before the queue moves on: a waiting link's card replaces this one as it shows
    this.card = {};
    return this.queue.closed(installId);
  }

  private showLinkCard(preview: ThemeInstallPreview, url: string): void {
    this.card = { preview };
    this.deps.openInstallCard(preview).then((opened) => {
      if (!opened) this.abandonLinkCard(preview.installId, url, 'Settings could not open');
    }, (err: unknown) => this.abandonLinkCard(preview.installId, url, errorText(err)));
  }

  // The user opened a link and nothing shows for it, so a notice says so.
  private abandonLinkCard(installId: string, url: string, reason: string): void {
    this.deps.log(`[themes] a theme link's install card did not show: ${reason}`);
    if (!this.closeCard(installId)) return;
    this.cancelInCore(installId);
    this.deps.notify(this.deps.t('Damocles could not show the theme from {0}, because Settings could not open.', hostOf(url)));
  }

  // Import (url undefined) or Install from link: the card slot, then the pick or the URL, then core's prepare.
  private async startInstall(rawUrl: string | undefined, settingsOpen: () => boolean): Promise<ThemeInstallStart> {
    const { t } = this.deps;
    let from: ThemeInstallFrom | undefined;
    if (rawUrl !== undefined) {
      const parsed = parsePastedInstallUrl(rawUrl);
      if (!parsed.ok) {
        this.deps.log(`[themes] Install from link refused a URL: ${parsed.reason}`);
        return { ok: false, error: t('Enter an https link, such as https://example.com/aurora.damocles-theme.') };
      }
      from = { kind: 'url', url: parsed.url };
    }
    const claim = this.queue.claim(from?.kind === 'url' ? from.url : undefined);
    if (claim === undefined) return { ok: false, error: t('Another theme install is open. Install or cancel it first.') };
    const preparing = this.startPreparing();
    try {
      if (from === undefined) {
        const file = await this.deps.pickImportFile();
        if (file === undefined) {
          claim.release();
          return { ok: false, cancelled: true };
        }
        from = { kind: 'file', path: file };
      }
      const prepared = await this.requireCore().themesInstallPrepare({ from }, preparing.signal);
      if ('refused' in prepared) {
        claim.release();
        return { ok: false, error: this.deps.render(prepared.refused) };
      }
      return this.openCard(claim, prepared.preview, settingsOpen);
    } catch (err) {
      claim.release();
      if (preparing.ended()) return { ok: false, cancelled: true };
      this.deps.log(`[themes] preparing an install failed: ${errorText(err)}`);
      return { ok: false, error: this.failureText(err, t('Damocles could not prepare this theme install. Try again.')) };
    } finally {
      preparing.done();
    }
  }

  private async storeList(refresh: boolean): Promise<OverlayStoreResult> {
    try {
      return { ok: true, view: overlayStoreView(await this.requireCore().themesStoreList(refresh), this.deps.render) };
    } catch (err) {
      this.deps.log(`[themes] reading the community store list failed: ${errorText(err)}`);
      return { ok: false, error: this.failureText(err, this.deps.t('Damocles could not read the community store list.')) };
    }
  }

  // Browse's Install or Update: the card slot, then core's download, pin check and stage, the same card as Install from link.
  private async startStoreInstall(entryId: string, settingsOpen: () => boolean): Promise<ThemeInstallStart> {
    const claim = this.queue.claim();
    if (claim === undefined) return { ok: false, error: this.deps.t('Another theme install is open. Install or cancel it first.') };
    const preparing = this.startPreparing();
    try {
      const prepared = await this.requireCore().themesStoreInstall(entryId, preparing.signal);
      if ('refused' in prepared) {
        claim.release();
        return { ok: false, error: this.deps.render(prepared.refused) };
      }
      return this.openCard(claim, prepared.preview, settingsOpen);
    } catch (err) {
      claim.release();
      if (preparing.ended()) return { ok: false, cancelled: true };
      this.deps.log(`[themes] preparing the store install of ${entryId} failed: ${errorText(err)}`);
      return { ok: false, error: this.failureText(err, this.deps.t('Damocles could not prepare this theme install. Try again.')) };
    } finally {
      preparing.done();
    }
  }

  // One prepare at a time, since each holds the card slot: its signal ends it, and `ended` says a failure was that end.
  private startPreparing(): { readonly signal: AbortSignal; ended(): boolean; done(): void } {
    const controller = new AbortController();
    this.preparing = controller;
    const signal = AbortSignal.any([controller.signal, this.quit.signal]);
    return {
      signal,
      ended: () => signal.aborted,
      done: () => {
        if (this.preparing === controller) this.preparing = undefined;
      },
    };
  }

  // Settings closed while core prepared: no card shows, so core drops what it staged.
  private openCard(claim: CardClaim, preview: ThemeInstallPreview, settingsOpen: () => boolean): ThemeInstallStart {
    if (!settingsOpen()) {
      claim.release();
      this.cancelInCore(preview.installId);
      return { ok: false, cancelled: true };
    }
    claim.opened(preview.installId);
    this.card = { preview };
    return { ok: true, preview };
  }

  private async commit(commit: ThemeInstallCommit): Promise<ThemeInstallCommitResult> {
    if (!this.queue.isOpen(commit.installId)) return { ok: false, error: this.deps.t('This theme install is no longer open.') };
    // one commit of a card reaches core: a second press while the first is in flight changes nothing
    if (this.committing === commit.installId) return { ok: false, error: this.deps.t('This theme is already being installed.') };
    this.committing = commit.installId;
    try {
      const committed = await this.requireCore().themesInstallCommit(commit);
      if ('refused' in committed) return { ok: false, error: this.deps.render(committed.refused) };
      this.closeCard(commit.installId);
      return { ok: true, installed: committed.installed };
    } catch (err) {
      this.deps.log(`[themes] installing a theme failed: ${errorText(err)}`);
      return { ok: false, error: this.failureText(err, this.deps.t('Damocles could not install this theme. Try again.')) };
    } finally {
      this.committing = undefined;
    }
  }

  private cancelCard(installId: string): void {
    if (this.closeCard(installId)) this.cancelInCore(installId);
  }

  private cancelInCore(installId: string): void {
    const core = this.deps.core();
    if (!core) {
      this.deps.log('[themes] an install was left staged: the engine is not running, and its next start sweeps it');
      return;
    }
    core.themesInstallCancel(installId).catch((err: unknown) => this.deps.log(`[themes] cancelling an install failed: ${errorText(err)}`));
  }

  private async exportPlan(themeId: string, installedFonts: readonly ThemeExportFontBytes[] | undefined): Promise<ThemeExportPlanResult> {
    try {
      const planned = await this.requireCore().themesExportPlan({ themeId, ...(installedFonts !== undefined ? { installedFonts } : {}) });
      return 'refused' in planned ? { ok: false, error: this.deps.render(planned.refused) } : { ok: true, plan: planned.plan };
    } catch (err) {
      this.deps.log(`[themes] planning the export of ${themeId} failed: ${errorText(err)}`);
      return { ok: false, error: this.failureText(err, this.deps.t('Damocles could not export this theme. Try again.')) };
    }
  }

  // The file name comes from core's plan, never from the page.
  private async exportSave(themeId: string, installedFonts: readonly ThemeExportFontBytes[]): Promise<ThemeExportSaveResult> {
    try {
      const core = this.requireCore();
      const planned = await core.themesExportPlan({ themeId });
      if ('refused' in planned) return { ok: false, error: this.deps.render(planned.refused) };
      const target = await this.deps.pickExportPath(planned.plan.fileName);
      if (target === undefined) return { ok: false, cancelled: true };
      const written = await core.themesExportWrite({ themeId, path: target, installedFonts });
      return 'refused' in written ? { ok: false, error: this.deps.render(written.refused) } : { ok: true, path: target, bytes: written.written.bytes };
    } catch (err) {
      this.deps.log(`[themes] exporting ${themeId} failed: ${errorText(err)}`);
      return { ok: false, error: this.failureText(err, this.deps.t('Damocles could not export this theme. Try again.')) };
    }
  }
}
