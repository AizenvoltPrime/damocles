<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick, inject, toRef, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatMessage, CompactMarker as CompactMarkerType } from '@shared/types/session';
import type { SubagentState } from '@shared/types/subagents';
import type { ImageBlock } from '@shared/types/content';
import type { ExpandedDiff } from '@/stores/useDiffStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useVirtualizedMessages } from '@/composables/useVirtualizedMessages';
import { useScrollEngine } from '@/composables/useScrollEngine';
import { useStickyHeader } from '@/composables/useStickyHeader';
import { initFonts, invalidateLayoutCache } from '@/composables/usePretextMeasurement';
import VirtualItemWrapper from './VirtualItemWrapper.vue';
import StickyUserHeader from './StickyUserHeader.vue';
import ImageLightbox from './ImageLightbox.vue';
import { imageBlockToDataUrl } from '@/utils/imageUtils';

const { t } = useI18n();
const sessionStore = useSessionStore();

const props = defineProps<{
  messages: ChatMessage[];
  streamingMessageId?: string | null;
  compactMarkers?: CompactMarkerType[];
  checkpointMessages?: Set<string>;
  subagents?: Record<string, SubagentState>;
}>();

const emit = defineEmits<{
  (e: 'rewind'): void;
  (e: 'expandSubagent', subagentId: string): void;
  (e: 'expandTool', toolId: string): void;
  (e: 'expandDiff', diff: ExpandedDiff): void;
  (e: 'viewContext', promptIndex: number): void;
}>();

const scrollContainer = inject<Ref<HTMLElement | null>>('messageScrollContainer', ref(null));
const canvasRef = ref<HTMLElement | null>(null);
const stickyRef = ref<HTMLElement | null>(null);

const messagesRef = toRef(props, 'messages');
const compactMarkersRef = toRef(props, 'compactMarkers');
const streamingIdRef = toRef(props, 'streamingMessageId');
const subagentsRef = toRef(props, 'subagents');

const { items } = useVirtualizedMessages(messagesRef, compactMarkersRef, streamingIdRef, subagentsRef);

const engine = useScrollEngine(items, scrollContainer, canvasRef);
const sticky = useStickyHeader(items, engine.frame);

watch(messagesRef, (msgs, prev) => {
  if (msgs.length === 0 || (prev && msgs[0]?.id !== prev[0]?.id)) {
    engine.knownItemIds.clear();
  }
});

const lightboxImageUrl = ref<string | null>(null);
const logoUri = ref('');

const isWelcome = computed(() => {
  return props.messages.length === 0 && !(props.compactMarkers?.length);
});

const promptIndices = computed(() => {
  const indices: number[] = new Array(props.messages.length);
  let idx = sessionStore.promptIndexOffset;
  for (let i = 0; i < props.messages.length; i++) {
    indices[i] = idx;
    const m = props.messages[i];
    if (m.role === 'user' && !m.isInjected && !m.isCombinedQueue && !m.isQueued) idx++;
  }
  return indices;
});

const visibleItems = computed(() => {
  const start = engine.visibleStart.value;
  const end = engine.visibleEnd.value;
  const all = items.value;
  const frameItems = engine.frame.value.items;
  const result: Array<{ item: typeof all[number]; frameItem: typeof frameItems[number]; index: number }> = [];
  for (let i = start; i < end && i < all.length; i++) {
    if (i < frameItems.length) {
      result.push({ item: all[i], frameItem: frameItems[i], index: i });
    }
  }
  return result;
});

const stickyExpanded = computed(() => {
  const msg = sticky.activeMessage.value;
  if (!msg) return false;
  return sticky.isExpanded(msg.id);
});

function getPromptIndexForMessage(messageIndex: number): number {
  return promptIndices.value[messageIndex] ?? sessionStore.promptIndexOffset;
}

function canRewindTo(message: ChatMessage): boolean {
  return message.role === 'user' && !!message.sdkMessageId && (props.checkpointMessages?.has(message.sdkMessageId) ?? false);
}

function isNewItem(itemId: string): boolean {
  if (engine.knownItemIds.has(itemId)) return false;
  engine.knownItemIds.add(itemId);
  return true;
}

