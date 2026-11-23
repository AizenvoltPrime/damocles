// Which look the window shows (docs/invariants.md "Desktop themes"). Pure: main runs it on every input change.
import { BUILTIN_THEME, BUILTIN_THEME_ID } from '../../../shared/themes/builtin';
import { decideSchedule, nextChange, type AppearanceSchedule, type ScheduleDecision, type ScheduleInput } from '../../../shared/themes/schedule';
import type { Look, ThemeFile } from '../../../shared/themes/schema';
import type { ThemeStyle } from '../../../shared/themes/style';
import { fullThemeKind, touchedLook, touchesOf, type ProjectLook, type ProjectTouch } from '../../../shared/themes/project-looks';
import { characterAssets } from '../../../shared/themes/characters';
import type { LookKind } from '../../../shared/themes/tokens';
import type { ThemePreference } from '../../local-services/desktop-configuration';
import type { LibraryEntry } from './theme-files';

type ThemeAssets = NonNullable<ThemeFile['assets']>;

// The launch flag of safe start, and of Help › Restart with Default Theme's relaunch.
export const SAFE_THEME_FLAG = '--damocles-safe-theme';

// launch: the flag; crashLoop: the window kept crashing while a custom theme showed; reset: Reset Theme to Default while the
// engine was down and a look only the engine writes still decided
export type SafeStartReason = 'launch' | 'crashLoop' | 'reset';

// A look painted on the window without being saved: the theme editor's draft or a card's Show in window.
export interface TransientPreview {
  readonly themeId: string;
  readonly kind: LookKind;
  readonly look: Look;
  readonly style?: ThemeStyle;
  readonly assets?: ThemeAssets;
  // the draft's custom CSS, which main sanitizes before it paints any of it
  readonly css?: NonNullable<ThemeFile['css']>;
  readonly characters?: NonNullable<ThemeFile['characters']>;
  // the wallpaper set the editor edits, which the preview shows instead of the cycle's
  readonly setIndex?: number;
}

// Why moving wallpapers show their still frame now; none of them, and they play.
export type MotionPause = 'unfocused' | 'hidden' | 'minimized' | 'battery' | 'batterySaver' | 'reduceMotion' | 'forcedColors' | 'wallpapersOff';

export interface MotionInputs {
  // the window has keyboard focus (BrowserWindow focus and blur)
  readonly focused: boolean;
  // the shell page's document.visibilityState is visible: Chromium marks it hidden while the window is covered (native
  // occlusion tracking, Windows and macOS) or minimized
  readonly visible: boolean;
  // the window's minimize and restore events, which cover a platform that reports no visibility change
  readonly minimized: boolean;
  // powerMonitor's on-battery and on-ac, or isOnBatteryPower() polled on Linux, which sends neither event
  readonly onBattery: boolean;
  // Windows battery saver (power-saver-win32.ts)
  readonly batterySaver: boolean;
  // damocles.desktop.reduceMotion, or the OS's reduced motion as the shell page's prefers-reduced-motion reports it
  readonly reduceMotion: boolean;
  readonly forcedColors: boolean;
  // the window shows a wallpaper at all
  readonly wallpapersShown: boolean;
}

/** Whether moving wallpapers play, and every reason they are paused; a file its flash check blocks never plays either way. */
export function wallpaperMotion(inputs: MotionInputs): { readonly play: boolean; readonly paused: readonly MotionPause[] } {
  const paused: MotionPause[] = [];
  if (!inputs.wallpapersShown) paused.push('wallpapersOff');
  if (inputs.forcedColors) paused.push('forcedColors');
  if (inputs.reduceMotion) paused.push('reduceMotion');
  if (inputs.minimized) paused.push('minimized');
  if (!inputs.visible) paused.push('hidden');
  if (!inputs.focused) paused.push('unfocused');
  if (inputs.onBattery) paused.push('battery');
  if (inputs.batterySaver) paused.push('batterySaver');
  return { play: paused.length === 0, paused };
}

export interface AppearanceInputs {
  // nativeTheme.inForcedColorsMode: Windows contrast themes, where themes step aside
  readonly forcedColors: boolean;
  // safe start for this run: the built-in look of the mode's kind, whatever the preferred looks are
  readonly safeStart?: SafeStartReason;
  readonly preview?: TransientPreview;
  // damocles.desktop.theme
  readonly mode: ThemePreference;
  // nativeTheme.shouldUseDarkColors; read only while themeSource is 'system', so it is the OS kind then
  readonly osKind: LookKind;
  // damocles.desktop.themes.dark and .light
  readonly preferred: Readonly<Record<LookKind, string>>;
  readonly theme: (id: string) => LibraryEntry | undefined;
  // appearance.json's schedule and pick, evaluated at `now` in `zone`, the zone the shell page reports
  readonly schedule?: { readonly state: AppearanceSchedule; readonly now: number; readonly zone: string };
  // the selected project's own look on this computer, as main checked it
  readonly project?: ProjectLook;
}

