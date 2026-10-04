<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { CalendarDate, getLocalTimeZone, today, type DateValue } from '@internationalized/date';
import type { AcceptableValue, DateRange } from 'reka-ui';
import { Calendar, Cpu, Folder } from 'lucide-vue-next';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RangeCalendar } from '@/components/ui/range-calendar';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { IconChevronLeft, IconChevronRight } from '@/components/icons';
import StatsMultiSelect, { type StatsSelectOption } from './StatsMultiSelect.vue';
import { folderName } from '@/lib/folder-name';
import { useUsageStatsStore } from '@/stores/useUsageStatsStore';
import { useStatsFormat } from '@/composables/useStatsFormat';
import { STATS_PRESETS, customSpec, firstDayMs, localDateOf, presetSpec } from '@/composables/useStatsRange';
import { NO_PROJECT_KEY } from '@shared/types/usage-stats';

const { t, locale } = useI18n();
const store = useUsageStatsStore();
const format = useStatsFormat();

const presetOptions = computed(() => STATS_PRESETS.map((preset) => ({ preset, label: t(`usageStats.presets.${preset}`) })));

const stepped = computed(() => 'offset' in store.rangeSpec && store.rangeSpec.offset !== 0);

const presetLabel = computed(() => {
  const spec = store.rangeSpec;
  if (spec.preset === 'custom') return t('usageStats.presets.custom');
  if (stepped.value) return t(`usageStats.steppedPresets.${spec.preset}`);
  return t(`usageStats.presets.${spec.preset}`);
});

// A stepped or custom range reports a value no item carries, so picking any preset, the same one included, fires.
const selectValue = computed<string>(() => (stepped.value ? 'custom' : store.preset));

function onPreset(value: AcceptableValue): void {
  const preset = STATS_PRESETS.find((p) => p === value);
  if (preset) store.setRange(presetSpec(preset));
}

const rangeLabel = computed(() => {
  const range = store.activeRange;
  if (!range) return '';
  if (store.preset === 'allTime') return t('usageStats.presets.allTime');
  return format.dateRange(range.startMs, range.endMs);
});

// All time has no previous period to compare with.
const compareDisabled = computed(() => store.preset === 'allTime');

const calendarOpen = ref(false);
const draft = shallowRef<DateRange | null>(null);
// Set on each open, because the overlay can stay up past midnight.
const maxDate = shallowRef<DateValue>(today(getLocalTimeZone()));

function toCalendarDate(ms: number): CalendarDate {
  const d = localDateOf(ms);
  return new CalendarDate(d.year, d.month, d.day);
}

const minDate = toCalendarDate(firstDayMs());

function onCalendarOpen(open: boolean): void {
  calendarOpen.value = open;
  if (!open) return;
  maxDate.value = today(getLocalTimeZone());
  const range = store.activeRange;
  draft.value = range && store.preset !== 'allTime'
    ? { start: toCalendarDate(range.startMs), end: toCalendarDate(range.endMs - 1) }
    : null;
}

function onCalendarUpdate(value: DateRange): void {
  draft.value = value;
  if (!value.start || !value.end) return;
  store.setRange(customSpec(value.start, value.end));
  calendarOpen.value = false;
}

const modelOptions = computed<StatsSelectOption[]>(() =>
  (store.report?.filterOptions.models ?? []).map((m) => ({ key: m.key, label: m.label, title: m.key })),
);

const projectOptions = computed<StatsSelectOption[]>(() =>
  (store.report?.filterOptions.projects ?? []).map((p) =>
    p.key === NO_PROJECT_KEY || p.cwd === null
      ? { key: p.key, label: t('usageStats.filters.noProject') }
      : { key: p.key, label: folderName(p.cwd), title: p.cwd },
  ),
);
</script>

