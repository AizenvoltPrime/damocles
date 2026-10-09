<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { GripVertical } from 'lucide-vue-next';
import type { GridPane } from '../../preload/shell-channels';
import { GRID_CONTEXT } from './grid-context';

const props = defineProps<{ pane: GridPane }>();
const { t } = useI18n();
const grid = inject(GRID_CONTEXT);
if (!grid) throw new Error('PaneGrip renders only inside LayoutGrid');

const button = ref<HTMLButtonElement | null>(null);
const dragging = computed(() => grid.dragging.value === props.pane);

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  grid!.press(props.pane, event);
}

// A click (or Enter or Space) opens the "Move to" menu, the keyboard path to the same move; a drag swallows its click.
function onClick(): void {
  if (!grid!.takeClick() || !button.value) return;
  void grid!.openMoveMenu(props.pane, button.value);
}
</script>

<template>
  <!-- A plain button: it is both a drag handle and a menu button, which no shadcn part combines. -->
  <button
    ref="button"
    type="button"
    :data-testid="`pane-grip-${pane}`"
    class="pane-grip flex shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-(--d-faint) transition-colors duration-150 hover:bg-(--d-hover) hover:text-(--d-text) active:cursor-grabbing"
    :class="dragging ? 'bg-(--d-accent-soft) text-(--d-accent-text)' : ''"
    :aria-label="t(`grid.move.${pane}`)"
    :title="t(`grid.drag.${pane}`)"
    aria-haspopup="menu"
    @pointerdown="onPointerDown"
    @click="onClick"
  >
    <GripVertical
      aria-hidden="true"
      class="size-3"
    />
  </button>
</template>
