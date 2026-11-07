<script setup lang="ts">
import type { OverflowStrip } from '@/composables/useOverflowStrip';

// The overlay slider of a useOverflowStrip strip, placed in the strip's relative wrapper; no shadcn part draws an overlay
// scrollbar. Hidden from AT: the strip itself is the keyboard's way to scroll.
defineProps<{ strip: OverflowStrip }>();
</script>

<template>
  <div
    v-if="strip.slider.value"
    aria-hidden="true"
    class="d-overflow-scrollbar pointer-events-none absolute inset-x-0 bottom-0 h-0.75"
    :class="strip.sliderShown.value ? 'd-overflow-scrollbar-shown' : ''"
  >
    <div
      class="d-overflow-slider pointer-events-auto absolute top-0 left-0 h-full"
      :data-active="strip.dragging.value || undefined"
      :style="{ width: `${strip.slider.value.width}px`, transform: `translateX(${strip.slider.value.left}px)` }"
      @pointerdown="strip.onSliderDown"
      @pointermove="strip.onSliderMove"
      @pointerup="strip.onSliderUp"
      @pointercancel="strip.onSliderUp"
      @lostpointercapture="strip.onSliderUp"
    />
  </div>
</template>
