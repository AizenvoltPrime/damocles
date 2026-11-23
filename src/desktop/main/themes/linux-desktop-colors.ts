// A Linux desktop's own palette for System colors (docs/themes.md "The System colors theme"): KDE's kdeglobals, GNOME's
// libadwaita with the user's gtk.css, or a qt5ct/qt6ct custom palette, read again when one of its files changes.
import * as path from 'node:path';
import { readFileBytes } from '../../../core/file-bytes';
import { literalGlob } from '../../../core/watch-root';
import type { Disposable } from '../../../platform/disposable';
import type { FileWatcher } from '../../../platform/file-watcher';
import { englishText } from '../../../shared/localized-text';
import { gtkRoles, iniValue, kdeRolesOfIni, LIBADWAITA_SEEDS, qtRolesOfIni, readIni, SchemeImportError, type Ini, type PaletteRoles } from '../../../shared/themes/schemes';
import { LOOK_KINDS, type LookKind } from '../../../shared/themes/tokens';

export type LinuxTier = 'kde' | 'gnome' | 'qt5ct' | 'qt6ct';

type Env = Readonly<Record<string, string | undefined>>;

/** The palettes a desktop gives, and the accent it shows when the OS reports none. Colors are `#rrggbb` or `#rrggbbaa`. */
export interface DesktopColors {
  readonly palettes: Partial<Record<LookKind, PaletteRoles>>;
  readonly accent?: string;
}

const NO_COLORS: DesktopColors = { palettes: {} };

// a config file of a few KB; anything this large is not one
const MAX_CONFIG_BYTES = 1024 * 1024;
const DEBOUNCE_MS = 100;

// KColorScheme's compiled defaults (Breeze Light), which KDE apps show for a key no kdeglobals sets: src/kcolorscheme.cpp of
// https://github.com/KDE/kcolorscheme at 47f3053a918bde5b6fbc9e8891e3b9ad46829cd8, in its SerializedColors order.
const SERIALIZED_KEYS = [
  'BackgroundNormal', 'BackgroundAlternate', 'ForegroundNormal', 'ForegroundInactive', 'ForegroundActive', 'ForegroundLink',
  'ForegroundVisited', 'ForegroundNegative', 'ForegroundNeutral', 'ForegroundPositive',
] as const;
const KCOLORSCHEME_DEFAULTS: Readonly<Record<string, readonly string[]>> = {
  'Colors:View': ['255,255,255', '247,247,247', '35,38,41', '112,125,138', '61,174,233', '41,128,185', '155,89,182', '218,68,83', '246,116,0', '39,174,96'],
  'Colors:Window': ['239,240,241', '227,229,231', '35,38,41', '112,125,138', '61,174,233', '41,128,185', '155,89,182', '218,68,83', '246,116,0', '39,174,96'],
  'Colors:Selection': ['61,174,233', '163,212,250', '255,255,255', '112,125,138', '255,255,255', '253,188,75', '155,89,182', '176,55,69', '198,92,0', '23,104,57'],
};
const BREEZE: Ini = new Map(Object.entries(KCOLORSCHEME_DEFAULTS).map(([group, colors]) => [group, new Map(SERIALIZED_KEYS.map((key, i) => [key, colors[i]!]))]));

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** D5: a KDE entry of XDG_CURRENT_DESKTOP, then a GNOME one, then QT_QPA_PLATFORMTHEME qt5ct or qt6ct; else no desktop palette. */
export function linuxTier(env: Env): LinuxTier | undefined {
  const desktops = (env['XDG_CURRENT_DESKTOP'] ?? '').split(':').map((entry) => entry.trim().toUpperCase());
  if (desktops.includes('KDE')) return 'kde';
  if (desktops.includes('GNOME')) return 'gnome';
  const qt = env['QT_QPA_PLATFORMTHEME'];
  return qt === 'qt5ct' || qt === 'qt6ct' ? qt : undefined;
}

/** $XDG_CONFIG_HOME when it is absolute, as the XDG Base Directory spec requires, else ~/.config. */
export function configHome(env: Env, home: string): string {
  const own = env['XDG_CONFIG_HOME'];
  return own !== undefined && path.isAbsolute(own) ? own : path.join(home, '.config');
}

// $XDG_CONFIG_DIRS, most important first; path.delimiter is the spec's ':' on Linux
function configDirs(env: Env): string[] {
  const dirs = (env['XDG_CONFIG_DIRS'] ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir));
  return dirs.length > 0 ? dirs : ['/etc/xdg'];
}

// undefined when the file is not there; throws when it is there and cannot be read as text
async function readConfigText(file: string): Promise<string | undefined> {
  const read = await readFileBytes(file, MAX_CONFIG_BYTES);
  switch (read.kind) {
    case 'bytes': return read.bytes.toString('utf8').replace(/^\uFEFF/, '');
    case 'missing': return undefined;
    case 'tooLarge': throw new Error(`${file} is larger than ${MAX_CONFIG_BYTES} bytes`);
    case 'notAFile': throw new Error(`${file} is ${read.folder ? 'a folder' : 'not a regular file'}`);
    case 'unreadable': throw new Error(`${file} could not be read: ${read.error}`);
  }
}

