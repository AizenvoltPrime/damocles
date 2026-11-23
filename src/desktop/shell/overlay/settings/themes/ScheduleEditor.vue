<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, shallowRef, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertTriangle, Bot, Clock, Globe, LayoutPanelTop, Plus, Trash2 } from 'lucide-vue-next';
import SettingSeg from '@/components/settings/controls/SettingSeg.vue';
import SettingSelect from '@/components/settings/controls/SettingSelect.vue';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Toggle } from '@/components/ui/toggle';
import { TimeField } from '@/components/ui/time-field';
import ThemeMiniature from '@/components/theme/ThemeMiniature.vue';
import { IsolatedText } from '@/components/isolated-text';
import { isolated, withoutIsolates } from '@shared/bidi-isolate';
import { lookPalette } from '@/components/theme/theme-view';
import { BUILTIN_PALETTES, BUILTIN_THEME_ID } from '@shared/themes/builtin';
import {
  addDays, daySpans, localTime, MAX_SCHEDULE_RULES, MINUTES_PER_DAY, shadowedRules, THEME_TICK_MS, type ScheduleLook, type ScheduleOutcome, type ScheduleRule, type Weekday, WEEKDAYS,
} from '@shared/themes/schedule';
import type { ThemeFile } from '@shared/themes/schema';
import type { LookKind } from '@shared/themes/tokens';
import type { OverlayThemeAction, OverlayThemeEntry, OverlayThemes } from '../../../../preload/overlay-channels';
import { answerOf } from '../../popup-answer';
import { useDesktopPrefs } from '../desktop-prefs';
import {
  clockOf, hourText, knownName, looksOf, minuteText, outcomeText, ownPick, ruleSummary, scheduleChoice, scheduleInput, scheduleStatus, themeName, timeText, weekdayName, weekOrder,
  type ScheduleChoice,
} from './schedule-text';
import { failureText, secondsText } from './theme-text';

const emit = defineEmits<{ (e: 'back'): void }>();

const S = 'settingsHost.schedule';

const { t, locale } = useI18n();
const prefs = useDesktopPrefs();
const uid = useId();
const data = shallowRef<OverlayThemes>();
// why the list could not be read, and why the last change was not made
const loadFailure = ref<string>();
const failure = ref<string>();
// main's clock when the data came, and this page's then: the status runs on from there
let receivedAt = 0;
const tick = ref(0);
const timer = setInterval(() => (tick.value += 1), THEME_TICK_MS);
onScopeDispose(() => clearInterval(timer));
const now = computed(() => {
  void tick.value;
  return data.value ? data.value.schedule.now + (Date.now() - receivedAt) : Date.now();
});
const clock = computed(() => clockOf(locale.value, data.value));

// The rules as this page edits them; each keeps its key across saves, so focus stays on the control the user changed.
interface EditRule extends ScheduleRule {
  readonly key: number;
}
let nextKey = 0;
const rules = ref<EditRule[]>([]);
// writes in flight, and a count of every write's start and end: a list read across either is older than this page's rules
const writing = ref(0);
let generation = 0;

async function load(): Promise<void> {
  const started = generation;
  const answer = await answerOf(prefs.api.getThemes()).catch((err: unknown) => {
    loadFailure.value = failureText(t, err, 'load');
    return undefined;
  });
  if (!answer) return;
  if (!answer.ok) {
    loadFailure.value = answer.error;
    return;
  }
  loadFailure.value = undefined;
  receivedAt = Date.now();
  data.value = answer;
  if (writing.value > 0 || started !== generation) return;
  rules.value = answer.schedule.schedule.rules.map((rule, index) => ({ ...rule, key: rules.value[index]?.key ?? nextKey++ }));
}
onMounted(() => void load());
// Main says so after every change core made, this page's own included: that read is the one a change is followed by.
onScopeDispose(prefs.api.onThemesChanged(() => void load()));

async function act(action: OverlayThemeAction): Promise<boolean> {
  failure.value = undefined;
  try {
    const result = await answerOf(prefs.api.themeAction(action));
    if (result && !result.ok) failure.value = result.error;
    return result?.ok === true;
  } catch (err) {
    failure.value = failureText(t, err, 'action');
    return false;
  }
}

// The rules alone are written: whether the schedule is on is core's, so a rule edit never undoes a mode change in flight.
async function save(next: EditRule[]): Promise<void> {
  rules.value = next;
  writing.value += 1;
  generation += 1;
  let saved = false;
  try {
    // plain copies: IPC cannot clone Vue's reactive proxies
    saved = await act({ action: 'schedule', rules: next.map(({ days, minute, theme, look }) => ({ days: [...days], minute, theme, look })) });
  } finally {
    writing.value -= 1;
    generation += 1;
  }
  // a refused write leaves core's rules, which this page shows again
  if (!saved && writing.value === 0) await load();
}

