<script setup lang="ts">
import { computed, ref, shallowRef, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { Image as ImageIcon, Layers, LayoutPanelLeft, Lock } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { ColorPicker } from '@/components/ui/color-picker';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import SettingSeg from '@/components/settings/controls/SettingSeg.vue';
import SettingSelect from '@/components/settings/controls/SettingSelect.vue';
import ThemeMiniature from '@/components/theme/ThemeMiniature.vue';
import { IsolatedText } from '@/components/isolated-text';
import { isolated, withoutIsolates } from '@shared/bidi-isolate';
import { canonicalHexColor, type HexColor } from '@shared/hex-color';
import { BUILTIN_THEME, BUILTIN_THEME_ID } from '@shared/themes/builtin';
import { AA } from '@shared/themes/contrast';
import { checkProjectLook, fullThemeKind, shownAccent, touchedTheme, touchesOf, type ProjectLook, type ProjectLookKind, type ProjectTouches } from '@shared/themes/project-looks';
import { FITS, PANELS, type AssetMeta, type Fit, type ThemeFile, type WallpaperSet } from '@shared/themes/schema';
import { DEFAULT_PANEL_LOOK } from '@shared/themes/wallpapers';
import type { LookKind } from '@shared/themes/tokens';
import type { DamoclesOverlayApi, OverlayAnswer, OverlayRequest } from '../../../../preload/overlay-channels';
import { answerOf } from '../../popup-answer';
import { useEditorFormat } from '../../theme-editor/format';

// Project look… from the project's menu: the current theme, touches on top of it, or a theme of its own, stored on this
// computer by core once Save answers. Nothing here applies a window arrangement.
const props = defineProps<{ api: DamoclesOverlayApi; request: Extract<OverlayRequest, { kind: 'projectLook' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t, locale } = useI18n();
const format = useEditorFormat();
const P = 'projectLook';

type Choice = 'none' | 'touches' | 'full';
type WallChoice = 'none' | 'image' | 'theme';

// Marked as user text (isolated), as every name in a sentence here is: IsolatedText shows them.
const name = computed(() => isolated(props.request.projectName));
const themes = computed(() => props.request.themes);
const themeOf = (id: string): ThemeFile | undefined => themes.value.find((entry) => entry.id === id)?.theme ?? (id === BUILTIN_THEME_ID ? BUILTIN_THEME : undefined);
// A theme the look names that is not installed or cannot show: the window shows Damocles' own look in its place.
const isMissing = (id: string): boolean => id !== BUILTIN_THEME_ID && !themes.value.some((entry) => entry.id === id);
const unusableName = (id: string): string | undefined => props.request.unusable?.find((entry) => entry.id === id)?.name;
// With its name while its file still gives one, else without: a theme that is gone has none, and its id is no name.
const missingText = (key: string, id: string, values: Record<string, unknown> = {}): string => {
  const known = unusableName(id);
  return known === undefined ? t(`${P}.${key}Unknown`, values) : t(`${P}.${key}`, { ...values, name: isolated(known) });
};
const themeName = (id: string): string => isolated(themes.value.find((entry) => entry.id === id)?.name ?? (id === BUILTIN_THEME_ID ? BUILTIN_THEME.name : missingText('missingOption', id)));
const kind = computed<LookKind>(() => props.request.shownKind);

const initial = props.request.look;
const initialTouches: ProjectTouches | undefined = initial?.mode === 'touches' ? initial : undefined;
const choice = ref<Choice>(initial?.mode ?? 'none');
const hexText = ref(initialTouches?.accent ?? '');
const wallChoice = ref<WallChoice>(initialTouches?.wallpaper ? 'image' : 'none');
// the image or video a Choose image or video… or the saved touch gave, with the asset entries it names
const image = shallowRef<{ readonly set: WallpaperSet; readonly assets: Readonly<Record<string, AssetMeta>>; readonly name?: string } | undefined>(
  initialTouches?.wallpaper ? { set: initialTouches.wallpaper, assets: initialTouches.assets ?? {} } : undefined,
);
const fit = ref<Fit>(initialTouches?.wallpaper?.span?.fit ?? 'fill');
const wallThemes = computed(() => themes.value.filter((entry) => (['dark', 'light'] as const).some((look) => (entry.theme.looks[look]?.wallpapers?.length ?? 0) > 0)));
const wallFrom = ref(wallThemes.value[0]?.id ?? '');
const characterThemes = computed(() => themes.value.filter((entry) => entry.theme.characters !== undefined));
// no theme id: the id pattern takes no parenthesis
const NO_CHARACTERS = '(none)';
const characters = ref(initialTouches?.characterSet ?? NO_CHARACTERS);
const fullTheme = ref(initial?.mode === 'full' ? initial.themeId : themes.value.find((entry) => entry.id !== BUILTIN_THEME_ID)?.id ?? BUILTIN_THEME_ID);
const fullLook = ref<ProjectLookKind>(initial?.mode === 'full' ? initial.look : 'auto');
const importing = ref(false);
const imageError = ref('');

// Accent
const HEX = /^#[0-9a-f]{6}$/i;
const accentInvalid = computed(() => hexText.value.trim() !== '' && !HEX.test(hexText.value.trim()));
const accent = computed(() => (HEX.test(hexText.value.trim()) ? hexText.value.trim().toLowerCase() : undefined));
const pickerOpen = ref(false);
// the picker starts from the accent, else the accent of the look on screen
const pickerValue = computed<HexColor>(() => canonicalHexColor(accent.value ?? themeOf(props.request.preferred[kind.value])?.looks[kind.value]?.colors.accent ?? BUILTIN_THEME.looks[kind.value]!.colors.accent)!);
const areaValueText = (saturation: number, brightness: number): string => t('colorPicker.areaValue', { saturation, brightness });
const hueValueText = (degrees: number): string => t('colorPicker.hueValue', degrees);

// The accent's text color in each of the user's looks, which the derivation moves to 4.5:1 when the fill is too faint.
const accentStatus = computed(() => {
  if (accentInvalid.value) return [t(`${P}.accentInvalid`)];
  const hex = accent.value;
  if (hex === undefined) return [t(`${P}.accentTheme`)];
  const moved = (['dark', 'light'] as const).flatMap((look) => {
    const source = themeOf(props.request.preferred[look])?.looks[look] ?? BUILTIN_THEME.looks[look]!;
    const shown = shownAccent(source, look, hex);
    const kindWord = t(`${P}.kind.${look}`);
    return [
      ...(shown.text === undefined ? [] : [t(`${P}.accentMoved`, { hex: shown.text, kind: kindWord, need: format.need(AA) })]),
      ...(shown.fill === undefined ? [] : [t(`${P}.accentFillMoved`, { hex: shown.fill, kind: kindWord, need: format.need(AA) })]),
    ];
  });
  return moved.length > 0 ? moved : [t(`${P}.accentKept`, { need: format.need(AA) })];
});

// Wallpaper
function wallpaperOf(): { readonly wallpaper: WallpaperSet; readonly assets: Readonly<Record<string, AssetMeta>> } | undefined {
  if (wallChoice.value === 'image' && image.value) {
    const set = image.value.set;
    return { wallpaper: set.span ? { ...set, span: { ...set.span, fit: fit.value } } : set, assets: image.value.assets };
  }
  if (wallChoice.value === 'theme') {
    const source = themeOf(wallFrom.value);
    const look = source?.looks[kind.value]?.wallpapers?.length ? source.looks[kind.value] : source?.looks.dark?.wallpapers?.length ? source.looks.dark : source?.looks.light;
    const set = look?.wallpapers?.[0];
    if (!source || !set) return undefined;
    const named = new Set([...(set.span ? [set.span.asset] : []), ...Object.values(set.panels ?? {}).map((panel) => panel!.asset)]);
    return { wallpaper: set, assets: Object.fromEntries(Object.entries(source.assets ?? {}).filter(([sha]) => named.has(sha))) };
  }
  return undefined;
}

async function chooseImage(): Promise<void> {
  if (importing.value) return;
  importing.value = true;
  imageError.value = '';
  try {
    const result = await answerOf(props.api.projectLookImage());
    if (!result) return;
    if (!result.ok) {
      if (!('cancelled' in result)) imageError.value = t(`${P}.imageFailed`, { reason: result.error });
      return;
    }
    const { sha256, asset } = result.image;
    const spanLook = Object.fromEntries(PANELS.map((panel) => [panel, { dim: DEFAULT_PANEL_LOOK.dim, blur: DEFAULT_PANEL_LOOK.blur }]));
    image.value = { set: { span: { asset: sha256, panels: [...PANELS], fit: fit.value }, spanLook }, assets: { [sha256]: asset }, name: result.name };
  } catch (error) {
    imageError.value = t(`${P}.imageFailed`, { reason: error instanceof Error ? error.message : String(error) });
  } finally {
    importing.value = false;
  }
}

// What Save stores: null for the current theme and for touches that set nothing, which clears the project's look; undefined
// for a look that does not check, which Save never sends.
const look = computed<ProjectLook | null | undefined>(() => {
  if (choice.value === 'none') return null;
  if (choice.value === 'full') return checkProjectLook({ mode: 'full', themeId: fullTheme.value, look: fullLook.value });
  const wall = wallpaperOf();
  const draft: ProjectTouches = {
    mode: 'touches',
    ...(accent.value !== undefined ? { accent: accent.value } : {}),
    ...(wall ? { wallpaper: wall.wallpaper, assets: wall.assets } : {}),
    ...(characters.value !== NO_CHARACTERS ? { characterSet: characters.value } : {}),
  };
  return touchesOf(draft).length === 0 ? null : checkProjectLook(draft);
});
const saveTried = ref(false);
const invalid = computed(() => saveTried.value && look.value === undefined);

// Preview: the theme the window would show for the project, with its touches
const fullHas = (id: string, look: LookKind): boolean => themeOf(id)?.looks[look] !== undefined;
const preview = computed<{ readonly theme: ThemeFile; readonly mode: LookKind | 'split'; readonly caption: string }>(() => {
  const now = kind.value;
  const kindWord = (look: LookKind): string => t(`${P}.kind.${look}`);
  if (choice.value === 'full') {
    const id = fullTheme.value;
    // as main resolves it: a theme that is missing or lacks the look shows Damocles' own look of that kind
    const shown = fullThemeKind(fullLook.value, (look) => fullHas(id, look), now).kind;
    if (!fullHas(id, shown)) {
      const caption = isMissing(id) ? missingText('caption.fullMissing', id, { kind: kindWord(shown) }) : t(`${P}.caption.fullNoLook`, { theme: themeName(id), kind: kindWord(shown) });
      return { theme: BUILTIN_THEME, mode: shown, caption };
    }
    const caption = fullLook.value === 'auto'
      ? t(`${P}.caption.fullAuto`, { theme: themeName(id), kind: kindWord(shown) })
      : t(`${P}.caption.full`, { theme: themeName(id), kind: kindWord(shown) });
    return { theme: themeOf(id)!, mode: shown, caption };
  }
  const baseId = props.request.preferred[now];
  const base = themeOf(baseId)?.looks[now] ? themeOf(baseId)! : BUILTIN_THEME;
  const baseName = base === BUILTIN_THEME ? themeName(BUILTIN_THEME_ID) : themeName(baseId);
  if (choice.value === 'none') return { theme: base, mode: now, caption: t(`${P}.caption.none`, { theme: baseName, kind: kindWord(now) }) };
  const touches = look.value?.mode === 'touches' ? look.value : undefined;
  if (!touches) return { theme: base, mode: now, caption: t(`${P}.caption.noTouches`, { theme: baseName, kind: kindWord(now) }) };
  const characterSource = touches.characterSet !== undefined ? themeOf(touches.characterSet) : undefined;
  const list = new Intl.ListFormat(locale.value, { type: 'conjunction' }).format(touchesOf(touches).map((touch) => t(`${P}.touch.${touch}`)));
  return { theme: touchedTheme(base, touches, characterSource), mode: now, caption: t(`${P}.caption.touches`, { theme: baseName, kind: kindWord(now), list }) };
});

// Options
const choices = computed(() => (['none', 'touches', 'full'] as const).map((value) => ({ value, label: t(`${P}.choice.${value}`), hint: t(`${P}.choice.${value}Hint`, { name: name.value }) })));
const wallOptions = computed(() => [
  { value: 'none' as const, label: t(`${P}.wallNone`) },
  { value: 'image' as const, label: t(`${P}.wallImage`) },
  { value: 'theme' as const, label: t(`${P}.wallTheme`), disabled: wallThemes.value.length === 0 },
]);
const fitOptions = computed(() => FITS.map((value) => ({ value, label: t(`${P}.fits.${value}`) })));
const wallFromOptions = computed(() => wallThemes.value.map((entry) => ({ value: entry.id, label: isolated(entry.name) })));
const charactersMissing = computed(() => characters.value !== NO_CHARACTERS && !characterThemes.value.some((entry) => entry.id === characters.value));
const characterOptions = computed(() => [
  { value: NO_CHARACTERS, label: t(`${P}.charactersNone`) },
  ...(charactersMissing.value ? [{ value: characters.value, label: t(`${P}.charactersMissingOption`), disabled: true }] : []),
  ...characterThemes.value.map((entry) => {
    const set = entry.theme.characters!.name;
    return { value: entry.id, label: set === entry.name ? isolated(entry.name) : t(`${P}.charactersFrom`, { set: isolated(set), theme: isolated(entry.name) }) };
  }),
]);
const themeOptions = computed<{ value: string; label: string; disabled?: boolean }[]>(() => [
  ...(isMissing(fullTheme.value) ? [{ value: fullTheme.value, label: missingText('missingOption', fullTheme.value), disabled: true }] : []),
  ...themes.value.map((entry) => ({ value: entry.id, label: isolated(entry.name) })),
]);
const lookOptions = computed(() => (['dark', 'light', 'auto'] as const).map((value) => ({ value, label: t(`${P}.looks.${value}`), disabled: value !== 'auto' && !fullHas(fullTheme.value, value) })));
function setFullTheme(id: string): void {
  fullTheme.value = id;
  // a look the new theme lacks turns into auto
  if (fullLook.value !== 'auto' && !fullHas(id, fullLook.value)) fullLook.value = 'auto';
}
const fullMode = computed<LookKind | 'split'>(() => {
  const theme = themeOf(fullTheme.value);
  if (fullLook.value !== 'auto') return fullLook.value;
  return theme?.looks.dark && theme.looks.light ? 'split' : theme?.looks.light ? 'light' : 'dark';
});

// Answers
let answered = false;
function cancel(): void {
  if (answered) return;
  answered = true;
  emit('answer', { kind: 'dismissed' });
}
const accentInput = ref<InstanceType<typeof Input> | null>(null);
function save(): void {
  // an image still being read is not in the look yet
  if (answered || importing.value) return;
  if (choice.value === 'touches' && accentInvalid.value) {
    (accentInput.value?.$el as HTMLElement | undefined)?.focus();
    return;
  }
  const saved = look.value;
  saveTried.value = true;
  if (saved === undefined) return;
  answered = true;
  emit('answer', { kind: 'projectLook', look: saved });
}

const ids = { accent: useId(), accentStatus: useId(), accentHint: useId(), wallHint: useId(), charactersHint: useId(), lookHint: useId() };
</script>

<template>
  <Dialog
    :open="true"
    @update:open="(open: boolean) => !open && cancel()"
  >
    <DialogContent
      inline
      data-testid="project-look"
      class="flex max-h-[calc(100%-2rem)] w-[min(52rem,calc(100%-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0"
    >
      <div class="flex flex-col gap-1 border-b border-(--d-border) px-5 py-4 pr-12">
        <DialogTitle class="text-sm font-semibold">
          <IsolatedText :text="t(`${P}.title`, { name })" />
        </DialogTitle>
        <DialogDescription class="text-12 text-(--d-muted)">
          <IsolatedText :text="t(`${P}.description`, { name })" />
        </DialogDescription>
      </div>

      <div class="@container/look min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div class="grid gap-5 @min-[40rem]/look:grid-cols-[minmax(0,1fr)_16rem]">
          <div class="flex min-w-0 flex-col gap-5">
            <RadioGroup
              :model-value="choice"
              :aria-label="withoutIsolates(t(`${P}.title`, { name }))"
              class="flex flex-col gap-2"
              @update:model-value="(value: unknown) => (choice = value as Choice)"
            >
              <div
                v-for="option in choices"
                :key="option.value"
                class="flex items-start gap-2.5 rounded-9 border px-3 py-2.5"
                :class="choice === option.value ? 'border-(--d-accent-fill) bg-(--d-accent-soft)' : 'border-(--d-border2)'"
              >
                <RadioGroupItem
                  :id="`project-look-${option.value}`"
                  :value="option.value"
                  :aria-describedby="`project-look-${option.value}-hint`"
                  class="mt-0.5"
                />
                <span class="flex min-w-0 flex-col gap-0.5">
                  <Label
                    :for="`project-look-${option.value}`"
                    class="cursor-pointer text-12.5 font-medium"
                  >{{ option.label }}</Label>
                  <span
                    :id="`project-look-${option.value}-hint`"
                    class="text-11.5 text-(--d-muted)"
                  ><IsolatedText :text="option.hint" /></span>
                </span>
              </div>
            </RadioGroup>

            <section
              v-if="choice === 'none'"
              :aria-label="t(`${P}.noneHead`)"
              class="flex flex-col gap-1.5"
            >
              <h3 class="text-12 font-semibold">
                {{ t(`${P}.noneHead`) }}
              </h3>
              <p class="text-12 text-(--d-muted)">
                <IsolatedText :text="t(`${P}.noneText`, { name })" />
              </p>
            </section>

            <section
              v-else-if="choice === 'touches'"
              :aria-label="t(`${P}.touchesHead`)"
              class="flex flex-col gap-4"
            >
              <h3 class="text-12 font-semibold">
                {{ t(`${P}.touchesHead`) }}
              </h3>
              <div class="flex flex-col gap-1.5">
                <Label
                  :for="ids.accent"
                  class="text-12 font-medium"
                >{{ t(`${P}.accent`) }}</Label>
                <p
                  :id="ids.accentHint"
                  class="text-11.5 text-(--d-muted)"
                >
                  {{ t(`${P}.accentHint`) }}
                </p>
                <div class="flex flex-wrap items-center gap-2">
                  <Popover v-model:open="pickerOpen">
                    <PopoverTrigger as-child>
                      <!-- a swatch of the picked color, which no shadcn part draws -->
                      <button
                        type="button"
                        data-testid="project-look-swatch"
                        class="size-7.5 shrink-0 rounded-7 border border-(--d-border2) focus-visible:outline-2 focus-visible:outline-(--d-accent-fill)"
                        :class="accent === undefined ? 'bg-[repeating-linear-gradient(45deg,var(--d-border2)_0_0.25rem,var(--d-card)_0_0.5rem)]' : ''"
                        :style="accent !== undefined ? { backgroundColor: accent } : undefined"
                        :aria-label="t(`${P}.pickAccent`)"
                      />
                    </PopoverTrigger>
                    <PopoverContent
                      align="start"
                      class="w-60"
                      data-testid="project-look-picker"
                    >
                      <ColorPicker
                        :model-value="pickerValue"
                        :area-label="t('colorPicker.area')"
                        :area-thumb-label="t('colorPicker.areaThumb')"
                        :hue-label="t('colorPicker.hue')"
                        :hex-label="t('colorPicker.hex')"
                        :preview-label="t('colorPicker.preview')"
                        :area-value-text="areaValueText"
                        :hue-value-text="hueValueText"
                        opaque
                        @update:model-value="(value: HexColor) => (hexText = value.slice(0, 7))"
                      />
                    </PopoverContent>
                  </Popover>
                  <Input
                    :id="ids.accent"
                    ref="accentInput"
                    :model-value="hexText"
                    class="h-7.5 w-28 px-2 font-mono text-12"
                    spellcheck="false"
                    autocomplete="off"
                    maxlength="7"
                    :placeholder="t(`${P}.accentPlaceholder`)"
                    :aria-invalid="accentInvalid ? 'true' : undefined"
                    :aria-describedby="`${ids.accentHint} ${ids.accentStatus}`"
                    @update:model-value="(value: string | number) => (hexText = String(value))"
                  />
                  <Button
                    v-if="accent !== undefined"
                    type="button"
                    variant="ghost"
                    size="sm"
                    class="h-7.5 px-2 text-12"
                    @click="hexText = ''"
                  >
                    {{ t(`${P}.clearAccent`) }}
                  </Button>
                </div>
                <div
                  :id="ids.accentStatus"
                  aria-live="polite"
                  data-testid="project-look-accent-status"
                  class="flex flex-col text-11.5"
                  :class="accentInvalid ? 'text-(--d-danger-text)' : 'text-(--d-muted)'"
                >
                  <span
                    v-for="line in accentStatus"
                    :key="line"
                  >{{ line }}</span>
                </div>
              </div>

              <div class="flex flex-col gap-1.5">
                <span class="text-12 font-medium">{{ t(`${P}.wallpaper`) }}</span>
                <p
                  :id="ids.wallHint"
                  class="text-11.5 text-(--d-muted)"
                >
                  {{ t(`${P}.wallpaperHint`) }}
                </p>
                <div class="flex">
                  <SettingSeg
                    :model-value="wallChoice"
                    :options="wallOptions"
                    :label="t(`${P}.wallpaper`)"
                    :describedby="ids.wallHint"
                    radios
                    @update:model-value="(value: WallChoice) => (wallChoice = value)"
                  />
                </div>
                <div
                  v-if="wallChoice === 'image'"
                  class="flex flex-wrap items-center gap-2"
                >
                  <span
                    class="max-w-48 truncate text-12"
                    data-testid="project-look-image"
                  ><bdi v-if="image?.name !== undefined">{{ image.name }}</bdi><template v-else>{{ image ? t(`${P}.currentImage`) : t(`${P}.noImage`) }}</template></span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    class="h-7.5 gap-1.5 px-2.5 text-12"
                    :disabled="importing"
                    @click="chooseImage"
                  >
                    <ImageIcon
                      class="size-3.5"
                      aria-hidden="true"
                    />{{ importing ? t(`${P}.importing`) : t(`${P}.chooseImage`) }}
                  </Button>
                  <!-- a fit belongs to an image that spans the panes; a set of per-pane images has none -->
                  <div
                    v-if="image?.set.span"
                    class="w-32"
                  >
                    <SettingSelect
                      :model-value="fit"
                      :options="fitOptions"
                      :label="t(`${P}.fit`)"
                      @update:model-value="(value: Fit) => (fit = value)"
                    />
                  </div>
                </div>
                <div
                  v-if="wallChoice === 'theme'"
                  class="max-w-64"
                >
                  <SettingSelect
                    :model-value="wallFrom"
                    :options="wallFromOptions"
                    :label="t(`${P}.wallFrom`)"
                    @update:model-value="(value: string) => (wallFrom = value)"
                  />
                </div>
                <p
                  v-if="imageError"
                  role="alert"
                  class="text-11.5 text-(--d-danger-text)"
                >
                  {{ imageError }}
                </p>
              </div>

              <div class="flex flex-col gap-1.5">
                <span class="text-12 font-medium">{{ t(`${P}.characters`) }}</span>
                <p
                  :id="ids.charactersHint"
                  class="text-11.5 text-(--d-muted)"
                >
                  {{ t(`${P}.charactersHint`) }}
                </p>
                <div class="max-w-64">
                  <SettingSelect
                    :model-value="characters"
                    :options="characterOptions"
                    :label="t(`${P}.characters`)"
                    :describedby="ids.charactersHint"
                    @update:model-value="(value: string) => (characters = value)"
                  />
                </div>
                <p
                  v-if="charactersMissing"
                  class="text-11.5 text-(--d-warning-text)"
                  data-testid="project-look-characters-missing"
                >
                  {{ t(`${P}.charactersMissing`) }}
                </p>
              </div>
            </section>

            <section
              v-else
              :aria-label="t(`${P}.fullHead`)"
              class="flex flex-col gap-4"
            >
              <h3 class="text-12 font-semibold">
                {{ t(`${P}.fullHead`) }}
              </h3>
              <div class="flex items-center gap-3">
                <div class="w-24 shrink-0">
                  <ThemeMiniature
                    :theme="themeOf(fullTheme) ?? BUILTIN_THEME"
                    :mode="fullMode"
                    :label="isMissing(fullTheme) ? t(`${P}.miniatureMissing`) : withoutIsolates(t(`${P}.miniature`, { theme: themeName(fullTheme) }))"
                  />
                </div>
                <div class="min-w-0 flex-1">
                  <SettingSelect
                    :model-value="fullTheme"
                    :options="themeOptions"
                    :label="t(`${P}.theme`)"
                    @update:model-value="setFullTheme"
                  />
                </div>
              </div>
              <p
                v-if="isMissing(fullTheme)"
                class="text-11.5 text-(--d-warning-text)"
                data-testid="project-look-theme-missing"
              >
                <IsolatedText :text="missingText('themeMissing', fullTheme)" />
              </p>
              <div class="flex flex-col gap-1.5">
                <span class="text-12 font-medium">{{ t(`${P}.look`) }}</span>
                <p
                  :id="ids.lookHint"
                  class="text-11.5 text-(--d-muted)"
                >
                  {{ t(`${P}.lookHint`) }}
                </p>
                <div class="flex">
                  <SettingSeg
                    :model-value="fullLook"
                    :options="lookOptions"
                    :label="t(`${P}.look`)"
                    :describedby="ids.lookHint"
                    radios
                    @update:model-value="(value: ProjectLookKind) => (fullLook = value)"
                  />
                </div>
              </div>
            </section>
          </div>

          <div
            role="group"
            :aria-label="t(`${P}.preview`)"
            class="flex min-w-0 flex-col gap-2"
          >
            <h3 class="text-12 font-semibold">
              {{ t(`${P}.preview`) }}
            </h3>
            <ThemeMiniature
              :theme="preview.theme"
              :mode="preview.mode"
              :label="withoutIsolates(t(`${P}.previewLabel`, { caption: preview.caption }))"
            />
            <p
              aria-live="polite"
              data-testid="project-look-caption"
              class="text-11.5 text-(--d-muted)"
            >
              <IsolatedText :text="preview.caption" />
            </p>
          </div>
        </div>

        <ul class="mt-5 flex flex-col gap-1.5 border-t border-(--d-border) pt-3 text-11.5 text-(--d-muted)">
          <li class="flex items-start gap-2">
            <Layers
              class="mt-0.5 size-3.5 shrink-0"
              aria-hidden="true"
            />{{ t(`${P}.notes.order`) }}
          </li>
          <li class="flex items-start gap-2">
            <Lock
              class="mt-0.5 size-3.5 shrink-0"
              aria-hidden="true"
            />{{ t(`${P}.notes.stored`) }}
          </li>
          <li class="flex items-start gap-2">
            <LayoutPanelLeft
              class="mt-0.5 size-3.5 shrink-0"
              aria-hidden="true"
            />{{ t(`${P}.notes.arrangement`) }}
          </li>
        </ul>
      </div>

      <div class="flex items-center justify-end gap-2 border-t border-(--d-border) px-5 py-3">
        <p
          v-if="invalid"
          role="alert"
          class="me-auto text-11.5 text-(--d-danger-text)"
          data-testid="project-look-invalid"
        >
          {{ t(`${P}.invalid`) }}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="project-look-cancel"
          class="h-7.5 px-3 text-12"
          @click="cancel"
        >
          {{ t(`${P}.cancel`) }}
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid="project-look-save"
          class="h-7.5 px-3 text-12 font-semibold aria-disabled:cursor-default aria-disabled:opacity-(--d-opacity-disabled)"
          :aria-disabled="importing ? 'true' : undefined"
          @click="save"
        >
          {{ t(`${P}.save`) }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
