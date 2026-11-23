// The words Settings › Appearance uses for the theme schedule: what shows now and until when, from the schedule functions main's
// resolveShown evaluates with, in main's clock and zone. Times and day names come from Intl in the UI's language, in the hour
// cycle of the operating system's region, which also names the week's first day.
import { BUILTIN_THEME_ID } from '@shared/themes/builtin';
import {
  decideSchedule, localTime, MINUTES_PER_DAY, nextChange, outcomeAt, scheduleChoiceOf, shadowedRules, skippedRules, type ScheduleChoice, type ScheduleInput, type ScheduleOutcome,
  type ScheduleRule, WEEKDAYS,
} from '@shared/themes/schedule';
import type { LookKind } from '@shared/themes/tokens';
import { isolated } from '@shared/bidi-isolate';
import type { OverlayThemeEntry, OverlayThemes } from '../../../../preload/overlay-channels';

type Translate = (key: string, values?: Record<string, unknown>, plural?: number) => string;

const S = 'settingsHost.schedule';
const DAY_MS = 86_400_000;
// 1 January 2024 was a Monday, so day i of that week is WEEKDAYS[i]
const MONDAY = Date.UTC(2024, 0, 1, 12);

/** The looks each listed theme can show; none for one that is missing, broken or needs a newer Damocles. */
export function looksOf(themes: readonly OverlayThemeEntry[]): (id: string) => readonly LookKind[] | undefined {
  return (id) => {
    if (id === BUILTIN_THEME_ID) return ['dark', 'light'];
    const entry = themes.find((candidate) => candidate.id === id);
    return entry?.status === 'ok' ? (['dark', 'light'] as const).filter((kind) => entry.theme.looks[kind] !== undefined) : undefined;
  };
}

/** The schedule as main evaluates it, with `rules` in place of the saved ones while the editor writes them. */
export function scheduleInput(data: OverlayThemes, now: number, rules?: readonly ScheduleRule[], enabled?: boolean): ScheduleInput {
  const { schedule, override, zone, osKind } = data.schedule;
  return { schedule: { enabled: enabled ?? schedule.enabled, rules: rules ?? schedule.rules }, override, now, zone, looks: looksOf(data.themes), osKind };
}

/** A theme's name as listed; undefined for a theme that is gone, whose name nothing keeps. */
export const knownName = (data: OverlayThemes | undefined, id: string): string | undefined => data?.themes.find((entry) => entry.id === id)?.name;

/** A theme's name as listed; a theme that is gone keeps its id. */
export const themeName = (data: OverlayThemes | undefined, id: string): string => knownName(data, id) ?? id;

/** How the schedule screen writes a time and orders a week. */
export interface ScheduleClock {
  // the UI's language
  readonly locale: string;
  // the hour cycle of the operating system's region
  readonly hour12: boolean;
  // the day that region's week starts on: 0 Monday .. 6 Sunday
  readonly firstDay: number;
}

interface WeekInfo {
  readonly firstDay?: number;
}

// Intl.Locale's week data is a method in the standard and an accessor in the engines that shipped it first.
function weekInfoOf(locale: Intl.Locale): WeekInfo | undefined {
  const source = locale as Intl.Locale & { getWeekInfo?: () => WeekInfo; readonly weekInfo?: WeekInfo };
  return typeof source.getWeekInfo === 'function' ? source.getWeekInfo() : source.weekInfo;
}

/** The clock of `systemLocale`, the operating system's regional format; one Intl cannot read falls back to the UI's language. */
export function scheduleClock(locale: string, systemLocale: string): ScheduleClock {
  let region: Intl.Locale;
  try {
    region = new Intl.Locale(systemLocale);
  } catch {
    region = new Intl.Locale(locale);
  }
  const cycle = new Intl.DateTimeFormat(region.toString(), { hour: 'numeric' }).resolvedOptions().hourCycle;
  // Intl numbers the days 1 Monday .. 7 Sunday; with no week data the week starts on Monday
  const first = weekInfoOf(region)?.firstDay;
  return { locale, hour12: cycle === 'h12' || cycle === 'h11', firstDay: typeof first === 'number' && first >= 1 && first <= 7 ? first - 1 : 0 };
}

/** The clock the screen's data names. */
export const clockOf = (locale: string, data: OverlayThemes | undefined): ScheduleClock => scheduleClock(locale, data?.schedule.systemLocale ?? locale);

