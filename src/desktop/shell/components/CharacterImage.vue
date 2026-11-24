<script setup lang="ts">
import { computed } from 'vue';
import type { CharacterFrameView } from '@shared/themes/characters';

// One state of a project character, filling its box: a strip clipped to one frame and stepped by d-sprite (motion.css), or an
// image; while it does not move, its first frame. `frame` holds a strip on that frame, still. `hover` moves it only under the
// pointer, over it or its [data-character-host]. `failed` says an image did not load, so the owner can show something else.
const props = defineProps<{
  image: CharacterFrameView;
  alt: string;
  moves: boolean;
  hover?: boolean;
  frame?: number;
}>();
const emit = defineEmits<{ failed: [] }>();

const held = computed(() => props.frame !== undefined && props.image.strip !== undefined);
const stripStyle = computed(() => {
  const strip = props.image.strip;
  if (!strip) return undefined;
  const width = `${strip.frames * 100}%`;
  if (held.value) return { width, transform: `translateX(-${(Math.min(Math.max(0, props.frame!), strip.frames - 1) / strip.frames) * 100}%)` };
  return { width, '--sprite-frames': String(strip.frames), '--sprite-duration': `${strip.frames / strip.fps}s` };
});
const boxStyle = computed(() => {
  const strip = props.image.strip;
  return strip ? { aspectRatio: `${strip.frameWidth} / ${strip.frameHeight}`, [strip.frameWidth >= strip.frameHeight ? 'width' : 'height']: '100%' } : undefined;
});
const stepping = computed(() => props.moves && !held.value);
</script>

<template>
  <span
    v-if="image.strip"
    class="relative block max-h-full max-w-full overflow-hidden"
    :style="boxStyle"
  >
    <img
      :src="image.url"
      :alt="alt"
      draggable="false"
      class="project-character-image absolute inset-y-0 left-0 h-full max-w-none"
      :class="stepping ? 'd-sprite' : ''"
      :data-sprite-hover="stepping && hover ? '' : undefined"
      :data-sprite-frame="held ? frame : undefined"
      :style="stripStyle"
      @error="emit('failed')"
    >
  </span>
  <template v-else-if="moves && hover && image.still">
    <img
      :src="image.still"
      :alt="alt"
      draggable="false"
      class="project-character-image project-character-still size-full object-contain"
      @error="emit('failed')"
    >
    <img
      :src="image.url"
      alt=""
      draggable="false"
      class="project-character-image project-character-moving size-full object-contain"
      @error="emit('failed')"
    >
  </template>
  <img
    v-else
    :src="moves || !image.still ? image.url : image.still"
    :alt="alt"
    draggable="false"
    class="project-character-image size-full object-contain"
    @error="emit('failed')"
  >
</template>
