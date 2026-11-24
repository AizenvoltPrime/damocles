// Main's own read of the theme files (docs/invariants.md "Desktop themes"): core writes them, and main validates each again
// before anything of it is painted, so a file core never wrote, or one changed by hand, is listed broken and never applied.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../../platform/disposable';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import { readFile as readResource } from '../../../core/resource-fs';
import type { ConfigNotices } from '../../../core/config/local-config-path';
import { createThemePathRule, type ThemePathRule } from '../../../core/themes/network-rule';
import { BUILTIN_EXAMPLE_IDS, BUILTIN_THEME, BUILTIN_THEME_ID, BUILTIN_THEME_NAMES, isBuiltinThemeId, SYSTEM_THEME_ID } from '../../../shared/themes/builtin';
import { checkedSystemTheme, systemTheme, type SystemLooks } from '../../../shared/themes/system-theme';
import { eachLimited } from '../../../shared/each-limited';
import { MAX_THEME_NAME_CHARS, READ_CONCURRENCY, USER_THEME_ID } from '../../../shared/themes/limits';
import { checkSchemaVersion, validateTheme, type ThemeFile, themeErrorEnglish, themeErrorText } from '../../../shared/themes/schema';
import { parseStoredJson } from '../../../shared/themes/stored-json';
import type { ThemeChange, ThemeHistoryChange } from '../../../shared/themes/changes';
import { sanitizeThemeCss, themeCssFamilies, type CssDroppedPart } from '../../../shared/themes/css-sanitizer';
import { l, type LocalizedText } from '../../../shared/localized-text';
import type { ThemeListing } from '../../core-protocol';
import type { OverlayThemeEntry } from '../../preload/overlay-channels';

// Must match THEMES_FOLDER, THEME_FILE and MAX_THEME_FILE_BYTES in src/core/themes/store.ts.
const THEMES_FOLDER = 'themes';
const THEME_FILE = 'theme.json';
const MAX_THEME_FILE_BYTES = 4 * 1024 * 1024;
// Must match BUILTIN_THEMES_DIR in src/core/themes/builtins.ts: under the desktop-shell root app:// already serves.
const BUILTIN_THEMES_DIR = ['dist', 'desktop-shell', 'themes'] as const;
export const WATCH_DEBOUNCE_MS = 100;
// A built-in example's wallpaper or sprite file is named by its sha256 and this extension; scripts/generate-theme-art.ts writes them.
const PACKED_EXTENSIONS: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

export type LibraryEntry =
  | { readonly status: 'ok'; readonly id: string; readonly builtin: boolean; readonly theme: ThemeFile }
  // error: the read error or the first validation error, in English, for the log; Settings words a broken theme from core's list
  | { readonly status: 'broken'; readonly id: string; readonly name?: string; readonly error: string }
  | { readonly status: 'needsNewer'; readonly id: string; readonly name?: string; readonly version: number };

const BUILTIN_ENTRY: LibraryEntry = { status: 'ok', id: BUILTIN_THEME_ID, builtin: true, theme: BUILTIN_THEME };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
// 128 UTF-16 units hold at least 64 characters, so a name of megabytes is never spread whole
const nameOf = (json: unknown): string | undefined => (isRecord(json) && typeof json['name'] === 'string' ? [...json['name'].slice(0, 128)].slice(0, 64).join('') : undefined);

const firstRemoved = (theme: ThemeFile): CssDroppedPart | undefined => (theme.css === undefined ? undefined : sanitizeThemeCss(theme.css, { families: themeCssFamilies(theme) }).dropped[0]);

/**
 * Main's own sanitizer pass over a theme's custom CSS: core stores only what the sanitizer kept, so any part it drops now
 * means the file was not written by this core (or by an older sanitizer), and the theme is broken. Undefined when clean.
 */
