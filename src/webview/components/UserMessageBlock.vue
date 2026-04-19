<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatMessage } from '@shared/types/session';
import type { ImageBlock } from '@shared/types/content';
import MarkdownRenderer from './MarkdownRenderer.vue';
import UserMessageImageChip from './UserMessageImageChip.vue';
import { isImageContentBlock } from '@/utils/imageUtils';
import { Button } from '@/components/ui/button';
import {
  IconDatabase,
  IconChevronRight,
  IconCopy,
  IconCheck,
  IconRotateLeft,
  IconArrowUp,
} from '@/components/icons';
import { useCopyToClipboard } from '@/composables/useCopyToClipboard';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    message: ChatMessage;
    messageIndex: number;
    canRewind: boolean;
    promptIndex: number;
    mode?: 'canvas' | 'pinned';
    offset?: number;
  }>(),
  {
    mode: 'canvas',
    offset: 0,
  },
);

const emit = defineEmits<{
  (e: 'rewind', message: ChatMessage): void;
  (e: 'viewContext', promptIndex: number): void;
  (e: 'openLightbox', block: ImageBlock): void;
  (e: 'scrollToPrimary'): void;
}>();

const { hasCopied, copyToClipboard } = useCopyToClipboard(2000);

const imageBlocks = computed<ImageBlock[]>(() => {
  if (!props.message.contentBlocks) return [];
  return props.message.contentBlocks.filter(isImageContentBlock);
});

const isInjectedOrQueued = computed(
  () => props.message.isInjected || props.message.isCombinedQueue || props.message.isQueued,
);

function handleCopy(): void {
  if (props.message.content) void copyToClipboard(props.message.content);
}

const isPinned = computed(() => props.mode === 'pinned');
const showScrollUp = computed(() => isPinned.value && props.offset === 0);
</script>

<template>
  <div class="flex justify-center px-2 py-2">
    <div class="w-full">
      <div
        class="group relative rounded-xl border px-4 py-3 motion-safe:transition-shadow motion-safe:transition-colors motion-safe:duration-200"
        :class="[
          isInjectedOrQueued
            ? isPinned
              ? 'bg-[color-mix(in_srgb,var(--color-warning)_10%,var(--background))] border-warning/25'
              : 'bg-warning/10 border-warning/25'
            : isPinned
              ? 'bg-muted/[0.98] border-border'
              : 'bg-muted/75 border-border group-hover:shadow-md',
          isPinned ? 'shadow-md ring-1 ring-border/40' : 'shadow-sm',
        ]"
      >
        <div
          v-if="isInjectedOrQueued"
          class="flex items-center gap-2 mb-2 text-xs text-warning/80"
        >
          <span class="px-1.5 py-0.5 rounded bg-warning/15 border border-warning/30">
            {{ t('welcome.sentMidStream') }}
          </span>
          <span
            v-if="message.isQueued"
            class="px-1.5 py-0.5 rounded bg-warning/15 border border-warning/30"
          >
            {{ t('welcome.queued') }}
          </span>
        </div>

        <div class="pr-12 max-h-[50vh] overflow-y-auto overscroll-contain">
          <div v-if="imageBlocks.length > 0" class="flex flex-wrap gap-1.5 mb-2">
            <UserMessageImageChip
              v-for="img in imageBlocks"
              :key="img.source.data"
              :block="img"
              @open-lightbox="emit('openLightbox', $event)"
            />
          </div>

          <MarkdownRenderer
            v-if="message.content"
            :content="message.content"
            class="text-foreground"
          />
        </div>

        <div
          class="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 motion-safe:transition-opacity motion-safe:duration-150"
        >
          <Button
            v-if="showScrollUp"
            variant="ghost"
            size="icon-sm"
            class="h-6 w-6 text-muted-foreground hover:text-foreground focus-visible:opacity-100"
            :title="t('userMessage.scrollToTopTitle')"
            @click="emit('scrollToPrimary')"
          >
            <IconArrowUp :size="12" />
          </Button>
          <Button
            v-if="canRewind && !isInjectedOrQueued"
            variant="ghost"
            size="icon-sm"
            class="h-6 w-6 text-muted-foreground hover:text-foreground focus-visible:opacity-100"
            :title="t('welcome.undoChanges')"
            :aria-label="t('userMessage.rewindAria')"
            @click="emit('rewind', props.message)"
          >
            <IconRotateLeft :size="12" />
          </Button>
          <Button
            v-if="message.content"
            variant="ghost"
            size="icon-sm"
            class="h-6 w-6 text-muted-foreground hover:text-foreground focus-visible:opacity-100"
            :class="{ 'text-success': hasCopied }"
            :title="hasCopied ? t('userMessage.copiedTitle') : t('userMessage.copyTitle')"
            :aria-label="hasCopied ? t('userMessage.copiedAria') : t('userMessage.copyAria')"
            @click="handleCopy"
          >
            <IconCheck v-if="hasCopied" :size="12" />
            <IconCopy v-else :size="12" />
          </Button>
        </div>

        <span class="sr-only" role="status" aria-live="polite">
          {{ hasCopied ? t('userMessage.copiedAnnouncement') : '' }}
        </span>

        <button
          v-if="!isInjectedOrQueued"
          type="button"
          class="group/ctx flex items-center gap-1.5 mt-2.5 px-2 py-0.5 rounded-full text-xs font-medium text-primary/50 bg-primary/5 border border-primary/10 hover:text-primary hover:bg-primary/10 hover:border-primary/20 motion-safe:transition-all motion-safe:duration-200 cursor-pointer"
          :title="t('contextInjection.viewContext')"
          @click.stop="emit('viewContext', promptIndex)"
        >
          <span class="relative flex h-1.5 w-1.5 shrink-0">
            <span
              class="absolute inline-flex h-full w-full rounded-full bg-primary opacity-0 group-hover/ctx:opacity-40 group-hover/ctx:animate-ping"
            />
            <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary/70" />
          </span>
          <IconDatabase
            :size="10"
            class="shrink-0 opacity-60 group-hover/ctx:opacity-100 motion-safe:transition-opacity"
          />
          <span>{{ t('contextInjection.viewContext') }}</span>
          <IconChevronRight
            :size="8"
            class="shrink-0 opacity-0 -ml-0.5 group-hover/ctx:opacity-60 group-hover/ctx:ml-0 motion-safe:transition-all motion-safe:duration-200"
          />
        </button>
      </div>
    </div>
  </div>
</template>
