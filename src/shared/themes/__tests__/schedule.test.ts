import { describe, expect, it, vi } from 'vitest';
import {
  addDays, daySpans, decideSchedule, instantAt, isTimeZone, latestStart, localTime, MAX_SCHEDULE_RULES, nextChange, nextStart, parseAppearanceSchedule, parseSchedule, parseScheduleRules,
  shadowedRules, skippedRules,
  type ScheduleInput, type ScheduleRule, type Weekday,
} from '../schedule';

const utc = (year: number, month: number, day: number, hour: number, minute = 0): number => Date.UTC(year, month - 1, day, hour, minute);
const date = (year: number, month: number, day: number) => ({ year, month, day });
const hm = (hour: number, minute = 0): number => hour * 60 + minute;
const EVERY: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const rule = (minute: number, theme: string, days: Weekday[] = EVERY, look: ScheduleRule['look'] = 'dark'): ScheduleRule => ({ days, minute, theme, look });

// Each row: the zone, the local date and time a rule names, and the instant it starts.
const DST_TABLE: ReadonlyArray<readonly [string, string, ReturnType<typeof date>, number, number]> = [
  // spring forward at 02:00 EST to 03:00 EDT (07:00 UTC): 02:30 and 02:00 do not exist, 03:00 is the first valid minute
  ['America/New_York', 'gap', date(2024, 3, 10), hm(2, 30), utc(2024, 3, 10, 7)],
  ['America/New_York', 'gap start', date(2024, 3, 10), hm(2), utc(2024, 3, 10, 7)],
  ['America/New_York', 'before the gap', date(2024, 3, 10), hm(1, 59), utc(2024, 3, 10, 6, 59)],
  ['America/New_York', 'after the gap', date(2024, 3, 10), hm(3), utc(2024, 3, 10, 7)],
  // fall back at 02:00 EDT to 01:00 EST (06:00 UTC): 01:30 happens at 05:30 and 06:30 UTC, the first counts
  ['America/New_York', 'overlap', date(2024, 11, 3), hm(1, 30), utc(2024, 11, 3, 5, 30)],
  // spring forward at 03:00 EET to 04:00 EEST (01:00 UTC)
  ['Europe/Athens', 'gap', date(2024, 3, 31), hm(3, 30), utc(2024, 3, 31, 1)],
  // fall back at 04:00 EEST to 03:00 EET (01:00 UTC): 03:30 happens at 00:30 and 01:30 UTC
  ['Europe/Athens', 'overlap', date(2024, 10, 27), hm(3, 30), utc(2024, 10, 27, 0, 30)],
  ['Europe/Athens', 'plain winter', date(2024, 12, 4), hm(7), utc(2024, 12, 4, 5)],
  // Lord Howe moves by 30 minutes: 02:00 to 02:30 (+10:30 to +11) at 15:30 UTC the day before
  ['Australia/Lord_Howe', 'half-hour gap', date(2024, 10, 6), hm(2, 15), utc(2024, 10, 5, 15, 30)],
  // back from 02:00 +11 to 01:30 +10:30 at 15:00 UTC: 01:45 happens at 14:45 and 15:15 UTC
  ['Australia/Lord_Howe', 'half-hour overlap', date(2024, 4, 7), hm(1, 45), utc(2024, 4, 6, 14, 45)],
  // Samoa skipped 30 December 2011 to cross the date line: its first valid minute after is 31 December 00:00 (+14)
  ['Pacific/Apia', 'skipped day', date(2011, 12, 30), hm(9), utc(2011, 12, 30, 10)],
  ['Pacific/Apia', 'the day before', date(2011, 12, 29), hm(9), utc(2011, 12, 29, 19)],
  ['Pacific/Apia', 'the day after', date(2011, 12, 31), hm(9), utc(2011, 12, 30, 19)],
  // no daylight saving: always +05:30
  ['Asia/Kolkata', 'no DST', date(2024, 3, 10), hm(7), utc(2024, 3, 10, 1, 30)],
  ['Asia/Kolkata', 'no DST in autumn', date(2024, 11, 3), hm(1, 30), utc(2024, 11, 2, 20)],
];

