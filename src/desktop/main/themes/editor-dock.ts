// The theme editor docked at the window's right edge (docs/invariants.md "Desktop host"): its own native view, loading the
// overlay bundle at its editor route under the overlay preload and CSP, placed on the dock slot the shell reserves and reports.
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { WebContentsView, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle } from 'electron';
import { MAX_FONT_BYTES, type FontImport } from '../../../shared/themes/fonts';
import { MAX_WALLPAPER_SETS, type FlashRecord, type WallpaperImport } from '../../../shared/themes/wallpapers';
import { validateTheme, type Arrangement, type ThemeFile, themeErrorEnglish } from '../../../shared/themes/schema';
import type { ThemeShowRefusal } from '../../../shared/themes/agent';
import { MAX_STRIP_FRAMES, MAX_THEME_NAME_CHARS } from '../../../shared/themes/limits';
import { SYSTEM_THEME_ID } from '../../../shared/themes/builtin';
import type { LookKind } from '../../../shared/themes/tokens';
import {
  OVERLAY_CHANNELS, THEME_EDITOR_CHANNELS, type ThemeEditorArrangementResult, type ThemeEditorFlashResult, type ThemeEditorFontResult, type ThemeEditorImageResult,
  type ThemeEditorOutside, type ThemeEditorResult, type ThemeEditorSession, type ThemeEditorSpriteResult,
} from '../../preload/overlay-channels';
import type { PanelTheme } from '../../preload/panel-channels';
import { THEME_EDITOR_PAGE_URL } from '../protocol';
import { loadAppPage, loggableUrl, mainFrameLoadFailed, registerLocalFontsContents } from '../security';
import { isPanelSender } from '../views';
import type { TransientPreview } from './appearance';
import type { NamedBlob } from './theme-blobs';
import { MAX_PINNED_PROJECTS, MAX_SPRITE_FPS, type PinEdit, type SpriteImport } from '../../../shared/themes/characters';
import type { StripCut } from '../../../core/themes/sprite-header';

// The dock's width in rem while it docks, and the least it shrinks to; ShellState.dockInset carries the first.
export const THEME_DOCK_REM = 22;

// A theme as the dock opens it. baseHash: the hash of its file as core read it, which a save names so a file another writer
// changed since is left alone; absent for a built-in theme and while this computer's engine is not running.
export type ThemeEditorRead = Omit<ThemeEditorSession, 'sessionId' | 'shownName'> & { readonly baseHash?: string };