const update = (key: number, change: Partial<ScheduleRule>): Promise<void> => save(rules.value.map((rule) => (rule.key === key ? { ...rule, ...change } : rule)));

// Mode
const pendingChoice = ref<ScheduleChoice>();
const choice = computed<ScheduleChoice | undefined>(() => pendingChoice.value ?? (data.value ? scheduleChoice(data.value) : undefined));
const choices: readonly ScheduleChoice[] = ['system', 'schedule', 'off'];
async function choose(next: unknown): Promise<void> {
  if (!choices.includes(next as ScheduleChoice) || next === choice.value) return;
  const wanted = next as ScheduleChoice;
  pendingChoice.value = wanted;
  try {
    await act({ action: 'scheduleMode', choice: wanted });
    // a change of the mode alone is a setting main follows, which core tells nobody of
    await load();
  } finally {
    // a later choice still in flight keeps its own
    if (pendingChoice.value === wanted) pendingChoice.value = undefined;
  }
}

// Status
const looks = computed(() => (data.value ? looksOf(data.value.themes) : () => undefined));
const status = computed(() => (data.value ? scheduleStatus(t, clock.value, data.value, now.value, rules.value) : undefined));
const zone = computed(() => data.value?.schedule.zone ?? 'UTC');
const today = computed(() => localTime(now.value, zone.value));
const kicker = computed(() => (data.value
  ? t(`${S}.now`, { day: weekdayName(locale.value, today.value.weekday), time: timeText(clock.value, now.value, zone.value) })
  : t(`${S}.loading`)));
const okEntry = (id: string): Extract<OverlayThemeEntry, { status: 'ok' }> | undefined => {
  const entry = data.value?.themes.find((candidate) => candidate.id === id);
  return entry?.status === 'ok' ? entry : undefined;
};
const shownMini = computed(() => {
  const shown = data.value?.shown;
  const entry = shown ? okEntry(shown.themeId) : undefined;
  return shown && entry ? { theme: entry.theme, kind: shown.kind, label: t(`${S}.showingNow.${shown.kind}`, { name: entry.name }) } : undefined;
});
// What decides the window when the schedule and the mode do not: the miniature shows that look, so the card says why.
const decidedLine = computed(() => {
  const shown = data.value?.shown;
  if (!shown || (shown.decidedBy !== 'project' && shown.decidedBy !== 'safeStart' && shown.decidedBy !== 'forcedColors')) return undefined;
  return t(`settingsHost.themes.mode.status.${shown.decidedBy}.${shown.kind}`, { name: isolated(themeName(data.value, shown.themeId)) });
});

async function resume(): Promise<void> {
  if (await act({ action: 'resume' })) statusCard.value?.focus();
}
const statusCard = ref<HTMLElement | null>(null);

// Day strip
type Range = 'today' | 'week';
const range = ref<Range>('today');
const rangeOptions = computed(() => [{ value: 'today' as const, label: t(`${S}.strip.today`) }, { value: 'week' as const, label: t(`${S}.strip.wholeWeek`) }]);
const showStrip = computed(() => choice.value === 'schedule' && rules.value.length > 0);
const week = computed(() => weekOrder(clock.value));
const axis = computed(() => [0, 6, 12, 18, 24].map((hour) => hourText(clock.value, hour)));

interface StripSpan {
  readonly key: string;
  readonly grow: number;
  readonly style: Record<string, string>;
  readonly time?: string;
  readonly name: string;
  readonly look: string;
  readonly pick: boolean;
  readonly label: string;
}

function spanColors(outcome: ScheduleOutcome): Record<string, string> {
  const theme: ThemeFile | undefined = okEntry(outcome.themeId)?.theme;
  const palette = (theme ? lookPalette(theme, outcome.kind) : undefined) ?? BUILTIN_PALETTES[outcome.kind];
  return { '--span-bg': palette['--d-bg'] ?? '', '--span-text': palette['--d-text'] ?? '', '--span-accent': palette['--d-accent-fill'] ?? '' };
}

