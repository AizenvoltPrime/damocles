<script setup lang="ts">
import { ref, computed } from 'vue';
import type { ChatMessage } from '@shared/types/session';
import type { ImageBlock } from '@shared/types/content';
import UserMessageBlock from './UserMessageBlock.vue';

const props = defineProps<{
  message: ChatMessage;
  offset: number;
  itemIndex: number;
  promptIndex: number;
  canRewind: boolean;
}>();

const emit = defineEmits<{
  (e: 'rewind', message: ChatMessage): void;
  (e: 'openLightbox', block: ImageBlock): void;
  (e: 'scrollToPrimary'): void;
  (e: 'viewContext', promptIndex: number): void;
}>();

const rootRef = ref<HTMLElement | null>(null);

defineExpose({ rootRef });

const style = computed(() => ({ transform: `translateY(${props.offset}px)` }));
</script>

<template>
  <div ref="rootRef" class="sticky top-0 z-10" :style="style">
    <UserMessageBlock
      mode="pinned"
      :message="message"
      :message-index="itemIndex"
      :prompt-index="promptIndex"
      :can-rewind="canRewind"
      :offset="offset"
      @rewind="(msg: ChatMessage) => emit('rewind', msg)"
      @open-lightbox="emit('openLightbox', $event)"
      @scroll-to-primary="emit('scrollToPrimary')"
      @view-context="emit('viewContext', $event)"
    />
  </div>
</template>
