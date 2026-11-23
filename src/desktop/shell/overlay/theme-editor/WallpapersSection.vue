<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertTriangle, ArrowDown, ArrowUp, Check, ImagePlus, Palette, Plus, Trash2 } from 'lucide-vue-next';
import SettingSeg from '@/components/settings/controls/SettingSeg.vue';
import SettingSelect from '@/components/settings/controls/SettingSelect.vue';
import SettingSlider from '@/components/settings/controls/SettingSlider.vue';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { lookPalette } from '@/components/theme/theme-view';
import { AA } from '@shared/themes/contrast';
import { MAX_THEME_NAME_CHARS } from '@shared/themes/limits';
import { FITS, LOOK_SEEDS, PANELS, type Fit, type Look, type LookColors, type Panel, type ThemeFile, type WallpaperSet } from '@shared/themes/schema';
import { PANE_SURFACES, type LookKind } from '@shared/themes/tokens';
import {
  contrastOverImage, DEFAULT_PANEL_LOOK, DIM_RANGE, isMoving, MAX_BLUR_PX, MAX_MOVING_BLUR_PX, MAX_WALLPAPER_SETS, readableDim, SURFACE_OPACITY_RANGE, surfaceOpacityOf,
  thumbUrl, TRUSTED_SURFACE_FLOOR, type FlashRecord, type ImageStats, type WallpaperPalette,
} from '@shared/themes/wallpapers';
import type { EditorImports, KnownImage } from './editor-imports';
import { useEditorFormat } from './format';
import { DEFAULT_TARGET, placeImage, spanLookFor, withLook, withoutSpan, withSet, withSets, type ImageDestination } from './wallpaper-edits';
import WallpaperPanelMap from './WallpaperPanelMap.vue';

// The editor's Wallpapers section (docs/themes.md "Wallpapers"): the look's wallpaper sets and how the window moves through
// them; for the set being edited, one image per panel or one image across chosen panels, with fit, dim and blur; a moving
// image's flash check and the per-file allowance; the look's surface opacity; and the palette proposed from the image.
// It unmounts when its tab hides, so what an import told and every call to main live in `imports`, which the editor owns.
const props = defineProps<{
  draft: ThemeFile;
  kind: LookKind;
  readOnly: boolean;
  // the set being edited, which the window shows while the editor previews
  setIndex: number;
  // what the theme renderer derived from each wallpaper the saved theme names
  known: Readonly<Record<string, { readonly stats: ImageStats; readonly palette?: WallpaperPalette; readonly flash?: FlashRecord }>>;
  contrast: 'raiseDim' | 'warn';
  imports: EditorImports;
  // Next Wallpaper's shortcut as main writes it for this platform
  nextShortcut: string;
}>();
const emit = defineEmits<{ update: [theme: ThemeFile]; 'update:setIndex': [index: number] }>();
const { t } = useI18n();
const format = useEditorFormat();

type Mode = 'none' | 'panels' | 'span';
const selected = ref<Panel>('chat');
// span chosen before its image: the panels it will cover
const pendingSpan = ref<Panel[] | undefined>();
const paletteOpen = ref(false);
const busy = computed(() => props.imports.busy.image);
const checking = computed(() => props.imports.checking);
const failure = computed(() => props.imports.failure.wallpapers);
// One instance serves both looks: what was pending or open for one look is not the other's.
watch(() => props.kind, () => {
  pendingSpan.value = undefined;
  paletteOpen.value = false;
  props.imports.clear('wallpapers');
});

const look = computed<Look | undefined>(() => props.draft.looks[props.kind]);
const sets = computed<readonly WallpaperSet[]>(() => look.value?.wallpapers ?? []);
const index = computed(() => Math.min(Math.max(0, props.setIndex), Math.max(0, sets.value.length - 1)));
const set = computed<WallpaperSet | undefined>(() => sets.value[index.value]);
const hasImages = (candidate: WallpaperSet | undefined): boolean => candidate?.span !== undefined || candidate?.panels !== undefined;
const mode = computed<Mode>(() => (set.value?.span || pendingSpan.value ? 'span' : hasImages(set.value) ? 'panels' : 'none'));
const spanPanels = computed<readonly Panel[]>(() => set.value?.span?.panels ?? pendingSpan.value ?? []);
const info = (sha: string): KnownImage | undefined => {
  const base = props.imports.images[sha] ?? props.known[sha];
  const flash = props.imports.allowed[sha] ?? base?.flash;
  return base ? { ...base, ...(flash ? { flash } : {}) } : undefined;
};
const assetOf = (sha: string | undefined) => (sha ? props.draft.assets?.[sha] : undefined);

