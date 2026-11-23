import { nativeTheme } from 'electron';
import type { Disposable } from '../../platform/disposable';
import type { PanelTheme, ThemeKind } from '../preload/panel-channels';
import {
  CHARACTER_MOTION_SETTING, FILE_ICON_THEME_SETTING, type FileIconTheme, parseFileIconTheme, REDUCE_MOTION_SETTING, SHOW_WALLPAPERS_SETTING, TEXT_SIZE_SETTING, THEME_PREFERENCES, THEME_SETTING, THEMES_DARK_SETTING, THEMES_LIGHT_SETTING,
  type ThemePreference, WALLPAPER_CONTRAST_SETTING,
} from '../local-services/desktop-configuration';
import { fontFaceCss } from './desktop-fonts';
import { APP_ORIGIN } from './protocol';
import { BUILTIN_PALETTES, BUILTIN_THEME, BUILTIN_THEME_ID } from '../../shared/themes/builtin';
import { bundledFonts } from '../../shared/themes/fonts';
import { parseTextSize, styleTokens, TEXT_SIZE_RANGE } from '../../shared/themes/style';
import type { ThemePalette } from '../../shared/themes/tokens';
import { resolveShown, themeSourceFor, wallpaperMotion, type AppearanceInputs, type MotionInputs, type MotionPause, type SafeStartReason, type ShownTheme, type TransientPreview } from './themes/appearance';
import { NO_APPEARANCE_SCHEDULE, type AppearanceSchedule } from '../../shared/themes/schedule';
import type { LibraryEntry, ThemeLibrary } from './themes/theme-files';
import type { CycleLook } from './themes/theme-state';
import { opaqueBackground, pageCss, pageCustomCss, scopedThemeCss, shownPalette, trustedCss, trustedPalette, type CustomCssPage, type TrustedScope } from './themes/theme-css';
import type { CssRegion } from '../../shared/themes/schema';
import { shownWallpapers, wallpapersOff, type ShownWallpapers, type WallpaperContrast, type WallpapersOff } from './themes/wallpapers';
import { isWallpaperAsset, type FlashRecord, type ImageStats, type WallpaperKind } from '../../shared/themes/wallpapers';
import { SURFACE_ALPHA_TOKEN } from '../../shared/themes/tokens';
import type { ThemeFile } from '../../shared/themes/schema';
import { CHARACTER_MOTIONS, EMPTY_PROJECTS, shownCharacters, type CharacterMotion, type ProjectsFile, type ShownCharacters } from '../../shared/themes/characters';
import { checkProjectLook, type ProjectLook } from '../../shared/themes/project-looks';

export const FONT_FACE_CSS: string = fontFaceCss(APP_ORIGIN);

/** The built-in look's page CSS of a kind, at the default text size. */
export function themeCss(kind: ThemeKind): string {
  return `${FONT_FACE_CSS}\n${pageCss({ kind }, BUILTIN_PALETTES[kind], TEXT_SIZE_RANGE.default)}`;
}

export function themePreference(value: unknown): ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference) ? (value as ThemePreference) : 'system';
}

export interface ThemeSettings {
  get<T>(key: string): T | undefined;
  onDidChange(section: string, cb: () => void): Disposable;
}

const BUILTIN_ENTRY: LibraryEntry = { status: 'ok', id: BUILTIN_THEME_ID, builtin: true, theme: BUILTIN_THEME };
/** A preferred look setting's theme id; unset or malformed reads as the built-in theme. */
export const preferredThemeId = (value: unknown): string => (typeof value === 'string' && value.length > 0 ? value : BUILTIN_THEME_ID);
const preferredId = preferredThemeId;

