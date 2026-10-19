<script setup lang="ts">
import { computed } from 'vue';
import { fileIconLook } from '../file-icons';

const props = withDefaults(defineProps<{ path: string; directory?: boolean; open?: boolean }>(), { directory: false, open: false });
// Rendered as one <img> across icon changes (expand, rename, theme kind): a new src keeps painting the current image until
// the next has loaded, where a new element paints nothing for a frame.
const look = computed(() => fileIconLook(props.path, props.directory, props.open));
</script>

<template>
  <img
    v-if="'src' in look"
    :src="look.src"
    alt=""
    draggable="false"
  >
  <component
    :is="look.icon"
    v-else
    aria-hidden="true"
    :style="{ color: look.color }"
  />
</template>
