// The theme schedule (docs/invariants.md "Desktop themes"): rules by days of the week and minute of the day, evaluated by
// state in an explicit IANA zone through Intl, never the process's default zone. Pure: main, core and the overlay share it.
import { MAX_INSTANT_MS, THEME_ID } from './limits';
import type { LookKind } from './tokens';

// ~/.damocles/themes/appearance.json, which only this computer's core writes
export const APPEARANCE_FILE = 'appearance.json';

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
// Index 0 is Monday; LocalTime.weekday uses the same numbering.
export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export type ScheduleLook = LookKind | 'auto';
export const SCHEDULE_LOOKS: readonly ScheduleLook[] = ['dark', 'light', 'auto'];
export const MAX_SCHEDULE_RULES = 48;
export const MINUTES_PER_DAY = 1440;
// Main evaluates the schedule again this often, so a change the clock made without an event shows within it.
export const THEME_TICK_MS = 30_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
// A rule with any day starts at least once a week; a date-line change can skip a whole local day.
const SCAN_DAYS = 8;

export interface ScheduleRule {
  readonly days: readonly Weekday[];
  // 0..1439, local time
  readonly minute: number;
  readonly theme: string;
  readonly look: ScheduleLook;
}

export interface ThemeSchedule {
  readonly enabled: boolean;
  readonly rules: readonly ScheduleRule[];
}

/** A pick made while the schedule runs; it shows until the first rule start after `at`. */
export interface ScheduleOverride {
  readonly themeId: string;
  readonly kind: LookKind;
  // ms since the epoch
  readonly at: number;
}

/** What appearance.json holds about the schedule. */
export interface AppearanceSchedule {
  readonly schedule: ThemeSchedule;
  readonly override?: ScheduleOverride;
}

/** Whether two schedules are on or off alike and hold the same rules in the same order. */
export function sameSchedule(a: ThemeSchedule, b: ThemeSchedule): boolean {
  return a.enabled === b.enabled && a.rules.length === b.rules.length && a.rules.every((rule, index) => {
    const other = b.rules[index]!;
    return rule.minute === other.minute && rule.theme === other.theme && rule.look === other.look && rule.days.length === other.days.length && rule.days.every((day, at) => day === other.days[at]);
  });
}

/** The schedule screen's mode: Follow the computer (System mode), Use a schedule, or Off (the fixed mode alone). */
export type ScheduleChoice = 'system' | 'schedule' | 'off';

/** System mode follows the computer and turns the schedule off; a running schedule needs a fixed mode. */
export function scheduleChoiceOf(mode: string, scheduleEnabled: boolean): ScheduleChoice {
  if (mode === 'system') return 'system';
  return scheduleEnabled ? 'schedule' : 'off';
}

export const NO_SCHEDULE: ThemeSchedule = { enabled: false, rules: [] };
export const NO_APPEARANCE_SCHEDULE: AppearanceSchedule = { schedule: NO_SCHEDULE };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isKind = (value: unknown): value is LookKind => value === 'dark' || value === 'light';

export function parseScheduleRule(raw: unknown): ScheduleRule | undefined {
  if (!isRecord(raw)) return undefined;
  const { days, minute, theme, look } = raw;
  if (!Array.isArray(days) || days.length > WEEKDAYS.length || !days.every((day) => WEEKDAYS.includes(day as Weekday))) return undefined;
  if (new Set(days).size !== days.length) return undefined;
  if (typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute >= MINUTES_PER_DAY) return undefined;
  if (typeof theme !== 'string' || !THEME_ID.test(theme)) return undefined;
  if (!SCHEDULE_LOOKS.includes(look as ScheduleLook)) return undefined;
  return { days: days as Weekday[], minute, theme, look: look as ScheduleLook };
}

/** A schedule's rules; undefined when there are too many or any of them does not hold up. */
export function parseScheduleRules(raw: unknown): ScheduleRule[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_SCHEDULE_RULES) return undefined;
  const rules = raw.map(parseScheduleRule);
  return rules.every((rule) => rule !== undefined) ? rules : undefined;
}

/** A schedule as appearance.json holds it; undefined when any part of it does not hold up. */
export function parseSchedule(raw: unknown): ThemeSchedule | undefined {
  if (!isRecord(raw) || typeof raw['enabled'] !== 'boolean') return undefined;
  const rules = parseScheduleRules(raw['rules']);
  return rules ? { enabled: raw['enabled'], rules } : undefined;
}