// Why the preferred look of the shown kind does not show: its theme is not installed, does not validate, needs a newer
// Damocles, or has no look of that kind.
export type FallbackReason = 'missing' | 'broken' | 'needsNewer' | 'noLook';

export interface ShownTheme {
  readonly kind: LookKind;
  // the theme whose look shows: the preferred one, or the built-in after a fallback, under forced colors or in safe start
  readonly themeId: string;
  readonly look: Look;
  // the theme's fonts, line spacing, corners, density and chat column, and the assets its fonts name; none for a built-in look
  readonly style?: ThemeStyle;
  readonly assets?: ThemeAssets;
  // the theme's custom CSS per region, as stored; none for a built-in look, under forced colors or in safe start
  readonly css?: NonNullable<ThemeFile['css']>;
  // the theme's character set; none for the built-in look, under forced colors or in safe start
  readonly characters?: NonNullable<ThemeFile['characters']>;
  readonly builtin: boolean;
  // what chose the look: forced colors and System mode follow the OS kind, a fixed mode is its own kind, safe start the
  // built-in look of the mode's kind, a preview its own look, the schedule its active rule, override a pick that holds
  // over the schedule until its next rule start, and project the selected project's own theme
  readonly decidedBy: 'forcedColors' | 'safeStart' | 'preview' | 'system' | 'mode' | 'schedule' | 'override' | 'project';
  // the selected project's touches on top of the look, each one that shows
  readonly touches?: readonly ProjectTouch[];
  // the computer's light or dark mode chose the shown kind, so nativeTheme.themeSource is 'system'
  readonly osDecides: boolean;
  // while the schedule decides: when a rule start next changes what shows (undefined: no rule within a week does)
  readonly until?: number;
  readonly fallback?: { readonly themeId: string; readonly reason: FallbackReason };
}

/** nativeTheme.themeSource: 'system' whenever the OS kind chooses the shown kind, else the shown kind, so native menus and scrollbars match it. */
export function themeSourceFor(shown: Pick<ShownTheme, 'kind' | 'osDecides'>): ThemePreference {
  return shown.osDecides ? 'system' : shown.kind;
}

const builtinLook = (kind: LookKind): Look => BUILTIN_THEME.looks[kind]!;

/** The looks of each installed theme the schedule may show; none for a theme that is missing, broken or needs a newer Damocles. */
export const scheduleLooks = (theme: AppearanceInputs['theme']) => (id: string): readonly LookKind[] | undefined => {
  if (id === BUILTIN_THEME_ID) return ['dark', 'light'];
  const entry = theme(id);
  return entry?.status === 'ok' ? (['dark', 'light'] as const).filter((kind) => entry.theme.looks[kind] !== undefined) : undefined;
};

/** The schedule's decision for these inputs; `none` unless the schedule is on and the mode is not System, which turns it off. */
export function scheduleDecisionOf(inputs: AppearanceInputs): { readonly decision: ScheduleDecision; readonly input?: ScheduleInput } {
  const { schedule } = inputs;
  if (!schedule || inputs.mode === 'system') return { decision: { by: 'none' } };
  const input: ScheduleInput = { schedule: schedule.state.schedule, override: schedule.state.override, now: schedule.now, zone: schedule.zone, looks: scheduleLooks(inputs.theme), osKind: inputs.osKind };
  return { decision: decideSchedule(input), input };
}

export function resolveShown(inputs: AppearanceInputs): ShownTheme {
  if (inputs.forcedColors) return { kind: inputs.osKind, themeId: BUILTIN_THEME_ID, look: builtinLook(inputs.osKind), builtin: true, decidedBy: 'forcedColors', osDecides: true };
  const systemMode = inputs.mode === 'system';
  const modeKind = systemMode ? inputs.osKind : inputs.mode;
  if (inputs.safeStart !== undefined) return { kind: modeKind, themeId: BUILTIN_THEME_ID, look: builtinLook(modeKind), builtin: true, decidedBy: 'safeStart', osDecides: systemMode };
  const { preview } = inputs;
  if (preview) return { kind: preview.kind, themeId: preview.themeId, look: preview.look, ...styleOf(preview), builtin: false, decidedBy: 'preview', osDecides: systemMode };
  return withTouches(inputs, baseLook(inputs));
}