describe('instantAt', () => {
  it.each(DST_TABLE)('%s, %s', (zone, _case, day, minute, expected) => {
    expect(instantAt(day, minute, zone)).toBe(expected);
  });

  it('reads the local time back in the zone it was given', () => {
    expect(localTime(utc(2024, 3, 10, 7), 'America/New_York')).toEqual({ date: date(2024, 3, 10), minute: hm(3), weekday: 6 });
    expect(localTime(utc(2024, 3, 10, 7), 'Asia/Kolkata')).toEqual({ date: date(2024, 3, 10), minute: hm(12, 30), weekday: 6 });
  });
});

describe('rule starts', () => {
  it('a rule inside a gap fires at the first valid minute after it', () => {
    const rules = [rule(hm(2, 30), 'gap', ['sun'])];
    // New York, Sunday 10 March 2024
    expect(latestStart(rules, utc(2024, 3, 10, 6, 59), 'America/New_York')!.at).toBe(utc(2024, 3, 3, 7, 30));
    expect(latestStart(rules, utc(2024, 3, 10, 7), 'America/New_York')!.at).toBe(utc(2024, 3, 10, 7));
    expect(nextStart(rules, utc(2024, 3, 10, 6), 'America/New_York')!.at).toBe(utc(2024, 3, 10, 7));
  });

  it('a rule inside an overlap fires once, at the first occurrence', () => {
    const rules = [rule(hm(1, 30), 'overlap', ['sun'])];
    const zone = 'America/New_York';
    // during the second 01:30 (06:30 UTC) the latest start is still the first one, and none comes after it until next week
    expect(latestStart(rules, utc(2024, 11, 3, 5, 45), zone)!.at).toBe(utc(2024, 11, 3, 5, 30));
    expect(latestStart(rules, utc(2024, 11, 3, 6, 45), zone)!.at).toBe(utc(2024, 11, 3, 5, 30));
    expect(nextStart(rules, utc(2024, 11, 3, 5, 30), zone)!.at).toBe(utc(2024, 11, 10, 6, 30));
  });

  it('the latest start at or before now wins, and at one instant the later rule in the list', () => {
    const zone = 'Asia/Kolkata';
    const rules = [rule(hm(7), 'day'), rule(hm(19), 'night'), rule(hm(19), 'later')];
    expect(latestStart(rules, utc(2024, 3, 10, 13, 30), zone)).toEqual({ rule: 2, at: utc(2024, 3, 10, 13, 30) });
    expect(latestStart(rules, utc(2024, 3, 10, 13, 29), zone)).toEqual({ rule: 0, at: utc(2024, 3, 10, 1, 30) });
  });

  it('two rules inside one gap keep their clock order, whatever their order in the list', () => {
    const zone = 'America/New_York';
    // Sunday 8 March 2026: 02:30 does not exist, so it and 03:00 both start at 07:00 UTC
    const gap = utc(2026, 3, 8, 7);
    expect(latestStart([rule(hm(3), 'b'), rule(hm(2, 30), 'a')], gap, zone)).toEqual({ rule: 0, at: gap });
    expect(latestStart([rule(hm(2, 30), 'a'), rule(hm(3), 'b')], utc(2026, 3, 8, 20), zone)).toEqual({ rule: 1, at: gap });
    // two times inside the gap: the later one
    expect(latestStart([rule(hm(2, 45), 'b'), rule(hm(2, 15), 'a')], gap, zone)).toEqual({ rule: 0, at: gap });
    // equal times: the later rule in the list
    expect(latestStart([rule(hm(2, 30), 'a'), rule(hm(2, 30), 'b')], gap, zone)).toEqual({ rule: 1, at: gap });
  });

  it('a rule of a skipped day comes before the next day\'s first minute', () => {
    // Samoa skipped 30 December 2011, so that day's 09:00 and 31 December's 00:00 are one instant
    const rules = [rule(0, 'midnight'), rule(hm(9), 'skipped')];
    expect(latestStart(rules, utc(2011, 12, 30, 10), 'Pacific/Apia')).toEqual({ rule: 0, at: utc(2011, 12, 30, 10) });
  });

  it('a week with a daylight saving change keeps every rule at its local time, on both sides of the change', () => {
    const zone = 'America/New_York';
    const rules = [rule(hm(7), 'day'), rule(hm(19), 'night')];
    // Saturday 9 March 2024 is UTC-5; the clocks go forward on Sunday the 10th, which is UTC-4 from 03:00
    expect(latestStart(rules, utc(2024, 3, 9, 12, 30), zone)).toEqual({ rule: 0, at: utc(2024, 3, 9, 12) });
    expect(latestStart(rules, utc(2024, 3, 10, 10, 59), zone)).toEqual({ rule: 1, at: utc(2024, 3, 10, 0) });
    // Saturday's night lasts 11 hours, an hour less than any other
    expect(nextStart(rules, utc(2024, 3, 10, 0), zone)!.at).toBe(utc(2024, 3, 10, 11));
    expect(latestStart(rules, utc(2024, 3, 10, 11), zone)).toEqual({ rule: 0, at: utc(2024, 3, 10, 11) });
    expect(nextStart(rules, utc(2024, 3, 10, 11), zone)!.at).toBe(utc(2024, 3, 10, 23));
    expect(nextStart(rules, utc(2024, 3, 10, 23), zone)!.at).toBe(utc(2024, 3, 11, 11));
  });

  it('a Sunday rule carries past midnight into Monday, and a Monday rule through the week to the next Sunday', () => {
    const zone = 'Asia/Kolkata';
    const rules = [rule(hm(22), 'sunday night', ['sun']), rule(hm(7), 'monday', ['mon'])];
    // Sunday 10 March 2024, 22:00 in Kolkata is 16:30 UTC; Monday 07:00 is 01:30 UTC
    const sunday = utc(2024, 3, 10, 16, 30);
    const monday = utc(2024, 3, 11, 1, 30);
    // Monday 00:30 and 06:59: Sunday's rule still shows
    expect(latestStart(rules, utc(2024, 3, 10, 19), zone)).toEqual({ rule: 0, at: sunday });
    expect(latestStart(rules, monday - 60_000, zone)).toEqual({ rule: 0, at: sunday });
    expect(latestStart(rules, monday, zone)).toEqual({ rule: 1, at: monday });
    // the next Sunday at 21:59 Monday's rule has shown for six days, and Sunday's starts a minute later
    const nextSunday = utc(2024, 3, 17, 16, 30);
    expect(latestStart(rules, nextSunday - 60_000, zone)).toEqual({ rule: 1, at: monday });
    expect(nextStart(rules, nextSunday - 60_000, zone)!.at).toBe(nextSunday);
    expect(latestStart(rules, nextSunday, zone)).toEqual({ rule: 0, at: nextSunday });
  });

  it('a rule for one day of the week starts within the last week', () => {
    const rules = [rule(hm(9), 'weekly', ['mon'])];
    // Sunday 10 March 2024 in Kolkata: the latest start is Monday the 4th
    expect(latestStart(rules, utc(2024, 3, 10, 12), 'Asia/Kolkata')!.at).toBe(utc(2024, 3, 4, 3, 30));
  });
});