export function parseOverride(raw: unknown): ScheduleOverride | undefined {
  if (!isRecord(raw)) return undefined;
  const { themeId, kind, at } = raw;
  if (typeof themeId !== 'string' || !THEME_ID.test(themeId) || !isKind(kind)) return undefined;
  return typeof at === 'number' && Number.isSafeInteger(at) && at >= 0 && at <= MAX_INSTANT_MS ? { themeId, kind, at } : undefined;
}

/** appearance.json's schedule and pick; a schedule that does not hold up reads as off, and a malformed pick as none. */
export function parseAppearanceSchedule(json: unknown): AppearanceSchedule {
  if (!isRecord(json) || json['version'] !== 1) return NO_APPEARANCE_SCHEDULE;
  const schedule = parseSchedule(json['schedule']) ?? NO_SCHEDULE;
  const override = parseOverride(json['override']);
  return override ? { schedule, override } : { schedule };
}

/** Whether Intl knows `zone` as an IANA time zone. */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A calendar date with no zone: month 1..12. */
export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface LocalTime {
  readonly date: CivilDate;
  readonly minute: number;
  // 0 Monday .. 6 Sunday
  readonly weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let known = formatters.get(zone);
  if (!known) {
    known = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    formatters.set(zone, known);
  }
  return known;
}

// The local wall clock of `instant` in `zone`, as if it were UTC, to the minute.
function wall(instant: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(instant)) if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return Date.UTC(parts['year']!, parts['month']! - 1, parts['day']!, parts['hour']!, parts['minute']!);
}

