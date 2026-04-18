import { ref, type Ref } from 'vue';
import type { ChatMessage } from '@shared/types/session';
import type { VirtualItem } from './useVirtualizedMessages';
import type { Frame } from './useScrollEngine';

export function useStickyHeader(
  virtualItems: Ref<VirtualItem[]>,
  frame: Ref<Frame>,
) {
  const activeMessage = ref<ChatMessage | null>(null);
  const activeItemIndex = ref(-1);

  function update(scrollTop: number, canvasOffset: number, stickyHeight: number): void {
    const items = virtualItems.value;
    const f = frame.value;
    const stickyBottom = scrollTop + stickyHeight;

    let found: ChatMessage | null = null;
    let foundIndex = -1;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type !== 'user-message') continue;
      if (i >= f.items.length) continue;
      const itemTop = canvasOffset + f.items[i].top;
      const itemBottom = canvasOffset + f.items[i].bottom;

      if (itemBottom < scrollTop) {
        found = items[i].message;
        foundIndex = i;
        continue;
      }

      if (foundIndex >= 0 && itemTop < stickyBottom) {
        found = items[i].message;
        foundIndex = i;
      }
      break;
    }

    activeMessage.value = found;
    activeItemIndex.value = foundIndex;
  }

  return {
    activeMessage,
    activeItemIndex,
    update,
  };
}
