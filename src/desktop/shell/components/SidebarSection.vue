<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight } from 'lucide-vue-next';
import { MIN_SECTION_SIZE, type SidebarSectionId } from '../../preload/shell-channels';
import { SECTION_HEADER_REM } from '../layout';
import type { DropEdge } from '../layout/section-order';
import { remPx } from '@/composables/useRemPx';
import { ALWAYS_SHOW_SECTION_ACTIONS, SECTION_DRAG_MIME, SECTION_ORDER, SECTION_TITLES } from './sidebar-section';

const props = defineProps<{
  section: SidebarSectionId;
  count?: number | undefined;
  collapsed: boolean;
  // CSS px of the body; absent, the section takes the sidebar's remaining height
  bodySize?: number | undefined;
  // a control shows beside the title; the #chip slot stays passed while its control leaves, so its exit can play
  hasChip?: boolean;
}>();
const emit = defineEmits<{ toggle: [] }>();
const { t } = useI18n();
const title = computed(() => t(SECTION_TITLES[props.section]));

const headingId = useId();
const bodyId = useId();
const root = ref<HTMLElement | null>(null);
const body = ref<HTMLElement | null>(null);
const alwaysShow = inject(ALWAYS_SHOW_SECTION_ACTIONS, ref(false));
const ordering = inject(SECTION_ORDER, null);

const sectionStyle = computed(() => {
  const order = ordering?.orderOf(props.section);
  if (props.collapsed) return { flex: `0 0 ${SECTION_HEADER_REM}rem`, order };
  // MIN_SECTION_SIZE is px at the default font.
  if (props.bodySize === undefined) return { flex: '1 1 0px', minHeight: `${MIN_SECTION_SIZE / 16 + SECTION_HEADER_REM}rem`, order };
  return { flex: `0 0 calc(${props.bodySize}px + ${SECTION_HEADER_REM}rem)`, order };
});

// VS Code's pane drag and drop (`viewPaneContainer.ts`, `ViewPaneDropOverlay`): the header drags the section, and dropping
// it on the upper or lower half of another section puts it above or below that one.
const dragImage = ref<HTMLElement | null>(null);
const dropEdge = ref<DropEdge | null>(null);
const dropShown = computed(() => dropEdge.value !== null && ordering?.dragged.value != null);

function onDragStart(event: DragEvent): void {
  if (!ordering || !event.dataTransfer) return;
  event.dataTransfer.setData(SECTION_DRAG_MIME, props.section);
  event.dataTransfer.effectAllowed = 'move';
  if (dragImage.value) event.dataTransfer.setDragImage(dragImage.value, remPx(0.75), remPx(0.75));
  ordering.dragged.value = props.section;
}

function onDragEnd(): void {
  if (ordering) ordering.dragged.value = null;
}

function acceptsDrop(event: DragEvent): boolean {
  const dragged = ordering?.dragged.value;
  return dragged != null && dragged !== props.section && event.dataTransfer?.types.includes(SECTION_DRAG_MIME) === true;
}

