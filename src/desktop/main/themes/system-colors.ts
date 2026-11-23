// This computer's colors as the System colors theme (docs/invariants.md "Desktop themes"): main is their only reader, and
// publishes the looks to its core. Electron is passed in, so nothing here imports it.
import type { Disposable } from '../../../platform/disposable';
import { parseHex } from '../../../shared/themes/color';
import { kindOfBackground } from '../../../shared/themes/contrast';
import type { ThemeFile } from '../../../shared/themes/schema';
import type { LookSeed, PaletteRoles } from '../../../shared/themes/schemes/palette';
import { systemTheme, systemThemeDetails, type SystemColors, type SystemFallback, type SystemLooks, type SystemThemeFile } from '../../../shared/themes/system-theme';
import type { LookKind, TokenName } from '../../../shared/themes/tokens';
import type { DesktopColors } from './linux-desktop-colors';

/** What the source calls of Electron's systemPreferences; the color and notification calls are made on macOS only. */
export interface SystemPreferencesLike {
  getAccentColor(): string;
  getColor(name: string): string;
  getSystemColor(name: string): string;
  on(event: 'accent-color-changed', listener: () => void): unknown;
  removeListener(event: 'accent-color-changed', listener: () => void): unknown;
  subscribeNotification(event: string, callback: () => void): number;
  unsubscribeNotification(id: number): void;
}

export interface NativeThemeLike {
  readonly shouldUseDarkColors: boolean;
  on(event: 'updated', listener: () => void): unknown;
  removeListener(event: 'updated', listener: () => void): unknown;
}

/** A Linux desktop's palettes (`LinuxDesktopColors`), which the source owns and disposes. */
export interface DesktopPalettes extends Disposable {
  current(): DesktopColors;
  load(): Promise<void>;
  reread(): void;
  onDidChange(listener: () => void): Disposable;
}

export interface SystemColorSourceDeps {
  readonly platform: NodeJS.Platform;
  readonly systemPreferences: SystemPreferencesLike;
  readonly nativeTheme: NativeThemeLike;
  readonly log: (line: string) => void;
  readonly desktop?: DesktopPalettes;
}

// NSColor names of systemPreferences.getColor, and the system colors of getSystemColor, by the role each fills.
const MAC_SURFACES: Readonly<Partial<Record<LookSeed, string>>> = { background: 'text-background', panel: 'window-background', text: 'label' };
const MAC_TONES: Readonly<Partial<Record<LookSeed, string>>> = { success: 'green', warning: 'orange', danger: 'red', info: 'blue' };
const MAC_TOKENS: Readonly<Partial<Record<TokenName, string>>> = { '--d-border': 'separator', '--d-muted': 'secondary-label' };
const MAC_NOTIFICATIONS = ['AppleColorPreferencesChangedNotification', 'AppleInterfaceThemeChangedNotification'] as const;

// startup waits this long for the desktop's files; a read that ends later repaints through onDidChange
export const FIRST_DESKTOP_READ_MS = 1000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Electron writes a color as `rrggbbaa` (the accent) or `#RRGGBBAA`; undefined for anything else, '' and a transparent color included.
function colorOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const hex = `#${value.replace(/^#/, '').toLowerCase()}`;
  const color = parseHex(hex);
  return color && color[3] > 0 ? hex : undefined;
}

// `promise`, or nothing once `ms` have passed
const settledWithin = (promise: Promise<void>, ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  void promise.then(() => {
    clearTimeout(timer);
    resolve();
  });
});

/**
 * Reads the accent on every platform, the semantic colors on macOS and the desktop's palettes on Linux, again whenever the OS
 * or the desktop's files say they changed, and tells its listeners only when the theme they make differs. The accent the OS
 * reports comes before the desktop's own default accent.
 */
export class SystemColorSource implements Disposable {
  private readonly deps: SystemColorSourceDeps;
  private readonly listeners = new Set<() => void>();
  private readonly subscriptions: Array<() => void> = [];
  // a role whose read failed is told once, not at every re-read
  private readonly told = new Set<string>();
  // macOS answers getColor for the app's current appearance only, so each kind keeps what was last read under it
  private palettes: Partial<Record<LookKind, PaletteRoles>> = {};
  private accent: string | undefined;
  private overridden: SystemColors | undefined;
  private current: SystemThemeFile = systemTheme({});
  private signature = JSON.stringify(this.current);
  // what the theme was last built from, so a read that changes nothing builds nothing
  private built = '';
  // the fallbacks last told, so each is told once per change
  private fallbacksTold = '';
  private disposed = false;

  constructor(deps: SystemColorSourceDeps) {
    this.deps = deps;
  }

