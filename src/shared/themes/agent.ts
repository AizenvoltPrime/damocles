// What the agent's theme tools, their cards, the keep-changes banner and the theme renderer page exchange, as data: core
// sends it, the renderers word it.
import type { ThemeActor, ThemeHistoryChange } from './changes';
import type { ContrastIssue } from './contrast';
import type { CssDroppedPart } from './css-types';
import type { Arrangement, CharacterSelection, CssRegion, LOOK_SEEDS, ThemeFile } from './schema';
import type { ShellWallpaper } from './wallpapers';
import type { CharacterState, CharacterView, ShownCharacters } from './characters';
import type { CharacterSheetPage } from './character-sheet';
import type { LookKind } from './tokens';
import type { ProjectLookKind, ProjectTouch } from './project-looks';
import type { TOOL_THEME_READ, TOOL_THEME_SCHEDULE, TOOL_THEME_SET } from '../tool-names';

// damocles.desktop.themes.applyMode
export type ThemeApplyMode = 'preview' | 'onTheFly';
export const THEME_APPLY_MODES: readonly ThemeApplyMode[] = ['preview', 'onTheFly'];

// How long the keep-changes banner counts before it reverts, restarted by a later change.
export const KEEP_CHANGES_MS = 15_000;

// How long ThemeRead's screenshot card waits for an answer; main holds the screenshot a little longer (SCREENSHOT_TTL_MS).
export const SCREENSHOT_ANSWER_MS: number = 10 * 60_000;

export type LookSeed = (typeof LOOK_SEEDS)[number];

/** One line of a proposal's summary of changes; null restores Damocles' default. */
export type ThemeChangeItem =
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'look'; readonly look: LookKind; readonly added: boolean }
  | { readonly kind: 'color'; readonly look: LookKind; readonly seed: LookSeed; readonly hex: string }
  | { readonly kind: 'tokens'; readonly look: LookKind; readonly count: number }
  | { readonly kind: 'font'; readonly role: 'ui' | 'mono'; readonly family: string | null }
  | { readonly kind: 'lineHeight' | 'radius' | 'density'; readonly value: number | null }
  | { readonly kind: 'chatColumn'; readonly value: number | 'full' | null }
  | { readonly kind: 'pick'; readonly looks: readonly LookKind[] }
  // panels: how many panels the look's first set gives an image, 0 when the look has no wallpaper left
  | { readonly kind: 'wallpapers'; readonly look: LookKind; readonly panels: number }
  | { readonly kind: 'surfaceOpacity'; readonly look: LookKind; readonly value: number | null }
  // minutes: the timer between the look's wallpaper sets; null: only Next Wallpaper moves on
  | { readonly kind: 'cycle'; readonly look: LookKind; readonly minutes: number | null }
  | { readonly kind: 'paletteFromWallpaper'; readonly look: LookKind }
  | { readonly kind: 'wallpapersOff' }
  // the theme takes this computer's window arrangement now, or loses its own when cleared
  | { readonly kind: 'layout'; readonly cleared: boolean }
  // the pick puts the theme's own window arrangement in place
  | { readonly kind: 'arrangementApplies' }
  // the region's custom CSS was replaced, or removed when cleared
  | { readonly kind: 'css'; readonly region: CssRegion; readonly cleared: boolean }
  // count: the characters of the theme's new set; 0 when it has none left
  | { readonly kind: 'characters'; readonly count: number }
  // character sprites the call drew from pixel grids, and those it recolored from another sprite
  | { readonly kind: 'sprites'; readonly added: number; readonly recolored: number }
  // characterEdits and characterSet: how many characters were added, changed and removed; all 0 when only the set changed
  | { readonly kind: 'characterEdits'; readonly added: number; readonly changed: number; readonly removed: number }
  | { readonly kind: 'schedule'; readonly enabled: boolean; readonly rules: number }
  // the chat's project's own look: none turns it off, touches lists what it sets, full names its theme and look
  | { readonly kind: 'projectLook'; readonly project: string; readonly look: 'none' | 'touches' | 'full'; readonly touches?: readonly ProjectTouch[]; readonly theme?: string; readonly themeLook?: ProjectLookKind }
  // the chat's project's character pinned (character) or unpinned (null) in the theme named, or with everyTheme in every theme
  | { readonly kind: 'projectPin'; readonly project: string; readonly theme: string; readonly themeId?: string; readonly character: string | null; readonly everyTheme?: true }
  | { readonly kind: 'undo'; readonly change: ThemeHistoryChange };

