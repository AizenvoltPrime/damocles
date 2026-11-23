import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_THEME } from '../../../../shared/themes/builtin';
import { checkPalette } from '../../../../shared/themes/contrast';
import { deriveLook } from '../../../../shared/themes/derive';
import type { ThemeFile } from '../../../../shared/themes/schema';
import type { PaletteRoles } from '../../../../shared/themes/schemes';
import * as systemThemeModule from '../../../../shared/themes/system-theme';
import { systemTheme } from '../../../../shared/themes/system-theme';
import { LOOK_KINDS } from '../../../../shared/themes/tokens';
import type { DesktopColors } from '../linux-desktop-colors';
import { FIRST_DESKTOP_READ_MS, SystemColorSource, type DesktopPalettes } from '../system-colors';

vi.mock('../../../../shared/themes/system-theme', async (original) => {
  const actual = await original<typeof systemThemeModule>();
  return { ...actual, systemThemeDetails: vi.fn(actual.systemThemeDetails) };
});

// The OS color reader with Electron injected. The macOS color names and notifications are the ones the reader asks for
// here; that macOS answers them as assumed is checked on a Mac, not by this file.

const DARK = BUILTIN_THEME.looks.dark!.colors;
const LIGHT = BUILTIN_THEME.looks.light!.colors;
const OPAQUE = /^#[0-9a-f]{6}$/;

const MAC_DARK: Record<string, string> = {
  'text-background': '#1E1E1EFF', 'window-background': '#323232FF', label: '#FFFFFFD8', separator: '#FFFFFF1A', 'secondary-label': '#FFFFFF8C',
  green: '#32D74BFF', orange: '#FF9F0AFF', red: '#FF453AFF', blue: '#0A84FFFF',
};
const MAC_LIGHT: Record<string, string> = {
  'text-background': '#FFFFFFFF', 'window-background': '#ECECECFF', label: '#000000D8', separator: '#0000001A', 'secondary-label': '#0000007F',
  green: '#28CD41FF', orange: '#FF9500FF', red: '#FF3B30FF', blue: '#007AFFFF',
};

/** A Linux desktop's palettes whose first read finishes when `load` does, and whose change the test announces. */
function fakeDesktop(load: () => Promise<void> = async () => undefined) {
  const listeners = new Set<() => void>();
  const state = { colors: { palettes: {} } as DesktopColors, rereads: 0, disposed: 0 };
  const desktop: DesktopPalettes = {
    current: () => state.colors,
    load,
    reread: () => void state.rereads++,
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose: () => void state.disposed++,
  };
  return { desktop, state, listeners, changed: () => { for (const listener of [...listeners]) listener(); } };
}

const DESKTOP_DARK: PaletteRoles = { kind: 'dark', seeds: { background: '#101418', panel: '#1b2026', text: '#f2f2f2' }, tokens: {} };

function fakeElectron(platform: NodeJS.Platform, start: { accent?: string; dark?: boolean; desktop?: DesktopPalettes } = {}) {
  const os = { accent: start.accent ?? '', dark: start.dark ?? true, colors: { dark: { ...MAC_DARK }, light: { ...MAC_LIGHT } }, throws: new Set<string>() };
  // one of: 'accent', a color name, or a notification name whose subscription fails
  const calls: string[] = [];
  const accentListeners = new Set<() => void>();
  const updatedListeners = new Set<() => void>();
  const notifications = new Map<number, { event: string; callback: () => void }>();
  let nextId = 1;
  const color = (call: string, name: string): string => {
    calls.push(`${call}:${name}`);
    if (os.throws.has(name)) throw new Error(`unknown color ${name}`);
    return os.colors[os.dark ? 'dark' : 'light'][name] ?? '';
  };
  const lines: string[] = [];
  const source = new SystemColorSource({
    platform,
    systemPreferences: {
      getAccentColor: () => {
        calls.push('getAccentColor');
        if (os.throws.has('accent')) throw new Error('no accent');
        return os.accent;
      },
      getColor: (name) => color('getColor', name),
      getSystemColor: (name) => color('getSystemColor', name),
      on: (_event, listener) => accentListeners.add(listener),
      removeListener: (_event, listener) => accentListeners.delete(listener),
      subscribeNotification: (event, callback) => {
        if (os.throws.has(event)) throw new Error(`cannot subscribe to ${event}`);
        notifications.set(nextId, { event, callback });
        return nextId++;
      },
      unsubscribeNotification: (id) => void notifications.delete(id),
    },
    nativeTheme: {
      get shouldUseDarkColors() {
        return os.dark;
      },
      on: (_event, listener) => updatedListeners.add(listener),
      removeListener: (_event, listener) => updatedListeners.delete(listener),
    },
    log: (line) => lines.push(line),
    ...(start.desktop ? { desktop: start.desktop } : {}),
  });
  let changes = 0;
  source.onDidChange(() => changes++);
  return {
    source, os, calls, lines,
    // the first read is a change from the Damocles seeds; the tests count the changes after it
    load: async (): Promise<void> => {
      await source.load();
      changes = 0;
    },
    changes: () => changes,
    accentChanged: () => { for (const listener of [...accentListeners]) listener(); },
    updated: () => { for (const listener of [...updatedListeners]) listener(); },
    notify: (event: string) => { for (const entry of [...notifications.values()]) if (entry.event === event) entry.callback(); },
    notificationNames: () => [...notifications.values()].map((entry) => entry.event).sort(),
    listening: () => accentListeners.size + updatedListeners.size + notifications.size,
  };
}

