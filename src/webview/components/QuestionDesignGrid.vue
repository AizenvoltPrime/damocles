<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleAlert, ExternalLink, FileCode2, MonitorPlay } from 'lucide-vue-next';
import type { AcceptableValue } from 'reka-ui';
import type { LocalizedText } from '@shared/localized-text';
import type { Question } from '@shared/types/permissions';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useLocalizedText } from '@/composables/useLocalizedText';
import { useOpenDesignInBrowser } from '@/composables/useOpenDesignInBrowser';
import { useOpenDesignPreview } from '@/composables/useOpenDesignPreview';
import { DOCK_PROMPT_SELECTOR } from '@/composables/useDockPrompt';
import { hasOpenOverlay } from '@/composables/useOverlayEscape';
import { isEditableTarget } from '@/utils/editable-target';
import { useDesignStore } from '@/stores/useDesignStore';
import { cacheResultImages, holdResultImages, releaseResultImages } from '@/utils/result-image-cache';

// A question whose options preview design files: a grid of option cards, one radio group (or checkboxes for multi-select).
const props = defineProps<{
  toolUseId: string;
  questionIndex: number;
  question: Question;
  selected: ReadonlySet<string>;
}>();

const emit = defineEmits<{
  choose: [label: string];
  toggle: [label: string];
  confirm: [];
}>();

const { t } = useI18n();
const { rt } = useLocalizedText();
const { postMessage, onMessage } = usePlatformBridge();
const designStore = useDesignStore();
const livePreview = useOpenDesignPreview();
const browser = useOpenDesignInBrowser();

const baseId = useId();
const root = ref<HTMLElement | null>(null);

const design = computed(() => designStore.design);
// FULL renders thumbnails through the attached app; REDUCED (VS Code) has no renderer, so its options are tiles.
const thumbnails = computed(() => design.value?.ruleSet === 'full');

type Thumbnail = { state: 'loading' } | { state: 'loaded'; url: string } | { state: 'failed'; error: LocalizedText | null };

// Image data stays out of every store: the page's object-URL cache holds each thumbnail while this grid holds its key,
// so a question the user comes back to asks core for nothing.
const images = shallowRef<ReadonlyMap<number, Thumbnail>>(new Map());
const pending = new Map<string, { index: number; key: string }>();
const held = new Set<string>();

function releaseThumbnails(): void {
  for (const key of held) releaseResultImages(key);
  held.clear();
}

const options = computed(() => props.question.options.map((option, index) => ({
  index,
  label: option.label,
  path: option.preview?.kind === 'design' ? option.preview.path : null,
})));

const cards = computed(() => props.question.options.map((option, index) => ({
  index,
  label: option.label,
  description: option.description,
  path: option.preview?.kind === 'design' ? option.preview.path : null,
  thumbnail: images.value.get(index),
  labelId: `${baseId}-label-${index}`,
  descriptionId: `${baseId}-description-${index}`,
  fileId: `${baseId}-file-${index}`,
})));

function setThumbnail(index: number, thumbnail: Thumbnail): void {
  images.value = new Map(images.value).set(index, thumbnail);
}

const unsubscribe = onMessage((msg) => {
  if (msg.type !== 'designPreviewImage') return;
  const request = pending.get(msg.requestId);
  if (request === undefined) return;
  pending.delete(msg.requestId);
  const image = msg.image;
  if (image?.mimeType === 'image/png' && typeof image.data === 'string' && image.data.length > 0) {
    const [url] = cacheResultImages(request.key, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.data } }]);
    held.add(request.key);
    if (url !== undefined) setThumbnail(request.index, { state: 'loaded', url });
  } else {
    setThumbnail(request.index, { state: 'failed', error: msg.error ?? null });
  }
});

const requestKey = computed(() => (thumbnails.value
  ? JSON.stringify([props.toolUseId, props.questionIndex, options.value.map((option) => option.path)])
  : ''));

