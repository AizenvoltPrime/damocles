<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { GripVertical, PanelBottom, PanelRight, Square } from 'lucide-vue-next';
import type { DamoclesOverlayApi, OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import type { GridSlot } from '../../../preload/shell-channels';
import { remPx } from '@/composables/useRemPx';
import { dropZoneAt, DROP_ZONES } from '../drop-zones';

type DropZonesRequest = Extract<OverlayRequest, { kind: 'dropZones' }>;

// The pane drop zones over the layout grid. The shell keeps the pointer of the drag (the view that took the press keeps a
// pressed drag), so it forwards each move through main; this page only draws the zones and answers with the one released on.
const props = defineProps<{ api: DamoclesOverlayApi; request: DropZonesRequest }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

const ICONS = { main: Square, side: PanelRight, bottom: PanelBottom } as const;

const pointer = ref({ x: props.request.pointer.x, y: props.request.pointer.y });
const hot = computed<GridSlot | null>(() => dropZoneAt(props.request.grid, pointer.value));
const current = computed(() => (Object.keys(props.request.slots) as GridSlot[]).find((slot) => props.request.slots[slot] === props.request.pane));
const zones = computed(() => DROP_ZONES.map((zone) => ({
  ...zone,
  icon: ICONS[zone.slot],
  label: zone.slot === current.value ? t('grid.zone.current') : t(`grid.zone.${zone.slot}`),
})));

// The ghost sits just below and right of the pointer, clear of the cursor.
const ghostTransform = computed(() => {
  const offset = remPx(0.875);
  return `translate(${pointer.value.x + offset}px, ${pointer.value.y + offset}px)`;
});

let stop: (() => void) | undefined;
onMounted(() => {
  stop = props.api.onDropZonesPointer((next) => {
    pointer.value = { x: next.x, y: next.y };
    if (next.released) emit('answer', { kind: 'dropZones', slot: hot.value });
  });
});
onBeforeUnmount(() => stop?.());
</script>

<template>
  <div
    data-testid="drop-zones"
    class="drop-zones fixed"
    :data-hot="hot ?? undefined"
    :style="{ left: `${request.grid.x}px`, top: `${request.grid.y}px`, width: `${request.grid.width}px`, height: `${request.grid.height}px` }"
  >
    <div
      v-for="(zone, index) in zones"
      :key="zone.slot"
      :data-testid="`drop-zone-${zone.slot}`"
      :data-hot="zone.slot === hot || undefined"
      class="drop-zone absolute p-2"
      :style="{ left: `${zone.left}%`, top: `${zone.top}%`, width: `${zone.width}%`, height: `${zone.height}%`, '--zone-index': index }"
    >
      <div class="drop-zone-box flex size-full items-center justify-center rounded-2xl border-2 border-dashed text-13 font-semibold">
        <!-- A pill under the label keeps it legible over whatever the zone lies on. -->
        <span class="drop-zone-label flex items-center gap-2 rounded-7 bg-[color-mix(in_srgb,var(--d-card)_90%,transparent)] px-2.5 py-1">
          <component
            :is="zone.icon"
            aria-hidden="true"
            class="size-4"
          />
          {{ zone.label }}
        </span>
      </div>
    </div>
    <!-- The ghost: the dragged pane's name rides beside the pointer. -->
    <div
      data-testid="drop-zones-ghost"
      class="drop-zones-ghost pointer-events-none fixed top-0 left-0 flex items-center gap-1.5 rounded-lg border border-(--d-accent) bg-(--d-card) py-1 pr-2.5 pl-1.5 text-12 font-medium text-(--d-text) shadow-(--d-shadow)"
      :style="{ transform: ghostTransform }"
    >
      <GripVertical
        aria-hidden="true"
        class="size-3 text-(--d-accent-text)"
      />
      {{ t(`grid.paneName.${request.pane}`) }}
    </div>
    <p
      class="sr-only"
      role="status"
      aria-live="polite"
    >
      {{ hot ? t('grid.dropOn', { zone: t(`grid.zone.${hot}`) }) : '' }}
    </p>
  </div>
</template>
