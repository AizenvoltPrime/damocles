<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick, inject, toRef, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatMessage, CompactMarker as CompactMarkerType, ModelFallbackNotice } from '@shared/types/session';
import type { SubagentState } from '@shared/types/subagents';
import type { ImageBlock } from '@shared/types/content';
import type { ExpandedDiff } from '@/stores/useDiffStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useMessageHighlightStore } from '@/stores/useMessageHighlightStore';
import { useVirtualizedMessages } from '@/composables/useVirtualizedMessages';
import { useScrollEngine } from '@/composables/useScrollEngine';
import { useStickyHeader } from '@/composables/useStickyHeader';
import { initFonts, invalidateLayoutCache } from '@/composables/usePretextMeasurement';
import VirtualItemWrapper from './VirtualItemWrapper.vue';
import StickyUserHeader from './StickyUserHeader.vue';
import PinnedRestoreChip from './PinnedRestoreChip.vue';
import ImageLightbox from './ImageLightbox.vue';
import { imageBlockToDataUrl } from '@/utils/imageUtils';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useVSCode } from '@/composables/useVSCode';
import { storeToRefs } from 'pinia';

const { t } = useI18n();
const sessionStore = useSessionStore();
const settingsStore = useSettingsStore();
const { currentSettings } = storeToRefs(settingsStore);
const { postMessage } = useVSCode();

const pinnedHeaderHidden = computed(() => currentSettings.value.pinnedHeaderHidden);

function setPinnedHeaderHidden(hidden: boolean): void {
  if (currentSettings.value.pinnedHeaderHidden === hidden) return;
  settingsStore.setPinnedHeaderHidden(hidden);
  postMessage({ type: 'setPinnedHeaderHidden', hidden });
}

const props = defineProps<{
  messages: ChatMessage[];
  streamingMessageId?: string | null;
  compactMarkers?: CompactMarkerType[];
  modelFallbackNotices?: ModelFallbackNotice[];
  checkpointMessages?: Set<string>;
  subagents?: Record<string, SubagentState>;
}>();

const emit = defineEmits<{
  (e: 'rewind', message: ChatMessage): void;
  (e: 'expandSubagent', subagentId: string): void;
  (e: 'expandTool', toolId: string): void;
  (e: 'expandDiff', diff: ExpandedDiff): void;
  (e: 'expandWorkflow', toolUseId: string): void;
  (e: 'viewContext', promptIndex: number): void;
}>();

const scrollContainer = inject<Ref<HTMLElement | null>>('messageScrollContainer', ref(null));
const canvasRef = ref<HTMLElement | null>(null);
const stickyHeaderRef = ref<InstanceType<typeof StickyUserHeader> | null>(null);
const stickyRef = computed<HTMLElement | null>(() => stickyHeaderRef.value?.rootRef ?? null);

const messagesRef = toRef(props, 'messages');
const compactMarkersRef = toRef(props, 'compactMarkers');
const modelFallbackNoticesRef = toRef(props, 'modelFallbackNotices');
const streamingIdRef = toRef(props, 'streamingMessageId');
const subagentsRef = toRef(props, 'subagents');

const { items } = useVirtualizedMessages(messagesRef, compactMarkersRef, streamingIdRef, subagentsRef, modelFallbackNoticesRef);

const engine = useScrollEngine(items, scrollContainer, canvasRef);
const sticky = useStickyHeader(items, engine.frame);
const highlightStore = useMessageHighlightStore();

function scrollToPrimary(): void {
  const index = sticky.activeItemIndex.value;
  if (index < 0) return;
  const item = items.value[index];
  if (!item || item.type !== 'user-message') return;

  if (scrollToMessageId(item.message.id)) {
    sticky.setVisitingMessage(item.message.id);
    highlightStore.flashMessage(item.message.id);
  }
}

let scrollGeneration = 0;

