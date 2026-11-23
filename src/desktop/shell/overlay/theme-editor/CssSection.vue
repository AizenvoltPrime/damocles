<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, Minus } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { CSS_REGION_LIMIT_BYTES, CSS_TOTAL_LIMIT_BYTES, sanitizeThemeCss, themeCssFamilies, type CssDroppedPart } from '@shared/themes/css-sanitizer';
import { cssDropReasonArgs } from '@shared/themes/css-types';
import { CSS_REGIONS, type CssRegion, type ThemeFile } from '@shared/themes/schema';

// The editor's CSS section (docs/themes.md "Custom CSS"): one region at a time, its size against the limits, and what the
// sanitizer would remove on save. Core sanitizes again on save and its answer is the one stored.
const props = defineProps<{
  draft: ThemeFile;
  readOnly: boolean;
  /** What core removed at the last save. The editor owns it and drops it when the CSS, or a font it may name, changes. */
  savedDropped?: readonly CssDroppedPart[] | undefined;
  /** How many more parts core removed than `savedDropped` lists. */
  savedDroppedMore?: number | undefined;
}>();
const emit = defineEmits<{ update: [theme: ThemeFile] }>();

const { t, locale } = useI18n();
const region = ref<CssRegion>('transcript');

const encoder = new TextEncoder();
const bytesOf = (text: string | undefined): number => (text ? encoder.encode(text).length : 0);
const sourceOf = (id: CssRegion): string => props.draft.css?.[id] ?? '';

const live = computed(() => sanitizeThemeCss(props.draft.css ?? {}, { families: themeCssFamilies(props.draft) }));
const dropped = computed<readonly CssDroppedPart[]>(() => props.savedDropped ?? live.value.dropped);
// the sanitizer lists its first parts only; the rest are counted over all regions
const more = computed(() => (props.savedDropped !== undefined ? props.savedDroppedMore ?? 0 : live.value.droppedMore));
const droppedIn = (id: CssRegion): CssDroppedPart[] => dropped.value.filter((part) => part.region === id);
const shown = computed(() => droppedIn(region.value));

const regionBytes = computed(() => bytesOf(sourceOf(region.value)));
const totalBytes = computed(() => CSS_REGIONS.reduce((sum, id) => sum + bytesOf(sourceOf(id)), 0));
const kb = (bytes: number): string => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 1 }).format(bytes / 1024);
const share = (bytes: number, limit: number): number => Math.min(100, (bytes / limit) * 100);
const meters = computed(() => [
  { key: 'region', label: t('themeEditor.css.meterRegion', { region: t(`themeEditor.css.regions.${region.value}`) }), text: t('themeEditor.css.regionSize', { size: kb(regionBytes.value), limit: kb(CSS_REGION_LIMIT_BYTES) }), bytes: regionBytes.value, limit: CSS_REGION_LIMIT_BYTES },
  { key: 'total', label: t('themeEditor.css.meterTotal'), text: t('themeEditor.css.totalSize', { size: kb(totalBytes.value), limit: kb(CSS_TOTAL_LIMIT_BYTES) }), bytes: totalBytes.value, limit: CSS_TOTAL_LIMIT_BYTES },
]);

function reasonText(part: CssDroppedPart): string {
  const { named, count } = cssDropReasonArgs(part.reason, locale.value);
  const reason = count === undefined ? t(`themeEditor.css.reasons.${part.reason}`, named) : t(`themeEditor.css.reasons.${part.reason}`, named, count);
  return part.line === undefined ? reason : t('themeEditor.css.lineReason', { n: part.line, reason });
}

function setSource(id: CssRegion, value: string): void {
  if (props.readOnly) return;
  const css: Partial<Record<CssRegion, string>> = { ...props.draft.css };
  if (value === '') delete css[id];
  else css[id] = value;
  const next: Record<string, unknown> = { ...props.draft, css };
  if (Object.keys(css).length === 0) delete next['css'];
  emit('update', next as unknown as ThemeFile);
}
</script>