/** A checkPalette issue of one look of the proposal. */
export interface ThemeContrastIssue extends ContrastIssue {
  readonly look: LookKind;
}

// waiting: the user can answer; applying: core took an Apply and no answer is taken until it ends; outdated: the theme
// changed after the proposal, so only Discard is offered
export type ThemeChangeState = 'waiting' | 'applying' | 'outdated';

// what the card proposes: a theme (ThemeSet), the schedule (ThemeSchedule), reverting the chat's own newest change, the
// chat's project's own look (ThemeSet target project), or turning Show wallpapers off (ThemeSet wallpapersOff)
export type ThemeChangeAction = 'theme' | 'schedule' | 'undo' | 'project' | 'wallpapersOff';

// Why the window cannot paint a card's proposal: Windows contrast themes or safe start chose the look before any preview.
export const THEME_SHOW_REFUSALS = ['forcedColors', 'safeStart'] as const;
export type ThemeShowRefusal = (typeof THEME_SHOW_REFUSALS)[number];
// Why main ended a card's Show in window: another preview took over, the strip's Stop showing, or a refusal that began.
export type ThemeShowEndReason = 'takenOver' | 'stopped' | ThemeShowRefusal;
export const THEME_SHOW_END_REASONS: readonly ThemeShowEndReason[] = ['takenOver', 'stopped', ...THEME_SHOW_REFUSALS];

// takenOver: another transient preview (the theme editor, another card) started, so this card's Show in window ended; a
// refusal: the window cannot paint the proposal, so the toggle is off
export type ThemeShowNote = 'takenOver' | ThemeShowRefusal;
export const THEME_SHOW_NOTES: readonly ThemeShowNote[] = ['takenOver', ...THEME_SHOW_REFUSALS];

/** What a `themeChangeUpdated` changes of an open theme card. */
export interface ThemeCardUpdate {
  readonly state?: ThemeChangeState;
  readonly showInWindow?: boolean;
  readonly showNote?: ThemeShowNote;
}

/** A theme card after an update. A note says why Show in window is off, so turning it on, or off with no note, clears it. */
export function applyThemeChangeUpdate<T extends { state: ThemeChangeState; showInWindow: boolean; showNote?: ThemeShowNote }>(card: T, update: ThemeCardUpdate): T {
  const next: T = {
    ...card,
    ...(update.state !== undefined ? { state: update.state } : {}),
    ...(update.showInWindow !== undefined ? { showInWindow: update.showInWindow } : {}),
    ...(update.showNote !== undefined ? { showNote: update.showNote } : {}),
  };
  if (update.showInWindow === true || (update.showInWindow === false && update.showNote === undefined)) delete next.showNote;
  return next;
}

export type ThemeChangeChoice = 'apply' | 'discard' | 'change';
// allowChat: allow this one and grant the chat every later screenshot until it closes or the grant is revoked
export type ThemeScreenshotChoice = 'allow' | 'allowChat' | 'deny';

// Why main took no screenshot of a draft or of the window.
export const THEME_CAPTURE_REFUSALS = ['forcedColors', 'safeStart', 'windowHidden', 'covered', 'noWindow', 'timeout'] as const;
export type ThemeCaptureRefusal = (typeof THEME_CAPTURE_REFUSALS)[number];

// applied: Apply on the card; kept and reverted: the keep-changes banner's end; discarded: Discard (or the stop of the
// turn); changesRequested: Change with a note; outdated: the theme changed meanwhile and the draft was discarded; undone:
// the chat's own newest change was reverted; staged: a draft built without a card; installed and installCancelled: the install
// card's Install and Cancel (or the stop of the turn); installExpired: the card waited until the staged file was dropped
export const THEME_OUTCOMES = ['applied', 'kept', 'reverted', 'discarded', 'changesRequested', 'outdated', 'undone', 'staged', 'installed', 'installCancelled', 'installExpired'] as const;
export type ThemeOutcome = (typeof THEME_OUTCOMES)[number];

