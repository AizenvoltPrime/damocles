import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_PALETTES, BUILTIN_THEME } from '../../../../shared/themes/builtin';
import { checkPalette, contrast } from '../../../../shared/themes/contrast';
import type { LookColors, ThemeFile } from '../../../../shared/themes/schema';
import { resolveShown, themeSourceFor, wallpaperMotion, type AppearanceInputs, type MotionInputs } from '../appearance';
import { opaqueBackground, shownPalette, trustedCss, trustedPalette } from '../theme-css';
import { cssRefusal, readThemeFiles, themeEntry, type LibraryEntry } from '../theme-files';
import { BUILTIN_MONO_STACK, BUILTIN_UI_STACK } from '../../../../shared/themes/fonts';
import type { Weekday } from '../../../../shared/themes/schedule';

const H = vi.hoisted(() => ({
  native: { themeSource: 'system', shouldUseDarkColors: true, inForcedColorsMode: false, on: vi.fn(), off: vi.fn() },
}));
vi.mock('electron', () => ({ nativeTheme: H.native }));

const {
  currentBaseShown, currentTheme, currentThemeKind, currentWallpaperMotion, followThemeSettings, onThemeChange, reevaluateTheme, setAppearanceSchedule, setMotionEnvironment, setReportedTimeZone, setSafeStart,
  setThemeClock, setThemePreview, shownBackground, setProjectLooks, setSelectedProject, projectLookOf,
} = await import('../../theme');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const COLORS: LookColors = { background: '#1a1033', panel: '#22163f', text: '#f0e8ff', accent: '#ff7ad9', success: '#5be3a0', warning: '#ffc857', danger: '#ff6b6b', info: '#8fb8ff' };
// text barely darker than the panel: deriveLook moves --d-text to pass, so the failure is in an Advanced override
const FAILING: ThemeFile = { schemaVersion: 1, id: ID, name: 'Murky', looks: { dark: { colors: COLORS, tokens: { '--d-text': '#2a2040' } } } };
const NIGHT: ThemeFile = { schemaVersion: 1, id: ID, name: 'Night', looks: { dark: { colors: COLORS } } };
// custom CSS as core stores it: what the sanitizer kept
const STYLED: ThemeFile = { ...NIGHT, name: 'Styled', css: { transcript: 'p { color: red }', sidebar: 'li { padding: 1px }', titlebar: 'span { font-weight: 600 }' } };

const ok = (theme: ThemeFile): LibraryEntry => ({ status: 'ok', id: theme.id, builtin: false, theme });

function inputs(overrides: Partial<AppearanceInputs> & { entries?: readonly LibraryEntry[] } = {}): AppearanceInputs {
  const entries = new Map((overrides.entries ?? []).map((entry) => [entry.id, entry]));
  return {
    forcedColors: false,
    mode: 'system',
    osKind: 'dark',
    preferred: { dark: 'damocles', light: 'damocles' },
    theme: (id) => entries.get(id),
    ...overrides,
  };
}

