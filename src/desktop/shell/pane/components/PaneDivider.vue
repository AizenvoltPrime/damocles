<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { cn } from '@/lib/utils';
import { PANE_RESIZE_STEP } from '../../../preload/pane-channels';
import { boundWidth, createWidthRequester } from '../width-request';

const props = defineProps<{
  // CSS px, all three from main's layout
  width: number;
  minWidth: number;
  maxWidth: number;
  controls: string;
}>();
const emit = defineEmits<{ resize: [width: number, commit: boolean] }>();
const { t } = useI18n();

const LARGE_STEP = PANE_RESIZE_STEP * 4;

const requester = createWidthRequester((width, commit) => emit('resize', width, commit));
const dragging = ref(false);
let drag: { pointerId: number; startScreenX: number; startWidth: number; last: number } | undefined;

function bounded(width: number): number | undefined {
  return boundWidth(width, props.minWidth, props.maxWidth);
}

function commitKey(width: number): void {
  const next = bounded(width);
  if (next !== undefined && next !== props.width) requester.commit(next);
}

function onKeydown(event: KeyboardEvent): void {
  const step = event.shiftKey ? LARGE_STEP : PANE_RESIZE_STEP;
  switch (event.key) {
    // The divider sits on the pane's left edge, so moving it left widens the pane.
    case 'ArrowLeft':
      commitKey(props.width + step);
      break;
    case 'ArrowRight':
      commitKey(props.width - step);
      break;
    case 'Home':
      commitKey(props.minWidth);
      break;
    case 'End':
      commitKey(props.maxWidth);
      break;
    default:
      return;
  }
  event.preventDefault();
}

// Screen coordinates: main moves this view while it resizes, so client coordinates shift under the pointer.
function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  drag = { pointerId: event.pointerId, startScreenX: event.screenX, startWidth: props.width, last: props.width };
  dragging.value = true;
  event.preventDefault();
}

function onPointerMove(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const next = bounded(drag.startWidth + drag.startScreenX - event.screenX);
  if (next === undefined) return;
  drag.last = next;
  requester.request(next);
}

function endDrag(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const { startWidth, last } = drag;
  drag = undefined;
  dragging.value = false;
  if (last !== startWidth) requester.commit(last);
  else requester.dispose();
}

onBeforeUnmount(() => requester.dispose());
</script>

<template>
  <div
    role="separator"
    aria-orientation="vertical"
    :aria-label="t('pane.divider')"
    :aria-controls="controls"
    :aria-valuenow="width"
    :aria-valuemin="minWidth"
    :aria-valuemax="maxWidth"
    :aria-valuetext="t('pane.dividerValue', { width })"
    :title="t('pane.dividerHelp')"
    tabindex="0"
    :class="cn(
      'group relative flex h-full shrink-0 cursor-col-resize touch-none select-none justify-center outline-none focus-visible:outline-none',
      dragging && 'bg-ring/40',
    )"
    @keydown="onKeydown"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="endDrag"
    @pointercancel="endDrag"
    @lostpointercapture="endDrag"
  >
    <span
      aria-hidden="true"
      :class="cn(
        'h-full w-px bg-border transition-[width,background-color] duration-150 group-hover:w-0.5 group-hover:bg-ring group-focus-visible:w-full group-focus-visible:bg-ring',
        dragging && 'w-0.5 bg-ring',
      )"
    />
  </div>
</template>
