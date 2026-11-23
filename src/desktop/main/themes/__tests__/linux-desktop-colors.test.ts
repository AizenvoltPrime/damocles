import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileWatcher } from '../../../../platform/file-watcher';
import { LIBADWAITA_SEEDS } from '../../../../shared/themes/schemes';
import { systemTheme } from '../../../../shared/themes/system-theme';
import { DesktopFileWatcherFactory } from '../../../local-services/file-watcher-factory';
import { createInProcessTreeHost } from '../../../watch-worker/fs-watch-tree';
import { configHome, LinuxDesktopColors, linuxTier, readLinuxColors } from '../linux-desktop-colors';
import { SystemColorSource } from '../system-colors';

// The Linux desktop tiers of System colors, on temp folders named by a fake environment. The fixtures are written for these
// tests, not copied from any desktop's scheme.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A config home and two system config folders under a temp root, the first system folder the more important. */
function desktop(env: Record<string, string> = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ldc-')));
  roots.push(root);
  const config = path.join(root, 'config');
  const system = [path.join(root, 'xdg1'), path.join(root, 'xdg2')];
  return { root, config, system, home: path.join(root, 'home'), env: { XDG_CONFIG_HOME: config, XDG_CONFIG_DIRS: system.join(path.delimiter), ...env } };
}

const KDE = { XDG_CURRENT_DESKTOP: 'KDE' };

// a dark scheme whose colors keep AA, so System colors keeps them
const kdeScheme = (background: string): string => [
  '[Colors:View]', `BackgroundNormal=${background}`, 'ForegroundNormal=230,230,235', 'ForegroundInactive=160,165,175',
  'ForegroundActive=90,170,240', 'ForegroundNegative=240,90,100', 'ForegroundNeutral=240,170,60', 'ForegroundPositive=90,200,120',
  '[Colors:Window]', 'BackgroundNormal=38,42,51', '[Colors:Selection]', 'BackgroundNormal=90,140,230', '',
].join('\n');

// a qt5ct palette in QPalette role order (WindowText, Button, Light, Midlight, Dark, Mid, Text, BrightText, ButtonText, Base,
// Window, Shadow, Highlight, HighlightedText, Link, LinkVisited, AlternateBase, NoRole, ToolTipBase, ToolTipText,
// PlaceholderText), with `base` as its Base
const qtScheme = (base: string): string =>
  `[ColorScheme]\nactive_colors=#ffe6e6eb, #ff2a2e36, #ff3a3f4a, #ff32363f, #ff15171c, #ff20232a, #ffe6e6eb, #ffffffff, #ffe6e6eb, ${base}, #ff262a33, #ff000000, #ff5a8ce6, #ffffffff, #ff5aaaf0, #ffb48cf0, #ff23262e, #ff000000, #ff262a33, #ffe6e6eb, #ffa0a5af\n`;

// KColorScheme's compiled Breeze Light defaults as the seeds they give
const BREEZE_SEEDS = { background: '#ffffff', panel: '#eff0f1', text: '#232629', accent: '#3daee9', success: '#27ae60', warning: '#f67400', danger: '#da4453', info: '#3daee9' };