describe('resolveShown', () => {
  it('shows the preferred look of the OS kind in System mode, and of the fixed kind otherwise', () => {
    const entries = [ok(NIGHT)];
    expect(resolveShown(inputs({ entries, preferred: { dark: ID, light: 'damocles' } }))).toMatchObject({ kind: 'dark', themeId: ID, builtin: false, decidedBy: 'system' });
    expect(resolveShown(inputs({ entries, osKind: 'light', preferred: { dark: ID, light: 'damocles' } }))).toMatchObject({ kind: 'light', themeId: 'damocles', builtin: true });
    expect(resolveShown(inputs({ entries, mode: 'dark', osKind: 'light', preferred: { dark: ID, light: 'damocles' } }))).toMatchObject({ kind: 'dark', themeId: ID, decidedBy: 'mode' });
  });

  it('falls back to the built-in look of the kind for a missing, broken, newer or lookless theme, and names why', () => {
    const preferred = { dark: ID, light: ID };
    expect(resolveShown(inputs({ preferred }))).toMatchObject({ kind: 'dark', themeId: 'damocles', builtin: true, fallback: { themeId: ID, reason: 'missing' } });
    expect(resolveShown(inputs({ preferred, entries: [{ status: 'broken', id: ID, error: 'x' }] })).fallback).toEqual({ themeId: ID, reason: 'broken' });
    expect(resolveShown(inputs({ preferred, entries: [{ status: 'needsNewer', id: ID, version: 2 }] })).fallback).toEqual({ themeId: ID, reason: 'needsNewer' });
    const lightOnly = resolveShown(inputs({ preferred, osKind: 'light', entries: [ok(NIGHT)] }));
    expect(lightOnly).toMatchObject({ kind: 'light', builtin: true, fallback: { themeId: ID, reason: 'noLook' } });
    expect(lightOnly.look).toBe(BUILTIN_THEME.looks.light);
  });

  it('steps aside under forced colors: the built-in look of the OS kind, whatever the mode and picks', () => {
    const shown = resolveShown(inputs({ forcedColors: true, mode: 'dark', osKind: 'light', preferred: { dark: ID, light: ID }, entries: [ok(NIGHT)] }));
    expect(shown).toMatchObject({ kind: 'light', themeId: 'damocles', builtin: true, decidedBy: 'forcedColors' });
    expect(shown.fallback).toBeUndefined();
  });

  it('shows the built-in look of the mode\'s kind in safe start, a preview included', () => {
    const preview = { themeId: ID, kind: 'light' as const, look: NIGHT.looks.dark! };
    const shown = resolveShown(inputs({ safeStart: 'crashLoop', mode: 'dark', osKind: 'light', preferred: { dark: ID, light: ID }, entries: [ok(NIGHT)], preview }));
    expect(shown).toMatchObject({ kind: 'dark', themeId: 'damocles', builtin: true, decidedBy: 'safeStart' });
  });

  it('paints a transient preview\'s look and kind over the preferred look', () => {
    const preview = { themeId: ID, kind: 'light' as const, look: NIGHT.looks.dark! };
    expect(resolveShown(inputs({ preview }))).toMatchObject({ kind: 'light', themeId: ID, builtin: false, decidedBy: 'preview', look: preview.look });
  });
});

describe('themeSourceFor', () => {
  it('is system whenever the OS kind chooses the shown kind, else the fixed kind', () => {
    const entries = [ok(NIGHT)];
    expect(themeSourceFor(resolveShown(inputs({ entries })))).toBe('system');
    expect(themeSourceFor(resolveShown(inputs({ entries, mode: 'dark' })))).toBe('dark');
    expect(themeSourceFor(resolveShown(inputs({ entries, mode: 'light' })))).toBe('light');
    expect(themeSourceFor(resolveShown(inputs({ entries, mode: 'dark', forcedColors: true })))).toBe('system');
  });
});