let reducedMotion = false;
let fileIconTheme: FileIconTheme = 'material';
let textSize: number = TEXT_SIZE_RANGE.default;
let safeStart: SafeStartReason | undefined;
let preview: TransientPreview | undefined;
let held: { readonly look: HeldLook; readonly scope: 'window' | 'trusted' } | undefined;
// base: the look without the transient preview, whose palette trusted UI keeps while a preview paints the window
interface Shown {
  readonly theme: ShownTheme;
  readonly palette: ThemePalette;
  readonly base: ShownTheme;
  readonly basePalette: ThemePalette;
  readonly css: string;
  readonly trusted: Readonly<Record<TrustedScope, string>>;
  // the trusted palette's --d-bg, which a trusted view paints before its page does
  readonly trustedBackground: string;
  // the shown theme's custom CSS per region, sanitized by main
  readonly custom: Partial<Record<CssRegion, string>>;
  readonly wallpapers?: ShownWallpapers;
  readonly characters?: ShownCharacters;
}
let shown: Shown | undefined;
let characterMotion: CharacterMotion = 'always';
// projects.json as main last read it
let projectPins: ProjectsFile = EMPTY_PROJECTS;
// every project's own look as core's themes.projectLooks gave it and main checked it again, and the selected project's key
let projectLooks: Readonly<Record<string, ProjectLook>> = {};
let selectedProject: string | undefined;
let showWallpapers = true;
let wallpaperContrast: WallpaperContrast = 'raiseDim';
let environment = { gpuCompositing: true, reducedTransparency: false };
// Each wallpaper's luminance percentiles as main read them from core's cache; a miss is asked for once until invalidated.
const wallpaperStats = new Map<string, ImageStats>();
const statsAsked = new Set<string>();
let statsReader: ((sha256: string) => Promise<ImageStats | undefined>) | undefined;
// Each moving wallpaper's flash check, read the same way; a file not read yet does not play.
const wallpaperFlashes = new Map<string, FlashRecord>();
const flashAsked = new Set<string>();
// counts the invalidations, so a read issued before one never overwrites a later read's answer
let flashGeneration = 0;
let flashReader: ((sha256: string) => Promise<FlashRecord | undefined>) | undefined;
// the wallpaper set a look shows now (theme-state.json's position and the look's timer)
let cycleIndex: (look: CycleLook) => number = () => 0;
// what pauses moving wallpapers besides the settings main reads itself; osReducedMotion is undefined until the shell page
// reports it, and counts as reduced until then
let motion: Omit<MotionInputs, 'reduceMotion' | 'forcedColors' | 'wallpapersShown'> & { readonly osReducedMotion: boolean | undefined } = {
  focused: true, visible: true, minimized: false, onBattery: false, batterySaver: false, osReducedMotion: undefined,
};
let followed: { readonly settings: ThemeSettings; readonly library: ThemeLibrary | undefined } | undefined;
let signature = '';
const appearanceListeners = new Set<() => void>();
const inputListeners = new Set<() => void>();

// appearance.json's schedule and pick as main last read them
let appearanceSchedule: AppearanceSchedule = NO_APPEARANCE_SCHEDULE;
// Node may keep its start-up zone, so main's own resolved zone counts only until the shell page reports the OS's
let timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone;
let zoneReported = false;
let clock: () => number = Date.now;
// the OS kind as last read while themeSource was 'system' (nativeTheme reports the forced kind otherwise), or the stand-in's
let knownOsKind: ThemeKind | undefined;
// e2e's stand-in for the computer's light or dark mode, which no test can switch
let osStandIn: ThemeKind | undefined;

function osKind(): ThemeKind {
  const kind: ThemeKind = osStandIn ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  if (osStandIn !== undefined || nativeTheme.themeSource === 'system') knownOsKind = kind;
  return kind;
}

/** Stands in for the computer's light or dark mode (e2e); undefined gives the OS's back. The look follows it as it does an OS switch. */
export function setOsKindStandIn(kind: ThemeKind | undefined): void {
  osStandIn = kind;
  refresh();
}