watch(requestKey, (key) => {
  pending.clear();
  releaseThumbnails();
  images.value = new Map();
  if (!key) return;
  const next = new Map<number, Thumbnail>();
  for (const option of options.value) {
    if (option.path === null) continue;
    const thumbnailKey = `designPreview\0${key}\0${option.index}`;
    const cached = holdResultImages(thumbnailKey)?.[0];
    if (cached !== undefined) {
      held.add(thumbnailKey);
      next.set(option.index, { state: 'loaded', url: cached });
      continue;
    }
    const requestId = crypto.randomUUID();
    pending.set(requestId, { index: option.index, key: thumbnailKey });
    next.set(option.index, { state: 'loading' });
    postMessage({ type: 'requestDesignPreviewImage', requestId, toolUseId: props.toolUseId, questionIndex: props.questionIndex, optionIndex: option.index });
  }
  images.value = next;
}, { immediate: true });

onUnmounted(() => {
  unsubscribe();
  pending.clear();
  releaseThumbnails();
  images.value = new Map();
});

// The group takes focus as it mounts, as a dock prompt's options list does, unless the user is typing or in another prompt.
onMounted(() => {
  const active = document.activeElement;
  const owner = active?.closest(DOCK_PROMPT_SELECTOR);
  const ownCard = root.value?.closest(DOCK_PROMPT_SELECTOR);
  if (isEditableTarget(active) || (owner && owner !== ownCard) || hasOpenOverlay()) return;
  void nextTick(() => {
    const controls = root.value?.querySelectorAll<HTMLElement>('[role="radio"], [role="checkbox"]');
    const checked = root.value?.querySelector<HTMLElement>('[aria-checked="true"]');
    (checked ?? controls?.[0])?.focus();
  });
});

const singleValue = computed(() => props.question.options.find((option) => props.selected.has(option.label))?.label);
const group = computed(() => (props.question.multiSelect
  ? { is: 'div', attrs: { role: 'group' } }
  : { is: RadioGroup, attrs: { modelValue: singleValue.value ?? null } }));

function onRadio(value: AcceptableValue): void {
  if (typeof value === 'string') emit('choose', value);
}

function pick(label: string): void {
  if (props.question.multiSelect) emit('toggle', label);
  else emit('choose', label);
}

// Enter on a card's own buttons (Open live, Open in browser) only activates that button.
function onEnter(event: KeyboardEvent): void {
  const ownControl = event.target instanceof Element && event.target.matches('[role="radio"], [role="checkbox"]');
  if (ownControl && props.selected.size > 0) emit('confirm');
}

function openLive(path: string): void {
  if (design.value) livePreview.open(design.value.designId, path);
}

function openInBrowser(path: string): void {
  if (design.value) browser.open(design.value.designId, path);
}

// Side by side once the cards fit at about 8 rem each; four options wrap two by two before they fit in one row.
const COLUMNS: Readonly<Record<number, string>> = {
  2: '@min-[18rem]/designs:grid-cols-2',
  3: '@min-[26rem]/designs:grid-cols-3',
  4: '@min-[18rem]/designs:grid-cols-2 @min-[36rem]/designs:grid-cols-4',
};
const CARD = 'group/card relative flex min-w-0 flex-col overflow-hidden rounded-10 border bg-(--d-bg) transition-[border-color,box-shadow] duration-150 ease-out';
const ACTION = 'd-press h-6.5 gap-1.5 rounded-7 px-2 text-12 text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 [&_svg]:size-3.5';
</script>