/** The week's days in the region's order, as indexes into WEEKDAYS. */
export const weekOrder = (clock: ScheduleClock): number[] => WEEKDAYS.map((_, index) => (clock.firstDay + index) % WEEKDAYS.length);

const formats = new Map<string, Intl.DateTimeFormat>();
function format(key: string, locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const id = `${locale}|${key}`;
  let known = formats.get(id);
  if (!known) {
    known = new Intl.DateTimeFormat(locale, options);
    formats.set(id, known);
  }
  return known;
}

const timeFormat = (clock: ScheduleClock, zone: string): Intl.DateTimeFormat => format(`time|${clock.hour12}|${zone}`, clock.locale, clock.hour12
  ? { hour: 'numeric', minute: '2-digit', hourCycle: 'h12', timeZone: zone }
  : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone });

export function timeText(clock: ScheduleClock, at: number, zone: string): string {
  return timeFormat(clock, zone).format(at);
}

/** A minute of the day as the clock writes it; the day's end is 24:00 on a 24-hour clock and midnight on a 12-hour one. */
export function minuteText(clock: ScheduleClock, minute: number): string {
  if (!clock.hour12 && minute >= MINUTES_PER_DAY) return '24:00';
  return timeFormat(clock, 'UTC').format((minute % MINUTES_PER_DAY) * 60_000);
}

/** An hour of the day strip's axis: "06" on a 24-hour clock, "6 AM" on a 12-hour one. */
export function hourText(clock: ScheduleClock, hour: number): string {
  if (!clock.hour12) return String(hour).padStart(2, '0');
  return format('hour', clock.locale, { hour: 'numeric', hourCycle: 'h12', timeZone: 'UTC' }).format((hour % 24) * 3_600_000);
}

/** The name of day `day` (0 Monday .. 6 Sunday) in the UI's language. */
export function weekdayName(locale: string, day: number, width: 'long' | 'short' = 'long'): string {
  return format(`weekday|${width}`, locale, { weekday: width, timeZone: 'UTC' }).format(MONDAY + day * DAY_MS);
}

const civilDays = (instant: number, zone: string): number => {
  const { date } = localTime(instant, zone);
  return Date.UTC(date.year, date.month - 1, date.day) / DAY_MS;
};

/** "07:00", "07:00 tomorrow", "Thursday 07:00", "next Wednesday 07:00", as the zone's clocks read `at` from `now`. */
export function whenText(t: Translate, clock: ScheduleClock, at: number, now: number, zone: string): string {
  const time = timeText(clock, at, zone);
  const days = civilDays(at, zone) - civilDays(now, zone);
  if (days <= 0) return t(`${S}.when.today`, { time });
  if (days === 1) return t(`${S}.when.tomorrow`, { time });
  const day = weekdayName(clock.locale, localTime(at, zone).weekday);
  return days < 7 ? t(`${S}.when.weekday`, { day, time }) : t(`${S}.when.nextWeek`, { day, time });
}

/**
 * "Bleach (light)", or for an auto rule "Forest (auto)", and "Forest (auto, dark now)" for the one that shows now. The name
 * is marked as user text (isolated), as in every sentence this file builds: show them through IsolatedText.
 */
export function outcomeText(t: Translate, themeName: string, outcome: Pick<ScheduleOutcome, 'kind' | 'look'>, now = false): string {
  const name = isolated(themeName);
  if (outcome.look !== 'auto') return t(`${S}.outcome.${outcome.kind}`, { name });
  return now ? t(`${S}.outcome.autoNow.${outcome.kind}`, { name }) : t(`${S}.outcome.auto`, { name });
}

export type { ScheduleChoice };

/** The schedule screen's mode, by the rule core and main share. */
export const scheduleChoice = (data: OverlayThemes): ScheduleChoice => scheduleChoiceOf(data.mode, data.schedule.schedule.enabled);

export interface ScheduleStatus {
  readonly text: string;
  readonly detail?: string;
  // a pick holds over the schedule, so Resume schedule now applies
  readonly override: boolean;
  // what shows now by the schedule's reckoning, which a new rule starts from
  readonly outcome: ScheduleOutcome;
}