function appearanceInputs(): AppearanceInputs {
  const settings = followed?.settings;
  const library = followed?.library;
  return {
    forcedColors: nativeTheme.inForcedColorsMode === true,
    ...(safeStart !== undefined ? { safeStart } : {}),
    mode: themePreference(settings?.get<unknown>(THEME_SETTING)),
    osKind: osKind(),
    preferred: { dark: preferredId(settings?.get<unknown>(THEMES_DARK_SETTING)), light: preferredId(settings?.get<unknown>(THEMES_LIGHT_SETTING)) },
    theme: (id: string) => (library ? library.entry(id) : id === BUILTIN_THEME_ID ? BUILTIN_ENTRY : undefined),
    schedule: { state: appearanceSchedule, now: clock(), zone: timeZone },
    ...(selectedProject !== undefined && projectLooks[selectedProject] ? { project: projectLooks[selectedProject] } : {}),
  };
}

/** Every project's own look, checked again here; main asks core's themes.projectLooks after each theme change. */
export function setProjectLooks(raw: Readonly<Record<string, unknown>>): void {
  const next = Object.fromEntries(Object.entries(raw).flatMap(([key, value]) => {
    const look = checkProjectLook(value);
    return look ? [[key, look] as const] : [];
  }));
  if (JSON.stringify(next) === JSON.stringify(projectLooks)) return;
  projectLooks = next;
  refresh();
}

/** The selected project, whose own look shows; selecting one never applies a window arrangement. */
export function setSelectedProject(key: string | undefined): void {
  if (key === selectedProject) return;
  selectedProject = key;
  refresh();
}

/** A project's own look as main holds it; undefined when it has none. */
export function projectLookOf(key: string): ProjectLook | undefined {
  return projectLooks[key];
}

/** appearance.json's schedule and pick as main read and checked them. */
export function setAppearanceSchedule(next: AppearanceSchedule): void {
  if (JSON.stringify(next) === JSON.stringify(appearanceSchedule)) return;
  appearanceSchedule = next;
  refresh();
}

/** The zone the shell page reports from Intl; whether it changed what main evaluates schedules in. */
export function setReportedTimeZone(zone: string): boolean {
  const changed = zone !== timeZone;
  zoneReported = true;
  if (!changed) return false;
  timeZone = zone;
  refresh();
  return true;
}

/** Main's clock for schedules; undefined restores Date.now. As time passing does, it evaluates nothing until the next re-evaluation. */
export function setThemeClock(next: (() => number) | undefined): void {
  clock = next ?? Date.now;
}

/** Evaluates the schedule again: the tick, a resume from sleep and an unlocked screen. State-based, so a repeat changes nothing. */
export function reevaluateTheme(): void {
  refresh();
}

/** What Settings' schedule screen evaluates with: the schedule, main's clock and zone, and the OS kind as last known. */
export function currentScheduleView(): { readonly state: AppearanceSchedule; readonly now: number; readonly zone: string; readonly zoneReported: boolean; readonly osKind: ThemeKind } {
  return { state: appearanceSchedule, now: clock(), zone: timeZone, zoneReported, osKind: knownOsKind ?? current().theme.kind };
}

/** Main's clock for schedules, which a pick's hold over the schedule starts from. */
export function themeNow(): number {
  return clock();
}

// The inputs as a held before-snapshot had them: its preferred looks and theme files and, when it holds them, the mode, the
// schedule with its pick, and the project looks. An item the snapshot lacks did not change, so today's stands.
function heldInputs(inputs: AppearanceInputs, look: HeldLook): AppearanceInputs {
  const { project: _current, ...rest } = inputs;
  const project = look.projectLooks === undefined ? inputs.project : selectedProject === undefined ? undefined : look.projectLooks[selectedProject];
  return {
    ...rest,
    ...(look.mode !== undefined ? { mode: look.mode } : {}),
    preferred: { ...inputs.preferred, ...look.preferred },
    theme: (id) => (look.themes.has(id) ? look.themes.get(id) : inputs.theme(id)),
    ...(look.schedule !== undefined && inputs.schedule ? { schedule: { ...inputs.schedule, state: look.schedule } } : {}),
    ...(project ? { project } : {}),
  };
}

