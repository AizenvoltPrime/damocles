<script setup lang="ts">
import { computed } from 'vue';
import { arrowPath, penPath, shapeBox } from './markup';
import type { StrokeDraft } from './markup-session';
import { BOX_RADIUS_PX, STROKE_CLASS, STROKE_PX, WING_PX } from './markup-style';

// One committed stroke of MarkupLayer's SVG. A mark is immutable, so the stroke renders again only when the mark, the scale or
// its draw-in changes, never on the layer's per-frame renders while a stroke is drawn or a pin dragged.
const props = defineProps<{ mark: StrokeDraft; scale: number; drawIn: Record<string, string> | undefined }>();

const animates = computed(() => props.drawIn?.['--len'] === '1');
const box = computed(() => {
  const [x, y, width, height] = shapeBox(props.mark.points);
  return { x, y, width, height };
});
const d = computed(() => (props.mark.type === 'pen'
  ? penPath(props.mark.points)
  : arrowPath(props.mark.points[0]!, props.mark.points[1]!, WING_PX / props.scale)));
</script>

<template>
  <rect
    v-if="mark.type === 'box'"
    v-bind="box"
    :rx="BOX_RADIUS_PX / scale"
    pathLength="1"
    data-testid="design-markup-stroke"
    data-type="box"
    :class="[STROKE_CLASS, 'fill-[color-mix(in_srgb,var(--d-design)_8%,transparent)]', animates && 'd-draw']"
    :style="drawIn"
    :stroke-width="STROKE_PX / scale"
  />
  <path
    v-else
    :d="d"
    :pathLength="animates ? 1 : undefined"
    data-testid="design-markup-stroke"
    :data-type="mark.type"
    :class="[STROKE_CLASS, animates && 'd-draw']"
    :style="drawIn"
    :stroke-width="STROKE_PX / scale"
  />
</template>
