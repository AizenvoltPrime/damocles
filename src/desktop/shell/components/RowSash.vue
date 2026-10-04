<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { MIN_SECTION_SIZE } from '../../preload/shell-channels';
import { ROW_SASH_HEIGHT, ROW_SASH_OVERLAP } from '../layout';

// size is the body height of the section above the sash; the section below takes what it gives up.
const props = defineProps<{
  label: string;
  size: number;
  max: number;
}>();
const emit = defineEmits<{
  // a pointer drag began; the parent stops animating section sizes until commit
  start: [];
  resize: [size: number];
  commit: [];
}>();
const { t } = useI18n();

const KEY_STEP = 10;
const drag = ref<{ pointerId: number; startY: number; startSize: number } | null>(null);

const upper = (): number => Math.max(MIN_SECTION_SIZE, props.max);
const clamp = (size: number): number => Math.round(Math.min(Math.max(size, MIN_SECTION_SIZE), upper()));

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  emit('start');
  drag.value = { pointerId: event.pointerId, startY: event.clientY, startSize: props.size };
}

function onPointerMove(event: PointerEvent): void {
  if (drag.value?.pointerId !== event.pointerId) return;
  emit('resize', clamp(drag.value.startSize + event.clientY - drag.value.startY));
}

function onPointerUp(event: PointerEvent): void {
  if (drag.value?.pointerId !== event.pointerId) return;
  drag.value = null;
  emit('commit');
}

function onKeydown(event: KeyboardEvent): void {
  const next = ({ ArrowUp: props.size - KEY_STEP, ArrowDown: props.size + KEY_STEP, Home: MIN_SECTION_SIZE, End: upper() } as Record<string, number>)[event.key];
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
    aria-orientation="horizontal"
    :aria-label="label"
    :aria-valuenow="size"
    :aria-valuemin="MIN_SECTION_SIZE"
    :aria-valuemax="upper()"
    :aria-valuetext="t('sidebar.sizeValue', { size })"
    data-testid="row-sash"
    class="relative z-[3] flex shrink-0 cursor-row-resize touch-none items-center hover:bg-(--d-accent-soft) focus-visible:bg-(--d-accent-soft)"
    :style="{ height: `${ROW_SASH_HEIGHT}px`, marginBlock: `-${ROW_SASH_OVERLAP}px` }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @keydown="onKeydown"
  >
    <div class="h-px w-full bg-(--d-border)" />
  </div>
</template>
