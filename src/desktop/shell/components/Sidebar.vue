<script setup lang="ts">
import { computed, ref, shallowRef, toRaw, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useElementSize, useWindowSize } from '@vueuse/core';
import { MAX_SEARCH_VIEW_STATES, MIN_SECTION_SIZE, MIN_SIDEBAR_WIDTH, type DamoclesShellApi, type FileRef, type SearchViewState, type ShellLayout, type ShellSidebarLayout, type ShellState } from '../../preload/shell-channels';
import { remPx } from '@/composables/useRemPx';
import { atRootFont, GRID_SASH_REM, ROW_SASH_OVERLAP_REM, ROW_SASH_REM, SASH_KEY_STEP_REM, SECTION_HEADER_REM } from '../layout';
import ProjectsSection from './ProjectsSection.vue';
import ChatsSection from './ChatsSection.vue';
import FilesSection from './FilesSection.vue';
import SearchSection from '../search/SearchSection.vue';
import Sash from '../layout/Sash.vue';
import { COLUMN_MIN_PX, gridAreas, gridMinWidth } from '../layout/layout-model';

defineOptions({ name: 'ShellSidebar' });

const props = defineProps<{ api: DamoclesShellApi; state: ShellState }>();
const { t } = useI18n();

// rem: four section headers plus the three row sashes between them.
const SECTION_CHROME_REM = 4 * SECTION_HEADER_REM + 3 * (ROW_SASH_REM - 2 * ROW_SASH_OVERLAP_REM);

type SizedSection = 'projects' | 'files' | 'search';

const root = ref<HTMLElement | null>(null);
const projects = ref<InstanceType<typeof ProjectsSection> | null>(null);
const chats = ref<InstanceType<typeof ChatsSection> | null>(null);
const files = ref<InstanceType<typeof FilesSection> | null>(null);
const { width: windowWidth } = useWindowSize();
const { height: sidebarHeight } = useElementSize(root);

// The sidebar owns its width, section sizes and Search states: it edits them here and reports them, and main's replace them
// only when main replaced the layout itself, so a state push carrying older ones never undoes a change.
// Shallow and raw: every change replaces the whole object, and the context bridge cannot clone a Vue proxy.
const sidebarPart = (state: ShellLayout): ShellSidebarLayout => {
  const { sidebarWidth, sections, search } = toRaw(state);
  return { sidebarWidth, sections, search };
};
const layout = shallowRef<ShellSidebarLayout>(sidebarPart(props.state.layout));
watch(() => props.state.layoutRevision, () => {
  layout.value = sidebarPart(props.state.layout);
});
const dragging = ref<{ pointerId: number; startX: number; startWidth: number } | null>(null);
const rowDragging = ref(false);