// The image, fit, dim and blur the controls below the map edit.
const target = computed<{ readonly sha?: string; readonly fit: Fit; readonly dim: number; readonly blur: number } | undefined>(() => {
  if (mode.value === 'none') return undefined;
  if (mode.value === 'panels') {
    const own = set.value?.panels?.[selected.value];
    return own ? { sha: own.asset, fit: own.fit, dim: own.dim, blur: own.blur } : DEFAULT_TARGET;
  }
  const span = set.value?.span;
  const first = spanPanels.value[0];
  const shown = (first !== undefined ? set.value?.spanLook?.[first] : undefined) ?? DEFAULT_PANEL_LOOK;
  return span ? { sha: span.asset, fit: span.fit, dim: shown.dim, blur: shown.blur } : DEFAULT_TARGET;
});
const moving = computed(() => isMoving(assetOf(target.value?.sha)?.kind));
const maxBlur = computed(() => (moving.value ? MAX_MOVING_BLUR_PX : MAX_BLUR_PX));
const images = computed<Partial<Record<Panel, string>>>(() => {
  const out: Partial<Record<Panel, string>> = {};
  const span = set.value?.span;
  for (const panel of span?.panels ?? []) out[panel] = span!.asset;
  for (const [panel, own] of Object.entries(set.value?.panels ?? {})) if (own) out[panel as Panel] = own.asset;
  return out;
});
const pressed = computed<readonly Panel[]>(() => (mode.value === 'panels' ? [selected.value] : mode.value === 'span' ? spanPanels.value : []));
const panelName = (panel: Panel): string => t(`themeEditor.wallpapers.panels.${panel}`);
const heading = computed(() => (mode.value === 'span' ? t('themeEditor.wallpapers.across', { panels: format.list(spanPanels.value.map(panelName)) }) : panelName(selected.value)));

// Writes go through wallpaper-edits.ts, against the draft as it is.
function emitTheme(theme: ThemeFile | undefined): void {
  if (theme && !props.readOnly) emit('update', theme);
}
const writeSets = (next: readonly WallpaperSet[]): void => emitTheme(withSets(props.draft, props.kind, next));
const writeSet = (next: WallpaperSet | undefined): void => emitTheme(withSet(props.draft, props.kind, index.value, next));
const named = (): Pick<WallpaperSet, 'name'> => (set.value?.name !== undefined ? { name: set.value.name } : {});

function setMode(next: Mode): void {
  if (next === mode.value) return;
  props.imports.clear('wallpapers');
  if (next === 'none') {
    pendingSpan.value = undefined;
    writeSet(undefined);
  } else if (next === 'panels') {
    pendingSpan.value = undefined;
    writeSet({ ...named(), panels: set.value?.panels ?? {} });
  } else pendingSpan.value = ['sidebar', 'chat'];
}

function toggle(panel: Panel): void {
  if (mode.value === 'panels') {
    selected.value = panel;
    return;
  }
  const current = spanPanels.value;
  const panels = current.includes(panel) ? (current.length > 1 ? current.filter((p) => p !== panel) : current) : PANELS.filter((p) => current.includes(p) || p === panel);
  const span = set.value?.span;
  if (!span) {
    pendingSpan.value = [...panels];
    return;
  }
  // a panel that stays keeps its own dim and blur; one that joins starts at the values the sliders show
  const shown = target.value ?? DEFAULT_TARGET;
  writeSet({ ...set.value, span: { ...span, panels }, spanLook: spanLookFor(panels, set.value?.spanLook, { dim: shown.dim, blur: shown.blur }) });
}