const colorsOf = (theme: ThemeFile) => ({ dark: theme.looks.dark!.colors, light: theme.looks.light!.colors });

function expectAa(theme: ThemeFile): void {
  for (const kind of LOOK_KINDS) {
    const look = theme.looks[kind]!;
    expect(checkPalette(deriveLook(look.colors, kind, look.tokens), kind).filter((issue) => issue.severity === 'error'), kind).toEqual([]);
  }
}

describe.each(['win32', 'linux'] as const)('SystemColorSource on %s', (platform) => {
  it('is the Damocles seeds until it loads, then the Damocles seeds with the OS accent', async () => {
    const e = fakeElectron(platform, { accent: '0078d4ff' });
    expect(e.source.theme()).toEqual(systemTheme({}));
    await e.load();
    expect(e.source.theme()).toMatchObject({ id: 'damocles-system', name: 'System colors' });
    expect(colorsOf(e.source.theme())).toEqual({ dark: { ...DARK, accent: '#0078d4' }, light: { ...LIGHT, accent: '#0078d4' } });
    expectAa(e.source.theme());
    // the accent is all these platforms give; the macOS reads answer legacy or no colors there
    expect([...new Set(e.calls)]).toEqual(['getAccentColor']);
    expect(e.notificationNames()).toEqual([]);
  });

  it('reads the accent again on accent-color-changed, and fires only when the theme changed', async () => {
    const e = fakeElectron(platform, { accent: '0078d4ff' });
    await e.load();
    const first = e.source.theme();
    e.accentChanged();
    expect(e.changes()).toBe(0);
    expect(e.source.theme()).toBe(first);

    e.os.accent = 'e81123ff';
    e.accentChanged();
    expect(e.changes()).toBe(1);
    expect(colorsOf(e.source.theme()).dark.accent).toBe('#e81123');
    expect(colorsOf(e.source.theme()).light.accent).toBe('#e81123');
    e.accentChanged();
    expect(e.changes()).toBe(1);
  });

  it('follows no dark or light switch: the accent is the same in both looks', async () => {
    const e = fakeElectron(platform, { accent: '0078d4ff' });
    await e.load();
    const reads = e.calls.length;
    e.os.dark = false;
    e.updated();
    expect(e.calls.length).toBe(reads);
    expect(e.changes()).toBe(0);
  });

  it.each(['', 'not a color', '12345', 'zzzzzzzz'])('reads the accent %j as no accent', async (accent) => {
    const e = fakeElectron(platform, { accent });
    await e.load();
    expect(e.source.theme()).toEqual(systemTheme({}));
  });

  it('reads an accent that throws as no accent, and logs it once', async () => {
    const e = fakeElectron(platform, { accent: '0078d4ff' });
    e.os.throws.add('accent');
    await e.load();
    e.accentChanged();
    e.accentChanged();
    expect(e.source.theme()).toEqual(systemTheme({}));
    expect(e.lines.filter((line) => line.includes('no accent'))).toHaveLength(1);
  });

  it('reads an accent answered as no string as no accent, and logs it', async () => {
    const e = fakeElectron(platform);
    e.os.accent = undefined as unknown as string;
    await e.load();
    expect(e.source.theme()).toEqual(systemTheme({}));
    expect(e.lines).toEqual(["[themes] the accent color is not a color: undefined, so System colors uses Damocles' own"]);
  });

  it('reads a fully transparent accent as no accent', async () => {
    const e = fakeElectron(platform, { accent: '0078d400' });
    await e.load();
    expect(e.source.theme()).toEqual(systemTheme({}));
  });

  it('logs a listener that throws, and still tells the others', async () => {
    const e = fakeElectron(platform, { accent: '0078d4ff' });
    await e.load();
    e.source.onDidChange(() => {
      throw new Error('listener broke');
    });
    let told = 0;
    e.source.onDidChange(() => told++);
    e.os.accent = 'e81123ff';
    e.accentChanged();
    expect([e.changes(), told]).toEqual([1, 1]);
    expect(e.lines).toContain('[themes] a listener of the system colors failed: listener broke');
  });

  it('builds the theme again only when what it is built from changed', async () => {
    const e = fakeElectron(platform, { accent: '0078d4ff' });
    await e.load();
    const built = vi.mocked(systemThemeModule.systemThemeDetails).mock.calls.length;
    e.accentChanged();
    e.accentChanged();
    expect(vi.mocked(systemThemeModule.systemThemeDetails).mock.calls.length).toBe(built);
    e.os.accent = 'e81123ff';
    e.accentChanged();
    expect(vi.mocked(systemThemeModule.systemThemeDetails).mock.calls.length).toBe(built + 1);
  });

  it('goes back to the Damocles accent when the OS accent goes away', async () => {
    const e = fakeElectron(platform, { accent: '0078d4ff' });
    await e.load();
    e.os.accent = '';
    e.accentChanged();
    expect(e.changes()).toBe(1);
    expect(e.source.theme()).toEqual(systemTheme({}));
  });

  it('stays at AA for a yellow, a near-white and a near-black accent', async () => {
    for (const accent of ['ffe100ff', 'fdfdfdff', '020202ff']) {
      const e = fakeElectron(platform, { accent });
      await e.load();
      expectAa(e.source.theme());
    }
  });

  it('reports the stand-in colors until they are given back', async () => {
    const e = fakeElectron(platform, { accent: '0078d4ff' });
    await e.load();
    e.source.override({ accent: '#ff0000' });
    expect(e.changes()).toBe(1);
    expect(colorsOf(e.source.theme()).dark.accent).toBe('#ff0000');
    // the OS changes underneath, and the stand-in still decides
    e.os.accent = 'e81123ff';
    e.accentChanged();
    expect(e.changes()).toBe(1);
    expect(colorsOf(e.source.theme()).dark.accent).toBe('#ff0000');
    e.source.override(undefined);
    expect(e.changes()).toBe(2);
    expect(colorsOf(e.source.theme()).dark.accent).toBe('#e81123');
  });

  it('listens to nothing and fires nothing once disposed', async () => {
    const e = fakeElectron(platform, { accent: '0078d4ff' });
    await e.load();
    expect(e.listening()).toBeGreaterThan(0);
    e.source.dispose();
    expect(e.listening()).toBe(0);
    e.os.accent = 'e81123ff';
    e.accentChanged();
    expect(e.changes()).toBe(0);
  });
});

