<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall, ToolResultOwner } from '@shared/types/session';
import { isImageBlock } from '@shared/types/content';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { cacheResultImages, holdResultImages, releaseResultImages } from '@/utils/result-image-cache';

const props = defineProps<{
  tool: ToolCall;
  owner?: ToolResultOwner | undefined;
  /** One label per image, in image order, shown as a chip under it (a screenshot's width). */
  captions?: readonly string[] | undefined;
  /** Each image's size in CSS px, in image order, when the result records it; its thumbnail box keeps that aspect ratio. */
  sizes?: readonly ({ readonly width: number; readonly height: number } | undefined)[] | undefined;
}>();

const emit = defineEmits<{
  open: [url: string];
}>();

const { t } = useI18n();
const { postMessage, onMessage } = usePlatformBridge();

// Image data stays out of every store: the page's result-image cache holds the decoded URLs while this component holds its key.
const urls = shallowRef<readonly string[]>([]);
const state = ref<'loading' | 'loaded' | 'unavailable'>('loading');
let pendingRequestId: string | null = null;
let heldKey: string | null = null;

const imageCount = computed(() => props.tool.imageCount ?? 0);
const ownerKey = computed(() => (props.owner ? JSON.stringify(props.owner) : ''));

function release(): void {
  if (heldKey !== null) releaseResultImages(heldKey);
  heldKey = null;
}

function show(key: string, shown: readonly string[]): void {
  heldKey = key;
  urls.value = shown;
  state.value = shown.length > 0 ? 'loaded' : 'unavailable';
}

const unsubscribe = onMessage((msg) => {
  if (msg.type !== 'toolResultImages' || msg.requestId !== pendingRequestId) return;
  pendingRequestId = null;
  const received = Array.isArray(msg.images) ? msg.images.filter(isImageBlock) : [];
  if (received.length === 0) {
    state.value = 'unavailable';
    return;
  }
  show(`${ownerKey.value}\0${props.tool.id}`, cacheResultImages(`${ownerKey.value}\0${props.tool.id}`, received));
});

watch(
  [() => props.tool.id, imageCount, ownerKey],
  () => {
    release();
    urls.value = [];
    pendingRequestId = null;
    if (imageCount.value === 0) return;
    if (!props.owner) {
      state.value = 'unavailable';
      return;
    }
    const key = `${ownerKey.value}\0${props.tool.id}`;
    const cached = holdResultImages(key);
    if (cached) {
      show(key, cached);
      return;
    }
    state.value = 'loading';
    const requestId = crypto.randomUUID();
    pendingRequestId = requestId;
    postMessage({ type: 'requestToolResultImages', requestId, toolUseId: props.tool.id, owner: props.owner });
  },
  { immediate: true },
);

// A thumbnail's width over its height, kept within these so a short strip or a tall page still reads as a thumbnail.
const MIN_ASPECT = 0.8;
const MAX_ASPECT = 2;

const thumbnails = computed(() => Array.from({ length: state.value === 'loaded' ? urls.value.length : imageCount.value }, (_, index) => {
  const size = props.sizes?.[index];
  const aspect = size && size.width > 0 && size.height > 0 ? Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, size.width / size.height)) : undefined;
  return {
    caption: props.captions?.[index],
    // the box is the same before and after the image loads, so the row never moves
    style: aspect === undefined ? undefined : { aspectRatio: String(Math.round(aspect * 1000) / 1000) },
  };
}));

const BOX = 'block w-40 overflow-hidden rounded-md border border-(--d-border) bg-(--d-hover)';
const CAPTION = 'rounded-full border border-(--d-border) px-1.5 font-mono text-10.5 text-(--d-muted) tabular-nums';

onUnmounted(() => {
  unsubscribe();
  pendingRequestId = null;
  release();
});
</script>

<template>
  <div
    v-if="imageCount > 0"
    class="flex flex-wrap gap-2"
    data-testid="tool-result-images"
  >
    <div
      v-if="state === 'loading'"
      role="status"
      aria-busy="true"
      class="flex flex-wrap gap-2"
    >
      <span class="sr-only">{{ t('toolOverlay.loadingResultImages') }}</span>
      <div
        v-for="(thumbnail, index) in thumbnails"
        :key="`placeholder-${index}`"
        class="flex flex-col items-start gap-1"
      >
        <div
          :class="[BOX, !thumbnail.style && 'h-28', 'd-pulsing']"
          :style="thumbnail.style"
          data-testid="tool-result-image-placeholder"
        />
        <span
          v-if="thumbnail.caption"
          :class="CAPTION"
          aria-hidden="true"
        >{{ thumbnail.caption }}</span>
      </div>
    </div>
    <template v-else-if="state === 'loaded'">
      <figure
        v-for="(url, index) in urls"
        :key="`image-${index}`"
        class="flex flex-col items-start gap-1"
        data-testid="tool-result-image"
      >
        <button
          type="button"
          :aria-label="thumbnails[index]?.caption ? t('toolOverlay.openResultImageCaption', { caption: thumbnails[index]?.caption }) : t('toolOverlay.openResultImage', { index: index + 1, count: urls.length })"
          :class="[BOX, !thumbnails[index]?.style && 'h-28', 'cursor-zoom-in transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--d-accent)']"
          :style="thumbnails[index]?.style"
          @click="emit('open', url)"
        >
          <img
            :src="url"
            alt=""
            class="size-full object-cover object-top-left"
          >
        </button>
        <figcaption
          v-if="thumbnails[index]?.caption"
          :class="CAPTION"
          data-testid="tool-result-image-caption"
        >
          {{ thumbnails[index]?.caption }}
        </figcaption>
      </figure>
    </template>
    <p
      v-else
      class="text-xs text-(--d-muted) italic"
    >
      {{ t('toolOverlay.resultImagesUnavailable') }}
    </p>
  </div>
</template>