const stripRows = computed(() => {
  const current = data.value;
  if (!current || !showStrip.value) return [];
  const input = scheduleInput(current, now.value, rules.value, true);
  const fallback = ownPick(current);
  // the week that holds today, from the region's first day
  const days = range.value === 'week' ? week.value : [today.value.weekday];
  const todayAt = week.value.indexOf(today.value.weekday);
  return days.map((day) => {
    const date = addDays(today.value.date, week.value.indexOf(day) - todayAt);
    const spans = daySpans(input, date, fallback).map((span, index): StripSpan => {
      const name = themeName(current, span.outcome.themeId);
      const look = t(`${S}.strip.${span.outcome.look === 'auto' ? 'auto' : span.outcome.kind}`);
      const period = t(`${S}.strip.span`, { from: minuteText(clock.value, span.from), to: minuteText(clock.value, span.to) });
      return {
        key: `${day}-${index}`,
        grow: span.to - span.from,
        style: spanColors(span.outcome),
        ...(span.from > 0 ? { time: minuteText(clock.value, span.from) } : {}),
        name,
        look,
        pick: span.pick,
        label: t(`${S}.strip.${span.pick ? 'spanLabelPick' : 'spanLabel'}`, { period, name: isolated(name), look }),
      };
    });
    return { day, today: day === today.value.weekday, name: weekdayName(locale.value, day), short: weekdayName(locale.value, day, 'short'), spans };
  });
});
const nowMinute = computed(() => today.value.minute);

// Rules
const themeOptions = computed(() => (data.value?.themes ?? []).flatMap((entry) => {
  if (entry.status !== 'ok') return [];
  const { dark, light } = entry.theme.looks;
  const name = isolated(entry.name);
  return [{ value: entry.id, label: dark && light ? name : t(`${S}.rule.only.${dark ? 'dark' : 'light'}`, { name }) }];
}));
const isMissing = (rule: ScheduleRule): boolean => (looks.value(rule.theme)?.length ?? 0) === 0;
// A missing theme's words: with its name while a broken file still has one, else without, since nothing keeps it.
const missingText = (key: string, rule: ScheduleRule, values: Record<string, unknown> = {}): string => {
  const name = knownName(data.value, rule.theme);
  return name === undefined ? t(`${S}.${key}Unknown`, values) : t(`${S}.${key}`, { ...values, name: isolated(name) });
};
const lookOptions = (rule: ScheduleRule): { value: ScheduleLook; label: string; disabled?: boolean; attrs?: Record<string, string> }[] => {
  const has = looks.value(rule.theme);
  return (['dark', 'light', 'auto'] as const).map((look) => {
    const lacks = look !== 'auto' && has !== undefined && !has.includes(look);
    const title = look === 'auto' ? t(`${S}.rule.autoTitle`) : lacks ? t(`${S}.rule.lacks.${look}`, { name: themeName(data.value, rule.theme) }) : undefined;
    return { value: look, label: t(`${S}.look.${look}`), ...(lacks ? { disabled: true } : {}), ...(title ? { attrs: { title } } : {}) };
  });
};
function thumbOf(rule: ScheduleRule): { theme: ThemeFile; mode: LookKind | 'split'; label: string } | undefined {
  const entry = okEntry(rule.theme);
  if (!entry) return undefined;
  const has = looks.value(rule.theme) ?? [];
  const both = has.length === 2;
  const mode: LookKind | 'split' = rule.look === 'auto' ? (both ? 'split' : has[0]!) : has.includes(rule.look) ? rule.look : has[0]!;
  return { theme: entry.theme, mode, label: t(`${S}.rule.thumb.${mode}`, { name: entry.name }) };
}
const timeOf = (minute: number): string => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

// What each rule's row shows, built once per change of the rules or the data.
const ruleViews = computed(() => {
  const shadowed = new Set(shadowedRules({ enabled: true, rules: rules.value }, looks.value));
  return rules.value.map((rule, index) => {
    const missing = isMissing(rule);
    const warning = missing ? missingText('rule.missingWarn', rule)
      : rule.days.length === 0 ? t(`${S}.rule.noDaysWarn`)
        : shadowed.has(index) ? t(`${S}.rule.shadowedWarn`)
          : undefined;
    return {
      rule,
      n: index + 1,
      time: timeOf(rule.minute),
      summary: ruleSummary(t, clock.value, rule),
      thumb: thumbOf(rule),
      noPreview: missing ? withoutIsolates(missingText('rule.noPreview', rule)) : '',
      warning,
      themeOptions: missing ? [{ value: rule.theme, label: missingText('rule.missingOption', rule), disabled: true }, ...themeOptions.value] : themeOptions.value,
      lookOptions: lookOptions(rule),
    };
  });
});

const toggleDay = (rule: EditRule, day: Weekday): Promise<void> =>
  update(rule.key, { days: rule.days.includes(day) ? rule.days.filter((d) => d !== day) : WEEKDAYS.filter((d) => d === day || rule.days.includes(d)) });

