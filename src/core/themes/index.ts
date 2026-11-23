// The desktop theme store of this computer's Damocles Core (docs/invariants.md "Desktop themes"). A daemon's core never builds it.
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Disposable } from '../../platform/disposable';
import type { SettingsStore } from '../../platform/settings-store';
import { LocalizedError, type LocalizedText } from '../../shared/localized-text';
import { MAX_COUNTDOWN_OWNERS, type PendingConfirm, type ThemeLaterChange } from '../../shared/themes/agent';
import { arrangementApplies, copiedLayoutOptIn } from '../../shared/themes/arrangement';
import { BUILTIN_THEME, BUILTIN_THEME_ID } from '../../shared/themes/builtin';
import { restoredChange, USER_ACTOR, type ThemeActor, type ThemeHistoryChange, type ThemeHistoryEntry, type ThemeModeValue } from '../../shared/themes/changes';
import { characterAssets, PROJECTS_FILE, spriteIsAnimated, spriteNeedsAnalysis, spriteStrip, type CharacterStrip, type SpriteImport } from '../../shared/themes/characters';
import { bundledFonts, fontNameOf, MAX_FONT_BYTES, type FontImport } from '../../shared/themes/fonts';
import type { ThemeExportFontBytes, ThemeExportPlan, ThemeInstallClash, ThemeInstallCommit, ThemeInstallCommitted, ThemeInstallFrom, ThemeInstallPreview, ThemeInstallProgress } from '../../shared/themes/install';
import { THEME_ID } from '../../shared/themes/limits';
import { checkProjectLook, type ProjectLook } from '../../shared/themes/project-looks';
import { sameSchedule, type AppearanceSchedule, type ScheduleChoice, type ScheduleOverride, type ScheduleRule, type ThemeSchedule } from '../../shared/themes/schedule';
import { MAX_REMOVED_REASON_CHARS, validateTheme, type Arrangement, type AssetMeta, type Origin, type ThemeFile, themeErrorText } from '../../shared/themes/schema';
import { parseStoredJson } from '../../shared/themes/stored-json';
import { LOOK_KINDS, type LookKind } from '../../shared/themes/tokens';
import { CACHE_FOLDER, isMoving, isWallpaperAsset, type FlashRecord, type ImageStats, type WallpaperImport, type WallpaperKind, type WallpaperPalette } from '../../shared/themes/wallpapers';
import { writeJsonConfig } from '../config/json-config-write';
import type { ConfigNotices } from '../config/local-config-path';
import { parseSettingsText } from '../config/settings-file';
import { errorTextOf, l } from '../l10n';
import { oneLine } from '../pi-session/untrusted-text';
import type { RelocationAliases } from '../project-relocation/aliases';
import { currentRelocations } from '../project-relocation/current';
import { APPEARANCE_FILE, createAppearanceStore } from './appearance-store';
import { checkWallpaper, readWallpaperFile, wallpaperAsset } from './assets';
import { createCountdownLock } from './countdown-lock';
import { BLOB_GRACE_MS, BLOBS_FOLDER, createBlobStore, SHA256 } from './blobs';
import { readBuiltinAsset, readBuiltinExamples, readBuiltinLicense } from './builtins';
import { createWallpaperCache, type SpriteAnalysis, type WallpaperAnalysis } from './cache';
import { applyPinEdits, checkSprite, createProjectsStore, spriteAsset, type PinEdit } from './characters';
import { createDraftStore, type DraftOwner, type ThemeDraft } from './drafts';
import { buildExport, checkExportPath, planExport, type ExportSource } from './export';
import { FontInfoError, readFontInfo, shareableLicense } from './font-info';
import { createThemeHistory, HISTORY_FILE, HISTORY_FOLDER, MAX_HISTORY_BYTES, touchedItems, type Snapshot, type SnapshotIo, type StoredEntry } from './history';
import { contentHash, createThemeInstalls, installClash, originKind, updateTarget, yourEditsNameOf, type StageInput } from './install';
import { createThemePathRule } from './network-rule';
import { createProjectLooks, type ProjectLooks } from './project-looks';
import type { StripCut } from './sprite-header';
import { MAX_STATE_FILE_BYTES, readCapped } from './state-file';
import {
  createThemeStore, eachLimited, isUserThemeId, MAX_THEME_FILE_BYTES, noLook, READ_CONCURRENCY, removeOrphanedTemps, THEMES_FOLDER, THEME_FILE, writeFileAtomic,
  type ThemeListEntry, type ThemeStore,
} from './store';
import { untilAborted } from './until-aborted';
import type { WriteLane } from './write-lane';

export { createThemeStore, isUserThemeId, type ThemeListEntry, type ThemeStore } from './store';
export { DraftLimitError, MAX_DRAFTS, MAX_DRAFTS_PER_CHAT, type DraftOwner, type ThemeDraft } from './drafts';
export { WEEKDAYS, type ThemeScheduleData, type Weekday } from './appearance-store';
export type { SpriteAnalysis, WallpaperAnalysis } from './cache';
export type { PinEdit } from './characters';
export type { ProjectLooks } from './project-looks';

// Must match THEMES_DARK_SETTING and THEMES_LIGHT_SETTING in src/desktop/local-services/desktop-configuration.ts.
export const PREFERRED_LOOK_SETTINGS: Readonly<Record<LookKind, string>> = {
  dark: 'damocles.desktop.themes.dark',
  light: 'damocles.desktop.themes.light',
};
// Must match THEME_SETTING in src/desktop/local-services/desktop-configuration.ts.
export const THEME_MODE_SETTING = 'damocles.desktop.theme';
// Must match SHOW_WALLPAPERS_SETTING in src/desktop/local-services/desktop-configuration.ts.
export const SHOW_WALLPAPERS_SETTING = 'damocles.desktop.themes.showWallpapers';

export type { ScheduleChoice };

const modeOf = (value: string | null): ThemeModeValue => (value === 'dark' || value === 'light' ? value : 'system');

// A save's answer: the hash of the file as written, or `changed` when the file no longer held the text the caller edited.
export type ThemeSaved = { readonly hash: string } | { readonly changed: true };

class BaseMoved extends Error {}

