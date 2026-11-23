// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import { MAX_SCHEDULE_RULES, type ScheduleRule, type Weekday } from '@shared/themes/schedule';
import type { ThemeFile } from '@shared/themes/schema';
import type { OverlayThemeAction, OverlayThemeResult, OverlayThemes, OverlayThemesResult, PopupAnswer } from '../../preload/overlay-channels';
import { provideDesktopPrefs } from '../overlay/settings/desktop-prefs';
import ScheduleEditor from '../overlay/settings/themes/ScheduleEditor.vue';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi, opened } from './fakes';

// The schedule screen (design S6) against a stand-in for main and core: what each control writes and when, what the page
// shows while a write is in flight and after one fails, the time field in the region's clock, and the week in its order.

const EVERY: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const NIGHT_ID = '0b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10';
const DAY_ID = '1b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10';
const GONE_ID = '2b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10';
const NIGHT: ThemeFile = { schemaVersion: 1, id: NIGHT_ID, name: 'Night', looks: { dark: BUILTIN_THEME.looks.dark! } };
const DAY: ThemeFile = { schemaVersion: 1, id: DAY_ID, name: 'Day', looks: { light: BUILTIN_THEME.looks.light! } };
const rule = (hour: number, theme: string, days: Weekday[] = EVERY, look: ScheduleRule['look'] = 'auto'): ScheduleRule => ({ days, minute: hour * 60, theme, look });
// Wednesday 12 June 2024, 20:15 in Athens (UTC+3)
const NOW = Date.UTC(2024, 5, 12, 17, 15);

// What core holds, which the stand-in's answers are built from.
interface Core {
  mode: OverlayThemes['mode'];
  enabled: boolean;
  rules: ScheduleRule[];
  systemLocale: string;
  shown?: OverlayThemes['shown'];
  override?: OverlayThemes['schedule']['override'];
  themes?: OverlayThemes['themes'];
}
let core: Core;
let api: ReturnType<typeof fakeOverlayApi>;
let themesChanged: () => void;
const sent = (): OverlayThemeAction[] => vi.mocked(api.themeAction).mock.calls.map(([action]) => action);
const loads = (): number => vi.mocked(api.getThemes).mock.calls.length;

function listing(): OverlayThemesResult {
  return {
    ok: true,
    themes: core.themes ?? [
      { status: 'ok', id: BUILTIN_THEME.id, name: BUILTIN_THEME.name, builtin: true, theme: BUILTIN_THEME },
      { status: 'ok', id: NIGHT_ID, name: 'Night', builtin: false, theme: NIGHT },
      { status: 'ok', id: DAY_ID, name: 'Day', builtin: false, theme: DAY },
    ],
    shown: core.shown ?? { themeId: NIGHT_ID, kind: 'dark', decidedBy: 'schedule' },
    preferred: { dark: NIGHT_ID, light: DAY_ID },
    mode: core.mode,
    schedule: { schedule: { enabled: core.enabled, rules: core.rules }, ...(core.override ? { override: core.override } : {}), now: NOW, zone: 'Europe/Athens', osKind: 'dark', systemLocale: core.systemLocale },
    history: [],
  };
}

// Core's side of an action: the rules replace the rules and nothing else, and the mode choice sets the mode and the switch.
function apply(action: OverlayThemeAction): void {
  if (action.action === 'schedule') core.rules = action.rules.map((given) => ({ ...given, days: [...given.days] }));
  if (action.action === 'scheduleMode') {
    core.enabled = action.choice === 'schedule';
    core.mode = action.choice === 'system' ? 'system' : core.mode === 'system' ? 'dark' : core.mode;
  }
  if (action.action === 'resume') delete core.override;
}

// The next action waits until the returned function is called, then lands as core applies it.
function holdNext(): () => Promise<void> {
  let release: (answer: PopupAnswer<OverlayThemeResult>) => void = () => undefined;
  vi.mocked(api.themeAction).mockImplementationOnce((action) => new Promise((resolve) => {
    release = (answer) => {
      apply(action);
      resolve(answer);
    };
  }));
  return async () => {
    release(opened({ ok: true as const }));
    await flushPromises();
  };
}