// Show wallpapers as the window paints it: a held look's while it paints the whole window, since its change may have set it.
function wallpapersEnabled(): boolean {
  return held?.scope === 'window' && held.look.showWallpapers !== undefined ? held.look.showWallpapers : showWallpapers;
}

/**
 * Whether the live inputs resolve to the look a held before-snapshot describes: core's revert has reached every input main
 * reads on its own (the settings, the theme files, the schedule, the project looks). True with no held look.
 */
export function heldLookSettled(): boolean {
  if (!held) return true;
  const inputs = appearanceInputs();
  const live = JSON.stringify(resolveShown(inputs)) === JSON.stringify(resolveShown(heldInputs(inputs, held.look)));
  return live && (held.look.showWallpapers === undefined || held.look.showWallpapers === showWallpapers);
}

function resolveNow(): NonNullable<typeof shown> {
  const inputs = appearanceInputs();
  // the look from before an agent's on-the-fly change: the window's at a launch that reverts it, trusted UI's during the countdown
  const before = held ? resolveShown(heldInputs(inputs, held.look)) : undefined;
  const base = held?.scope === 'window' ? before! : resolveShown(inputs);
  const basePalette = shownPalette(base);
  const theme = preview ? resolveShown({ ...inputs, preview }) : base;
  const palette = theme === base ? basePalette : shownPalette(theme);
  const trustedLook = held?.scope === 'trusted' ? before! : base;
  const trustedLookPalette = trustedLook === base ? basePalette : shownPalette(trustedLook);
  const setIndex = theme.decidedBy === 'preview' ? preview?.setIndex ?? 0 : cycleIndex({ themeId: theme.themeId, kind: theme.kind, sets: theme.look.wallpapers?.length ?? 0, minutes: theme.look.cycle?.minutes });
  const wallpapers = shownWallpapers(theme, palette, { enabled: wallpapersEnabled(), contrast: wallpaperContrast, ...environment }, statsOf, (sha) => `${APP_ORIGIN}/theme-blob/${sha}`, setIndex, flashOf);
  const pagePalette = wallpapers ? { ...palette, ...wallpapers.tokens } : palette;
  const regionExtra = wallpapers ? { [SURFACE_ALPHA_TOKEN]: wallpapers.trustedAlpha } : {};
  const characters = charactersOf(theme, inputs);
  return {
    theme,
    palette,
    base,
    basePalette,
    css: `${FONT_FACE_CSS}\n${pageCss(theme, pagePalette, textSize)}`,
    trusted: { region: trustedCss(trustedLookPalette, trustedLook.kind, 'region', trustedLook.style, textSize, regionExtra), root: trustedCss(trustedLookPalette, trustedLook.kind, 'root', trustedLook.style, textSize) },
    trustedBackground: opaqueBackground(trustedPalette(trustedLookPalette, trustedLook.kind)),
    // forced colors and safe start show a built-in look, which has no custom CSS
    custom: theme.builtin ? {} : scopedThemeCss(theme),
    ...(wallpapers ? { wallpapers } : {}),
    ...(characters ? { characters } : {}),
  };
}

/**
 * The characters the window shows: under forced colors those of the look that would show without it, held on their first frame;
 * none in safe start, which shows Damocles as it ships.
 */
function charactersOf(theme: ShownTheme, inputs: Parameters<typeof resolveShown>[0]): ShownCharacters | undefined {
  if (theme.decidedBy === 'safeStart') return undefined;
  const forced = theme.decidedBy === 'forcedColors';
  const source = forced ? resolveShown({ ...inputs, forcedColors: false, ...(preview ? { preview } : {}) }) : theme;
  if (source.decidedBy === 'safeStart') return undefined;
  const still = forced || reducedMotion || motion.osReducedMotion !== false;
  const set = { themeId: source.themeId, ...(source.characters ? { characters: source.characters } : {}), ...(source.assets ? { assets: source.assets } : {}) };
  return shownCharacters(set, projectPins, { url: (sha) => `${APP_ORIGIN}/theme-blob/${sha}`, flash: flashOf }, still ? 'still' : characterMotion);
}