const weekdayOf = (date: CivilDate): number => (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7;

/** The civil date `days` after `date`. */
export function addDays(date: CivilDate, days: number): CivilDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

export function localTime(instant: number, zone: string): LocalTime {
  const at = new Date(wall(instant, zone));
  const date = { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
  return { date, minute: at.getUTCHours() * 60 + at.getUTCMinutes(), weekday: weekdayOf(date) };
}

const floorMinute = (instant: number): number => Math.floor(instant / MINUTE_MS) * MINUTE_MS;

/**
 * The instant `zone`'s clocks read `minute` on `date`: the first of two in a fall-back overlap, and the first valid minute after
 * it when a spring-forward gap (or a skipped day) leaves that time out.
 */
export function instantAt(date: CivilDate, minute: number, zone: string): number {
  const target = Date.UTC(date.year, date.month - 1, date.day, 0, minute);
  const offsets = new Set([-DAY_MS, 0, DAY_MS].map((shift) => wall(target + shift, zone) - floorMinute(target + shift)));
  const candidates = [...offsets].map((offset) => target - offset);
  const valid = candidates.filter((instant) => wall(instant, zone) === target);
  if (valid.length > 0) return Math.min(...valid);
  // a gap: the earliest minute between the candidates whose clock reads the target or later
  let lo = Math.min(...candidates) / MINUTE_MS;
  let hi = Math.max(...candidates) / MINUTE_MS;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (wall(mid * MINUTE_MS, zone) >= target) hi = mid;
    else lo = mid + 1;
  }
  return hi * MINUTE_MS;
}

/** One start of a rule: the index of the rule in the schedule's list and its instant. */
export interface RuleStart {
  readonly rule: number;
  readonly at: number;
}

// Every start of `rules` on the local days from `from` to `to` days after `instant`'s, sorted by instant, then by the clock
// time the rule names (times a gap or a skipped day moves to one instant keep their clock order), then by rule.
function startsAround(rules: readonly ScheduleRule[], include: (index: number) => boolean, instant: number, zone: string, from: number, to: number): RuleStart[] {
  const today = localTime(instant, zone).date;
  const starts: Array<RuleStart & { readonly clock: number }> = [];
  for (let offset = from; offset <= to; offset++) {
    const date = addDays(today, offset);
    const weekday = WEEKDAYS[weekdayOf(date)]!;
    rules.forEach((rule, index) => {
      if (include(index) && rule.days.includes(weekday)) starts.push({ rule: index, at: instantAt(date, rule.minute, zone), clock: offset * MINUTES_PER_DAY + rule.minute });
    });
  }
  return starts.sort((a, b) => a.at - b.at || a.clock - b.clock || a.rule - b.rule).map(({ rule, at }) => ({ rule, at }));
}

/** The latest rule start at or before `now`; at one instant the later clock time wins, and of equal times the later rule in the list. */
export function latestStart(rules: readonly ScheduleRule[], now: number, zone: string, include: (index: number) => boolean = () => true): RuleStart | undefined {
  return startsAround(rules, include, now, zone, -SCAN_DAYS, 0).filter((start) => start.at <= now).at(-1);
}

/** The first rule start after `after`. */
export function nextStart(rules: readonly ScheduleRule[], after: number, zone: string, include: (index: number) => boolean = () => true): RuleStart | undefined {
  return startsAround(rules, include, after, zone, 0, SCAN_DAYS).find((start) => start.at > after);
}

/** Every rule start after `after` up to `until`, in order. */
export function startsBetween(rules: readonly ScheduleRule[], after: number, until: number, zone: string, include: (index: number) => boolean = () => true): RuleStart[] {
  const days = Math.ceil((until - after) / DAY_MS) + 1;
  return startsAround(rules, include, after, zone, 0, days).filter((start) => start.at > after && start.at <= until);
}

/** The looks of a theme the schedule may show; undefined when the theme is missing, broken or needs a newer Damocles. */
export type ScheduleLooks = (themeId: string) => readonly LookKind[] | undefined;

/** A rule runs when it has a day and its theme can be shown; any other is skipped and listed. */
export function ruleRuns(rule: ScheduleRule, looks: ScheduleLooks): boolean {
  return rule.days.length > 0 && (looks(rule.theme)?.length ?? 0) > 0;
}

export type SkipReason = 'missing' | 'noDays';

/** The rules the schedule skips, by index, and why. */
export function skippedRules(schedule: ThemeSchedule, looks: ScheduleLooks): Array<{ readonly rule: number; readonly reason: SkipReason }> {
  return schedule.rules.flatMap((rule, index): Array<{ readonly rule: number; readonly reason: SkipReason }> => {
    if ((looks(rule.theme)?.length ?? 0) === 0) return [{ rule: index, reason: 'missing' }];
    return rule.days.length === 0 ? [{ rule: index, reason: 'noDays' }] : [];
  });
}

/** The rules that run and never show, by index: on each of their days a later rule that runs starts at the same minute. */
export function shadowedRules(schedule: ThemeSchedule, looks: ScheduleLooks): number[] {
  const { rules } = schedule;
  return rules.flatMap((rule, index) => {
    if (!ruleRuns(rule, looks)) return [];
    const later = rules.slice(index + 1).filter((other) => other.minute === rule.minute && ruleRuns(other, looks));
    return rule.days.every((day) => later.some((other) => other.days.includes(day))) ? [index] : [];
  });
}

/** What a rule shows: its theme in a kind; byOs when the computer's kind chose it. */
export interface ScheduleOutcome {
  readonly themeId: string;
  readonly kind: LookKind;
  readonly look: ScheduleLook;
  readonly byOs: boolean;
}

/** A look named auto takes the OS kind when the theme has both; a theme with one look shows that one whatever the rule names. */
export function ruleOutcome(rule: ScheduleRule, looks: readonly LookKind[], osKind: LookKind): ScheduleOutcome {
  const both = looks.includes('dark') && looks.includes('light');
  const wanted = rule.look === 'auto' ? osKind : rule.look;
  const kind = looks.includes(wanted) ? wanted : looks[0] ?? wanted;
  return { themeId: rule.theme, kind, look: rule.look, byOs: rule.look === 'auto' && both };
}

export const sameOutcome = (a: ScheduleOutcome, b: ScheduleOutcome): boolean => a.themeId === b.themeId && a.kind === b.kind && a.look === b.look;

export interface ScheduleInput {
  readonly schedule: ThemeSchedule;
  readonly override?: ScheduleOverride | undefined;
  readonly now: number;
  readonly zone: string;
  readonly looks: ScheduleLooks;
  readonly osKind: LookKind;
}

export type ScheduleDecision =
  // the schedule is off, or no rule can run
  | { readonly by: 'none' }
  // until: the first rule start after the pick
  | { readonly by: 'override'; readonly override: ScheduleOverride; readonly until: number }
  | { readonly by: 'rule'; readonly start: RuleStart; readonly outcome: ScheduleOutcome };

function runnable(input: Pick<ScheduleInput, 'schedule' | 'looks'>): (index: number) => boolean {
  const { rules } = input.schedule;
  return (index) => ruleRuns(rules[index]!, input.looks);
}

type StartOutcome = { readonly start: RuleStart; readonly outcome: ScheduleOutcome };

function outcomeOf(input: ScheduleInput, start: RuleStart): StartOutcome {
  const rule = input.schedule.rules[start.rule]!;
  return { start, outcome: ruleOutcome(rule, input.looks(rule.theme)!, input.osKind) };
}

/** The outcome of the latest start at or before `instant`. */
export function outcomeAt(input: ScheduleInput, instant: number): { readonly start: RuleStart; readonly outcome: ScheduleOutcome } | undefined {
  const start = latestStart(input.schedule.rules, instant, input.zone, runnable(input));
  return start ? outcomeOf(input, start) : undefined;
}

// What shows from each instant after `after` up to `until` that has a start: the last start of an instant decides it. One scan
// of the days between, however many rules there are.
function outcomesBetween(input: ScheduleInput, after: number, until: number): StartOutcome[] {
  const starts = startsBetween(input.schedule.rules, after, until, input.zone, runnable(input));
  return starts.filter((start, index) => starts[index + 1]?.at !== start.at).map((start) => outcomeOf(input, start));
}

/** What the schedule shows now, by state: the pick until the next rule start after it, else the latest rule start. */
export function decideSchedule(input: ScheduleInput): ScheduleDecision {
  if (!input.schedule.enabled) return { by: 'none' };
  const include = runnable(input);
  if (!input.schedule.rules.some((_, index) => include(index))) return { by: 'none' };
  const { override } = input;
  if (override) {
    const until = nextStart(input.schedule.rules, override.at, input.zone, include)?.at;
    if (until !== undefined && input.now < until) return { by: 'override', override, until };
  }
  const active = outcomeAt(input, input.now);
  return active ? { by: 'rule', ...active } : { by: 'none' };
}

/** The first start after `after` whose outcome differs from `from`'s; undefined when every start within the scan shows it. */
export function nextChange(input: ScheduleInput, after: number, from: ScheduleOutcome): { readonly at: number; readonly outcome: ScheduleOutcome } | undefined {
  const change = outcomesBetween(input, after, after + SCAN_DAYS * DAY_MS).find(({ outcome }) => !sameOutcome(outcome, from));
  return change ? { at: change.start.at, outcome: change.outcome } : undefined;
}

/** One span of the day strip, in local minutes from midnight; pick: the override. */
export interface DaySpan {
  readonly from: number;
  readonly to: number;
  readonly outcome: ScheduleOutcome;
  readonly pick: boolean;
}

const minuteIn = (instant: number, dayStart: number, dayEnd: number, zone: string): number => (instant >= dayEnd ? MINUTES_PER_DAY : instant <= dayStart ? 0 : localTime(instant, zone).minute);

/**
 * What shows across the local day `date`: the rules' spans, with the override drawn over its own hours while it decides now,
 * or one span of `fallback` when no rule runs.
 */
export function daySpans(input: ScheduleInput, date: CivilDate, fallback: ScheduleOutcome): DaySpan[] {
  const { zone } = input;
  const dayStart = instantAt(date, 0, zone);
  const dayEnd = instantAt(addDays(date, 1), 0, zone);
  const first = outcomeAt(input, dayStart);
  if (!input.schedule.enabled || !first) return [{ from: 0, to: MINUTES_PER_DAY, outcome: fallback, pick: false }];
  let spans: DaySpan[] = [];
  let current = first.outcome;
  let from = 0;
  for (const { start, outcome: next } of outcomesBetween(input, dayStart, dayEnd - 1)) {
    if (sameOutcome(next, current)) continue;
    const at = minuteIn(start.at, dayStart, dayEnd, zone);
    if (at > from) spans.push({ from, to: at, outcome: current, pick: false });
    current = next;
    from = at;
  }
  spans.push({ from, to: MINUTES_PER_DAY, outcome: current, pick: false });
  const decision = decideSchedule(input);
  if (decision.by === 'override') {
    const pickFrom = minuteIn(Math.max(decision.override.at, dayStart), dayStart, dayEnd, zone);
    const pickTo = minuteIn(Math.min(decision.until, dayEnd), dayStart, dayEnd, zone);
    if (pickTo > pickFrom && decision.override.at < dayEnd && decision.until > dayStart) {
      const looks = input.looks(decision.override.themeId) ?? [decision.override.kind];
      const pick: ScheduleOutcome = { themeId: decision.override.themeId, kind: looks.includes(decision.override.kind) ? decision.override.kind : looks[0] ?? decision.override.kind, look: decision.override.kind, byOs: false };
      spans = [
        ...spans.flatMap((span): DaySpan[] => {
          if (span.to <= pickFrom || span.from >= pickTo) return [span];
          return [
            ...(span.from < pickFrom ? [{ ...span, to: pickFrom }] : []),
            ...(span.to > pickTo ? [{ ...span, from: pickTo }] : []),
          ];
        }),
        { from: pickFrom, to: pickTo, outcome: pick, pick: true },
      ].sort((a, b) => a.from - b.from);
    }
  }
  return spans;
}
