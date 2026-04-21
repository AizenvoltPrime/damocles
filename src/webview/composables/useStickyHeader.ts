import { ref, type Ref } from 'vue';
import type { ChatMessage } from '@shared/types/session';
import type { VirtualItem } from './useVirtualizedMessages';
import type { Frame } from './useScrollEngine';

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useStickyHeader(
  virtualItems: Ref<VirtualItem[]>,
  frame: Ref<Frame>,
) {
  const activeMessage = ref<ChatMessage | null>(null);
  const activeItemIndex = ref(-1);
  const activeOffset = ref(0);
  const visitingMessageId = ref<string | null>(null);

  function setVisitingMessage(id: string | null): void {
    visitingMessageId.value = id;
  }

  function update(scrollTop: number, canvasOffset: number, stickyHeight: number): void {
    const items = virtualItems.value;
    const f = frame.value;

    let visitingIndex = -1;
    if (visitingMessageId.value !== null) {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.type === 'user-message' && it.message.id === visitingMessageId.value) {
          visitingIndex = i;
          break;
        }
      }
    }

    let activeIndex = -1;
    let activeMsg: ChatMessage | null = null;
    let nextFrameTop: number | null = null;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.type !== 'user-message') continue;
      if (i >= f.items.length) continue;
      if (visitingIndex >= 0 && i <= visitingIndex) continue;
      if (it.message.isInjected || it.message.isCombinedQueue || it.message.isQueued) continue;
      const topY = canvasOffset + f.items[i].top;
      if (topY < scrollTop) {
        activeIndex = i;
        activeMsg = it.message;
      } else {
        nextFrameTop = topY;
        break;
      }
    }

    activeMessage.value = activeMsg;
    activeItemIndex.value = activeIndex;

    let offset = 0;
    if (nextFrameTop !== null && stickyHeight > 0) {
      const gap = nextFrameTop - (scrollTop + stickyHeight);
      offset = Math.min(0, Math.max(-stickyHeight, gap));
    }
    if (prefersReducedMotion() && stickyHeight > 0) {
      offset = offset < -stickyHeight / 2 ? -stickyHeight : 0;
    }
    activeOffset.value = offset;
  }

  return {
    activeMessage,
    activeItemIndex,
    activeOffset,
    visitingMessageId,
    setVisitingMessage,
    update,
  };
}
