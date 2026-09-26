<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall, ToolResultOwner } from '@shared/types/session';
import { isImageBlock, type ImageBlock } from '@shared/types/content';
import { useVSCode } from '@/composables/useVSCode';
import { imageBlockToDataUrl } from '@/utils/imageUtils';

const props = defineProps<{
  tool: ToolCall;
  owner?: ToolResultOwner | undefined;
}>();

const emit = defineEmits<{
  open: [url: string];
}>();

const { t } = useI18n();
const { postMessage, onMessage } = useVSCode();

// Image data stays in this component's state only; no store ever holds it.
const images = shallowRef<ImageBlock[]>([]);
const urls = computed(() => images.value.map(imageBlockToDataUrl));
const state = ref<'loading' | 'loaded' | 'unavailable'>('loading');
let pendingRequestId: string | null = null;

const imageCount = computed(() => props.tool.imageCount ?? 0);
const ownerKey = computed(() => (props.owner ? JSON.stringify(props.owner) : ''));

const unsubscribe = onMessage((msg) => {
  if (msg.type !== 'toolResultImages' || msg.requestId !== pendingRequestId) return;
  pendingRequestId = null;
  const received = Array.isArray(msg.images) ? msg.images.filter(isImageBlock) : [];
  images.value = received;
  state.value = received.length > 0 ? 'loaded' : 'unavailable';
});

watch(
  [() => props.tool.id, imageCount, ownerKey],
  () => {
    images.value = [];
    pendingRequestId = null;
    if (imageCount.value === 0) return;
    if (!props.owner) {
      state.value = 'unavailable';
      return;
    }
    state.value = 'loading';
    const requestId = crypto.randomUUID();
    pendingRequestId = requestId;
    postMessage({ type: 'requestToolResultImages', requestId, toolUseId: props.tool.id, owner: props.owner });
  },
  { immediate: true },
);

onUnmounted(() => {
  unsubscribe();
  pendingRequestId = null;
  images.value = [];
});
</script>

<template>
  <div v-if="imageCount > 0" class="flex flex-wrap gap-2 pl-2" data-testid="tool-result-images">
    <div v-if="state === 'loading'" role="status" aria-busy="true" class="flex flex-wrap gap-2">
      <span class="sr-only">{{ t('toolOverlay.loadingResultImages') }}</span>
      <div
        v-for="index in imageCount"
        :key="`placeholder-${index}`"
        class="w-40 h-28 rounded-md bg-muted animate-pulse"
        data-testid="tool-result-image-placeholder"
      />
    </div>
    <template v-else-if="state === 'loaded'">
      <button
        v-for="(url, index) in urls"
        :key="`image-${index}`"
        type="button"
        :aria-label="t('toolOverlay.openResultImage', { index: index + 1, count: urls.length })"
        class="rounded-md cursor-pointer hover:opacity-80 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        @click="emit('open', url)"
      >
        <img
          :src="url"
          alt=""
          class="max-w-64 max-h-64 rounded-md border border-border object-contain"
        />
      </button>
    </template>
    <p v-else class="text-sm text-muted-foreground italic">{{ t('toolOverlay.resultImagesUnavailable') }}</p>
  </div>
</template>