/** A later history entry that blocks the agent's undo, named in the refusal. */
export interface ThemeLaterChange {
  readonly change: ThemeHistoryChange;
  readonly actor: ThemeActor;
  readonly at: number;
}

/** The `details` of a ThemeRead, ThemeSet or ThemeSchedule result, all ThemeToolCard reads; images travel as imageCount only. */
export interface ThemeToolDetails {
  readonly tool: typeof TOOL_THEME_READ | typeof TOOL_THEME_SET | typeof TOOL_THEME_SCHEDULE;
  readonly outcome?: ThemeOutcome;
  readonly themeName?: string;
  readonly looks?: readonly LookKind[];
  readonly draftId?: string;
  // the note of changesRequested, as the user typed it
  readonly note?: string;
  readonly applyMode?: ThemeApplyMode;
  // undone: what the agent's undo reverted
  readonly undone?: ThemeHistoryChange;
  // a refused undo: the later change that touched the same items
  readonly laterChange?: ThemeLaterChange;
  readonly changes?: readonly ThemeChangeItem[];
  readonly contrast?: readonly ThemeContrastIssue[];
  // the parts of the proposal's custom CSS the sanitizer removed (feature themes)
  readonly droppedCss?: readonly CssDroppedPart[];
  // how many more parts it removed than droppedCss lists; absent when it lists them all
  readonly droppedCssMore?: number;
  // what the card's small miniature draws (miniatureTheme); absent past MAX_DETAILS_THEME_CHARS
  readonly theme?: ThemeFile;
  // ThemeRead with screenshot: whether the user allowed it
  readonly screenshot?: 'sent' | 'denied';
  // ThemeRead with screenshot: why main took none
  readonly shotRefused?: ThemeCaptureRefusal;
  // ThemeSet that generated an image: the image model its usage is billed to, as GenerateImage names it
  readonly provider?: string;
  readonly model?: string;
  // ThemeSet install, installed: whether the user turned on "Use this theme's window arrangement"; themeName is the installed name
  readonly useArrangement?: boolean;
}

// Details are persisted with every result, so the miniature copy is kept small.
export const MAX_DETAILS_THEME_CHARS: number = 16 * 1024;

/** Only what ThemeMiniature reads of a theme: the looks' colors and tokens, the style and the font assets it names. */
export function miniatureTheme(theme: ThemeFile): ThemeFile | undefined {
  const looks = Object.fromEntries(Object.entries(theme.looks).flatMap(([kind, look]) =>
    look ? [[kind, { colors: look.colors, ...(look.tokens ? { tokens: look.tokens } : {}) }]] : []));
  const fontAssets = Object.values(theme.style?.fonts ?? {}).flatMap((choice) => {
    const meta = choice && 'asset' in choice ? theme.assets?.[choice.asset] : undefined;
    return meta && choice && 'asset' in choice ? [[choice.asset, { kind: meta.kind, mime: meta.mime, bytes: meta.bytes, ...(meta.family !== undefined ? { family: meta.family } : {}), license: {} }] as const] : [];
  });
  const copy: ThemeFile = {
    schemaVersion: theme.schemaVersion,
    id: theme.id,
    name: theme.name,
    looks,
    ...(theme.style ? { style: theme.style } : {}),
    ...(fontAssets.length > 0 ? { assets: Object.fromEntries(fontAssets) } : {}),
  };
  return JSON.stringify(copy).length <= MAX_DETAILS_THEME_CHARS ? copy : undefined;
}