describe('decideSchedule', () => {
  const zone = 'Europe/Athens';
  const looks = (id: string): readonly ('dark' | 'light')[] | undefined => ({ day: ['light'], night: ['dark'], both: ['dark', 'light'] } as Record<string, ('dark' | 'light')[]>)[id];
  const input = (now: number, more: Partial<ScheduleInput> = {}): ScheduleInput => ({
    schedule: { enabled: true, rules: [rule(hm(7), 'day', EVERY, 'light'), rule(hm(19), 'night'), rule(hm(12), 'gone')] },
    now, zone, looks, osKind: 'dark', ...more,
  });
  // Athens in June is UTC+3
  const athens = (day: number, hour: number, minute = 0): number => utc(2024, 6, day, hour - 3, minute);

  it('is state based: the same instant gives the same answer whatever was evaluated before, the clock moving backwards included', () => {
    const late = decideSchedule(input(athens(12, 20)));
    const early = decideSchedule(input(athens(12, 8)));
    expect(late).toMatchObject({ by: 'rule', outcome: { themeId: 'night', kind: 'dark' } });
    expect(early).toMatchObject({ by: 'rule', outcome: { themeId: 'day', kind: 'light' } });
    expect(decideSchedule(input(athens(12, 20)))).toEqual(late);
  });

  it('skips and lists rules whose theme is missing or that have no days', () => {
    const rules = [...input(0).schedule.rules, rule(hm(8), 'day', [])];
    expect(skippedRules({ enabled: true, rules }, looks)).toEqual([{ rule: 2, reason: 'missing' }, { rule: 3, reason: 'noDays' }]);
    // 12:00 names the missing theme, so 07:00 still decides at 13:00
    expect(decideSchedule(input(athens(12, 13)))).toMatchObject({ by: 'rule', start: { rule: 0 } });
    expect(decideSchedule(input(athens(12, 13), { schedule: { enabled: true, rules: [rule(hm(1), 'gone')] } }))).toEqual({ by: 'none' });
    expect(decideSchedule(input(athens(12, 13), { schedule: { enabled: false, rules: input(0).schedule.rules } }))).toEqual({ by: 'none' });
  });

  it('holds a pick until the first rule start after it, then the schedule decides again', () => {
    const override = { themeId: 'both', kind: 'light' as const, at: athens(12, 19, 52) };
    expect(decideSchedule(input(athens(12, 20, 15), { override }))).toEqual({ by: 'override', override, until: athens(13, 7) });
    expect(decideSchedule(input(athens(13, 7), { override }))).toMatchObject({ by: 'rule', outcome: { themeId: 'day' } });
  });

  it('takes the OS kind for auto when the theme has both looks, and the look a one-look theme has', () => {
    const auto = (id: string, osKind: 'dark' | 'light') => decideSchedule(input(athens(12, 10), { osKind, schedule: { enabled: true, rules: [rule(hm(9), id, EVERY, 'auto')] } }));
    expect(auto('both', 'light')).toMatchObject({ outcome: { kind: 'light', byOs: true } });
    expect(auto('both', 'dark')).toMatchObject({ outcome: { kind: 'dark', byOs: true } });
    expect(auto('night', 'light')).toMatchObject({ outcome: { kind: 'dark', byOs: false } });
  });

  it('names the next change, skipping starts that show the same look', () => {
    const rules = [rule(hm(7), 'day', EVERY, 'light'), rule(hm(19), 'night'), rule(hm(21), 'night')];
    const now = athens(12, 20);
    const decision = decideSchedule(input(now, { schedule: { enabled: true, rules } }));
    expect(decision.by).toBe('rule');
    if (decision.by === 'rule') expect(nextChange(input(now, { schedule: { enabled: true, rules } }), now, decision.outcome)).toMatchObject({ at: athens(13, 7), outcome: { themeId: 'day' } });
  });

  it('lets the last rule of one instant decide it, for the next change and the day\'s spans alike', () => {
    // at 19:00 the later rule in the list shows the day theme again, so nothing changes there
    const schedule = { enabled: true, rules: [rule(hm(7), 'day', EVERY, 'light'), rule(hm(19), 'night'), rule(hm(19), 'day', EVERY, 'light'), rule(hm(22), 'night')] };
    const now = athens(12, 8);
    const decision = decideSchedule(input(now, { schedule }));
    expect(decision).toMatchObject({ by: 'rule', outcome: { themeId: 'day' } });
    if (decision.by === 'rule') expect(nextChange(input(now, { schedule }), now, decision.outcome)).toMatchObject({ at: athens(12, 22), outcome: { themeId: 'night' } });
    const spans = daySpans(input(now, { schedule }), date(2024, 6, 12), { themeId: 'damocles', kind: 'dark', look: 'dark', byOs: false });
    expect(spans.map(({ from, to, outcome }) => [from, to, outcome.themeId])).toEqual([[0, hm(7), 'night'], [hm(7), hm(22), 'day'], [hm(22), 1440, 'night']]);
  });

  it('reads the clock a number of times that grows with the rules, not with their square', () => {
    // 48 rules that all show one look: no start changes anything, so every one of them is looked at
    const rules = Array.from({ length: MAX_SCHEDULE_RULES }, (_, i) => rule(i * 30, 'night'));
    const given = input(athens(12, 8), { schedule: { enabled: true, rules } });
    const night = { themeId: 'night', kind: 'dark', look: 'dark', byOs: false } as const;
    const reads = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      expect(nextChange(given, given.now, night)).toBeUndefined();
      // four readings place a rule on a day, over the ten local days the scan covers
      expect(reads.mock.calls.length).toBeLessThan(MAX_SCHEDULE_RULES * 10 * 4 + 20);
      reads.mockClear();
      expect(daySpans(given, date(2024, 6, 12), night)).toEqual([{ from: 0, to: 1440, outcome: night, pick: false }]);
      // the state before the day and the decision now scan nine days each, the day itself three
      expect(reads.mock.calls.length).toBeLessThan(MAX_SCHEDULE_RULES * (9 + 9 + 3) * 4 + 40);
    } finally {
      reads.mockRestore();
    }
  });

  it('draws a whole week of the most rules a schedule holds within seven times one day\'s readings', () => {
    // 48 rules, each its own look: every start is a span, on every day
    const rules = Array.from({ length: MAX_SCHEDULE_RULES }, (_, i) => rule(i * 30, i % 2 === 0 ? 'night' : 'day', EVERY, i % 2 === 0 ? 'dark' : 'light'));
    const given = input(athens(12, 8), { schedule: { enabled: true, rules } });
    const fallback = { themeId: 'damocles', kind: 'dark', look: 'dark', byOs: false } as const;
    const reads = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      const week = Array.from({ length: 7 }, (_, day) => daySpans(given, addDays(date(2024, 6, 10), day), fallback));
      expect(week.every((spans) => spans.length === MAX_SCHEDULE_RULES)).toBe(true);
      // per day: the scans the test above bounds, and one reading for each span's start
      expect(reads.mock.calls.length).toBeLessThan(7 * (MAX_SCHEDULE_RULES * ((9 + 9 + 3) * 4 + 1) + 40));
    } finally {
      reads.mockRestore();
    }
  });

  it('names the rules that run and never show: on each of their days a later rule starts at the same minute', () => {
    const rules = [
      rule(hm(7), 'day', ['mon', 'tue']),
      rule(hm(7), 'night', ['mon']),
      rule(hm(7), 'both', ['tue', 'wed']),
      rule(hm(8), 'day', ['mon', 'tue']),
    ];
    // rule 1 is covered on Monday by rule 2 and on Tuesday by rule 3; rule 2 keeps Monday, rule 3 is last
    expect(shadowedRules({ enabled: true, rules }, looks)).toEqual([0]);
    // a later rule that is skipped covers nothing, and a skipped rule is listed as skipped, not as covered
    expect(shadowedRules({ enabled: true, rules: [rule(hm(7), 'day'), rule(hm(7), 'gone')] }, looks)).toEqual([]);
    expect(shadowedRules({ enabled: true, rules: [rule(hm(7), 'gone'), rule(hm(7), 'day')] }, looks)).toEqual([]);
    expect(shadowedRules({ enabled: true, rules: [rule(hm(7), 'day', []), rule(hm(7), 'night')] }, looks)).toEqual([]);
    // the same days at another minute cover nothing
    expect(shadowedRules({ enabled: true, rules: [rule(hm(7), 'day'), rule(hm(7, 1), 'night')] }, looks)).toEqual([]);
    expect(shadowedRules({ enabled: true, rules: [rule(hm(7), 'day'), rule(hm(7), 'night')] }, looks)).toEqual([0]);
  });

  it('draws the day as spans in local minutes, with the pick over its hours', () => {
    const override = { themeId: 'both', kind: 'dark' as const, at: athens(12, 19, 52) };
    const spans = daySpans(input(athens(12, 20, 15), { override }), date(2024, 6, 12), { themeId: 'damocles', kind: 'dark', look: 'dark', byOs: false });
    expect(spans.map(({ from, to, outcome, pick }) => [from, to, outcome.themeId, pick])).toEqual([
      [0, hm(7), 'night', false],
      [hm(7), hm(19), 'day', false],
      [hm(19), hm(19, 52), 'night', false],
      [hm(19, 52), 1440, 'both', true],
    ]);
  });
});