// The layout main stores is px; its minimums are px at the default font, so they follow the root font here.
const minWidth = computed(() => atRootFont(MIN_SIDEBAR_WIDTH));
const minSection = computed(() => atRootFont(MIN_SECTION_SIZE));
const gridMin = computed(() => gridMinWidth(gridAreas(props.state.layout.grid), atRootFont(COLUMN_MIN_PX), remPx(GRID_SASH_REM)));
const maxWidth = computed(() => Math.max(minWidth.value, windowWidth.value - gridMin.value));
const width = computed(() => Math.min(Math.max(layout.value.sidebarWidth, minWidth.value), maxWidth.value));
// The first open section of Chats, Files, Search and Projects fills the height the others leave and keeps at least a
// section's minimum; the other open sections keep their sizes.
const sections = computed(() => layout.value.sections);
const filler = computed(() => (['chats', 'files', 'search', 'projects'] as const).find((name) => !sections.value[name].collapsed));
const sectionRoom = computed(() => sidebarHeight.value - remPx(SECTION_CHROME_REM) - minSection.value);
const fixedSize = (name: SizedSection, size: number): number => (sections.value[name].collapsed || filler.value === name ? 0 : size);
const clampSize = (size: number, max: number): number => Math.min(Math.max(size, minSection.value), max);
const maxProjectsSize = computed(() => Math.max(minSection.value, sectionRoom.value - fixedSize('files', sections.value.files.size) - fixedSize('search', sections.value.search.size)));
const projectsSize = computed(() => clampSize(sections.value.projects.size, maxProjectsSize.value));
const maxFilesSize = computed(() => Math.max(minSection.value, sectionRoom.value - fixedSize('projects', projectsSize.value) - fixedSize('search', sections.value.search.size)));
const filesSize = computed(() => clampSize(sections.value.files.size, maxFilesSize.value));
const maxSearchSize = computed(() => Math.max(minSection.value, sectionRoom.value - fixedSize('projects', projectsSize.value) - fixedSize('files', filesSize.value)));
const searchSize = computed(() => clampSize(sections.value.search.size, maxSearchSize.value));
// Reference motion: the sidebar slides out by its own width; no transition while the user drags its edge.
const slideStyle = computed(() => ({
  width: `${width.value}px`,
  marginLeft: props.state.layout.sidebarVisible ? '0px' : `-${width.value}px`,
  transition: dragging.value ? 'none' : 'margin-left .28s cubic-bezier(.2, .8, .2, 1)',
}));
const projectsBody = computed(() => (filler.value === 'projects' ? undefined : projectsSize.value));
const filesBody = computed(() => (filler.value === 'files' ? undefined : filesSize.value));
const searchBody = computed(() => (filler.value === 'search' ? undefined : searchSize.value));
// A sash sits on the side of a sized section that faces the filler: below Projects, above Files and Search.
const projectsSashShown = computed(() => !sections.value.projects.collapsed && filler.value !== undefined && filler.value !== 'projects');
const filesSashShown = computed(() => !sections.value.files.collapsed && filler.value !== 'files');
const searchSashShown = computed(() => !sections.value.search.collapsed && filler.value !== 'search');

const selectedProject = computed(() => props.state.projects.find((project) => project.key === props.state.selected.projectKey));

// A collapsed section keeps the size it had, so it reopens at that size even after the sidebar got shorter.
function report(): void {
  const { sections } = layout.value;
  const settled = (name: SizedSection, size: number) => ({ ...sections[name], size: sections[name].collapsed ? sections[name].size : size });
  layout.value = {
    ...layout.value,
    sidebarWidth: width.value,
    sections: { ...sections, projects: settled('projects', projectsSize.value), files: settled('files', filesSize.value), search: settled('search', searchSize.value) },
  };
  props.api.reportSidebarLayout(layout.value);
}

function toggleSection(name: SizedSection | 'chats'): void {
  const section = layout.value.sections[name];
  layout.value = { ...layout.value, sections: { ...layout.value.sections, [name]: { ...section, collapsed: !section.collapsed } } };
  report();
}

function resizeSection(name: SizedSection, size: number): void {
  layout.value = { ...layout.value, sections: { ...layout.value.sections, [name]: { ...layout.value.sections[name], size } } };
}

function expand(name: SizedSection): void {
  if (layout.value.sections[name].collapsed) toggleSection(name);
}

// The project's Search query and toggles; the most recently saved projects stay within MAX_SEARCH_VIEW_STATES.
function saveSearchView(projectKey: string, state: SearchViewState): void {
  const { [projectKey]: _previous, ...others } = layout.value.search;
  const kept = Object.entries(others).slice(-(MAX_SEARCH_VIEW_STATES - 1));
  layout.value = { ...layout.value, search: { ...Object.fromEntries(kept), [projectKey]: state } };
  report();
}