/** projects.json as main read and checked it; the characters projects pin. */
export function setProjectPins(next: ProjectsFile): void {
  if (JSON.stringify(next) === JSON.stringify(projectPins)) return;
  projectPins = next;
  refresh();
}

/** The characters the window shows now; undefined while every project shows its letter. */
export function currentCharacters(): ShownCharacters | undefined {
  return current().characters;
}

// Every theme file whose blobs a page may be painting: the library's, and those of a held before-look, which the files no
// longer hold.
function paintableThemes(): ThemeFile[] {
  const entries = [...(followed?.library?.entries().values() ?? []), ...(held?.look.themes.values() ?? [])];
  return entries.flatMap((entry) => (entry?.status === 'ok' ? [entry.theme] : []));
}

/** The blob a theme main read, a held before-look, the transient preview or a pin names as a character sprite, with its declared type. */
export function namedSpriteBlob(sha256: string): { readonly mime: string } | undefined {
  const named = (assets: ThemeFile['assets']): string | undefined => {
    const asset = assets?.[sha256];
    return asset?.kind === 'sprite' ? asset.mime : undefined;
  };
  const found = (preview ? named(preview.assets) : undefined)
    ?? paintableThemes().map((theme) => named(theme.assets)).find((mime) => mime !== undefined)
    ?? Object.values(projectPins.pins).map((pin) => named(pin.everyTheme?.assets)).find((mime) => mime !== undefined);
  return found === undefined ? undefined : { mime: found };
}

// A wallpaper's stats, or undefined while main reads them; the read refreshes the look once it lands.
function statsOf(sha256: string): ImageStats | undefined {
  const known = wallpaperStats.get(sha256);
  if (known || !statsReader || statsAsked.has(sha256)) return known;
  statsAsked.add(sha256);
  void statsReader(sha256).then((stats) => {
    if (!stats) return;
    wallpaperStats.set(sha256, stats);
    refresh();
  }, () => undefined);
  return undefined;
}

/** Where main reads a wallpaper's luminance percentiles (core's cache); main reads one again after `invalidateWallpaperStats`. */
export function setWallpaperStatsReader(reader: (sha256: string) => Promise<ImageStats | undefined>): void {
  statsReader = reader;
}

// A moving wallpaper's flash check, or undefined while main reads it; read again after every invalidation, since the user's
// allowance changes it in place.
function flashOf(sha256: string): FlashRecord | undefined {
  const known = wallpaperFlashes.get(sha256);
  if (!flashReader || flashAsked.has(sha256)) return known;
  flashAsked.add(sha256);
  const generation = flashGeneration;
  void flashReader(sha256).then((record) => {
    if (generation !== flashGeneration) return;
    const before = wallpaperFlashes.get(sha256);
    if (record) wallpaperFlashes.set(sha256, record);
    else wallpaperFlashes.delete(sha256);
    if (JSON.stringify(before) !== JSON.stringify(record)) refresh();
  }, () => undefined);
  return known;
}

/** Where main reads a moving wallpaper's flash check (core's cache). */
export function setWallpaperFlashReader(reader: (sha256: string) => Promise<FlashRecord | undefined>): void {
  flashReader = reader;
}

/** Core wrote the theme files or a wallpaper's analysis or allowance: stats it lacked and every flash check are read again. */
export function invalidateWallpaperStats(): void {
  statsAsked.clear();
  flashAsked.clear();
  flashGeneration += 1;
  refresh();
}

/** Which of its wallpaper sets a look shows now; `wallpaperCycleChanged` paints a change. */
export function setWallpaperCycle(reader: (look: CycleLook) => number): void {
  cycleIndex = reader;
  refresh();
}

