<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef } from 'vue';
import type { ChatMessage } from '@shared/types/session';
import VirtualItemWrapper from '@/components/VirtualItemWrapper.vue';
import { useVirtualizedMessages } from '@/composables/useVirtualizedMessages';
import { getGap } from '@/composables/useScrollEngine';

// The sample chat in the chat view's own rows, built from its messages as the chat view builds them and stacked from their
// measured heights with the list's gaps. Nothing scrolls, streams or arrives.
const props = defineProps<{ messages: readonly ChatMessage[] }>();

const { items } = useVirtualizedMessages({
  messages: shallowRef([...props.messages]),
  compactMarkers: shallowRef(undefined),
  cacheMissNotices: shallowRef(undefined),
  compactionAbortedNotices: shallowRef(undefined),
  thinkingDroppedNotices: shallowRef(undefined),
  streamingMessageId: shallowRef(null),
});

// px by item id, from each row's box
const heights = shallowRef<Readonly<Record<string, number>>>({});
const rows = new Map<Element, string>();
const observer = new ResizeObserver((entries) => {
  const next = { ...heights.value };
  for (const entry of entries) {
    const id = rows.get(entry.target);
    if (id !== undefined) next[id] = (entry.target as HTMLElement).offsetHeight;
  }
  heights.value = next;
});
onBeforeUnmount(() => observer.disconnect());

function measure(id: string, element: HTMLElement): void {
  rows.set(element, id);
  observer.observe(element);
}

const frame = computed(() => {
  let bottom = 0;
  const tops = items.value.map((item, index) => {
    const previous = items.value[index - 1];
    const top = previous ? bottom + getGap(previous, item) : 0;
    bottom = top + (heights.value[item.id] ?? 0);
    return top;
  });
  return { tops, height: bottom };
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden bg-(--d-pane-chat) text-(--d-text)">
    <!-- The chat header's surface (h-11.5, panel background, bottom border), which the chat gutter's top cell continues. -->
    <div
      aria-hidden="true"
      class="h-11.5 shrink-0 border-b border-(--d-border) bg-(--d-panel)"
    />
    <div class="min-h-0 flex-1 overflow-hidden pt-4">
      <div
        class="relative"
        data-testid="sample-transcript"
        :style="{ minHeight: `${frame.height}px` }"
      >
        <VirtualItemWrapper
          v-for="(item, index) in items"
          :key="item.id"
          :item="item"
          :top="frame.tops[index] ?? 0"
          :arriving="false"
          :can-rewind="false"
          :prompt-index="item.message.promptIndex ?? 0"
          @mounted="measure(item.id, $event)"
        />
      </div>
    </div>
  </div>
</template>
