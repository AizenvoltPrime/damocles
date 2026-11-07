<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ImageAttachment } from '@/composables/useImageAttachments';
import { IconX } from '@/components/icons';
import ImageChip from './ImageChip.vue';
import ImageLightbox from './ImageLightbox.vue';

const { t } = useI18n();

defineProps<{
  attachments: ImageAttachment[];
}>();

defineEmits<{
  remove: [id: string];
}>();

const lightboxImageUrl = ref<string | null>(null);

// An image Damocles made is named by its origin in the current language.
function nameOf(attachment: ImageAttachment): string | undefined {
  return attachment.fileName ?? (attachment.origin === 'designPreview' ? t('imageAttachment.previewScreenshot') : undefined);
}

function openLightbox(attachment: ImageAttachment): void {
  lightboxImageUrl.value = attachment.dataUrl;
}

function closeLightbox(): void {
  lightboxImageUrl.value = null;
}
</script>

<template>
  <div
    v-if="attachments.length > 0"
    class="flex flex-wrap gap-1.5 p-2 border-b border-border/50"
  >
    <div
      v-for="attachment in attachments"
      :key="attachment.id"
      class="relative group shrink-0"
      data-testid="composer-image-attachment"
      :data-origin="attachment.origin"
    >
      <ImageChip
        :filename="nameOf(attachment)"
        :width="attachment.width"
        :height="attachment.height"
        :thumbnail-url="attachment.dataUrl"
        :title="t('imageThumbnail.clickToPreview')"
        @click="openLightbox(attachment)"
      />
      <button
        type="button"
        class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-destructive text-destructive-foreground
               flex items-center justify-center opacity-0 group-hover:opacity-100 motion-safe:transition-opacity
               hover:bg-destructive/80 cursor-pointer"
        :title="t('imageThumbnail.remove', { name: nameOf(attachment) || 'image' })"
        :aria-label="t('imageThumbnail.remove', { name: nameOf(attachment) || 'image' })"
        @click="$emit('remove', attachment.id)"
      >
        <IconX class="size-3" />
      </button>
    </div>

    <ImageLightbox
      :open="lightboxImageUrl !== null"
      :image-url="lightboxImageUrl ?? ''"
      @close="closeLightbox"
    />
  </div>
</template>
