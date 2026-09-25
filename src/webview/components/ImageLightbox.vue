<script setup lang="ts">
import ImageLightboxLayer from './ImageLightboxLayer.vue';

defineProps<{
  open: boolean;
  imageUrl: string;
}>();

defineEmits<{
  close: [];
}>();
</script>

<template>
  <ImageLightboxLayer v-if="open" :image-url="imageUrl" @close="$emit('close')" />
</template>