<template>
  <div
    class="flex flex-col gap-3"
    data-testid="theme-editor-css"
  >
    <p class="text-11.5 text-(--d-muted)">
      {{ t('themeEditor.css.note') }}
    </p>
    <Tabs
      v-model="region"
      class="flex flex-col gap-2"
    >
      <!-- One segmented switch; a region whose CSS loses parts on save shows how many, in the warning tint. -->
      <TabsList
        class="h-auto w-full flex-wrap gap-0.5 rounded-9 bg-(--d-hover) p-0.5"
        :aria-label="t('themeEditor.css.regionsLabel')"
      >
        <TabsTrigger
          v-for="id in CSS_REGIONS"
          :key="id"
          :value="id"
          class="h-auto flex-auto rounded-7 px-2 py-1 text-11 text-(--d-muted) hover:text-(--d-text) data-[state=active]:bg-(--d-card) data-[state=active]:font-semibold data-[state=active]:text-(--d-text)"
          :aria-label="droppedIn(id).length > 0 ? t('themeEditor.css.regionRemoved', { region: t(`themeEditor.css.regions.${id}`), n: droppedIn(id).length }, droppedIn(id).length) : undefined"
          :data-testid="`theme-editor-css-region-${id}`"
        >
          {{ t(`themeEditor.css.regions.${id}`) }}
          <span
            v-if="droppedIn(id).length > 0"
            class="min-w-4 rounded-full bg-[color-mix(in_srgb,var(--d-warning-fill)_18%,transparent)] px-1 text-center text-10/4 font-semibold text-(--d-warning-text)"
            aria-hidden="true"
            data-testid="theme-editor-css-count"
          >{{ droppedIn(id).length }}</span>
        </TabsTrigger>
      </TabsList>
      <TabsContent
        v-for="id in CSS_REGIONS"
        :key="id"
        :value="id"
        class="flex flex-col overflow-hidden rounded-10 border border-(--d-border2) bg-(--d-code) focus-within:border-(--d-accent-fill)"
      >
        <label
          :for="`theme-editor-css-${id}`"
          class="border-b border-(--d-border) px-3 py-1.5 text-11 font-medium text-(--d-muted)"
        >{{ t('themeEditor.css.regionCss', { region: t(`themeEditor.css.regions.${id}`) }) }}</label>
        <Textarea
          :id="`theme-editor-css-${id}`"
          :model-value="sourceOf(id)"
          class="min-h-52 resize-y rounded-none border-0 bg-transparent px-3 py-2.5 font-mono text-11 leading-[1.6] whitespace-pre shadow-none focus-visible:ring-0 read-only:text-(--d-muted)"
          spellcheck="false"
          autocomplete="off"
          :readonly="readOnly"
          :data-testid="`theme-editor-css-source-${id}`"
          @update:model-value="(value: string | number) => setSource(id, String(value))"
        />
        <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t border-(--d-border) px-3 py-2 text-11 text-(--d-muted)">
          <template
            v-for="meter in meters"
            :key="meter.key"
          >
            <!-- A size meter: role="meter", which no shadcn part draws (Progress is a progressbar). -->
            <div
              role="meter"
              class="h-1 overflow-hidden rounded-full bg-(--d-border)"
              :aria-label="meter.label"
              aria-valuemin="0"
              :aria-valuemax="meter.limit / 1024"
              :aria-valuenow="Math.round((meter.bytes / 1024) * 10) / 10"
              :aria-valuetext="meter.text"
              :data-testid="`theme-editor-css-meter-${meter.key}`"
            >
              <div
                class="h-full min-w-1 rounded-full"
                :class="meter.bytes > meter.limit ? 'bg-(--d-warning-fill)' : 'bg-(--d-accent-fill)'"
                :style="{ width: `${share(meter.bytes, meter.limit)}%` }"
              />
            </div>
            <span class="font-mono text-(--d-text)">{{ meter.text }}</span>
          </template>
        </div>
      </TabsContent>
    </Tabs>

    <div class="mt-2 flex items-center gap-2">
      <h2
        id="theme-editor-css-removed"
        class="text-11 font-semibold tracking-[.07em] text-(--d-muted) uppercase"
      >
        {{ t('themeEditor.css.removedHeading') }}
      </h2>
      <Badge
        v-if="shown.length > 0 || more === 0"
        variant="tone"
        class="border-0 bg-(--tone)/15 px-1.5 py-px text-10.5 font-medium"
        :class="shown.length > 0 ? 'd-tone-warning' : 'd-tone-success'"
        data-testid="theme-editor-css-removed-count"
      >
        {{ shown.length > 0 ? t('themeEditor.css.parts', { n: shown.length }, shown.length) : t('themeEditor.css.none') }}
      </Badge>
    </div>
    <!-- One list split by hairlines, no side bars. -->
    <ul
      class="flex flex-col overflow-hidden rounded-10 border border-(--d-border) bg-(--d-panel)"
      aria-labelledby="theme-editor-css-removed"
      data-testid="theme-editor-css-removed"
    >
      <li
        v-for="(part, index) in shown"
        :key="`${part.reason}-${part.line ?? 0}-${index}`"
        class="grid grid-cols-[1.375rem_minmax(0,1fr)] items-start gap-x-2.5 gap-y-0.5 px-3 py-2.5 text-12 not-first:border-t not-first:border-(--d-border)"
        :data-reason="part.reason"
      >
        <span
          class="row-span-2 flex size-5.5 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--d-warning-fill)_14%,transparent)] text-(--d-warning-text)"
          aria-hidden="true"
        >
          <Minus class="size-3" />
        </span>
        <code class="justify-self-start rounded-5 bg-(--d-hover) px-1.5 font-mono text-11 leading-5.5 wrap-anywhere">{{ part.text }}</code>
        <span class="text-(--d-muted)">{{ reasonText(part) }}</span>
      </li>
      <li
        v-if="more > 0"
        class="px-3 py-2.5 text-12 text-(--d-muted) not-first:border-t not-first:border-(--d-border)"
        data-testid="theme-editor-css-removed-more"
      >
        {{ t('themeEditor.css.moreRemoved', { n: more }, more) }}
      </li>
      <li
        v-else-if="shown.length === 0"
        class="grid grid-cols-[1.375rem_minmax(0,1fr)] items-center gap-x-2.5 px-3 py-2.5 text-12 text-(--d-muted)"
      >
        <span
          class="flex size-5.5 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--d-success-fill)_14%,transparent)] text-(--d-success-text)"
          aria-hidden="true"
        >
          <Check class="size-3" />
        </span>
        {{ t('themeEditor.css.nothingRemoved', { region: t(`themeEditor.css.regions.${region}`) }) }}
      </li>
    </ul>
  </div>
</template>