export function wallpaperCycleChanged(): void {
  refresh();
}

/** The window's focus, visibility, minimized state and the power state, which pause moving wallpapers. */
export function setMotionEnvironment(next: Partial<typeof motion>): void {
  const merged = { ...motion, ...next };
  if (Object.entries(merged).every(([key, value]) => motion[key as keyof typeof motion] === value)) return;
  motion = merged;
  refresh();
}

/** Whether moving wallpapers play now, and every reason they do not. */
export function currentWallpaperMotion(): { readonly play: boolean; readonly paused: readonly MotionPause[] } {
  const { osReducedMotion, ...rest } = motion;
  return wallpaperMotion({
    ...rest,
    reduceMotion: reducedMotion || osReducedMotion !== false,
    forcedColors: current().theme.decidedBy === 'forcedColors',
    wallpapersShown: current().wallpapers !== undefined,
  });
}

/** GPU compositing and the OS's reduced transparency, which turn wallpapers off and surfaces opaque. */
export function setWallpaperEnvironment(next: { readonly gpuCompositing: boolean; readonly reducedTransparency: boolean }): void {
  if (next.gpuCompositing === environment.gpuCompositing && next.reducedTransparency === environment.reducedTransparency) return;
  environment = { ...next };
  refresh();
}

/** The wallpapers the window draws now; undefined while none shows. */
export function currentWallpapers(): ShownWallpapers | undefined {
  return current().wallpapers;
}

/** Why the shown look's wallpapers do not show, when it has any. */
function currentWallpapersOff(): WallpapersOff | undefined {
  const theme = current().theme;
  if (!(theme.look.wallpapers?.length)) return undefined;
  return wallpapersOff(theme, { enabled: wallpapersEnabled(), gpuCompositing: environment.gpuCompositing });
}

/** The chat panel shows a wallpaper, so the chat view and its page are see-through over the chat slot. */
export function chatSeeThrough(): boolean {
  return current().wallpapers?.regions.some((region) => region.panel === 'chat') === true;
}

