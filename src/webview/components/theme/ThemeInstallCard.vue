<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertTriangle, CircleAlert, Download, Info, LoaderCircle, Minus } from 'lucide-vue-next';
import { isolated, withoutIsolates } from '@shared/bidi-isolate';
import type { ThemeInstallAnswer, ThemeInstallClashChoice, ThemeInstallFont, ThemeInstallFormat, ThemeInstallPreview, ThemeInstallWallpaper } from '@shared/themes/install';
import type { LookColors } from '@shared/themes/schema';
import { LOOK_KINDS, type LookKind } from '@shared/themes/tokens';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { IsolatedText } from '../isolated-text';
import TrustedCheckingNote from '../TrustedCheckingNote.vue';
import ThemeMiniature from './ThemeMiniature.vue';
import { contrastText, droppedCssText, listText, themeNameText } from './theme-words';
import { isHexColor } from './theme-view';
import { formatBytes } from '@/utils/format-bytes';
import { useDockPromptDigits } from '@/composables/useDockPrompt';
import { useLocalizedText } from '@/composables/useLocalizedText';
import { useTrustedVisibility } from '@/composables/useTrustedVisibility';

// What a theme file holds before anything installs: docked above a chat's composer for the agent's ThemeSet install, and the
// body of the Settings install dialog for Import, Install from link and damocles:// links. Trusted UI with Damocles' fonts.
const props = defineProps<{
  preview: ThemeInstallPreview;
  variant: 'dock' | 'dialog';
  // HostCapabilities.damoclesTheme in a chat; the overlay always checks
  gated: boolean;
  // a chat whose host is away holds its prompts and says so itself, so the card does not explain the check
  quiet?: boolean;
  // the Install went out and no answer came back yet: Install is held; a docked card's Cancel still acts, the dialog's does not
  busy?: boolean;
  // the wallpaper thumbnails the page holds, as URLs by the wallpaper's sha256; absent: the preview's own data URLs
  thumbs?: Readonly<Record<string, string>> | undefined;
  // how far each running flash check is, 0 to 1, by the wallpaper's sha256
  progress?: Readonly<Record<string, number>> | undefined;
  // a remote chat's card on a device the install does not land on: it names that computer and offers Cancel only
  otherDevice?: { readonly computer?: string } | undefined;
}>();

const emit = defineEmits<{
  (e: 'answer', answer: ThemeInstallAnswer): void;
  /** The user's Allow flashing for this file, for a wallpaper the card lists as flagged. */
  (e: 'allow-flash', sha256: string): void;
  /** The card left while it held focus; the page hands focus on. */
  (e: 'release-focus'): void;
}>();

const { t, te, locale } = useI18n();
const { rt } = useLocalizedText();
const cardRef = ref<HTMLElement | null>(null);
const { isVisible, explain, refuse } = useTrustedVisibility(cardRef, () => props.gated, { quiet: () => props.quiet === true });
const locked = computed(() => !isVisible.value || props.busy === true);
// Core takes a docked card's Cancel whenever it takes an answer; the Settings dialog's install cannot be cancelled once it commits.
const cancelLocked = computed(() => !isVisible.value || (props.busy === true && props.variant === 'dialog'));
const words = computed(() => ({ t, locale: locale.value }));

const name = computed(() => props.preview.about.name);
const update = computed(() => props.preview.store?.update);
const title = computed(() => (update.value && props.preview.store
  ? t('themeInstall.updateTitle', { name: isolated(name.value), version: props.preview.store.version })
  : t('themeInstall.title', { name: isolated(name.value) })));
const theme = computed(() => props.preview.theme);
const kinds = computed(() => LOOK_KINDS.filter((kind) => theme.value.looks[kind] !== undefined));
const miniMode = computed<'split' | LookKind>(() => (kinds.value.length === 2 ? 'split' : kinds.value[0] ?? 'dark'));
const miniLabel = computed(() => t('themeInstall.miniLabel', { name: name.value, looks: t(`themeInstall.miniLooks.${miniMode.value}`) }));
const looksText = computed(() => t(`themeInstall.looks.${miniMode.value}`));

const FILE_SOURCE_KEYS: Readonly<Record<ThemeInstallFormat, string>> = {
  damocles: 'themeInstall.source.file',
  vscode: 'themeInstall.source.vscodeFile',
  base16: 'themeInstall.source.base16File',
  gtk: 'themeInstall.source.gtkFile',
  kde: 'themeInstall.source.kdeFile',
  qt: 'themeInstall.source.qtFile',
};