describe('the schedule in resolveShown', () => {
  const DAY_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const GONE = 'a1b2c3d4-0000-4000-8000-000000000009';
  const DAY: ThemeFile = { schemaVersion: 1, id: DAY_ID, name: 'Day', looks: { dark: { colors: COLORS }, light: { colors: { ...COLORS, background: '#fbf8f1', panel: '#f1ece0', text: '#1f1a12' } } } };
  const ATHENS = 'Europe/Athens';
  // Athens is UTC+3 in June; 12 June 2024 was a Wednesday
  const at = (day: number, hour: number, minute = 0): number => Date.UTC(2024, 5, day, hour - 3, minute);
  const WEEKDAYS_ONLY = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;
  const rules = [
    { days: [...WEEKDAYS_ONLY], minute: 7 * 60, theme: DAY_ID, look: 'light' as const },
    { days: [...WEEKDAYS_ONLY], minute: 19 * 60, theme: ID, look: 'dark' as const },
    { days: ['sat', 'sun'] as Weekday[], minute: 9 * 60, theme: 'damocles', look: 'auto' as const },
  ];
  const entries = [ok(NIGHT), ok(DAY)];
  const scheduled = (now: number, more: Partial<AppearanceInputs> = {}, override?: { themeId: string; kind: 'dark' | 'light'; at: number }, zone = ATHENS): AppearanceInputs => inputs({
    entries,
    mode: 'light',
    preferred: { dark: 'damocles', light: 'damocles' },
    schedule: { state: { schedule: { enabled: true, rules }, ...(override ? { override } : {}) }, now, zone },
    ...more,
  });

  it('shows the latest rule start at or before now, with when the next change comes, and moving the clock backwards keeps state-based results', () => {
    const evening = resolveShown(scheduled(at(12, 20, 15)));
    expect(evening).toMatchObject({ themeId: ID, kind: 'dark', decidedBy: 'schedule', osDecides: false, until: at(13, 7) });
    expect(themeSourceFor(evening)).toBe('dark');
    expect(resolveShown(scheduled(at(12, 12)))).toMatchObject({ themeId: DAY_ID, kind: 'light', decidedBy: 'schedule', until: at(12, 19) });
    // before Wednesday's first rule the latest start is Tuesday 19:00
    expect(resolveShown(scheduled(at(12, 6, 59)))).toMatchObject({ themeId: ID, kind: 'dark' });
    expect(resolveShown(scheduled(at(12, 20, 15)))).toEqual(evening);
  });

  it('takes the OS kind for a look named auto, so themeSource goes back to system', () => {
    const saturday = resolveShown(scheduled(at(15, 10), { osKind: 'light' }));
    expect(saturday).toMatchObject({ themeId: 'damocles', kind: 'light', decidedBy: 'schedule', osDecides: true });
    expect(themeSourceFor(saturday)).toBe('system');
    expect(resolveShown(scheduled(at(15, 10), { osKind: 'dark' }))).toMatchObject({ kind: 'dark', osDecides: true });
  });

  it('shows a pick made while the schedule runs until the next rule start after it, then the schedule resumes', () => {
    const pick = { themeId: DAY_ID, kind: 'dark' as const, at: at(12, 19, 52) };
    expect(resolveShown(scheduled(at(12, 20, 15), {}, pick))).toMatchObject({ themeId: DAY_ID, kind: 'dark', decidedBy: 'override', osDecides: false, until: at(13, 7) });
    expect(resolveShown(scheduled(at(13, 7), {}, pick))).toMatchObject({ themeId: DAY_ID, kind: 'light', decidedBy: 'schedule' });
  });

  it('is off in System mode and paused in safe start', () => {
    expect(resolveShown(scheduled(at(12, 20, 15), { mode: 'system', osKind: 'light' }))).toMatchObject({ themeId: 'damocles', kind: 'light', decidedBy: 'system' });
    expect(resolveShown(scheduled(at(12, 20, 15), { safeStart: 'launch' }))).toMatchObject({ themeId: 'damocles', kind: 'light', decidedBy: 'safeStart', builtin: true });
  });

  it('skips a rule naming a missing theme, and falls back to the mode when no rule can run', () => {
    const withGone = inputs({
      entries, mode: 'light',
      schedule: { state: { schedule: { enabled: true, rules: [...rules, { days: [...WEEKDAYS_ONLY], minute: 20 * 60, theme: GONE, look: 'dark' }] } }, now: at(12, 20, 15), zone: ATHENS },
    });
    expect(resolveShown(withGone)).toMatchObject({ themeId: ID, decidedBy: 'schedule' });
    const onlyGone = inputs({ entries, mode: 'light', schedule: { state: { schedule: { enabled: true, rules: [{ days: ['wed'], minute: 0, theme: GONE, look: 'dark' }] } }, now: at(12, 20, 15), zone: ATHENS } });
    expect(resolveShown(onlyGone)).toMatchObject({ themeId: 'damocles', kind: 'light', decidedBy: 'mode' });
  });

  it('evaluates in the zone it is given, never the process default', () => {
    // 20:15 in Athens is 13:15 in New York, where Wednesday's 07:00 rule shows
    expect(resolveShown(scheduled(at(12, 20, 15), {}, undefined, 'America/New_York'))).toMatchObject({ themeId: DAY_ID, kind: 'light' });
  });
});

describe('the trusted palette', () => {
  it('is the shown palette while it passes every text rule, warnings included', () => {
    const palette = shownPalette({ kind: 'dark', themeId: ID, look: NIGHT.looks.dark!, builtin: false });
    expect(checkPalette(palette, 'dark').every((issue) => issue.severity === 'warning')).toBe(true);
    expect(trustedPalette(palette, 'dark')).toBe(palette);
    expect(trustedCss(palette, 'dark', 'region')).toContain(`[data-trusted] { color-scheme: dark; `);
    expect(trustedCss(palette, 'dark', 'region')).toContain(`--d-bg: ${COLORS.background};`);
  });

  it('is the built-in palette of the kind when a text rule fails, scoped to the page in the overlay', () => {
    const palette = shownPalette({ kind: 'dark', themeId: ID, look: FAILING.looks.dark!, builtin: false });
    expect(checkPalette(palette, 'dark').some((issue) => issue.severity === 'error')).toBe(true);
    expect(trustedPalette(palette, 'dark')).toBe(BUILTIN_PALETTES.dark);
    const css = trustedCss(palette, 'dark', 'root');
    expect(css.startsWith(':root { color-scheme: dark; ')).toBe(true);
    expect(css).toContain(`--d-bg: ${BUILTIN_PALETTES.dark['--d-bg']};`);
  });

  it('paints the look\'s opaque --d-bg before a page does', () => {
    expect(opaqueBackground({ ...BUILTIN_PALETTES.dark, '--d-bg': '#11223380' })).toBe('#112233');
  });
});