  /** The first read, and from then on every change the OS reports; never rejects. */
  async load(): Promise<void> {
    const { systemPreferences, nativeTheme, platform, desktop } = this.deps;
    const reread = (): void => this.read();
    systemPreferences.on('accent-color-changed', reread);
    this.subscriptions.push(() => systemPreferences.removeListener('accent-color-changed', reread));
    if (desktop) {
      // a dark or light switch reads the desktop's files again too, which catches a change no watch saw
      const desktopChanged = desktop.onDidChange(reread);
      const switched = (): void => {
        desktop.reread();
        this.read();
      };
      nativeTheme.on('updated', switched);
      this.subscriptions.push(() => desktopChanged.dispose(), () => nativeTheme.removeListener('updated', switched));
    }
    if (platform === 'darwin') {
      nativeTheme.on('updated', reread);
      this.subscriptions.push(() => nativeTheme.removeListener('updated', reread));
      for (const name of MAC_NOTIFICATIONS) {
        // startup awaits load(): a notification macOS refuses costs that one trigger, and `updated` still reads again
        try {
          const id = systemPreferences.subscribeNotification(name, reread);
          this.subscriptions.push(() => systemPreferences.unsubscribeNotification(id));
        } catch (err) {
          this.deps.log(`[themes] System colors could not follow ${name}: ${errorText(err)}`);
        }
      }
    }
    if (desktop) await settledWithin(desktop.load(), FIRST_DESKTOP_READ_MS);
    this.read();
  }

  /** Reads the OS colors again now; macOS answers them for the appearance nativeTheme.themeSource sets at that moment. */
  readNow(): void {
    this.read();
  }

  theme(): ThemeFile {
    return this.current;
  }

  looks(): SystemLooks {
    return this.current.looks;
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Colors that stand in for the OS reads, for the e2e hooks; undefined gives the OS reads back. */
  override(colors: SystemColors | undefined): void {
    this.overridden = colors;
    this.apply();
  }

  dispose(): void {
    this.disposed = true;
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    this.deps.desktop?.dispose();
    this.listeners.clear();
  }

  private read(): void {
    if (this.disposed) return;
    const desktop = this.deps.desktop?.current();
    this.accent = this.call('the accent color', () => this.deps.systemPreferences.getAccentColor()) ?? desktop?.accent;
    if (desktop) this.palettes = desktop.palettes;
    if (this.deps.platform === 'darwin') {
      const shown: LookKind = this.deps.nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
      const palette = this.macPalette(shown);
      // colors read while the appearance changes may be the other kind's; those are not kept under either kind
      const background = palette.seeds.background;
      if (background === undefined || kindOfBackground(background) === shown) this.palettes = { ...this.palettes, [shown]: palette };
    }
    this.apply();
  }

  // Main's own nativeTheme.themeSource write fires `updated` too: the theme it reads then equals this one, which ends the loop.
  private apply(): void {
    const colors = this.overridden ?? { ...(this.accent !== undefined ? { accent: this.accent } : {}), palettes: this.palettes };
    const built = JSON.stringify(colors);
    if (built === this.built) return;
    this.built = built;
    const { theme: next, fallbacks } = systemThemeDetails(colors);
    this.tellFallbacks(fallbacks);
    const signature = JSON.stringify(next);
    if (signature === this.signature) return;
    this.current = next;
    this.signature = signature;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        this.deps.log(`[themes] a listener of the system colors failed: ${errorText(err)}`);
      }
    }
  }

  private macPalette(kind: LookKind): PaletteRoles {
    const { systemPreferences } = this.deps;
    const roles = <K extends string>(names: Readonly<Partial<Record<K, string>>>, read: (name: string) => string): Partial<Record<K, string>> =>
      Object.fromEntries((Object.entries(names) as [K, string][]).flatMap(([role, name]) => {
        const color = this.call(`the macOS color ${name}`, () => read(name));
        return color === undefined ? [] : [[role, color]];
      })) as Partial<Record<K, string>>;
    const getColor = (name: string): string => systemPreferences.getColor(name);
    // no accent seed: the accent is not per appearance, so the kind read earlier takes a new one too
    return { kind, seeds: { ...roles(MAC_SURFACES, getColor), ...roles(MAC_TONES, (name) => systemPreferences.getSystemColor(name)) }, tokens: roles(MAC_TOKENS, getColor) };
  }

  // One OS read as a color; a read that throws or answers no color is left out, so Damocles' own color fills its role.
  private call(what: string, read: () => string): string | undefined {
    let value: string;
    try {
      value = read();
    } catch (err) {
      this.tell(what, `could not be read: ${errorText(err)}`);
      return undefined;
    }
    const color = colorOf(value);
    // Linux without a portal accent answers ''; JSON.stringify answers undefined for undefined and a function
    if (color === undefined && value !== '') this.tell(what, `is not a color: ${String(JSON.stringify(value) ?? typeof value).slice(0, 80)}`);
    return color;
  }

  private tell(what: string, why: string): void {
    if (this.told.has(what)) return;
    this.told.add(what);
    this.deps.log(`[themes] ${what} ${why}, so System colors uses Damocles' own`);
  }

  private tellFallbacks(fallbacks: readonly SystemFallback[]): void {
    const given = this.deps.platform === 'darwin' ? "macOS's" : "the desktop's";
    const lines = fallbacks.map(({ kind, reason }) => (reason === 'otherKind'
      ? `[themes] System colors takes only the tones of ${given} ${kind} palette, since its background is of the other kind`
      : `[themes] System colors shows Damocles' own ${kind} colors with the accent, since ${given} ${kind} palette cannot keep text at 4.5:1 and fills at 3:1`));
    const said = lines.join('\n');
    if (said === this.fallbacksTold) return;
    this.fallbacksTold = said;
    for (const line of lines) this.deps.log(line);
  }
}