function scrollToMessageId(id: string): boolean {
  const all = items.value;
  const targetIdx = all.findIndex((it) => it.type === 'user-message' && it.message.id === id);
  if (targetIdx < 0) return false;

  const container = scrollContainer.value;
  const canvas = canvasRef.value;
  if (!container || !canvas) return false;

  const OFFSET = 16;
  const EPSILON = 1;
  let attempts = 5;
  scrollGeneration++;
  const generation = scrollGeneration;

  const computeTargetTop = (): number | null => {
    const frameItem = engine.frame.value.items[targetIdx];
    if (!frameItem) return null;
    return Math.max(0, canvas.offsetTop + frameItem.top - OFFSET);
  };

  const settle = (): void => {
    if (generation !== scrollGeneration) return;
    const targetTop = computeTargetTop();
    if (targetTop === null) return;
    if (Math.abs(container.scrollTop - targetTop) < EPSILON || attempts <= 0) return;

    container.scrollTo({ top: targetTop, behavior: 'auto' });
    attempts--;
    requestAnimationFrame(() => requestAnimationFrame(settle));
  };

  settle();
  return true;
}

defineExpose({ scrollToMessageId });

watch(() => sessionStore.currentResumedSessionId, () => {
  scrollGeneration++;
  engine.knownItemIds.clear();
  expandedMessages.clear();
});

const lightboxImageUrl = ref<string | null>(null);
const logoUri = ref('');