describe('main reads the theme files itself', () => {
  it('validates each folder again and never trusts what core wrote', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-main-themes-'));
    try {
      const write = (id: string, text: string): void => {
        fs.mkdirSync(path.join(root, 'themes', id), { recursive: true });
        fs.writeFileSync(path.join(root, 'themes', id, 'theme.json'), text);
      };
      write(ID, JSON.stringify(NIGHT));
      write('7c9e6679-7425-40de-944b-e07fc1f90ae7', JSON.stringify({ ...NIGHT, looks: { dark: { colors: { ...COLORS, panel: 'red' } } } }));
      const entries = await readThemeFiles(root);
      expect([...entries.keys()].sort()).toEqual(['0f8fad5b-d9cb-469f-a165-70867728950e', '7c9e6679-7425-40de-944b-e07fc1f90ae7', 'damocles']);
      expect(entries.get(ID)).toMatchObject({ status: 'ok' });
      expect(entries.get('7c9e6679-7425-40de-944b-e07fc1f90ae7')).toMatchObject({ status: 'broken' });
      expect(themeEntry(ID, { ...NIGHT, schemaVersion: 2 })).toMatchObject({ status: 'needsNewer', version: 2, name: 'Night' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs the sanitizer again: a theme whose stored CSS it would cut is broken and never shows', async () => {
    expect(themeEntry(ID, STYLED)).toMatchObject({ status: 'ok' });
    expect(cssRefusal(STYLED)).toBeUndefined();
    const handWritten: ThemeFile = { ...STYLED, css: { sidebar: 'a { color: red } [data-trusted] { display: none }' } };
    expect(cssRefusal(handWritten)).toBe('/css/sidebar: custom CSS the sanitizer removes (selector): [data-trusted]');
    expect(themeEntry(ID, handWritten)).toEqual({ status: 'broken', id: ID, name: 'Styled', error: cssRefusal(handWritten) });
    // a family the theme no longer declares counts too
    const fontless: ThemeFile = { ...STYLED, style: {}, css: { transcript: "p { font-family: 'My Font' }" } };
    expect(themeEntry(ID, fontless)).toMatchObject({ status: 'broken' });
    expect(themeEntry(ID, { ...fontless, style: { fonts: { ui: { installed: 'My Font' } } } })).toMatchObject({ status: 'ok' });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-main-themes-'));
    try {
      fs.mkdirSync(path.join(root, 'themes', ID), { recursive: true });
      fs.writeFileSync(path.join(root, 'themes', ID, 'theme.json'), JSON.stringify(handWritten));
      const entry = (await readThemeFiles(root)).get(ID);
      expect(entry).toMatchObject({ status: 'broken' });
      expect(resolveShown(inputs({ preferred: { dark: ID, light: ID }, entries: [entry!] }))).toMatchObject({ themeId: 'damocles', builtin: true, fallback: { themeId: ID, reason: 'broken' } });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('main follows the settings and nativeTheme', () => {
  function fakeSettings(values: Record<string, unknown>) {
    let listener: (() => void) | undefined;
    return {
      values,
      get: <T>(key: string): T | undefined => values[key] as T | undefined,
      onDidChange: (_section: string, cb: () => void) => {
        listener = cb;
        return { dispose: () => (listener = undefined) };
      },
      fire: () => listener?.(),
    };
  }
  const library = (entries: readonly LibraryEntry[]) => {
    const map = new Map(entries.map((entry) => [entry.id, entry]));
    return { entry: (id: string) => map.get(id), onDidChange: () => ({ dispose: () => undefined }) } as unknown as Parameters<typeof followThemeSettings>[1];
  };
  const updated = (): void => {
    for (const [event, handler] of H.native.on.mock.calls as Array<[string, () => void]>) if (event === 'updated') handler();
  };

  it('writes themeSource from the mode and forced colors only, never on an OS switch nativeTheme reports', () => {
    H.native.on.mockClear();
    H.native.inForcedColorsMode = false;
    const settings = fakeSettings({ 'damocles.desktop.theme': 'system', 'damocles.desktop.themes.dark': ID });
    const following = followThemeSettings(settings, library([ok(NIGHT)]));
    expect(H.native.themeSource).toBe('system');
    expect(currentThemeKind()).toBe('dark');
    expect(shownBackground()).toBe(COLORS.background);
    expect(currentTheme().css).toContain(`--d-bg: ${COLORS.background};`);

    // the OS switches to light: the shown kind follows and themeSource stays system
    H.native.shouldUseDarkColors = false;
    updated();
    expect(H.native.themeSource).toBe('system');
    expect(currentThemeKind()).toBe('light');
    expect(shownBackground()).toBe(BUILTIN_PALETTES.light['--d-bg']);

    settings.values['damocles.desktop.theme'] = 'dark';
    settings.fire();
    expect(H.native.themeSource).toBe('dark');
    expect(currentThemeKind()).toBe('dark');

    // a Windows contrast theme: themeSource goes back to system and the built-in look of the OS kind shows
    H.native.inForcedColorsMode = true;
    updated();
    expect(H.native.themeSource).toBe('system');
    expect(currentThemeKind()).toBe('light');
    expect(currentTheme().css).toContain(`--d-bg: ${BUILTIN_PALETTES.light['--d-bg']};`);

    H.native.inForcedColorsMode = false;
    updated();
    expect(H.native.themeSource).toBe('dark');
    following.dispose();
    H.native.shouldUseDarkColors = true;
  });

  it('evaluates the schedule in the zone the shell reports, again on each re-evaluation, and writes themeSource from the rule', () => {
    const DAY_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const DAY: ThemeFile = { schemaVersion: 1, id: DAY_ID, name: 'Day', looks: { light: { colors: { ...COLORS, background: '#fbf8f1', panel: '#f1ece0', text: '#1f1a12' } } } };
    const settings = fakeSettings({ 'damocles.desktop.theme': 'light' });
    const following = followThemeSettings(settings, library([ok(NIGHT), ok(DAY)]));
    const schedule = { enabled: true, rules: [
      { days: ['mon', 'tue', 'wed', 'thu', 'fri'] as Weekday[], minute: 7 * 60, theme: DAY_ID, look: 'light' as const },
      { days: ['mon', 'tue', 'wed', 'thu', 'fri'] as Weekday[], minute: 19 * 60, theme: ID, look: 'dark' as const },
    ] };
    let now = Date.UTC(2024, 5, 12, 17, 15);
    setThemeClock(() => now);
    setReportedTimeZone('Europe/Athens');
    setAppearanceSchedule({ schedule });
    // 20:15 in Athens: the evening rule, a fixed kind
    expect(currentBaseShown()).toMatchObject({ themeId: ID, kind: 'dark', decidedBy: 'schedule' });
    expect(H.native.themeSource).toBe('dark');

    // the shell reports New York, where it is 13:15: the day rule shows at once
    expect(setReportedTimeZone('America/New_York')).toBe(true);
    expect(currentBaseShown()).toMatchObject({ themeId: DAY_ID, kind: 'light' });
    expect(H.native.themeSource).toBe('light');
    expect(setReportedTimeZone('America/New_York')).toBe(false);

    // time passes during sleep; nothing changes until the resume re-evaluates
    now = Date.UTC(2024, 5, 13, 0, 30);
    expect(currentBaseShown().themeId).toBe(DAY_ID);
    reevaluateTheme();
    expect(currentBaseShown()).toMatchObject({ themeId: ID, kind: 'dark' });

    setAppearanceSchedule({ schedule: { enabled: false, rules: [] } });
    setThemeClock(undefined);
    following.dispose();
  });

  it('gives the overlay the trusted palette as its page palette and the chat pages a [data-trusted] one', () => {
    const settings = fakeSettings({ 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': ID });
    const following = followThemeSettings(settings, library([ok(FAILING)]));
    expect(currentTheme().css).toContain('--d-text: #2a2040;');
    expect(currentTheme().trustedCss).toContain(`[data-trusted] { color-scheme: dark; `);
    expect(currentTheme().trustedCss).toContain(`--d-text: ${BUILTIN_PALETTES.dark['--d-text']};`);
    expect(currentTheme('root').trustedCss.startsWith(':root {')).toBe(true);
    following.dispose();
  });

  it('paints a transient preview on the page palette while trusted UI keeps the palette from before it', () => {
    const settings = fakeSettings({ 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': 'damocles' });
    const following = followThemeSettings(settings, library([ok(NIGHT)]));
    setThemePreview({ themeId: ID, kind: 'dark', look: NIGHT.looks.dark! });
    expect(currentTheme().css).toContain(`--d-bg: ${COLORS.background};`);
    expect(currentTheme('root').trustedCss).toContain(`--d-bg: ${BUILTIN_PALETTES.dark['--d-bg']};`);
    setThemePreview(undefined);
    expect(currentTheme().css).toContain(`--d-bg: ${BUILTIN_PALETTES.dark['--d-bg']};`);
    following.dispose();
  });

  it('gives each content page only its own regions of the sanitized custom CSS, and no other renderer any', () => {
    H.native.on.mockClear();
    const settings = fakeSettings({ 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': ID });
    const following = followThemeSettings(settings, library([ok(STYLED)]));
    const chat = currentTheme('region', 'chat').customCss;
    const shell = currentTheme('region', 'shell').customCss;
    expect(chat).toBe('@layer damocles-user { @scope ([data-theme-scope~="transcript"]) to ([data-trusted], [data-trusted-mark], .monaco-editor, .xterm) { :where(:scope) p{color:red} } }');
    expect(shell).toContain('[data-theme-scope~="sidebar"]');
    expect(shell).toContain('[data-theme-scope~="titlebar"]');
    expect(shell).not.toContain('transcript');
    expect(currentTheme().customCss).toBeUndefined();
    expect(currentTheme('root', 'chat').customCss).toBeUndefined();
    expect(currentTheme('root', 'shell').customCss).toBeUndefined();
    // custom CSS is never part of the CSS main puts into a page's HTML
    expect(currentTheme('region', 'chat').css).not.toContain('damocles-user');

    // forced colors and safe start step aside
    H.native.inForcedColorsMode = true;
    updated();
    expect(currentTheme('region', 'chat').customCss).toBeUndefined();
    expect(currentTheme('region', 'shell').customCss).toBeUndefined();
    H.native.inForcedColorsMode = false;
    updated();
    setSafeStart('launch');
    expect(currentTheme('region', 'chat').customCss).toBeUndefined();
    setSafeStart(undefined);
    expect(currentTheme('region', 'chat').customCss).toBe(chat);
    following.dispose();
  });

  it('paints a transient preview\'s custom CSS only as main sanitizes it', () => {
    const settings = fakeSettings({ 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': 'damocles' });
    const following = followThemeSettings(settings, library([]));
    setThemePreview({ themeId: ID, kind: 'dark', look: NIGHT.looks.dark!, css: { transcript: 'p { display: none; color: blue } :root { --d-text: red }' } });
    const css = currentTheme('region', 'chat').customCss;
    expect(css).toContain('p{color:blue}');
    expect(css).not.toContain('display');
    expect(css).not.toContain('--d-text');
    setThemePreview(undefined);
    expect(currentTheme('region', 'chat').customCss).toBeUndefined();
    following.dispose();
  });

  it('resets the fonts of safety marks inside content areas to Damocles\' own stacks', () => {
    expect(trustedCss(BUILTIN_PALETTES.dark, 'dark', 'region')).toContain(`[data-trusted-mark] { --d-font: ${BUILTIN_UI_STACK}; --d-mono: ${BUILTIN_MONO_STACK}; }`);
    expect(trustedCss(BUILTIN_PALETTES.dark, 'dark', 'root')).not.toContain('data-trusted-mark');
  });

  it('shows the built-in look in safe start until it ends', () => {
    const settings = fakeSettings({ 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': ID });
    const following = followThemeSettings(settings, library([ok(NIGHT)]));
    setSafeStart('launch');
    expect(shownBackground()).toBe(BUILTIN_PALETTES.dark['--d-bg']);
    setSafeStart(undefined);
    expect(shownBackground()).toBe(COLORS.background);
    following.dispose();
  });
});

describe("the selected project's own look in resolveShown", () => {
  const DAY_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const ARCADE_ID = '9c9e6679-7425-40de-944b-e07fc1f90ae7';
  const SPRITE = 'e'.repeat(64);
  const WALL = 'f'.repeat(64);
  const IMAGE = { kind: 'image' as const, mime: 'image/png', bytes: 30, width: 1600, height: 1000, license: {} };
  const DAY: ThemeFile = {
    schemaVersion: 1, id: DAY_ID, name: 'Day',
    looks: { dark: { colors: COLORS }, light: { colors: { ...COLORS, background: '#fbf8f1', panel: '#f1ece0', text: '#1f1a12' } } },
    layout: { sidebarWidth: 400 },
  };
  const ARCADE: ThemeFile = {
    schemaVersion: 1, id: ARCADE_ID, name: 'Arcade copy', looks: { dark: { colors: COLORS } },
    characters: { name: 'Pals', characters: [{ name: 'Pip', states: { idle: { asset: SPRITE } } }] },
    assets: { [SPRITE]: { kind: 'sprite', mime: 'image/png', bytes: 10, width: 16, height: 16, license: {} } },
  };
  const ATHENS = 'Europe/Athens';
  // Athens is UTC+3 in June; 12 June 2024 was a Wednesday, and the rule shows NIGHT from 19:00
  const evening = Date.UTC(2024, 5, 12, 20 - 3);
  const scheduled = (more: Partial<AppearanceInputs> = {}): AppearanceInputs => inputs({
    entries: [ok(NIGHT), ok(DAY), ok(ARCADE)],
    mode: 'light',
    schedule: { state: { schedule: { enabled: true, rules: [{ days: ['wed'], minute: 19 * 60, theme: ID, look: 'dark' }] } }, now: evening, zone: ATHENS },
    ...more,
  });

  it('shows the project\'s own theme over the schedule and the mode, and its auto look follows the OS kind', () => {
    expect(resolveShown(scheduled())).toMatchObject({ themeId: ID, kind: 'dark', decidedBy: 'schedule' });
    const own = resolveShown(scheduled({ project: { mode: 'full', themeId: DAY_ID, look: 'light' } }));
    expect(own).toMatchObject({ themeId: DAY_ID, kind: 'light', decidedBy: 'project', osDecides: false });
    expect(themeSourceFor(own)).toBe('light');
    const auto = resolveShown(scheduled({ osKind: 'dark', project: { mode: 'full', themeId: DAY_ID, look: 'auto' } }));
    expect(auto).toMatchObject({ themeId: DAY_ID, kind: 'dark', decidedBy: 'project', osDecides: true });
    // a theme without the OS kind shows the look it has, which the OS does not choose
    expect(resolveShown(scheduled({ osKind: 'light', project: { mode: 'full', themeId: ID, look: 'auto' } }))).toMatchObject({ themeId: ID, kind: 'dark', osDecides: false });
    // a missing theme falls back to the built-in look of its kind and names it
    expect(resolveShown(scheduled({ project: { mode: 'full', themeId: '1c9e6679-7425-40de-944b-e07fc1f90ae7', look: 'light' } }))).toMatchObject({ themeId: 'damocles', kind: 'light', decidedBy: 'project', fallback: { reason: 'missing' } });
  });

  it('never carries a window arrangement: selecting a project changes only the look', () => {
    const own = resolveShown(scheduled({ project: { mode: 'full', themeId: DAY_ID, look: 'dark' } }));
    expect(own.themeId).toBe(DAY_ID);
    expect(Object.keys(own)).not.toContain('layout');
    expect(JSON.stringify(own)).not.toContain('sidebarWidth');
  });

  it('puts an accent touch on whatever shows, derived again for that look with its text at 4.5:1', () => {
    const bright = '#ffd60a';
    for (const shown of [
      resolveShown(scheduled({ project: { mode: 'touches', accent: bright } })),
      resolveShown(inputs({ mode: 'light', project: { mode: 'touches', accent: bright } })),
    ]) {
      expect(shown.touches).toEqual(['accent']);
      expect(shown.builtin).toBe(false);
      expect(shown.look.colors.accent).toBe(bright);
      expect(Object.keys(shown.look.tokens ?? {}).some((token) => token.startsWith('--d-accent') || token === '--d-on-accent')).toBe(false);
      const palette = shownPalette(shown);
      expect(palette['--d-accent-fill']).toBe(bright);
      for (const surface of ['--d-bg', '--d-panel'] as const) expect(contrast(palette['--d-accent']!, palette[surface]!)).toBeGreaterThanOrEqual(4.5);
    }
    // the schedule still decides the theme under the touch
    expect(resolveShown(scheduled({ project: { mode: 'touches', accent: bright } }))).toMatchObject({ themeId: ID, decidedBy: 'schedule' });
    // the built-in light look keeps every other token as it ships
    const light = shownPalette(resolveShown(inputs({ mode: 'light', project: { mode: 'touches', accent: bright } })));
    expect(light['--d-text']).toBe(BUILTIN_PALETTES.light['--d-text']);
    expect(light['--d-accent']).not.toBe(bright);
  });

  it("replaces the look's wallpaper sets with the touch's, and takes another theme's character set while it can show", () => {
    const wallpaper = { span: { asset: WALL, panels: ['chat' as const], fit: 'fill' as const } };
    const shown = resolveShown(scheduled({ project: { mode: 'touches', wallpaper, assets: { [WALL]: IMAGE }, characterSet: ARCADE_ID } }));
    expect(shown.touches).toEqual(['wallpaper', 'characters']);
    expect(shown.look.wallpapers).toEqual([wallpaper]);
    expect(shown.assets).toMatchObject({ [WALL]: IMAGE, [SPRITE]: ARCADE.assets![SPRITE] });
    expect(shown.characters).toEqual(ARCADE.characters);
    const gone = resolveShown(scheduled({ project: { mode: 'touches', characterSet: '2c9e6679-7425-40de-944b-e07fc1f90ae7' } }));
    expect(gone.touches).toBeUndefined();
    expect(gone.characters).toBeUndefined();
  });

  it('steps aside under forced colors, in safe start and for a transient preview', () => {
    const project = { mode: 'full' as const, themeId: DAY_ID, look: 'light' as const };
    expect(resolveShown(scheduled({ forcedColors: true, osKind: 'dark', project }))).toMatchObject({ themeId: 'damocles', decidedBy: 'forcedColors' });
    expect(resolveShown(scheduled({ safeStart: 'launch', project: { mode: 'touches', accent: '#ffd60a' } }))).toMatchObject({ themeId: 'damocles', builtin: true, decidedBy: 'safeStart' });
    const preview = { themeId: ID, kind: 'dark' as const, look: NIGHT.looks.dark! };
    const previewed = resolveShown(scheduled({ preview, project: { mode: 'touches', accent: '#ffd60a' } }));
    expect(previewed).toMatchObject({ decidedBy: 'preview' });
    expect(previewed.touches).toBeUndefined();
  });
});

describe("main's selected project", () => {
  it("shows its own look once main has it, says so to the theme listeners, and shows the current theme again for another project", () => {
    H.native.themeSource = 'system';
    H.native.inForcedColorsMode = false;
    const listener = vi.fn();
    const subscription = onThemeChange(listener);
    setProjectLooks({ '/work/site': { mode: 'full', themeId: 'damocles', look: 'light' }, '/work/bad': { mode: 'sideways' } });
    expect(projectLookOf('/work/bad')).toBeUndefined();
    setSelectedProject('/work/site');
    expect(currentBaseShown()).toMatchObject({ themeId: 'damocles', kind: 'light', decidedBy: 'project' });
    expect(listener).toHaveBeenCalled();
    setSelectedProject('/work/other');
    expect(currentBaseShown().decidedBy).not.toBe('project');
    setSelectedProject(undefined);
    setProjectLooks({});
    subscription.dispose();
  });
});

describe('wallpaperMotion', () => {
  const playing: MotionInputs = { focused: true, visible: true, minimized: false, onBattery: false, batterySaver: false, reduceMotion: false, forcedColors: false, wallpapersShown: true };

  it('plays only while the window is focused and shown, on power, with motion and wallpapers on', () => {
    expect(wallpaperMotion(playing)).toEqual({ play: true, paused: [] });
  });

  it.each([
    ['the window lost focus', { focused: false }, 'unfocused'],
    // the shell page reports document.visibilityState, which Chromium sets hidden while another window covers this one
    ['another window covers it', { visible: false }, 'hidden'],
    ['it is minimized', { minimized: true }, 'minimized'],
    ['the computer runs on battery', { onBattery: true }, 'battery'],
    ['Windows battery saver is on', { batterySaver: true }, 'batterySaver'],
    ['motion is reduced', { reduceMotion: true }, 'reduceMotion'],
    ['a contrast theme is on', { forcedColors: true }, 'forcedColors'],
    ['wallpapers are off', { wallpapersShown: false }, 'wallpapersOff'],
  ] as const)('pauses while %s', (_name, change, reason) => {
    expect(wallpaperMotion({ ...playing, ...change })).toEqual({ play: false, paused: [reason] });
  });

  // The covered window: the shell page's hidden report reaches main as `visible: false` (shell-host.test.ts, page-motion.test.ts).
  it('pauses while the page reports it is hidden and plays again once visible, telling the theme listeners each time', () => {
    setMotionEnvironment({ focused: true, visible: true, minimized: false, onBattery: false, batterySaver: false, osReducedMotion: false });
    const heard: string[] = [];
    const listening = onThemeChange(() => heard.push(currentWallpaperMotion().paused.join(',')));
    setMotionEnvironment({ visible: false });
    expect(currentWallpaperMotion().paused).toContain('hidden');
    setMotionEnvironment({ visible: false });
    setMotionEnvironment({ visible: true, osReducedMotion: true });
    expect(currentWallpaperMotion().paused).toContain('reduceMotion');
    expect(currentWallpaperMotion().paused).not.toContain('hidden');
    expect(heard).toHaveLength(2);
    expect(heard[0]).toContain('hidden');
    listening.dispose();
    setMotionEnvironment({ osReducedMotion: false });
  });

  it('names every reason at once, so lifting one keeps the others', () => {
    const paused = wallpaperMotion({ ...playing, minimized: true, visible: false, focused: false });
    expect(paused).toEqual({ play: false, paused: ['minimized', 'hidden', 'unfocused'] });
    expect(wallpaperMotion({ ...playing, visible: false, focused: false }).play).toBe(false);
  });
});
