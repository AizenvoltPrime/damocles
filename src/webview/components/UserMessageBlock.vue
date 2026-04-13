<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatMessage } from '@shared/types/session';
import type { ImageBlock } from '@shared/types/content';
import MarkdownRenderer from './MarkdownRenderer.vue';
import { Button } from '@/components/ui/button';
import { IconDatabase, IconChevronRight } from '@/components/icons';
import { imageBlockToDataUrl } from '@/utils/imageUtils';

const { t } = useI18n();

const props = defineProps<{
  message: ChatMessage;
  messageIndex: number;
  canRewind: boolean;
  promptIndex: number;
}>();

const emit = defineEmits<{
  (e: 'rewind'): void;
  (e: 'viewContext', promptIndex: number): void;
  (e: 'openLightbox', block: ImageBlock): void;
}>();

function isImageBlock(block: unknown): block is ImageBlock {
  return !!block && typeof block === 'object' && (block as { type: string }).type === 'image';
}

function getImageBlocks(): ImageBlock[] {
  if (!props.message.contentBlocks) return [];
  return props.message.contentBlocks.filter(isImageBlock);
}

const isInjectedOrQueued = computed(() => props.message.isInjected || props.message.isCombinedQueue || props.message.isQueued);
</script>

<template>
  <div class="group relative">
    <Button
      v-if="canRewind && !message.isInjected && !message.isCombinedQueue"
      variant="ghost"
      size="icon-sm"
      class="absolute -left-6 top-2 opacity-0 group-hover:opacity-100 text-base text-muted-foreground hover:text-foreground hover:bg-transparent"
      :title="t('welcome.undoChanges')"
      @click="emit('rewind')"
    >
      ⏪
    </Button>

    <div
      class="px-4 py-1.5 transition-shadow duration-200"
      :class="[
        isInjectedOrQueued
          ? 'bg-amber-500/10 border-y border-amber-500/25'
          : 'bg-muted/75 border-y border-border/60'
      ]"
    >
      <div
        v-if="isInjectedOrQueued"
        class="flex items-center gap-2 mb-2 text-xs text-amber-400/80"
      >
        <span class="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/30">{{ t('welcome.sentMidStream') }}</span>
        <span v-if="message.isQueued" class="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/30">{{ t('welcome.queued') }}</span>
      </div>

      <MarkdownRenderer v-if="message.content" :content="message.content" class="text-foreground" />

      <div v-if="getImageBlocks().length > 0" class="flex flex-wrap gap-2 mt-2">
        <img
          v-for="(img, imgIdx) in getImageBlocks()"
          :key="`img-${imgIdx}`"
          :src="imageBlockToDataUrl(img)"
          alt="Attached image"
          class="max-w-32 max-h-32 rounded-md border border-border object-contain cursor-pointer hover:opacity-80 transition-opacity"
          @click="emit('openLightbox', img)"
        />
      </div>

      <button
        v-if="!isInjectedOrQueued"
        type="button"
        class="group/ctx flex items-center gap-1.5 mt-2.5 mb-2 px-2 py-0.5 rounded-full text-xs font-medium text-primary/50 bg-primary/5 border border-primary/10 hover:text-primary hover:bg-primary/10 hover:border-primary/20 transition-all duration-200 cursor-pointer"
        :title="t('contextInjection.viewContext')"
        @click.stop="emit('viewContext', promptIndex)"
      >
        <span class="relative flex h-1.5 w-1.5 shrink-0">
          <span class="absolute inline-flex h-full w-full rounded-full bg-primary opacity-0 group-hover/ctx:opacity-40 group-hover/ctx:animate-ping" />
          <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary/70" />
        </span>
        <IconDatabase :size="10" class="shrink-0 opacity-60 group-hover/ctx:opacity-100 transition-opacity" />
        <span>{{ t('contextInjection.viewContext') }}</span>
        <IconChevronRight
          :size="8"
          class="shrink-0 opacity-0 -ml-0.5 group-hover/ctx:opacity-60 group-hover/ctx:ml-0 transition-all duration-200"
        />
      </button>
    </div>
  </div>
</template>