<template>
  <div class="flex flex-wrap items-center gap-1.5">
    <div class="flex h-7 items-stretch rounded-md border border-(--d-border2)">
      <button
        type="button"
        class="flex w-6.5 items-center justify-center border-r border-(--d-border2) text-(--d-text) transition-colors enabled:hover:bg-(--d-hover) disabled:text-(--d-faint)"
        :disabled="!store.activeRange?.canStepPrev"
        :aria-label="t('usageStats.filters.previousPeriod')"
        :title="t('usageStats.filters.previousPeriod')"
        @click="store.step(-1)"
      >
        <IconChevronLeft class="size-3.25" />
      </button>
      <Select
        :model-value="selectValue"
        @update:model-value="onPreset"
      >
        <SelectTrigger
          class="h-full w-auto gap-1.5 rounded-none border-0 bg-transparent px-2.5 text-xs shadow-none hover:bg-(--d-hover)"
          :aria-label="`${t('usageStats.filters.range')}: ${presetLabel}`"
        >
          <Calendar
            class="size-3 text-(--d-faint)"
            aria-hidden="true"
          />
          <span>{{ presetLabel }}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="option in presetOptions"
            :key="option.preset"
            :value="option.preset"
            class="text-xs"
          >
            {{ option.label }}
          </SelectItem>
        </SelectContent>
      </Select>
      <button
        type="button"
        class="flex w-6.5 items-center justify-center border-l border-(--d-border2) text-(--d-text) transition-colors enabled:hover:bg-(--d-hover) disabled:text-(--d-faint)"
        :disabled="!store.activeRange?.canStepNext"
        :aria-label="t('usageStats.filters.nextPeriod')"
        :title="t('usageStats.filters.nextPeriod')"
        @click="store.step(1)"
      >
        <IconChevronRight class="size-3.25" />
      </button>
    </div>

    <Popover
      :open="calendarOpen"
      @update:open="onCalendarOpen"
    >
      <PopoverTrigger as-child>
        <button
          type="button"
          class="rounded-md px-1.5 py-1 font-mono text-11.5 whitespace-nowrap text-(--d-faint) transition-colors hover:bg-(--d-hover) hover:text-(--d-text)"
          :aria-label="`${t('usageStats.filters.pickRange')}: ${rangeLabel}`"
          :title="t('usageStats.filters.pickRange')"
        >
          {{ rangeLabel }}
        </button>
      </PopoverTrigger>
      <PopoverContent
        class="w-auto p-0"
        align="start"
      >
        <RangeCalendar
          :model-value="draft"
          :locale="locale"
          :week-starts-on="1"
          :min-value="minDate"
          :max-value="maxDate"
          :prev-page-label="t('usageStats.filters.previousMonth')"
          :next-page-label="t('usageStats.filters.nextMonth')"
          @update:model-value="onCalendarUpdate"
        />
      </PopoverContent>
    </Popover>

    <span class="flex-1" />

    <StatsMultiSelect
      :label="t('usageStats.filters.models')"
      :icon="Cpu"
      :all-label="t('usageStats.filters.allModels')"
      :options="modelOptions"
      :model-value="store.modelKeys"
      @update:model-value="store.setModelKeys"
    />
    <StatsMultiSelect
      :label="t('usageStats.filters.projects')"
      :icon="Folder"
      :all-label="t('usageStats.filters.allProjects')"
      :options="projectOptions"
      :model-value="store.projectKeys"
      @update:model-value="store.setProjectKeys"
    />

    <label
      class="flex h-7 items-center gap-1.75 rounded-md border border-(--d-border2) px-2.25 text-xs whitespace-nowrap transition-colors hover:bg-(--d-hover)"
      :class="compareDisabled ? 'opacity-50' : ''"
      :title="t(compareDisabled ? 'usageStats.filters.compareAllTime' : 'usageStats.filters.compareHint')"
    >
      <Switch
        :checked="store.compare"
        :disabled="compareDisabled"
        @update:checked="store.setCompare"
      />
      {{ t('usageStats.filters.compare') }}
    </label>
  </div>
</template>