// The source host is what the user trusts or not, so it renders apart and in mono, as the `source` part of its message; a
// file shows its name instead. A store file matched the signed list's pin, so the list, not the download host, vouches for it.
const source = computed<{ readonly text: string } | { readonly keypath: string; readonly value: string }>(() => {
  const { kind, host, fileName } = props.preview.source;
  if (kind === 'store') {
    const author = props.preview.about.author;
    return { text: author ? t('themeInstall.source.storeBy', { author }) : t('themeInstall.source.store') };
  }
  // a newer peer may send a format or source kind this build has no words for
  if (kind === 'file') {
    const { format } = props.preview;
    return { keypath: Object.hasOwn(FILE_SOURCE_KEYS, format) ? FILE_SOURCE_KEYS[format] : 'themeInstall.source.file', value: fileName ?? '' };
  }
  const keypath = `themeInstall.source.${kind}`;
  return { keypath: te(keypath) ? keypath : 'themeInstall.source.file', value: host ?? '' };
});
const conversionKey = computed(() => `themeInstall.conversion.${props.preview.format}`);

const SWATCHES: readonly (keyof LookColors)[] = ['background', 'panel', 'text', 'accent'];
// each seed is drawn only when it is a hex color
const swatches = computed(() => kinds.value.map((kind) => ({ kind, colors: SWATCHES.map((seed) => theme.value.looks[kind]!.colors[seed]).filter(isHexColor) })));

function licenseOf(font: ThemeInstallFont): string {
  if (font.license.spdx) return font.license.spdx;
  return font.license.text ? t('themeInstall.fonts.licenseText') : t('themeInstall.fonts.noLicense');
}
const fonts = computed(() => props.preview.fonts.map((font) => ({
  key: `${font.role}-${font.family}`,
  text: t(`themeInstall.fonts.${font.source}`, { family: font.family, role: t(`themeInstall.fonts.role.${font.role}`), license: licenseOf(font) }),
})));

const FORMATS: Readonly<Record<string, string>> = {
  'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/avif': 'AVIF', 'image/gif': 'GIF', 'video/mp4': 'MP4', 'video/webm': 'WebM',
};
const secondsFormat = computed(() => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 1 }));
const seconds = (ms: number): string => secondsFormat.value.format(ms / 1000);
function wallpaperText(wallpaper: ThemeInstallWallpaper): string {
  const named = { format: FORMATS[wallpaper.mime] ?? wallpaper.mime, width: wallpaper.width, height: wallpaper.height, size: formatBytes(wallpaper.bytes, locale.value) };
  if (wallpaper.kind === 'image') return t('themeInstall.wallpapers.still', named);
  if (wallpaper.durationMs !== undefined) return t('themeInstall.wallpapers.movingTimed', { ...named, seconds: seconds(wallpaper.durationMs) });
  return t('themeInstall.wallpapers.movingFrames', { ...named, n: wallpaper.frames ?? 0 }, wallpaper.frames ?? 0);
}
// one line per look the wallpaper sits in
function placementLines(wallpaper: ThemeInstallWallpaper): string[] {
  return wallpaper.placements.map((place) => t(place.span ? 'themeInstall.wallpapers.span' : 'themeInstall.wallpapers.panels', {
    look: t(`themeInstall.look.${place.look}`),
    panels: listText(locale.value, place.panels.map((panel) => t(`themeInstall.panel.${panel}`))),
  }));
}
// A thumbnail is drawn only from what this page holds: its cache's URL, or the preview's own WebP data URL.
const WEBP_DATA_URL = 'data:image/webp;base64,';
const thumbBySha = computed<Readonly<Record<string, string>>>(() => props.thumbs ?? Object.fromEntries(props.preview.wallpapers.flatMap((wallpaper) =>
  (wallpaper.thumb?.startsWith(WEBP_DATA_URL) === true ? [[wallpaper.sha256, wallpaper.thumb]] : []))));
