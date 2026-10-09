<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, provide, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useElementSize } from '@vueuse/core';
import type { DamoclesShellApi, GridPane, GridSlot, ShellGridLayout, ShellGridSizes, ShellState } from '../../preload/shell-channels';
import type { OverlayMenuItem } from '../../preload/overlay-channels';
import { remPx } from '@/composables/useRemPx';
import { atRootFont, GRID_SASH_REM } from '../layout';
import { clampSlotSize, COLUMN_MIN_PX, GRID_SLOTS, gridAreas, gridMinWidth, ROW_MIN_PX, slotMax, slotOf } from './layout-model';
import { GRID_CONTEXT, type GridContext } from './grid-context';
import { reducedMotion } from '../reduced-motion';
import { LAYOUT_SETTLED_EVENT } from '../content-bounds';
import Sash from './Sash.vue';
import PaneGrip from './PaneGrip.vue';
import TerminalPane from './TerminalPane.vue';

// focusOverlay: the editor covers the window, so nothing else in the grid takes focus or pointer input.
const props = defineProps<{ api: DamoclesShellApi; state: ShellState; focusOverlay: boolean }>();
const { t, locale } = useI18n();

// rem the pointer travels on a grip before a press becomes a drag.
const DRAG_THRESHOLD_REM = 0.25;
const ICONS = { main: 'square', side: 'panel-right', bottom: 'panel-bottom' } as const satisfies Record<GridSlot, string>;

const root = ref<HTMLElement | null>(null);
const chatSlot = ref<HTMLElement | null>(null);
const { width: gridWidth, height: gridHeight } = useElementSize(root);

// The grid owns its sash sizes: a sash edits them here and reports them, and main's sizes replace them only when main
// replaced the layout itself, so a state push carrying older sizes never undoes a resize.
const gridSizes = (layout: ShellGridLayout): ShellGridSizes => ({ sideWidth: layout.sideWidth, bottomHeight: layout.bottomHeight });
const sizes = shallowRef<ShellGridSizes>(gridSizes(props.state.layout.grid));
watch(() => props.state.layoutRevision, () => {
  sizes.value = gridSizes(props.state.layout.grid);
});
// A pointer drag: the tracks follow the pointer; a keyboard step glides like any other size change.
const sashDragging = ref(false);
const grid = computed<ShellGridLayout>(() => ({ ...props.state.layout.grid, ...sizes.value }));
const areas = computed(() => gridAreas(grid.value));
const area = (pane: GridPane): GridSlot => slotOf(grid.value, pane);
const shown = (pane: GridPane): boolean => areas.value[area(pane)];

// The px minimums are at the default font, so they follow the root font here; a sash stops where either neighbour reaches its minimum.
const sideMin = computed(() => atRootFont(COLUMN_MIN_PX));
const bottomMin = computed(() => atRootFont(ROW_MIN_PX));
const sashPx = computed(() => remPx(GRID_SASH_REM));
const sideRoom = computed(() => gridWidth.value - sashPx.value);
const bottomRoom = computed(() => gridHeight.value - sashPx.value);
const sideWidth = computed(() => clampSlotSize(grid.value.sideWidth, sideRoom.value, sideMin.value));
const bottomHeight = computed(() => clampSlotSize(grid.value.bottomHeight, bottomRoom.value, bottomMin.value));
const sideMax = computed(() => slotMax(sideRoom.value, sideMin.value, sideWidth.value));
const bottomMax = computed(() => slotMax(bottomRoom.value, bottomMin.value, bottomHeight.value));

// Reference motion (gridTrans): the tracks glide when a pane shows, hides or swaps, and follow the pointer while a sash drags.
const gridStyle = computed(() => {
  const { main, side, bottom } = areas.value;
  const sash = `${GRID_SASH_REM}rem`;
  const columns = main && side ? `minmax(0, 1fr) ${sash} ${sideWidth.value}px` : side && !main ? '0px 0rem minmax(0, 1fr)' : 'minmax(0, 1fr) 0rem 0px';
  const top = main || side;
  const rows = top && bottom ? `minmax(0, 1fr) ${sash} ${bottomHeight.value}px` : bottom ? '0px 0rem minmax(0, 1fr)' : 'minmax(0, 1fr) 0rem 0px';
  return {
    gridTemplateColumns: columns,
    gridTemplateRows: rows,
    gridTemplateAreas: '"main vs side" "hs hs hs" "bottom bottom bottom"',
    minWidth: `${gridMinWidth(areas.value, sideMin.value, sashPx.value)}px`,
    transition: sashDragging.value ? 'none' : 'grid-template-columns .3s var(--ease-out), grid-template-rows .3s var(--ease-out)',
  };
});

function onSashStart(): void {
  sashDragging.value = true;
}

function onSashResize(key: keyof ShellGridSizes, size: number): void {
  sizes.value = { ...sizes.value, [key]: size };
}