export interface ThemeService {
  list(): Promise<ThemeListEntry[]>;
  // newest first
  history(): Promise<ThemeHistoryEntry[]>;
  // a user theme replaced whole by `theme`, validated; unknown keys of the file and its origin are kept, and its custom CSS
  // as the sanitizer keeps it. `pins` change projects.json for that theme in the same history entry. With `baseHash` (the
  // hash `editBase` gave for the file the caller edited) a file that holds another text now is left as it is.
  saveTheme(id: string, theme: unknown, actor?: ThemeActor, pins?: readonly PinEdit[], baseHash?: string): Promise<ThemeSaved>;
  duplicate(id: string, name: string, actor?: ThemeActor): Promise<string>;
  rename(id: string, name: string, actor?: ThemeActor): Promise<void>;
  remove(id: string, actor?: ThemeActor): Promise<void>;
  // the preferred look of `kind`, which shows when the mode or the OS kind selects that kind; while the schedule runs it also
  // holds over the schedule from `at` (default now) until the next rule start. `arrangementBefore` is the window arrangement
  // main replaces with the theme's own, which Undo gives back. Whether an entry was recorded: none is for the look already
  // preferred with no schedule to hold over, and main then leaves the window's arrangement as it is
  pick(id: string, kind: LookKind, options?: { readonly arrangementBefore?: unknown; readonly actor?: ThemeActor; readonly at?: number }): Promise<boolean>;
  // both preferred looks back to the built-in theme in one settings write, appearance.json's pick and schedule off, and the
  // look of `projectKey` (the selected project) off
  reset(actor?: ThemeActor, projectKey?: string): Promise<void>;
  // projects.json's looks and pins by project key, which follow relocation and forgetting
  readonly projectLooks: ProjectLooks;
  // the project's own look, or none for null, as one history entry; on the fly, marked for the keep-changes banner. `name`
  // is the project's name, which the entry keeps. Undefined when the look was already that.
  setProjectLook(projectKey: string, look: ProjectLook | null, options: { readonly name: string; readonly actor?: ThemeActor; readonly onTheFly?: boolean }): Promise<(Recorded & { readonly change: ThemeHistoryChange }) | undefined>;
  // damocles.desktop.themes.showWallpapers turned off as one history entry; on the fly, marked for the keep-changes banner.
  // Undefined when the user settings already have it off.
  wallpapersOff(actor: AgentActor, onTheFly: boolean): Promise<(Recorded & { readonly change: ThemeHistoryChange }) | undefined>;
  // damocles.desktop.theme; System turns a schedule off in the same history entry, and a mode change alone records none
  setMode(mode: ThemeModeValue, actor?: ThemeActor): Promise<void>;
  // the schedule screen's mode: Use a schedule and Off change a System mode to `showing`, the kind on screen now; one history
  // entry when it turns the schedule on or off, none when only the mode changes
  setScheduleMode(choice: ScheduleChoice, showing: LookKind, actor?: ThemeActor): Promise<void>;
  // appearance.json's schedule and the pick that holds over it
  schedule(): Promise<AppearanceSchedule>;
  // ends the pick that holds over the schedule
  resumeSchedule(actor?: ThemeActor): Promise<void>;
  // shows `themeId`'s `kind` look over the running schedule from `at` until its next rule start, preferred looks unchanged
  hold(themeId: string, kind: LookKind, at: number, actor?: ThemeActor): Promise<void>;
  // the newest change reversed and dropped from the history; the arrangement main gives back, when it took one. With
  // `pendingEntryId` (the keep-changes banner's revert) the countdown's every change, that entry and each later one, is
  // reversed instead, and nothing happens unless the mark still names that entry.
  // `expected` names the entry the caller means to reverse: when another change is the newest, the call is refused.
  undo(pendingEntryId?: string, expected?: string): Promise<{ readonly undone?: ThemeHistoryChange; readonly arrangement?: unknown }>;
  // a user theme as its file holds it now and that same text's hash, from one read, for a draft that edits it; undefined
  // when it has no file or the file is no theme this Damocles can edit
  editBase(id: string): Promise<{ readonly theme: ThemeFile; readonly hash: string } | undefined>;
  // appearance.json's object; undefined when it is missing, unreadable or another version
  appearance(): Promise<Record<string, unknown> | undefined>;
  readonly drafts: ThemeDrafts;
  // every draft, at core start
  sweepDrafts(): Promise<number>;
  // the draft's theme saved (after its baseHash check) and picked for `pick`, as one history entry of the agent
  applyDraft(apply: DraftApply): Promise<DraftApplyResult>;
  // whether applyDraft's pick of the draft would put its window arrangement in place, as of now
  draftArrangementApplies(draft: ThemeDraft): Promise<boolean>;
  // appearance.json's schedule replaced, as one history entry; turning it on changes a System mode to `showing`, the kind on
  // screen now, so the mode and the schedule screen agree. Undefined when the schedule and the mode were already that.
  setSchedule(schedule: ThemeSchedule, actor: ThemeActor, onTheFly: boolean, showing?: LookKind): Promise<Recorded | undefined>;
  // the schedule's rules replaced, as one history entry; whether it is on stays as appearance.json has it when the write
  // runs, so a caller's older read never turns it on or off. Nothing is recorded when the rules were already these.
  setScheduleRules(rules: readonly ScheduleRule[], actor?: ThemeActor): Promise<void>;
  // what the chat's undo would revert now
  agentUndoTarget(chatId: string): Promise<AgentUndoTarget>;
  // reverts `entryId`, the chat's newest entry, checked again under the lane, as a new entry Undo can reverse; `currentArrangement`
  // is read only when the entry put a window arrangement in place, which the result gives back
  agentUndo(entryId: string, actor: AgentActor, onTheFly: boolean, currentArrangement: () => Promise<unknown>): Promise<AgentUndoResult>;
  // the keep-changes banner's Keep: the mark goes when it still names `entryId`
  keep(entryId: string): Promise<void>;
  pendingConfirm(): Promise<PendingConfirm | undefined>;
  // a mark a crash or force-quit left: the countdown's every change undone and the mark cleared. Answers how its countdown
  // ended, with the window arrangement the revert put back; kept when the revert failed; undefined when there was no mark
  settlePendingAtStart(): Promise<PendingAtStart | undefined>;
  // the same for a countdown a start left to another running app, asked again later: nothing while this app counts it too
  settlePendingLeft(): Promise<PendingAtStart | undefined>;
  // the banner ended because of a change it did not make
  onPendingSettled(listener: (settled: PendingSettled) => void): Disposable;
  // a change that is not on the fly joined the running countdown, which restarts
  onPendingExtended(listener: (extended: PendingExtended) => void): Disposable;
  restore(entryId: string, arrangementNow?: unknown, actor?: ThemeActor): Promise<{ readonly arrangement?: unknown }>;
  // a font file stored as a blob for a theme to bundle; refused for a collection, a restricted font or one over the size cap.
  // Not a history entry: the save that names it is.
  importFont(bytes: Uint8Array): Promise<FontImport>;
  // a still or moving wallpaper stored as a blob and analyzed by the theme renderer, a moving one's flash check included; refused
  // past its kind's caps or when its pixels do not decode as its header says. Not a history entry: the save that names it is.
  // `signal` ends the wait for the renderer.
  importImage(source: { readonly file: string } | { readonly bytes: Uint8Array; readonly name?: string }, signal?: AbortSignal): Promise<WallpaperImport>;
  // a character sprite stored as a blob, cut into `strip` when given, and checked by the theme renderer (its flash check and
  // still frame); refused past the sprite caps. Not a history entry: the save that names it is.
  // `signal` ends the wait for the renderer.
  importSprite(source: { readonly file: string } | { readonly bytes: Uint8Array; readonly name?: string }, strip?: StripCut, signal?: AbortSignal): Promise<SpriteImport>;
  setSpriteAnalyzer(analyze: SpriteAnalyzer | undefined): void;
  // what the renderer derived from a wallpaper, undefined before its analysis
  wallpaperStats(sha256: string): Promise<ImageStats | undefined>;
  wallpaperPalette(sha256: string): Promise<WallpaperPalette | undefined>;
  wallpaperFlash(sha256: string): Promise<FlashRecord | undefined>;
  // the user's "Allow flashing for this file" on this computer, from the theme editor or an install card; false before the file's
  // flash check. Every staged install listing the file says so.
  allowFlash(sha256: string): Promise<boolean>;
  // an install card's Allow: only for a wallpaper the staged install lists as flagged; whether it is allowed now
  installAllowFlash(installId: string, sha256: string): Promise<boolean>;
  // how far the theme renderer's flash check of `sha256` is, which the install cards waiting on it show
  analyzeProgress(sha256: string, fraction: number): void;
  onInstallProgress(listener: (progress: ThemeInstallProgress) => void): Disposable;
  // analyzes every wallpaper and character sprite a theme names that has no derived files yet; the analysis runs in main's
  // theme renderer. failed: how many could not be analyzed, which a later pass tries again
  analyzeMissing(): Promise<{ readonly analyzed: number; readonly failed: number }>;
  setAnalyzer(analyze: WallpaperAnalyzer | undefined): void;
  // removes the blobs no theme file or history entry names, older than BLOB_GRACE_MS, and the derived files of gone ones
  collectBlobs(): Promise<number>;
  // a file or https URL read and checked into a staged install the install card lists; its assets are stored as blobs and their
  // flash checks start. Throws a LocalizedError naming the refusal. Nothing is installed before installCommit.
  installPrepare(from: ThemeInstallFrom, options?: { readonly agent?: boolean; readonly signal?: AbortSignal }): Promise<ThemeInstallPreview>;
  // the staged install under a new id (Replace: the replaced theme's), one history entry; waits for its running flash checks
  installCommit(commit: ThemeInstallCommit, actor?: ThemeActor): Promise<ThemeInstallCommitted>;
  // the staged install and the blobs only it named go
  installCancel(installId: string): Promise<void>;
  // whether the install is still staged: not committed, cancelled or expired
  installOpen(installId: string): boolean;
  // bytes the store client downloaded and pin-checked, read into a staged install the same card lists
  installStage(input: StageInput): Promise<ThemeInstallPreview>;
  // each installed theme of `marks` not yet marked with that reason: marked removed from the store, and every preferred look,
  // schedule rule, held pick and project look naming it moved to the built-in theme, as one history entry; deletes nothing.
  // The themes it marked now.
  markRemovedFromStore(marks: readonly { readonly themeId: string; readonly reason: string }[]): Promise<readonly string[]>;
  onInstallUpdated(listener: (preview: ThemeInstallPreview) => void): Disposable;
  // a staged install waited past STAGED_INSTALL_TTL_MS and was dropped with its blobs; its card can no longer install it
  onInstallExpired(listener: (installId: string) => void): Disposable;
  // the export's file name and font verdicts; installedFonts: the overlay's bytes of installed fonts the theme names
  exportPlan(themeId: string, installedFonts?: readonly ThemeExportFontBytes[]): Promise<ThemeExportPlan>;
  // one .damocles-theme written atomically to the absolute path `file`; its size. Throws a LocalizedError for a Restricted font.
  exportWrite(themeId: string, file: string, installedFonts: readonly ThemeExportFontBytes[]): Promise<number>;
  // after a theme file or the history changed
  onDidChange(listener: () => void): Disposable;
  // the one write lane of the themes root, which the community store list's files share
  readonly lane: WriteLane;
}

/** Main's theme renderer decoding a wallpaper: its thumbnail, luminance percentiles and proposed palette, and a moving one's still frame and flash check. */
export type WallpaperAnalyzer = (sha256: string, image: WallpaperToAnalyze, signal?: AbortSignal) => Promise<WallpaperAnalysis & { readonly width: number; readonly height: number }>;

/** Main's theme renderer checking a character sprite: every frame for flashing, and an animated image's or SVG's first frame. */
export type SpriteAnalyzer = (sha256: string, sprite: SpriteToAnalyze, signal?: AbortSignal) => Promise<SpriteAnalysis>;

export interface SpriteToAnalyze {
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly strip?: CharacterStrip;
  // an animated PNG, GIF or WebP, which moves on its own
  readonly animated: boolean;
}

export interface WallpaperToAnalyze {
  readonly kind: WallpaperKind;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly durationMs?: number;
}

/** The keep-changes banner's end that a change it did not make caused: Undo of its entry reverts, anything else keeps. */
export interface PendingSettled {
  readonly entryId: string;
  readonly outcome: 'kept' | 'reverted';
}

/**
 * What a start made of the countdown the last run left. Reverted, with the window arrangement to put back when this app
 * counted it, or kept when the revert could not be made; counted when an app that still runs counts it, so it was left alone.
 */
export type PendingAtStart = (PendingSettled & { readonly arrangement?: unknown }) | { readonly entryId: string; readonly outcome: 'counted' };

/** A change that is not on the fly joined the countdown of `entryId`, the mark's entry. */
export interface PendingExtended {
  readonly entryId: string;
  readonly change: ThemeHistoryChange;
  readonly actor: ThemeActor;
}

/** Where a change landed in the history: its entry, and on the fly the countdown it started or joined (the mark's entry). */
export interface Recorded {
  readonly entryId: string;
  readonly pending?: string;
}

export type AgentActor = Extract<ThemeActor, { kind: 'agent' }>;

export interface DraftApply {
  readonly draft: ThemeDraft;
  // the looks that become the preferred ones
  readonly pick: readonly LookKind[];
  readonly actor: AgentActor;
  // applied at once and marked pendingConfirm for the keep-changes banner
  readonly onTheFly: boolean;
  // the kind on screen, which a pick of both looks holds over a running schedule
  readonly showing?: LookKind;
  // the window's arrangement, read only when the pick puts the theme's own in place, as a manual pick does
  readonly currentArrangement: () => Promise<unknown>;
}

export interface AppliedDraft {
  readonly themeId: string;
  readonly name: string;
  // the history change recorded
  readonly change: ThemeHistoryChange;
  // the theme that showed in the one picked look before, when one look was picked
  readonly previousName?: string;
  // the theme's window arrangement, which main puts in place now, with the theme's density its minimums scale by
  readonly arrangement?: { readonly layout: Arrangement; readonly density: number };
}

export type DraftApplyResult = { readonly kind: 'outdated' } | ({ readonly kind: 'applied' } & Recorded & AppliedDraft);

export type AgentUndoTarget =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly entry: ThemeHistoryEntry }
  | { readonly kind: 'refused'; readonly entry: ThemeHistoryEntry; readonly later: ThemeLaterChange };

export type AgentUndoResult =
  // change: the history change recorded for the revert; arrangement: the window arrangement it puts back, which main applies
  | ({ readonly kind: 'undone'; readonly undone: ThemeHistoryChange; readonly change: ThemeHistoryChange; readonly arrangement?: unknown } & Recorded)
  | { readonly kind: 'refused'; readonly later: ThemeLaterChange }
  // the chat's newest entry changed since the card showed it
  | { readonly kind: 'gone' };

/** The drafts, each write under the lane. */
export interface ThemeDrafts {
  get(id: string): Promise<ThemeDraft | undefined>;
  put(draft: ThemeDraft): Promise<void>;
  remove(id: string): Promise<void>;
  removeOwnedBy(owner: Pick<DraftOwner, 'authority' | 'sessionId'>): Promise<number>;
  removeRelayedBefore(localAuthority: string, before: number, keep?: ReadonlySet<string>): Promise<number>;
  removeOfAuthority(authority: string): Promise<number>;
  authorities(): Promise<string[]>;
  newId(): string;
}