function setTime(rule: EditRule, value: string): void {
  const [hour = 0, minute = 0] = value.split(':').map(Number);
  void update(rule.key, { minute: hour * 60 + minute });
}

function setTheme(rule: EditRule, theme: string): void {
  const has = looks.value(theme) ?? [];
  // a look the new theme lacks becomes Auto, which shows the look it has
  const look = rule.look !== 'auto' && !has.includes(rule.look) ? 'auto' : rule.look;
  void update(rule.key, { theme, look });
}

const ruleElements = new Map<number, HTMLElement>();
const ruleRef = (key: number) => (element: unknown): void => {
  if (element instanceof HTMLElement) ruleElements.set(key, element);
  else ruleElements.delete(key);
};
const addFirstButton = ref<HTMLElement | null>(null);

// The schedule's reader refuses more rules than this, so the page never builds such a list.
const atCap = computed(() => rules.value.length >= MAX_SCHEDULE_RULES);

async function addRule(made: readonly ScheduleRule[]): Promise<void> {
  if (rules.value.length + made.length > MAX_SCHEDULE_RULES) return;
  const added = made.map((rule) => ({ ...rule, key: nextKey++ }));
  const last = added.at(-1)!;
  const saving = save([...rules.value, ...added]);
  await nextTick();
  ruleElements.get(last.key)?.querySelector<HTMLElement>('[data-slot="time-field"] [contenteditable="true"]')?.focus();
  await saving;
}

const preferred = computed(() => data.value?.preferred ?? { dark: BUILTIN_THEME_ID, light: BUILTIN_THEME_ID });
// A new rule starts as what shows now, so adding it changes nothing on screen.
function addOne(): Promise<void> {
  const outcome = status.value?.outcome;
  const shows = outcome !== undefined && (looks.value(outcome.themeId)?.length ?? 0) > 0;
  return addRule([{ days: [...WEEKDAYS], minute: 12 * 60, theme: shows ? outcome.themeId : BUILTIN_THEME_ID, look: outcome === undefined ? 'auto' : shows ? outcome.look : outcome.kind }]);
}
const addFirst = (): Promise<void> => addRule([{ days: [...WEEKDAYS], minute: 7 * 60, theme: preferred.value.light, look: 'light' }]);
const addDayAndNight = (): Promise<void> => addRule([
  { days: [...WEEKDAYS], minute: 7 * 60, theme: preferred.value.light, look: 'light' },
  { days: [...WEEKDAYS], minute: 19 * 60, theme: preferred.value.dark, look: 'dark' },
]);

async function removeRule(rule: EditRule): Promise<void> {
  const index = rules.value.findIndex((candidate) => candidate.key === rule.key);
  const saving = save(rules.value.filter((candidate) => candidate.key !== rule.key));
  await nextTick();
  const next = rules.value[Math.min(index, rules.value.length - 1)];
  if (next) ruleElements.get(next.key)?.querySelector<HTMLElement>('[data-delete-rule]')?.focus();
  else addFirstButton.value?.focus();
  await saving;
}

// The first rule whose theme is missing, which the banner names.
const missingRule = computed(() => {
  const index = rules.value.findIndex(isMissing);
  return index < 0 ? undefined : { index, rule: rules.value[index]! };
});
function pickForMissing(): void {
  const target = missingRule.value;
  if (target) ruleElements.get(target.rule.key)?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
}

// Follow the computer and Off: the looks the mode shows
const lookRows = computed(() => {
  const current = data.value;
  if (!current || choice.value === 'schedule' || choice.value === undefined) return [];
  const row = (kind: LookKind, label: string): { kind: LookKind; label: string; name: string; theme?: ThemeFile } => {
    const id = current.preferred[kind];
    const theme = okEntry(id)?.theme;
    return { kind, label, name: themeName(current, id), ...(theme ? { theme } : {}) };
  };
  if (choice.value === 'system') return [row('dark', t(`${S}.looks.whileDark`)), row('light', t(`${S}.looks.whileLight`))];
  const kind: LookKind = current.mode === 'light' ? 'light' : 'dark';
  return [row(kind, t(`${S}.looks.fixed.${kind}`))];
});
</script>