const mounted: VueWrapper[] = [];
async function editor(given: Partial<Core> = {}, pages = 1): Promise<VueWrapper> {
  core = { mode: 'dark', enabled: true, rules: [rule(7, DAY_ID), rule(19, NIGHT_ID)], systemLocale: 'en-GB', ...given };
  const Host = defineComponent({
    setup() {
      provideDesktopPrefs(api);
      return () => Array.from({ length: pages }, () => h(ScheduleEditor));
    },
  });
  const wrapper = mount(Host, { global: { plugins: [shellI18n, createPinia()] }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

const byTestId = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (id: string): string => byTestId(id)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const named = (label: string): HTMLElement => document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
const button = (label: string): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.trim() === label)!;
const radio = (label: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('[role="radio"]')]
  .find((element) => document.getElementById(element.getAttribute('aria-labelledby') ?? '')?.textContent?.trim() === label)!;
const ruleCount = (): number => document.querySelectorAll('[data-testid^="schedule-rule-"]:not([data-testid*="warning"])').length;
const timeField = (n: number): HTMLElement => document.querySelectorAll<HTMLElement>('[data-slot="time-field"]')[n - 1]!;
const segment = (n: number, part: string): HTMLElement => timeField(n).querySelector<HTMLElement>(`[data-reka-time-field-segment="${part}"]`)!;
const timeShown = (n: number): string => [...timeField(n).querySelectorAll('[data-reka-time-field-segment]')].map((element) => element.textContent!.trim() || ' ').join('');
async function click(element: HTMLElement): Promise<void> {
  element.click();
  await flushPromises();
}
async function type(n: number, part: string, ...keys: string[]): Promise<void> {
  const target = segment(n, part);
  target.focus();
  for (const key of keys) target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await flushPromises();
}
async function echo(): Promise<void> {
  themesChanged();
  await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  api = fakeOverlayApi();
  themesChanged = () => undefined;
  vi.mocked(api.getThemes).mockImplementation(async () => opened(listing()));
  vi.mocked(api.themeAction).mockImplementation(async (action) => {
    apply(action);
    return opened({ ok: true as const });
  });
  vi.mocked(api.onThemesChanged).mockImplementation((listener) => {
    themesChanged = listener;
    return () => undefined;
  });
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('what the schedule screen writes', () => {
  it('sends a rule edit as the rules alone, in the stored Monday-first order, and never whether the schedule is on', async () => {
    await editor();
    await click(named('Wednesday, rule 2'));
    expect(sent()).toEqual([{ action: 'schedule', rules: [rule(7, DAY_ID), rule(19, NIGHT_ID, ['mon', 'tue', 'thu', 'fri', 'sat', 'sun'])] }]);
    expect(Object.keys(sent()[0]!).sort()).toEqual(['action', 'rules']);
    await click(named('Wednesday, rule 2'));
    expect(sent()[1]).toEqual({ action: 'schedule', rules: [rule(7, DAY_ID), rule(19, NIGHT_ID)] });
  });

  it('reads the list once for a change: when main says it changed, and not again when the write answers', async () => {
    await editor();
    expect(loads()).toBe(1);
    await click(named('Wednesday, rule 2'));
    expect(loads()).toBe(1);
    await echo();
    expect(loads()).toBe(2);
    expect(named('Wednesday, rule 2').getAttribute('aria-pressed')).toBe('false');
  });

  it('shows a refused write\'s reason and core\'s rules again, from one read', async () => {
    await editor();
    vi.mocked(api.themeAction).mockResolvedValueOnce(opened({ ok: false as const, error: 'The disk is full.' }));
    await click(named('Wednesday, rule 2'));
    expect(text('schedule-error')).toBe('The disk is full.');
    expect(named('Wednesday, rule 2').getAttribute('aria-pressed')).toBe('true');
    expect(loads()).toBe(2);
    // the next write clears it
    await click(named('Monday, rule 1'));
    expect(byTestId('schedule-error')).toBeNull();
  });

  it('says a rejected call in its own words, never the error Electron wraps', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await editor();
    vi.mocked(api.themeAction).mockRejectedValueOnce(new Error("Error invoking remote method 'damocles:overlay:theme-action': Error: Malformed theme action"));
    await click(named('Wednesday, rule 2'));
    expect(text('schedule-error')).toBe('Damocles could not do that. Try again.');
  });

  it('keeps the rules of the later of two writes in flight, whatever a read between them says', async () => {
    await editor();
    const first = holdNext();
    await click(named('Wednesday, rule 2'));
    const second = holdNext();
    await click(named('Monday, rule 1'));
    expect(sent()).toHaveLength(2);
    await first();
    // main tells of the first write while the second is in flight: the page's rules are newer than that list
    await echo();
    expect(named('Monday, rule 1').getAttribute('aria-pressed')).toBe('false');
    expect(named('Wednesday, rule 2').getAttribute('aria-pressed')).toBe('false');
    await second();
    await echo();
    expect(core.rules).toEqual([rule(7, DAY_ID, ['tue', 'wed', 'thu', 'fri', 'sat', 'sun']), rule(19, NIGHT_ID, ['mon', 'tue', 'thu', 'fri', 'sat', 'sun'])]);
    expect(named('Monday, rule 1').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('the schedule screen\'s mode', () => {
  it('writes the choice, shows it while it is written and reads the list after it', async () => {
    await editor({ mode: 'system', enabled: false });
    expect(radio("Follow the computer's light and dark mode").getAttribute('aria-checked')).toBe('true');
    // one background class per state, so the pointer never takes the chosen mode's tint
    const grounds = (label: string): string[] => [...radio(label).closest('label')!.classList].filter((name) => name.includes('bg-(--d-'));
    expect(grounds("Follow the computer's light and dark mode")).toEqual(['bg-(--d-accent-soft)']);
    expect(grounds('Use a schedule')).toEqual(['hover:bg-(--d-hover)']);
    const land = holdNext();
    await click(radio('Use a schedule'));
    expect(sent()).toEqual([{ action: 'scheduleMode', choice: 'schedule' }]);
    expect(radio('Use a schedule').getAttribute('aria-checked')).toBe('true');
    await land();
    expect(radio('Use a schedule').getAttribute('aria-checked')).toBe('true');
    expect(core).toMatchObject({ enabled: true, mode: 'dark' });
  });

  it('leaves the schedule on when a rule is added before the mode write lands', async () => {
    await editor({ mode: 'system', enabled: false, rules: [] });
    const land = holdNext();
    await click(radio('Use a schedule'));
    await click(button('Add the first rule'));
    await land();
    await echo();
    expect(sent()[1]).toEqual({ action: 'schedule', rules: [rule(7, DAY_ID, EVERY, 'light')] });
    expect(core).toMatchObject({ enabled: true, rules: [rule(7, DAY_ID, EVERY, 'light')] });
    expect(radio('Use a schedule').getAttribute('aria-checked')).toBe('true');
    expect(ruleCount()).toBe(1);
  });

  it('keeps showing the later of two choices while the earlier one lands', async () => {
    await editor({ mode: 'system', enabled: false });
    const first = holdNext();
    await click(radio('Use a schedule'));
    const second = holdNext();
    await click(radio('Off (manual only)'));
    await first();
    expect(radio('Off (manual only)').getAttribute('aria-checked')).toBe('true');
    await second();
    expect(radio('Off (manual only)').getAttribute('aria-checked')).toBe('true');
  });
});

describe('adding and deleting rules', () => {
  it('starts a new rule as what shows now, so adding it after its start time changes nothing on screen', async () => {
    await editor();
    await click(button('Add rule'));
    // 20:15: Night shows by the 19:00 rule, and a 12:00 rule of anything else would take the screen
    expect(sent()).toEqual([{ action: 'schedule', rules: [rule(7, DAY_ID), rule(19, NIGHT_ID), rule(12, NIGHT_ID)] }]);
    expect(text('schedule-summary')).toBe('Night (auto, dark now) until 07:00 tomorrow, then Day (auto).');
  });

  it('starts a new rule as the pick that holds over the schedule while one does', async () => {
    await editor({ override: { themeId: 'damocles', kind: 'light', at: NOW - 60_000 } });
    await click(button('Add rule'));
    expect(sent()[0]).toEqual({ action: 'schedule', rules: [rule(7, DAY_ID), rule(19, NIGHT_ID), rule(12, 'damocles', EVERY, 'light')] });
  });

  it('puts focus in the new rule\'s time, and after a delete on the next rule\'s delete button or the first-rule button', async () => {
    await editor();
    await click(button('Add rule'));
    expect(document.activeElement).toBe(segment(3, 'hour'));
    await click(named('Delete rule 1'));
    expect(document.activeElement).toBe(named('Delete rule 1'));
    expect(ruleCount()).toBe(2);
    await click(named('Delete rule 2'));
    expect(document.activeElement).toBe(named('Delete rule 1'));
    await click(named('Delete rule 1'));
    expect(ruleCount()).toBe(0);
    expect(document.activeElement).toBe(button('Add the first rule'));
    expect(sent().at(-1)).toEqual({ action: 'schedule', rules: [] });
  });

  it('offers the day and night pair with its times in the region\'s clock', async () => {
    await editor({ rules: [], systemLocale: 'en-US' });
    await click(button('Start with Day 7:00 AM and Night 7:00 PM'));
    expect(sent()).toEqual([{ action: 'schedule', rules: [rule(7, DAY_ID, EVERY, 'light'), rule(19, NIGHT_ID, EVERY, 'dark')] }]);
  });

  it('stops at the number of rules a schedule holds: the button says why and sends nothing', async () => {
    await editor({ rules: Array.from({ length: MAX_SCHEDULE_RULES }, (_, at) => rule(at % 24, NIGHT_ID)) });
    const add = byTestId('schedule-add')!;
    expect(add.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(add.getAttribute('aria-describedby')!)!.textContent).toBe('A schedule holds at most 48 rules.');
    await click(add);
    expect(sent()).toEqual([]);
    expect(ruleCount()).toBe(MAX_SCHEDULE_RULES);
    // one fewer and it adds again
    await click(named('Delete rule 48'));
    expect(byTestId('schedule-add')!.getAttribute('aria-disabled')).toBeNull();
    expect(byTestId('schedule-cap')).toBeNull();
  });
});

describe('the time field', () => {
  it('writes a typed time once, on Enter or when focus leaves, and nothing while its segments are typed', async () => {
    await editor();
    expect(timeField(2).getAttribute('aria-label')).toBe('Starts at, rule 2');
    expect(timeShown(2)).toBe('19:00');
    await type(2, 'hour', '2', '1');
    await type(2, 'minute', '3', '0');
    expect(sent()).toEqual([]);
    await type(2, 'minute', 'Enter');
    expect(sent()).toEqual([{ action: 'schedule', rules: [rule(7, DAY_ID), { ...rule(21, NIGHT_ID), minute: 21 * 60 + 30 }] }]);
    await type(1, 'hour', '0', '6');
    named('Delete rule 1').focus();
    await flushPromises();
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toMatchObject({ rules: [{ minute: 6 * 60 }, { minute: 21 * 60 + 30 }] });
  });

  it('writes nothing for an entry with an empty segment, and shows the rule\'s time again', async () => {
    await editor();
    await type(1, 'minute', 'Backspace', 'Backspace');
    named('Delete rule 1').focus();
    await flushPromises();
    expect(sent()).toEqual([]);
    expect(timeShown(1)).toBe('07:00');
    expect(text('schedule-rule-1')).toContain('Every day from 07:00');
  });

  it('shows a 12-hour clock in a 12-hour region, the field and every time on the screen alike, and stores 24-hour minutes', async () => {
    await editor({ systemLocale: 'en-US' });
    expect(timeShown(1)).toBe('7:00 AM');
    expect(timeShown(2)).toBe('7:00 PM');
    expect(text('schedule-now')).toBe('Now · Wednesday 8:15 PM');
    expect(text('schedule-summary')).toBe('Night (auto, dark now) until 7:00 AM tomorrow, then Day (auto).');
    expect(text('schedule-rule-2')).toContain('Every day from 7:00 PM');
    expect(text('schedule-axis')).toBe('12 AM6 AM12 PM6 PM12 AM');
    await type(2, 'hour', '9');
    await type(2, 'hour', 'Enter');
    expect(sent()).toEqual([{ action: 'schedule', rules: [rule(7, DAY_ID), rule(21, NIGHT_ID)] }]);
  });

  it('shows a 24-hour clock in a 24-hour region whatever the UI\'s language', async () => {
    shellI18n.global.locale.value = 'el';
    await editor({ systemLocale: 'de-DE' });
    expect(timeShown(2)).toBe('19:00');
    expect(text('schedule-axis')).toBe('0006121824');
    // and Greece's own clock in Greek
    for (const wrapper of mounted.splice(0)) wrapper.unmount();
    await editor({ systemLocale: 'el-GR' });
    expect(timeShown(2)).toBe('7:00 μ.μ.');
  });
});

describe('the week', () => {
  it('starts the day toggles and the week strip on the region\'s first day, and stores the days Monday first', async () => {
    await editor({ systemLocale: 'en-US', rules: [rule(7, DAY_ID, ['mon']), rule(19, NIGHT_ID)] });
    const days = [...named('Days, rule 1').querySelectorAll('button')].map((element) => element.textContent!.trim());
    expect(days).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    await click(named('Sunday, rule 1'));
    expect(sent()[0]).toMatchObject({ rules: [{ days: ['mon', 'sun'] }, {}] });
    await click(button('Whole week'));
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid^="schedule-day-"]')].map((element) => element.querySelector('ol')!.getAttribute('aria-label'));
    expect(rows).toEqual(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
  });

  it('starts on Monday in a Monday-first region', async () => {
    await editor({ systemLocale: 'el-GR' });
    expect([...named('Days, rule 1').querySelectorAll('button')].map((element) => element.textContent!.trim())).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  });

  it('labels each span once: the list item holds the words, and the tooltip sits on a copy hidden from assistive technology', async () => {
    await editor();
    const span = document.querySelector<HTMLElement>('[data-testid="schedule-strip"] li')!;
    expect(span.getAttribute('title')).toBeNull();
    expect(span.querySelector('.sr-only')!.textContent).toBe('00:00 to 07:00: Night, auto');
    const visual = span.querySelector<HTMLElement>('[title]')!;
    expect(visual.getAttribute('aria-hidden')).toBe('true');
    expect(visual.getAttribute('title')).toBe('00:00 to 07:00: Night, auto');
  });
});

describe('what the schedule screen says', () => {
  it('warns of a rule whose theme is missing, in the banner, on the rule and as a disabled option', async () => {
    await editor({ rules: [rule(7, DAY_ID), rule(19, GONE_ID)] });
    expect(text('schedule-missing')).toContain('The theme of rule 2 is missing, so the rule is skipped.');
    expect(text('schedule-rule-warning-2')).toBe('Its theme is missing; this rule is skipped until you pick another theme.');
    expect(named('Theme, rule 2').textContent).toContain('Missing theme');
    expect(named('No preview: the theme is missing')).not.toBeNull();
  });

  it('warns of a rule that a later rule of the same time covers on each of its days', async () => {
    await editor({ rules: [rule(7, DAY_ID, ['mon', 'tue']), rule(7, NIGHT_ID)] });
    expect(text('schedule-rule-warning-1')).toBe('A later rule starts at the same time on each of these days, so this rule never shows.');
    expect(byTestId('schedule-rule-warning-2')).toBeNull();
    expect(text('schedule-detail')).toBe('Rule 1 (07:00) never shows: a later rule starts at the same time on each of its days.');
  });

  it('says what decides the window when the schedule does not', async () => {
    await editor({ shown: { themeId: 'damocles', kind: 'dark', decidedBy: 'project' } });
    expect(text('schedule-decided')).toBe("Showing Damocles, dark look: the selected project's own look.");
    for (const wrapper of mounted.splice(0)) wrapper.unmount();
    await editor({ shown: { themeId: 'damocles', kind: 'light', decidedBy: 'safeStart' } });
    expect(text('schedule-decided')).toBe('Showing Damocles, light look: your theme is paused for this run.');
    for (const wrapper of mounted.splice(0)) wrapper.unmount();
    await editor();
    expect(byTestId('schedule-decided')).toBeNull();
  });

  it('shows no clock before the list came, and offers to read it again when the first read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.getThemes).mockRejectedValueOnce(new Error("Error invoking remote method 'damocles:overlay:themes'"));
    await editor();
    expect(text('schedule-now')).toBe('Reading the schedule…');
    expect(text('schedule-load-error')).toContain('Damocles could not read the installed themes.');
    expect(document.querySelector('[role="radio"][aria-checked="true"]')).toBeNull();
    await click(byTestId('schedule-retry')!);
    expect(byTestId('schedule-load-error')).toBeNull();
    expect(text('schedule-now')).toBe('Now · Wednesday 20:15');
    expect(radio('Use a schedule').getAttribute('aria-checked')).toBe('true');
  });

  it('drops a read\'s error once a later read succeeds, and keeps what it showed when a later read fails', async () => {
    await editor();
    vi.mocked(api.getThemes).mockResolvedValueOnce(opened({ ok: false as const, error: "This computer's Damocles engine is not running." }));
    await echo();
    expect(text('schedule-load-error')).toBe("This computer's Damocles engine is not running.");
    // the list it has still shows, so there is nothing to read again by hand
    expect(byTestId('schedule-retry')).toBeNull();
    expect(ruleCount()).toBe(2);
    await echo();
    expect(byTestId('schedule-load-error')).toBeNull();
  });

  it('gives each mounted page its own element ids', async () => {
    await editor({}, 2);
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.startsWith('schedule-'))).toEqual([]);
  });

  // a name written right to left would take the brackets, the times and the words beside it into its own run
  it('isolates a right-to-left theme name in the status, the day strip and a rule\'s theme, and keeps every text and name free of direction marks', async () => {
    const name = 'ליל 2';
    await editor({ themes: [
      { status: 'ok', id: BUILTIN_THEME.id, name: BUILTIN_THEME.name, builtin: true, theme: BUILTIN_THEME },
      { status: 'ok', id: NIGHT_ID, name, builtin: false, theme: NIGHT },
      { status: 'ok', id: DAY_ID, name: 'Day', builtin: false, theme: DAY },
    ] });
    const runs = (root: Element | null): string[] => [...(root?.querySelectorAll('bdi') ?? [])].map((run) => run.textContent ?? '');

    expect(runs(byTestId('schedule-summary'))).toEqual([name, 'Day']);
    expect(text('schedule-summary')).toContain(`${name} (auto, dark now)`);
    expect(runs(byTestId('schedule-rule-2')!.querySelector('[role="combobox"]'))).toEqual([name]);
    expect(runs(byTestId('schedule-strip'))).toContain(name);
    expect(document.body.textContent).not.toMatch(/[\u2066-\u2069]/);
    for (const element of document.querySelectorAll('[aria-label], [title]')) {
      expect(`${element.getAttribute('aria-label') ?? ''}${element.getAttribute('title') ?? ''}`).not.toMatch(/[\u2066-\u2069]/);
    }
  });
});