/** The blob a theme main read, a held before-look or the transient preview names as a wallpaper, with its kind and declared type. */
export function namedImageBlob(sha256: string): { readonly kind: WallpaperKind; readonly mime: string } | undefined {
  const named = (theme: Pick<ThemeFile, 'assets'>): { kind: WallpaperKind; mime: string } | undefined => {
    const asset = theme.assets?.[sha256];
    return asset && isWallpaperAsset(asset) ? { kind: asset.kind as WallpaperKind, mime: asset.mime } : undefined;
  };
  const fromPreview = preview ? named(preview) : undefined;
  if (fromPreview !== undefined) return fromPreview;
  for (const theme of paintableThemes()) {
    const found = named(theme);
    if (found !== undefined) return found;
  }
  for (const look of [...Object.values(projectLooks), ...Object.values(held?.look.projectLooks ?? {})]) {
    const found = look.mode === 'touches' && look.assets ? named(look) : undefined;
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * What a pendingConfirm entry's before-snapshot held: the preferred looks it set and the theme files it changed (undefined:
 * none). Every input of the shown look a change can write is here, or the held look is not the one from before.
 */
export interface HeldLook {
  readonly preferred: Partial<Record<ThemeKind, string>>;
  readonly themes: ReadonlyMap<string, LibraryEntry | undefined>;
  // projects.json's looks from before, when the change set a project's look
  readonly projectLooks?: Readonly<Record<string, ProjectLook>>;
  // damocles.desktop.theme from before, when the change set it
  readonly mode?: ThemePreference;
  // appearance.json's schedule and pick from before, when the change wrote the file
  readonly schedule?: AppearanceSchedule;
  // Show wallpapers from before, when the change set it
  readonly showWallpapers?: boolean;
}

/**
 * The look from before an agent's on-the-fly change, painted on the whole window (`window`: a launch whose last run ended
 * during the countdown, until core's revert lands) or on trusted UI only (`trusted`: the countdown); undefined ends it.
 */
export function setHeldLook(next: { readonly look: HeldLook; readonly scope: 'window' | 'trusted' } | undefined): void {
  held = next;
  refresh();
}

export function heldLookScope(): 'window' | 'trusted' | undefined {
  return held?.scope;
}

/** The blob a theme main read, a held before-look or the transient preview names as a bundled font, with its declared type; undefined otherwise. */
export function namedFontBlob(sha256: string): { readonly mime: string } | undefined {
  const named = (theme: Pick<ShownTheme, 'style' | 'assets'>): string | undefined => bundledFonts(theme).find((font) => font.sha256 === sha256)?.mime;
  const fromPreview = preview ? named(preview) : undefined;
  if (fromPreview !== undefined) return { mime: fromPreview };
  for (const theme of paintableThemes()) {
    const mime = named(theme);
    if (mime !== undefined) return { mime };
  }
  return undefined;
}

function current(): NonNullable<typeof shown> {
  shown ??= resolveNow();
  return shown;
}

/** The look the window shows now (docs/invariants.md "Desktop themes"), a transient preview included. */
export function currentShown(): ShownTheme {
  return current().theme;
}

/** The look the window shows without the transient preview: what Settings names and trusted UI takes its palette from. */
export function currentBaseShown(): ShownTheme {
  return current().base;
}

/** The look that shows once forced colors and safe start end, without the transient preview. */
export function decidedShown(): ShownTheme {
  const { safeStart: _safeStart, ...inputs } = appearanceInputs();
  return resolveShown({ ...inputs, forcedColors: false });
}

/** Safe start for this run (`--damocles-safe-theme`, Help › Restart with Damocles Theme, the crash loop, or Reset while the engine is down); undefined ends it. */
export function setSafeStart(reason: SafeStartReason | undefined): void {
  if (safeStart === reason) return;
  safeStart = reason;
  refresh();
}

export function safeStartReason(): SafeStartReason | undefined {
  return safeStart;
}

/** Paints `next` on the window without saving it, or ends the preview; trusted UI keeps the palette from before it. */
export function setThemePreview(next: TransientPreview | undefined): void {
  if (preview === next) return;
  preview = next;
  refresh();
}

export function currentThemeKind(): ThemeKind {
  return current().theme.kind;
}

/** The color the window and every view paint before their page does. */
export function shownBackground(): string {
  return opaqueBackground(current().palette);
}

/** The color an opaque trusted view (the theme editor dock) paints before its page does: the trusted palette's --d-bg. */
export function trustedBackground(): string {
  return current().trustedBackground;
}

/**
 * What a renderer gets; `scope` root makes the trusted palette the overlay's, the notifier's or the editor dock's whole page
 * palette. `page` names the content page whose regions' custom CSS it gets; no other renderer gets any.
 */
export function currentTheme(scope: TrustedScope = 'region', page?: CustomCssPage): PanelTheme {
  const { theme, css, trusted, custom } = current();
  const customCss = scope === 'region' && page !== undefined ? pageCustomCss(custom, page) : undefined;
  return { kind: theme.kind, css, trustedCss: trusted[scope], ...(customCss !== undefined ? { customCss } : {}), reducedMotion, fileIconTheme };
}

/** The shown look's density, which scales main's own layout minimums as Tailwind's --spacing scales the pages'. */
export function currentDensity(): number {
  return Number(styleTokens(current().theme.style)['--d-density'] ?? 1);
}

/** damocles.desktop.textSize in px. */
export function currentTextSize(): number {
  return textSize;
}

// Resolves the shown look again and tells the theme listeners when anything a renderer gets changed.
function refresh(notify = true, writeSource = true): void {
  shown = resolveNow();
  // the OS kind is readable only while themeSource is 'system', so a look it chooses is resolved again once it is
  if (writeSource && writeThemeSource(shown.base) === 'system') shown = resolveNow();
  const theme = currentTheme();
  const next = JSON.stringify([theme.kind, shown.theme.themeId, shown.base.themeId, shown.theme.decidedBy, theme.css, theme.trustedCss, shown.custom, theme.reducedMotion, theme.fileIconTheme, shown.wallpapers?.regions, shown.wallpapers?.lowContrast, currentWallpapersOff(), currentWallpaperMotion(), shown.characters]);
  if (next !== signature) {
    signature = next;
    if (notify) for (const listener of [...appearanceListeners]) listener();
  }
  for (const listener of [...inputListeners]) listener();
}

// Writes nativeTheme.themeSource for the look shown without a transient preview, and returns what it wrote. It follows what
// chose the look (the settings, the schedule, forced colors); an `updated` that reports an OS switch never calls it.
function writeThemeSource(base: ShownTheme): ThemePreference | undefined {
  if (!followed) return undefined;
  // Electron cannot be told the OS's kind, so under a stand-in native menus and scrollbars follow its kind set directly
  const source = osStandIn === undefined ? themeSourceFor(base) : base.kind;
  if (nativeTheme.themeSource === source) return undefined;
  nativeTheme.themeSource = source;
  return source;
}

/**
 * Applies damocles.desktop.theme and the preferred looks, damocles.desktop.reduceMotion and fileIconTheme now and on every
 * change, the theme files on every change `library` reports, and the OS kind and forced colors on nativeTheme's `updated`.
 */
export function followThemeSettings(settings: ThemeSettings, library?: ThemeLibrary): Disposable {
  followed = { settings, library };
  let forced = nativeTheme.inForcedColorsMode === true;
  const apply = (notify = true): void => {
    reducedMotion = settings.get<unknown>(REDUCE_MOTION_SETTING) === true;
    fileIconTheme = parseFileIconTheme(settings.get<unknown>(FILE_ICON_THEME_SETTING));
    textSize = parseTextSize(settings.get<unknown>(TEXT_SIZE_SETTING));
    showWallpapers = settings.get<unknown>(SHOW_WALLPAPERS_SETTING) !== false;
    wallpaperContrast = settings.get<unknown>(WALLPAPER_CONTRAST_SETTING) === 'warn' ? 'warn' : 'raiseDim';
    const motionSetting = settings.get<unknown>(CHARACTER_MOTION_SETTING);
    characterMotion = CHARACTER_MOTIONS.find((value) => value === motionSetting) ?? 'always';
    refresh(notify);
  };
  // an OS switch nativeTheme reports never writes themeSource; a forced colors change does
  const updated = (): void => {
    const forcedNow = nativeTheme.inForcedColorsMode === true;
    const forcedChanged = forcedNow !== forced;
    forced = forcedNow;
    environment = { ...environment, reducedTransparency: nativeTheme.prefersReducedTransparency === true };
    refresh(true, forcedChanged);
  };
  // the first paint reads the theme itself, so nothing is told
  environment = { ...environment, reducedTransparency: nativeTheme.prefersReducedTransparency === true };
  apply(false);
  nativeTheme.on('updated', updated);
  const subscriptions = [settings.onDidChange('damocles.desktop', () => apply()), ...(library ? [library.onDidChange(() => refresh())] : [])];
  return {
    dispose: () => {
      nativeTheme.off('updated', updated);
      for (const subscription of subscriptions) subscription.dispose();
      if (followed?.settings === settings) followed = undefined;
    },
  };
}

/** Told after every evaluation of the look's inputs, whether or not what a renderer gets changed: a held look hides such a change. */
export function onThemeInputsChange(listener: () => void): Disposable {
  inputListeners.add(listener);
  return { dispose: () => inputListeners.delete(listener) };
}

export function onThemeChange(listener: (theme: PanelTheme) => void): Disposable {
  const handler = (): void => listener(currentTheme());
  appearanceListeners.add(handler);
  return { dispose: () => appearanceListeners.delete(handler) };
}