<template>
  <div
    class="flex flex-col gap-3"
    data-testid="schedule-editor"
  >
    <div
      v-if="choice === 'schedule' && missingRule"
      class="sm-banner sm-banner-warning"
      role="note"
      data-testid="schedule-missing"
    >
      <AlertTriangle
        class="size-4 text-(--d-warning-text)"
        aria-hidden="true"
      />
      <span class="sm-banner-text"><IsolatedText :text="missingText('missing.text', missingRule.rule, { n: missingRule.index + 1 })" /></span>
      <button
        type="button"
        class="sm-button"
        @click="pickForMissing"
      >
        {{ t(`${S}.missing.pick`, { n: missingRule.index + 1 }) }}
      </button>
    </div>

    <div
      v-if="loadFailure"
      class="flex flex-wrap items-center gap-2"
      data-testid="schedule-load-error"
    >
      <p
        class="sm-feedback sm-feedback-error"
        role="alert"
      >
        {{ loadFailure }}
      </p>
      <button
        v-if="!data"
        type="button"
        class="sm-button"
        data-testid="schedule-retry"
        @click="load"
      >
        {{ t(`${S}.retry`) }}
      </button>
    </div>
    <p
      v-if="failure"
      class="sm-feedback sm-feedback-error"
      role="alert"
      data-testid="schedule-error"
    >
      {{ failure }}
    </p>

    <section
      ref="statusCard"
      tabindex="-1"
      class="flex flex-col gap-3 rounded-11 border border-(--d-border) bg-(--d-panel) px-3.5 py-3 @container/now"
      :aria-labelledby="`${uid}-now`"
      data-testid="schedule-status"
    >
      <div class="flex items-start gap-3.5">
        <div
          v-if="shownMini"
          class="w-30 shrink-0 @max-[30rem]/now:w-18"
        >
          <ThemeMiniature
            :theme="shownMini.theme"
            :mode="shownMini.kind"
            :label="shownMini.label"
          />
        </div>
        <div class="min-w-0 flex-1">
          <p
            :id="`${uid}-now`"
            class="text-11 font-semibold tracking-[0.07em] text-(--d-faint-text) uppercase"
            data-testid="schedule-now"
          >
            {{ kicker }}
          </p>
          <p
            class="mt-1 text-15 leading-[1.35] font-semibold text-pretty @max-[30rem]/now:text-13"
            aria-live="polite"
            data-testid="schedule-summary"
          >
            <IsolatedText :text="status?.text ?? ''" />
          </p>
          <p
            v-if="status?.detail"
            class="mt-1 text-12 text-(--d-muted) text-pretty"
            data-testid="schedule-detail"
          >
            <IsolatedText :text="status.detail" />
          </p>
          <p
            v-if="decidedLine"
            class="mt-1 text-12 text-(--d-muted) text-pretty"
            data-testid="schedule-decided"
          >
            <IsolatedText :text="decidedLine" />
          </p>
          <div
            v-if="status?.override"
            class="mt-2.5 flex flex-wrap gap-2"
          >
            <button
              type="button"
              class="sm-button"
              @click="resume"
            >
              {{ t(`${S}.resume`) }}
            </button>
          </div>
        </div>
      </div>
      <div
        v-if="showStrip"
        class="flex flex-col gap-1.5 border-t border-(--d-border) pt-3"
        data-testid="schedule-strip"
      >
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p class="flex-auto text-12 font-medium">
            {{ range === 'week' ? t(`${S}.strip.week`) : t(`${S}.strip.todayTitle`, { day: weekdayName(locale, today.weekday) }) }}
          </p>
          <span class="inline-flex items-center gap-1 text-11 text-(--d-muted)">
            <span
              class="size-2 rounded-full bg-(--d-accent-fill)"
              aria-hidden="true"
            />{{ t(`${S}.strip.now`, { time: timeText(clock, now, zone) }) }}
          </span>
          <SettingSeg
            :model-value="range"
            :options="rangeOptions"
            :label="t(`${S}.strip.timeline`)"
            radios
            @update:model-value="(value: Range) => (range = value)"
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <div
            v-for="row in stripRows"
            :key="row.day"
            class="grid items-center gap-2"
            :class="range === 'week' ? 'grid-cols-[1.5rem_minmax(0,1fr)]' : 'grid-cols-[minmax(0,1fr)]'"
            :data-testid="`schedule-day-${row.day}`"
          >
            <span
              v-if="range === 'week'"
              class="text-11 font-semibold"
              :class="row.today ? 'text-(--d-accent-text)' : 'text-(--d-muted)'"
              aria-hidden="true"
            >{{ row.short }}</span>
            <div
              class="relative grid"
              :class="[range === 'week' ? 'h-7.5' : 'h-9', row.today ? 'mt-2.5' : '']"
            >
              <ol
                class="col-start-1 row-start-1 m-0 flex min-w-0 list-none gap-0.5 p-0"
                :aria-label="row.name"
              >
                <li
                  v-for="span in row.spans"
                  :key="span.key"
                  class="flex min-w-0 basis-0 overflow-hidden rounded-6 bg-(--span-bg) text-(--span-text) shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--span-text)_14%,transparent)] @container"
                  :style="{ ...span.style, flexGrow: String(span.grow) }"
                  :data-pick="span.pick ? '' : undefined"
                >
                  <span class="sr-only"><IsolatedText :text="span.label" /></span>
                  <!-- the tooltip sits on the hidden copy, so the label is read once -->
                  <span
                    class="flex w-full min-w-0 items-center gap-1.5 px-2 text-11 whitespace-nowrap @max-[3.5rem]:justify-center @max-[3.5rem]:px-0"
                    :class="span.pick ? 'bg-[repeating-linear-gradient(135deg,color-mix(in_srgb,currentColor_12%,transparent)_0_0.25rem,transparent_0.25rem_0.5rem)]' : ''"
                    aria-hidden="true"
                    :title="withoutIsolates(span.label)"
                  >
                    <span class="size-1.75 flex-none rounded-full bg-(--span-accent)" />
                    <span
                      v-if="span.time"
                      class="flex-none font-mono text-10 opacity-72 @max-[7.5rem]:hidden"
                    >{{ span.time }}</span>
                    <span class="min-w-0 truncate font-medium @max-[3.5rem]:hidden"><bdi>{{ span.name }}</bdi> <span class="font-normal opacity-72">· {{ span.look }}</span></span>
                  </span>
                </li>
              </ol>
              <div
                v-if="row.today"
                class="pointer-events-none col-start-1 row-start-1 flex"
                aria-hidden="true"
              >
                <span :style="{ flexGrow: String(nowMinute) }" />
                <span class="relative -mt-2 h-1.75 w-0.5 flex-none self-start rounded-full bg-(--d-accent-fill) before:absolute before:-top-1 before:-left-0.75 before:size-2 before:rounded-full before:bg-(--d-accent-fill) before:shadow-[0_0_0_2px_var(--d-bg)]" />
                <span :style="{ flexGrow: String(MINUTES_PER_DAY - nowMinute) }" />
              </div>
            </div>
          </div>
        </div>
        <div
          class="flex justify-between font-mono text-10 text-(--d-faint-text)"
          :class="range === 'week' ? 'ms-8' : ''"
          aria-hidden="true"
          data-testid="schedule-axis"
        >
          <span
            v-for="(hour, index) in axis"
            :key="index"
          >{{ hour }}</span>
        </div>
      </div>
    </section>

    <div
      :id="`${uid}-mode`"
      class="sm-group-head"
    >
      {{ t(`${S}.mode.head`) }}
    </div>
    <RadioGroup
      :model-value="choice ?? null"
      :aria-labelledby="`${uid}-mode`"
      class="flex flex-col gap-1.5"
      data-testid="schedule-mode"
      @update:model-value="choose"
    >
      <label
        v-for="value in choices"
        :key="value"
        :for="`${uid}-mode-${value}`"
        class="flex cursor-pointer items-start gap-2.5 rounded-9 border px-3 py-2.5"
        :class="choice === value ? 'border-(--d-accent-fill) bg-(--d-accent-soft)' : 'border-(--d-border) hover:bg-(--d-hover)'"
      >
        <RadioGroupItem
          :id="`${uid}-mode-${value}`"
          :value="value"
          class="mt-0.5"
          :aria-labelledby="`${uid}-mode-${value}-label`"
          :aria-describedby="`${uid}-mode-${value}-desc`"
        />
        <span class="flex min-w-0 flex-col gap-0.5">
          <span
            :id="`${uid}-mode-${value}-label`"
            class="text-12.5 font-medium"
          >{{ t(`${S}.mode.${value}.label`) }}</span>
          <span
            :id="`${uid}-mode-${value}-desc`"
            class="text-12 text-(--d-muted)"
          >{{ t(`${S}.mode.${value}.desc`) }}</span>
        </span>
      </label>
    </RadioGroup>

    <template v-if="choice === 'schedule'">
      <div
        :id="`${uid}-rules`"
        class="sm-group-head"
      >
        {{ t(`${S}.rules`) }}
      </div>
      <ul
        v-if="ruleViews.length > 0"
        class="m-0 flex list-none flex-col gap-2 p-0 @container/rules"
        :aria-labelledby="`${uid}-rules`"
      >
        <li
          v-for="view in ruleViews"
          :key="view.rule.key"
          :ref="ruleRef(view.rule.key)"
        >
          <div
            role="group"
            :aria-labelledby="`${uid}-rule-${view.rule.key}`"
            class="flex flex-col gap-2.5 rounded-11 border bg-(--d-panel) p-3"
            :class="view.warning ? 'border-(--d-warning-fill)/45' : 'border-(--d-border)'"
            :data-testid="`schedule-rule-${view.n}`"
          >
            <div class="flex min-w-0 items-center gap-2">
              <span
                :id="`${uid}-rule-${view.rule.key}`"
                class="flex-none font-semibold"
              >{{ t(`${S}.rule.name`, { n: view.n }) }}</span>
              <span class="min-w-0 flex-1 text-12 text-(--d-muted)">{{ view.summary }}</span>
              <button
                type="button"
                class="sm-button"
                data-delete-rule
                :aria-label="t(`${S}.rule.delete`, { n: view.n })"
                :title="t(`${S}.rule.deleteTitle`)"
                @click="removeRule(view.rule)"
              >
                <Trash2
                  class="size-3.5"
                  aria-hidden="true"
                />
              </button>
            </div>
            <div
              role="group"
              class="flex flex-wrap gap-1"
              :aria-label="t(`${S}.rule.days`, { n: view.n })"
            >
              <Toggle
                v-for="day in week"
                :key="day"
                variant="outline"
                size="sm"
                class="h-7.5 min-w-9 rounded-7 border-(--d-border2) bg-(--d-input) px-1.5 text-12 text-(--d-muted) data-[state=on]:border-(--d-accent-fill) data-[state=on]:bg-(--d-accent-soft) data-[state=on]:font-bold data-[state=on]:text-(--d-accent-text)"
                :model-value="view.rule.days.includes(WEEKDAYS[day]!)"
                :aria-label="t(`${S}.rule.day`, { day: weekdayName(locale, day), n: view.n })"
                @update:model-value="toggleDay(view.rule, WEEKDAYS[day]!)"
              >
                {{ weekdayName(locale, day, 'short') }}
              </Toggle>
            </div>
            <div class="grid grid-cols-[8rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2.5 @max-[36rem]/rules:grid-cols-[8rem_minmax(0,1fr)] @max-[30rem]/rules:grid-cols-1">
              <div class="flex min-w-0 flex-col gap-1">
                <span
                  class="text-11 text-(--d-muted)"
                  aria-hidden="true"
                >{{ t(`${S}.rule.startsAt`) }}</span>
                <TimeField
                  class="h-8 w-fit border-(--d-border2) bg-(--d-input) font-mono text-12.5"
                  :model-value="view.time"
                  :locale="locale"
                  :hour-cycle="clock.hour12 ? 12 : 24"
                  :aria-label="t(`${S}.rule.startsAtRule`, { n: view.n })"
                  @commit="(value: string) => setTime(view.rule, value)"
                />
              </div>
              <div class="flex min-w-0 flex-col gap-1">
                <span
                  class="text-11 text-(--d-muted)"
                  aria-hidden="true"
                >{{ t(`${S}.rule.theme`) }}</span>
                <div class="flex min-w-0 items-center gap-2">
                  <div
                    v-if="view.thumb"
                    class="w-14 shrink-0"
                  >
                    <ThemeMiniature
                      :theme="view.thumb.theme"
                      :mode="view.thumb.mode"
                      :label="view.thumb.label"
                    />
                  </div>
                  <div
                    v-else
                    class="aspect-16/10 w-14 shrink-0 rounded-5 border border-dashed border-(--d-border2)"
                    role="img"
                    :aria-label="view.noPreview"
                  />
                  <div class="min-w-0 flex-1">
                    <SettingSelect
                      :model-value="view.rule.theme"
                      :options="view.themeOptions"
                      :label="t(`${S}.rule.themeRule`, { n: view.n })"
                      @update:model-value="(value: string) => setTheme(view.rule, value)"
                    />
                  </div>
                </div>
              </div>
              <div class="flex min-w-0 flex-col gap-1 @max-[36rem]/rules:col-span-full">
                <span
                  class="text-11 text-(--d-muted)"
                  aria-hidden="true"
                >{{ t(`${S}.rule.look`) }}</span>
                <SettingSeg
                  :model-value="view.rule.look"
                  :options="view.lookOptions"
                  :label="t(`${S}.rule.lookRule`, { n: view.n })"
                  radios
                  @update:model-value="(value: ScheduleLook) => update(view.rule.key, { look: value })"
                />
              </div>
            </div>
            <p
              v-if="view.warning"
              class="flex items-center gap-1.5 text-12 text-(--d-warning-text)"
              :data-testid="`schedule-rule-warning-${view.n}`"
            >
              <AlertTriangle
                class="size-3.5 flex-none"
                aria-hidden="true"
              /><IsolatedText :text="view.warning" />
            </p>
          </div>
        </li>
      </ul>
      <div
        v-else
        class="flex flex-col items-start gap-2 rounded-11 border border-dashed border-(--d-border2) bg-(--d-panel) p-5"
        data-testid="schedule-empty"
      >
        <span class="grid size-9 place-items-center rounded-9 bg-(--d-accent-soft) text-(--d-accent-text)">
          <Clock
            class="size-4.5"
            aria-hidden="true"
          />
        </span>
        <h3 class="text-15 font-semibold">
          {{ t(`${S}.empty.title`) }}
        </h3>
        <p class="max-w-136 text-12 text-(--d-muted) text-pretty">
          {{ t(`${S}.empty.body`) }}
        </p>
        <div class="mt-1 flex flex-wrap gap-2">
          <button
            ref="addFirstButton"
            type="button"
            class="sm-button sm-button-primary"
            @click="addFirst"
          >
            <Plus
              class="size-3"
              aria-hidden="true"
            />{{ t(`${S}.empty.addFirst`) }}
          </button>
          <button
            type="button"
            class="sm-button"
            @click="addDayAndNight"
          >
            {{ t(`${S}.empty.template`, { day: minuteText(clock, 7 * 60), night: minuteText(clock, 19 * 60) }) }}
          </button>
        </div>
        <p class="max-w-136 text-12 text-(--d-muted) text-pretty">
          <IsolatedText :text="t(`${S}.empty.note`, { light: isolated(themeName(data, preferred.light)), dark: isolated(themeName(data, preferred.dark)) })" />
        </p>
      </div>
      <div
        v-if="rules.length > 0"
        class="mt-1 flex flex-wrap items-center gap-2"
      >
        <!-- aria-disabled, not disabled: the button keeps focus and its reason stays reachable -->
        <button
          type="button"
          class="sm-button"
          data-testid="schedule-add"
          :aria-disabled="atCap ? 'true' : undefined"
          :aria-describedby="atCap ? `${uid}-cap` : undefined"
          @click="addOne"
        >
          <Plus
            class="size-3"
            aria-hidden="true"
          />{{ t(`${S}.addRule`) }}
        </button>
        <span
          v-if="atCap"
          :id="`${uid}-cap`"
          class="text-12 text-(--d-muted)"
          data-testid="schedule-cap"
        >{{ t(`${S}.capReached`, { n: MAX_SCHEDULE_RULES }) }}</span>
      </div>
    </template>

    <template v-else-if="lookRows.length > 0">
      <div class="sm-group-head">
        {{ t(`${S}.looks.head`) }}
      </div>
      <div class="flex flex-col">
        <div
          v-for="row in lookRows"
          :key="row.kind"
          class="flex items-center gap-3 border-b border-(--d-border) py-2.5"
        >
          <div class="w-20 shrink-0">
            <ThemeMiniature
              v-if="row.theme"
              :theme="row.theme"
              :mode="row.kind"
              :label="t(`${S}.rule.thumb.${row.kind}`, { name: row.name })"
            />
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-12.5 font-medium">
              {{ row.label }}
            </div>
            <div class="text-12 text-(--d-muted)">
              <IsolatedText :text="outcomeText(t, row.name, { kind: row.kind, look: row.kind })" />
            </div>
          </div>
        </div>
      </div>
      <p
        v-if="rules.length > 0"
        class="mt-2.5 text-12 text-(--d-muted)"
      >
        {{ t(`${S}.looks.kept`, { n: rules.length }, rules.length) }}
      </p>
      <div class="mt-1 flex flex-wrap gap-2">
        <button
          type="button"
          class="sm-button"
          @click="emit('back')"
        >
          {{ t(`${S}.looks.change`) }}
        </button>
      </div>
    </template>

    <div class="mt-6 flex flex-col gap-2 border-t border-(--d-border) pt-3 text-12 text-(--d-muted)">
      <p class="flex items-start gap-2">
        <LayoutPanelTop
          class="mt-0.5 size-3.5 flex-none"
          aria-hidden="true"
        />{{ t(`${S}.notes.arrangement`) }}
      </p>
      <p class="flex items-start gap-2">
        <Bot
          class="mt-0.5 size-3.5 flex-none"
          aria-hidden="true"
        />{{ t(`${S}.notes.agent`) }}
      </p>
      <p class="flex items-start gap-2">
        <Globe
          class="mt-0.5 size-3.5 flex-none"
          aria-hidden="true"
        />{{ t(`${S}.notes.time`, { duration: secondsText(locale, THEME_TICK_MS) }) }}
      </p>
    </div>
  </div>
</template>