<template>
  <div
    ref="root"
    class="@container/designs px-1.5 pt-1 pb-1.5"
    data-testid="question-design-previews"
    :data-rule-set="thumbnails ? 'full' : 'reduced'"
  >
    <component
      :is="group.is"
      v-bind="group.attrs"
      :aria-label="question.question"
      :class="cn('grid grid-cols-1 gap-2', COLUMNS[cards.length])"
      @update:model-value="onRadio"
      @keydown.enter="onEnter"
    >
      <div
        v-for="card in cards"
        :key="card.label"
        :class="cn(CARD, selected.has(card.label)
          ? 'border-(--d-accent) shadow-[0_0_0_3px_var(--d-accent-soft)]'
          : 'border-(--d-border) hover:border-(--d-border2)')"
        data-testid="question-design-option"
        :data-option-label="card.label"
        :data-checked="selected.has(card.label) || undefined"
      >
        <!-- A pointer convenience: the card's radio or checkbox is its keyboard control. -->
        <div
          class="relative aspect-16/10 cursor-pointer overflow-hidden border-b border-(--d-border) bg-(--d-code)"
          data-testid="question-design-thumbnail"
          @click="pick(card.label)"
        >
          <template v-if="thumbnails && card.path !== null">
            <img
              v-if="card.thumbnail?.state === 'loaded'"
              :src="card.thumbnail.url"
              :alt="t('question.design.thumbnailAlt', { label: card.label })"
              class="size-full animate-[d-fade_.2s_var(--ease-out)] object-cover object-top"
              data-testid="question-design-image"
            >
            <div
              v-else-if="card.thumbnail?.state === 'failed'"
              class="flex size-full flex-col items-center justify-center gap-1.5 p-3 text-center text-11.5 text-pretty text-(--d-muted)"
              role="status"
              data-testid="question-design-image-error"
            >
              <CircleAlert
                class="size-4 flex-none text-(--d-danger-text)"
                aria-hidden="true"
              />
              {{ card.thumbnail.error ? rt(card.thumbnail.error) : t('question.design.thumbnailFailed') }}
            </div>
            <div
              v-else
              role="status"
              aria-busy="true"
              class="size-full"
              data-testid="question-design-image-loading"
            >
              <span class="sr-only">{{ t('question.design.thumbnailLoading', { label: card.label }) }}</span>
              <div
                class="d-pulsing absolute inset-3 rounded-md bg-(--d-hover)"
                aria-hidden="true"
              />
            </div>
          </template>
          <div
            v-else
            class="flex size-full flex-col items-center justify-center gap-2 p-3"
            data-testid="question-design-tile"
          >
            <span
              class="d-tone-design flex size-9 items-center justify-center rounded-lg bg-(--tone)/12 text-(--tone)"
              aria-hidden="true"
            >
              <FileCode2 class="size-4.5" />
            </span>
            <span
              v-if="card.path !== null"
              class="max-w-full truncate font-mono text-11 text-(--d-muted)"
              dir="ltr"
            >{{ card.path.split('/').at(-1) }}</span>
          </div>
        </div>

        <div class="flex min-w-0 flex-1 items-start gap-2 px-2.5 pt-2 pb-1.5">
          <Checkbox
            v-if="question.multiSelect"
            :checked="selected.has(card.label)"
            :aria-labelledby="card.labelId"
            :aria-describedby="`${card.descriptionId} ${card.fileId}`"
            class="mt-0.5 rounded-[0.25rem] border-(--d-border2) data-[state=checked]:border-(--d-accent) data-[state=checked]:bg-(--d-accent) data-[state=checked]:text-(--d-on-accent)"
            data-testid="question-design-control"
            @update:checked="emit('toggle', card.label)"
          />
          <RadioGroupItem
            v-else
            :value="card.label"
            :aria-labelledby="card.labelId"
            :aria-describedby="`${card.descriptionId} ${card.fileId}`"
            class="mt-0.5"
            data-testid="question-design-control"
          />
          <div
            class="min-w-0 flex-1 cursor-pointer"
            @click="pick(card.label)"
          >
            <span
              :id="card.labelId"
              class="block text-12.5 font-medium text-(--d-text)"
            >{{ card.label }}</span>
            <span
              :id="card.descriptionId"
              class="block text-xs text-pretty text-(--d-faint-text)"
            >{{ card.description }}</span>
            <span
              :id="card.fileId"
              class="mt-0.5 block truncate font-mono text-10.5 text-(--d-faint-text)"
              dir="ltr"
              :title="card.path ?? undefined"
              data-testid="question-design-file"
            >{{ card.path }}</span>
          </div>
        </div>

        <div
          v-if="card.path !== null && (thumbnails ? livePreview.available.value : browser.available.value)"
          class="flex justify-end px-1.5 pb-1.5"
        >
          <Button
            v-if="thumbnails"
            variant="ghost"
            :class="ACTION"
            :aria-label="t('question.design.openLiveAria', { label: card.label })"
            data-testid="question-design-open-live"
            @click="openLive(card.path)"
          >
            <MonitorPlay aria-hidden="true" />{{ t('question.design.openLive') }}
          </Button>
          <Button
            v-else
            variant="ghost"
            :class="ACTION"
            :aria-label="t('question.design.openInBrowserAria', { label: card.label })"
            data-testid="question-design-open-browser"
            @click="openInBrowser(card.path)"
          >
            <ExternalLink aria-hidden="true" />{{ t('design.browser.open') }}
          </Button>
        </div>
      </div>
    </component>
  </div>
</template>