export interface ThemeEditorDockDeps {
  readonly window: BrowserWindow;
  readonly preloadPath: string;
  readonly log: (line: string) => void;
  // the dock opened, closed or started or stopped peeking; ShellState carries it
  readonly onChange: () => void;
  // the dock's view was added; the overlay restacks above it
  readonly onRestack: () => void;
  readonly theme: () => PanelTheme;
  // what the view paints before its page does: the trusted palette's --d-bg
  readonly background: () => string;
  // the session of `themeId` without its id, or undefined when that theme cannot be edited or read
  readonly session: (themeId: string) => Promise<ThemeEditorRead | undefined>;
  // a theme's name as the UI shows it now (shownThemeName)
  readonly shownName: (entry: { readonly id: string; readonly builtin: boolean; readonly theme: ThemeFile }) => string;
  // paints a draft on the window, or ends the preview; answers why the window paints no preview now, if it does not
  readonly preview: (preview: TransientPreview | undefined) => ThemeShowRefusal | undefined;
  // `baseHash`: the file the draft was made from. A save that wrote answers the hash of what it wrote.
  readonly save: (themeId: string, theme: ThemeFile, pins: readonly PinEdit[], baseHash: string) => Promise<ThemeEditorResult & { readonly baseHash?: string }>;
  // what a save answers while this computer's engine is not running
  readonly engineDown: () => string;
  // the hash of the theme's file now; null when it has none or the file is no theme, undefined when nothing can say
  readonly baseHash: (themeId: string) => Promise<string | null | undefined>;
  // the window's arrangement at this moment, for Capture the current window arrangement
  readonly arrangement: () => Arrangement;
  // a built-in theme's editable copy; its id, or the error the dock shows
  readonly duplicate: (themeId: string) => Promise<{ readonly themeId: string } | { readonly error: string }>;
  // what the dock says when the copy was made and cannot be opened, in the UI's language
  readonly copyNotOpened: () => string;
  // Cancel or Close: Settings › Appearance opens again
  readonly closed: () => void;
  readonly openSettings: () => void;
  // the dock covering the window peeks: the shell's peek bar takes keyboard focus
  readonly peeked: () => void;
  // Add a font file…: the bytes of the file the user picked; tooLarge past MAX_FONT_BYTES, undefined when cancelled
  readonly pickFontFile: () => Promise<Uint8Array | 'tooLarge' | undefined>;
  // core stores the font as a blob, or refuses it with a reason in the UI's language
  readonly importFont: (bytes: Uint8Array) => Promise<FontImport>;
  // the refusal of a font over MAX_FONT_BYTES, in the UI's language
  readonly fontTooLarge: () => string;
  // Choose image…: the path of the image the user picked, undefined when cancelled
  readonly pickImageFile: () => Promise<string | undefined>;
  // core reads, checks, stores and analyzes the wallpaper, or refuses it with a reason in the UI's language
  readonly importImage: (file: string) => Promise<WallpaperImport>;
  // Allow flashing for this file: core records this computer's allowance; the file's flash check after it, undefined before one
  readonly allowFlash: (sha256: string) => Promise<FlashRecord | undefined>;
  // the refusal of an allowance for a file with no flash check yet, in the UI's language
  readonly notChecked: () => string;
  // a character's Choose image…: the path of the image the user picked, undefined when cancelled
  readonly pickSpriteFile: () => Promise<string | undefined>;
  // core reads, checks, stores and checks the sprite for flashing, or refuses it with a reason in the UI's language
  readonly importSprite: (file: string, strip: StripCut | undefined) => Promise<SpriteImport>;
}

const PIN_EDIT_KEYS = new Set(['projectKey', 'character', 'everyTheme']);

/** The Characters section's pin changes as the page sent them, each checked; anything else is dropped. */
export function pinEditsOf(raw: unknown): PinEdit[] {
  if (!Array.isArray(raw)) return [];
  const name = (value: unknown): value is string | null | undefined => value === undefined || value === null || (typeof value === 'string' && value.length > 0 && [...value].length <= MAX_THEME_NAME_CHARS);
  return raw.slice(0, MAX_PINNED_PROJECTS).flatMap((edit: unknown): PinEdit[] => {
    if (typeof edit !== 'object' || edit === null || Object.keys(edit).some((key) => !PIN_EDIT_KEYS.has(key))) return [];
    const { projectKey, character, everyTheme } = edit as Record<string, unknown>;
    if (typeof projectKey !== 'string' || projectKey === '' || projectKey.length > 4096 || !name(character) || !name(everyTheme)) return [];
    return [{ projectKey, ...(character !== undefined ? { character } : {}), ...(everyTheme !== undefined ? { everyTheme } : {}) }];
  });
}

const CLOSED = { ok: false, closed: true } as const;

export const stripOf = (raw: unknown): StripCut | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { frames, fps } = raw as Record<string, unknown>;
  return typeof frames === 'number' && Number.isInteger(frames) && frames >= 1 && frames <= MAX_STRIP_FRAMES && typeof fps === 'number' && Number.isFinite(fps) && fps >= 1 && fps <= MAX_SPRITE_FPS ? { frames, fps } : undefined;
};

/**
 * At most one editor at a time. A relaunch restores neither the dock nor its draft: nothing of it is stored. The preview is
 * painted only while the dock is open on the session that asked for it.
 */
export class ThemeEditorDock {
  private view: WebContentsView | undefined;
  private current: ThemeEditorSession | undefined;
  private nextSession = 1;
  private bounds: Rectangle | undefined;
  private peek = false;
  // what the page last said of its draft: main asks before it moves a dock whose draft holds unsaved edits
  private dirty = false;
  // the theme whose editor was asked for while the draft held unsaved edits, until the page answers
  private pendingMove: string | undefined;
  private baseHash: string | undefined;
  private outside: ThemeEditorOutside | undefined;
  private refused: ThemeShowRefusal | undefined;
  private saving = false;
  private duplicating = false;
  // the sprites this session imported, which its page loads before any preview or saved theme names them
  private readonly imported = new Map<string, NamedBlob>();
  private loaded = false;
  private disposed = false;
  private readonly deps: ThemeEditorDockDeps;