const miniThumb = (asset: string): string => thumbBySha.value[asset] ?? '';
const wallpapers = computed(() => props.preview.wallpapers.map((wallpaper) => {
  const checked = props.progress?.[wallpaper.sha256];
  return {
    sha: wallpaper.sha256,
    thumb: thumbBySha.value[wallpaper.sha256],
    flash: wallpaper.flash,
    allowed: wallpaper.allowed === true,
    text: wallpaperText(wallpaper),
    placements: placementLines(wallpaper),
    percent: wallpaper.flash === 'pending' && checked !== undefined ? Math.round(checked * 100) : undefined,
    flagged: wallpaper.flash === 'flagged'
      ? (wallpaper.atMs !== undefined ? t('themeInstall.wallpapers.flaggedAt', { time: t('themeInstall.wallpapers.seconds', { seconds: seconds(wallpaper.atMs) }) }) : t('themeInstall.wallpapers.flagged'))
      : undefined,
  };
}));

// Only the user allows a file to flash, and only on the device the install lands on.
function allowFlash(sha256: string): void {
  if (locked.value || props.otherDevice !== undefined) return;
  emit('allow-flash', sha256);
}
const moving = computed(() => props.preview.wallpapers.some((wallpaper) => wallpaper.kind !== 'image'));

const cssRegions = computed(() => props.preview.css.map((part) => t(`themeAgent.cssRegion.${part.region}`)));
const dropped = computed(() => props.preview.css.flatMap((part) => part.dropped).map((part, index) => ({
  key: `${part.region}-${part.reason}-${index}`,
  code: part.text,
  text: droppedCssText(words.value, part),
})));
const droppedMore = computed(() => props.preview.cssDroppedMore ?? 0);
const contrast = computed(() => props.preview.contrast.map((issue, index) => ({ key: `${issue.look}-${issue.fg}-${issue.bg}-${index}`, look: issue.look, text: contrastText(words.value, issue) })));
const warnings = computed(() => props.preview.warnings.map((warning) => rt(warning)));

// Where the arrangement puts the editor and terminal around the chat; one without panes holds only the sidebar.
const arrangementText = computed(() => {
  const grid = theme.value.layout?.grid;
  if (!grid) return t('themeInstall.arrangement.presentPlain');
  const shown = (pane: 'chat' | 'editor' | 'terminal'): boolean => pane === 'chat' || grid.visible[pane];
  const place = (slot: 'main' | 'side' | 'bottom'): string | undefined => {
    const pane = grid.slots[slot];
    if (slot === 'main' && pane === 'chat') return undefined;
    const named = { pane: t(`themeInstall.arrangement.pane.${pane}`) };
    return shown(pane) ? t(`themeInstall.arrangement.slot.${slot}`, named) : t('themeInstall.arrangement.hidden', named);
  };
  const parts = (['main', 'side', 'bottom'] as const).flatMap((slot) => place(slot) ?? []);
  return t('themeInstall.arrangement.present', { parts: listText(locale.value, parts) });
});

// Keep both is the default on a clash; a built-in is never replaced.
const clash = computed(() => props.preview.clash);
const onClash = ref<ThemeInstallClashChoice>('keepBoth');
const useArrangement = ref(false);
watch(() => props.preview.installId, (_id, was) => {
  if (was !== undefined && cardRef.value?.contains(document.activeElement)) emit('release-focus');
  onClash.value = 'keepBoth';
  useArrangement.value = false;
}, { flush: 'pre' });
// a clash that changed while the card was open (another theme of that name, maybe a built-in) is chosen afresh
watch([() => clash.value?.themeId, () => clash.value?.replaceable], () => {
  onClash.value = 'keepBoth';
});
onBeforeUnmount(() => {
  if (cardRef.value?.contains(document.activeElement)) emit('release-focus');
});

const installLabel = computed(() => {
  const held = clash.value;
  if (!held) return update.value ? t('themeInstall.update') : t('themeInstall.install');
  return onClash.value === 'replace' ? t('themeInstall.replaceInstall') : t('themeInstall.installAs', { name: isolated(held.keepBothName) });
});

function install(): void {
  if (locked.value || props.otherDevice !== undefined) return;
  emit('answer', clash.value ? { choice: 'install', onClash: onClash.value, useArrangement: useArrangement.value } : { choice: 'install', useArrangement: useArrangement.value });
}
function cancel(): void {
  if (cancelLocked.value) return;
  emit('answer', { choice: 'cancel' });
}

// Docked, digits answer as on the other theme cards: 1 installs, 2 cancels; another device's card has Cancel alone, as 1.
useDockPromptDigits(() => (props.variant === 'dock' ? cardRef.value : null), (digit) => {
  if (cancelLocked.value) return false;
  if (props.otherDevice !== undefined) {
    if (digit !== 1) return false;
    cancel();
    return true;
  }
  if (digit > 2 || (digit === 1 && locked.value)) return false;
  if (digit === 1) install();
  else cancel();
  return true;
}, refuse);