export function cssRefusal(theme: ThemeFile): string | undefined {
  const first = firstRemoved(theme);
  return first === undefined ? undefined : `/css/${first.region}: custom CSS the sanitizer removes (${first.reason}): ${first.text}`;
}

// The same refusal as Settings words it.
function cssRefusalText(theme: ThemeFile): LocalizedText | undefined {
  const first = firstRemoved(theme);
  return first === undefined ? undefined : l('/css/{0}: custom CSS that Damocles removes: {1}', first.region, first.text);
}

/**
 * One theme folder as main reads it; `json` is the parsed file of any status, for a check of what core wrote. Never throws:
 * a check that fails lists that one theme broken.
 */
export function themeEntry(id: string, json: unknown): LibraryEntry {
  let name: string | undefined;
  const broken = (error: string): LibraryEntry => ({ status: 'broken', id, ...(name !== undefined ? { name } : {}), error });
  try {
    name = nameOf(json);
    const version = checkSchemaVersion(json);
    if (version.kind === 'needsNewer') return { status: 'needsNewer', id, ...(name !== undefined ? { name } : {}), version: version.version };
    const result = validateTheme(json, { folder: id });
    if (!result.ok) return broken(themeErrorEnglish(result.errors[0]));
    const refused = cssRefusal(result.theme);
    return refused !== undefined ? broken(refused) : { status: 'ok', id, builtin: false, theme: result.theme };
  } catch (err) {
    return broken(errorText(err));
  }
}

/** A theme core listed, as Settings shows it: an `ok` one main's own validation refuses is broken there too. */
export function overlayThemeEntry(listing: ThemeListing, localization: { t(message: string, ...args: string[]): string; render(text: LocalizedText): string }): OverlayThemeEntry {
  if (listing.status === 'needsNewer') return listing;
  if (listing.status === 'broken') return { status: 'broken', id: listing.id, ...(listing.name !== undefined ? { name: listing.name } : {}), reason: localization.render(listing.reason) };
  const builtin = listing.builtin && isBuiltinThemeId(listing.id);
  const result = validateTheme(listing.theme, builtin ? { builtin: true, ...(listing.id !== BUILTIN_THEME_ID ? { folder: listing.id } : {}) } : { folder: listing.id });
  const refused = result.ok ? cssRefusalText(result.theme) : themeErrorText(result.errors);
  if (!result.ok || refused !== undefined) return { status: 'broken', id: listing.id, name: listing.name, reason: localization.render(l('theme.json is not a valid theme: {0}', refused!)) };
  const name = shownThemeName({ id: listing.id, builtin, theme: result.theme }, localization);
  const removed = result.theme.origin?.kind === 'store' ? result.theme.origin.removedFromStore : undefined;
  return {
    status: 'ok', id: listing.id, name, builtin, theme: result.theme,
    ...(listing.storeUpdate && !builtin ? { storeUpdate: { version: listing.storeUpdate.version } } : {}),
    ...(removed ? { removedFromStore: { reason: removed.reason } } : {}),
  };
}

/** A theme's name as the UI shows it: a built-in's in the UI's language, any other theme's as its file says it. */
export function shownThemeName(entry: { readonly id: string; readonly builtin: boolean; readonly theme: Pick<ThemeFile, 'name'> }, localization: { t(message: string): string }): string {
  return (entry.builtin ? builtinName(entry.id, localization) : undefined) ?? entry.theme.name;
}

/** A theme name stored beside its id, as the UI shows it: a built-in's in the UI's language, any other as it was stored. */
export function shownStoredName(id: string | undefined, name: string, localization: { t(message: string): string }): string {
  return (id !== undefined ? builtinName(id, localization) : undefined) ?? name;
}

/** The name of a copy, Duplicate's and the agent's unnamed one alike: the theme's shown name, cut so the whole fits a theme name. */
export function themeCopyName(id: string, name: string, localization: { t(message: string, ...args: string[]): string }): string {
  const fixed = [...localization.t('{0} copy', '')].length;
  return localization.t('{0} copy', [...shownStoredName(id, name, localization)].slice(0, MAX_THEME_NAME_CHARS - fixed).join('').trimEnd());
}