function chooseImage(): void {
  if (props.readOnly || busy.value) return;
  const shown = target.value ?? DEFAULT_TARGET;
  // where the image goes, read now: the look, the set and the panel can all change while the file dialog is open
  const to: ImageDestination = { kind: props.kind, index: index.value, at: mode.value === 'span' ? { span: [...spanPanels.value] } : { panel: selected.value }, fit: shown.fit, dim: shown.dim, blur: shown.blur };
  void props.imports.importImage((draft, image) => placeImage(draft, to, image)).then((placed) => {
    if (placed) pendingSpan.value = undefined;
  });
}

function removeImage(): void {
  if (mode.value === 'span') {
    pendingSpan.value = undefined;
    // only the spanning image goes: the panels' own images stay
    writeSet(set.value ? withoutSpan(set.value) : undefined);
    return;
  }
  const panels = { ...set.value?.panels };
  delete panels[selected.value];
  writeSet({ ...set.value, panels });
}

function setTarget(change: Partial<{ fit: Fit; dim: number; blur: number }>): void {
  const current = target.value;
  if (!current?.sha || !set.value) return;
  const span = set.value.span;
  if (mode.value === 'span' && span) {
    // each panel keeps the value this change does not name
    const edited = spanLookFor(span.panels, set.value.spanLook, DEFAULT_PANEL_LOOK, { ...(change.dim !== undefined ? { dim: change.dim } : {}), ...(change.blur !== undefined ? { blur: change.blur } : {}) });
    const spanLook = Object.fromEntries(Object.entries(edited).map(([panel, own]) => [panel, { dim: own!.dim, blur: Math.min(own!.blur, maxBlur.value) }]));
    writeSet({ ...set.value, span: { ...span, fit: change.fit ?? span.fit }, spanLook });
    return;
  }
  const next = { fit: current.fit, dim: current.dim, blur: Math.min(current.blur, maxBlur.value), ...change };
  writeSet({ ...set.value, panels: { ...set.value.panels, [selected.value]: { asset: current.sha, ...next } } });
}

function setSurface(value: number): void {
  const current = look.value;
  if (!current || props.readOnly) return;
  const next: Record<string, unknown> = { ...current, surfaceOpacity: Math.round(value * 100) / 100 };
  if (next['surfaceOpacity'] === 1) delete next['surfaceOpacity'];
  emit('update', withLook(props.draft, props.kind, next as unknown as Look));
}

// Sets: add, rename, reorder and remove; the edited set follows the one it was.
function pickSet(i: number): void {
  pendingSpan.value = undefined;
  emit('update:setIndex', i);
}
function addSet(): void {
  if (sets.value.length >= MAX_WALLPAPER_SETS) return;
  const next = [...sets.value, { name: t('themeEditor.wallpapers.sets.defaultName', { n: sets.value.length + 1 }) }];
  writeSets(next);
  pickSet(next.length - 1);
}
function renameSet(i: number, name: string): void {
  const trimmed = [...name].slice(0, MAX_THEME_NAME_CHARS).join('');
  const all = sets.value.map((candidate, at) => {
    if (at !== i) return candidate;
    const rest: Record<string, unknown> = { ...candidate };
    if (trimmed.trim() === '') delete rest['name'];
    else rest['name'] = trimmed;
    return rest as WallpaperSet;
  });
  writeSets(all);
}
function moveSet(i: number, by: -1 | 1): void {
  const to = i + by;
  if (to < 0 || to >= sets.value.length) return;
  const all = [...sets.value];
  [all[i], all[to]] = [all[to]!, all[i]!];
  writeSets(all);
  if (index.value === i) emit('update:setIndex', to);
  else if (index.value === to) emit('update:setIndex', i);
}
function removeSet(i: number): void {
  const all = sets.value.filter((_, at) => at !== i);
  writeSets(all);
  if (index.value >= i && index.value > 0) emit('update:setIndex', index.value - 1);
}
const setLabel = (candidate: WallpaperSet, i: number): string => candidate.name ?? t('themeEditor.wallpapers.sets.defaultName', { n: i + 1 });
const setThumb = (candidate: WallpaperSet): string | undefined => candidate.span?.asset ?? Object.values(candidate.panels ?? {})[0]?.asset;
const setSummary = (candidate: WallpaperSet): string => {
  if (candidate.span) return t('themeEditor.wallpapers.sets.across', { n: candidate.span.panels.length }, candidate.span.panels.length);
  const count = Object.keys(candidate.panels ?? {}).length;
  return count === 0 ? t('themeEditor.wallpapers.sets.empty') : t('themeEditor.wallpapers.sets.panels', { n: count }, count);
};