function onSashCommit(): void {
  sashDragging.value = false;
  props.api.reportGridSizes(sizes.value);
}

// A pane that changes slot glides from where it was (FLIP, transform only); the chat is a native view main places, so it jumps.
const paneElements = new Map<GridPane, HTMLElement>();
function setPaneElement(pane: GridPane, element: unknown): void {
  if (element instanceof HTMLElement) paneElements.set(pane, element);
  else paneElements.delete(pane);
}

// Once the panes rest in their new slots, the views main lays over them (a browser page) are measured again.
function settleAfter(animations: readonly Animation[]): void {
  void Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))).then(() => {
    window.dispatchEvent(new Event(LAYOUT_SETTLED_EVENT));
  });
}

watch(() => grid.value.slots, (slots, previous) => {
  if (GRID_SLOTS.every((slot) => slots[slot] === previous[slot])) return;
  const glide = !reducedMotion();
  const before = new Map([...paneElements].map(([pane, element]) => [pane, element.getBoundingClientRect()]));
  void nextTick(() => {
    const easing = getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim() || 'ease-out';
    const animations: Animation[] = [];
    for (const [pane, element] of glide ? paneElements : []) {
      const from = before.get(pane);
      const to = element.getBoundingClientRect();
      if (pane === 'chat' || !from || from.width === 0 || to.width === 0 || to.height === 0) continue;
      const transform = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
      animations.push(element.animate([{ transform, transformOrigin: 'top left' }, { transform: 'none', transformOrigin: 'top left' }], { duration: 320, easing }));
    }
    settleAfter(animations);
  });
}, { flush: 'pre' });

// Maximize and restore: the tracks switch at once (an fr track does not interpolate to a length), and the pane glides from
// its old top-left corner to its new one, translate only, so its text never stretches.
watch(() => grid.value.maximized, (maximized, previous) => {
  const pane = maximized ?? previous;
  const element = pane === null || pane === 'chat' ? undefined : paneElements.get(pane);
  if (!element || reducedMotion()) return;
  const from = element.getBoundingClientRect();
  void nextTick(() => {
    const to = element.getBoundingClientRect();
    if (from.height === 0 || to.height === 0) return;
    const easing = getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim() || 'ease-out';
    settleAfter([element.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: 'none' }], { duration: 320, easing })]);
  });
}, { flush: 'pre' });

// "Moved {pane} to {zone}", announced politely after a move the user made here.
const announcement = ref('');
function announceMove(pane: GridPane, slot: GridSlot): void {
  announcement.value = t('grid.moved', { pane: t(`grid.pane.${pane}`), zone: t(`grid.zone.${slot}`).toLocaleLowerCase(locale.value) });
}

async function openMoveMenu(pane: GridPane, anchor: HTMLElement): Promise<void> {
  const rect = anchor.getBoundingClientRect();
  const current = area(pane);
  const items: OverlayMenuItem[] = GRID_SLOTS.map((slot) => ({
    kind: 'item',
    id: slot,
    label: t(`grid.zone.${slot}`),
    icon: ICONS[slot],
    checked: slot === current,
    disabled: slot === current,
  }));
  const answer = await props.api.requestOverlay({
    kind: 'menu',
    label: t('grid.moveMenu', { pane: t(`grid.pane.${pane}`) }),
    anchor: { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height },
    items,
  });
  if (answer.kind !== 'menu') return;
  const slot = GRID_SLOTS.find((candidate) => candidate === answer.itemId);
  if (!slot) return;
  await props.api.layoutMove(pane, slot);
  announceMove(pane, slot);
}

// The pane being dragged. The view that took the press keeps the pointer until release (Chromium routes a pressed drag to the
// pressed view), so the overlay drawing the drop zones never sees it: the shell forwards each move through main. Chromium can
// end the grip's capture as the overlay opens (from a focused terminal), so the moves and the release are read on the window.
const dragging = ref<GridPane | null>(null);
let swallowClick = false;
let release: (() => void) | undefined;

