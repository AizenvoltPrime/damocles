<script setup lang="ts">
import { ref } from 'vue';
import type { ElementAttachment } from '@shared/types/browser';
import { IconX, IconCode } from '@/components/icons';
import ImageLightbox from './ImageLightbox.vue';
import { formatElementContext } from '@/composables/useElementAttachments';
import { usePlatformBridge } from '@/composables/usePlatformBridge';

const { postMessage } = usePlatformBridge();

defineProps<{
  attachments: ElementAttachment[];
}>();

defineEmits<{
  remove: [id: string];
}>();

const lightboxImageUrl = ref<string | null>(null);

function openLightbox(attachment: ElementAttachment): void {
  if (attachment.elementScreenshot) {
    lightboxImageUrl.value = `data:image/png;base64,${attachment.elementScreenshot}`;
  }
}

function closeLightbox(): void {
  lightboxImageUrl.value = null;
}

function openElementCode(attachment: ElementAttachment): void {
  postMessage({ type: 'openElementContext', content: formatElementContext(attachment) });
}
</script>

<template>
  <div
    v-if="attachments.length > 0"
    class="flex gap-2 p-2 overflow-x-auto border-b border-border/50"
  >
    <template
      v-for="attachment in attachments"
      :key="attachment.id"
    >
      <!-- Image card -->
      <div class="relative group shrink-0">
        <img
          v-if="attachment.elementScreenshot"
          :src="`data:image/png;base64,${attachment.elementScreenshot}`"
          :alt="attachment.selector"
          class="size-16 object-cover rounded-md border border-border cursor-pointer hover:opacity-80 transition-opacity"
          :title="$t('elementAttachment.preview')"
          @click="openLightbox(attachment)"
        >
        <div
          v-else
          class="size-16 rounded-md border border-border bg-muted flex items-center justify-center"
        >
          <span class="text-10 text-muted-foreground">DOM</span>
        </div>
        <button
          class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-destructive text-destructive-foreground
                 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity
                 hover:bg-destructive/80 cursor-pointer"
          @click="$emit('remove', attachment.id)"
        >
          <IconX class="size-3" />
        </button>
      </div>

      <!-- Code card -->
      <div
        class="relative group shrink-0 flex items-center gap-2 px-2 py-1.5 rounded-md border border-border bg-card hover:bg-accent/50 transition-colors cursor-pointer"
        :title="$t('elementAttachment.openContext')"
        @click="openElementCode(attachment)"
      >
        <IconCode
          class="size-3.5 text-(--d-info) shrink-0"
        />
        <div class="flex flex-col min-w-0">
          <span class="text-10 font-medium text-(--d-info) uppercase tracking-wider">{{ $t('elementAttachment.element') }}</span>
          <span
            class="text-xs text-foreground truncate max-w-30"
            :title="attachment.selector"
          >
            {{ attachment.selector }}
          </span>
        </div>
        <button
          class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-destructive text-destructive-foreground
                 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity
                 hover:bg-destructive/80 cursor-pointer"
          @click.stop="$emit('remove', attachment.id)"
        >
          <IconX class="size-3" />
        </button>
      </div>
    </template>

    <ImageLightbox
      :open="lightboxImageUrl !== null"
      :image-url="lightboxImageUrl ?? ''"
      @close="closeLightbox"
    />
  </div>
</template>
