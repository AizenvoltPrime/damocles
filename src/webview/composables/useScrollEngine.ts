import { ref, watch, shallowRef, type Ref, type ShallowRef } from 'vue';
import { estimateTextHeight, isReady } from './usePretextMeasurement';
import type { VirtualItem } from './useVirtualizedMessages';

export interface FrameItem {
  top: number;
  height: number;
  bottom: number;
}

export interface Frame {
  items: FrameItem[];
  totalHeight: number;
}

const BOTTOM_PADDING = 16;
const OVERSCAN = 5;

const LEVEL_GAPS = [16, 12, 8] as const;

function getGap(prev: VirtualItem, curr: VirtualItem): number {
  if (prev.spacingLevel === 0 || curr.spacingLevel === 0) return 16;
  if (prev.sourceMessageId !== curr.sourceMessageId) return 16;
  const level = Math.min(prev.spacingLevel, curr.spacingLevel);
  return LEVEL_GAPS[Math.min(level, LEVEL_GAPS.length - 1)];
}

const CARD_HEADER = 34;
const CARD_CONTENT_PADDING = 24;
const CARD_BORDER = 2;
const CARD_IN_LINE = 16;
const CARD_OUT_LINE = 24;

const FILE_OP_TOOLS = new Set(['Edit', 'Write']);

function estimateToolCallHeight(item: VirtualItem): number {
  const toolCall = item.toolCall;
  if (!toolCall) return CARD_HEADER + CARD_CONTENT_PADDING + CARD_IN_LINE + CARD_BORDER;

  const hasResult = !!toolCall.result || !!toolCall.errorMessage;
  const isFileOp = FILE_OP_TOOLS.has(toolCall.name) && hasResult;

  if (isFileOp) return CARD_HEADER + 120 + CARD_BORDER;
  if (hasResult) return CARD_HEADER + CARD_CONTENT_PADDING + CARD_IN_LINE + CARD_OUT_LINE + CARD_BORDER;
  return CARD_HEADER + CARD_CONTENT_PADDING + CARD_IN_LINE + CARD_BORDER;
}

const THINKING_TRIGGER = 30;
const THINKING_CONTENT_OVERHEAD = 10;
const THINKING_MAX_CONTENT = 256;

function estimateThinkingHeight(item: VirtualItem): number {
  const msg = item.message;
  const isStreaming = !!msg.isThinkingPhase;
  const hasContent = !!(msg.thinking || msg.thinkingContent);

  if (isStreaming && hasContent) {
    const text = msg.thinking || msg.thinkingContent || '';
    const estimatedContent = Math.min(text.length * 0.3, THINKING_MAX_CONTENT);
    return THINKING_TRIGGER + THINKING_CONTENT_OVERHEAD + estimatedContent;
  }

  return THINKING_TRIGGER;
}

function estimateHeight(item: VirtualItem, containerWidth: number): number {
  if (item.type === 'tool-call') return estimateToolCallHeight(item);
  if (item.type === 'thinking-block') return estimateThinkingHeight(item);
  if (item.type === 'compact-marker') return 36;
  if (item.type === 'model-fallback-notice') return 32;
  if (item.type === 'error-message') return 32;
  if (item.type === 'refusal-message') return 110;
  if (item.type === 'background-label') return 32;

  if (!isReady()) {
    if (item.type === 'user-message') return 80;
    return 36;
  }

  const textWidth = Math.max(100, containerWidth - 32);

  if (item.type === 'user-message') {
    const textH = item.text ? estimateTextHeight(item.text, textWidth) : 22;
    const paddingH = 12;
    const imageH = item.imageBlocks?.length ? 40 : 0;
    const badgeH = (item.message.isInjected || item.message.isCombinedQueue || item.message.isQueued) ? 24 : 0;
    const contextButtonH = 32;
    return textH + paddingH + imageH + badgeH + contextButtonH;
  }

  if (item.type === 'text-block' || item.type === 'streaming-text') {
    return item.text ? estimateTextHeight(item.text, textWidth) : 36;
  }

  return 36;
}

function binarySearchVisibleRange(
  f: Frame,
  scrollTopRelative: number,
  viewportHeight: number,
  topOcclusion: number,
): { start: number; end: number } {
  if (f.items.length === 0) return { start: 0, end: 0 };

  const minY = Math.max(0, scrollTopRelative + topOcclusion);
  const maxY = Math.max(minY, scrollTopRelative + viewportHeight);

  let low = 0;
  let high = f.items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (f.items[mid].bottom > minY) high = mid;
    else low = mid + 1;
  }
  const start = Math.max(0, low - OVERSCAN);

  low = start;
  high = f.items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (f.items[mid].top >= maxY) high = mid;
    else low = mid + 1;
  }
  const end = Math.min(f.items.length, low + OVERSCAN);

  return { start, end };
}

