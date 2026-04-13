import { ref, reactive, type Ref } from 'vue';
import type { ChatMessage } from '@shared/types/session';
import type { VirtualItem } from './useVirtualizedMessages';
import type { Frame } from './useScrollEngine';

export function useStickyHeader(
  virtualItems: Ref<VirtualItem[]>,
  frame: Ref<Frame>,
) {
  const activeMessage = ref<ChatMessage | null>(null);
  const activeItemIndex = ref(-1);
  const expandedStickies = reactive(new Map<string, boolean>());

  function update(scrollTop: number, canvasOffset: number): void {
    const items = virtualItems.value;
    const f = frame.value;

    let found: ChatMessage | null = null;
    let foundIndex = -1;

    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].type !== 'user-message') continue;
      if (i >= f.items.length) continue;
      if ((canvasOffset + f.items[i].bottom) < scrollTop) {
        found = items[i].message;
        foundIndex = i;
        break;
      }
    }

    activeMessage.value = found;
    activeItemIndex.value = foundIndex;
  }

  function isExpanded(messageId: string): boolean {
    return expandedStickies.get(messageId) ?? false;
  }

  function toggle(messageId: string): void {
    expandedStickies.set(messageId, !isExpanded(messageId));
  }

  function getOriginalTop(): number {
    const idx = activeItemIndex.value;
    if (idx < 0 || idx >= frame.value.items.length) return 0;
    return frame.value.items[idx].top;
  }

  return {
    activeMessage,
    activeItemIndex,
    isExpanded,
    toggle,
    update,
    getOriginalTop,
  };
}