/** A history change as the UI words it: the names stored beside a built-in's id in the UI's language. */
export function shownChange(change: ThemeHistoryChange, localization: { t(message: string): string }): ThemeHistoryChange {
  const shown = (plain: ThemeChange): ThemeChange => {
    if (plain.kind === 'pick') {
      return { ...plain, theme: shownStoredName(plain.themeId, plain.theme, localization), ...(plain.was !== undefined ? { was: shownStoredName(plain.wasId, plain.was, localization) } : {}) };
    }
    if (plain.kind === 'hold' || plain.kind === 'projectPin') return { ...plain, theme: shownStoredName(plain.themeId, plain.theme, localization) };
    return plain;
  };
  return change.kind === 'restore' ? { kind: 'restore', before: shown(change.before) } : shown(change);
}

// A built-in's name is Damocles' own text, so it shows in the UI's language.
function builtinName(id: string, localization: { t(message: string): string }): string | undefined {
  return isBuiltinThemeId(id) ? localization.t(BUILTIN_THEME_NAMES[id]) : undefined;
}

/** The file a theme's folder holds, for Show file. */
export function themeFilePath(root: string, id: string): string {
  return path.join(root, THEMES_FOLDER, id, THEME_FILE);
}

// A theme folder as main last checked it: its entry holds while `stamp`, what the file was then, is the same.
interface CheckedFile {
  readonly stamp: string;
  readonly entry: LibraryEntry;
}

// One folder's entry, `known` itself when its file did not change: an unchanged file is not parsed or checked again.
async function readFolder(themesDir: string, id: string, rule: ThemePathRule, known: CheckedFile | undefined): Promise<CheckedFile> {
  const file = path.join(themesDir, id, THEME_FILE);
  const broken = (stamp: string, error: string): CheckedFile => (known?.stamp === stamp ? known : { stamp, entry: { status: 'broken', id, error } });
  try {
    await rule.readable(file);
    const stat = await fs.stat(file);
    if (!stat.isFile()) return broken('not a file', 'theme.json is not a file');
    const stamp = `${stat.size} ${stat.mtimeMs}`;
    if (stat.size > MAX_THEME_FILE_BYTES) return broken(stamp, `theme.json is larger than ${MAX_THEME_FILE_BYTES / 1024 / 1024} MB`);
    if (known?.stamp === stamp) return known;
    const text = await fs.readFile(file, 'utf8');
    let json: unknown;
    try {
      json = parseStoredJson(text);
    } catch (err) {
      return { stamp, entry: { status: 'broken', id, error: errorText(err) } };
    }
    return { stamp, entry: themeEntry(id, json) };
  } catch (err) {
    const error = errorText(err);
    return broken(`unreadable: ${error}`, error);
  }
}

/** A built-in example theme packed with the app, validated as a built-in; never written, so it is read once per run. */
async function readBuiltinExample(resourceRoot: string, id: string): Promise<LibraryEntry> {
  try {
    const json: unknown = JSON.parse(await readResource(path.join(resourceRoot, ...BUILTIN_THEMES_DIR, id, THEME_FILE), 'utf8'));
    const result = validateTheme(json, { builtin: true, folder: id });
    const refused = result.ok ? cssRefusal(result.theme) : themeErrorEnglish(result.errors[0]);
    return result.ok && refused === undefined ? { status: 'ok', id, builtin: true, theme: result.theme } : { status: 'broken', id, error: refused ?? '' };
  } catch (err) {
    return { status: 'broken', id, error: errorText(err) };
  }
}

/** What a listing keeps between reads: each file as last checked, and the folders already told as no theme's. */
interface ListingMemory {
  readonly checked: Map<string, CheckedFile>;
  readonly skipped: Set<string>;
  readonly log: (line: string) => void;
}