describe('SystemColorSource on darwin', () => {
  const MAC_READS = [
    'getAccentColor', 'getColor:label', 'getColor:secondary-label', 'getColor:separator', 'getColor:text-background', 'getColor:window-background',
    'getSystemColor:blue', 'getSystemColor:green', 'getSystemColor:orange', 'getSystemColor:red',
  ];

  it('reads the semantic colors of the appearance in effect, flattened, and gives the other kind the Damocles seeds with the accent', async () => {
    const e = fakeElectron('darwin', { accent: 'bf5af2ff', dark: true });
    await e.load();
    expect([...new Set(e.calls)].sort()).toEqual(MAC_READS);
    const { dark, light } = colorsOf(e.source.theme());
    expect(dark).toEqual({ background: '#1e1e1e', panel: '#323232', text: '#dddddd', accent: '#bf5af2', success: '#32d74b', warning: '#ff9f0a', danger: '#ff453a', info: '#0a84ff' });
    expect(light).toEqual({ ...LIGHT, accent: '#bf5af2' });
    for (const value of Object.values(e.source.theme().looks.dark!.tokens ?? {})) expect(value).toMatch(OPAQUE);
    expectAa(e.source.theme());
    expect(e.notificationNames()).toEqual(['AppleColorPreferencesChangedNotification', 'AppleInterfaceThemeChangedNotification']);
  });

  it('keeps each kind it has read, so a switch back needs no colors it cannot read', async () => {
    const e = fakeElectron('darwin', { accent: 'bf5af2ff', dark: true });
    await e.load();
    e.os.dark = false;
    e.updated();
    expect(e.changes()).toBe(1);
    const both = colorsOf(e.source.theme());
    // macOS's light green is below 3:1 on white, so it shows darker
    expect(both.light).toMatchObject({ background: '#ffffff', panel: '#ececec', info: '#007aff' });
    // the dark colors are the ones read while the appearance was dark
    expect(both.dark).toMatchObject({ background: '#1e1e1e', panel: '#323232', success: '#32d74b' });
    expectAa(e.source.theme());
  });

  // Main writes nativeTheme.themeSource for the look it shows, which fires `updated` again.
  it('settles after one re-read when its own change makes main write themeSource', async () => {
    const e = fakeElectron('darwin', { accent: 'bf5af2ff', dark: true });
    await e.load();
    let rounds = 0;
    e.source.onDidChange(() => {
      if (++rounds > 20) throw new Error('the themeSource write and the re-read never settle');
      e.updated();
    });
    e.os.dark = false;
    e.calls.length = 0;
    e.updated();
    expect(rounds).toBe(1);
    expect(e.changes()).toBe(1);
    // the change's own read, then the one read main's themeSource write causes
    expect(e.calls.filter((call) => call === 'getColor:text-background')).toHaveLength(2);
  });

  it('fires nothing for an update or a notification that changes no color', async () => {
    const e = fakeElectron('darwin', { accent: 'bf5af2ff' });
    await e.load();
    const first = e.source.theme();
    e.updated();
    e.notify('AppleColorPreferencesChangedNotification');
    e.notify('AppleInterfaceThemeChangedNotification');
    expect(e.changes()).toBe(0);
    expect(e.source.theme()).toBe(first);
  });

  it.each(['AppleColorPreferencesChangedNotification', 'AppleInterfaceThemeChangedNotification'])('reads again on %s', async (event) => {
    const e = fakeElectron('darwin', { accent: 'bf5af2ff' });
    await e.load();
    e.os.accent = 'ff9f0aff';
    e.os.colors.dark['green'] = '#00FF00FF';
    e.notify(event);
    expect(e.changes()).toBe(1);
    expect(colorsOf(e.source.theme()).dark).toMatchObject({ accent: '#ff9f0a', success: '#00ff00' });
    expect(colorsOf(e.source.theme()).light.accent).toBe(systemTheme({ accent: '#ff9f0a' }).looks.light!.colors.accent);
  });

  it('fills a role macOS does not answer, or answers with no color, from the Damocles seed', async () => {
    const e = fakeElectron('darwin', { accent: 'bf5af2ff' });
    e.os.throws.add('window-background');
    e.os.throws.add('separator');
    e.os.colors.dark['green'] = '';
    e.os.colors.dark['label'] = 'labelColor';
    await e.load();
    expect(colorsOf(e.source.theme()).dark).toEqual({ background: '#1e1e1e', panel: DARK.panel, text: DARK.text, accent: '#bf5af2', success: DARK.success, warning: '#ff9f0a', danger: '#ff453a', info: '#0a84ff' });
    expect(e.source.theme().looks.dark!.tokens?.['--d-border']).toBeUndefined();
    expectAa(e.source.theme());
    expect(e.lines.join('\n')).toContain('window-background');
  });

  it('still reads the colors and follows nativeTheme when a notification cannot be subscribed to', async () => {
    const e = fakeElectron('darwin', { accent: 'bf5af2ff' });
    e.os.throws.add('AppleColorPreferencesChangedNotification');
    await e.load();
    expect(colorsOf(e.source.theme()).dark).toMatchObject({ background: '#1e1e1e', accent: '#bf5af2' });
    expect(e.lines.join(' ')).toContain('AppleColorPreferencesChangedNotification');
    expect(e.notificationNames()).toEqual(['AppleInterfaceThemeChangedNotification']);
    e.os.dark = false;
    e.updated();
    expect(e.changes()).toBe(1);
  });

  it('is the Damocles seeds when every read fails', async () => {
    const e = fakeElectron('darwin');
    for (const name of ['accent', ...Object.keys(MAC_DARK)]) e.os.throws.add(name);
    await e.load();
    expect(e.source.theme()).toEqual(systemTheme({}));
  });

  it('keeps no colors macOS answers of the other kind than nativeTheme reports', async () => {
    const e = fakeElectron('darwin', { accent: 'fdfdfdff', dark: true });
    // a light appearance's colors while nativeTheme says dark
    e.os.colors.dark = { ...MAC_LIGHT, label: '#FFFFFF10', 'secondary-label': '#FFFFFF05' };
    await e.load();
    expect(e.source.theme()).toEqual(systemTheme({ accent: '#fdfdfd' }));
    expectAa(e.source.theme());
  });

  it('keeps the colors under the kind nativeTheme reports when the text background cannot be read', async () => {
    const e = fakeElectron('darwin', { accent: 'bf5af2ff', dark: true });
    e.os.throws.add('text-background');
    await e.load();
    expect(colorsOf(e.source.theme()).dark).toMatchObject({ background: DARK.background, panel: '#323232', success: '#32d74b' });
  });

  it('reads a fully transparent label color as no color', async () => {
    const e = fakeElectron('darwin', { accent: 'bf5af2ff', dark: true });
    e.os.colors.dark['label'] = '#FFFFFF00';
    await e.load();
    expect(colorsOf(e.source.theme()).dark).toMatchObject({ background: '#1e1e1e', text: DARK.text });
  });

  it('listens to nothing once disposed', async () => {
    const e = fakeElectron('darwin', { accent: 'bf5af2ff' });
    await e.load();
    e.source.dispose();
    expect(e.listening()).toBe(0);
    e.os.dark = false;
    e.updated();
    expect(e.changes()).toBe(0);
  });
});