  constructor(deps: ThemeEditorDockDeps) {
    this.deps = deps;
  }

  isOpen(): boolean {
    return this.current !== undefined;
  }

  peeking(): boolean {
    return this.current !== undefined && this.peek;
  }

  editing(): string | undefined {
    return this.current?.themeId;
  }

  /**
   * Opens the dock on `themeId`, or moves an open dock to it. A dock whose draft holds unsaved edits stays on its theme: it
   * stays as it is for that same theme, and for another one its page asks first and `discard` is its answer.
   */
  async open(themeId: string, discard = false): Promise<boolean> {
    if (!discard && this.current && this.dirty && !this.disposed) {
      this.setPeek(false);
      if (themeId === this.current.themeId) return true;
      this.pendingMove = themeId;
      this.send(THEME_EDITOR_CHANNELS.moveAsked);
      return true;
    }
    const read = await this.deps.session(themeId);
    if (!read || this.disposed) return false;
    const { baseHash, ...session } = read;
    this.reset();
    this.baseHash = baseHash;
    this.current = { ...session, ...this.named(session), sessionId: this.nextSession++ };
    const view = this.ensureView();
    if (this.loaded) view.webContents.send(THEME_EDITOR_CHANNELS.session, this.current);
    this.place();
    this.deps.onChange();
    return true;
  }

  close(): void {
    if (!this.current) return;
    this.current = undefined;
    this.reset();
    this.place();
    this.deps.onChange();
  }

  // Everything of one session: its preview, what its page reported and what it imported.
  private reset(): void {
    this.deps.preview(undefined);
    this.peek = false;
    this.dirty = false;
    this.pendingMove = undefined;
    this.baseHash = undefined;
    this.outside = undefined;
    this.refused = undefined;
    this.imported.clear();
  }

  /** A sprite the open session imported, which the theme-blob route serves to its page; undefined otherwise. */
  namedBlob(sha256: string): NamedBlob | undefined {
    return this.current ? this.imported.get(sha256) : undefined;
  }

  /** Why the window paints no preview now (a contrast theme, safe start), or undefined once it can: the page says so. */
  previewRefused(reason: ThemeShowRefusal | undefined): void {
    if (!this.current || this.current.builtin || this.refused === reason) return;
    this.refused = reason;
    this.send(THEME_EDITOR_CHANNELS.previewRefused, reason ?? null);
  }

  /** The theme files changed: the page hears when the file it edits is no longer the one its session was read from. */
  async libraryChanged(): Promise<void> {
    const session = this.current;
    if (!session || session.builtin || this.saving || this.baseHash === undefined) return;
    const hash = await this.deps.baseHash(session.themeId);
    if (hash === undefined || this.saving || !this.still(session)) return;
    const outside = hash === null ? 'gone' : hash !== this.baseHash ? 'changed' : undefined;
    if (outside === this.outside) return;
    this.outside = outside;
    if (outside) this.send(THEME_EDITOR_CHANNELS.outside, outside);
  }

  /**
   * The library's System colors entry, after any library change: an open System colors session, which libraryChanged skips
   * as a built-in, shows new looks. The session keeps its id, so its page keeps its place.
   */
  systemChanged(theme: ThemeFile): void {
    const session = this.current;
    if (session?.themeId !== SYSTEM_THEME_ID || isDeepStrictEqual(theme, session.theme)) return;
    this.current = { ...session, theme };
    this.send(THEME_EDITOR_CHANNELS.session, this.current);
  }

  /** The UI's language changed: an open built-in's session takes its name in the new language, under the same session id. */
  languageChanged(): void {
    const session = this.current;
    if (!session?.builtin) return;
    this.current = { ...session, ...this.named(session) };
    this.send(THEME_EDITOR_CHANNELS.session, this.current);
  }

