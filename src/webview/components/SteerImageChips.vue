<script setup lang="ts">
import type { ImageBlock } from '@shared/types/content';
import UserMessageImageChip from './UserMessageImageChip.vue';

defineProps<{
  images: ImageBlock[];
}>();

// The overlay hosts the lightbox, because a row remounts when its transcript is rebuilt.
const emit = defineEmits<{
  (e: 'openLightbox', block: ImageBlock): void;
}>();
</script>

<template>
  <div
    v-if="images.length > 0"
    class="flex flex-wrap gap-1.5 mb-1"
  >
    <UserMessageImageChip
      v-for="(img, index) in images"
      :key="index"
      :block="img"
      @open-lightbox="emit('openLightbox', $event)"
    />
  </div>
</template>