describe('SystemColorSource with a Linux desktop', () => {
  it(`waits ${FIRST_DESKTOP_READ_MS} ms at most for the desktop's first read, and shows its colors when they come`, async () => {
    vi.useFakeTimers();
    try {
      const d = fakeDesktop(() => new Promise<void>(() => undefined));
      const e = fakeElectron('linux', { accent: '0078d4ff', desktop: d.desktop });
      let loaded = false;
      void e.source.load().then(() => (loaded = true));
      await vi.advanceTimersByTimeAsync(FIRST_DESKTOP_READ_MS - 1);
      expect(loaded).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(loaded).toBe(true);
      expect(e.source.theme()).toEqual(systemTheme({ accent: '#0078d4' }));
      d.state.colors = { palettes: { dark: DESKTOP_DARK } };
      d.changed();
      expect(e.source.theme()).toEqual(systemTheme({ accent: '#0078d4', palettes: { dark: DESKTOP_DARK } }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the desktop's files and the accent again on nativeTheme's updated", async () => {
    const d = fakeDesktop();
    const e = fakeElectron('linux', { accent: '0078d4ff', desktop: d.desktop });
    await e.load();
    e.os.accent = 'e81123ff';
    e.updated();
    expect(d.state.rereads).toBe(1);
    expect(colorsOf(e.source.theme()).dark.accent).toBe('#e81123');
  });

  it('logs once per change a kind whose palette it does not show as given, and why', async () => {
    const d = fakeDesktop();
    const lightAsDark: PaletteRoles = { kind: 'dark', seeds: { background: '#ffffff', panel: '#ececec', text: '#000000' }, tokens: {} };
    d.state.colors = { palettes: { dark: lightAsDark } };
    const e = fakeElectron('linux', { desktop: d.desktop });
    await e.load();
    const said = "[themes] System colors takes only the tones of the desktop's dark palette, since its background is of the other kind";
    expect(e.lines).toEqual([said]);
    e.accentChanged();
    expect(e.lines).toEqual([said]);
    d.state.colors = { palettes: { dark: { ...lightAsDark, seeds: { background: '#6e6e6e', panel: '#808080', text: '#7a7a7a' } } } };
    d.changed();
    expect(e.lines).toEqual([said, "[themes] System colors shows Damocles' own dark colors with the accent, since the desktop's dark palette cannot keep text at 4.5:1 and fills at 3:1"]);
  });

  it('subscribes to nothing and reads nothing when disposed during its first read', async () => {
    let finish!: () => void;
    const d = fakeDesktop(() => new Promise<void>((resolve) => (finish = resolve)));
    const e = fakeElectron('linux', { accent: '0078d4ff', desktop: d.desktop });
    const loading = e.source.load();
    e.source.dispose();
    d.state.colors = { palettes: { dark: DESKTOP_DARK } };
    finish();
    await loading;
    expect([e.listening(), d.listeners.size, d.state.disposed]).toEqual([0, 0, 1]);
    expect(e.calls).toEqual([]);
    expect(e.source.theme()).toEqual(systemTheme({}));
  });
});
