import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_PALETTES } from '../../../shared/themes/builtin';
import type { LookColors, ThemeFile } from '../../../shared/themes/schema';
import type { FlashRecord } from '../../../shared/themes/wallpapers';
import type { LibraryEntry, ThemeLibrary } from '../themes/theme-files';
import { transientPreviewOf } from '../themes/appearance';

const H = vi.hoisted(() => ({
  native: { themeSource: 'system', shouldUseDarkColors: true, inForcedColorsMode: false, prefersReducedTransparency: false, on: vi.fn(), off: vi.fn() },
}));
vi.mock('electron', () => ({ nativeTheme: H.native }));

const BEFORE_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const AFTER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const SHOWN_ID = '9c9e6679-7425-40de-944b-e07fc1f90ae7';
const COLORS: LookColors = { background: '#1a1033', panel: '#22163f', text: '#f0e8ff', accent: '#ff7ad9', success: '#5be3a0', warning: '#ffc857', danger: '#ff6b6b', info: '#8fb8ff' };
const OTHER: LookColors = { ...COLORS, background: '#0c1a26', panel: '#132434', text: '#e6f2ff' };
const THIRD: LookColors = { ...COLORS, background: '#201405', panel: '#2b1c0a', text: '#fff1dc' };
const VIDEO = 'a'.repeat(64);
const OLD_WALL = 'b'.repeat(64);
const OLD_FONT = 'c'.repeat(64);
const OLD_SPRITE = 'd'.repeat(64);
const TOUCH_WALL = 'e'.repeat(64);

const theme = (id: string, colors: LookColors, more: Partial<ThemeFile> = {}): ThemeFile => ({ schemaVersion: 1, id, name: id.slice(0, 4), looks: { dark: { colors } }, ...more });
const ok = (file: ThemeFile): LibraryEntry => ({ status: 'ok', id: file.id, builtin: false, theme: file });

function library(...files: ThemeFile[]): ThemeLibrary {
  const entries = new Map(files.map((file) => [file.id, ok(file)]));
  return { entry: (id: string) => entries.get(id), entries: () => entries, onDidChange: () => ({ dispose: () => undefined }) } as unknown as ThemeLibrary;
}

const settings = (values: Record<string, unknown>) => ({ get: <T>(key: string): T | undefined => values[key] as T | undefined, onDidChange: () => ({ dispose: () => undefined }) });

// theme.ts keeps the shown look in module state, so each test reads a fresh copy
async function freshTheme(): Promise<typeof import('../theme')> {
  vi.resetModules();
  return import('../theme');
}

beforeEach(() => {
  H.native.themeSource = 'system';
  H.native.shouldUseDarkColors = true;
  H.native.inForcedColorsMode = false;
});