type Made<T> = { readonly result: T; readonly change: ThemeHistoryChange; readonly before: Snapshot };
// A change's body tells each before-snapshot it takes, ahead of the write that snapshot covers: what it told is what is put
// back when the change fails part-way.
type Taking = (before: Snapshot) => void;
type Body<T> = (taking: Taking) => Promise<Made<T>>;
type Changed<T> = Recorded & { readonly result: T; readonly settled?: PendingSettled; readonly extended?: PendingExtended };

const sameChat = (a: ThemeActor, b: ThemeActor): boolean => a.kind === 'agent' && b.kind === 'agent' && a.chatId === b.chatId;

// The clash commit found against the one the install card showed: the same theme, the same Keep both name and the same options.
const sameClash = (found: ThemeInstallClash, shown: ThemeInstallClash | undefined): boolean =>
  shown !== undefined && found.themeId === shown.themeId && found.name === shown.name && found.keepBothName === shown.keepBothName && found.replaceable === shown.replaceable && found.keepsCopy === shown.keepsCopy;

/** The sha256 of a theme.json text, the base a draft is checked against; null for no file. */
export const hashText = (text: string | null): string | null => (text === null ? null : createHash('sha256').update(text).digest('hex'));

export interface ThemeServiceOptions {
  readonly root: string;
  readonly settings: SettingsStore;
  readonly store?: ThemeStore;
  // the app's resource root, where the built-in example themes are packed
  readonly resourceRoot?: string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  // this process's relocation journal; absent: the one ProjectRelocations installs
  readonly relocations?: () => { readonly aliases: RelocationAliases; readonly pendingKeys: ReadonlySet<string> };
  // the e2e hooks' folder https://e2e.test/<name> installs read; the caller passes it only with the hooks on
  readonly e2eThemeDownloads?: string;
  // where a theme file the network rule refuses to read is told, once per file
  readonly notifications?: ConfigNotices;
  // this app among those that share the themes folder (COUNTDOWN_OWNER), the same at every run of it; one core with it runs
  // at a time. Absent: an id of this service's own.
  readonly owner?: string;
}


function fontRefusal(err: FontInfoError): LocalizedText {
  switch (err.reason) {
    case 'collection': return l('This file is a font collection. Damocles bundles one font per file; pick a single font.');
    case 'tooLarge': return l('This font is larger than {0} MB, the most a theme bundles.', String(MAX_FONT_BYTES / 1024 / 1024));
    case 'unknown': return l('This file is not a WOFF2, WOFF, TrueType or OpenType font.');
    default: return l('This font file could not be read: {0}', err.text);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// Nothing is at the path: the only read failure that means "holds nothing". Any other may pass, so it is never read as empty.
const isAbsent = (err: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '');
const namesIn = (dir: string): Promise<string[]> => fs.readdir(dir).catch((err: unknown): string[] => {
  if (isAbsent(err)) return [];
  throw err;
});

// A stored file's JSON; undefined for no file or one that does not parse, which a write of projects.json starts again
function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return parseStoredJson(text);
  } catch {
    return undefined;
  }
}

// the origin theme.json's text records; undefined for a theme with no file (a built-in) or one that does not validate
function originOf(id: string, text: string | null): Origin | undefined {
  const valid = text === null ? undefined : validateTheme(parseJson(text), { folder: id });
  return valid?.ok ? valid.theme.origin : undefined;
}