export function useScrollEngine(
  virtualItems: Ref<VirtualItem[]>,
  scrollContainer: Ref<HTMLElement | null>,
  canvasRef: Ref<HTMLElement | null>,
) {
  const containerWidth = ref(0);
  const frame: ShallowRef<Frame> = shallowRef({ items: [], totalHeight: 0 });
  const visibleStart = ref(0);
  const visibleEnd = ref(0);
  const stickyHeight = ref(0);
  const frameVersion = ref(0);

  const knownItemIds = new Set<string>();
  const measuredHeights = new Map<string, number>();
  const itemIdToIndex = new Map<string, number>();

  let scheduledRaf: number | null = null;
  let lastBuildWidth = 0;
  const resizeObservers = new Map<string, ResizeObserver>();

  function getItemHeight(item: VirtualItem, width: number): number {
    const measured = measuredHeights.get(item.id);
    if (measured !== undefined) return measured;
    return estimateHeight(item, width);
  }

  watch(
    [virtualItems, containerWidth],
    ([items, width]) => {
      if (width > 0) {
        if (width !== lastBuildWidth) measuredHeights.clear();
        lastBuildWidth = width;

        itemIdToIndex.clear();
        for (let i = 0; i < items.length; i++) {
          itemIdToIndex.set(items[i].id, i);
        }

        frame.value = buildFrameWithCache(items, width);
        frameVersion.value++;
        scheduleVisibleRangeUpdate();
      }
    },
    { immediate: true },
  );

  function buildFrameWithCache(items: VirtualItem[], width: number): Frame {
    if (items.length === 0) return { items: [], totalHeight: 0 };

    const frameItems: FrameItem[] = new Array(items.length);
    let y = 0;

    let lastVisibleIdx = -1;
    for (let i = 0; i < items.length; i++) {
      const height = getItemHeight(items[i], width);
      if (height > 0 && lastVisibleIdx >= 0) {
        y += getGap(items[lastVisibleIdx], items[i]);
      }
      frameItems[i] = { top: y, height, bottom: y + height };
      y += height;
      if (height > 0) lastVisibleIdx = i;
    }

    return { items: frameItems, totalHeight: y + BOTTOM_PADDING };
  }

  function measureContainerWidth(): void {
    const container = scrollContainer.value;
    if (container) {
      const w = container.clientWidth;
      if (w !== containerWidth.value) containerWidth.value = w;
    }
  }

  function scheduleVisibleRangeUpdate(): void {
    if (scheduledRaf !== null) return;
    scheduledRaf = requestAnimationFrame(() => {
      scheduledRaf = null;
      updateVisibleRange();
    });
  }

  function updateVisibleRange(): void {
    const container = scrollContainer.value;
    const canvas = canvasRef.value;
    if (!container || !canvas) return;

    const w = container.clientWidth;
    if (w > 0 && w !== containerWidth.value) {
      containerWidth.value = w;
      return;
    }

    const viewportHeight = container.clientHeight;
    const scrollTop = container.scrollTop;
    const canvasOffset = canvas.offsetTop;
    const scrollTopRelative = scrollTop - canvasOffset;

    const { start, end } = binarySearchVisibleRange(
      frame.value, scrollTopRelative, viewportHeight, stickyHeight.value,
    );

    visibleStart.value = start;
    visibleEnd.value = end;
  }

  function onScroll(): void {
    scheduleVisibleRangeUpdate();
  }

  function setStickyHeight(h: number): void {
    if (h !== stickyHeight.value) {
      stickyHeight.value = h;
      scheduleVisibleRangeUpdate();
    }
  }

  function onItemResized(itemId: string, newHeight: number): void {
    measuredHeights.set(itemId, newHeight);

    const items = virtualItems.value;
    const index = itemIdToIndex.get(itemId);
    if (index === undefined) return;

    const f = frame.value;
    if (index >= f.items.length) return;

    const oldHeight = f.items[index].height;
    if (Math.abs(newHeight - oldHeight) < 1) return;

    const newItems = f.items.slice();
    newItems[index] = { top: newItems[index].top, height: newHeight, bottom: newItems[index].top + newHeight };

    for (let i = index + 1; i < newItems.length; i++) {
      const h = newItems[i].height;
      if (h === 0) {
        const top = newItems[i - 1].bottom;
        newItems[i] = { top, height: 0, bottom: top };
        continue;
      }
      let j = i - 1;
      while (j >= 0 && newItems[j].height === 0) j--;
      const gap = j >= 0 ? getGap(items[j], items[i]) : 0;
      const base = j >= 0 ? newItems[j].bottom : 0;
      const top = base + gap;
      newItems[i] = { top, height: h, bottom: top + h };
    }

    const lastItem = newItems[newItems.length - 1];
    const totalHeight = lastItem ? lastItem.bottom + BOTTOM_PADDING : 0;

    const container = scrollContainer.value;
    const canvas = canvasRef.value;
    if (container && canvas) {
      const canvasOffset = canvas.offsetTop;
      if ((canvasOffset + newItems[index].top) < container.scrollTop) {
        container.scrollTop += (newHeight - oldHeight);
      }
    }

    frame.value = { items: newItems, totalHeight };
    frameVersion.value++;
  }

  function onItemMounted(itemId: string, el: HTMLElement): void {
    if (resizeObservers.has(itemId)) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
        onItemResized(itemId, height);
      }
    });
    observer.observe(el);
    resizeObservers.set(itemId, observer);
  }

  function onItemUnmounted(itemId: string): void {
    const observer = resizeObservers.get(itemId);
    if (observer) {
      observer.disconnect();
      resizeObservers.delete(itemId);
    }
    if (!itemIdToIndex.has(itemId)) {
      measuredHeights.delete(itemId);
    }
  }

  function forceRebuild(): void {
    measureContainerWidth();
  }

  function destroy(): void {
    if (scheduledRaf !== null) {
      cancelAnimationFrame(scheduledRaf);
      scheduledRaf = null;
    }
    for (const observer of resizeObservers.values()) observer.disconnect();
    resizeObservers.clear();
  }

  return {
    frame,
    visibleStart,
    visibleEnd,
    frameVersion,
    knownItemIds,
    stickyHeight,
    onScroll,
    setStickyHeight,
    onItemMounted,
    onItemUnmounted,
    forceRebuild,
    destroy,
    measureContainerWidth,
  };
}