const titleTag = computed(() => (props.variant === 'dialog' ? DialogTitle : 'h2'));
const subTag = computed(() => (props.variant === 'dialog' ? DialogDescription : 'p'));
</script>

<template>
  <section
    ref="cardRef"
    class="@container/pcard relative flex min-h-0 flex-col overflow-x-hidden overflow-y-auto text-(--d-text)"
    :class="variant === 'dock' ? 'max-h-[70dvh] rounded-14 border border-[color-mix(in_srgb,var(--d-accent-fill)_40%,var(--d-border))] bg-(--d-card) [--attention-ring:var(--d-accent-fill)]' : ''"
    role="region"
    :aria-label="withoutIsolates(title)"
    :data-dock-prompt="variant === 'dock' ? '' : undefined"
    data-trusted
    data-testid="theme-install-card"
    :data-variant="variant"
  >
    <header class="flex flex-none items-center gap-2.5 border-b border-(--d-border) bg-linear-to-b from-[color-mix(in_srgb,var(--d-accent-fill)_12%,transparent)] to-transparent px-3 py-2">
      <span
        class="d-ring [--tone:var(--d-accent-fill)] flex size-6.5 flex-none items-center justify-center rounded-8 bg-[color-mix(in_srgb,var(--d-accent-fill)_16%,transparent)] text-(--d-accent)"
        aria-hidden="true"
      >
        <Download class="size-3.5" />
      </span>
      <div class="min-w-0 flex-1">
        <component
          :is="titleTag"
          class="text-13 font-semibold text-pretty wrap-anywhere"
        >
          <IsolatedText :text="title" />
        </component>
        <component
          :is="subTag"
          class="flex flex-wrap items-baseline gap-x-1.5 text-xs text-(--d-muted)"
          data-testid="theme-install-source"
        >
          <span v-if="'text' in source">{{ source.text }}</span>
          <i18n-t
            v-else
            :keypath="source.keypath"
            tag="span"
            scope="global"
          >
            <template #source>
              <span
                class="rounded-5 bg-(--d-hover) px-1 font-mono font-semibold text-(--d-text) wrap-anywhere"
                data-testid="theme-install-host"
              >{{ source.value }}</span>
            </template>
          </i18n-t>
        </component>
      </div>
    </header>

    <!-- Scrolls when long; focusable so a keyboard user can scroll it too. -->
    <div
      class="flex min-h-0 flex-col gap-2.5 overflow-y-auto px-3.5 pt-2.5 pb-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-(--d-accent-fill) focus-visible:ring-inset"
      :class="variant === 'dock' ? 'max-h-80' : 'max-h-[30rem]'"
      role="region"
      :aria-label="t('themeInstall.details')"
      tabindex="0"
      data-testid="theme-install-details"
    >
      <div class="grid grid-cols-1 items-start gap-x-4 gap-y-2.5 @min-[36rem]/pcard:grid-cols-[17rem_minmax(0,1fr)]">
        <figure class="m-0 flex flex-col gap-1.5">
          <ThemeMiniature
            :theme="theme"
            :mode="miniMode"
            :label="miniLabel"
            :thumbs="miniThumb"
            class="border border-(--d-border)"
          />
          <figcaption class="text-11 text-(--d-faint-text)">
            {{ miniMode === 'split' ? t('themeInstall.splitCaption') : looksText }}
          </figcaption>
        </figure>

        <div class="flex min-w-0 flex-col gap-3">
          <p
            v-if="otherDevice"
            class="flex items-start gap-2 rounded-9 border border-[color-mix(in_srgb,var(--d-info-fill)_40%,var(--d-border))] bg-[color-mix(in_srgb,var(--d-info-fill)_9%,var(--d-card))] px-2.5 py-2 text-pretty wrap-anywhere"
            data-testid="theme-install-other-device"
          >
            <Info
              class="mt-0.5 size-3.5 flex-none text-(--d-info)"
              aria-hidden="true"
            />
            <span>{{ otherDevice.computer !== undefined ? t('themeInstall.otherDevice', { computer: otherDevice.computer }) : t('themeInstall.otherDeviceUnnamed') }}</span>
          </p>
          <p
            v-if="update?.yourEditsName"
            class="flex items-start gap-2 rounded-9 border border-[color-mix(in_srgb,var(--d-info-fill)_40%,var(--d-border))] bg-[color-mix(in_srgb,var(--d-info-fill)_9%,var(--d-card))] px-2.5 py-2 text-pretty wrap-anywhere"
            data-testid="theme-install-your-edits"
          >
            <Info
              class="mt-0.5 size-3.5 flex-none text-(--d-info)"
              aria-hidden="true"
            />
            <span><IsolatedText :text="t('themeInstall.yourEdits', { name: isolated(update.yourEditsName) })" /></span>
          </p>
          <fieldset
            v-if="clash"
            class="flex flex-col gap-2 rounded-9 border border-[color-mix(in_srgb,var(--d-warning-fill)_40%,var(--d-border))] bg-[color-mix(in_srgb,var(--d-warning-fill)_9%,var(--d-card))] px-2.5 py-2"
            data-testid="theme-install-clash"
          >
            <legend class="float-left mb-1 flex w-full items-start gap-2 text-pretty">
              <AlertTriangle
                class="mt-0.5 size-3.5 flex-none text-(--d-warning)"
                aria-hidden="true"
              />
              <span><IsolatedText :text="t('themeInstall.clash.legend', { name: isolated(themeNameText(t, { id: clash.themeId }, clash.name) ?? clash.name) })" /></span>
            </legend>
            <RadioGroup
              v-model="onClash"
              class="clear-both flex flex-col gap-2"
              :aria-label="t('themeInstall.clash.group')"
              :disabled="otherDevice !== undefined"
            >
              <div class="flex items-start gap-2">
                <RadioGroupItem
                  id="theme-install-keep"
                  value="keepBoth"
                  class="mt-0.5"
                  aria-describedby="theme-install-keep-hint"
                />
                <div class="flex min-w-0 flex-col">
                  <Label
                    for="theme-install-keep"
                    class="text-xs font-medium"
                  >{{ t('themeInstall.clash.keepBoth') }}</Label>
                  <span
                    id="theme-install-keep-hint"
                    class="text-pretty text-(--d-muted)"
                  ><IsolatedText :text="t('themeInstall.clash.keepBothHint', { name: isolated(clash.keepBothName) })" /></span>
                </div>
              </div>
              <div class="flex items-start gap-2">
                <RadioGroupItem
                  id="theme-install-replace"
                  value="replace"
                  class="mt-0.5"
                  :disabled="!clash.replaceable"
                  aria-describedby="theme-install-replace-hint"
                />
                <div class="flex min-w-0 flex-col">
                  <Label
                    for="theme-install-replace"
                    class="text-xs font-medium"
                  >{{ t('themeInstall.clash.replace') }}</Label>
                  <span
                    id="theme-install-replace-hint"
                    class="text-pretty text-(--d-muted)"
                  ><IsolatedText :text="!clash.replaceable ? t('themeInstall.clash.builtin') : clash.keepsCopy ? t('themeInstall.clash.replaceKeepsCopy', { name: isolated(clash.keepBothName) }) : t('themeInstall.clash.replaceHint')" /></span>
                </div>
              </div>
            </RadioGroup>
          </fieldset>

          <p
            v-if="te(conversionKey)"
            class="flex items-start gap-2 rounded-9 border border-(--d-border) bg-(--d-panel) px-2.5 py-2 text-pretty"
            data-testid="theme-install-conversion"
          >
            <Info
              class="mt-0.5 size-3.5 flex-none text-(--d-info)"
              aria-hidden="true"
            />
            <span>{{ t(conversionKey) }}</span>
          </p>

          <dl class="grid grid-cols-1 gap-x-3 gap-y-1.5 @min-[24rem]/pcard:grid-cols-[minmax(0,8rem)_minmax(0,1fr)]">
            <template v-if="preview.about.author">
              <dt class="font-medium text-(--d-muted)">
                {{ t('themeInstall.facts.author') }}
              </dt>
              <dd class="m-0 wrap-anywhere">
                {{ preview.about.author }}
              </dd>
            </template>
            <template v-if="preview.about.license">
              <dt class="font-medium text-(--d-muted)">
                {{ t('themeInstall.facts.license') }}
              </dt>
              <dd class="m-0 wrap-anywhere">
                {{ preview.about.license }}
              </dd>
            </template>
            <dt class="font-medium text-(--d-muted)">
              {{ t('themeInstall.facts.looks') }}
            </dt>
            <dd class="m-0">
              {{ looksText }}
            </dd>
            <dt class="font-medium text-(--d-muted)">
              {{ t('themeInstall.facts.colors') }}
            </dt>
            <dd class="m-0 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                class="flex items-center gap-1"
                aria-hidden="true"
              >
                <template
                  v-for="(look, index) in swatches"
                  :key="look.kind"
                >
                  <span
                    v-if="index > 0"
                    class="mx-0.5 h-3 w-px bg-(--d-border2)"
                  />
                  <span
                    v-for="(color, at) in look.colors"
                    :key="at"
                    class="size-3 rounded-sm shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--d-text)_18%,transparent)]"
                    :style="{ backgroundColor: color }"
                    data-testid="theme-install-swatch"
                  />
                </template>
              </span>
              <span class="text-pretty">{{ t('themeInstall.colorsNote') }}</span>
            </dd>
            <dt class="font-medium text-(--d-muted)">
              {{ t('themeInstall.facts.fonts') }}
            </dt>
            <dd
              class="m-0"
              data-testid="theme-install-fonts"
            >
              <span v-if="fonts.length === 0">{{ t('themeInstall.fonts.none') }}</span>
              <span
                v-for="font in fonts"
                :key="font.key"
                class="block text-pretty wrap-anywhere"
              >{{ font.text }}</span>
            </dd>
            <template v-if="wallpapers.length > 0">
              <dt class="font-medium text-(--d-muted)">
                {{ t('themeInstall.facts.wallpapers') }}
              </dt>
              <dd class="m-0 flex flex-col gap-2">
                <ul
                  class="flex flex-col gap-2"
                  data-testid="theme-install-wallpapers"
                >
                  <li
                    v-for="wallpaper in wallpapers"
                    :key="wallpaper.sha"
                    class="flex flex-col gap-1.5"
                    :data-flash="wallpaper.flash"
                    data-testid="theme-install-wallpaper"
                  >
                    <span class="flex items-start gap-2">
                      <img
                        v-if="wallpaper.thumb"
                        :src="wallpaper.thumb"
                        alt=""
                        class="h-9 w-14 flex-none rounded-6 border border-(--d-border2) object-cover"
                      >
                      <span
                        v-else
                        class="h-9 w-14 flex-none rounded-6 border border-dashed border-(--d-border2)"
                        aria-hidden="true"
                      />
                      <span class="flex min-w-0 flex-col">
                        <span class="text-pretty">{{ wallpaper.text }}</span>
                        <span
                          v-for="(placement, at) in wallpaper.placements"
                          :key="at"
                          class="text-pretty text-(--d-muted)"
                        >{{ placement }}</span>
                      </span>
                    </span>
                    <span
                      v-if="wallpaper.flash === 'pending' && wallpaper.percent !== undefined"
                      class="flex flex-col gap-1"
                      role="status"
                      data-testid="theme-install-flash-progress"
                    >
                      <span class="text-(--d-muted)">{{ t('themeInstall.wallpapers.checking', { percent: wallpaper.percent }) }}</span>
                      <Progress
                        :model-value="wallpaper.percent"
                        class="h-1"
                        :aria-label="t('themeInstall.wallpapers.progressLabel')"
                      />
                    </span>
                    <span
                      v-else-if="wallpaper.flash === 'pending'"
                      class="flex items-center gap-1.5 text-(--d-muted)"
                      role="status"
                      data-testid="theme-install-flash-pending"
                    >
                      <LoaderCircle
                        class="d-spinning size-3 flex-none text-(--d-accent)"
                        aria-hidden="true"
                      />{{ t('themeInstall.wallpapers.pending') }}
                    </span>
                    <span
                      v-else-if="wallpaper.flash === 'clear'"
                      class="text-(--d-muted)"
                    >{{ t('themeInstall.wallpapers.clear') }}</span>
                    <span
                      v-else-if="wallpaper.flash === 'unchecked'"
                      class="text-(--d-muted)"
                    >{{ t('themeInstall.wallpapers.unchecked') }}</span>
                    <span
                      v-else-if="wallpaper.flagged && wallpaper.allowed"
                      class="text-pretty text-(--d-muted)"
                      data-testid="theme-install-flash-allowed"
                    >{{ otherDevice === undefined ? t('themeInstall.wallpapers.allowed') : otherDevice.computer !== undefined ? t('themeInstall.wallpapers.allowedElsewhere', { computer: otherDevice.computer }) : t('themeInstall.wallpapers.allowedElsewhereUnnamed') }}</span>
                    <span
                      v-else-if="wallpaper.flagged"
                      class="flex flex-col gap-1.5 rounded-8 bg-(--d-warning-fill)/10 px-2 py-1.5 text-11.5 text-(--d-warning-text)"
                      role="group"
                      :aria-label="t('themeInstall.wallpapers.blocked')"
                      data-testid="theme-install-flash-blocked"
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
                          {{ t('themeInstall.wallpapers.blocked') }}
                        </Badge>
                      </span>
                      <span class="text-pretty">{{ wallpaper.flagged }}</span>
                      <template v-if="otherDevice === undefined">
                        <span class="text-pretty">{{ t('themeInstall.wallpapers.warning') }}</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          class="h-7 self-start rounded-8 border-(--d-border2) bg-transparent px-2.5 text-12 aria-disabled:opacity-(--d-opacity-disabled)"
                          :aria-disabled="locked || undefined"
                          :aria-describedby="explain ? 'theme-install-checking' : undefined"
                          data-testid="theme-install-allow-flash"
                          @click="allowFlash(wallpaper.sha)"
                        >
                          {{ t('themeInstall.wallpapers.allow') }}
                        </Button>
                      </template>
                      <span
                        v-else
                        class="text-pretty"
                      >{{ t('themeInstall.wallpapers.allowElsewhere') }}</span>
                    </span>
                  </li>
                </ul>
                <span
                  v-if="moving"
                  class="text-pretty text-(--d-muted)"
                >{{ t('themeInstall.wallpapers.movingNote') }}</span>
              </dd>
            </template>
            <dt class="font-medium text-(--d-muted)">
              {{ t('themeInstall.facts.css') }}
            </dt>
            <dd
              class="m-0 flex flex-col gap-1.5"
              data-testid="theme-install-css"
            >
              <span class="text-pretty">{{ cssRegions.length === 0 ? t('themeInstall.css.none') : t('themeInstall.css.present', { regions: listText(locale, cssRegions), n: cssRegions.length }, cssRegions.length) }}</span>
              <template v-if="dropped.length > 0">
                <span class="font-medium text-(--d-warning-text)">{{ t('themeInstall.css.dropped') }}</span>
                <ul class="flex flex-col gap-1">
                  <li
                    v-for="part in dropped"
                    :key="part.key"
                    class="flex min-w-0 items-start gap-2 text-pretty"
                  >
                    <Minus
                      class="mt-0.5 size-3 flex-none text-(--d-warning-text)"
                      aria-hidden="true"
                    />
                    <span class="flex min-w-0 flex-col gap-0.5">
                      <code class="self-start rounded-5 bg-(--d-hover) px-1 font-mono text-10.5 wrap-anywhere">{{ part.code }}</code>
                      <span class="text-(--d-muted)">{{ part.text }}</span>
                    </span>
                  </li>
                </ul>
                <span
                  v-if="droppedMore > 0"
                  class="text-(--d-muted)"
                  data-testid="theme-install-dropped-more"
                >{{ t('themeAgent.dropped.more', { n: droppedMore }, droppedMore) }}</span>
              </template>
            </dd>
            <template v-if="preview.characters">
              <dt class="font-medium text-(--d-muted)">
                {{ t('themeInstall.facts.characters') }}
              </dt>
              <dd class="m-0 wrap-anywhere">
                <IsolatedText :text="t('themeInstall.characters', { name: isolated(preview.characters.name), n: preview.characters.count }, preview.characters.count)" />
              </dd>
            </template>
            <template v-if="preview.arrangement">
              <dt class="font-medium text-(--d-muted)">
                {{ t('themeInstall.facts.arrangement') }}
              </dt>
              <dd class="m-0 flex flex-col gap-1.5">
                <span class="text-pretty">{{ arrangementText }}</span>
                <span class="flex items-start gap-2">
                  <Checkbox
                    id="theme-install-arrangement"
                    v-model:checked="useArrangement"
                    :disabled="otherDevice !== undefined"
                    class="mt-0.5 border-(--d-border2) data-[state=checked]:border-(--d-accent-fill) data-[state=checked]:bg-(--d-accent-fill) data-[state=checked]:text-(--d-on-accent)"
                    aria-describedby="theme-install-arrangement-hint"
                    data-testid="theme-install-arrangement"
                  />
                  <span class="flex min-w-0 flex-col">
                    <Label
                      for="theme-install-arrangement"
                      class="text-xs font-medium"
                    >{{ t('themeInstall.arrangement.use') }}</Label>
                    <span
                      id="theme-install-arrangement-hint"
                      class="text-pretty text-(--d-muted)"
                    >{{ useArrangement ? t('themeInstall.arrangement.on') : t('themeInstall.arrangement.off') }}</span>
                  </span>
                </span>
              </dd>
            </template>
            <dt class="font-medium text-(--d-muted)">
              {{ t('themeInstall.facts.size') }}
            </dt>
            <dd class="m-0">
              {{ formatBytes(preview.totalBytes, locale) }}
            </dd>
          </dl>

          <section
            v-if="contrast.length > 0"
            :aria-label="t('themeInstall.contrast')"
            data-testid="theme-install-contrast"
          >
            <h3 class="mb-1 text-10.5 font-semibold tracking-[.06em] text-(--d-warning-text) uppercase">
              {{ t('themeInstall.contrast') }}
            </h3>
            <ul class="flex flex-col gap-1">
              <li
                v-for="issue in contrast"
                :key="issue.key"
                class="flex min-w-0 items-start gap-2 text-pretty text-(--d-warning-text)"
              >
                <CircleAlert
                  class="mt-0.5 size-3 flex-none"
                  aria-hidden="true"
                />
                <span class="min-w-0 wrap-anywhere">
                  <span class="me-1 rounded-5 border border-(--d-border2) px-1 text-10.5 text-(--d-muted)">{{ t(`themeInstall.lookTitle.${issue.look}`) }}</span>{{ issue.text }}
                </span>
              </li>
            </ul>
          </section>

          <section
            v-if="warnings.length > 0"
            :aria-label="t('themeInstall.warnings')"
            data-testid="theme-install-warnings"
          >
            <h3 class="mb-1 text-10.5 font-semibold tracking-[.06em] text-(--d-warning-text) uppercase">
              {{ t('themeInstall.warnings') }}
            </h3>
            <ul class="flex flex-col gap-1">
              <li
                v-for="(warning, index) in warnings"
                :key="index"
                class="flex min-w-0 items-start gap-2 text-pretty"
              >
                <AlertTriangle
                  class="mt-0.5 size-3 flex-none text-(--d-warning-text)"
                  aria-hidden="true"
                />
                <span class="min-w-0 wrap-anywhere">{{ warning }}</span>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>

    <TrustedCheckingNote
      id="theme-install-checking"
      overlay
      class="bottom-0"
      :shown="explain"
      :text="t('trusted.checkingVisible')"
    />

    <div class="flex flex-none flex-wrap items-center justify-end gap-2 border-t border-(--d-border) px-3 py-2">
      <span
        id="theme-install-busy"
        role="status"
        class="sr-only"
      >{{ busy ? t('themeInstall.installing') : '' }}</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        class="h-7.5 rounded-9 border-(--d-border2) bg-transparent px-3 text-12.5 aria-disabled:opacity-(--d-opacity-disabled)"
        :aria-disabled="cancelLocked || undefined"
        :aria-describedby="explain ? 'theme-install-checking' : undefined"
        :aria-keyshortcuts="variant === 'dock' ? (otherDevice ? '1' : '2') : undefined"
        data-dock-focus
        data-testid="theme-install-cancel"
        @click="cancel"
      >
        {{ t('themeInstall.cancel') }}
      </Button>
      <Button
        v-if="!otherDevice"
        type="button"
        size="sm"
        class="h-7.5 max-w-full rounded-9 bg-(--d-accent-fill) px-3.5 text-12.5 font-semibold text-(--d-on-accent) hover:brightness-110 aria-disabled:opacity-(--d-opacity-disabled)"
        :aria-disabled="locked || undefined"
        :aria-describedby="explain ? 'theme-install-checking' : busy ? 'theme-install-busy' : undefined"
        :aria-keyshortcuts="variant === 'dock' ? '1' : undefined"
        data-testid="theme-install-go"
        @click="install"
      >
        <LoaderCircle
          v-if="busy"
          class="d-spinning size-3.5"
          aria-hidden="true"
        />
        <span class="truncate"><IsolatedText :text="installLabel" /></span>
      </Button>
    </div>
  </section>
</template>