/** Why each rule that never shows does not, in words: the skipped ones, then those a later rule of the same time covers. */
export function skippedText(t: Translate, clock: ScheduleClock, data: OverlayThemes, rules: readonly ScheduleRule[]): string[] {
  const schedule = { enabled: true, rules };
  const looks = looksOf(data.themes);
  const skipped = skippedRules(schedule, looks).map(({ rule, reason }) => {
    if (reason === 'noDays') return t(`${S}.skipped.noDays`, { n: rule + 1 });
    const name = knownName(data, rules[rule]!.theme);
    const values = { n: rule + 1, time: minuteText(clock, rules[rule]!.minute) };
    return name === undefined ? t(`${S}.skipped.missingUnknown`, values) : t(`${S}.skipped.missing`, { ...values, name: isolated(name) });
  });
  return [...skipped, ...shadowedRules(schedule, looks).map((rule) => t(`${S}.skipped.shadowed`, { n: rule + 1, time: minuteText(clock, rules[rule]!.minute) }))];
}

/** The look of the fixed mode, or of the OS kind in System mode: what shows when no rule decides. */
export function ownPick(data: OverlayThemes): ScheduleOutcome {
  const kind: LookKind = data.mode === 'system' ? data.schedule.osKind : data.mode;
  return { themeId: data.preferred[kind], kind, look: kind, byOs: data.mode === 'system' };
}

/** What shows now and until when, in words, for the schedule screen's status card and the Schedule row. */
export function scheduleStatus(t: Translate, clock: ScheduleClock, data: OverlayThemes, now: number, rules?: readonly ScheduleRule[]): ScheduleStatus {
  const choice = scheduleChoice(data);
  const name = (id: string): string => themeName(data, id);
  const own = ownPick(data);
  if (choice === 'system') {
    const kind = data.schedule.osKind;
    return { text: t(`${S}.status.follow.${kind}`), detail: t(`${S}.status.followDetail.${kind}`, { dark: isolated(name(data.preferred.dark)), light: isolated(name(data.preferred.light)) }), override: false, outcome: own };
  }
  if (choice === 'off') {
    return { text: t(`${S}.status.off`, { pick: outcomeText(t, name(own.themeId), own) }), detail: t(`${S}.status.offDetail`), override: false, outcome: own };
  }
  const input = scheduleInput(data, now, rules, true);
  const skipped = skippedText(t, clock, data, input.schedule.rules).join(' ');
  const decision = decideSchedule(input);
  const zone = input.zone;
  if (decision.by === 'none') {
    const key = input.schedule.rules.length === 0 ? 'noRules' : 'noneRun';
    return { text: t(`${S}.status.${key}`, { pick: outcomeText(t, name(own.themeId), own) }), detail: skipped || t(`${S}.status.addRule`), override: false, outcome: own };
  }
  if (decision.by === 'override') {
    const { override, until } = decision;
    const pick: ScheduleOutcome = { themeId: override.themeId, kind: override.kind, look: override.kind, byOs: false };
    const then = outcomeAt(input, until);
    const thenText = then ? t(`${S}.status.then`, { next: outcomeText(t, name(then.outcome.themeId), then.outcome) }) : '';
    return {
      text: t(`${S}.status.override`, { pick: outcomeText(t, name(pick.themeId), pick), when: whenText(t, clock, until, now, zone) }),
      detail: [thenText, skipped].filter(Boolean).join(' '),
      override: true,
      outcome: pick,
    };
  }
  const active = decision.outcome;
  const next = nextChange(input, now, active);
  const activeText = outcomeText(t, name(active.themeId), active, true);
  const text = next
    ? t(`${S}.status.until`, { active: activeText, when: whenText(t, clock, next.at, now, zone), next: outcomeText(t, name(next.outcome.themeId), next.outcome) })
    : t(`${S}.status.allWeek`, { active: activeText });
  return { text, ...(skipped ? { detail: skipped } : {}), override: false, outcome: active };
}

/** "Weekdays", "Weekends", "Every day" or the short day names in the region's order, then the start time. */
export function ruleSummary(t: Translate, clock: ScheduleClock, rule: ScheduleRule): string {
  if (rule.days.length === 0) return t(`${S}.rule.noDays`);
  const key = WEEKDAYS.filter((day) => rule.days.includes(day)).join(',');
  const days = key === WEEKDAYS.join(',') ? t(`${S}.days.every`)
    : key === 'mon,tue,wed,thu,fri' ? t(`${S}.days.weekdays`)
      : key === 'sat,sun' ? t(`${S}.days.weekends`)
        : new Intl.ListFormat(clock.locale, { style: 'short', type: 'unit' }).format(weekOrder(clock).filter((day) => rule.days.includes(WEEKDAYS[day]!)).map((day) => weekdayName(clock.locale, day, 'short')));
  return t(`${S}.rule.summary`, { days, time: minuteText(clock, rule.minute) });
}