// The look before the project's touches: the project's own theme, else the schedule, else the mode and preferred looks.
function baseLook(inputs: AppearanceInputs): ShownTheme {
  const systemMode = inputs.mode === 'system';
  const modeKind = systemMode ? inputs.osKind : inputs.mode;
  const { project } = inputs;
  if (project?.mode === 'full') {
    const entry = project.themeId === BUILTIN_THEME_ID ? undefined : inputs.theme(project.themeId);
    const has = (kind: LookKind): boolean => project.themeId === BUILTIN_THEME_ID || (entry?.status === 'ok' && entry.theme.looks[kind] !== undefined);
    const { kind, byOs } = fullThemeKind(project.look, has, inputs.osKind);
    return lookOf(inputs, project.themeId, kind, { decidedBy: 'project', osDecides: byOs });
  }
  const { decision, input } = scheduleDecisionOf(inputs);
  if (decision.by === 'override') {
    const { themeId, kind } = decision.override;
    return lookOf(inputs, themeId, kind, { decidedBy: 'override', osDecides: false, until: decision.until });
  }
  if (decision.by === 'rule') {
    const { outcome } = decision;
    const next = nextChange(input!, input!.now, outcome);
    return lookOf(inputs, outcome.themeId, outcome.kind, { decidedBy: 'schedule', osDecides: outcome.byOs, ...(next ? { until: next.at } : {}) });
  }
  return lookOf(inputs, inputs.preferred[modeKind], modeKind, { decidedBy: systemMode ? 'system' : 'mode', osDecides: systemMode });
}

// The selected project's touches on top of whatever shows: the accent derived again for this look, its wallpaper set in place
// of the look's, and another theme's character set while that theme can show.
function withTouches(inputs: AppearanceInputs, shown: ShownTheme): ShownTheme {
  const { project } = inputs;
  if (project?.mode !== 'touches') return shown;
  const source = project.characterSet === undefined ? undefined : inputs.theme(project.characterSet);
  const characters = source?.status === 'ok' ? source.theme.characters : undefined;
  const touches = touchesOf(project).filter((touch) => touch !== 'characters' || characters !== undefined);
  if (touches.length === 0) return shown;
  const sprites = characters && source?.status === 'ok'
    ? Object.fromEntries(characterAssets(source.theme).flatMap((sha) => (source.theme.assets?.[sha] ? [[sha, source.theme.assets[sha]!]] : [])))
    : {};
  const assets = { ...shown.assets, ...(project.wallpaper ? project.assets : {}), ...sprites };
  return {
    ...shown,
    look: touchedLook(shown.look, project),
    ...(Object.keys(assets).length > 0 ? { assets } : {}),
    ...(characters ? { characters } : {}),
    builtin: false,
    touches,
  };
}

// `kind` of `themeId`, or the built-in look of that kind with the reason when the theme cannot show it.
function lookOf(inputs: AppearanceInputs, themeId: string, kind: LookKind, decided: Pick<ShownTheme, 'decidedBy' | 'osDecides' | 'until'>): ShownTheme {
  const builtin = (fallback?: ShownTheme['fallback']): ShownTheme => ({ kind, themeId: BUILTIN_THEME_ID, look: builtinLook(kind), builtin: true, ...decided, ...(fallback ? { fallback } : {}) });
  if (themeId === BUILTIN_THEME_ID) return builtin();
  const entry = inputs.theme(themeId);
  if (entry === undefined) return builtin({ themeId, reason: 'missing' });
  if (entry.status !== 'ok') return builtin({ themeId, reason: entry.status });
  const look = entry.theme.looks[kind];
  if (look === undefined) return builtin({ themeId, reason: 'noLook' });
  return { kind, themeId, look, ...styleOf(entry.theme), builtin: false, ...decided };
}

const styleOf = (theme: Pick<ThemeFile, 'style' | 'assets' | 'css' | 'characters'>): Pick<ShownTheme, 'style' | 'assets' | 'css' | 'characters'> => ({
  ...(theme.style !== undefined ? { style: theme.style } : {}),
  ...(theme.assets !== undefined ? { assets: theme.assets } : {}),
  ...(theme.css !== undefined ? { css: theme.css } : {}),
  ...(theme.characters !== undefined ? { characters: theme.characters } : {}),
});