function press(pane: GridPane, event: PointerEvent): void {
  const grip = event.currentTarget as HTMLElement;
  const gridElement = root.value;
  if (!gridElement || dragging.value) return;
  release?.();
  grip.setPointerCapture(event.pointerId);
  const start = { x: event.clientX, y: event.clientY };
  let active = false;
  swallowClick = false;
  const point = (moved: PointerEvent): { x: number; y: number } => ({ x: Math.max(0, moved.clientX), y: Math.max(0, moved.clientY) });

  const begin = (moved: PointerEvent): void => {
    active = true;
    swallowClick = true;
    dragging.value = pane;
    const from = area(pane);
    const rect = gridElement.getBoundingClientRect();
    props.api.requestOverlay({
      kind: 'dropZones',
      pane,
      slots: grid.value.slots,
      grid: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
      pointer: point(moved),
    }).then((answer) => {
      if (answer.kind === 'dropZones' && answer.slot !== null && answer.slot !== from) announceMove(pane, answer.slot);
    }).catch(() => {
      // Main refused the request or reloaded meanwhile; the pane stays where it is.
    }).finally(() => {
      dragging.value = null;
    });
  };
  const onMove = (moved: PointerEvent): void => {
    if (moved.pointerId !== event.pointerId) return;
    if (active) props.api.reportDropZonesPointer({ ...point(moved), released: false });
    else if (Math.hypot(moved.clientX - start.x, moved.clientY - start.y) >= remPx(DRAG_THRESHOLD_REM)) begin(moved);
  };
  const onUp = (ended: PointerEvent): void => {
    if (ended.pointerId !== event.pointerId) return;
    release?.();
    if (active) props.api.reportDropZonesPointer({ ...point(ended), released: true });
  };
  // A press that lost its capture before it became a drag (the pane hidden while the grip is held) ends.
  const onLost = (lost: PointerEvent): void => {
    if (lost.pointerId === event.pointerId && !active) release?.();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  grip.addEventListener('lostpointercapture', onLost);
  release = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    grip.removeEventListener('lostpointercapture', onLost);
    release = undefined;
  };
}

function takeClick(): boolean {
  const take = !swallowClick;
  swallowClick = false;
  return take;
}

const context: GridContext = { dragging, press, takeClick, openMoveMenu };
provide(GRID_CONTEXT, context);
onBeforeUnmount(() => release?.());

defineExpose({ chatSlot, root });
</script>

<template>
  <div
    ref="root"
    data-testid="layout-grid"
    class="layout-grid relative grid min-h-0 flex-1"
    :style="gridStyle"
  >
    <Sash
      v-if="areas.sideSash"
      :inert="focusOverlay"
      orientation="vertical"
      data-testid="sash-side"
      class="relative z-2 [grid-area:vs]"
      :label="t('grid.resizeSide')"
      :value="sideWidth"
      :min="sideMin"
      :max="sideMax"
      @start="onSashStart"
      @resize="onSashResize('sideWidth', $event)"
      @commit="onSashCommit"
    />
    <Sash
      v-if="areas.bottomSash"
      :inert="focusOverlay"
      orientation="horizontal"
      data-testid="sash-bottom"
      class="relative z-2 [grid-area:hs]"
      :label="t('grid.resizeBottom')"
      :value="bottomHeight"
      :min="bottomMin"
      :max="bottomMax"
      @start="onSashStart"
      @resize="onSashResize('bottomHeight', $event)"
      @commit="onSashCommit"
    />

    <div
      v-show="shown('chat')"
      :ref="(element) => setPaneElement('chat', element)"
      data-testid="grid-pane-chat"
      :inert="focusOverlay"
      :data-slot="area('chat')"
      class="flex min-h-0 min-w-0 overflow-hidden bg-(--d-bg)"
      :style="{ gridArea: area('chat') }"
    >
      <!-- The chat view covers its slot, so its grip lives in a gutter beside it; the gutter's top cell continues the chat
           header (h-11.5, panel background, bottom border), so the grip sits where the editor's and terminal's do. -->
      <div class="flex w-4 shrink-0 flex-col">
        <span class="flex h-11.5 shrink-0 items-center justify-center border-b border-(--d-border) bg-(--d-panel)">
          <PaneGrip
            pane="chat"
            class="h-5 w-3"
          />
        </span>
      </div>
      <main
        ref="chatSlot"
        data-testid="chat-slot"
        class="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <slot name="chat" />
      </main>
    </div>

    <Transition name="t-fade">
      <div
        v-show="shown('editor')"
        :ref="(element) => setPaneElement('editor', element)"
        data-testid="grid-pane-editor"
        :data-slot="area('editor')"
        class="grid-pane flex min-h-0 min-w-0 overflow-hidden"
        :class="dragging === 'editor' ? 'grid-pane-dragging' : ''"
        :style="{ gridArea: area('editor') }"
      >
        <slot name="editor" />
      </div>
    </Transition>

    <Transition name="t-fade">
      <div
        v-show="shown('terminal')"
        :ref="(element) => setPaneElement('terminal', element)"
        data-testid="grid-pane-terminal"
        :inert="focusOverlay"
        :data-slot="area('terminal')"
        class="grid-pane flex min-h-0 min-w-0 overflow-hidden"
        :class="dragging === 'terminal' ? 'grid-pane-dragging' : ''"
        :style="{ gridArea: area('terminal') }"
      >
        <TerminalPane
          :api="api"
          :state="state"
          :maximized="grid.maximized === 'terminal'"
          :hide-shortcut="state.shortcuts.toggleTerminal"
          @toggle-maximize="api.toggleMaximize('terminal')"
          @hide="api.toggleTerminal()"
        />
      </div>
    </Transition>

    <p
      class="sr-only"
      role="status"
      aria-live="polite"
    >
      {{ announcement }}
    </p>
  </div>
</template>