function setWidth(next: number): void {
  layout.value = { ...layout.value, sidebarWidth: Math.round(Math.min(Math.max(next, minWidth.value), maxWidth.value)) };
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
  const step = remPx(SASH_KEY_STEP_REM);
  const next = ({ ArrowLeft: width.value - step, ArrowRight: width.value + step, Home: minWidth.value, End: maxWidth.value } as Record<string, number>)[event.key];
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
  // Reveal in Files: the editor tab's file, selected and scrolled into view in the tree.
  revealFile: (file: FileRef): Promise<void> | undefined => files.value?.reveal(file),
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
      :body-size="projectsBody"
      @toggle="toggleSection('projects')"
    />
    <!-- Projects sits above the section that fills the sidebar, so its sash grows it downwards. -->
    <Sash
      v-if="projectsSashShown"
      orientation="horizontal"
      pane="before"
      data-testid="projects-sash"
      class="relative z-3 shrink-0"
      :style="{ height: `${ROW_SASH_REM}rem`, marginBlock: `-${ROW_SASH_OVERLAP_REM}rem` }"
      :label="t('sidebar.resizeSections')"
      :value="projectsSize"
      :min="minSection"
      :max="maxProjectsSize"
      @start="rowDragging = true"
      @resize="resizeSection('projects', $event)"
      @commit="rowDragging = false; report()"
    />
    <ChatsSection
      ref="chats"
      :api="api"
      :project-key="state.selected.projectKey"
      :state-revision="state.revision"
      :project-name="selectedProject?.name ?? t('projects.home')"
      :selected-chat-id="state.selected.chatId"
      :new-chat-shortcut="state.shortcuts.newChat"
      :collapsed="layout.sections.chats.collapsed"
      @toggle="toggleSection('chats')"
    />
    <!-- Files sits below Chats, so its sash grows it upwards, as the grid's bottom sash does. -->
    <Sash
      v-if="filesSashShown"
      orientation="horizontal"
      data-testid="files-sash"
      class="relative z-3 shrink-0"
      :style="{ height: `${ROW_SASH_REM}rem`, marginBlock: `-${ROW_SASH_OVERLAP_REM}rem` }"
      :label="t('sidebar.resizeFiles')"
      :value="filesSize"
      :min="minSection"
      :max="maxFilesSize"
      @start="rowDragging = true"
      @resize="resizeSection('files', $event)"
      @commit="rowDragging = false; report()"
    />
    <!-- Files lists an open project; the home folder a chat may run in is no project, so it shows the open-a-project hint. -->
    <FilesSection
      ref="files"
      :api="api"
      :project-key="selectedProject?.key"
      :project-name="selectedProject?.name ?? t('projects.home')"
      :platform="state.platform"
      :collapsed="layout.sections.files.collapsed"
      :body-size="filesBody"
      @toggle="toggleSection('files')"
      @expand="expand('files')"
    />
    <Sash
      v-if="searchSashShown"
      orientation="horizontal"
      data-testid="search-sash"
      class="relative z-3 shrink-0"
      :style="{ height: `${ROW_SASH_REM}rem`, marginBlock: `-${ROW_SASH_OVERLAP_REM}rem` }"
      :label="t('sidebar.resizeSearch')"
      :value="searchSize"
      :min="minSection"
      :max="maxSearchSize"
      @start="rowDragging = true"
      @resize="resizeSection('search', $event)"
      @commit="rowDragging = false; report()"
    />
    <SearchSection
      :api="api"
      :project-key="selectedProject?.key"
      :project-name="selectedProject?.name ?? t('projects.home')"
      :platform="state.platform"
      :saved="selectedProject ? layout.search[selectedProject.key] : undefined"
      :settings="state.search"
      :shortcuts="state.shortcuts"
      :collapsed="layout.sections.search.collapsed"
      :body-size="searchBody"
      @toggle="toggleSection('search')"
      @expand="expand('search')"
      @view-state="selectedProject && saveSearchView(selectedProject.key, $event)"
      @reveal-in-files="files?.reveal($event)"
    />
    <!-- A sash: no shadcn part covers a resize handle. -->
    <div
      role="separator"
      tabindex="0"
      aria-orientation="vertical"
      data-testid="sidebar-sash"
      :aria-label="t('sidebar.resize')"
      :aria-valuenow="width"
      :aria-valuemin="minWidth"
      :aria-valuemax="maxWidth"
      :aria-valuetext="t('sidebar.sizeValue', { size: width })"
      class="absolute inset-y-0 right-0 z-5 w-1.25 cursor-col-resize touch-none hover:bg-(--d-accent-soft) focus-visible:bg-(--d-accent-soft)"
      @pointerdown="onSashDown"
      @pointermove="onSashMove"
      @pointerup="onSashUp"
      @pointercancel="onSashUp"
      @keydown="onSashKeydown"
    />
  </nav>
</template>