/**
 * Every installed theme as main last read it: the built-ins, then each folder under `<root>/themes` named by a user theme's
 * id, by id. A folder of any other name is no theme: it is left out and told once per run. `unchanged` says no user theme's
 * entry is new since `memory` last held them.
 */
async function listThemeFiles(root: string, builtins: readonly LibraryEntry[], notices: ConfigNotices | undefined, memory?: ListingMemory): Promise<{ readonly entries: ReadonlyMap<string, LibraryEntry>; readonly unchanged: boolean }> {
  const themesDir = path.join(root, THEMES_FOLDER);
  const rule = createThemePathRule(root, notices);
  let names: string[] = [];
  try {
    await rule.readable(themesDir);
    names = (await fs.readdir(themesDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const ids = names.filter((name) => USER_THEME_ID.test(name));
  for (const name of names) {
    if (USER_THEME_ID.test(name) || !memory || memory.skipped.has(name)) continue;
    memory.skipped.add(name);
    memory.log(`[themes] the folder ${JSON.stringify(name)} under ${themesDir} is not named by a theme id, so it is not listed`);
  }
  const read = await eachLimited(ids, READ_CONCURRENCY, (id) => readFolder(themesDir, id, rule, memory?.checked.get(id)));
  const unchanged = memory !== undefined && memory.checked.size === ids.length && read.every((folder, at) => folder === memory.checked.get(ids[at]!));
  if (memory) {
    memory.checked.clear();
    read.forEach((folder, at) => memory.checked.set(ids[at]!, folder));
  }
  return { entries: new Map([[BUILTIN_THEME_ID, BUILTIN_ENTRY], ...[...builtins, ...read.map((folder) => folder.entry)].map((entry): [string, LibraryEntry] => [entry.id, entry])]), unchanged };
}

/** One listing with nothing kept from an earlier one. */
export const readThemeFiles = async (root: string, builtins: readonly LibraryEntry[] = [], notices?: ConfigNotices): Promise<ReadonlyMap<string, LibraryEntry>> => (await listThemeFiles(root, builtins, notices)).entries;

export interface ThemeLibraryOptions {
  readonly root: string;
  // where the built-in example themes are packed; none when absent
  readonly resourceRoot?: string;
  readonly watchers: FileWatcherFactory;
  readonly log: (line: string) => void;
  // where a theme file the network rule refuses to read is told, once per file
  readonly notifications?: ConfigNotices;
  // the System colors theme and its changes; absent: Damocles' own colors for the whole run
  readonly system?: { looks(): SystemLooks; onDidChange(listener: () => void): Disposable };
}

/**
 * The theme files main paints from, read again WATCH_DEBOUNCE_MS after the last change its watcher saw, or at once when core
 * says it wrote one (`coreChanged`), which also cancels the debounce, since core's write is the change the watcher reports.
 * System colors has no file: its entry comes from `system`, whose change tells the listeners with no read.
 */
export class ThemeLibrary implements Disposable {
  // the files as last listed, which each listing replaces whole; System colors is merged into `merged`
  private current: ReadonlyMap<string, LibraryEntry> = new Map([[BUILTIN_THEME_ID, BUILTIN_ENTRY]]);
  private systemEntry: LibraryEntry;
  private merged: ReadonlyMap<string, LibraryEntry>;
  private readonly systemSubscription: Disposable | undefined;
  private builtins: Promise<LibraryEntry[]> | undefined;
  private readonly memory: ListingMemory;
  private listed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reading: Promise<void> | undefined;
  // the one read that follows the running one, shared by every caller that asked during it
  private followUp: Promise<void> | undefined;
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private readonly watcher: Disposable;
  private readonly options: ThemeLibraryOptions;

  constructor(options: ThemeLibraryOptions) {
    this.options = options;
    this.memory = { checked: new Map(), skipped: new Set(), log: options.log };
    // based at the store's root, so the watcher's network rule judges the themes folder as the reads do
    const watcher = options.watchers.watch(options.root, `${THEMES_FOLDER}/*/${THEME_FILE}`);
    const schedule = (): void => this.schedule();
    watcher.onDidCreate(schedule);
    watcher.onDidChange(schedule);
    watcher.onDidDelete(schedule);
    this.watcher = watcher;
    const { system } = options;
    const systemEntry = (): LibraryEntry => ({ status: 'ok', id: SYSTEM_THEME_ID, builtin: true, theme: system ? checkedSystemTheme(system.looks(), options.log) : systemTheme({}) });
    this.systemEntry = systemEntry();
    this.merged = this.merge();
    this.systemSubscription = system?.onDidChange(() => {
      if (this.disposed) return;
      this.systemEntry = systemEntry();
      this.merged = this.merge();
      this.fire();
    });
  }

  entry(id: string): LibraryEntry | undefined {
    return this.merged.get(id);
  }

  entries(): ReadonlyMap<string, LibraryEntry> {
    return this.merged;
  }

  // Damocles, System colors, then the files as listed.
  private merge(): ReadonlyMap<string, LibraryEntry> {
    const [first, ...rest] = [...this.current];
    return new Map([...(first ? [first] : []), [SYSTEM_THEME_ID, this.systemEntry], ...rest]);
  }

  private fire(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        this.options.log(`[themes] a listener of the theme files failed: ${errorText(err)}`);
      }
    }
  }

  /** The packed file of a wallpaper or sprite a built-in example ships, `<sha256>.<ext>` beside its theme.json; undefined for any other. */
  packedAsset(sha256: string): string | undefined {
    const { resourceRoot } = this.options;
    if (resourceRoot === undefined) return undefined;
    for (const entry of this.current.values()) {
      const asset = entry.status === 'ok' && entry.builtin && entry.id !== BUILTIN_THEME_ID ? entry.theme.assets?.[sha256] : undefined;
      const extension = asset?.kind === 'image' || asset?.kind === 'sprite' ? PACKED_EXTENSIONS[asset.mime] : undefined;
      if (extension !== undefined) return path.join(resourceRoot, ...BUILTIN_THEMES_DIR, entry.id, `${sha256}.${extension}`);
    }
    return undefined;
  }

  /** Reads the files now; settles once a read that started after this call has the entries. Never rejects. */
  load(): Promise<void> {
    const reading = this.reading;
    if (reading) {
      this.followUp ??= reading.then(() => {
        this.followUp = undefined;
        return this.disposed ? undefined : this.load();
      });
      return this.followUp;
    }
    this.reading = this.read().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  /** Core wrote a theme file: read them all now; settles once the entries are current. */
  coreChanged(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.load();
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.watcher.dispose();
    this.systemSubscription?.dispose();
    this.listeners.clear();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.load();
    }, WATCH_DEBOUNCE_MS);
  }

  private async read(): Promise<void> {
    let next: { readonly entries: ReadonlyMap<string, LibraryEntry>; readonly unchanged: boolean };
    const { resourceRoot } = this.options;
    this.builtins ??= resourceRoot === undefined ? Promise.resolve([]) : Promise.all(BUILTIN_EXAMPLE_IDS.map((id) => readBuiltinExample(resourceRoot, id)));
    try {
      next = await listThemeFiles(this.options.root, await this.builtins, this.options.notifications, this.memory);
    } catch (err) {
      this.options.log(`[themes] the theme files could not be listed: ${errorText(err)}`);
      return;
    }
    if (this.disposed) return;
    // the built-ins are read once, so after the first listing only a user theme's file can differ
    if (this.listed && next.unchanged) return;
    this.listed = true;
    this.current = next.entries;
    this.merged = this.merge();
    this.fire();
  }
}