const isWelcome = computed(() => {
  return props.messages.length === 0 && !(props.compactMarkers?.length);
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

const stickyPromptIndex = computed(() => {
  const idx = sticky.activeItemIndex.value;
  if (idx < 0) return 0;
  const item = items.value[idx];
  if (!item || item.type !== 'user-message') return 0;
  return item.message.promptIndex ?? 0;
});

const stickyCanRewind = computed(() => {
  const msg = sticky.activeMessage.value;
  return msg ? canRewindTo(msg) : false;
});

const pinnedMessageId = computed(() => sticky.activeMessage.value?.id ?? null);

const expandedMessages = reactive(new Map<string, boolean>());
function toggleExpanded(messageId: string): void {
  if (expandedMessages.get(messageId)) expandedMessages.delete(messageId);
  else expandedMessages.set(messageId, true);
}
function isExpanded(messageId: string): boolean {
  return expandedMessages.get(messageId) ?? false;
}
function toggleStickyExpanded(): void {
  const msg = sticky.activeMessage.value;
  if (msg) toggleExpanded(msg.id);
}
function toggleItemExpanded(item: typeof items.value[number]): void {
  if (item.type === 'user-message') toggleExpanded(item.message.id);
}

function getPromptIndexForMessage(messageIndex: number): number {
  return props.messages[messageIndex]?.promptIndex ?? 0;
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

function onScroll(): void {
  engine.onScroll();
  updateSticky();
}

function onUserScrollInput(): void {
  if (sticky.visitingMessageId.value !== null) sticky.setVisitingMessage(null);
}

function onContainerMouseDown(ev: MouseEvent): void {
  if (ev.target === scrollContainer.value) onUserScrollInput();
}

function updateSticky(): void {
  const container = scrollContainer.value;
  const canvas = canvasRef.value;
  if (!container || !canvas) return;
  const stickyEl = stickyRef.value;
  const stickyHeight = stickyEl && sticky.activeMessage.value ? stickyEl.offsetHeight : 0;
  sticky.update(container.scrollTop, canvas.offsetTop, stickyHeight);
  updateStickyHeight();
}

function updateStickyHeight(): void {
  const stickyEl = stickyRef.value;
  engine.setStickyHeight(stickyEl && sticky.activeMessage.value ? stickyEl.offsetHeight : 0);
}

let containerResizeObserver: ResizeObserver | null = null;
let stickySlotResizeObserver: ResizeObserver | null = null;

watch(scrollContainer, (container, prev) => {
  if (prev) {
    prev.removeEventListener('scroll', onScroll);
    prev.removeEventListener('wheel', onUserScrollInput);
    prev.removeEventListener('touchstart', onUserScrollInput);
    prev.removeEventListener('keydown', onUserScrollInput);
    prev.removeEventListener('mousedown', onContainerMouseDown);
  }
  if (container) {
    container.addEventListener('scroll', onScroll, { passive: true });
    container.addEventListener('wheel', onUserScrollInput, { passive: true });
    container.addEventListener('touchstart', onUserScrollInput, { passive: true });
    container.addEventListener('keydown', onUserScrollInput, { passive: true });
    container.addEventListener('mousedown', onContainerMouseDown, { passive: true });
    engine.measureContainerWidth();
  }
}, { immediate: true });

watch(canvasRef, (el) => {
  if (el) {
    nextTick(() => engine.forceRebuild());
  }
});

watch(stickyRef, (el, prev) => {
  if (prev && stickySlotResizeObserver) {
    stickySlotResizeObserver.disconnect();
    stickySlotResizeObserver = null;
  }
  if (el) {
    stickySlotResizeObserver = new ResizeObserver(() => updateSticky());
    stickySlotResizeObserver.observe(el);
  }
});

watch(() => sticky.activeMessage.value?.id ?? null, () => updateStickyHeight());

watch(pinnedHeaderHidden, () => {
  nextTick(() => updateSticky());
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
  stickySlotResizeObserver?.disconnect();
  const container = scrollContainer.value;
  if (container) {
    container.removeEventListener('scroll', onScroll);
    container.removeEventListener('wheel', onUserScrollInput);
    container.removeEventListener('touchstart', onUserScrollInput);
    container.removeEventListener('keydown', onUserScrollInput);
    container.removeEventListener('mousedown', onContainerMouseDown);
  }
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
    <StickyUserHeader
      v-if="sticky.activeMessage.value && !pinnedHeaderHidden"
      ref="stickyHeaderRef"
      :message="sticky.activeMessage.value"
      :offset="sticky.activeOffset.value"
      :item-index="sticky.activeItemIndex.value"
      :prompt-index="stickyPromptIndex"
      :can-rewind="stickyCanRewind"
      :expanded="isExpanded(sticky.activeMessage.value.id)"
      @rewind="(msg: ChatMessage) => emit('rewind', msg)"
      @open-lightbox="openLightbox"
      @scroll-to-primary="scrollToPrimary"
      @view-context="(idx: number) => emit('viewContext', idx)"
      @toggle-expanded="toggleStickyExpanded"
      @hide-pinned="setPinnedHeaderHidden(true)"
    />

    <div
      v-if="sticky.activeMessage.value && pinnedHeaderHidden"
      class="sticky top-0 z-20 pointer-events-none"
      style="height: 0"
    >
      <PinnedRestoreChip
        :message="sticky.activeMessage.value"
        class="absolute top-2 right-2 pointer-events-auto"
        @restore="setPinnedHeaderHidden(false)"
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
      :is-pinned-in-sticky="item.type === 'user-message' && item.message.id === pinnedMessageId && !pinnedHeaderHidden"
      :user-message-expanded="item.type === 'user-message' && isExpanded(item.message.id)"
      @rewind="(msg: ChatMessage) => emit('rewind', msg)"
      @expand-subagent="emit('expandSubagent', $event)"
      @expand-tool="emit('expandTool', $event)"
      @expand-diff="emit('expandDiff', $event)"
      @expand-workflow="emit('expandWorkflow', $event)"
      @view-context="emit('viewContext', $event)"
      @open-lightbox="openLightbox"
      @toggle-user-message-expanded="toggleItemExpanded(item)"
      @mounted="(el: HTMLElement) => engine.onItemMounted(item.id, el)"
      @unmounted="engine.onItemUnmounted(item.id)"
    />

    <ImageLightbox :open="lightboxImageUrl !== null" :image-url="lightboxImageUrl ?? ''" @close="lightboxImageUrl = null" />
  </div>
</template>
