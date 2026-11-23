import { describe, expect, it } from 'vitest';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import { isolated, withoutIsolates } from '@shared/bidi-isolate';
import type { ScheduleRule, Weekday } from '@shared/themes/schedule';
import type { ThemeFile } from '@shared/themes/schema';
import type { OverlayThemes } from '../../preload/overlay-channels';
import {
  clockOf, hourText, minuteText, ruleSummary, scheduleClock, scheduleStatus, skippedText, timeText, weekdayName, weekOrder, whenText, type ScheduleClock,
} from '../overlay/settings/themes/schedule-text';

// The schedule screen's words: every time in the hour cycle of the operating system's region and the UI's language, the week
// from that region's first day, and each branch of the status sentence.

// A stand-in for vue-i18n's t: the key's last two parts and the values, so a test reads which sentence was chosen and with what.
const marked = (key: string, values: Record<string, unknown> = {}): string => {
  const name = key.replace('settingsHost.schedule.', '');
  const given = Object.entries(values).map(([field, value]) => `${field}=${String(value)}`).join(' ');
  return given ? `${name}[${given}]` : name;
};
// Without the marks around each theme name, which one test below reads from `marked`.
const t = (key: string, values: Record<string, unknown> = {}): string => withoutIsolates(marked(key, values));

const EVERY: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const NIGHT_ID = '0b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10';
const DAY_ID = '1b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10';
const GONE_ID = '2b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10';
const NIGHT: ThemeFile = { schemaVersion: 1, id: NIGHT_ID, name: 'Night', looks: { dark: BUILTIN_THEME.looks.dark! } };
const DAY: ThemeFile = { schemaVersion: 1, id: DAY_ID, name: 'Day', looks: { light: BUILTIN_THEME.looks.light! } };
const rule = (hour: number, theme: string, days: Weekday[] = EVERY, look: ScheduleRule['look'] = 'auto'): ScheduleRule => ({ days, minute: hour * 60, theme, look });
// Wednesday 12 June 2024 in Athens, UTC+3
const athens = (day: number, hour: number, minute = 0): number => Date.UTC(2024, 5, day, hour - 3, minute);
const NOW = athens(12, 20, 15);

function data(more: Partial<OverlayThemes> & { rules?: ScheduleRule[]; enabled?: boolean; override?: OverlayThemes['schedule']['override']; systemLocale?: string } = {}): OverlayThemes {
  const { rules, enabled, override, systemLocale, ...rest } = more;
  return {
    themes: [
      { status: 'ok', id: BUILTIN_THEME.id, name: BUILTIN_THEME.name, builtin: true, theme: BUILTIN_THEME },
      { status: 'ok', id: NIGHT_ID, name: 'Night', builtin: false, theme: NIGHT },
      { status: 'ok', id: DAY_ID, name: 'Day', builtin: false, theme: DAY },
    ],
    shown: { themeId: NIGHT_ID, kind: 'dark', decidedBy: 'schedule' },
    preferred: { dark: NIGHT_ID, light: DAY_ID },
    mode: 'dark',
    schedule: {
      schedule: { enabled: enabled ?? true, rules: rules ?? [rule(7, DAY_ID), rule(19, NIGHT_ID)] },
      ...(override ? { override } : {}),
      now: NOW, zone: 'Europe/Athens', osKind: 'dark', systemLocale: systemLocale ?? 'en-GB',
    },
    history: [],
    ...rest,
  };
}

const H24: ScheduleClock = { locale: 'en', hour12: false, firstDay: 0 };
const H12: ScheduleClock = { locale: 'en', hour12: true, firstDay: 6 };