  // A built-in's name is Damocles' text, which main words; a user theme's name is its draft's, which the page edits.
  private named(session: Pick<ThemeEditorSession, 'themeId' | 'builtin' | 'theme'>): { readonly shownName?: string } {
    return session.builtin ? { shownName: this.deps.shownName({ id: session.themeId, builtin: true, theme: session.theme }) } : {};
  }

  /**
   * The hash a save of `session` names. A session opened while the engine was down has none and takes one here, from a file
   * that still reads as the theme the session opened. Without one nothing is saved: the save could not be checked.
   */
  private async baseOf(session: ThemeEditorSession): Promise<{ readonly hash: string } | ThemeEditorResult> {
    if (this.baseHash !== undefined) return { hash: this.baseHash };
    const fresh = await this.deps.session(session.themeId);
    if (fresh && fresh.baseHash === undefined && (await this.deps.baseHash(session.themeId)) === undefined) return { ok: false, error: this.deps.engineDown() };
    if (!this.still(session)) return CLOSED;
    if (fresh?.baseHash === undefined || !isDeepStrictEqual(fresh.theme, session.theme)) return { ok: false, reason: 'changed' };
    this.baseHash = fresh.baseHash;
    return { hash: fresh.baseHash };
  }

  private send(channel: string, payload?: unknown): void {
    const contents = this.view?.webContents;
    if (this.loaded && contents && !contents.isDestroyed() && !contents.isCrashed()) contents.send(channel, payload);
  }

  // The session object is replaced after a save, so a handler that awaited compares ids.
  private still(session: ThemeEditorSession): boolean {
    return this.current?.sessionId === session.sessionId;
  }

  setPeek(on: boolean): void {
    if (!this.current || this.peek === on) return;
    this.peek = on;
    this.place();
    this.deps.onChange();
    if (on) this.deps.peeked();
    else this.focus();
  }

  /** The dock slot's rectangle in window DIPs, as the shell reports it; undefined while the shell shows none. */
  setBounds(bounds: Rectangle | undefined): void {
    this.bounds = bounds;
    this.place();
  }

  /** A theme card's Show in window took the window: the page turns its preview off with a note until its next edit. */
  previewTakenOver(): void {
    if (!this.current || !this.view || !this.loaded) return;
    this.view.webContents.send(THEME_EDITOR_CHANNELS.previewTakenOver);
  }

  /** Puts the dock above the window's other views; the overlay restacks above it after. */
  raise(): void {
    if (!this.view || this.disposed) return;
    this.deps.window.contentView.addChildView(this.view);
  }

  sendTheme(theme: PanelTheme): void {
    const contents = this.view?.webContents;
    if (!this.loaded || !contents || contents.isDestroyed() || contents.isCrashed()) return;
    contents.send(OVERLAY_CHANNELS.theme, theme);
  }

  /** How far the theme renderer's flash check of a wallpaper the dock is importing is, 0 to 1. */
  importProgress(fraction: number): void {
    const contents = this.view?.webContents;
    if (!this.current || !this.loaded || !contents || contents.isDestroyed() || contents.isCrashed()) return;
    contents.send(THEME_EDITOR_CHANNELS.importProgress, fraction);
  }

  dispose(): void {
    this.disposed = true;
    this.current = undefined;
    const view = this.view;
    this.view = undefined;
    if (view) this.dropView(view);
  }