export function createThemeService(options: ThemeServiceOptions): ThemeService {
  const { resourceRoot } = options;
  const rule = createThemePathRule(options.root, options.notifications);
  const store = options.store ?? createThemeStore({
    root: options.root, rule, ...(resourceRoot !== undefined ? { examples: () => readBuiltinExamples(resourceRoot) } : {}), ...(options.log ? { log: options.log } : {}),
  });
  // every file of the store is replaced only while the lane's lock is still held
  const writeFile = (file: string, data: string | Uint8Array): Promise<void> => writeFileAtomic(file, data, { held: store.lane.held });
  const appearance = createAppearanceStore(options.root, writeFile, rule, options.log);
  const blobs = createBlobStore(options.root, writeFile, rule);
  const projects = createProjectsStore(options.root, writeFile, rule, options.log);
  const historyFile = path.join(options.root, HISTORY_FOLDER, HISTORY_FILE);
  // Inside the lane: the before-snapshot of a file the change writes, refused as that write when the file links off the store's share.
  const appearanceBefore = async (): Promise<string | null> => {
    await rule.writable(path.join(options.root, APPEARANCE_FILE));
    return appearance.readText();
  };
  const projectsBefore = async (): Promise<string | null> => {
    await rule.writable(path.join(options.root, PROJECTS_FILE));
    return projects.readText();
  };
  const projectLooks = createProjectLooks({ projects, lane: store.lane, changed: () => store.changed(), relocations: options.relocations ?? currentRelocations, history: () => history });
  const now = options.now ?? Date.now;
  const { settings } = options;
  const userFile = (): string => {
    const file = settings.scopeFile('user');
    if (file === undefined) throw new Error('This host keeps no user settings file');
    return file;
  };
  // judged from its own folder, as the settings store judges the user settings file
  const settingsRule = (file: string) => createThemePathRule(path.dirname(file), options.notifications);
  // The preferred looks as the user settings file holds them; null for a key it does not set.
  const readSettings = async (): Promise<Record<LookKind, string | null>> => {
    const file = userFile();
    await settingsRule(file).readable(file);
    let text: string | undefined;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const values = text === undefined ? {} : parseSettingsText(text, file);
    // a value that is no theme id names no theme, so it reads as unset
    const idOf = (value: unknown): string | null => (typeof value === 'string' && THEME_ID.test(value) ? value : null);
    return Object.fromEntries(LOOK_KINDS.map((kind) => [kind, idOf(values[PREFERRED_LOOK_SETTINGS[kind]])])) as Record<LookKind, string | null>;
  };
  const writeSettings = async (next: Partial<Record<LookKind, string | null>>): Promise<void> => {
    const file = userFile();
    await writeJsonConfig(file, (current) => {
      const values = current === undefined ? {} : parseSettingsText(current, file);
      for (const [kind, value] of Object.entries(next) as [LookKind, string | null | undefined][]) {
        if (value === undefined) continue;
        if (value === null) delete values[PREFERRED_LOOK_SETTINGS[kind]];
        else values[PREFERRED_LOOK_SETTINGS[kind]] = value;
      }
      return `${JSON.stringify(values, null, 2)}\n`;
    }, { baseFolder: path.dirname(file) });
  };
  // `key` as the user settings file holds it; undefined when it does not set it
  const readUserValue = async (key: string): Promise<unknown> => {
    const file = userFile();
    await settingsRule(file).readable(file);
    let text: string | undefined;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return text === undefined ? undefined : parseSettingsText(text, file)[key];
  };
  // null removes `key` from the user settings file
  const writeUserValue = async (key: string, value: unknown): Promise<void> => {
    const file = userFile();
    await writeJsonConfig(file, (current) => {
      const values = current === undefined ? {} : parseSettingsText(current, file);
      if (value === null) delete values[key];
      else values[key] = value;
      return `${JSON.stringify(values, null, 2)}\n`;
    }, { baseFolder: path.dirname(file) });
  };
  // damocles.desktop.theme as the user settings file holds it; null when it does not set it
  const readMode = async (): Promise<string | null> => {
    const value = await readUserValue(THEME_MODE_SETTING);
    return typeof value === 'string' ? value : null;
  };
  const writeMode = (value: string | null): Promise<void> => writeUserValue(THEME_MODE_SETTING, value);
  const readShowWallpapers = async (): Promise<boolean | null> => {
    const value = await readUserValue(SHOW_WALLPAPERS_SETTING);
    return typeof value === 'boolean' ? value : null;
  };
  const io: SnapshotIo = {
    readSettings,
    writeSettings,
    readMode,
    writeMode,
    readShowWallpapers,
    writeShowWallpapers: (value) => writeUserValue(SHOW_WALLPAPERS_SETTING, value),
    readAppearance: () => appearance.readText(),
    writeAppearance: (text) => appearance.writeText(text),
    readTheme: (id) => store.unlocked.readText(id),
    writeTheme: (id, text) => store.unlocked.writeText(id, text),
    readProjects: () => projects.readText(),
    writeProjects: (text) => projects.writeText(text),
  };
  const history = createThemeHistory({ root: options.root, io, writeText: writeFile, rule, ...(options.now ? { now: options.now } : {}), ...(options.log ? { log: options.log } : {}) });

  const drafts = createDraftStore(options.root, writeFile, store.newId, options.log, rule);
  const countdown = createCountdownLock(options.root, options.owner ?? randomUUID().replaceAll('-', ''), options.log);
  // Inside the lane: the countdown's mark. This app lets go of its countdown lock once no mark names it.
  const readMark = async (): Promise<PendingConfirm | undefined> => {
    const mark = await appearance.pendingConfirm();
    if (!mark?.owners.includes(countdown.owner)) await countdown.release();
    return mark;
  };
  const clearMark = async (): Promise<void> => {
    await appearance.setPendingConfirm(undefined);
    await countdown.release();
  };
  const settledListeners = new Set<(settled: PendingSettled) => void>();
  const tellSettled = (settled: PendingSettled | undefined): void => {
    if (settled) for (const listener of [...settledListeners]) listener(settled);
  };
  const extendedListeners = new Set<(extended: PendingExtended) => void>();
  const tellExtended = (extended: PendingExtended | undefined): void => {
    if (extended) for (const listener of [...extendedListeners]) listener(extended);
  };

  // Inside the lane: the countdown's mark, while its entry is still in the history (`entries`, when this lane run read it
  // already). A mark whose entry left is cleared, which settles its banner as kept.
  const standingMark = async (entries?: readonly StoredEntry[]): Promise<{ readonly mark?: PendingConfirm; readonly settled?: PendingSettled }> => {
    const mark = await readMark();
    if (!mark) return {};
    if ((entries ?? await history.entries()).some((entry) => entry.id === mark.entryId)) return { mark };
    await clearMark();
    return { settled: { entryId: mark.entryId, outcome: 'kept' } };
  };
  // One change inside the lane and its history entry; while a countdown runs it joins it ("Apply on the fly" in invariants.md).
  const changeLocked = async <T>(actor: ThemeActor, onTheFly: boolean, body: Body<T>): Promise<Changed<T>> => {
    // a change whose entry could not be written or read must not be made
    await rule.writable(historyFile);
    const entries = await history.editable();
    const { mark, settled } = await standingMark(entries);
    // The mark of a countdown this change starts is written before the change: a change that cannot be marked is never made,
    // and a crash at any later point leaves a mark the next start settles.
    const marked = !mark && onTheFly ? history.newId() : undefined;
    // A change made while a countdown stands is counted by this app too, whose banner it starts or restarts: the mark names
    // this app and its lock is held before the change, so no start elsewhere reverts what this app counts.
    const joined = mark !== undefined && !mark.owners.includes(countdown.owner);
    if (joined && mark.owners.length >= MAX_COUNTDOWN_OWNERS) throw new LocalizedError(l('Another Damocles is changing the themes. Try again in a moment.'));
    if (marked !== undefined || mark) {
      await countdown.hold();
      try {
        if (marked !== undefined) await appearance.setPendingConfirm({ entryId: marked, startedAt: now(), owners: [countdown.owner] });
        else if (joined) await appearance.setPendingConfirm({ ...mark, owners: [...mark.owners, countdown.owner] });
      } catch (err) {
        if (marked !== undefined || joined) await countdown.release();
        throw err;
      }
    }
    const taken: Snapshot[] = [];
    let made: Made<T>;
    let entryId: string;
    try {
      made = await body((before) => void taken.push(before));
      const newest = entries[0];
      // a revert is never merged into the entry it reverts, or Undo could not bring that change back
      const merge = mark && onTheFly && made.change.kind !== 'restore' && newest !== undefined && sameChat(newest.actor, actor) ? newest.id : undefined;
      if (merge !== undefined) {
        await history.extend(merge, made.change, made.before, entries);
        entryId = merge;
      } else {
        entryId = await history.record(actor, made.change, made.before, { from: entries, ...(marked !== undefined ? { id: marked } : {}) });
      }
    } catch (err) {
      // what the body wrote goes back and the mark goes; when that fails too, the change's own failure is the one reported
      try {
        if (taken.length > 0) await history.rollBack(taken);
        if (marked !== undefined) await appearance.setPendingConfirm(undefined);
        else if (joined) await appearance.setPendingConfirm(mark);
      } catch (undoErr) {
        options.log?.(`[themes] a theme change that failed could not be put back: ${undoErr instanceof Error ? undoErr.message : String(undoErr)}`);
      }
      // this app's banner counts nothing for a change that was not made
      if (marked !== undefined || joined) await countdown.release();
      if (taken.length > 0 || marked !== undefined) store.changed();
      throw err;
    }
    const pending = mark?.entryId ?? (onTheFly ? entryId : undefined);
    return {
      result: made.result,
      entryId,
      ...(pending !== undefined && onTheFly ? { pending } : {}),
      ...(settled ? { settled } : {}),
      ...(mark && !onTheFly ? { extended: { entryId: mark.entryId, change: made.change, actor } } : {}),
    };
  };

  // Reverts the countdown the mark names once no running app counts it. At a start this app counts none, so a mark that
  // names it is of its core that ended; later a mark that names it is one it counts, which its own banner ends.
  const settleGone = async (atStart: boolean): Promise<PendingAtStart | undefined> => {
    let wrote = false;
    try {
      return await store.lane.run(async () => {
        const pending = await appearance.pendingConfirm();
        if (!pending) return undefined;
        const { entryId, owners } = pending;
        const mine = owners.includes(countdown.owner);
        if (mine && !atStart) return undefined;
        for (const owner of owners) {
          if (owner === countdown.owner || (await countdown.gone(owner))) continue;
          // this app's banner counts on with the app that still runs, so its lock is held again
          if (mine) await countdown.hold();
          return { entryId, outcome: 'counted' as const };
        }
        wrote = true;
        try {
          const { arrangement } = await history.undoThrough(entryId);
          // the arrangement is of the window of an app that counted the change, so no other app's window takes it
          return { entryId, outcome: 'reverted' as const, ...(mine && arrangement !== undefined ? { arrangement } : {}) };
        } catch (err) {
          options.log?.(`[themes] the change the keep-changes banner had not settled could not be reverted, so it is kept: ${err instanceof Error ? err.message : String(err)}`);
          return { entryId, outcome: 'kept' as const };
        } finally {
          // the mark goes either way, so main stops holding the look from before a change that is still on disk
          await clearMark();
        }
      });
    } finally {
      if (wrote) store.changed();
    }
  };

  // Inside the lane: the origin a draft is saved with. A copy keeps where its texts came from, so an outside theme's description
  // stays outside text, and an arrangement the user did not opt into stays off.
  const draftOrigin = async (draft: ThemeDraft): Promise<{ readonly editing: boolean; readonly text: string | null; readonly created: Origin; readonly origin: Origin | undefined }> => {
    const editing = draft.baseThemeId !== null && draft.baseThemeId === draft.theme.id;
    const text = await store.unlocked.readText(draft.theme.id);
    const baseOrigin = draft.baseThemeId !== null && !editing ? originOf(draft.baseThemeId, await store.unlocked.readText(draft.baseThemeId)) : undefined;
    const created: Origin = draft.baseThemeId !== null ? { kind: 'duplicate', from: draft.baseThemeId, installedAt: now(), ...copiedLayoutOptIn(baseOrigin) } : { kind: 'created', installedAt: now() };
    return { editing, text, created, origin: editing ? originOf(draft.theme.id, text) : created };
  };

  // The listeners hear of a change once its lane run is done.
  const finished = <T>(done: Changed<T>): Changed<T> => {
    store.changed();
    tellSettled(done.settled);
    tellExtended(done.extended);
    return done;
  };

  const change = async <T>(actor: ThemeActor | undefined, body: Body<T>): Promise<T> =>
    finished(await store.lane.run(() => changeLocked(actor ?? USER_ACTOR, false, body))).result;
  // Inside the lane: a schedule runs while it is on and the mode is not System, which turns it off.
  const scheduleRuns = async (): Promise<boolean> => (await appearance.schedule()).schedule.enabled && modeOf(await readMode()) !== 'system';
  // Inside the lane: a pick while the schedule runs holds over it until the next rule start; appearance.json's text before it,
  // or undefined when no schedule runs.
  const holdOverSchedule = async (override: ScheduleOverride, taking: Taking): Promise<{ readonly appearance: string | null } | undefined> => {
    if (!(await scheduleRuns())) return undefined;
    const before = { appearance: await appearanceBefore() };
    taking(before);
    await appearance.setOverride(override);
    return before;
  };
  // Inside the lane: the schedule turned on or off and the mode set together, as one history change. A mode that changes while
  // the schedule stays as it was is written here and is no history change, as a mode change made anywhere else is none.
  const scheduleAndMode = async (next: { readonly enabled: boolean; readonly mode?: ThemeModeValue }): Promise<Body<undefined> | undefined> => {
    const { schedule } = await appearance.schedule();
    const modeChanges = next.mode !== undefined && next.mode !== modeOf(await readMode());
    if (next.enabled === schedule.enabled) {
      if (modeChanges) await writeMode(next.mode!);
      return undefined;
    }
    return async (taking) => {
      const before: Snapshot = { appearance: await appearanceBefore(), ...(modeChanges ? { mode: await readMode() } : {}) };
      taking(before);
      await appearance.setSchedule({ enabled: next.enabled, rules: schedule.rules });
      // a pick from before the schedule turned on or off would end at a rule start that has nothing to do with it
      await appearance.setOverride(undefined);
      if (modeChanges) await writeMode(next.mode!);
      return { result: undefined, change: { kind: 'schedule', enabled: next.enabled, rules: schedule.rules.length, ...(modeChanges ? { mode: next.mode! } : {}) }, before };
    };
  };
  // A user's change that may change nothing: `plan` reads what would change, and only a change it returns is made and recorded.
  // Whether one was recorded.
  const changeIf = async (actor: ThemeActor | undefined, plan: () => Promise<Body<undefined> | undefined>): Promise<boolean> => {
    const done = await store.lane.run(async (): Promise<Changed<undefined> | undefined> => {
      const apply = await plan();
      return apply ? changeLocked(actor ?? USER_ACTOR, false, apply) : undefined;
    });
    // a plan that only changed the mode wrote a setting main already follows
    if (done) finished(done);
    return done !== undefined;
  };
  const themeBefore = async (id: string): Promise<Snapshot> => {
    if (isUserThemeId(id)) await rule.writable(path.join(options.root, THEMES_FOLDER, id, THEME_FILE));
    return { themes: { [id]: await store.unlocked.readText(id) } };
  };
  const nameOf = async (id: string): Promise<string> => {
    if (id === BUILTIN_THEME_ID) return BUILTIN_THEME.name;
    const entry = (await store.list()).find((candidate) => candidate.id === id);
    return entry?.name || id;
  };
  // Inside the lane: the installed theme `id` with a look of `kind`, or the refusal the caller throws.
  const themeWithLook = async (id: string, kind: LookKind): Promise<Extract<ThemeListEntry, { status: 'ok' }>> => {
    const entry = (await store.list()).find((candidate) => candidate.id === id);
    if (entry?.status !== 'ok') throw new LocalizedError(l('The theme {0} is missing, broken or needs a newer Damocles.', entry?.name || id));
    if (entry.theme.looks[kind] === undefined) throw new LocalizedError(noLook(entry.name, kind));
    return entry;
  };
  // The chat's newest entry, refused when a later entry touched any item it touched.
  const agentUndoTarget = async (chatId: string): Promise<AgentUndoTarget> => {
    const entries = await history.entries();
    const index = entries.findIndex((entry) => entry.actor.kind === 'agent' && entry.actor.chatId === chatId);
    const entry = entries[index];
    if (!entry || entry.cannotUndo) return { kind: 'none' };
    const items = new Set(touchedItems(entry.before));
    // a later entry this Damocles cannot read the snapshot of may have touched anything
    const later = entries.slice(0, index).find((other) => other.cannotUndo || touchedItems(other.before).some((item) => items.has(item)));
    const own = { id: entry.id, at: entry.at, actor: entry.actor, change: entry.change };
    return later ? { kind: 'refused', entry: own, later: { change: later.change, actor: later.actor, at: later.at } } : { kind: 'ok', entry: own };
  };
  // An undo or a restore inside the lane. The listeners hear of one that failed too, whose files moved and went back.
  const historyRun = async <T>(body: () => Promise<T>): Promise<T> => {
    try {
      return await store.lane.run(body);
    } finally {
      store.changed();
    }
  };
  // Every text that may name a blob: each theme file, each draft, the history, whose snapshots hold theme files of their own, and
  // projects.json, whose every-theme pins keep their sprites after their theme is deleted.
  const blobReferences = async (): Promise<string[]> => {
    const themesDir = path.join(options.root, THEMES_FOLDER);
    // Only a file that is not there names nothing. A text that is refused, cannot be read or is past its writer's cap stops
    // the collection, since reading it as empty would remove the blobs it names.
    const read = async (file: string, cap: number): Promise<string> => {
      await rule.readable(file);
      try {
        return await readCapped(file, cap);
      } catch (err) {
        if (isAbsent(err)) return '';
        throw err;
      }
    };
    await rule.readable(themesDir);
    const ids = await namesIn(themesDir);
    const draftTexts = (await drafts.list()).map((draft) => JSON.stringify(draft.theme));
    const themeTexts = await eachLimited(ids, READ_CONCURRENCY, (id) => read(path.join(themesDir, id, THEME_FILE), MAX_THEME_FILE_BYTES));
    const historyText = await read(historyFile, MAX_HISTORY_BYTES);
    const projectsText = await read(path.join(options.root, PROJECTS_FILE), MAX_STATE_FILE_BYTES);
    return [...themeTexts, historyText, projectsText, ...draftTexts, ...installs.references()];
  };
  const wallpaperCache = createWallpaperCache(options.root, writeFile, rule);
  let analyzer: WallpaperAnalyzer | undefined;
  // The wallpapers every theme names, the built-in examples' included, with the asset entry that describes each.
  const namedWallpapers = async (): Promise<Map<string, AssetMeta>> => {
    const named = new Map<string, AssetMeta>();
    for (const entry of await store.list()) {
      if (entry.status !== 'ok') continue;
      for (const [sha, asset] of Object.entries(entry.theme.assets ?? {})) if (isWallpaperAsset(asset)) named.set(sha, asset);
    }
    return named;
  };
  const builtinAssets = async (): Promise<Set<string>> => new Set((await store.list()).flatMap((entry) => (entry.status === 'ok' && entry.builtin ? Object.keys(entry.theme.assets ?? {}) : [])));
  const blobFile = (sha256: string): string => {
    if (!SHA256.test(sha256)) throw new Error(`${sha256} is not a sha256`);
    return path.join(options.root, BLOBS_FOLDER, sha256);
  };
  const blobStored = async (sha256: string): Promise<boolean> => (await rule.readable(blobFile(sha256)).then(() => fs.stat(blobFile(sha256))).catch(() => undefined))?.isFile() === true;
  const analyze = async (sha256: string, asset: Pick<AssetMeta, 'kind' | 'mime' | 'width' | 'height' | 'durationMs'>, signal?: AbortSignal): Promise<WallpaperAnalysis & { readonly width: number; readonly height: number }> => {
    if (!analyzer) throw new LocalizedError(l('Wallpapers cannot be read while the Damocles window is closed.'));
    if (asset.width === undefined || asset.height === undefined) throw new LocalizedError(l('The wallpaper names no size.'));
    const kind = asset.kind as WallpaperKind;
    const analysis = await untilAborted(analyzer(sha256, { kind, mime: asset.mime, width: asset.width, height: asset.height, ...(asset.durationMs !== undefined ? { durationMs: asset.durationMs } : {}) }, signal), signal);
    if (isMoving(kind) && (!analysis.still || !analysis.flash)) throw new LocalizedError(l('The moving wallpaper was not checked for flashing.'));
    await store.lane.run(() => wallpaperCache.write(sha256, analysis));
    return analysis;
  };
  let spriteAnalyzer: SpriteAnalyzer | undefined;
  const analyzeSprite = async (sha256: string, asset: AssetMeta, signal?: AbortSignal): Promise<SpriteAnalysis> => {
    if (!spriteAnalyzer) throw new LocalizedError(l('Character sprites cannot be read while the Damocles window is closed.'));
    if (asset.width === undefined || asset.height === undefined) throw new LocalizedError(l('The sprite names no size.'));
    const strip = spriteStrip(asset);
    const analysis = await untilAborted(spriteAnalyzer(sha256, { mime: asset.mime, width: asset.width, height: asset.height, ...(strip ? { strip } : {}), animated: spriteIsAnimated(asset) }, signal), signal);
    await store.lane.run(() => wallpaperCache.writeSprite(sha256, analysis));
    return analysis;
  };
  // The sprites every theme's characters name, the built-in examples' included, with the asset entry that describes each.
  const namedSprites = async (): Promise<Map<string, AssetMeta>> => {
    const named = new Map<string, AssetMeta>();
    for (const entry of await store.list()) {
      if (entry.status !== 'ok') continue;
      for (const sha of characterAssets(entry.theme)) {
        const asset = entry.theme.assets?.[sha];
        if (asset?.kind === 'sprite') named.set(sha, asset);
      }
    }
    return named;
  };
  const collectBlobs = async (): Promise<number> => store.lane.run(async () => {
    const references = await blobReferences();
    const removed = await blobs.collect(references, now());
    // a blob the grace period kept has its derived files kept too; a blobs folder that cannot be listed stops the collection,
    // since listing it as empty would remove every derived file
    const kept = await namesIn(path.join(options.root, BLOBS_FOLDER));
    const live = new Set([...kept, ...await builtinAssets()]);
    await wallpaperCache.collect(live);
    await removeOrphanedTemps(options.root, now() - BLOB_GRACE_MS, rule);
    return removed;
  });
  // A saved theme's wallpapers and sprites must be stored blobs or a built-in example's own, or main would have nothing to draw.
  const missingImage = async (theme: unknown, id: string, which: (asset: AssetMeta) => boolean): Promise<boolean> => {
    const result = validateTheme(theme, { folder: id });
    if (!result.ok) return false;
    const packed = await builtinAssets();
    for (const [sha, asset] of Object.entries(result.theme.assets ?? {})) {
      if (which(asset) && !packed.has(sha) && !(await blobStored(sha))) return true;
    }
    return false;
  };
  // A saved theme's bundled fonts must be stored blobs, or main would have nothing to serve.
  const missingFont = async (theme: unknown, id: string): Promise<string | undefined> => {
    const result = validateTheme(theme, { folder: id });
    if (!result.ok) return undefined;
    for (const font of bundledFonts(result.theme)) if (!(await blobStored(font.sha256))) return font.family;
    return undefined;
  };

  // Inside the lane: removes the blobs of `staged` that nothing names and nothing stored again since they were staged.
  const dropUnnamedBlobs = async (staged: ReadonlyMap<string, number>): Promise<void> => {
    const named = (await blobReferences()).join('\n');
    for (const [sha256, stagedAt] of staged) {
      if (named.includes(sha256)) continue;
      // Stored again since (BlobStore.put moves the write time on): an import holds it for a theme no file names yet, so
      // it stays for the collection's grace period.
      const stat = await fs.stat(blobFile(sha256)).catch(() => undefined);
      if (stat !== undefined && stat.mtimeMs !== stagedAt) continue;
      await rule.writable(blobFile(sha256));
      await rule.writable(path.join(options.root, CACHE_FOLDER, sha256));
      await fs.rm(blobFile(sha256), { force: true });
      await fs.rm(path.join(options.root, CACHE_FOLDER, sha256), { recursive: true, force: true });
    }
  };

  const installs = createThemeInstalls({
    list: () => store.list(),
    // all or nothing: a store that fails part-way takes back the blobs it added, so none is left that nothing names
    putBlobs: (assets) => store.lane.run(async () => {
      const added = new Map<string, number>();
      try {
        for (const [sha256, bytes] of assets) {
          const stored = await blobStored(sha256);
          await blobs.put(bytes);
          if (!stored) added.set(sha256, (await fs.stat(blobFile(sha256))).mtimeMs);
        }
      } catch (err) {
        await dropUnnamedBlobs(added).catch((dropErr: unknown) => options.log?.(`[themes] the blobs of a failed install were not removed: ${dropErr instanceof Error ? dropErr.message : String(dropErr)}`));
        throw err;
      }
      return added;
    }),
    dropBlobs: async (staged) => {
      if (staged.size > 0) await store.lane.run(() => dropUnnamedBlobs(staged));
    },
    analyzeWallpaper: async (sha256, asset, signal) => {
      const { thumb, flash, width, height } = await analyze(sha256, asset, signal);
      // a new analysis keeps the allowance this computer's user gave the file before
      const allowed = flash?.flagged === true && (await wallpaperCache.flash(sha256))?.allowed === true;
      return { thumb, width, height, ...(flash ? { flash: { flagged: flash.flagged, ...(flash.atMs !== undefined ? { atMs: flash.atMs } : {}), ...(allowed ? { allowed } : {}) } } : {}) };
    },
    analyzeSprite: async (sha256, asset, signal) => {
      const { flash } = await analyzeSprite(sha256, asset, signal);
      return { flash: { flagged: flash.flagged, ...(flash.atMs !== undefined ? { atMs: flash.atMs } : {}) } };
    },
    newId: () => store.newId(),
    now,
    ...(options.e2eThemeDownloads !== undefined ? { e2eFolder: options.e2eThemeDownloads } : {}),
    ...(options.log ? { log: options.log } : {}),
  });

  const allowFlash = async (sha256: string): Promise<boolean> => {
    const allowed = await store.lane.run(() => wallpaperCache.allowFlash(sha256));
    if (!allowed) return false;
    installs.flashAllowed(sha256);
    store.changed();
    return true;
  };

  // The theme an export reads, with its assets from blobs or packed with a built-in example.
  const exportSource = async (themeId: string): Promise<ExportSource> => {
    const entries = await store.list();
    const entry = entries.find((candidate) => candidate.id === themeId);
    if (entry?.status !== 'ok') throw new LocalizedError(l('The theme {0} is missing, broken or needs a newer Damocles.', entry?.name ?? themeId));
    const packedBy = (sha256: string): string | undefined =>
      entries.find((candidate) => candidate.status === 'ok' && candidate.builtin && candidate.id !== BUILTIN_THEME_ID && candidate.theme.assets?.[sha256] !== undefined)?.id;
    const readAsset = async (sha256: string, asset: AssetMeta): Promise<Uint8Array> => {
      const example = packedBy(sha256);
      if (example !== undefined && resourceRoot !== undefined) {
        const packed = await readBuiltinAsset(resourceRoot, example, sha256, asset.mime);
        if (packed) return packed;
      }
      await rule.readable(blobFile(sha256));
      try {
        return await fs.readFile(blobFile(sha256));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new LocalizedError(l('The theme {0} was not exported: a file it names is missing.', entry.name), { cause: err });
        throw err;
      }
    };
    const licenseText = entry.builtin && entry.id !== BUILTIN_THEME_ID && resourceRoot !== undefined ? await readBuiltinLicense(resourceRoot, entry.id) : undefined;
    return { theme: entry.theme, builtin: entry.builtin, readAsset, ...(licenseText !== undefined ? { licenseText } : {}) };
  };

  // Inside the lane: the staged theme under its id, as one history entry; Replace keeps an edited theme as a copy first.
  // copy.origin: the copy's own origin; absent, it keeps the replaced theme's
  const commitInstall = async (theme: ThemeFile, origin: Origin, target: { readonly id: string; readonly replace: boolean; readonly copy?: { readonly id: string; readonly name: string; readonly origin?: Origin } }, taking: Taking): Promise<Made<undefined>> => {
    const before: Snapshot = { themes: { [target.id]: await store.unlocked.readText(target.id), ...(target.copy ? { [target.copy.id]: null } : {}) } };
    const installed: ThemeFile = { ...theme, id: target.id };
    const valid = validateTheme({ ...installed, origin }, { folder: target.id });
    if (!valid.ok) throw new LocalizedError(l('The theme was not installed: {0}', themeErrorText(valid.errors)));
    taking(before);
    if (target.copy) {
      const old = parseStoredJson(before.themes![target.id]!) as Record<string, unknown>;
      // a kept origin keeps its texts outside text and its edits marked as edits; a store Update's copy is a duplicate of the
      // updated theme, which keeps them outside text as well and is no store theme of that entry
      await store.unlocked.writeText(target.copy.id, `${JSON.stringify({ ...old, id: target.copy.id, name: target.copy.name, ...(target.copy.origin ? { origin: target.copy.origin } : {}) }, null, 2)}\n`);
    }
    // Replace writes over the theme in place, never deleting it first, so a write that fails leaves the replaced theme as it was
    if (target.replace) await store.unlocked.replace(installed, origin);
    else await store.unlocked.create(installed, origin);
    return { result: undefined, change: target.replace ? { kind: 'save', theme: theme.name } : { kind: 'create', theme: theme.name }, before };
  };

  return {
    list: () => store.list(),
    history: async () => (await history.entries()).map(({ id, at, actor, change: what, cannotUndo }) => ({ id, at, actor, change: what, ...(cannotUndo ? { cannotUndo } : {}) })),
    saveTheme: (id, theme, actor, pins, baseHash) => change(actor, async (taking): Promise<{ result: ThemeSaved; change: ThemeHistoryChange; before: Snapshot }> => {
      // before any other check, so a theme that moved is told as moved and nothing of it is read as the caller's
      if (baseHash !== undefined && hashText(await store.unlocked.readText(id)) !== baseHash) throw new BaseMoved();
      const missing = await missingFont(theme, id);
      if (missing !== undefined) throw new LocalizedError(l('The theme was not saved: the font file of {0} is missing. Add the font again.', missing));
      if (await missingImage(theme, id, isWallpaperAsset)) throw new LocalizedError(l('The theme was not saved: a wallpaper image it names is missing. Choose the image again.'));
      if (await missingImage(theme, id, (asset) => asset.kind === 'sprite')) throw new LocalizedError(l('The theme was not saved: a character image it names is missing. Choose the image again.'));
      const edits = pins ?? [];
      const before: Snapshot = { ...await themeBefore(id), ...(edits.length > 0 ? { projects: await projectsBefore() } : {}) };
      // before the theme is written, so a projects.json this Damocles may not change refuses the whole save
      const pinned = edits.length > 0 ? await projects.editable() : undefined;
      taking(before);
      await store.unlocked.saveTheme(id, theme);
      const saved = validateTheme(theme, { folder: id });
      if (edits.length > 0 && saved.ok) await projects.writeText(`${JSON.stringify(applyPinEdits(pinned, saved.theme, edits), null, 2)}\n`);
      const name = isRecord(theme) && typeof theme['name'] === 'string' ? theme['name'] : id;
      return { result: { hash: hashText(await store.unlocked.readText(id))! }, change: { kind: 'save', theme: name }, before };
    }).catch((err: unknown): ThemeSaved => {
      if (err instanceof BaseMoved) return { changed: true };
      throw err;
    }),
    duplicate: (id, name, actor) => change(actor, async (taking) => {
      const copyId = store.newId();
      const before: Snapshot = { themes: { [copyId]: null } };
      taking(before);
      await store.unlocked.duplicate(id, name, copyId);
      return { result: copyId, change: { kind: 'create', theme: name }, before };
    }),
    rename: (id, name, actor) => change(actor, async (taking) => {
      const before = await themeBefore(id);
      taking(before);
      const was = await store.unlocked.rename(id, name);
      return { result: undefined, change: { kind: 'rename', theme: name, was }, before };
    }),
    remove: async (id, actor) => {
      await change(actor, async (taking) => {
        const before = await themeBefore(id);
        taking(before);
        const name = await store.unlocked.remove(id);
        return { result: undefined, change: { kind: 'delete', theme: name }, before };
      });
      await collectBlobs().catch((err: unknown) => options.log?.(`[themes] the unused blobs could not be removed: ${err instanceof Error ? err.message : String(err)}`));
    },
    pick: (id, kind, pickOptions) => changeIf(pickOptions?.actor, async () => {
      // inside the lane, so a delete or a save queued ahead of this pick has already happened
      const entry = await themeWithLook(id, kind);
      const settingsBefore = await readSettings();
      // the look already preferred: nothing to record, unless a running schedule would be held over from now
      if ((settingsBefore[kind] || BUILTIN_THEME_ID) === id && !(await scheduleRuns())) return undefined;
      return async (taking) => {
        const was = await nameOf(settingsBefore[kind] || BUILTIN_THEME_ID);
        const picked: Snapshot = { settings: { [kind]: settingsBefore[kind] } };
        taking(picked);
        await settings.update(PREFERRED_LOOK_SETTINGS[kind], id, 'user');
        const held = await holdOverSchedule({ themeId: id, kind, at: pickOptions?.at ?? now() }, taking);
        const before: Snapshot = { ...picked, ...held, ...(pickOptions?.arrangementBefore !== undefined ? { arrangement: pickOptions.arrangementBefore } : {}) };
        return { result: undefined, change: { kind: 'pick', look: kind, theme: entry.name, was }, before };
      };
    }),
    setMode: async (mode, actor) => void await changeIf(actor, async () => {
      if (mode === 'system' && (await appearance.schedule()).schedule.enabled) return scheduleAndMode({ enabled: false, mode });
      // a mode change alone is not a theme change the history keeps
      if (modeOf(await readMode()) !== mode) await writeMode(mode);
      return undefined;
    }),
    setScheduleMode: async (choice, showing, actor) => void await changeIf(actor, async () => {
      if (choice === 'system') return scheduleAndMode({ enabled: false, mode: 'system' });
      const mode = modeOf(await readMode());
      return scheduleAndMode({ enabled: choice === 'schedule', mode: mode === 'system' ? showing : mode });
    }),
    schedule: () => appearance.schedule(),
    resumeSchedule: async (actor) => void await changeIf(actor, async () => {
      if ((await appearance.schedule()).override === undefined) return undefined;
      return async (taking) => {
        const before: Snapshot = { appearance: await appearanceBefore() };
        taking(before);
        await appearance.setOverride(undefined);
        return { result: undefined, change: { kind: 'resume' }, before };
      };
    }),
    async hold(themeId, kind, at, actor) {
      await changeIf(actor, async () => {
        // inside the lane, as a pick's check is
        const entry = await themeWithLook(themeId, kind);
        if (!(await scheduleRuns())) return undefined;
        return async (taking) => {
          const held = await holdOverSchedule({ themeId, kind, at }, taking);
          return { result: undefined, change: { kind: 'hold', theme: entry.name, look: kind }, before: held ?? {} };
        };
      });
    },
    reset: (actor, projectKey) => change(actor, async (taking) => {
      const projectsText = projectKey === undefined ? null : await projectsBefore();
      const lookOff = projectKey !== undefined && (await projectLooks.projectLookOf(projectKey)) !== undefined;
      const before: Snapshot = { settings: await readSettings(), appearance: await appearanceBefore(), ...(lookOff ? { projects: projectsText } : {}) };
      taking(before);
      await writeSettings(Object.fromEntries(LOOK_KINDS.map((kind) => [kind, BUILTIN_THEME_ID])));
      await appearance.reset();
      if (lookOff) await projects.writeText(`${JSON.stringify(projectLooks.withLook(parseJson(projectsText), projectKey, null), null, 2)}\n`);
      return { result: undefined, change: { kind: 'reset' }, before };
    }),
    projectLooks,
    async setProjectLook(projectKey, given, lookOptions) {
      // the look as every reader checks it, so it is compared and stored in one form whatever the caller's key order or case
      const look = given === null ? null : checkProjectLook(given);
      if (look === undefined) throw new LocalizedError(l('This project look is not valid, so it was not saved.'));
      const done = await store.lane.run(async (): Promise<Changed<ThemeHistoryChange> | undefined> => {
        const text = await projectsBefore();
        const raw = await projects.editable();
        const was = await projectLooks.projectLookOf(projectKey);
        if (isDeepStrictEqual(was ?? null, look)) return undefined;
        return changeLocked(lookOptions.actor ?? USER_ACTOR, lookOptions.onTheFly === true, async (taking) => {
          const before: Snapshot = { projects: text };
          taking(before);
          await projects.writeText(`${JSON.stringify(projectLooks.withLook(raw, projectKey, look), null, 2)}\n`);
          const made: ThemeHistoryChange = { kind: 'projectLook', project: lookOptions.name, look: look === null ? 'none' : look.mode };
          return { result: made, change: made, before };
        });
      });
      if (!done) return undefined;
      finished(done);
      return { entryId: done.entryId, ...(done.pending !== undefined ? { pending: done.pending } : {}), change: done.result };
    },
    async wallpapersOff(actor, onTheFly) {
      const done = await store.lane.run(async (): Promise<Changed<ThemeHistoryChange> | undefined> => {
        if (settings.get<unknown>(SHOW_WALLPAPERS_SETTING, true) === false) return undefined;
        return changeLocked(actor, onTheFly, async (taking) => {
          const before: Snapshot = { showWallpapers: await readShowWallpapers() };
          taking(before);
          await writeUserValue(SHOW_WALLPAPERS_SETTING, false);
          const made: ThemeHistoryChange = { kind: 'wallpapersOff' };
          return { result: made, change: made, before };
        });
      });
      if (!done) return undefined;
      finished(done);
      return { entryId: done.entryId, ...(done.pending !== undefined ? { pending: done.pending } : {}), change: done.result };
    },
    async undo(pendingEntryId, expected) {
      let settled: PendingSettled | undefined;
      let extended: PendingExtended | undefined;
      const result = await historyRun(async (): Promise<{ readonly undone?: ThemeHistoryChange; readonly arrangement?: unknown }> => {
        // a history this Damocles may not write is refused before the mark is read, which it would clear
        const { mark, settled: stale } = await standingMark(await history.editable());
        settled = stale;
        if (pendingEntryId !== undefined) {
          // the banner's revert ends only its own countdown: every change it covers, back to the state before the first
          if (mark?.entryId !== pendingEntryId) return {};
          const { undone, arrangement } = await history.undoThrough(pendingEntryId, clearMark);
          const first = undone.at(-1);
          return { ...(first ? { undone: first.change } : {}), ...(arrangement !== undefined ? { arrangement } : {}) };
        }
        const undone = await history.undo(expected, async (newest) => {
          if (mark && newest.id === mark.entryId) await clearMark();
        });
        if (!undone) return {};
        if (mark && undone.id === mark.entryId) {
          settled = { entryId: mark.entryId, outcome: 'reverted' };
        } else if (mark) {
          extended = { entryId: mark.entryId, change: { kind: 'restore', before: restoredChange(undone.change) }, actor: USER_ACTOR };
        }
        return { undone: undone.change, ...(undone.before.arrangement !== undefined ? { arrangement: undone.before.arrangement } : {}) };
      });
      tellSettled(settled);
      tellExtended(extended);
      return result;
    },
    async restore(entryId, arrangementNow, actor) {
      let settled: PendingSettled | undefined;
      let extended: PendingExtended | undefined;
      const result = await historyRun(async () => {
        const standing = await standingMark(await history.editable());
        settled = standing.settled;
        const restored = await history.restore(entryId, actor ?? USER_ACTOR, arrangementNow);
        const newest = (await history.entries())[0];
        if (standing.mark && newest) extended = { entryId: standing.mark.entryId, change: newest.change, actor: newest.actor };
        return restored;
      });
      tellSettled(settled);
      tellExtended(extended);
      return result;
    },
    editBase: (id) => store.lane.run(async () => {
      const text = await store.unlocked.readText(id);
      const json = parseJson(text);
      if (text === null || json === undefined) return undefined;
      const valid = validateTheme(json, { folder: id });
      return valid.ok ? { theme: valid.theme, hash: hashText(text)! } : undefined;
    }),
    appearance: () => appearance.read(),
    drafts: {
      get: (id) => drafts.get(id),
      put: (draft) => store.lane.run(() => drafts.put(draft)),
      remove: (id) => store.lane.run(() => drafts.remove(id)),
      removeOwnedBy: (owner) => store.lane.run(() => drafts.removeOwnedBy(owner)),
      removeRelayedBefore: (localAuthority, before, keep) => store.lane.run(() => drafts.removeRelayedBefore(localAuthority, before, keep)),
      removeOfAuthority: (authority) => store.lane.run(() => drafts.removeOfAuthority(authority)),
      authorities: () => drafts.authorities(),
      newId: () => drafts.newId(),
    },
    sweepDrafts: () => store.lane.run(() => drafts.sweep()),
    async applyDraft(apply) {
      const { draft, actor, onTheFly } = apply;
      const done = await store.lane.run(async (): Promise<Changed<AppliedDraft> | undefined> => {
        const { editing, text, created, origin } = await draftOrigin(draft);
        if (editing && hashText(text) !== draft.baseHash) return undefined;
        // the window arrangement applies on the agent's pick exactly as on a manual one
        const saved: ThemeFile = { ...draft.theme, ...(origin ? { origin } : {}) };
        const layout = apply.pick.length > 0 && arrangementApplies(saved) ? saved.layout : undefined;
        const arrangementBefore = layout ? await apply.currentArrangement() : undefined;
        const changed = await changeLocked(actor, onTheFly, async (taking) => {
          const settingsBefore = apply.pick.length > 0 ? await readSettings() : undefined;
          const previousName = apply.pick.length === 1 ? await nameOf(settingsBefore?.[apply.pick[0]!] || BUILTIN_THEME_ID) : undefined;
          const themeBefore: Snapshot = { themes: { [draft.theme.id]: text }, ...(settingsBefore ? { settings: Object.fromEntries(apply.pick.map((kind) => [kind, settingsBefore[kind]])) } : {}) };
          taking(themeBefore);
          if (editing) await store.unlocked.saveTheme(draft.theme.id, draft.theme);
          else await store.unlocked.create(draft.theme, created);
          if (apply.pick.length > 0) await writeSettings(Object.fromEntries(apply.pick.map((kind) => [kind, draft.theme.id])));
          const heldKind = apply.pick.length === 1 ? apply.pick[0] : apply.showing !== undefined && apply.pick.includes(apply.showing) ? apply.showing : apply.pick[0];
          const held = heldKind !== undefined ? await holdOverSchedule({ themeId: draft.theme.id, kind: heldKind, at: now() }, taking) : undefined;
          const before: Snapshot = { ...themeBefore, ...held, ...(arrangementBefore !== undefined ? { arrangement: arrangementBefore } : {}) };
          const picked = apply.pick.length > 0 ? { picked: [...apply.pick] } : {};
          const change: ThemeHistoryChange = editing ? { kind: 'save', theme: draft.theme.name, ...picked } : { kind: 'create', theme: draft.theme.name, ...picked };
          return {
            result: {
              themeId: draft.theme.id, name: draft.theme.name, change, ...(previousName !== undefined ? { previousName } : {}),
              ...(layout ? { arrangement: { layout, density: draft.theme.style?.density ?? 1 } } : {}),
            },
            change,
            before,
          };
        });
        // Only once the change is recorded, so an apply that failed can be made again from its draft. The change stands
        // whether or not the file goes: a draft left behind is swept at the next core start.
        await drafts.remove(draft.id).catch((err: unknown) => options.log?.(`[themes] the applied draft ${draft.id} was not removed: ${err instanceof Error ? err.message : String(err)}`));
        return changed;
      });
      if (!done) return { kind: 'outdated' };
      finished(done);
      return { kind: 'applied', entryId: done.entryId, ...(done.pending !== undefined ? { pending: done.pending } : {}), ...done.result };
    },
    draftArrangementApplies: (draft) => store.lane.run(async () => {
      const { origin } = await draftOrigin(draft);
      return arrangementApplies({ ...draft.theme, ...(origin ? { origin } : {}) });
    }),
    async setSchedule(schedule, actor, onTheFly, showing) {
      const done = await store.lane.run(async (): Promise<Changed<undefined> | undefined> => {
        const modeText = await readMode();
        const toFixed = schedule.enabled && showing !== undefined && modeOf(modeText) === 'system' ? showing : undefined;
        const was = (await appearance.schedule()).schedule;
        if (toFixed === undefined && sameSchedule(was, schedule)) return undefined;
        return changeLocked(actor, onTheFly, async (taking) => {
          const before: Snapshot = { appearance: await appearanceBefore(), ...(toFixed !== undefined ? { mode: modeText } : {}) };
          taking(before);
          await appearance.setSchedule(schedule);
          if (was.enabled !== schedule.enabled) await appearance.setOverride(undefined);
          if (toFixed !== undefined) await writeMode(toFixed);
          return { result: undefined, change: { kind: 'schedule', enabled: schedule.enabled, rules: schedule.rules.length, ...(toFixed !== undefined ? { mode: toFixed } : {}) }, before };
        });
      });
      if (!done) return undefined;
      finished(done);
      return { entryId: done.entryId, ...(done.pending !== undefined ? { pending: done.pending } : {}) };
    },
    setScheduleRules: async (rules, actor) => void await changeIf(actor, async () => {
      const was = (await appearance.schedule()).schedule;
      const next: ThemeSchedule = { enabled: was.enabled, rules };
      if (sameSchedule(was, next)) return undefined;
      return async (taking) => {
        const before: Snapshot = { appearance: await appearanceBefore() };
        taking(before);
        await appearance.setSchedule(next);
        return { result: undefined, change: { kind: 'schedule', enabled: next.enabled, rules: rules.length }, before };
      };
    }),
    agentUndoTarget: (chatId) => agentUndoTarget(chatId),
    async agentUndo(entryId, actor, onTheFly, currentArrangement) {
      let target: AgentUndoTarget | undefined;
      const done = await store.lane.run(async (): Promise<Changed<{ readonly undone: ThemeHistoryChange; readonly arrangement?: unknown }> | undefined> => {
        target = await agentUndoTarget(actor.chatId);
        if (target.kind !== 'ok' || target.entry.id !== entryId) return undefined;
        const entry = (await history.entries()).find((candidate) => candidate.id === entryId);
        const arrangement = entry?.before.arrangement;
        const arrangementNow = arrangement !== undefined ? await currentArrangement() : undefined;
        return changeLocked(actor, onTheFly, async (taking) => {
          const reverted = await history.revert(entryId, arrangementNow, taking);
          return { result: { undone: reverted.reverted.change, ...(arrangement !== undefined ? { arrangement } : {}) }, change: reverted.change, before: reverted.before };
        });
      });
      if (!done) return target?.kind === 'refused' ? { kind: 'refused', later: target.later } : { kind: 'gone' };
      finished(done);
      const { undone, arrangement } = done.result;
      return {
        kind: 'undone', entryId: done.entryId, ...(done.pending !== undefined ? { pending: done.pending } : {}),
        undone, change: { kind: 'restore', before: restoredChange(undone) }, ...(arrangement !== undefined ? { arrangement } : {}),
      };
    },
    async keep(entryId) {
      await store.lane.run(async () => {
        if ((await readMark())?.entryId === entryId) await clearMark();
      });
    },
    pendingConfirm: () => appearance.pendingConfirm(),
    settlePendingAtStart: () => settleGone(true),
    settlePendingLeft: () => settleGone(false),
    onPendingSettled(listener) {
      settledListeners.add(listener);
      return { dispose: () => settledListeners.delete(listener) };
    },
    onPendingExtended(listener) {
      extendedListeners.add(listener);
      return { dispose: () => extendedListeners.delete(listener) };
    },
    async importFont(bytes) {
      let info;
      try {
        info = await readFontInfo(bytes);
      } catch (err) {
        if (err instanceof FontInfoError) throw new LocalizedError(fontRefusal(err));
        throw err;
      }
      const family = fontNameOf(info.names.family) ?? fontNameOf(info.names.fullName) ?? fontNameOf(info.names.postscriptName);
      if (family === undefined) throw new LocalizedError(l('This font names no family Damocles can use.'));
      if (info.embedding === 'restricted') throw new LocalizedError(l('{0} forbids embedding, so a theme cannot bundle it. Pick it as an installed font instead.', family));
      const sha256 = await store.lane.run(() => blobs.put(bytes));
      const licenseText = info.names.license?.slice(0, 20_000);
      const spdx = shareableLicense(info.names);
      const license = {
        ...(spdx !== undefined ? { spdx } : {}),
        ...(licenseText !== undefined ? { text: licenseText } : {}),
        ...(info.names.licenseUrl !== undefined ? { source: info.names.licenseUrl.slice(0, 2048) } : {}),
      };
      return { sha256, family, embedding: info.embedding, asset: { kind: 'font', mime: info.mime, bytes: bytes.length, family, license } };
    },
    async importImage(source, signal) {
      const bytes = 'file' in source ? await readWallpaperFile(source.file) : source.bytes;
      const header = checkWallpaper(bytes, 'file' in source ? source.file : source.name);
      const sha256 = await store.lane.run(() => blobs.put(bytes));
      const { stats, palette, width, height, flash } = await analyze(sha256, wallpaperAsset(bytes, header), signal);
      // a JPEG its EXIF orientation turns is laid out at its decoded size
      const asset = { ...wallpaperAsset(bytes, { ...header, width, height }), ...(flash ? { flash: { flagged: flash.flagged, ...(flash.atMs !== undefined ? { atMs: flash.atMs } : {}) } } : {}) };
      const record = flash ? await wallpaperCache.flash(sha256) : undefined;
      return { sha256, asset, stats, palette, ...(record ? { flash: record } : {}) };
    },
    async importSprite(source, strip, signal) {
      const bytes = 'file' in source ? await readWallpaperFile(source.file) : source.bytes;
      const sprite = checkSprite(bytes, 'file' in source ? source.file : source.name, strip);
      const sha256 = await store.lane.run(() => blobs.put(bytes));
      const stored = spriteAsset(bytes, sprite);
      const { flash } = await analyzeSprite(sha256, stored, signal);
      const cut = spriteStrip(stored);
      const moves = cut !== undefined || (stored.frames ?? 1) > 1;
      const asset: AssetMeta = moves ? { ...stored, flash: { flagged: flash.flagged, ...(flash.atMs !== undefined ? { atMs: flash.atMs } : {}) } } : stored;
      const record = moves ? await wallpaperCache.flash(sha256) : undefined;
      return { sha256, asset, ...(cut ? { strip: cut } : {}), ...(record ? { flash: record } : {}) };
    },
    setSpriteAnalyzer(next) {
      spriteAnalyzer = next;
    },
    wallpaperStats: (sha256) => wallpaperCache.stats(sha256),
    wallpaperPalette: (sha256) => wallpaperCache.palette(sha256),
    wallpaperFlash: (sha256) => wallpaperCache.flash(sha256),
    allowFlash,
    async installAllowFlash(installId, sha256) {
      return installs.flagged(installId, sha256) && allowFlash(sha256);
    },
    analyzeProgress: (sha256, fraction) => installs.progress(sha256, fraction),
    onInstallProgress: (listener) => installs.onProgress(listener),
    async analyzeMissing() {
      let analyzed = 0;
      let failed = 0;
      for (const [sha256, asset] of await namedWallpapers()) {
        if (!analyzer) break;
        if (await wallpaperCache.has(sha256, isMoving(asset.kind))) continue;
        try {
          await analyze(sha256, asset);
          analyzed++;
        } catch (err) {
          failed++;
          options.log?.(`[themes] the wallpaper ${sha256} was not analyzed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // the window hears of the wallpapers before the sprites' checks run
      if (analyzed > 0) store.changed();
      let sprites = 0;
      for (const [sha256, asset] of await namedSprites()) {
        if (!spriteAnalyzer) break;
        if (!spriteNeedsAnalysis(asset) || await wallpaperCache.flash(sha256)) continue;
        try {
          await analyzeSprite(sha256, asset);
          sprites++;
        } catch (err) {
          failed++;
          options.log?.(`[themes] the sprite ${sha256} was not analyzed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (sprites > 0) store.changed();
      return { analyzed: analyzed + sprites, failed };
    },
    setAnalyzer(next) {
      analyzer = next;
    },
    collectBlobs,
    installPrepare: (from, prepareOptions) => installs.prepare(from, prepareOptions),
    async installCommit({ installId, onClash, useArrangement }, actor) {
      const ready = await installs.settled(installId);
      if (!ready) return { refused: l('This theme install is no longer open. Start it again.') };
      const { staged, theme } = ready;
      let refused: LocalizedText | undefined;
      let changed: { readonly clash?: ThemeInstallClash; readonly yourEditsName?: string } | undefined;
      let installed: { themeId: string; name: string; replaced: boolean; keptCopy?: { themeId: string; name: string } } | undefined;
      const done = await store.lane.run(async (): Promise<Changed<undefined> | undefined> => {
        const entries = await store.list();
        const target = staged.store?.update ? updateTarget(staged.store, entries) : undefined;
        if (staged.store?.update && !target) {
          refused = l('The theme this would update is no longer installed. Open Browse and try again.');
          return undefined;
        }
        const found = installClash(theme.name, entries, target?.id);
        const yourEditsName = target ? yourEditsNameOf(target, entries) : undefined;
        // a clash the card did not show as it is now (a theme of that name installed, replaced or renamed meanwhile) is asked again
        if (found && !sameClash(found, staged.preview.clash)) {
          changed = { clash: found, ...(yourEditsName !== undefined ? { yourEditsName } : {}) };
          refused = l('A theme named {0} was installed while this card was open. Choose Keep both or Replace, then Install again.', found.name);
          return undefined;
        }
        // so is an Update's copy of the user's edits the card did not name
        if (target && yourEditsName !== staged.preview.store?.update?.yourEditsName) {
          changed = { ...(found ? { clash: found } : {}), ...(yourEditsName !== undefined ? { yourEditsName } : {}) };
          refused = l('The theme {0} changed while this card was open. Check the card, then Install again.', target.name);
          return undefined;
        }
        if (found && onClash === undefined) {
          refused = target ? l('A theme named {0} is installed. Choose Keep both.', found.name) : l('A theme named {0} is installed. Choose Keep both or Replace.', found.name);
          return undefined;
        }
        if (found && onClash === 'replace' && !found.replaceable) {
          refused = target ? l('The update can only keep both themes named {0}. Choose Keep both.', found.name) : l('{0} is a built-in theme, which cannot be replaced. Choose Keep both.', found.name);
          return undefined;
        }
        const replaceClash = found !== undefined && onClash === 'replace';
        const name = found && !replaceClash ? found.keepBothName : theme.name;
        const id = target?.id ?? (replaceClash ? found.themeId : store.newId());
        const copy = target && yourEditsName !== undefined
          ? { id: store.newId(), name: yourEditsName, origin: { kind: 'duplicate', from: target.id, installedAt: now(), ...copiedLayoutOptIn(target.theme.origin) } satisfies Origin }
          : replaceClash && found.keepsCopy ? { id: store.newId(), name: found.keepBothName } : undefined;
        const named: ThemeFile = { ...theme, name };
        const origin: Origin = {
          kind: originKind(staged),
          ...(staged.url !== undefined ? { url: staged.url.slice(0, 2048) } : {}),
          ...(staged.store ? { store: { entryId: staged.store.entryId, version: staged.store.version, sha256: staged.store.sha256 } } : {}),
          installedHash: contentHash({ ...named, id }),
          ...(named.layout !== undefined ? { layoutOptIn: useArrangement } : {}),
          installedAt: now(),
        };
        const replace = target !== undefined || replaceClash;
        installed = { themeId: id, name, replaced: replace, ...(copy ? { keptCopy: { themeId: copy.id, name: copy.name } } : {}) };
        return changeLocked(actor ?? USER_ACTOR, false, (taking) => commitInstall(named, origin, { id, replace, ...(copy ? { copy } : {}) }, taking));
      });
      if (changed) {
        const preview = installs.setClash(installId, changed.clash, changed.yourEditsName);
        if (preview) return { refused: refused!, preview };
      }
      if (!done || !installed) return { refused: refused ?? l('This theme install is no longer open. Start it again.') };
      finished(done);
      installs.forget(installId);
      return { installed };
    },
    installCancel: (installId) => installs.cancel(installId),
    installOpen: (installId) => installs.open(installId),
    installStage: (input) => installs.stage(input),
    async markRemovedFromStore(marks) {
      let marked: string[] = [];
      const done = await store.lane.run(async (): Promise<Changed<undefined> | undefined> => {
        const fresh = new Map<string, { readonly text: string; readonly reason: string }>();
        for (const { themeId, reason } of marks) {
          const text = await store.unlocked.readText(themeId);
          if (text === null || fresh.has(themeId)) continue;
          const read = validateTheme(parseJson(text), { folder: themeId });
          const kept = oneLine(reason, MAX_REMOVED_REASON_CHARS) ?? '';
          // a theme already marked for this reason is left as it is, so a pick the user made since holds
          if (!read.ok || read.theme.origin?.kind !== 'store' || read.theme.origin.removedFromStore?.reason === kept) continue;
          fresh.set(themeId, { text, reason: kept });
        }
        if (fresh.size === 0) return undefined;
        const ids = new Set(fresh.keys());
        return changeLocked(USER_ACTOR, false, async (taking) => {
          const settingsBefore = await readSettings();
          const { schedule, override } = await appearance.schedule();
          const projectsText = await projectsBefore();
          const before: Snapshot = {
            themes: Object.fromEntries([...fresh].map(([id, { text }]) => [id, text])),
            settings: settingsBefore,
            appearance: await appearanceBefore(),
            projects: projectsText,
          };
          taking(before);
          const looks = LOOK_KINDS.filter((kind) => settingsBefore[kind] !== null && ids.has(settingsBefore[kind]!));
          if (looks.length > 0) await writeSettings(Object.fromEntries(looks.map((kind) => [kind, BUILTIN_THEME_ID])));
          if (schedule.rules.some((rule) => ids.has(rule.theme))) await appearance.setSchedule({ ...schedule, rules: schedule.rules.map((rule) => (ids.has(rule.theme) ? { ...rule, theme: BUILTIN_THEME_ID } : rule)) });
          if (override !== undefined && ids.has(override.themeId)) await appearance.setOverride(undefined);
          const projectsNext = projectLooks.withoutThemes(parseJson(projectsText), ids);
          if (projectsNext) await projects.writeText(`${JSON.stringify(projectsNext, null, 2)}\n`);
          const names: string[] = [];
          for (const [id, { text, reason }] of fresh) {
            const raw = parseStoredJson(text) as Record<string, unknown>;
            const origin = isRecord(raw['origin']) ? raw['origin'] : {};
            await store.unlocked.writeText(id, `${JSON.stringify({ ...raw, origin: { ...origin, removedFromStore: { reason, at: now() } } }, null, 2)}\n`);
            names.push(typeof raw['name'] === 'string' ? raw['name'] : id);
          }
          marked = [...ids];
          return { result: undefined, change: { kind: 'storeRemoved', themes: names }, before };
        });
      });
      if (done) finished(done);
      return marked;
    },
    onInstallUpdated: (listener) => installs.onUpdated(listener),
    onInstallExpired: (listener) => installs.onExpired(listener),
    exportPlan: async (themeId, installedFonts = []) => planExport(await exportSource(themeId), installedFonts),
    async exportWrite(themeId, file, installedFonts) {
      checkExportPath(file);
      const bytes = await buildExport(await exportSource(themeId), installedFonts);
      try {
        // the user's own file, so it takes the mode any saved file gets, not the store's private one
        await writeFileAtomic(file, bytes, { mode: 0o666 });
      } catch (err) {
        throw new LocalizedError(l('The theme was not exported: {0}', errorTextOf(err)), { cause: err });
      }
      return bytes.length;
    },
    onDidChange: (listener) => store.onDidChange(listener),
    lane: store.lane,
  };
}
