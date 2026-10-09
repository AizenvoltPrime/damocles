<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { remPx } from '@/composables/useRemPx';
import { SASH_KEY_STEP_REM } from '../layout';

// A sash: no shadcn part covers a resize handle. `value` is the size of the pane the sash controls, by default the one after
// it (right of a vertical sash, below a horizontal one), so moving the sash towards that pane shrinks it.
// The caller positions and stacks it (relative in a grid area, absolute over a pane edge); a class here would override that.
defineOptions({ name: 'GridSash' });

const props = defineProps<{
  orientation: 'vertical' | 'horizontal';
  label: string;
  value: number;
  min: number;
  max: number;
  // what a screen reader hears for the value; the size in pixels by default
  valueText?: string;
  // 'before': value sizes the pane left of or above the sash, which grows as the sash moves away from it
  pane?: 'before' | 'after';
}>();
const emit = defineEmits<{
  // a pointer drag began; the grid stops animating its tracks until commit
  start: [];
  resize: [size: number];
  commit: [];
}>();
const { t } = useI18n();

const drag = ref<{ pointerId: number; start: number; startValue: number } | null>(null);
const vertical = computed(() => props.orientation === 'vertical');
// 1: the pane `value` sizes grows as the sash moves right or down; -1: it shrinks.
const growth = computed(() => (props.pane === 'before' ? 1 : -1));

const upper = (): number => Math.max(props.min, props.max);
const clamp = (size: number): number => Math.round(Math.min(Math.max(size, props.min), upper()));
const coordinate = (event: PointerEvent): number => (vertical.value ? event.clientX : event.clientY);

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  drag.value = { pointerId: event.pointerId, start: coordinate(event), startValue: props.value };
  emit('start');
}

function onPointerMove(event: PointerEvent): void {
  if (drag.value?.pointerId !== event.pointerId) return;
  emit('resize', clamp(drag.value.startValue + growth.value * (coordinate(event) - drag.value.start)));
}

function onPointerUp(event: PointerEvent): void {
  if (drag.value?.pointerId !== event.pointerId) return;
  drag.value = null;
  emit('commit');
}

function onKeydown(event: KeyboardEvent): void {
  const step = growth.value * remPx(SASH_KEY_STEP_REM);
  const keys: Record<string, number> = vertical.value
    ? { ArrowLeft: props.value - step, ArrowRight: props.value + step }
    : { ArrowUp: props.value - step, ArrowDown: props.value + step };
  const next = { ...keys, Home: props.min, End: upper() }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  emit('resize', clamp(next));
  emit('commit');
}
</script>

<template>
  <div
    role="separator"
    tabindex="0"
    :aria-orientation="orientation"
    :aria-label="label"
    :aria-valuenow="value"
    :aria-valuemin="min"
    :aria-valuemax="upper()"
    :aria-valuetext="valueText ?? t('sidebar.sizeValue', { size: value })"
    :data-active="drag !== null || undefined"
    class="grid-sash group/sash flex touch-none outline-none"
    :class="vertical ? 'cursor-col-resize justify-center' : 'cursor-row-resize items-center'"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @keydown="onKeydown"
  >
    <div
      class="grid-sash-line"
      :class="vertical ? 'h-full w-px' : 'h-px w-full'"
    />
  </div>
</template>