  // Removing a view from its window does not end its page: the contents is closed here, or it lives until quit.
  private dropView(view: WebContentsView): void {
    if (!this.deps.window.isDestroyed()) this.deps.window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  private focus(): void {
    const contents = this.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.focus();
  }

  private place(): void {
    const view = this.view;
    if (!view || this.disposed) return;
    const shown = this.current !== undefined && !this.peek && this.bounds !== undefined && this.bounds.width > 0 && this.bounds.height > 0;
    if (shown) view.setBounds(this.bounds!);
    if (view.getVisible() === shown) return;
    view.setVisible(shown);
    if (shown) this.focus();
  }

  private accepts(event: IpcMainEvent | IpcMainInvokeEvent, channel: string): boolean {
    const contents = this.view?.webContents;
    const accepted = contents !== undefined && isPanelSender(event, contents, THEME_EDITOR_PAGE_URL);
    if (!accepted) this.deps.log(`[theme editor] rejected ${channel} from ${event.senderFrame ? loggableUrl(event.senderFrame.url) : 'a destroyed frame'} (webContents ${event.sender.id})`);
    return accepted;
  }

  // The session a call names, when it is the open one.
  private sessionOf(raw: unknown): ThemeEditorSession | undefined {
    const id = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['sessionId'] : undefined;
    return this.current !== undefined && id === this.current.sessionId ? this.current : undefined;
  }

  private async importFont(session: ThemeEditorSession, bytes: Uint8Array): Promise<ThemeEditorFontResult> {
    try {
      const font = await this.deps.importFont(bytes);
      return this.still(session) ? { ok: true, font } : CLOSED;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // The page chose to give up its draft for the theme as its file is now.
  private reopen(themeId: string): void {
    this.open(themeId, true).catch((err: unknown) => {
      this.deps.log(`[theme editor] ${themeId} could not be opened: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
    view.setBackgroundColor(this.deps.background());
    view.setVisible(false);
    // its Type section lists the installed fonts; no other page may
    registerLocalFontsContents(view.webContents);
    this.view = view;
    this.deps.window.contentView.addChildView(view);
    this.deps.onRestack();
    const contents = view.webContents;
    const ipc = contents.ipc;
    ipc.handle(THEME_EDITOR_CHANNELS.getSession, (event) => {
      if (!this.accepts(event, THEME_EDITOR_CHANNELS.getSession)) throw new Error('Rejected');
      return this.current ?? null;
    });
    ipc.on(THEME_EDITOR_CHANNELS.preview, (event, raw: unknown) => {
      if (!this.accepts(event, THEME_EDITOR_CHANNELS.preview)) return;
      const session = this.sessionOf(raw);
      if (!session || session.builtin) return;
      const { kind, theme, setIndex } = raw as { kind: unknown; theme: unknown; setIndex?: unknown };
      if (kind !== 'dark' && kind !== 'light') return;
      if (theme === null) {
        this.previewRefused(this.deps.preview(undefined));
        return;
      }
      // main validates the draft as it validates a file before it paints any of it
      const result = validateTheme(theme, { folder: session.themeId });
      const look = result.ok ? result.theme.looks[kind as LookKind] : undefined;
      if (!result.ok || !look) return;
      const { style, assets, css, characters } = result.theme;
      const set = typeof setIndex === 'number' && Number.isInteger(setIndex) && setIndex >= 0 && setIndex < MAX_WALLPAPER_SETS ? { setIndex } : {};
      this.previewRefused(this.deps.preview({ themeId: session.themeId, kind, look, ...(style ? { style } : {}), ...(assets ? { assets } : {}), ...(css ? { css } : {}), ...(characters ? { characters } : {}), ...set }));
    });
    ipc.handle(THEME_EDITOR_CHANNELS.allowFlash, async (event, raw: unknown): Promise<ThemeEditorFlashResult> => {
      if (!this.accepts(event, THEME_EDITOR_CHANNELS.allowFlash)) throw new Error('Rejected');
      const session = this.sessionOf(raw);
      const sha256 = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['sha256'] : undefined;
      if (!session || session.builtin || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return CLOSED;
      try {
        const flash = await this.deps.allowFlash(sha256);
        if (!this.still(session)) return CLOSED;
        return flash ? { ok: true, flash } : { ok: false, error: this.deps.notChecked() };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
    ipc.handle(THEME_EDITOR_CHANNELS.importFontFile, async (event, raw: unknown): Promise<ThemeEditorFontResult> => {
      if (!this.accepts(event, THEME_EDITOR_CHANNELS.importFontFile)) throw new Error('Rejected');
      const session = this.sessionOf(raw);
      if (!session || session.builtin) return CLOSED;
      let bytes: Uint8Array | 'tooLarge' | undefined;
      try {
        bytes = await this.deps.pickFontFile();
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (!this.still(session)) return CLOSED;
      if (bytes === undefined) return { ok: false, cancelled: true };
      if (bytes === 'tooLarge') return { ok: false, error: this.deps.fontTooLarge() };
      return this.importFont(session, bytes);
    });
    ipc.handle(THEME_EDITOR_CHANNELS.importFontBytes, async (event, raw: unknown): Promise<ThemeEditorFontResult> => {
      if (!this.accepts(event, THEME_EDITOR_CHANNELS.importFontBytes)) throw new Error('Rejected');
      const session = this.sessionOf(raw);
      const bytes = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['bytes'] : undefined;
      if (!session || session.builtin) return CLOSED;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_FONT_BYTES) return { ok: false, error: this.deps.fontTooLarge() };
      return this.importFont(session, bytes);
    });
    ipc.handle(THEME_EDITOR_CHANNELS.importImageFile, async (event, raw: unknown): Promise<ThemeEditorImageResult> => {
      if (!this.accepts(event, THEME_EDITOR_CHANNELS.importImageFile)) throw new Error('Rejected');
      const session = this.sessionOf(raw);
      if (!session || session.builtin) return CLOSED;
      try {
        const file = await this.deps.pickImageFile();
        if (!this.still(session)) return CLOSED;
        if (file === undefined) return { ok: false, cancelled: true };
        const image = await this.deps.importImage(file);
        return this.still(session) ? { ok: true, image, name: path.basename(file) } : CLOSED;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
    ipc.handle(THEME_EDITOR_CHANNELS.importSpriteFile, async (event, raw: unknown): Promise<ThemeEditorSpriteResult> => {
      if (!this.accepts(event, THEME_EDITOR_CHANNELS.importSpriteFile)) throw new Error('Rejected');
      const session = this.sessionOf(raw);
      if (!session || session.builtin) return CLOSED;
      const strip = stripOf((raw as Record<string, unknown>)['strip']);
      try {
        const file = await this.deps.pickSpriteFile();
        if (!this.still(session)) return CLOSED;
        if (file === undefined) return { ok: false, cancelled: true };
        const sprite = await this.deps.importSprite(file, strip);
        if (!this.still(session)) return CLOSED;
        // named before the answer leaves, so the page's first request for the image is served
        this.imported.set(sprite.sha256, { kind: 'sprite', mime: sprite.asset.mime });
        return { ok: true, sprite, name: path.basename(file) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
    ipc.handle(THEME_EDITOR_CHANNELS.save, async (event, raw: unknown): Promise<ThemeEditorResult> => {
      if (!this.accepts(event, THEME_EDITOR_CHANNELS.save)) throw new Error('Rejected');
      const session = this.sessionOf(raw);
      if (!session || session.builtin) return CLOSED;
      if (this.saving) return { ok: false, reason: 'busy' };
      const { theme, pins } = raw as { theme: unknown; pins?: unknown };
      const result = validateTheme(theme, { folder: session.themeId });
      if (!result.ok) {
        this.deps.log(`[theme editor] the draft of ${session.themeId} is no valid theme: ${themeErrorEnglish(result.errors[0])}`);
        return { ok: false, reason: 'invalid' };
      }
      this.saving = true;
      try {
        const base = await this.baseOf(session);
        if (!('hash' in base)) return base;
        const { baseHash, ...saved } = await this.deps.save(session.themeId, result.theme, pinEditsOf(pins), base.hash);
        if (!saved.ok || !this.still(session)) return saved;
        // the hash of what this save wrote, never a later read's: a file another writer changed since stays refused
        this.baseHash = baseHash;
        this.outside = undefined;
        // the session is the theme as core stored it, so a page that loads again shows the file
        const fresh = await this.deps.session(session.themeId);
        if (fresh && this.still(session)) {
          const { baseHash: _read, ...stored } = fresh;
          this.current = { ...stored, sessionId: session.sessionId };
        }
        return saved;
      } finally {
        this.saving = false;
      }
    });
    ipc.handle(THEME_EDITOR_CHANNELS.captureArrangement, (event, raw: unknown): ThemeEditorArrangementResult => {
      if (!this.accepts(event, THEME_EDITOR_CHANNELS.captureArrangement)) throw new Error('Rejected');
      const session = this.sessionOf(raw);
      return session && !session.builtin ? { ok: true, arrangement: this.deps.arrangement() } : CLOSED;
    });
    ipc.handle(THEME_EDITOR_CHANNELS.duplicate, async (event, raw: unknown): Promise<ThemeEditorResult> => {
      if (!this.accepts(event, THEME_EDITOR_CHANNELS.duplicate)) throw new Error('Rejected');
      const session = this.sessionOf(raw);
      if (!session) return CLOSED;
      if (this.duplicating) return { ok: false, reason: 'busy' };
      this.duplicating = true;
      try {
        const copy = await this.deps.duplicate(session.themeId);
        if ('error' in copy) return { ok: false, error: copy.error };
        // the user closed the dock or moved it to another theme meanwhile: it stays as they left it, and the copy is in the gallery
        if (!this.still(session)) return { ok: true };
        return (await this.open(copy.themeId, true)) ? { ok: true } : { ok: false, error: this.deps.copyNotOpened() };
      } finally {
        this.duplicating = false;
      }
    });
    ipc.on(THEME_EDITOR_CHANNELS.dirty, (event, raw: unknown) => {
      if (this.accepts(event, THEME_EDITOR_CHANNELS.dirty) && this.sessionOf(raw)) this.dirty = (raw as Record<string, unknown>)['dirty'] === true;
    });
    ipc.on(THEME_EDITOR_CHANNELS.moveAnswer, (event, raw: unknown) => {
      if (!this.accepts(event, THEME_EDITOR_CHANNELS.moveAnswer) || !this.sessionOf(raw)) return;
      const target = this.pendingMove;
      this.pendingMove = undefined;
      if (target !== undefined && (raw as Record<string, unknown>)['discard'] === true) this.reopen(target);
    });
    ipc.on(THEME_EDITOR_CHANNELS.reload, (event, raw: unknown) => {
      const session = this.accepts(event, THEME_EDITOR_CHANNELS.reload) ? this.sessionOf(raw) : undefined;
      if (session) this.reopen(session.themeId);
    });
    ipc.on(THEME_EDITOR_CHANNELS.close, (event, raw: unknown) => {
      if (!this.accepts(event, THEME_EDITOR_CHANNELS.close) || !this.sessionOf(raw)) return;
      this.close();
      this.deps.closed();
    });
    ipc.on(THEME_EDITOR_CHANNELS.peek, (event, on: unknown) => {
      if (this.accepts(event, THEME_EDITOR_CHANNELS.peek) && typeof on === 'boolean') this.setPeek(on);
    });
    ipc.on(THEME_EDITOR_CHANNELS.openSettings, (event) => {
      if (this.accepts(event, THEME_EDITOR_CHANNELS.openSettings)) this.deps.openSettings();
    });
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.loaded = false;
    });
    contents.on('did-finish-load', () => {
      this.loaded = true;
      this.sendTheme(this.deps.theme());
      if (!this.current) return;
      // a page that loaded again holds no draft, and hears again what main knows of its session
      this.dirty = false;
      this.pendingMove = undefined;
      contents.send(THEME_EDITOR_CHANNELS.session, this.current);
      if (this.refused) contents.send(THEME_EDITOR_CHANNELS.previewRefused, this.refused);
      if (this.outside) contents.send(THEME_EDITOR_CHANNELS.outside, this.outside);
    });
    contents.on('did-fail-load', (_event, errorCode: number, _description, _url, isMainFrame: boolean) => {
      if (mainFrameLoadFailed(errorCode, isMainFrame)) this.deps.log(`[theme editor] the page did not load (${errorCode})`);
    });
    // The editor's page is trusted UI with no state worth keeping: a crash closes the dock, and the next open loads it again.
    contents.on('render-process-gone', (_event, details) => {
      this.deps.log(`[theme editor] renderer gone (${details.reason})`);
      this.loaded = false;
      if (this.view !== view) return;
      this.view = undefined;
      this.dropView(view);
      this.close();
    });
    loadAppPage(contents, THEME_EDITOR_PAGE_URL).catch((err: unknown) => {
      this.deps.log(`[theme editor] the page did not load: ${err instanceof Error ? err.message : String(err)}`);
    });
    return view;
  }
}
