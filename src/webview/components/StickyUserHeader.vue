<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatMessage } from '@shared/types/session';
import type { ImageBlock } from '@shared/types/content';
import MarkdownRenderer from './MarkdownRenderer.vue';
import { Button } from '@/components/ui/button';
import { IconChevronUp, IconChevronDown, IconArrowUp } from '@/components/icons';

const { t } = useI18n();

const props = defineProps<{
  message: ChatMessage | null;
  expanded: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle'): void;
  (e: 'scrollToOriginal'): void;
  (e: 'openLightbox', block: ImageBlock): void;
}>();

function isImageBlock(block: unknown): block is ImageBlock {
  return !!block && typeof block === 'object' && (block as { type: string }).type === 'image';
}

const imageCount = computed(() => {
  if (!props.message?.contentBlocks) return 0;
  return props.message.contentBlocks.filter(isImageBlock).length;
});
</script>

<template>
  <div
    v-if="message"
    class="px-4 py-2.5 bg-card shadow-[0_4px_12px_-4px_rgba(0,0,0,0.4)] border-b border-border/60"
  >
    <div class="relative">
      <div :class="expanded ? 'max-h-[30vh] overflow-y-auto' : 'max-h-[3.5rem] overflow-hidden'">
        <MarkdownRenderer v-if="message.content" :content="message.content" class="text-foreground" />
      </div>
      <div
        v-if="!expanded"
        class="absolute bottom-0 inset-x-0 h-4 bg-gradient-to-t from-card to-transparent pointer-events-none"
      />
    </div>
    <span v-if="imageCount > 0" class="text-xs text-muted-foreground">
      {{ t('stickyMessage.imageCount', { n: imageCount }, imageCount) }}
    </span>
    <div class="flex items-center gap-1 mt-1">
      <Button
        variant="ghost"
        size="icon-sm"
        class="h-5 w-5 text-muted-foreground hover:text-foreground"
        @click.stop="emit('toggle')"
      >
        <IconChevronUp v-if="expanded" :size="12" />
        <IconChevronDown v-else :size="12" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        class="h-5 w-5 text-muted-foreground hover:text-foreground"
        @click.stop="emit('scrollToOriginal')"
      >
        <IconArrowUp :size="12" />
      </Button>
    </div>
  </div>
</template>