describe('parsing appearance.json', () => {
  it('reads a schedule that holds up, and turns anything else off', () => {
    const schedule = { enabled: true, rules: [{ days: ['mon'], minute: 420, theme: 'damocles', look: 'auto' }] };
    expect(parseAppearanceSchedule({ version: 1, schedule, override: { themeId: 'damocles', kind: 'dark', at: 5 } })).toEqual({ schedule, override: { themeId: 'damocles', kind: 'dark', at: 5 } });
    expect(parseSchedule({ enabled: true, rules: [{ days: ['mon', 'mon'], minute: 420, theme: 'damocles', look: 'auto' }] })).toBeUndefined();
    expect(parseSchedule({ enabled: true, rules: [{ days: ['mon'], minute: 1440, theme: 'damocles', look: 'auto' }] })).toBeUndefined();
    expect(parseAppearanceSchedule({ version: 2, schedule })).toEqual({ schedule: { enabled: false, rules: [] } });
    // the rules alone, as the schedule screen sends them
    expect(parseScheduleRules(schedule.rules)).toEqual(schedule.rules);
    expect(parseScheduleRules([])).toEqual([]);
    expect(parseScheduleRules(Array.from({ length: MAX_SCHEDULE_RULES + 1 }, () => schedule.rules[0]))).toBeUndefined();
    expect(parseScheduleRules([{ ...schedule.rules[0], look: 'dim' }])).toBeUndefined();
    expect(parseScheduleRules({ length: 0 })).toBeUndefined();
    expect(parseAppearanceSchedule({ version: 1, schedule, override: { themeId: '../x', kind: 'dark', at: 1 } })).toEqual({ schedule });
  });

  it('reads a pick whose time is no instant the schedule can scan from as none', () => {
    const schedule = { enabled: true, rules: [{ days: ['mon'], minute: 420, theme: 'damocles', look: 'auto' }] };
    const latest = Date.UTC(9999, 11, 31);
    for (const at of [1e300, 8.64e15, latest + 1, 1.5, -1, Number.NaN]) {
      expect(parseAppearanceSchedule({ version: 1, schedule, override: { themeId: 'damocles', kind: 'dark', at } })).toEqual({ schedule });
    }
    const parsed = parseAppearanceSchedule({ version: 1, schedule, override: { themeId: 'damocles', kind: 'dark', at: latest } });
    expect(parsed.override?.at).toBe(latest);
    // the latest pick it reads still decides, at that instant and now
    for (const now of [latest, utc(2024, 6, 12, 8)]) {
      expect(decideSchedule({ ...parsed, now, zone: 'Pacific/Kiritimati', looks: () => ['dark'], osKind: 'dark' }).by).not.toBe('none');
    }
  });

  it('takes a theme id only in the lowercase form every theme has', () => {
    const rules = (theme: string) => ({ enabled: true, rules: [{ days: ['mon'], minute: 420, theme, look: 'auto' }] });
    expect(parseSchedule(rules('3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f809a1b'))).toBeDefined();
    expect(parseSchedule(rules('3F1C2A4E-9B7D-4C1E-8A2F-5D6E7F809A1B'))).toBeUndefined();
    expect(parseAppearanceSchedule({ version: 1, schedule: rules('damocles'), override: { themeId: 'Damocles', kind: 'dark', at: 1 } }).override).toBeUndefined();
  });

  it('knows an IANA zone from anything else', () => {
    expect(isTimeZone('Europe/Athens')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
    expect(isTimeZone(3)).toBe(false);
  });
});