describe('linuxTier', () => {
  it('takes a KDE entry first, then GNOME, then qt5ct or qt6ct, and nothing else', () => {
    expect(linuxTier({ XDG_CURRENT_DESKTOP: 'GNOME:KDE', QT_QPA_PLATFORMTHEME: 'qt5ct' })).toBe('kde');
    expect(linuxTier({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', QT_QPA_PLATFORMTHEME: 'qt6ct' })).toBe('gnome');
    expect(linuxTier({ XDG_CURRENT_DESKTOP: 'XFCE', QT_QPA_PLATFORMTHEME: 'qt6ct' })).toBe('qt6ct');
    expect(linuxTier({ QT_QPA_PLATFORMTHEME: 'qt5ct' })).toBe('qt5ct');
    expect(linuxTier({ XDG_CURRENT_DESKTOP: 'XFCE', QT_QPA_PLATFORMTHEME: 'gtk3' })).toBeUndefined();
    expect(linuxTier({})).toBeUndefined();
  });

  it('counts XDG_CONFIG_HOME only when it is absolute', () => {
    const home = path.resolve('/home/someone');
    expect(configHome({ XDG_CONFIG_HOME: 'relative/config' }, home)).toBe(path.join(home, '.config'));
    expect(configHome({}, home)).toBe(path.join(home, '.config'));
    expect(configHome({ XDG_CONFIG_HOME: path.join(home, 'cfg') }, home)).toBe(path.join(home, 'cfg'));
  });

  it('gives no palette and watches nothing on any other desktop', async () => {
    const reading = await readLinuxColors({ XDG_CURRENT_DESKTOP: 'XFCE' }, '/home/someone');
    expect(reading.colors).toEqual({ palettes: {} });
    expect(reading.watch).toEqual([]);
    expect(reading.notes).toEqual([expect.stringContaining('reads no desktop palette')]);
  });
});

describe('KDE', () => {
  it('merges kdeglobals key by key in KConfig order, the config home over each config dir, an earlier dir over a later one', async () => {
    const d = desktop(KDE);
    write(path.join(d.config, 'kdeglobals'), '[Colors:View]\nBackgroundNormal=30,32,40\nForegroundNormal=230,230,235\na line KConfig skips\n');
    write(path.join(d.system[0]!, 'kdeglobals'), '[Colors:View]\nBackgroundNormal=1,1,1\n[Colors:Window]\nBackgroundNormal=38,42,51\n');
    write(path.join(d.system[1]!, 'kdeglobals'), '[Colors:Window]\nBackgroundNormal=99,99,99\n[Colors:View]\nForegroundPositive=90,200,120\nForegroundNegative=\n');
    const reading = await readLinuxColors(d.env, d.home);
    // every key no file sets is KColorScheme's default, an empty value included
    expect(reading.colors).toEqual({
      palettes: { dark: { kind: 'dark', seeds: { ...BREEZE_SEEDS, background: '#1e2028', panel: '#262a33', text: '#e6e6eb', success: '#5ac878' }, tokens: { '--d-muted': '#707d8a' } } },
    });
    expect(reading.watch).toEqual([[d.config, 'kdeglobals'], [d.system[0], 'kdeglobals'], [d.system[1], 'kdeglobals']]);
    expect(reading.notes[0]).toBe(`[themes] System colors follows KDE's colors in ${[d.config, ...d.system].map((dir) => path.join(dir, 'kdeglobals')).join(', ')}`);
  });

  it("shows KColorScheme's compiled Breeze defaults when no kdeglobals sets a color", async () => {
    const d = desktop(KDE);
    write(path.join(d.config, 'kdeglobals'), '[General]\nColorScheme=Whatever\n');
    const reading = await readLinuxColors(d.env, d.home);
    expect(reading.colors).toEqual({ palettes: { light: { kind: 'light', seeds: BREEZE_SEEDS, tokens: { '--d-muted': '#707d8a' } } } });
    fs.rmSync(path.join(d.config, 'kdeglobals'));
    expect((await readLinuxColors(d.env, d.home)).colors).toEqual(reading.colors);
    // System colors keeps what KDE apps show, its fills moved only where they are below 3:1 on white
    expect(systemTheme(reading.colors).looks.light!.colors).toMatchObject({ background: BREEZE_SEEDS.background, panel: BREEZE_SEEDS.panel, text: BREEZE_SEEDS.text });
  });

  it('gives no palette, and says why, for a kdeglobals of your own that is a folder or larger than 1 MB', async () => {
    const d = desktop(KDE);
    const own = path.join(d.config, 'kdeglobals');
    fs.mkdirSync(own, { recursive: true });
    const folder = await readLinuxColors(d.env, d.home);
    expect(folder.colors).toEqual({ palettes: {} });
    expect(folder.notes).toEqual([`[themes] System colors shows Damocles' own colors with the accent, since ${own} is a folder`]);
    // still watched, so fixing it is seen
    expect(folder.watch).toContainEqual([d.config, 'kdeglobals']);
    fs.rmdirSync(own);
    write(own, `[Colors:View]\n${'#'.repeat(1024 * 1024)}\n`);
    expect((await readLinuxColors(d.env, d.home)).notes).toEqual([`[themes] System colors shows Damocles' own colors with the accent, since ${own} is larger than 1048576 bytes`]);
  });

  it("skips a system folder's kdeglobals that is a folder or larger than 1 MB, as KConfig does, and says so", async () => {
    const d = desktop(KDE);
    write(path.join(d.config, 'kdeglobals'), kdeScheme('30,32,40'));
    fs.mkdirSync(path.join(d.system[0]!, 'kdeglobals'), { recursive: true });
    write(path.join(d.system[1]!, 'kdeglobals'), `[Colors:View]\n${'#'.repeat(1024 * 1024)}\n`);
    const reading = await readLinuxColors(d.env, d.home);
    expect(reading.colors.palettes.dark!.seeds.background).toBe('#1e2028');
    expect(reading.notes).toEqual([
      `[themes] System colors follows KDE's colors in ${path.join(d.config, 'kdeglobals')}`,
      `[themes] ${path.join(d.system[1]!, 'kdeglobals')} is larger than 1048576 bytes; System colors skips it, as KDE does`,
      `[themes] ${path.join(d.system[0]!, 'kdeglobals')} is a folder; System colors skips it, as KDE does`,
    ]);
  });

  it("reads a value that is no color as KDE's default for that key", async () => {
    const d = desktop(KDE);
    write(path.join(d.config, 'kdeglobals'), '[Colors:View]\nBackgroundNormal=not a color\n');
    const bad = await readLinuxColors(d.env, d.home);
    expect(bad.colors).toEqual({ palettes: { light: { kind: 'light', seeds: BREEZE_SEEDS, tokens: { '--d-muted': '#707d8a' } } } });
  });

  it('reads $XDG_CONFIG_DIRS as /etc/xdg when it is unset or names no absolute folder', async () => {
    const d = desktop(KDE);
    for (const dirs of [undefined, ['relative', 'also/relative'].join(path.delimiter)]) {
      const env: Record<string, string> = { XDG_CURRENT_DESKTOP: 'KDE', XDG_CONFIG_HOME: d.config, ...(dirs !== undefined ? { XDG_CONFIG_DIRS: dirs } : {}) };
      expect((await readLinuxColors(env, d.home)).watch).toEqual([[d.config, 'kdeglobals'], ['/etc/xdg', 'kdeglobals']]);
    }
    const mixed = { ...d.env, XDG_CONFIG_DIRS: ['relative', d.system[1]!].join(path.delimiter) };
    expect((await readLinuxColors(mixed, d.home)).watch).toEqual([[d.config, 'kdeglobals'], [d.system[1], 'kdeglobals']]);
  });
});

describe('GNOME', () => {
  const GNOME = { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' };
  const { accent: _dark, ...darkDefaults } = LIBADWAITA_SEEDS.dark;
  const { accent: _light, ...lightDefaults } = LIBADWAITA_SEEDS.light;

  it("is libadwaita's colors of each kind with libadwaita blue as the accent the portal's comes before", async () => {
    const d = desktop(GNOME);
    const reading = await readLinuxColors(d.env, d.home);
    expect(reading.colors).toEqual({
      palettes: { dark: { kind: 'dark', seeds: darkDefaults, tokens: {} }, light: { kind: 'light', seeds: lightDefaults, tokens: {} } },
      accent: '#3584e4',
    });
    expect(reading.watch).toEqual([[d.config, 'gtk-4.0/gtk.css']]);
  });

  it("takes the user's gtk.css over libadwaita per kind, its accent included", async () => {
    const d = desktop(GNOME);
    write(path.join(d.config, 'gtk-4.0', 'gtk.css'), '@media (prefers-color-scheme: dark) {\n  @define-color view_bg_color #101418;\n  @define-color accent_bg_color #c061cb;\n}\n');
    const { colors } = await readLinuxColors(d.env, d.home);
    expect(colors.palettes.dark!.seeds).toEqual({ ...darkDefaults, background: '#101418', accent: '#c061cb' });
    expect(colors.palettes.light!.seeds).toEqual(lightDefaults);
  });

  it("keeps libadwaita's colors, and says why, for a gtk.css it cannot read", async () => {
    const d = desktop(GNOME);
    fs.mkdirSync(path.join(d.config, 'gtk-4.0', 'gtk.css'), { recursive: true });
    const reading = await readLinuxColors(d.env, d.home);
    expect(reading.colors.palettes.dark!.seeds).toEqual(darkDefaults);
    expect(reading.notes).toContainEqual(`[themes] ${path.join(d.config, 'gtk-4.0', 'gtk.css')} is a folder; System colors shows libadwaita's own colors`);
  });

  it("shows libadwaita's colors for a gtk.css that only imports another file, and names that file", async () => {
    const d = desktop(GNOME);
    const file = path.join(d.config, 'gtk-4.0', 'gtk.css');
    write(file, "@import 'colors.css';\n");
    const reading = await readLinuxColors(d.env, d.home);
    expect(reading.colors.palettes.dark!.seeds).toEqual(darkDefaults);
    expect(reading.notes).toEqual([
      "[themes] System colors follows libadwaita's colors",
      `[themes] System colors shows libadwaita's colors: ${file} defines none of the GTK colors Damocles reads and imports 'colors.css', which Damocles does not follow. Import that file instead.`,
    ]);
  });
});

describe('qt5ct and qt6ct', () => {
  const SCHEME = qtScheme('#ff1e2028');

  it("follows the scheme file a custom palette names, and watches it, under qt6ct's own conf", async () => {
    const d = desktop({ QT_QPA_PLATFORMTHEME: 'qt6ct' });
    const scheme = path.join(d.root, 'schemes', 'mine.conf');
    write(scheme, SCHEME);
    write(path.join(d.config, 'qt6ct', 'qt6ct.conf'), `[Appearance]\ncustom_palette=true\ncolor_scheme_path=${scheme}\nstyle=Fusion\n`);
    const reading = await readLinuxColors(d.env, d.home);
    expect(reading.colors).toEqual({
      palettes: { dark: { kind: 'dark', seeds: { background: '#1e2028', panel: '#262a33', text: '#e6e6eb', accent: '#5a8ce6', info: '#5aaaf0' }, tokens: { '--d-muted': '#a0a5af' } } },
    });
    expect(reading.watch).toEqual([[d.config, 'qt6ct/qt6ct.conf'], [path.dirname(scheme), 'mine.conf']]);
  });

  it('gives no palette without custom_palette=true, or for a scheme path that is not absolute or not there', async () => {
    const d = desktop({ QT_QPA_PLATFORMTHEME: 'qt5ct' });
    const conf = path.join(d.config, 'qt5ct', 'qt5ct.conf');
    write(path.join(d.root, 'mine.conf'), SCHEME);
    write(conf, `[Appearance]\ncustom_palette=false\ncolor_scheme_path=${path.join(d.root, 'mine.conf')}\n`);
    const off = await readLinuxColors(d.env, d.home);
    expect(off.colors).toEqual({ palettes: {} });
    expect(off.notes).toEqual([`[themes] System colors follows ${conf}, which sets no custom palette`]);
    write(conf, '[Appearance]\ncustom_palette=true\ncolor_scheme_path=mine.conf\n');
    const relative = await readLinuxColors(d.env, d.home);
    expect(relative.colors).toEqual({ palettes: {} });
    expect(relative.notes[0]).toContain('by a path that is not absolute: "mine.conf"');
    write(conf, `[Appearance]\ncustom_palette=true\ncolor_scheme_path=${path.join(d.root, 'gone.conf')}\n`);
    expect((await readLinuxColors(d.env, d.home)).notes[0]).toContain(`${path.join(d.root, 'gone.conf')}, the color scheme ${conf} names, is not there`);
  });

  it('reads the conf and the scheme as QSettings does: a ; comment, and a \\ that continues a line', async () => {
    const d = desktop({ QT_QPA_PLATFORMTHEME: 'qt5ct' });
    const scheme = path.join(d.root, 'mine.conf');
    write(scheme, SCHEME.replace('#ff2a2e36, ', '#ff2a2e36, \\\n  '));
    write(path.join(d.config, 'qt5ct', 'qt5ct.conf'), `[Appearance]\ncustom_palette=true ; set by qt5ct\ncolor_scheme_path=${scheme} ; picked by hand\n`);
    const reading = await readLinuxColors(d.env, d.home);
    expect(reading.colors.palettes.dark!.seeds).toMatchObject({ background: '#1e2028', panel: '#262a33' });
  });

  it.skipIf(process.platform === 'win32')('never opens a scheme path that is a device or a FIFO', async () => {
    const d = desktop({ QT_QPA_PLATFORMTHEME: 'qt5ct' });
    const conf = path.join(d.config, 'qt5ct', 'qt5ct.conf');
    write(conf, '[Appearance]\ncustom_palette=true\ncolor_scheme_path=/dev/zero\n');
    const device = await readLinuxColors(d.env, d.home);
    expect(device.colors).toEqual({ palettes: {} });
    expect(device.notes[0]).toContain('/dev/zero is not a regular file');
    // a FIFO with no writer would hold a blocking open forever
    const fifo = path.join(d.root, 'scheme.fifo');
    execFileSync('mkfifo', [fifo]);
    write(conf, `[Appearance]\ncustom_palette=true\ncolor_scheme_path=${fifo}\n`);
    const reading = await readLinuxColors(d.env, d.home);
    expect(reading.colors).toEqual({ palettes: {} });
    expect(reading.notes[0]).toContain(`${fifo} is not a regular file`);
  });
});

type WatchEvent = 'create' | 'change' | 'delete';

/** A watch factory that records each watch and hands its events out; `started` runs as each watch starts. */
function fakeWatches(started: (base: string, glob: string) => void = () => undefined) {
  const watches: Array<{ base: string; glob: string; disposed: boolean; fire: (event: WatchEvent) => void; change: () => void }> = [];
  const watch = (base: string, glob: string): FileWatcher => {
    const listeners: Record<WatchEvent, Array<(fsPath: string) => void>> = { create: [], change: [], delete: [] };
    const entry = {
      base, glob, disposed: false,
      fire: (event: WatchEvent) => { for (const cb of listeners[event]) cb(path.join(base, glob)); },
      change: () => entry.fire('change'),
    };
    watches.push(entry);
    started(base, glob);
    const on = (event: WatchEvent) => (cb: (fsPath: string) => void) => {
      listeners[event].push(cb);
      return { dispose: () => undefined };
    };
    return { ready: Promise.resolve(), onDidCreate: on('create'), onDidChange: on('change'), onDidDelete: on('delete'), dispose: () => void (entry.disposed = true) };
  };
  return { watches, watch };
}

const until = async (check: () => boolean): Promise<void> => {
  for (let waited = 0; !check(); waited += 20) {
    if (waited > 5_000) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('LinuxDesktopColors', () => {
  it('reads again after a change, tells its listeners and the log only of what changed, and watches the scheme a new path names', async () => {
    const d = desktop({ QT_QPA_PLATFORMTHEME: 'qt5ct' });
    const conf = path.join(d.config, 'qt5ct', 'qt5ct.conf');
    const [first, second] = [path.join(d.root, 'a', 'one.conf'), path.join(d.root, 'b', 'two.conf')];
    write(first, qtScheme('#ff1e2028'));
    write(second, qtScheme('#ff101010'));
    write(conf, `[Appearance]\ncustom_palette=true\ncolor_scheme_path=${first}\n`);
    const { watches, watch } = fakeWatches();
    const lines: string[] = [];
    const colors = new LinuxDesktopColors({ env: d.env, home: d.home, watch, log: (line) => lines.push(line) });
    let changes = 0;
    colors.onDidChange(() => changes++);
    await colors.load();
    expect(colors.current().palettes.dark!.seeds.background).toBe('#1e2028');
    expect(watches.map(({ base, glob }) => [base, glob])).toEqual([[d.config, 'qt5ct/qt5ct.conf'], [path.dirname(first), 'one.conf']]);
    expect(lines).toEqual([`[themes] System colors follows the qt5ct palette ${first}`]);

    // an unchanged file: no change, and nothing logged again
    colors.reread();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect([changes, lines.length]).toEqual([1, 1]);

    write(conf, `[Appearance]\ncustom_palette=true\ncolor_scheme_path=${second}\n`);
    watches[0]!.change();
    await until(() => changes === 2);
    expect(colors.current().palettes.dark!.seeds.background).toBe('#101010');
    expect(watches.map(({ base, glob, disposed }) => [base, glob, disposed])).toEqual([[d.config, 'qt5ct/qt5ct.conf', false], [path.dirname(first), 'one.conf', true], [path.dirname(second), 'two.conf', false]]);
    expect(lines).toEqual([`[themes] System colors follows the qt5ct palette ${first}`, `[themes] System colors follows the qt5ct palette ${second}`]);

    colors.dispose();
    expect(watches.every((entry) => entry.disposed)).toBe(true);
  });

  it('reads again when a watched file appears or goes away', async () => {
    const d = desktop(KDE);
    const file = path.join(d.config, 'kdeglobals');
    const { watches, watch } = fakeWatches();
    const colors = new LinuxDesktopColors({ env: d.env, home: d.home, watch, log: () => undefined });
    let changes = 0;
    colors.onDidChange(() => changes++);
    await colors.load();
    expect(colors.current().palettes.light!.seeds).toEqual(BREEZE_SEEDS);
    const own = watches.find((entry) => entry.base === d.config)!;
    write(file, kdeScheme('30,32,40'));
    own.fire('create');
    await until(() => changes === 2);
    expect(colors.current().palettes.dark!.seeds.background).toBe('#1e2028');
    fs.rmSync(file);
    own.fire('delete');
    await until(() => changes === 3);
    expect(colors.current().palettes.light!.seeds).toEqual(BREEZE_SEEDS);
    colors.dispose();
  });

  it('watches each file before reading it, so a change made between the read and the watch is not lost', async () => {
    const d = desktop(KDE);
    const file = path.join(d.config, 'kdeglobals');
    write(file, kdeScheme('30,32,40'));
    // the file changes as its watch starts, which the fake reports as no event
    const { watch } = fakeWatches((base) => {
      if (base === d.config) write(file, kdeScheme('20,22,30'));
    });
    const colors = new LinuxDesktopColors({ env: d.env, home: d.home, watch, log: () => undefined });
    await colors.load();
    expect(colors.current().palettes.dark!.seeds.background).toBe('#14161e');
    colors.dispose();
  });

  it('reads once more after a read that a change interrupted', async () => {
    const d = desktop({ QT_QPA_PLATFORMTHEME: 'qt5ct' });
    const conf = path.join(d.config, 'qt5ct', 'qt5ct.conf');
    const [first, second] = [path.join(d.root, 'a', 'one.conf'), path.join(d.root, 'b', 'two.conf')];
    write(first, qtScheme('#ff1e2028'));
    write(second, qtScheme('#ff101010'));
    write(conf, `[Appearance]\ncustom_palette=true\ncolor_scheme_path=${first}\n`);
    // between the conf's read and the scheme's, the conf names another scheme and a read is asked for
    const { watch } = fakeWatches((_base, glob) => {
      if (glob !== 'one.conf') return;
      write(conf, `[Appearance]\ncustom_palette=true\ncolor_scheme_path=${second}\n`);
      void colors.load();
    });
    const colors = new LinuxDesktopColors({ env: d.env, home: d.home, watch, log: () => undefined });
    const seen: string[] = [];
    colors.onDidChange(() => seen.push(colors.current().palettes.dark!.seeds.background!));
    await colors.load();
    expect(seen).toEqual(['#1e2028', '#101010']);
    colors.dispose();
  });

  it('starts no watch and tells nothing when disposed during a read', async () => {
    const d = desktop({ QT_QPA_PLATFORMTHEME: 'qt5ct' });
    const scheme = path.join(d.root, 'mine.conf');
    write(scheme, qtScheme('#ff1e2028'));
    write(path.join(d.config, 'qt5ct', 'qt5ct.conf'), `[Appearance]\ncustom_palette=true\ncolor_scheme_path=${scheme}\n`);
    const { watches, watch } = fakeWatches();
    const lines: string[] = [];
    const colors = new LinuxDesktopColors({ env: d.env, home: d.home, watch, log: (line) => lines.push(line) });
    let changes = 0;
    colors.onDidChange(() => changes++);
    const loading = colors.load();
    colors.dispose();
    await loading;
    expect(watches.filter((entry) => !entry.disposed)).toEqual([]);
    expect([changes, lines, colors.current()]).toEqual([0, [], { palettes: {} }]);
  });

  it('logs a listener that throws, and still tells the others', async () => {
    const d = desktop(KDE);
    const lines: string[] = [];
    const colors = new LinuxDesktopColors({ env: d.env, home: d.home, watch: fakeWatches().watch, log: (line) => lines.push(line) });
    colors.onDidChange(() => {
      throw new Error('listener broke');
    });
    let told = 0;
    colors.onDidChange(() => told++);
    await colors.load();
    expect(told).toBe(1);
    expect(lines).toContain('[themes] a listener of the desktop colors failed: listener broke');
    colors.dispose();
  });

  it('logs a watch that cannot start once per file, and tries it again at each read', async () => {
    const d = desktop(KDE);
    const lines: string[] = [];
    const { watch } = fakeWatches();
    let attempts = 0;
    const colors = new LinuxDesktopColors({
      env: d.env, home: d.home, log: (line) => lines.push(line),
      watch: (base, glob) => {
        if (base !== d.config) return watch(base, glob);
        attempts++;
        throw new Error('no inotify watches left');
      },
    });
    await colors.load();
    colors.reread();
    await until(() => attempts === 2);
    await colors.load();
    expect(lines.filter((line) => line.includes('could not watch'))).toEqual([`[themes] System colors could not watch ${path.join(d.config, 'kdeglobals')}: no inotify watches left`]);
    colors.dispose();
  });

  it('feeds System colors its palettes, and the accent the OS reports before its own default', async () => {
    const d = desktop({ XDG_CURRENT_DESKTOP: 'GNOME' });
    const { watches, watch } = fakeWatches();
    const machine = { accent: '' };
    const accentChanged = new Set<() => void>();
    const updated = new Set<() => void>();
    const source = new SystemColorSource({
      platform: 'linux',
      systemPreferences: {
        getAccentColor: () => machine.accent, getColor: () => '', getSystemColor: () => '',
        on: (_event, listener) => accentChanged.add(listener), removeListener: (_event, listener) => accentChanged.delete(listener),
        subscribeNotification: () => 0, unsubscribeNotification: () => undefined,
      },
      nativeTheme: { shouldUseDarkColors: true, on: (_event, listener) => updated.add(listener), removeListener: (_event, listener) => updated.delete(listener) },
      log: () => undefined,
      desktop: new LinuxDesktopColors({ env: d.env, home: d.home, watch, log: () => undefined }),
    });
    await source.load();
    const { palettes } = (await readLinuxColors(d.env, d.home)).colors;
    expect(source.theme()).toEqual(systemTheme({ accent: '#3584e4', palettes }));
    expect(updated.size).toBe(1);

    machine.accent = 'e62d42ff';
    for (const listener of accentChanged) listener();
    expect(source.theme()).toEqual(systemTheme({ accent: '#e62d42ff', palettes }));

    // a gtk.css accent comes before the portal's
    write(path.join(d.config, 'gtk-4.0', 'gtk.css'), '@define-color accent_bg_color #2190a4;\n');
    let changed = false;
    source.onDidChange(() => (changed = true));
    for (const listener of updated) listener();
    await until(() => changed);
    expect(source.theme().looks.dark!.colors.accent).toBe('#2190a4');

    source.dispose();
    expect([updated.size, accentChanged.size]).toEqual([0, 0]);
    expect(watches.every((entry) => entry.disposed)).toBe(true);
  });

  it.skipIf(process.platform !== 'linux')('repaints when kdeglobals is replaced by a rename, through a real watcher', async () => {
    const d = desktop(KDE);
    const file = path.join(d.config, 'kdeglobals');
    write(file, kdeScheme('30,32,40'));
    const log = (): undefined => undefined;
    const watchers = new DesktopFileWatcherFactory({ folders: () => [], onDidChange: () => ({ dispose: () => undefined }) }, log, createInProcessTreeHost(log));
    const colors = new LinuxDesktopColors({ env: d.env, home: d.home, watch: (base, glob) => watchers.watch(base, glob), log });
    try {
      await colors.load();
      expect(colors.current().palettes.dark!.seeds.background).toBe('#1e2028');
      let changes = 0;
      colors.onDidChange(() => changes++);
      // KConfig writes through a temporary file renamed over kdeglobals
      write(`${file}.new`, kdeScheme('20,22,30'));
      fs.renameSync(`${file}.new`, file);
      await until(() => changes > 0);
      expect(colors.current().palettes.dark!.seeds.background).toBe('#14161e');
    } finally {
      colors.dispose();
      await watchers.close();
    }
  });
});