// a file to watch: the folder its watch is based at, and its path below that folder
type Watched = readonly [base: string, name: string];
// told each file to watch before the read opens it
type WatchSink = (file: Watched) => void;

interface TierRead {
  readonly colors: DesktopColors;
  // where the colors came from, for the log
  readonly source: string;
  readonly notes?: readonly string[];
}

/** What one read gives: the colors, the files whose change reads again, and the lines it tells the log. */
export interface LinuxReading {
  readonly colors: DesktopColors;
  readonly watch: readonly Watched[];
  readonly notes: readonly string[];
}

// KConfig's cascade: each $XDG_CONFIG_DIRS/kdeglobals, the last least important, then $XDG_CONFIG_HOME/kdeglobals, merged key by
// key over KColorScheme's defaults; a system folder's file that cannot be read is skipped, as KConfig skips it
async function readKde(env: Env, config: string, watch: WatchSink): Promise<TierRead> {
  const bases = [config, ...configDirs(env)];
  for (const base of bases) watch([base, 'kdeglobals']);
  const merged = new Map([...BREEZE].map(([group, keys]) => [group, new Map(keys)]));
  const read: string[] = [];
  const notes: string[] = [];
  for (const base of [...bases].reverse()) {
    const file = path.join(base, 'kdeglobals');
    let text: string | undefined;
    try {
      text = await readConfigText(file);
    } catch (err) {
      if (base === config) throw err;
      notes.push(`${errorText(err)}; System colors skips it, as KDE does`);
      continue;
    }
    if (text === undefined) continue;
    read.push(file);
    // an empty value reads as unset, so the default below it stays
    for (const [group, keys] of readIni(text, file, { lenient: true })) merged.set(group, new Map([...(merged.get(group) ?? []), ...[...keys].filter(([, value]) => value !== '')]));
  }
  const { palettes } = kdeRolesOfIni(merged, 'kdeglobals', { lenient: true, defaults: BREEZE });
  return { colors: { palettes }, source: read.length > 0 ? `KDE's colors in ${[...read].reverse().join(', ')}` : "KDE's default colors (no kdeglobals sets them)", notes };
}

// libadwaita's colors of each kind under the user's gtk-4.0/gtk.css; the accent is the file's, else the portal's, else libadwaita blue
async function readGnome(config: string, watch: WatchSink): Promise<TierRead> {
  watch([config, 'gtk-4.0/gtk.css']);
  const file = path.join(config, 'gtk-4.0', 'gtk.css');
  let own: Partial<Record<LookKind, PaletteRoles>> = {};
  let notes: string[] = [];
  try {
    const text = await readConfigText(file);
    if (text !== undefined) {
      const roles = gtkRoles(text, file, { kinds: LOOK_KINDS });
      own = roles.palettes;
      notes = roles.warnings.map(englishText);
    }
  } catch (err) {
    // a file that defines no color, an @import-only one included, is no failure: libadwaita's colors show
    notes = [err instanceof SchemeImportError && err.reason === 'noColors' ? `System colors shows libadwaita's colors: ${err.message}` : `${errorText(err)}; System colors shows libadwaita's own colors`];
  }
  const palettes = Object.fromEntries(LOOK_KINDS.map((kind) => {
    const { accent: _accent, ...defaults } = LIBADWAITA_SEEDS[kind];
    return [kind, { kind, seeds: { ...defaults, ...own[kind]?.seeds }, tokens: {} }];
  }));
  return { colors: { palettes, accent: LIBADWAITA_SEEDS.dark.accent }, source: Object.keys(own).length > 0 ? `libadwaita's colors under ${file}` : "libadwaita's colors", notes };
}

// qt5ct's or qt6ct's conf, and with [Appearance] custom_palette=true the scheme file color_scheme_path names, which qt5ct
// writes absolute; a relative path, which Qt would read against the app's working folder, names no file here
async function readQt(tier: 'qt5ct' | 'qt6ct', config: string, watch: WatchSink): Promise<TierRead> {
  watch([config, `${tier}/${tier}.conf`]);
  const file = path.join(config, tier, `${tier}.conf`);
  const text = await readConfigText(file);
  if (text === undefined) throw new Error(`${file} is not there`);
  const appearance = readIni(text, file, { lenient: true, qsettings: true }).get('Appearance');
  if (iniValue(appearance?.get('custom_palette') ?? '') !== 'true') return { colors: NO_COLORS, source: `${file}, which sets no custom palette` };
  const scheme = iniValue(appearance?.get('color_scheme_path') ?? '');
  if (!path.isAbsolute(scheme)) throw new Error(`${file} names its color scheme by a path that is not absolute: ${JSON.stringify(scheme).slice(0, 200)}`);
  watch([path.dirname(scheme), path.basename(scheme)]);
  const schemeText = await readConfigText(scheme);
  if (schemeText === undefined) throw new Error(`${scheme}, the color scheme ${file} names, is not there`);
  return { colors: { palettes: qtRolesOfIni(readIni(schemeText, scheme, { lenient: true, qsettings: true }), scheme, { lenient: true }).palettes }, source: `the ${tier} palette ${scheme}` };
}