// Cycle: every N minutes, or only with Next Wallpaper.
type CycleMode = 'timer' | 'shortcut';
const CYCLE_MINUTES = ['5', '15', '30', '60'] as const;
const cycleMode = computed<CycleMode>(() => (typeof look.value?.cycle?.minutes === 'number' ? 'timer' : 'shortcut'));
const cycleMinutes = computed(() => String(look.value?.cycle?.minutes ?? 15));
function setCycle(next: CycleMode, minutes = Number(cycleMinutes.value)): void {
  const current = look.value;
  if (!current || props.readOnly) return;
  const rest: Record<string, unknown> = { ...current };
  delete rest['cycle'];
  emit('update', withLook(props.draft, props.kind, (next === 'timer' ? { ...rest, cycle: { minutes } } : rest) as unknown as Look));
}
const cycleOptions = computed(() => [
  { value: 'timer' as const, label: t('themeEditor.wallpapers.cycle.timer') },
  { value: 'shortcut' as const, label: t('themeEditor.wallpapers.cycle.shortcut', { shortcut: props.nextShortcut }) },
]);
const minuteOptions = computed(() => CYCLE_MINUTES.map((value) => ({ value, label: t('themeEditor.wallpapers.cycle.minutes', { n: Number(value) }, Number(value)) })));

// What the image is and how text reads over it.
const meta = computed(() => {
  const sha = target.value?.sha;
  const asset = assetOf(sha);
  if (!sha || !asset) return undefined;
  const base = { width: asset.width ?? 0, height: asset.height ?? 0, megabytes: format.megabytes(asset.bytes) };
  const size = asset.kind === 'video'
    ? t('themeEditor.wallpapers.metaVideo', { ...base, duration: format.duration(asset.durationMs ?? 0) })
    : asset.kind === 'animated' ? t('themeEditor.wallpapers.metaAnimated', { ...base, frames: asset.frames ?? 1 }) : t('themeEditor.wallpapers.meta', base);
  return { name: info(sha)?.name ?? t('themeEditor.wallpapers.image'), size };
});
// A moving file's flash check: not done, passed, blocked, or allowed on this computer.
const flash = computed<{ readonly state: 'unchecked' | 'blocked' | 'allowed'; readonly atMs?: number } | undefined>(() => {
  const sha = target.value?.sha;
  if (!sha || !moving.value) return undefined;
  const record = info(sha)?.flash;
  if (!record) return { state: 'unchecked' };
  if (!record.flagged) return undefined;
  return { state: record.allowed === true ? 'allowed' : 'blocked', ...(record.atMs !== undefined ? { atMs: record.atMs } : {}) };
});
function allowFlashing(): void {
  const sha = target.value?.sha;
  if (sha && !props.readOnly) void props.imports.allowFlash('wallpapers', sha);
}
const readability = computed<{ readonly ok: boolean; readonly text: string } | undefined>(() => {
  const current = target.value;
  const stats = current?.sha ? info(current.sha)?.stats : undefined;
  const palette = look.value ? lookPalette(props.draft, props.kind) : undefined;
  const muted = palette?.['--d-muted'];
  if (!current || !stats || !palette || !muted) return undefined;
  const panels = mode.value === 'span' ? spanPanels.value : [selected.value];
  const ratios = panels.map((panel) => ({ panel, color: palette[PANE_SURFACES[panel]]!.slice(0, 7) })).map(({ color }) => ({ color, ratio: contrastOverImage(muted, color, current.dim, stats) }));
  const worst = ratios.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  // rounded down, so a ratio below the threshold never reads as the threshold
  const ratio = format.ratio(worst.ratio);
  const need = format.need(AA);
  if (worst.ratio >= AA) return { ok: true, text: t('themeEditor.wallpapers.readable', { ratio }) };
  if (props.contrast === 'warn') return { ok: false, text: t('themeEditor.wallpapers.lowContrast', { ratio, need }) };
  const raised = Math.max(...ratios.map(({ color }) => readableDim(muted, color, current.dim, stats)));
  return { ok: false, text: t('themeEditor.wallpapers.raised', { ratio, need, dim: format.percent(Math.round(raised * 100) / 100) }) };
});