function onDragOver(event: DragEvent): void {
  if (!acceptsDrop(event) || !root.value) return;
  event.preventDefault();
  event.dataTransfer!.dropEffect = 'move';
  const rect = root.value.getBoundingClientRect();
  dropEdge.value = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function onDragLeave(event: DragEvent): void {
  if (!root.value?.contains(event.relatedTarget as Node | null)) dropEdge.value = null;
}

function onDrop(event: DragEvent): void {
  const edge = dropEdge.value;
  dropEdge.value = null;
  const dragged = ordering?.dragged.value;
  if (!acceptsDrop(event) || !edge || !dragged) return;
  event.preventDefault();
  ordering!.dragged.value = null;
  ordering!.drop(dragged, props.section, edge);
}

function openMenuAt(anchor: { x: number; y: number; width: number; height: number }): void {
  if (ordering) void holdActions(ordering.openMenu(props.section, anchor));
}

function onHeaderContextMenu(event: MouseEvent): void {
  if (!ordering) return;
  event.preventDefault();
  openMenuAt({ x: event.clientX, y: event.clientY, width: 0, height: 0 });
}

function onHeaderKeydown(event: KeyboardEvent): void {
  if (!ordering || !(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return;
  event.preventDefault();
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  openMenuAt({ x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height });
}

// VS Code's paneview.css: the title actions take no space at rest and show while the section is expanded and hovered or holds
// focus, or always with the setting. Focus leaving the page (the overlay, a chat view) hides them as it does in VS Code, except
// while a popup one of them opened is up, so a menu's own button never vanishes under it.
const hovered = ref(false);
const focusWithin = ref(false);
const popups = ref(0);
const actionsShown = computed(() => !props.collapsed && (alwaysShow.value || hovered.value || focusWithin.value || popups.value > 0));

function onFocusChange(event: FocusEvent): void {
  focusWithin.value = event.type === 'focusin' || root.value?.contains(event.relatedTarget as Node | null) === true;
}

const withinPage = (): boolean => document.hasFocus() && root.value?.contains(document.activeElement) === true;

function onPointerLeave(): void {
  hovered.value = false;
  // a focused action that unmounted fires no focusout
  focusWithin.value = withinPage();
}

const onWindowFocusChange = (): void => {
  focusWithin.value = withinPage();
};
onMounted(() => {
  window.addEventListener('blur', onWindowFocusChange);
  window.addEventListener('focus', onWindowFocusChange);
});
onBeforeUnmount(() => {
  window.removeEventListener('blur', onWindowFocusChange);
  window.removeEventListener('focus', onWindowFocusChange);
});

// With a chip beside the title, the actions lie over the chip's tail on an opaque ground (the header's own hover tint on top),
// so the chip keeps its width and never jumps as they come and go. They share the chip's grid cell, whose minimum is theirs
// alone, so they never reach over the title: a header too narrow for both shortens the title, as VS Code's pane header does.
// Their ground starts with a 1rem fade, so a chip they cover ends softly rather than cut mid-letter.
const CHIP_ACTIONS = 'relative isolate z-1 justify-self-end self-stretch [grid-area:1/1] bg-[linear-gradient(to_right,transparent,var(--d-panel)_1rem)] ps-5.5 before:pointer-events-none before:absolute before:inset-0 before:-z-1 group-hover/header:before:bg-[linear-gradient(to_right,transparent,var(--d-hover)_1rem)]';
const CHIP_GROUND = 'bg-(--d-panel) before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-full group-hover/header:before:bg-(--d-hover)';
const chipPointer = ref(false);
const chipFocus = ref(false);
const chipRaised = computed(() => chipPointer.value || chipFocus.value);

/** Keeps the title actions shown until `popup` (a menu a title action opened) settles. */
async function holdActions<T>(popup: Promise<T>): Promise<T> {
  popups.value++;
  try {
    return await popup;
  } finally {
    popups.value--;
  }
}

defineExpose({ bodyHeight: (): number => body.value?.getBoundingClientRect().height ?? 0, holdActions });
</script>

<template>
  <!-- overflow-clip, not hidden: a hidden overflow is still a scroll container, which a focused input or its caret
       scrolls when the section is shorter than its content, moving every control in it. -->
  <section
    ref="root"
    :aria-labelledby="headingId"
    class="sidebar-section relative flex min-h-0 flex-col overflow-clip"
    :style="sectionStyle"
    :data-section="section"
    @pointerenter="hovered = true"
    @pointerleave="onPointerLeave"
    @focusin="onFocusChange"
    @focusout="onFocusChange"
    @dragenter="onDragOver"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div
      data-testid="sidebar-section-header"
      class="group/header @container/header relative flex shrink-0 items-center gap-1.5 pr-1.5 pl-2 hover:bg-(--d-hover)"
      :style="{ height: `${SECTION_HEADER_REM}rem` }"
      :draggable="ordering !== null"
      @dragstart="onDragStart"
      @dragend="onDragEnd"
      @contextmenu="onHeaderContextMenu"
    >
      <h2
        :id="headingId"
        class="flex min-w-0 self-stretch"
        :class="hasChip ? '' : 'flex-1'"
      >
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          :aria-expanded="!collapsed"
          :aria-controls="bodyId"
          @click="emit('toggle')"
          @keydown="onHeaderKeydown"
        >
          <ChevronRight
            aria-hidden="true"
            class="size-3.25 shrink-0 text-(--d-faint) transition-transform duration-200"
            :class="collapsed ? '' : 'rotate-90'"
          />
          <!-- One clipped line: a count or badge with no room beside the title wraps out of sight, so the title reads whole first. -->
          <span
            data-testid="sidebar-section-title-line"
            class="flex min-w-0 flex-1 flex-wrap content-start items-center gap-x-1.5 self-stretch overflow-hidden"
          >
            <span
              data-testid="sidebar-section-title"
              class="h-full content-center truncate text-11 font-semibold tracking-[.07em] text-(--d-muted) uppercase"
            >{{ title }}</span>
            <span
              v-if="count !== undefined"
              class="font-mono text-10.5 text-(--d-faint)"
            >{{ count }}</span>
            <slot name="badge" />
          </span>
        </button>
      </h2>
      <!-- A control beside the title (the Files branch chip); the space after it still toggles the section. -->
      <div
        v-if="$slots.chip"
        class="grid grid-cols-[1fr] items-center self-stretch"
        :class="hasChip ? 'flex-1' : 'flex-none'"
        @click.self="emit('toggle')"
      >
        <!-- w-14 min-w-full: the chip fills the cell and adds only 3.5rem to the cell's minimum width (its icon, a letter with
             an ellipsis and its chevron), which a long title gives up first; past that only the actions set the minimum. -->
        <span
          class="flex min-w-0 self-stretch [grid-area:1/1]"
          :class="hasChip ? 'w-14 min-w-full' : ''"
          @click.self="emit('toggle')"
        >
          <!-- While pointed at or focused, the chip rises over the title actions on the same opaque ground, so none covers it. -->
          <span
            data-testid="sidebar-section-chip"
            :data-raised="chipRaised || undefined"
            class="relative isolate flex max-w-full min-w-0 self-center rounded-full"
            :class="chipRaised ? `z-2 ${CHIP_GROUND}` : ''"
            @pointerenter="chipPointer = true"
            @pointerleave="chipPointer = false"
            @focusin="chipFocus = true"
            @focusout="chipFocus = false"
          >
            <slot name="chip" />
          </span>
        </span>
        <div
          v-if="hasChip && $slots.actions"
          v-show="actionsShown"
          data-testid="sidebar-section-actions"
          class="d-actions-in flex items-center gap-1.5"
          :class="CHIP_ACTIONS"
        >
          <slot name="actions" />
        </div>
      </div>
      <!-- display:none at rest takes the buttons out of the tab order; focusing the header button shows them, so Tab reaches them.
           Absent without actions, so revealing an empty bar never takes the header's gap from the title. -->
      <div
        v-if="$slots.actions && !(hasChip && $slots.chip)"
        v-show="actionsShown"
        data-testid="sidebar-section-actions"
        class="d-actions-in flex shrink-0 items-center gap-1.5"
      >
        <slot name="actions" />
      </div>
    </div>
    <!-- Not a Collapsible: the body stays mounted and clipped while collapsed, so the section height can animate; inert hides it from focus and AT. -->
    <div
      :id="bodyId"
      ref="body"
      :inert="collapsed"
      class="flex min-h-0 flex-1 flex-col"
    >
      <slot />
    </div>
    <!-- VS Code's drop overlay: the half the section lands on, with an edge line where a collapsed section is too short to show it. -->
    <div
      v-if="dropShown"
      data-testid="sidebar-section-drop"
      :data-edge="dropEdge"
      aria-hidden="true"
      class="pointer-events-none absolute inset-x-0 z-4 h-1/2 border-(--d-accent) bg-(--d-accent-soft)"
      :class="[dropEdge === 'before' ? 'top-0' : 'bottom-0', collapsed ? (dropEdge === 'before' ? 'border-t-2' : 'border-b-2') : '']"
    />
    <div
      v-if="ordering"
      ref="dragImage"
      aria-hidden="true"
      class="pointer-events-none fixed -top-40 left-0 rounded-7 border border-(--d-accent) bg-(--d-card) px-2 py-1 text-11 font-semibold tracking-[.07em] text-(--d-text) uppercase shadow-(--d-shadow)"
    >
      {{ title }}
    </div>
  </section>
</template>