/**
 * The desktop's colors as its files say now; `follow` hears of each file to watch before it is read. Never throws: a file
 * that is there and cannot be read gives no palette, and says why.
 */
export async function readLinuxColors(env: Env, home: string, follow: WatchSink = () => undefined): Promise<LinuxReading> {
  const tier = linuxTier(env);
  if (tier === undefined) {
    return { colors: NO_COLORS, watch: [], notes: ['[themes] System colors reads no desktop palette: XDG_CURRENT_DESKTOP names neither KDE nor GNOME, and QT_QPA_PLATFORMTHEME is neither qt5ct nor qt6ct'] };
  }
  const config = configHome(env, home);
  const watch: Watched[] = [];
  const watched: WatchSink = (file) => {
    watch.push(file);
    follow(file);
  };
  try {
    const read = tier === 'kde' ? await readKde(env, config, watched) : tier === 'gnome' ? await readGnome(config, watched) : await readQt(tier, config, watched);
    return { colors: read.colors, watch, notes: [`[themes] System colors follows ${read.source}`, ...(read.notes ?? []).map((note) => `[themes] ${note}`)] };
  } catch (err) {
    return { colors: NO_COLORS, watch, notes: [`[themes] System colors shows Damocles' own colors with the accent, since ${errorText(err)}`] };
  }
}

export interface LinuxDesktopColorsDeps {
  readonly env: Env;
  readonly home: string;
  // the file watchers' watch(base, glob)
  readonly watch: (base: string, glob: string) => FileWatcher;
  readonly log: (line: string) => void;
}

/**
 * The desktop's colors as last read. A change of a file it read (an atomic rename included) or `reread()` reads again
 * DEBOUNCE_MS later, and its listeners hear only of colors that differ. A symlinked file whose target changes elsewhere is not seen.
 */
export class LinuxDesktopColors implements Disposable {
  private readonly deps: LinuxDesktopColorsDeps;
  private readonly listeners = new Set<() => void>();
  private readonly watchers = new Map<string, FileWatcher>();
  // a watch that failed is logged once, not at every read that tries it again
  private readonly watchFailed = new Set<string>();
  private colors: DesktopColors = NO_COLORS;
  // the last read's log lines, so a line is told once per change and not at every read
  private told = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reading: Promise<void> | undefined;
  private again = false;
  private disposed = false;

  constructor(deps: LinuxDesktopColorsDeps) {
    this.deps = deps;
  }

  current(): DesktopColors {
    return this.colors;
  }

  /** The first read, which starts the watches. */
  load(): Promise<void> {
    return this.read();
  }

  reread(): void {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.read(), DEBOUNCE_MS);
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    for (const watcher of this.watchers.values()) watcher.dispose();
    this.watchers.clear();
    this.listeners.clear();
  }

  // One read at a time; a change during one reads once more after it.
  private read(): Promise<void> {
    if (this.reading) {
      this.again = true;
      return this.reading;
    }
    this.reading = (async () => {
      do {
        this.again = false;
        const reading = await readLinuxColors(this.deps.env, this.deps.home, (file) => this.follow(file));
        if (this.disposed) return;
        this.unfollowAllBut(reading.watch);
        this.tell(reading.notes);
        this.publish(reading.colors);
      } while (this.again && !this.disposed);
    })().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  // Started before the read opens the file, so a change after the read is an event.
  private follow([base, name]: Watched): void {
    const key = `${base}\0${name}`;
    if (this.disposed || this.watchers.has(key)) return;
    try {
      const watcher = this.deps.watch(base, literalGlob(name));
      const changed = (): void => this.reread();
      watcher.onDidCreate(changed);
      watcher.onDidChange(changed);
      watcher.onDidDelete(changed);
      this.watchers.set(key, watcher);
      this.watchFailed.delete(key);
    } catch (err) {
      if (this.watchFailed.has(key)) return;
      this.watchFailed.add(key);
      this.deps.log(`[themes] System colors could not watch ${path.join(base, name)}: ${errorText(err)}`);
    }
  }

  private unfollowAllBut(watch: readonly Watched[]): void {
    const wanted = new Set(watch.map(([base, name]) => `${base}\0${name}`));
    for (const [key, watcher] of this.watchers) {
      if (wanted.has(key)) continue;
      watcher.dispose();
      this.watchers.delete(key);
    }
  }

  private tell(notes: readonly string[]): void {
    for (const note of notes) if (!this.told.has(note)) this.deps.log(note);
    this.told = new Set(notes);
  }

  private publish(colors: DesktopColors): void {
    if (JSON.stringify(colors) === JSON.stringify(this.colors)) return;
    this.colors = colors;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        this.deps.log(`[themes] a listener of the desktop colors failed: ${errorText(err)}`);
      }
    }
  }
}
