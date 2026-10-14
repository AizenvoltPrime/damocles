<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { remPx } from '@/composables/useRemPx';
import { SASH_KEY_STEP_REM } from '../layout';

// A sash: no shadcn part covers a resize handle. `value` is the size of the pane the sash controls, by default the one after
// it (right of a vertical sash, below a horizontal one), so moving the sash towards that pane shrinks it. It may be the
// sash's position instead, which reads as pixels too unless `valueText` says otherwise.
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
  // VS Code's SashState.Disabled: nothing on either side can give or take, so it takes no pointer or focus and has no value
  disabled?: boolean;
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
  if (event.button !== 0 || props.disabled) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  drag.value = { pointerId: event.pointerId, start: coordinate(event), startValue: props.value };
  emit('start');
}

function onPointerMove(event: PointerEvent): void {
  if (drag.value?.pointerId !== event.pointerId) return;
  emit('resize', clamp(drag.value.startValue + growth.value * (coordinate(event) - drag.value.start)));
}

// The release point is the drag's last position: the pointermove that reached it may not have been delivered first.
function onPointerUp(event: PointerEvent): void {
  if (drag.value?.pointerId !== event.pointerId) return;
  onPointerMove(event);
  endDrag();
}

// A cancel carries no release point, so the drag ends at its last moved size.
function onPointerCancel(event: PointerEvent): void {
  if (drag.value?.pointerId !== event.pointerId) return;
  endDrag();
}

function endDrag(): void {
  drag.value = null;
  emit('commit');
}

function onKeydown(event: KeyboardEvent): void {
  if (props.disabled) return;
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
    :tabindex="disabled ? undefined : 0"
    :aria-orientation="orientation"
    :aria-label="label"
    :aria-valuenow="disabled ? undefined : value"
    :aria-valuemin="disabled ? undefined : min"
    :aria-valuemax="disabled ? undefined : upper()"
    :aria-valuetext="disabled ? undefined : (valueText ?? t('sidebar.sizeValue', { size: value }))"
    :data-active="drag !== null || undefined"
    :data-disabled="disabled || undefined"
    class="grid-sash group/sash flex touch-none outline-none"
    :class="[vertical ? 'cursor-col-resize justify-center' : 'cursor-row-resize items-center', disabled ? 'pointer-events-none' : '']"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @keydown="onKeydown"
  >
    <div
      class="grid-sash-line"
      :class="vertical ? 'h-full w-px' : 'h-px w-full'"
    />
  </div>
</template>