describe('the clock of the operating system\'s region', () => {
  it('takes the hour cycle and the week\'s first day from the system locale, and the language from the UI', () => {
    expect(scheduleClock('en', 'en-GB')).toEqual({ locale: 'en', hour12: false, firstDay: 0 });
    expect(scheduleClock('en', 'en-US')).toEqual({ locale: 'en', hour12: true, firstDay: 6 });
    expect(scheduleClock('en', 'de-DE')).toEqual({ locale: 'en', hour12: false, firstDay: 0 });
    // Greece writes a 12-hour clock and starts the week on Monday
    expect(scheduleClock('el', 'el-GR')).toEqual({ locale: 'el', hour12: true, firstDay: 0 });
    // an English UI in Greece keeps Greece's clock and week
    expect(scheduleClock('en', 'el-GR')).toEqual({ locale: 'en', hour12: true, firstDay: 0 });
  });

  it('falls back to the UI\'s language for a system locale Intl cannot read', () => {
    expect(scheduleClock('el', 'not a locale')).toEqual(scheduleClock('el', 'el'));
    expect(scheduleClock('en', '')).toEqual(scheduleClock('en', 'en'));
  });

  // Takes Intl.Locale's week data away for `run`: the standard's method, and with `accessor` false the older accessor too.
  function withoutWeekInfo(accessor: { readonly get: (() => unknown) | undefined }, run: () => void): void {
    const proto = Intl.Locale.prototype as unknown as Record<string, unknown>;
    const method = Object.getOwnPropertyDescriptor(proto, 'getWeekInfo');
    const older = Object.getOwnPropertyDescriptor(proto, 'weekInfo');
    delete proto['getWeekInfo'];
    delete proto['weekInfo'];
    if (accessor.get) Object.defineProperty(proto, 'weekInfo', { configurable: true, get: accessor.get });
    try {
      run();
    } finally {
      delete proto['weekInfo'];
      if (method) Object.defineProperty(proto, 'getWeekInfo', method);
      if (older) Object.defineProperty(proto, 'weekInfo', older);
    }
  }

  it('starts the week on Monday where the engine has no week data', () => {
    withoutWeekInfo({ get: undefined }, () => expect(scheduleClock('en', 'en-US').firstDay).toBe(0));
    expect(scheduleClock('en', 'en-US').firstDay).toBe(6);
  });

  it('reads the older weekInfo accessor where the method is missing, and takes no first day outside 1 to 7', () => {
    withoutWeekInfo({ get: () => ({ firstDay: 6 }) }, () => expect(scheduleClock('en', 'en-GB').firstDay).toBe(5));
    withoutWeekInfo({ get: () => ({ firstDay: 0 }) }, () => expect(scheduleClock('en', 'en-GB').firstDay).toBe(0));
    withoutWeekInfo({ get: () => ({}) }, () => expect(scheduleClock('en', 'en-US').firstDay).toBe(0));
  });

  it('is the clock main names in the data, and the UI language\'s own before the data came', () => {
    expect(clockOf('en', data({ systemLocale: 'en-US' }))).toEqual(H12);
    expect(clockOf('en', data({ systemLocale: 'en-GB' }))).toEqual(H24);
    expect(clockOf('el', undefined)).toEqual(scheduleClock('el', 'el'));
  });

  it('orders the week from the region\'s first day, as indexes into the stored Monday-first order', () => {
    expect(weekOrder(H24)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(weekOrder(H12)).toEqual([6, 0, 1, 2, 3, 4, 5]);
    expect(weekOrder({ ...H24, firstDay: 5 })).toEqual([5, 6, 0, 1, 2, 3, 4]);
  });
});

describe('times and days in words', () => {
  it('writes an instant in the zone, in the clock\'s hour cycle', () => {
    expect(timeText(H24, athens(12, 7), 'Europe/Athens')).toBe('07:00');
    expect(timeText(H24, athens(12, 19, 5), 'Europe/Athens')).toBe('19:05');
    expect(timeText(H12, athens(12, 7), 'Europe/Athens')).toBe('7:00 AM');
    expect(timeText(H12, athens(12, 19, 5), 'Europe/Athens')).toBe('7:05 PM');
    expect(timeText(H24, athens(12, 7), 'America/New_York')).toBe('00:00');
    expect(timeText({ locale: 'el', hour12: true, firstDay: 0 }, athens(12, 19), 'Europe/Athens')).toBe('7:00 μ.μ.');
  });

  it('writes a minute of the day, the day\'s end as 24:00 on a 24-hour clock and as midnight on a 12-hour one', () => {
    expect(minuteText(H24, 0)).toBe('00:00');
    expect(minuteText(H24, 7 * 60 + 30)).toBe('07:30');
    expect(minuteText(H24, 1440)).toBe('24:00');
    expect(minuteText(H12, 0)).toBe('12:00 AM');
    expect(minuteText(H12, 12 * 60)).toBe('12:00 PM');
    expect(minuteText(H12, 21 * 60)).toBe('9:00 PM');
    expect(minuteText(H12, 1440)).toBe('12:00 AM');
  });

  it('writes the day strip\'s hours as two digits, or with the day period on a 12-hour clock', () => {
    expect([0, 6, 12, 18, 24].map((hour) => hourText(H24, hour))).toEqual(['00', '06', '12', '18', '24']);
    expect([0, 6, 12, 18, 24].map((hour) => hourText(H12, hour))).toEqual(['12 AM', '6 AM', '12 PM', '6 PM', '12 AM']);
  });

  it('names a day by its place in the stored order, in the UI\'s language', () => {
    expect(weekdayName('en', 0)).toBe('Monday');
    expect(weekdayName('en', 6, 'short')).toBe('Sun');
    expect(weekdayName('el', 2)).toBe('Τετάρτη');
  });

  it('says when by the civil days between two instants in the zone', () => {
    const zone = 'Europe/Athens';
    expect(whenText(t, H24, athens(12, 21), NOW, zone)).toBe('when.today[time=21:00]');
    expect(whenText(t, H24, athens(13, 7), NOW, zone)).toBe('when.tomorrow[time=07:00]');
    // 00:30 on the 13th is tomorrow though it is under five hours away
    expect(whenText(t, H24, athens(13, 0, 30), NOW, zone)).toBe('when.tomorrow[time=00:30]');
    expect(whenText(t, H24, athens(15, 9), NOW, zone)).toBe('when.weekday[day=Saturday time=09:00]');
    expect(whenText(t, H24, athens(19, 9), NOW, zone)).toBe('when.nextWeek[day=Wednesday time=09:00]');
    expect(whenText(t, H12, athens(13, 7), NOW, zone)).toBe('when.tomorrow[time=7:00 AM]');
    // the same instant is another civil day in another zone
    expect(whenText(t, H24, athens(13, 0, 30), NOW, 'America/New_York')).toBe('when.today[time=17:30]');
  });

  it('sums a rule up as its days and its start time, the days in the region\'s order', () => {
    expect(ruleSummary(t, H24, rule(7, DAY_ID))).toBe('rule.summary[days=days.every time=07:00]');
    expect(ruleSummary(t, H24, rule(7, DAY_ID, ['mon', 'tue', 'wed', 'thu', 'fri']))).toBe('rule.summary[days=days.weekdays time=07:00]');
    expect(ruleSummary(t, H12, rule(9, DAY_ID, ['sun', 'sat']))).toBe('rule.summary[days=days.weekends time=9:00 AM]');
    expect(ruleSummary(t, H24, rule(7, DAY_ID, ['sun', 'mon', 'wed']))).toBe('rule.summary[days=Mon, Wed, Sun time=07:00]');
    expect(ruleSummary(t, H12, rule(7, DAY_ID, ['sun', 'mon', 'wed']))).toBe('rule.summary[days=Sun, Mon, Wed time=7:00 AM]');
    expect(ruleSummary(t, H24, rule(7, DAY_ID, []))).toBe('rule.noDays');
  });
});

describe('the rules that never show, in words', () => {
  it('lists a rule with no days, a rule whose theme is missing with its name while one is known, and a rule a later one covers', () => {
    const rules = [rule(7, DAY_ID, []), rule(8, GONE_ID), rule(9, 'damocles'), rule(9, NIGHT_ID)];
    expect(skippedText(t, H24, data(), rules)).toEqual([
      'skipped.noDays[n=1]',
      'skipped.missingUnknown[n=2 time=08:00]',
      'skipped.shadowed[n=3 time=09:00]',
    ]);
    const broken = data({ themes: [...data().themes, { status: 'broken', id: GONE_ID, name: 'Dusk', reason: 'no' }] });
    expect(skippedText(t, H12, broken, [rule(8, GONE_ID)])).toEqual(['skipped.missing[n=1 time=8:00 AM name=Dusk]']);
    expect(skippedText(t, H24, data(), [rule(7, DAY_ID), rule(19, NIGHT_ID)])).toEqual([]);
  });
});

describe('the schedule\'s status', () => {
  it('follows the computer in System mode', () => {
    const status = scheduleStatus(t, H24, data({ mode: 'system', enabled: false }), NOW);
    expect(status.text).toBe('status.follow.dark');
    expect(status.detail).toBe('status.followDetail.dark[dark=Night light=Day]');
    expect(status).toMatchObject({ override: false, outcome: { themeId: NIGHT_ID, kind: 'dark', byOs: true } });
  });

  // IsolatedText draws each marked run as a bdi element, so a name written right to left keeps the words beside it in place
  it('marks every theme name in its sentences as user text', () => {
    expect(scheduleStatus(marked, H24, data({ mode: 'system', enabled: false }), NOW).detail).toBe(`status.followDetail.dark[dark=${isolated('Night')} light=${isolated('Day')}]`);
    expect(scheduleStatus(marked, H24, data({ mode: 'light', enabled: false }), NOW).text).toBe(`status.off[pick=outcome.light[name=${isolated('Day')}]]`);
    const broken = data({ themes: [...data().themes, { status: 'broken', id: GONE_ID, name: 'Gone', reason: 'no' }] });
    expect(skippedText(marked, H24, broken, [rule(8, GONE_ID)])[0]).toContain(`name=${isolated('Gone')}`);
  });

  it('says Off with the fixed mode\'s own pick', () => {
    const status = scheduleStatus(t, H24, data({ mode: 'light', enabled: false }), NOW);
    expect(status.text).toBe('status.off[pick=outcome.light[name=Day]]');
    expect(status.detail).toBe('status.offDetail');
    expect(status.outcome).toEqual({ themeId: DAY_ID, kind: 'light', look: 'light', byOs: false });
  });

  it('says there are no rules, or that none can run and why', () => {
    const none = scheduleStatus(t, H24, data({ rules: [] }), NOW);
    expect(none.text).toBe('status.noRules[pick=outcome.dark[name=Night]]');
    expect(none.detail).toBe('status.addRule');
    const skipped = scheduleStatus(t, H24, data({ rules: [rule(7, DAY_ID, []), rule(8, GONE_ID)] }), NOW);
    expect(skipped.text).toBe('status.noneRun[pick=outcome.dark[name=Night]]');
    expect(skipped.detail).toBe('skipped.noDays[n=1] skipped.missingUnknown[n=2 time=08:00]');
    expect(skipped.outcome.themeId).toBe(NIGHT_ID);
  });

  it('says what shows now and until when, and what shows next', () => {
    const status = scheduleStatus(t, H24, data(), NOW);
    expect(status.text).toBe('status.until[active=outcome.autoNow.dark[name=Night] when=when.tomorrow[time=07:00] next=outcome.auto[name=Day]]');
    expect(status.detail).toBeUndefined();
    expect(status).toMatchObject({ override: false, outcome: { themeId: NIGHT_ID, kind: 'dark', look: 'auto' } });
    // on a 12-hour clock the same sentence carries the 12-hour time
    expect(scheduleStatus(t, H12, data(), NOW).text).toContain('when=when.tomorrow[time=7:00 AM]');
  });

  it('says all week when every rule picks what shows', () => {
    const status = scheduleStatus(t, H24, data({ rules: [rule(7, NIGHT_ID), rule(19, NIGHT_ID)] }), NOW);
    expect(status.text).toBe('status.allWeek[active=outcome.autoNow.dark[name=Night]]');
  });

  it('says a pick holds until the next rule start, and what shows then', () => {
    const status = scheduleStatus(t, H24, data({ override: { themeId: 'damocles', kind: 'light', at: athens(12, 20) } }), NOW);
    expect(status.text).toBe('status.override[pick=outcome.light[name=Damocles] when=when.tomorrow[time=07:00]]');
    expect(status.detail).toBe('status.then[next=outcome.auto[name=Day]]');
    expect(status).toMatchObject({ override: true, outcome: { themeId: 'damocles', kind: 'light', look: 'light' } });
  });

  it('evaluates the rules the editor holds in place of the saved ones, as though the schedule were on', () => {
    const status = scheduleStatus(t, H24, data({ rules: [] }), NOW, [rule(7, DAY_ID), rule(19, 'damocles')]);
    expect(status.text).toBe('status.until[active=outcome.autoNow.dark[name=Damocles] when=when.tomorrow[time=07:00] next=outcome.auto[name=Day]]');
  });
});