/** The keep-changes banner (main's state machine), as the shell shows it; kept and reverted linger briefly after the end. */
export interface KeepChangesState {
  readonly phase: 'counting' | 'kept' | 'reverted';
  // ms since the epoch when the countdown reverts; the last value in kept and reverted
  readonly endsAt: number;
  readonly durationMs: number;
  // the chat whose agent made the change, as its title reads; absent while the chat has no title
  readonly chatTitle?: string;
  // what the countdown's latest change did, as data the shell words (an agent apply is create or save, an undo a restore)
  readonly change: ThemeHistoryChange;
  // the theme that showed before the first change, when it picked one look
  readonly previousName?: string;
  readonly previousId?: string;
  // the changes the countdown covers, 1 or more
  readonly changeCount: number;
  // the changes came from more than one chat, or from a chat and the user; chatTitle is then absent
  readonly several?: true;
  // counting only: this answer is on its way to core (Keep, or Revert or the timeout), so no other is taken until it ends
  readonly ending?: 'kept' | 'reverted';
  // counting only: this computer's engine is not running, so nothing can keep or revert and no countdown runs until one starts
  readonly engineDown?: true;
  // kept and reverted only: who ended the countdown; absent when another change did, or when main read the end from the files
  readonly endedBy?: KeepChangesEndedBy;
}

// user: the banner's Keep or Revert, or Undo of the countdown's first change; timeout: nobody answered; engineStart: an
// engine that started during the countdown reverted it, or kept it because it could not
export type KeepChangesEndedBy = 'user' | 'timeout' | 'engineStart';

/** The Show in window strip: a card's proposal paints the window. */
export interface ThemeProposalStrip {
  readonly promptId: string;
  // absent while the chat has no title
  readonly chatTitle?: string;
}

/** appearance.json's mark of an applied change the keep-changes banner has not settled; a launch with it reverts the change. */
export interface PendingConfirm {
  readonly entryId: string;
  readonly startedAt: number;
  // every Damocles app that counts it, one or more (COUNTDOWN_OWNER each)
  readonly owners: readonly string[];
}

// A Damocles app among those that share the themes folder, the same at every run of it. It names a lock folder, so it holds
// nothing a path could be built from.
export const COUNTDOWN_OWNER: RegExp = /^[0-9a-f]{32}$/;
export const MAX_COUNTDOWN_OWNERS = 16;

/** The pendingConfirm of an appearance.json object, when it is well formed. */
export function pendingConfirmOf(json: Readonly<Record<string, unknown>> | undefined): PendingConfirm | undefined {
  const mark = json?.['pendingConfirm'];
  if (typeof mark !== 'object' || mark === null || Array.isArray(mark)) return undefined;
  const { entryId, startedAt, owners } = mark as Record<string, unknown>;
  if (typeof entryId !== 'string' || typeof startedAt !== 'number') return undefined;
  if (!Array.isArray(owners) || owners.length === 0 || owners.length > MAX_COUNTDOWN_OWNERS) return undefined;
  if (!owners.every((owner): owner is string => typeof owner === 'string' && COUNTDOWN_OWNER.test(owner))) return undefined;
  return { entryId, startedAt, owners };
}

export const THEME_RENDER_SIZE = { width: 1280, height: 800 } as const;

/** What main's window builder gives the render page: the same CSS, wallpapers and characters the window would paint. */
export interface RenderAppearance {
  readonly kind: 'dark' | 'light';
  // FONT_FACE_CSS and pageCss, for the host style element
  readonly css: string;
  // the trusted region palette, scoped to [data-trusted]
  readonly trustedCss: string;
  // sanitized custom CSS for sidebar, editorChrome, terminalChrome and titlebar
  readonly shellCss?: string;
  // sanitized custom CSS for transcript
  readonly chatCss?: string;
  // a moving wallpaper is already its still: url is the still and there is no `moving`
  readonly wallpapers?: readonly ShellWallpaper[];
  // motion 'still'
  readonly characters?: ShownCharacters;
  // the theme's own arrangement, else the window's current one, whole and clamped to the drawing's size
  readonly arrangement: Required<Arrangement>;
  readonly platform: 'darwin' | 'win32' | 'linux';
}