// Palette from wallpaper: the 8 colors the theme renderer proposed for this look's kind.
const proposal = computed<LookColors | undefined>(() => {
  const sha = target.value?.sha ?? set.value?.span?.asset;
  return sha ? info(sha)?.palette?.[props.kind] : undefined;
});
function applyPalette(): void {
  const current = look.value;
  if (!current || !proposal.value) return;
  emit('update', withLook(props.draft, props.kind, { ...current, colors: { ...proposal.value } }));
  paletteOpen.value = false;
}

const modeOptions = computed(() => (['none', 'panels', 'span'] as const).map((value) => ({ value, label: t(`themeEditor.wallpapers.mode.${value}`) })));
const fitOptions = computed(() => FITS.map((value) => ({ value, label: t(`themeEditor.wallpapers.fit.${value}`) })));
const percent = (value: number): string => format.percent(Math.round(value * 100) / 100);
const pixels = (value: number): string => t('themeEditor.units.value', { n: format.number(value), unit: 'px' });
const seedLabel = (seed: (typeof LOOK_SEEDS)[number]): string => t(`settingsHost.themes.seeds.${seed}`);
const seedColor = (seed: (typeof LOOK_SEEDS)[number], colors: LookColors): string => t('themeEditor.wallpapers.stripColor', { color: seedLabel(seed), value: colors[seed] });
const stripLabel = (title: string, colors: LookColors): string => t('themeEditor.wallpapers.stripLabel', { title, colors: format.list(LOOK_SEEDS.map((seed) => seedColor(seed, colors))) });
</script>

