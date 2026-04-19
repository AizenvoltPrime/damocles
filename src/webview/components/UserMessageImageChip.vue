<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ImageBlock } from '@shared/types/content';
import { useImageBlockDimensions } from '@/composables/useImageBlockDimensions';
import { imageBlockToDataUrl } from '@/utils/imageUtils';
import ImageChip from './ImageChip.vue';

const props = defineProps<{
  block: ImageBlock;
  filename?: string;
}>();

const emit = defineEmits<{
  (e: 'openLightbox', block: ImageBlock): void;
}>();

const { t } = useI18n();

const dims = useImageBlockDimensions(props.block);
const thumbnailUrl = computed(() => imageBlockToDataUrl(props.block));
const displayFilename = computed(() => props.filename ?? `image.${props.block.source.media_type.split('/')[1]}`);

function handleClick(): void {
  emit('openLightbox', props.block);
}
</script>

<template>
  <ImageChip
    :filename="displayFilename"
    :width="dims?.width"
    :height="dims?.height"
    :thumbnail-url="thumbnailUrl"
    :title="t('imageThumbnail.clickToPreview')"
    @click="handleClick"
  />
</template>
