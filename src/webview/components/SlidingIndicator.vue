<script setup lang="ts">
import { computed } from 'vue';
import type { IndicatorBox } from '@/composables/useSlidingIndicator';

// `solid`: two fixed caps and a middle scaled on X, so only transform moves and the corners never stretch;
// its currentColor must be opaque, because the pieces overlap by 1px to hide seams.
// `ring`: currentColor border and tinted fill for a vertical list. Fixed top and bottom caps and a middle scaled on Y,
// so rows of different heights animate by transform alone; a width change snaps.
// `soft`: the ring's pieces filled with currentColor and no border; currentColor may be translucent, as those pieces never overlap.
const props = withDefaults(defineProps<{
  box: IndicatorBox | null;
  /** px at the default font, scaled with the root font size like the rem radii it matches; `pill` is half the box height. */
  radius: number | 'pill';
  animate: boolean;
  variant?: 'solid' | 'ring' | 'soft';
}>(), { variant: 'solid' });

// The middle is drawn this many px long, then scaled to its span. Chromium snaps the unscaled box to device pixels,
// so a 1px middle at 150% display scaling paints 2 device px and the scale stretches it a third past the far cap.
const MIDDLE_BASE = 100;

function radiusPx(box: IndicatorBox): number {
  if (props.radius === 'pill') return box.height / 2;
  return (props.radius * Number.parseFloat(getComputedStyle(document.documentElement).fontSize)) / 16;
}

const pieces = computed(() => {
  const box = props.box;
  if (!box) return null;
  const r = Math.min(radiusPx(box), box.width / 2);
  return {
    height: `${box.height}px`,
    cap: `${r}px`,
    start: `translate(${box.x}px, ${box.y}px)`,
    middle: `translate(${box.x + r - 1}px, ${box.y}px) scaleX(${Math.max(0, box.width - 2 * r + 2) / MIDDLE_BASE})`,
    end: `translate(${box.x + box.width - r}px, ${box.y}px)`,
  };
});

// The translucent fill must not overlap, so the middle spans exactly the gap between the caps.
const ring = computed(() => {
  const box = props.box;
  if (!box || props.variant === 'solid') return null;
  const r = Math.min(radiusPx(box), box.height / 2);
  return {
    width: `${box.width}px`,
    cap: `${r}px`,
    top: `translate(${box.x}px, ${box.y}px)`,
    middle: `translate(${box.x}px, ${box.y + r}px) scaleY(${Math.max(0, box.height - 2 * r) / MIDDLE_BASE})`,
    bottom: `translate(${box.x}px, ${box.y + box.height - r}px)`,
  };
});

const pieceClass = computed(() => [
  'absolute left-0 top-0 origin-top-left',
  props.animate ? 'transition-transform duration-300 ease-(--ease-spring)' : '',
]);

const ringFill = computed(() => (props.variant === 'ring'
  ? {
    top: 'border border-b-0 border-current bg-[color-mix(in_srgb,currentColor_12%,transparent)]',
    middle: 'border-x border-current bg-[color-mix(in_srgb,currentColor_12%,transparent)]',
    bottom: 'border border-t-0 border-current bg-[color-mix(in_srgb,currentColor_12%,transparent)]',
  }
  : { top: 'bg-current', middle: 'bg-current', bottom: 'bg-current' }));
</script>

<template>
  <span
    v-if="ring"
    class="pointer-events-none absolute inset-0"
    aria-hidden="true"
    data-testid="sliding-indicator"
  >
    <span
      :class="[pieceClass, ringFill.top]"
      :style="{ width: ring.width, height: ring.cap, borderTopLeftRadius: ring.cap, borderTopRightRadius: ring.cap, transform: ring.top }"
    />
    <span
      :class="[pieceClass, ringFill.middle]"
      :style="{ width: ring.width, height: `${MIDDLE_BASE}px`, transform: ring.middle }"
    />
    <span
      :class="[pieceClass, ringFill.bottom]"
      :style="{ width: ring.width, height: ring.cap, borderBottomLeftRadius: ring.cap, borderBottomRightRadius: ring.cap, transform: ring.bottom }"
    />
  </span>
  <span
    v-else-if="pieces && variant === 'solid'"
    class="pointer-events-none absolute inset-0"
    aria-hidden="true"
    data-testid="sliding-indicator"
  >
    <span
      :class="pieceClass"
      class="bg-current"
      :style="{ width: pieces.cap, height: pieces.height, borderTopLeftRadius: pieces.cap, borderBottomLeftRadius: pieces.cap, transform: pieces.start }"
    />
    <span
      :class="pieceClass"
      class="bg-current"
      :style="{ width: `${MIDDLE_BASE}px`, height: pieces.height, transform: pieces.middle }"
    />
    <span
      :class="pieceClass"
      class="bg-current"
      :style="{ width: pieces.cap, height: pieces.height, borderTopRightRadius: pieces.cap, borderBottomRightRadius: pieces.cap, transform: pieces.end }"
    />
  </span>
</template>