/** One job of the theme renderer page, passed as JSON text to window.damoclesRender. */
export type ThemeRenderJob =
  | { readonly kind: 'window'; readonly view: 'window' | 'sidebar'; readonly appearance: RenderAppearance; readonly width: typeof THEME_RENDER_SIZE.width; readonly height: typeof THEME_RENDER_SIZE.height }
  // one page of a character sheet, at the size its layout gives; characters: the set's characters its rows draw, by index
  | { readonly kind: 'characters'; readonly appearance: RenderAppearance; readonly sheet: CharacterSheetPage; readonly characters: readonly SheetCharacterView[]; readonly width: number; readonly height: number }
  // shell and chat are data:image/png URLs; bounds place the chat capture over the shell capture, in its pixels
  | { readonly kind: 'composite'; readonly shell: string; readonly chat: string; readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }; readonly width: number; readonly height: number }
  // a wallpaper at `url` decoded and measured; `image` is the size its header declares, which the decoded pixels must match.
  // A moving one (`moving`) is also checked for flashing, every frame, decoded one by one from the bytes main fed the page
  // before the job; a video is never played. Nothing is captured: the answer is a ThemeAnalysisAnswer.
  | {
    readonly kind: 'analyze';
    readonly url: string;
    readonly image: { readonly width: number; readonly height: number };
    readonly moving?: { readonly kind: 'animated' | 'video'; readonly mime: string; readonly durationMs?: number };
    readonly width: number;
    readonly height: number;
  }
  // a character sprite at `url` decoded at the size its header declares: a strip's frames, or an animated image's from the bytes
  // main fed, checked for flashing; an animated image's or an SVG's first frame drawn. The answer is a ThemeSpriteAnswer.
  | {
    readonly kind: 'sprite';
    readonly url: string;
    readonly mime: string;
    readonly image: { readonly width: number; readonly height: number };
    readonly strip?: { readonly frameWidth: number; readonly frameHeight: number; readonly frames: number; readonly fps: number };
    readonly animated: boolean;
    readonly width: number;
    readonly height: number;
  };

/** A character of the set by its index there, as the sheet draws it. */
export interface SheetCharacterView {
  readonly index: number;
  readonly view: CharacterView;
}

/** What a character sheet drew, as data core words: every character by its index in the set. */
export interface CharacterSheetFacts {
  // the characters each page shows, in order
  readonly sheets: readonly (readonly number[])[];
  // those that would need a page past MAX_SHEETS, which a sheet of fewer characters draws
  readonly omitted: readonly number[];
  // those no page can draw: an image with no declared size, or a frame over MAX_SPRITE_SIDE, taller than a page or too wide
  // to fit across at 1x
  readonly unfit: readonly number[];
  // those with no image that can show yet: an animated image whose still frame is not drawn, or a strip its image does not match
  readonly undrawn: readonly number[];
  // states drawn as their still frame: an animated GIF or WebP, whose frames are not shown
  readonly stills: readonly { readonly character: number; readonly state: CharacterState }[];
  // states whose frames did not all show: past MAX_SHEET_FRAMES, or more than fit a page
  readonly clipped: readonly { readonly character: number; readonly state: CharacterState; readonly shown: number; readonly frames: number }[];
  // the set's selection: none draws the selected cell without an outline
  readonly selection: CharacterSelection;
  // the look has a sidebar wallpaper, so each line has its cell
  readonly wallpaper: boolean;
}

/** The sprite job's answer, as JSON text: the decoded size, the first frame as a data:image/png URL when drawn, the flash check. */
export interface ThemeSpriteAnswer {
  readonly width: number;
  readonly height: number;
  readonly still?: string;
  readonly flash: unknown;
}

/**
 * The analyze job's answer, as JSON text: the thumbnail as a data:image/webp URL, the luminance stats and the palette; for a
 * moving wallpaper also its first frame as a data:image/png URL and its flash check.
 */
export interface ThemeAnalysisAnswer {
  readonly thumb: string;
  readonly stats: unknown;
  readonly palette: unknown;
  readonly still?: string;
  readonly flash?: unknown;
}

/** What window.damoclesRender resolves, as JSON text, once the job is drawn with its fonts and images loaded; main then captures. */
export interface ThemeRenderAnswer {
  readonly drawn: true;
  readonly width: number;
  readonly height: number;
  // view 'sidebar' only: the [data-render-region="sidebar"] rect in CSS px, integers, inside width x height
  readonly region?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}
