<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useElementSize, useWindowSize } from '@vueuse/core';
import { MIN_SECTION_SIZE, MIN_SIDEBAR_WIDTH, type DamoclesShellApi, type ShellLayout, type ShellState } from '../../preload/shell-channels';
import { MIN_MAIN_SLOT_WIDTH, ROW_SASH_HEIGHT, ROW_SASH_OVERLAP, SECTION_HEADER_HEIGHT } from '../layout';
import ProjectsSection from './ProjectsSection.vue';
import ChatsSection from './ChatsSection.vue';
import RowSash from './RowSash.vue';

defineOptions({ name: 'ShellSidebar' });

const props = defineProps<{ api: DamoclesShellApi; state: ShellState }>();
const { t } = useI18n();

// CSS px: two section headers plus the row sash between them.
const SECTION_CHROME = 2 * SECTION_HEADER_HEIGHT + ROW_SASH_HEIGHT - 2 * ROW_SASH_OVERLAP;
const KEY_STEP = 10;

const root = ref<HTMLElement | null>(null);
const projects = ref<InstanceType<typeof ProjectsSection> | null>(null);
const chats = ref<InstanceType<typeof ChatsSection> | null>(null);
const { width: windowWidth } = useWindowSize();
const { height: sidebarHeight } = useElementSize(root);

// Main's layout, edited locally while the user drags and reported when the gesture ends.
const layout = ref<ShellLayout>(props.state.layout);
const dragging = ref<{ pointerId: number; startX: number; startWidth: number } | null>(null);
const rowDragging = ref(false);
// Every state push carries a new layout object, so only a layout main changed replaces the local one, never mid-drag.
watch(() => props.state.layout, (next, previous) => {
  if (dragging.value || rowDragging.value || JSON.stringify(next) === JSON.stringify(previous)) return;
  layout.value = next;
});

const maxWidth = computed(() => Math.max(MIN_SIDEBAR_WIDTH, windowWidth.value - MIN_MAIN_SLOT_WIDTH));
const width = computed(() => Math.min(Math.max(layout.value.sidebarWidth, MIN_SIDEBAR_WIDTH), maxWidth.value));
const maxProjectsSize = computed(() => Math.max(MIN_SECTION_SIZE, sidebarHeight.value - SECTION_CHROME - MIN_SECTION_SIZE));
const projectsSize = computed(() => Math.min(Math.max(layout.value.sections.projects.size, MIN_SECTION_SIZE), maxProjectsSize.value));
// Reference motion: the sidebar slides out by its own width; no transition while the user drags its edge.
const slideStyle = computed(() => ({
  width: `${width.value}px`,
  marginLeft: props.state.layout.sidebarVisible ? '0px' : `-${width.value}px`,
  transition: dragging.value ? 'none' : 'margin-left .28s cubic-bezier(.2, .8, .2, 1)',
}));
const bothOpen = computed(() => !layout.value.sections.projects.collapsed && !layout.value.sections.chats.collapsed);

const selectedProject = computed(() => props.state.projects.find((project) => project.key === props.state.selected.projectKey));

function report(): void {
  const { sections } = layout.value;
  layout.value = {
    ...layout.value,
    sidebarWidth: width.value,
    sections: { ...sections, projects: { ...sections.projects, size: projectsSize.value } },
  };
  props.api.reportLayout(layout.value);
}

function toggleSection(name: 'projects' | 'chats'): void {
  const section = layout.value.sections[name];
  layout.value = { ...layout.value, sections: { ...layout.value.sections, [name]: { ...section, collapsed: !section.collapsed } } };
  report();
}

function resizeProjects(size: number): void {
  layout.value = { ...layout.value, sections: { ...layout.value.sections, projects: { ...layout.value.sections.projects, size } } };
}

function setWidth(next: number): void {
  layout.value = { ...layout.value, sidebarWidth: Math.round(Math.min(Math.max(next, MIN_SIDEBAR_WIDTH), maxWidth.value)) };
}

function onSashDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  dragging.value = { pointerId: event.pointerId, startX: event.clientX, startWidth: width.value };
}

function onSashMove(event: PointerEvent): void {
  if (dragging.value?.pointerId !== event.pointerId) return;
  setWidth(dragging.value.startWidth + event.clientX - dragging.value.startX);
}

function onSashUp(event: PointerEvent): void {
  if (dragging.value?.pointerId !== event.pointerId) return;
  dragging.value = null;
  report();
}

function onSashKeydown(event: KeyboardEvent): void {
  const next = ({ ArrowLeft: width.value - KEY_STEP, ArrowRight: width.value + KEY_STEP, Home: MIN_SIDEBAR_WIDTH, End: maxWidth.value } as Record<string, number>)[event.key];
  if (next === undefined) return;
  event.preventDefault();
  setWidth(next);
  report();
}

// F6 parts: focus anywhere in the sidebar is the sidebar part; leaving it (to the title bar or a chat view) is none.
function onFocusIn(): void {
  props.api.reportFocusedPart('sidebar');
}

function onFocusOut(event: FocusEvent): void {
  if (event.relatedTarget instanceof Node && root.value?.contains(event.relatedTarget)) return;
  props.api.reportFocusedPart(null);
}

defineExpose({
  // F6 lands on the current row: the selected chat, or the selected project when the chats list cannot take focus.
  focusCurrentRow: (): void => {
    if (chats.value?.focus()) return;
    if (projects.value?.focus()) return;
    root.value?.querySelector<HTMLElement>('button')?.focus();
  },
});
</script>

<template>
  <nav
    ref="root"
    data-testid="sidebar"
    :aria-label="t('sidebar.label')"
    :inert="!state.layout.sidebarVisible"
    class="relative flex shrink-0 flex-col overflow-hidden border-r border-(--d-border) bg-(--d-panel)"
    :class="rowDragging ? '' : 'sidebar-sections-animated'"
    :style="slideStyle"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
  >
    <ProjectsSection
      ref="projects"
      :api="api"
      :projects="state.projects"
      :selected-key="state.selected.projectKey"
      :collapsed="layout.sections.projects.collapsed"
      :size="layout.sections.chats.collapsed ? undefined : projectsSize"
      @toggle="toggleSection('projects')"
    />
    <RowSash
      v-if="bothOpen"
      :label="t('sidebar.resizeSections')"
      :size="projectsSize"
      :max="maxProjectsSize"
      @start="rowDragging = true"
      @resize="resizeProjects"
      @commit="rowDragging = false; report()"
    />
    <ChatsSection
      ref="chats"
      :api="api"
      :project-key="state.selected.projectKey"
      :project-name="selectedProject?.name ?? t('projects.home')"
      :selected-chat-id="state.selected.chatId"
      :new-chat-shortcut="state.shortcuts.newChat"
      :collapsed="layout.sections.chats.collapsed"
      @toggle="toggleSection('chats')"
    />
    <div
      role="separator"
      tabindex="0"
      aria-orientation="vertical"
      data-testid="sidebar-sash"
      :aria-label="t('sidebar.resize')"
      :aria-valuenow="width"
      :aria-valuemin="MIN_SIDEBAR_WIDTH"
      :aria-valuemax="maxWidth"
      :aria-valuetext="t('sidebar.sizeValue', { size: width })"
      class="absolute top-0 right-0 bottom-0 z-[5] w-[5px] cursor-col-resize touch-none hover:bg-(--d-accent-soft) focus-visible:bg-(--d-accent-soft)"
      @pointerdown="onSashDown"
      @pointermove="onSashMove"
      @pointerup="onSashUp"
      @pointercancel="onSashUp"
      @keydown="onSashKeydown"
    />
  </nav>
</template>