function openLightbox(block: ImageBlock): void {
  lightboxImageUrl.value = imageBlockToDataUrl(block);
}

function handleStickyToggle(): void {
  const msg = sticky.activeMessage.value;
  if (msg) sticky.toggle(msg.id);
}

function handleStickyScrollToOriginal(): void {
  const container = scrollContainer.value;
  const canvas = canvasRef.value;
  if (!container || !canvas) return;
  container.scrollTop = canvas.offsetTop + sticky.getOriginalTop();
}

function onScroll(): void {
  engine.onScroll();
  updateSticky();
}

function updateSticky(): void {
  const container = scrollContainer.value;
  const canvas = canvasRef.value;
  if (!container || !canvas) return;
  sticky.update(container.scrollTop, canvas.offsetTop);

  const stickyEl = stickyRef.value;
  engine.setStickyHeight(stickyEl && sticky.activeMessage.value ? stickyEl.offsetHeight : 0);
}

let containerResizeObserver: ResizeObserver | null = null;

watch(scrollContainer, (container, prev) => {
  if (prev) prev.removeEventListener('scroll', onScroll);
  if (container) {
    container.addEventListener('scroll', onScroll, { passive: true });
    engine.measureContainerWidth();
  }
}, { immediate: true });

watch(canvasRef, (el) => {
  if (el) {
    nextTick(() => engine.forceRebuild());
  }
});

onMounted(() => {
  logoUri.value = document.getElementById('app')?.dataset.logoUri ?? '';

  engine.measureContainerWidth();

  initFonts().then(() => {
    engine.forceRebuild();
  });

  const container = scrollContainer.value;
  if (container) {
    containerResizeObserver = new ResizeObserver(() => {
      invalidateLayoutCache();
      engine.forceRebuild();
    });
    containerResizeObserver.observe(container);
  }
});

onUnmounted(() => {
  engine.destroy();
  containerResizeObserver?.disconnect();
  const container = scrollContainer.value;
  if (container) container.removeEventListener('scroll', onScroll);
});
</script>

<template>
  <div
    v-if="isWelcome"
    class="px-4 pb-4 bg-background flex flex-col justify-center h-full"
  >
    <div class="text-center w-full px-4">
      <img :src="logoUri" alt="Damocles" class="w-16 h-16 mx-auto mb-4" />
      <p class="text-xl mb-2 text-foreground font-medium">{{ t('welcome.title') }}</p>
      <p class="text-sm text-muted-foreground">{{ t('welcome.message') }}</p>
    </div>
  </div>

  <div
    v-else
    ref="canvasRef"
    class="relative bg-background"
    :style="{ minHeight: engine.frame.value.totalHeight + 'px' }"
  >
    <div ref="stickyRef" class="sticky top-0 z-10">
      <StickyUserHeader
        :message="sticky.activeMessage.value"
        :expanded="stickyExpanded"
        @toggle="handleStickyToggle"
        @scroll-to-original="handleStickyScrollToOriginal"
        @open-lightbox="openLightbox"
      />
    </div>

    <VirtualItemWrapper
      v-for="{ item, frameItem } in visibleItems"
      :key="item.id"
      :item="item"
      :top="frameItem.top"
      :is-new="isNewItem(item.id)"
      :can-rewind="item.type === 'user-message' && canRewindTo(item.message)"
      :prompt-index="item.type === 'user-message' ? getPromptIndexForMessage(item.originalMessageIndex) : 0"
      :subagents="subagents"
      @rewind="emit('rewind')"
      @expand-subagent="emit('expandSubagent', $event)"
      @expand-tool="emit('expandTool', $event)"
      @expand-diff="emit('expandDiff', $event)"
      @view-context="emit('viewContext', $event)"
      @open-lightbox="openLightbox"
      @mounted="(el: HTMLElement) => engine.onItemMounted(item.id, el)"
      @unmounted="engine.onItemUnmounted(item.id)"
    />

    <ImageLightbox :open="lightboxImageUrl !== null" :image-url="lightboxImageUrl ?? ''" @close="lightboxImageUrl = null" />
  </div>
</template>