<template>
  <div
    class="flex flex-col gap-4"
    data-testid="theme-editor-wallpapers"
  >
    <div class="flex flex-col gap-1.5">
      <span class="text-12 font-medium">{{ t('themeEditor.wallpapers.label') }}</span>
      <SettingSeg
        :model-value="mode"
        :options="modeOptions"
        :label="t('themeEditor.wallpapers.label')"
        radios
        :disabled="readOnly"
        @update:model-value="setMode"
      />
    </div>

    <div
      v-if="mode !== 'none'"
      class="flex flex-col gap-1.5"
    >
      <span class="text-12 font-medium">{{ t('themeEditor.wallpapers.panel') }}</span>
      <p
        id="theme-wallpaper-map-desc"
        class="text-11 text-(--d-muted)"
      >
        {{ mode === 'span' ? t('themeEditor.wallpapers.mapSpan') : t('themeEditor.wallpapers.mapPanels') }}
      </p>
      <WallpaperPanelMap
        :pressed="pressed"
        :images="images"
        :disabled="readOnly"
        described-by="theme-wallpaper-map-desc"
        @toggle="toggle"
      />
    </div>

    <section
      v-if="mode !== 'none' && target"
      class="flex flex-col gap-3"
      aria-labelledby="theme-wallpaper-target"
    >
      <h2
        id="theme-wallpaper-target"
        class="text-12 font-semibold"
      >
        {{ heading }}
      </h2>
      <div class="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <img
          v-if="target.sha"
          :src="thumbUrl(target.sha)"
          alt=""
          class="h-9 w-14 flex-none rounded-6 border border-(--d-border2) object-cover"
        >
        <span
          v-else
          class="h-9 w-14 flex-none rounded-6 border border-dashed border-(--d-border2)"
          aria-hidden="true"
        />
        <span class="min-w-32 flex-1 text-12">
          <span class="block truncate font-medium">{{ meta?.name ?? t('themeEditor.wallpapers.noImageTitle') }}</span>
          <span class="block text-11 text-(--d-muted)">{{ meta?.size ?? t('themeEditor.wallpapers.noImageHint') }}</span>
        </span>
      </div>
      <p
        v-if="moving"
        class="flex flex-wrap items-center gap-1.5 text-11 text-(--d-muted)"
      >
        <Badge
          variant="tone"
          class="d-tone-info"
        >
          {{ t('themeEditor.wallpapers.moving') }}
        </Badge>
        {{ t('themeEditor.wallpapers.movingNote') }}
      </p>
      <div
        v-if="flash?.state === 'blocked'"
        class="flex flex-col gap-2 rounded-8 bg-(--d-warning-fill)/10 px-2 py-1.5 text-11.5 text-(--d-warning-text)"
        role="group"
        :aria-label="t('themeEditor.wallpapers.flash.blocked')"
        data-testid="wallpaper-flash-blocked"
      >
        <span class="flex flex-wrap items-center gap-2">
          <AlertTriangle
            class="size-3.5 flex-none"
            aria-hidden="true"
          />
          <Badge
            variant="tone"
            class="d-tone-warning"
          >
            {{ t('themeEditor.wallpapers.flash.blocked') }}
          </Badge>
        </span>
        <span>{{ flash.atMs !== undefined ? t('themeEditor.wallpapers.flash.at', { time: format.duration(flash.atMs) }) : t('themeEditor.wallpapers.flash.found') }}</span>
        <span>{{ t('themeEditor.wallpapers.flash.warning') }}</span>
        <button
          type="button"
          class="sm-button self-start"
          :disabled="readOnly || imports.busy.allowing"
          data-testid="wallpaper-allow-flashing"
          @click="allowFlashing"
        >
          {{ t('themeEditor.wallpapers.flash.allow') }}
        </button>
      </div>
      <p
        v-else-if="flash?.state === 'allowed'"
        class="text-11 text-(--d-muted)"
        data-testid="wallpaper-flash-allowed"
      >
        {{ t('themeEditor.wallpapers.flash.allowed') }}
      </p>
      <p
        v-else-if="flash?.state === 'unchecked'"
        class="text-11 text-(--d-muted)"
      >
        {{ t('themeEditor.wallpapers.flash.unchecked') }}
      </p>
      <div class="flex flex-wrap gap-1.5">
        <button
          type="button"
          class="sm-button"
          :disabled="readOnly || busy"
          data-testid="wallpaper-choose"
          @click="chooseImage"
        >
          <ImagePlus
            class="size-3"
            aria-hidden="true"
          />{{ busy ? t('themeEditor.wallpapers.reading') : t('themeEditor.wallpapers.choose') }}
        </button>
        <button
          v-if="target.sha"
          type="button"
          class="sm-button"
          :disabled="readOnly"
          @click="removeImage"
        >
          <Trash2
            class="size-3"
            aria-hidden="true"
          />{{ t('themeEditor.wallpapers.remove') }}
        </button>
      </div>
      <div
        v-if="busy && checking !== undefined"
        class="flex flex-col gap-1"
        role="status"
        data-testid="wallpaper-flash-progress"
      >
        <span class="text-11 text-(--d-muted)">{{ t('themeEditor.wallpapers.flash.checking', { percent: percent(checking) }) }}</span>
        <Progress
          :model-value="Math.round(checking * 100)"
          class="h-1"
          :aria-label="t('themeEditor.wallpapers.flash.progressLabel')"
        />
      </div>
      <p
        v-if="failure"
        class="text-11 text-(--d-danger-text)"
        role="alert"
      >
        {{ failure }}
      </p>
      <template v-if="target.sha">
        <div class="flex flex-col gap-1.5">
          <span class="text-12 font-medium">{{ t('themeEditor.wallpapers.fitLabel') }}</span>
          <SettingSeg
            :model-value="target.fit"
            :options="fitOptions"
            :label="t('themeEditor.wallpapers.fitLabel')"
            radios
            :disabled="readOnly"
            @update:model-value="(value: Fit) => setTarget({ fit: value })"
          />
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-12 font-medium">{{ t('themeEditor.wallpapers.dim') }}</span>
          <SettingSlider
            :model-value="target.dim"
            :min="DIM_RANGE.min"
            :max="DIM_RANGE.max"
            :step="0.05"
            :label="t('themeEditor.wallpapers.dim')"
            :format="percent"
            :disabled="readOnly"
            live
            @update:model-value="(value: number) => setTarget({ dim: Math.round(value * 100) / 100 })"
          />
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-12 font-medium">{{ t('themeEditor.wallpapers.blur') }}</span>
          <SettingSlider
            :model-value="Math.min(target.blur, maxBlur)"
            :min="0"
            :max="maxBlur"
            :step="1"
            :label="t('themeEditor.wallpapers.blur')"
            :format="pixels"
            :disabled="readOnly"
            live
            data-testid="wallpaper-blur"
            @update:model-value="(value: number) => setTarget({ blur: value })"
          />
          <p class="text-11 text-(--d-muted)">
            {{ t('themeEditor.wallpapers.blurNote', { px: MAX_BLUR_PX, moving: MAX_MOVING_BLUR_PX }) }}
          </p>
        </div>
        <p
          v-if="readability"
          class="flex items-start gap-2 rounded-8 px-2 py-1.5 text-11.5"
          :class="readability.ok ? 'bg-(--d-success-fill)/10 text-(--d-success-text)' : 'bg-(--d-warning-fill)/10 text-(--d-warning-text)'"
          role="status"
          data-testid="wallpaper-readability"
        >
          <component
            :is="readability.ok ? Check : AlertTriangle"
            class="mt-0.5 size-3.5 flex-none"
            aria-hidden="true"
          />
          <span>{{ readability.text }}</span>
        </p>
      </template>
    </section>

    <div class="flex flex-col gap-1">
      <span class="text-12 font-medium">{{ t('themeEditor.wallpapers.surface') }}</span>
      <SettingSlider
        :model-value="surfaceOpacityOf(look)"
        :min="SURFACE_OPACITY_RANGE.min"
        :max="SURFACE_OPACITY_RANGE.max"
        :step="0.02"
        :label="t('themeEditor.wallpapers.surface')"
        :format="percent"
        :disabled="readOnly || !look"
        live
        @update:model-value="setSurface"
      />
      <p class="text-11 text-(--d-muted)">
        {{ t('themeEditor.wallpapers.surfaceNote', { min: format.percent(SURFACE_OPACITY_RANGE.min), trusted: format.percent(TRUSTED_SURFACE_FLOOR) }) }}
      </p>
    </div>

    <section
      class="flex flex-col gap-2"
      aria-labelledby="theme-wallpaper-sets"
      data-testid="wallpaper-sets"
    >
      <h2
        id="theme-wallpaper-sets"
        class="text-12 font-semibold"
      >
        {{ t('themeEditor.wallpapers.sets.title') }}
      </h2>
      <p class="text-11 text-(--d-muted)">
        {{ t('themeEditor.wallpapers.sets.count', { n: sets.length, max: MAX_WALLPAPER_SETS }) }}
      </p>
      <ul
        v-if="sets.length > 0"
        class="flex flex-col gap-1.5"
        :aria-label="t('themeEditor.wallpapers.sets.title')"
      >
        <li
          v-for="(candidate, i) in sets"
          :key="i"
          class="flex items-center gap-1.5 rounded-8 border border-(--d-border2) p-1"
          :class="i === index ? 'bg-(--d-hover)' : ''"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2 rounded-6 p-0.5 text-start"
            :aria-pressed="i === index"
            :aria-label="t('themeEditor.wallpapers.sets.edit', { name: setLabel(candidate, i) })"
            @click="pickSet(i)"
          >
            <img
              v-if="setThumb(candidate)"
              :src="thumbUrl(setThumb(candidate)!)"
              alt=""
              class="h-6 w-9 flex-none rounded-5 border border-(--d-border2) object-cover"
            >
            <span
              v-else
              class="h-6 w-9 flex-none rounded-5 border border-dashed border-(--d-border2)"
              aria-hidden="true"
            />
            <span class="min-w-0 text-11 text-(--d-muted)">{{ setSummary(candidate) }}</span>
          </button>
          <Input
            :model-value="candidate.name ?? ''"
            :placeholder="setLabel(candidate, i)"
            dir="auto"
            :aria-label="t('themeEditor.wallpapers.sets.name', { n: i + 1 })"
            :disabled="readOnly"
            :maxlength="MAX_THEME_NAME_CHARS"
            class="h-7 w-28 flex-none px-2 text-12"
            @change="(event: Event) => renameSet(i, (event.target as HTMLInputElement).value)"
          />
          <button
            type="button"
            class="sm-button px-1"
            :disabled="readOnly || i === 0"
            :aria-label="t('themeEditor.wallpapers.sets.up', { name: setLabel(candidate, i) })"
            @click="moveSet(i, -1)"
          >
            <ArrowUp
              class="size-3"
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            class="sm-button px-1"
            :disabled="readOnly || i === sets.length - 1"
            :aria-label="t('themeEditor.wallpapers.sets.down', { name: setLabel(candidate, i) })"
            @click="moveSet(i, 1)"
          >
            <ArrowDown
              class="size-3"
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            class="sm-button px-1"
            :disabled="readOnly"
            :aria-label="t('themeEditor.wallpapers.sets.remove', { name: setLabel(candidate, i) })"
            @click="removeSet(i)"
          >
            <Trash2
              class="size-3"
              aria-hidden="true"
            />
          </button>
        </li>
      </ul>
      <button
        type="button"
        class="sm-button self-start"
        :disabled="readOnly || !look || sets.length >= MAX_WALLPAPER_SETS"
        data-testid="wallpaper-set-add"
        @click="addSet"
      >
        <Plus
          class="size-3"
          aria-hidden="true"
        />{{ t('themeEditor.wallpapers.sets.add') }}
      </button>
      <div
        v-if="sets.length > 1"
        class="flex flex-col gap-1.5"
      >
        <span class="text-12 font-medium">{{ t('themeEditor.wallpapers.cycle.label') }}</span>
        <SettingSeg
          :model-value="cycleMode"
          :options="cycleOptions"
          :label="t('themeEditor.wallpapers.cycle.label')"
          radios
          :disabled="readOnly"
          @update:model-value="(value: CycleMode) => setCycle(value)"
        />
        <SettingSelect
          v-if="cycleMode === 'timer'"
          :model-value="cycleMinutes"
          :options="minuteOptions"
          :label="t('themeEditor.wallpapers.cycle.minutesLabel')"
          :disabled="readOnly"
          @update:model-value="(value: string) => setCycle('timer', Number(value))"
        />
      </div>
    </section>

    <div
      v-if="proposal"
      class="flex flex-col gap-2"
    >
      <h2 class="text-12 font-semibold">
        {{ t('themeEditor.wallpapers.paletteTitle') }}
      </h2>
      <p class="text-11 text-(--d-muted)">
        {{ t('themeEditor.wallpapers.paletteNote') }}
      </p>
      <button
        type="button"
        class="sm-button self-start"
        :aria-expanded="paletteOpen"
        aria-controls="theme-wallpaper-palette"
        :disabled="readOnly"
        @click="paletteOpen = !paletteOpen"
      >
        <Palette
          class="size-3"
          aria-hidden="true"
        />{{ t('themeEditor.wallpapers.paletteButton') }}
      </button>
      <div
        v-if="paletteOpen && look"
        id="theme-wallpaper-palette"
        class="flex flex-col gap-2"
      >
        <div
          v-for="strip in [{ key: 'now', colors: look.colors }, { key: 'proposed', colors: proposal }]"
          :key="strip.key"
          role="img"
          class="flex items-center gap-1.5"
          :aria-label="stripLabel(t(`themeEditor.wallpapers.strip.${strip.key}`), strip.colors)"
        >
          <span class="w-16 flex-none text-11 text-(--d-muted)">{{ t(`themeEditor.wallpapers.strip.${strip.key}`) }}</span>
          <span class="flex h-5 min-w-0 flex-1 overflow-hidden rounded-5 border border-(--d-border2)">
            <!-- a strip of the look's own colors, which no shadcn part draws -->
            <i
              v-for="seed in LOOK_SEEDS"
              :key="seed"
              class="flex-1"
              :style="{ backgroundColor: strip.colors[seed] }"
              :title="seedColor(seed, strip.colors)"
            />
          </span>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <button
            type="button"
            class="sm-button sm-button-primary"
            @click="applyPalette"
          >
            {{ t('themeEditor.wallpapers.paletteApply') }}
          </button>
          <button
            type="button"
            class="sm-button"
            @click="paletteOpen = false"
          >
            {{ t('themeEditor.wallpapers.paletteKeep') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