describe('trusted UI during a keep-changes countdown', () => {
  it('keeps the look from before the change while a transient preview paints the window', async () => {
    const t = await freshTheme();
    t.followThemeSettings(settings({ 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': AFTER_ID }), library(theme(BEFORE_ID, COLORS), theme(AFTER_ID, OTHER)));
    const after = t.currentTheme('root').trustedCss;
    t.setHeldLook({ look: { preferred: { dark: BEFORE_ID }, themes: new Map() }, scope: 'trusted' });
    const before = t.currentTheme('root').trustedCss;
    expect(before).not.toBe(after);

    t.setThemePreview({ themeId: SHOWN_ID, kind: 'dark', look: { colors: THIRD } });
    expect(t.currentShown().decidedBy).toBe('preview');
    expect(t.currentTheme('root').trustedCss).toBe(before);
    expect(t.currentTheme('region').trustedCss).toContain(before.slice(before.indexOf('{')));
  });
});

describe('the look held from before an unsettled change', () => {
  const NOW = Date.UTC(2026, 0, 14, 12);
  const EVERY_DAY = { enabled: true, rules: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const, minute: 0, theme: BEFORE_ID, look: 'dark' as const }] };
  const wallpapered = theme(BEFORE_ID, COLORS, {
    looks: { dark: { colors: COLORS, wallpapers: [{ panels: { chat: { asset: OLD_WALL, fit: 'fill', dim: 0.3, blur: 0 } } }] } },
    assets: { [OLD_WALL]: { kind: 'image', mime: 'image/png', bytes: 30, width: 1600, height: 1000, license: {} } },
  });

  // An on-the-fly apply with a pick over a running schedule creates the theme and writes a pick that holds over the schedule.
  it('is the look the schedule showed when the change wrote a pick over a running schedule, on the window and on trusted UI', async () => {
    const t = await freshTheme();
    t.setThemeClock(() => NOW);
    t.followThemeSettings(settings({ 'damocles.desktop.theme': 'dark' }), library(theme(BEFORE_ID, COLORS), theme(AFTER_ID, OTHER)));
    t.setAppearanceSchedule({ schedule: EVERY_DAY });
    expect(t.currentShown()).toMatchObject({ themeId: BEFORE_ID, decidedBy: 'schedule' });
    const scheduled = t.currentTheme('root').trustedCss;

    t.setAppearanceSchedule({ schedule: EVERY_DAY, override: { themeId: AFTER_ID, kind: 'dark', at: NOW } });
    expect(t.currentShown()).toMatchObject({ themeId: AFTER_ID, decidedBy: 'override' });
    const before = { preferred: {}, themes: new Map([[AFTER_ID, undefined]]), schedule: { schedule: EVERY_DAY } };

    t.setHeldLook({ look: before, scope: 'trusted' });
    expect(t.currentShown()).toMatchObject({ themeId: AFTER_ID });
    expect(t.currentTheme('root').trustedCss).toBe(scheduled);

    t.setHeldLook({ look: before, scope: 'window' });
    expect(t.currentShown()).toMatchObject({ themeId: BEFORE_ID, decidedBy: 'schedule' });
    expect(t.currentShown().fallback).toBeUndefined();
  });

  it('takes the mode from before a change that set it', async () => {
    const t = await freshTheme();
    t.followThemeSettings(settings({ 'damocles.desktop.theme': 'dark' }), library());
    t.setHeldLook({ look: { preferred: {}, themes: new Map(), mode: 'light' }, scope: 'window' });
    expect(t.currentShown()).toMatchObject({ kind: 'light', decidedBy: 'mode' });
    t.setHeldLook({ look: { preferred: {}, themes: new Map() }, scope: 'window' });
    expect(t.currentShown()).toMatchObject({ kind: 'dark' });
  });

  it('paints the wallpapers a change turned off while it holds the whole window, and not while it holds trusted UI only', async () => {
    const t = await freshTheme();
    t.followThemeSettings(settings({ 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': BEFORE_ID, 'damocles.desktop.themes.showWallpapers': false }), library(wallpapered));
    expect(t.currentWallpapers()).toBeUndefined();
    t.setHeldLook({ look: { preferred: {}, themes: new Map(), showWallpapers: true }, scope: 'window' });
    expect(t.currentWallpapers()?.regions).toHaveLength(1);
    t.setHeldLook({ look: { preferred: {}, themes: new Map(), showWallpapers: true }, scope: 'trusted' });
    expect(t.currentWallpapers()).toBeUndefined();
  });

  it('is settled once the live inputs resolve to it, which a listener of the inputs hears though the window paints the same', async () => {
    const t = await freshTheme();
    const values: Record<string, unknown> = { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': AFTER_ID, 'damocles.desktop.themes.showWallpapers': false };
    t.followThemeSettings(settings(values), library(wallpapered, theme(AFTER_ID, OTHER)));
    expect(t.heldLookSettled()).toBe(true);
    t.setHeldLook({ look: { preferred: { dark: BEFORE_ID }, themes: new Map(), showWallpapers: true }, scope: 'window' });
    expect(t.heldLookSettled()).toBe(false);
    const painted = vi.fn();
    const evaluated = vi.fn();
    t.onThemeChange(painted);
    t.onThemeInputsChange(evaluated);

    // core's revert reaches the settings one key at a time
    values['damocles.desktop.themes.dark'] = BEFORE_ID;
    t.reevaluateTheme();
    expect(t.heldLookSettled()).toBe(false);
    values['damocles.desktop.themes.showWallpapers'] = true;
    t.followThemeSettings(settings(values), library(wallpapered, theme(AFTER_ID, OTHER)));
    expect(t.heldLookSettled()).toBe(true);
    expect(evaluated).toHaveBeenCalled();
    expect(painted).not.toHaveBeenCalled();
  });
});

describe('the color a trusted view paints before its page', () => {
  it('is the built-in background when the shown palette fails a text contrast rule, and the look\'s own otherwise', async () => {
    const t = await freshTheme();
    // text barely darker than the panel, set as an Advanced override so deriving the look does not repair it
    const murky = theme(AFTER_ID, COLORS, { looks: { dark: { colors: COLORS, tokens: { '--d-text': '#2a2040' } } } });
    t.followThemeSettings(settings({ 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': AFTER_ID }), library(murky, theme(BEFORE_ID, OTHER)));
    expect(t.shownBackground()).toBe('#1a1033');
    expect(t.trustedBackground()).toBe(BUILTIN_PALETTES.dark['--d-bg']!.slice(0, 7));

    t.setHeldLook({ look: { preferred: { dark: BEFORE_ID }, themes: new Map() }, scope: 'trusted' });
    expect(t.shownBackground()).toBe('#1a1033');
    expect(t.trustedBackground()).toBe('#0c1a26');
  });

  it('stays the look from before a transient preview', async () => {
    const t = await freshTheme();
    t.followThemeSettings(settings({ 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': BEFORE_ID }), library(theme(BEFORE_ID, COLORS)));
    t.setThemePreview({ themeId: SHOWN_ID, kind: 'dark', look: { colors: THIRD } });
    expect(t.shownBackground()).toBe('#201405');
    expect(t.trustedBackground()).toBe('#1a1033');
  });
});

describe('a moving wallpaper\'s flash check', () => {
  const moving = theme(AFTER_ID, COLORS, {
    looks: { dark: { colors: COLORS, wallpapers: [{ panels: { chat: { asset: VIDEO, fit: 'fill', dim: 0.3, blur: 0 } } }] } },
    assets: { [VIDEO]: { kind: 'video', mime: 'video/mp4', bytes: 1000, width: 1920, height: 1080, durationMs: 4000, license: {} } },
  });

  it('keeps the newest read\'s answer when an older read of the same file settles after it', async () => {
    const t = await freshTheme();
    const reads: Array<(record: FlashRecord | undefined) => void> = [];
    t.setWallpaperFlashReader(() => new Promise((resolve) => { reads.push(resolve); }));
    t.followThemeSettings(settings({ 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': AFTER_ID }), library(moving));
    const playable = (): boolean | undefined => t.currentWallpapers()?.regions[0]?.moving?.playable;
    expect(playable()).toBe(false);
    expect(reads).toHaveLength(1);

    // the user allows the file: core rewrites its record and main reads it again while the first read is still out
    t.invalidateWallpaperStats();
    expect(reads).toHaveLength(2);
    reads[1]!({ flagged: true, allowed: true });
    await vi.waitFor(() => expect(playable()).toBe(true));
    reads[0]!({ flagged: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(playable()).toBe(true);
  });
});

describe('the blobs a held before-look names', () => {
  it('are named for the blob route though the theme files no longer name them', async () => {
    const t = await freshTheme();
    const now = theme(BEFORE_ID, COLORS);
    const was = theme(BEFORE_ID, COLORS, {
      style: { fonts: { ui: { asset: OLD_FONT, family: 'Old Sans' } } },
      characters: { name: 'Pals', characters: [{ name: 'Pip', states: { idle: { asset: OLD_SPRITE } } }] },
      assets: {
        [OLD_WALL]: { kind: 'image', mime: 'image/png', bytes: 30, width: 1600, height: 1000, license: {} },
        [OLD_FONT]: { kind: 'font', mime: 'font/woff2', bytes: 30, family: 'Old Sans', license: {} },
        [OLD_SPRITE]: { kind: 'sprite', mime: 'image/png', bytes: 10, width: 16, height: 16, license: {} },
      },
    });
    t.followThemeSettings(settings({ 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': BEFORE_ID }), library(now));
    expect(t.namedImageBlob(OLD_WALL)).toBeUndefined();
    expect(t.namedFontBlob(OLD_FONT)).toBeUndefined();
    expect(t.namedSpriteBlob(OLD_SPRITE)).toBeUndefined();

    const touched = { mode: 'touches' as const, wallpaper: { panels: { chat: { asset: TOUCH_WALL, fit: 'fill' as const, dim: 0.2, blur: 0 } } }, assets: { [TOUCH_WALL]: { kind: 'image' as const, mime: 'image/webp', bytes: 30, width: 800, height: 600, license: {} } } };
    t.setHeldLook({ look: { preferred: {}, themes: new Map([[BEFORE_ID, ok(was)]]), projectLooks: { 'c:/work/app': touched } }, scope: 'window' });
    expect(t.namedImageBlob(OLD_WALL)).toEqual({ kind: 'image', mime: 'image/png' });
    expect(t.namedFontBlob(OLD_FONT)).toEqual({ mime: 'font/woff2' });
    expect(t.namedSpriteBlob(OLD_SPRITE)).toEqual({ mime: 'image/png' });
    expect(t.namedImageBlob(TOUCH_WALL)).toEqual({ kind: 'image', mime: 'image/webp' });

    t.setHeldLook(undefined);
    expect(t.namedImageBlob(OLD_WALL)).toBeUndefined();
    expect(t.namedImageBlob(TOUCH_WALL)).toBeUndefined();
  });
});

describe('projectCharacter', () => {
  it("names the character a project shows as if it were selected, and what decided it: the key, a theme pin or an every-theme pin", async () => {
    const t = await freshTheme();
    const sprites = { [OLD_SPRITE]: { kind: 'sprite' as const, mime: 'image/png', bytes: 10, width: 16, height: 16, license: {} } };
    const idle = { idle: { asset: OLD_SPRITE } };
    const pals = theme(AFTER_ID, COLORS, { characters: { name: 'Pals', characters: [{ name: 'Pip', states: idle }, { name: 'Pop', states: idle }] }, assets: sprites });
    t.followThemeSettings(settings({ 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': AFTER_ID }), library(pals));
    const key = 'c:/work/app';
    expect(t.projectCharacter(key)).toMatchObject({ themeId: AFTER_ID, by: 'projectKey' });
    t.setProjectPins({ version: 1, pins: { [key]: { byTheme: { [AFTER_ID]: 'Pop' } } } });
    expect(t.projectCharacter(key)).toEqual({ themeId: AFTER_ID, character: 'Pop', by: 'themePin' });
    t.setProjectPins({ version: 1, pins: { [key]: { everyTheme: { name: 'Kept', states: idle, assets: sprites } } } });
    expect(t.projectCharacter(key)).toEqual({ themeId: AFTER_ID, character: 'Kept', by: 'everyTheme' });
    t.followThemeSettings(settings({ 'damocles.desktop.theme': 'dark' }), library(pals));
    t.setProjectPins({ version: 1, pins: {} });
    expect(t.projectCharacter(key)).toBeUndefined();
  });

  it("keys a project's characters by the theme they come from when its touches borrow another theme's set", async () => {
    const t = await freshTheme();
    const sprites = { [OLD_SPRITE]: { kind: 'sprite' as const, mime: 'image/png', bytes: 10, width: 16, height: 16, license: {} } };
    const idle = { idle: { asset: OLD_SPRITE } };
    const shownTheme = theme(SHOWN_ID, COLORS, { characters: { name: 'Own', characters: [{ name: 'Pop', states: idle }] }, assets: sprites });
    const pals = theme(AFTER_ID, OTHER, { characters: { name: 'Pals', characters: [{ name: 'Pip', states: idle }, { name: 'Pop', states: idle }] }, assets: sprites });
    t.followThemeSettings(settings({ 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': SHOWN_ID }), library(shownTheme, pals));
    const key = 'c:/work/app';
    t.setProjectLooks({ [key]: { mode: 'touches', characterSet: AFTER_ID } });
    t.setProjectPins({ version: 1, pins: { [key]: { byTheme: { [AFTER_ID]: 'Pip' } } } });
    expect(t.projectCharacter(key)).toEqual({ themeId: AFTER_ID, character: 'Pip', by: 'themePin' });
    t.setSelectedProject(key);
    expect(t.currentCharacters()?.pins[key]).toBe(0);
    // a pin of the theme on screen names a character of its own set, not of the borrowed one
    t.setProjectPins({ version: 1, pins: { [key]: { byTheme: { [SHOWN_ID]: 'Pop' } } } });
    expect(t.projectCharacter(key)).toMatchObject({ themeId: AFTER_ID, by: 'projectKey' });
    expect(t.currentCharacters()?.pins[key]).toBeUndefined();
  });
});

describe("the blobs an open theme card's theme names", () => {
  it('are served only between cardOpened and cardClosed, and none after the core that opened them ended', async () => {
    const t = await freshTheme();
    const card = theme(AFTER_ID, COLORS, {
      characters: { name: 'Pals', characters: [{ name: 'Pip', states: { idle: { asset: OLD_SPRITE } } }] },
      assets: {
        [OLD_WALL]: { kind: 'image', mime: 'image/png', bytes: 30, width: 1600, height: 1000, license: {} },
        [OLD_SPRITE]: { kind: 'sprite', mime: 'image/png', bytes: 10, width: 16, height: 16, license: {} },
      },
    });
    t.followThemeSettings(settings({ 'damocles.desktop.theme': 'dark' }), library());
    expect(t.namedSpriteBlob(OLD_SPRITE)).toBeUndefined();
    t.setCardTheme('local', 'stage-1', card);
    expect(t.namedSpriteBlob(OLD_SPRITE)).toEqual({ mime: 'image/png' });
    expect(t.namedImageBlob(OLD_WALL)).toEqual({ kind: 'image', mime: 'image/png' });
    t.setCardTheme('local', 'stage-1', undefined);
    expect(t.namedSpriteBlob(OLD_SPRITE)).toBeUndefined();
    expect(t.namedImageBlob(OLD_WALL)).toBeUndefined();
    t.setCardTheme('local', 'stage-2', card);
    t.clearCardThemes('local');
    expect(t.namedSpriteBlob(OLD_SPRITE)).toBeUndefined();
  });

  it("keeps a remote chat's draft capture past the end of this computer's core, until the capture itself ends", async () => {
    const t = await freshTheme();
    const card = theme(AFTER_ID, COLORS, {
      characters: { name: 'Pals', characters: [{ name: 'Pip', states: { idle: { asset: OLD_SPRITE } } }] },
      assets: { [OLD_SPRITE]: { kind: 'sprite', mime: 'image/png', bytes: 10, width: 16, height: 16, license: {} } },
    });
    t.followThemeSettings(settings({ 'damocles.desktop.theme': 'dark' }), library());
    t.setCardTheme('relayed', 'capture-1', card);
    // one id under each origin: the local card's end leaves the capture
    t.setCardTheme('local', 'capture-1', card);
    t.setCardTheme('local', 'capture-1', undefined);
    t.clearCardThemes('local');
    expect(t.namedSpriteBlob(OLD_SPRITE)).toEqual({ mime: 'image/png' });
    t.setCardTheme('relayed', 'capture-1', undefined);
    expect(t.namedSpriteBlob(OLD_SPRITE)).toBeUndefined();
  });
});

describe('motion before the shell page reports the OS setting', () => {
  const SPRITE = 'f'.repeat(64);
  const lively = theme(AFTER_ID, COLORS, {
    looks: { dark: { colors: COLORS, wallpapers: [{ panels: { chat: { asset: VIDEO, fit: 'fill', dim: 0.3, blur: 0 } } }] } },
    characters: { name: 'Pals', characters: [{ name: 'Pip', states: { idle: { asset: SPRITE } } }] },
    assets: {
      [VIDEO]: { kind: 'video', mime: 'video/mp4', bytes: 1000, width: 1920, height: 1080, durationMs: 4000, license: {} },
      [SPRITE]: { kind: 'sprite', mime: 'image/png', bytes: 10, width: 16, height: 16, license: {} },
    },
  });

  it('counts as reduced: wallpapers pause and characters hold still until the page says motion is allowed', async () => {
    const t = await freshTheme();
    t.followThemeSettings(settings({ 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': AFTER_ID }), library(lively));
    expect(t.currentWallpaperMotion()).toEqual({ play: false, paused: ['reduceMotion'] });
    expect(t.currentCharacters()?.motion).toBe('still');

    t.setMotionEnvironment({ osReducedMotion: false });
    expect(t.currentWallpaperMotion()).toEqual({ play: true, paused: [] });
    expect(t.currentCharacters()?.motion).toBe('always');

    t.setMotionEnvironment({ osReducedMotion: true });
    expect(t.currentWallpaperMotion().paused).toEqual(['reduceMotion']);
    expect(t.currentCharacters()?.motion).toBe('still');
  });

  it('holds the characters still under a contrast theme, though the page allows motion: those of the look that would show without it', async () => {
    const t = await freshTheme();
    t.followThemeSettings(settings({ 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': AFTER_ID }), library(lively));
    t.setMotionEnvironment({ osReducedMotion: false });
    expect(t.currentCharacters()?.motion).toBe('always');

    H.native.inForcedColorsMode = true;
    t.reevaluateTheme();
    expect(t.currentShown()).toMatchObject({ themeId: 'damocles', decidedBy: 'forcedColors' });
    expect(t.currentCharacters()?.motion).toBe('still');
    expect(t.currentCharacters()?.characters.map((character) => character.name)).toEqual(['Pip']);

    H.native.inForcedColorsMode = false;
    t.reevaluateTheme();
    expect(t.currentCharacters()?.motion).toBe('always');
  });
});

describe('the theme revision pages acknowledge', () => {
  it('bumps only when what a renderer gets changes, and every currentTheme carries it', async () => {
    const t = await freshTheme();
    t.followThemeSettings(settings({ 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': AFTER_ID }), library(theme(AFTER_ID, COLORS)));
    const first = t.currentThemeRevision();
    expect(t.currentTheme().revision).toBe(first);
    t.reevaluateTheme();
    expect(t.currentThemeRevision()).toBe(first);
    t.setThemePreview({ themeId: SHOWN_ID, kind: 'dark', look: { colors: THIRD } });
    expect(t.currentThemeRevision()).toBe(first + 1);
    expect(t.currentTheme('root').revision).toBe(first + 1);
    t.reevaluateTheme();
    expect(t.currentThemeRevision()).toBe(first + 1);
  });
});

describe("a draft capture's wallpaper records", () => {
  const draft = theme(AFTER_ID, COLORS, {
    looks: { dark: { colors: COLORS, wallpapers: [{ panels: { chat: { asset: OLD_WALL, fit: 'fill', dim: 0.1, blur: 0 } } }] } },
    assets: { [OLD_WALL]: { kind: 'image', mime: 'image/png', bytes: 30, width: 1600, height: 1000, license: {} } },
  });

  it('are read before the draft paints, so it paints once with its readable dim and no read lands after the paint', async () => {
    const t = await freshTheme();
    const reads: string[] = [];
    t.setWallpaperStatsReader(async (sha) => {
      reads.push(sha);
      return { p10: 0.2, p90: 0.9, mean: 0.5 };
    });
    t.setWallpaperFlashReader(async () => undefined);
    t.followThemeSettings(settings({ 'damocles.desktop.theme': 'dark' }), library());
    const preview = transientPreviewOf(draft, 'dark')!;
    await t.readPreviewRecords(preview);
    t.setThemePreview(preview);
    const painted = t.currentThemeRevision();
    expect(t.currentWallpapers()?.regions[0]?.dim).toBeGreaterThan(0.1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.currentThemeRevision()).toBe(painted);
    expect(reads).toEqual([OLD_WALL]);
  });
});

describe('the themes of open cards', () => {
  it('serves the blobs of at most 64 cards of one origin, the oldest card leaving first', async () => {
    const t = await freshTheme();
    t.followThemeSettings(settings({ 'damocles.desktop.theme': 'dark' }), library());
    const sprite = (index: number): string => index.toString(16).padStart(64, '0');
    const card = (index: number): ThemeFile => theme(AFTER_ID, COLORS, {
      characters: { name: 'Pals', characters: [{ name: 'Pip', states: { idle: { asset: sprite(index) } } }] },
      assets: { [sprite(index)]: { kind: 'sprite', mime: 'image/png', bytes: 10, width: 16, height: 16, license: {} } },
    });
    for (let index = 0; index < 65; index += 1) t.setCardTheme('local', `stage-${index}`, card(index));
    expect(t.namedSpriteBlob(sprite(0))).toBeUndefined();
    expect(t.namedSpriteBlob(sprite(1))).toEqual({ mime: 'image/png' });
    expect(t.namedSpriteBlob(sprite(64))).toEqual({ mime: 'image/png' });
    // a card opened again counts as the newest
    t.setCardTheme('local', 'stage-1', card(1));
    t.setCardTheme('local', 'stage-65', card(65));
    expect(t.namedSpriteBlob(sprite(1))).toEqual({ mime: 'image/png' });
    expect(t.namedSpriteBlob(sprite(2))).toBeUndefined();
  });
});
