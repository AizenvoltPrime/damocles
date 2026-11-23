<script setup lang="ts">
import { computed } from 'vue';
import type { CharacterFrameView } from '@shared/themes/characters';

// One state of a project character, filling its box: a strip clipped to one frame and stepped by d-sprite (motion.css), or an
// image; while it does not move, its first frame. `hover` moves it only under the pointer, over it or its [data-character-host].
// `failed` says an image did not load, so the owner can show something else.
const props = defineProps<{
  frame: CharacterFrameView;
  alt: string;
  moves: boolean;
  hover?: boolean;
}>();
const emit = defineEmits<{ failed: [] }>();

const stripStyle = computed(() => {
  const strip = props.frame.strip;
  return strip ? { width: `${strip.frames * 100}%`, '--sprite-frames': String(strip.frames), '--sprite-duration': `${strip.frames / strip.fps}s` } : undefined;
});
const boxStyle = computed(() => {
  const strip = props.frame.strip;
  return strip ? { aspectRatio: `${strip.frameWidth} / ${strip.frameHeight}`, [strip.frameWidth >= strip.frameHeight ? 'width' : 'height']: '100%' } : undefined;
});
</script>

<template>
  <span
    v-if="frame.strip"
    class="relative block max-h-full max-w-full overflow-hidden"
    :style="boxStyle"
  >
    <img
      :src="frame.url"
      :alt="alt"
      draggable="false"
      class="project-character-image absolute inset-y-0 left-0 h-full max-w-none"
      :class="moves ? 'd-sprite' : ''"
      :data-sprite-hover="moves && hover ? '' : undefined"
      :style="stripStyle"
      @error="emit('failed')"
    >
  </span>
  <template v-else-if="moves && hover && frame.still">
    <img
      :src="frame.still"
      :alt="alt"
      draggable="false"
      class="project-character-image project-character-still size-full object-contain"
      @error="emit('failed')"
    >
    <img
      :src="frame.url"
      alt=""
      draggable="false"
      class="project-character-image project-character-moving size-full object-contain"
      @error="emit('failed')"
    >
  </template>
  <img
    v-else
    :src="moves || !frame.still ? frame.url : frame.still"
    :alt="alt"
    draggable="false"
    class="project-character-image size-full object-contain"
    @error="emit('failed')"
  >
</template>
