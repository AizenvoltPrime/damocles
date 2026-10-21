<script setup lang="ts">
import { computed, provide, ref, shallowRef, toRaw, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useElementSize, useWindowSize } from '@vueuse/core';
import { boundGraphChoices, boundRepositoryViewStates, MAX_SEARCH_VIEW_STATES, MIN_SECTION_SIZE, MIN_SIDEBAR_WIDTH, SIDEBAR_SECTIONS, type DamoclesShellApi, type FileRef, type GraphRefChoice, type SearchViewState, type ShellLayout, type ScmViewOptions, type ShellSidebarLayout, type ShellState, type SidebarSectionId } from '../../preload/shell-channels';
import type { OverlayMenuItem } from '../../preload/overlay-channels';
import { remPx } from '@/composables/useRemPx';
import { atRootFont, GRID_SASH_REM, ROW_SASH_OVERLAP_REM, ROW_SASH_REM, SASH_KEY_STEP_REM, SECTION_HEADER_REM } from '../layout';
import ProjectsSection from './ProjectsSection.vue';
import ChatsSection from './ChatsSection.vue';
import FilesSection from './FilesSection.vue';
import SearchSection from '../search/SearchSection.vue';
import ScmSection from '../scm/ScmSection.vue';
import RepositoriesSection from '../scm/RepositoriesSection.vue';
import GraphSection from '../graph/GraphSection.vue';
import { ALWAYS_SHOW_SECTION_ACTIONS, SECTION_ORDER, SECTION_TITLES } from './sidebar-section';
import Sash from '../layout/Sash.vue';
import { COLUMN_MIN_PX, gridAreas, gridMinWidth } from '../layout/layout-model';
import { fitSections, isSizedSection, moveSash, sashRange, SIZED_SECTIONS, yieldTo, type SectionSizes, type SizedSection, type SplitItem } from '../layout/section-sizes';
import { dropSection, sameOrder, shiftSection, type SectionOrder } from '../layout/section-order';

defineOptions({ name: 'ShellSidebar' });

const props = defineProps<{ api: DamoclesShellApi; state: ShellState }>();
const { t } = useI18n();
provide(ALWAYS_SHOW_SECTION_ACTIONS, computed(() => props.state.sidebar.alwaysShowHeaderActions));

// rem: seven section headers plus the six row sashes between them.
const SECTION_CHROME_REM = 7 * SECTION_HEADER_REM + 6 * (ROW_SASH_REM - 2 * ROW_SASH_OVERLAP_REM);

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
  const { sidebarWidth, sections, sectionOrder, search, scm, repositories, graph } = toRaw(state);
  return { sidebarWidth, sections, sectionOrder, search, scm, repositories, graph };
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
// The first open section of Chats, Files, Search, Projects, Repositories, Source control and Graph fills the height the others leave,
// wherever the user put it, and keeps at least a section's minimum; the other open sections keep their sizes, shrinking in
// proportion when the sidebar is too short for them.
const sections = computed(() => layout.value.sections);
const order = computed(() => layout.value.sectionOrder);
const filler = computed(() => (['chats', 'files', 'search', 'projects', 'repos', 'scm', 'graph'] as const).find((name) => !sections.value[name].collapsed));
const sectionRoom = computed(() => sidebarHeight.value - remPx(SECTION_CHROME_REM) - minSection.value);
const fixedSections = computed(() => order.value.filter(isSizedSection).filter((name) => !sections.value[name].collapsed && filler.value !== name));
const sizes = computed(() => {
  const stored = Object.fromEntries(SIZED_SECTIONS.map((name) => [name, sections.value[name].size])) as SectionSizes;
  return fitSections(stored, fixedSections.value, sectionRoom.value, minSection.value);
});
const projectsSize = computed(() => sizes.value.projects);
const filesSize = computed(() => sizes.value.files);
const searchSize = computed(() => sizes.value.search);
const reposSize = computed(() => sizes.value.repos);
const scmSize = computed(() => sizes.value.scm);
const graphSize = computed(() => sizes.value.graph);
// Reference motion: the sidebar slides out by its own width; no transition while the user drags its edge.
const slideStyle = computed(() => ({
  width: `${width.value}px`,
  marginLeft: props.state.layout.sidebarVisible ? '0px' : `-${width.value}px`,
  transition: dragging.value ? 'none' : 'margin-left .28s cubic-bezier(.2, .8, .2, 1)',
}));
// The panes beside the sidebar take every width in between while it slides; a transition its sections run bubbles here too.
const emit = defineEmits<{ slide: [running: boolean] }>();
function onSlide(event: TransitionEvent, running: boolean): void {
  if (event.target === root.value && event.propertyName === 'margin-left') emit('slide', running);
}
const bodySize = (name: SizedSection): number | undefined => (filler.value === name ? undefined : sizes.value[name]);

// The sections keep their DOM order and show in the user's order through CSS `order` (odd values), so a move never detaches a
// section, which would reset its lists' scroll and drop focus; `reading-flow` gives Tab and assistive technology the same order.
const orderOf = (name: SidebarSectionId): number => 2 * order.value.indexOf(name) + 1;
// VS Code's SplitView (`splitview.ts`): every section top to bottom by its body, the filler's being the height the others leave,
// and a sash between each two (an even `order`). A sash moves the height between the sections above and below it, looking past
// collapsed ones, and is disabled when neither side has any to give.
const splitItems = computed((): SplitItem[] => {
  const fixedTotal = fixedSections.value.reduce((sum, name) => sum + sizes.value[name], 0);
  return order.value.map((name) => {
    if (sections.value[name].collapsed) return { size: 0, min: 0, max: 0 };
    const size = isSizedSection(name) && name !== filler.value ? sizes.value[name] : Math.max(minSection.value, sectionRoom.value + minSection.value - fixedTotal);
    return { size, min: minSection.value, max: Number.POSITIVE_INFINITY };
  });
});
const sashes = computed(() => order.value.slice(0, -1).map((above, index) => {
  // px from the top of the first section's body to the sash, as the WAI-ARIA window splitter's value
  const position = Math.round(splitItems.value.slice(0, index + 1).reduce((sum, item) => sum + item.size, 0));
  const range = sashRange(splitItems.value, index);
  const below = order.value[index + 1]!;
  return { index, above, below, position, min: position + range.min, max: position + range.max, disabled: range.min >= 0 && range.max <= 0, order: 2 * index + 2 };
}));
// The sections and sash position when a sash drag started: the drag moves from them, so dragging back restores what it took.
let dragBase: { index: number; items: SplitItem[]; position: number } | undefined;

// "{section} moved to position {position} of {count}", announced politely after a move the user made here.
const announcement = ref('');

function setOrder(next: SectionOrder, message: string): void {
  if (sameOrder(next, order.value)) return;
  layout.value = { ...layout.value, sectionOrder: next };
  report();
  announcement.value = message;
}

function moveSection(name: SidebarSectionId, next: SectionOrder): void {
  setOrder(next, t('sidebar.moved', { section: t(SECTION_TITLES[name]), position: next.indexOf(name) + 1, count: next.length }));
}

async function openSectionMenu(name: SidebarSectionId, anchor: { x: number; y: number; width: number; height: number }): Promise<void> {
  const at = order.value.indexOf(name);
  const items: OverlayMenuItem[] = [
    { kind: 'item', id: 'up', label: t('sidebar.moveUp'), disabled: at === 0 },
    { kind: 'item', id: 'down', label: t('sidebar.moveDown'), disabled: at === order.value.length - 1 },
    { kind: 'separator' },
    { kind: 'item', id: 'reset', label: t('sidebar.resetOrder'), disabled: sameOrder(order.value, SIDEBAR_SECTIONS) },
  ];
  const answer = await props.api.requestOverlay({ kind: 'menu', label: t('sidebar.sectionMenu', { section: t(SECTION_TITLES[name]) }), anchor, items });
  if (answer.kind !== 'menu') return;
  if (answer.itemId === 'up') moveSection(name, shiftSection(order.value, name, -1));
  else if (answer.itemId === 'down') moveSection(name, shiftSection(order.value, name, 1));
  else if (answer.itemId === 'reset') setOrder(SIDEBAR_SECTIONS, t('sidebar.orderReset'));
}

provide(SECTION_ORDER, {
  dragged: ref<SidebarSectionId | null>(null),
  orderOf,
  drop: (moved, target, edge) => moveSection(moved, dropSection(order.value, moved, target, edge)),
  openMenu: openSectionMenu,
});

const selectedProject = computed(() => props.state.projects.find((project) => project.key === props.state.selected.projectKey));
// D31: Files, Search, Source control and Repositories read the folder shown for the selected project, by its root key.
const shownFolder = computed(() => (selectedProject.value ? props.state.shownFolders[selectedProject.value.key] : undefined));
const viewKey = computed(() => shownFolder.value?.rootKey ?? selectedProject.value?.key);

// A collapsed section keeps the size it had, so it reopens at that size even after the sidebar got shorter.
function report(): void {
  const { sections } = layout.value;
  const settled = (name: SizedSection, size: number) => ({ ...sections[name], size: sections[name].collapsed ? sections[name].size : size });
  layout.value = {
    ...layout.value,
    sidebarWidth: width.value,
    sections: {
      ...sections,
      projects: settled('projects', projectsSize.value),
      files: settled('files', filesSize.value),
      search: settled('search', searchSize.value),
      repos: settled('repos', reposSize.value),
      scm: settled('scm', scmSize.value),
      graph: settled('graph', graphSize.value),
    },
  };
  props.api.reportSidebarLayout(layout.value);
}

function toggleSection(name: SizedSection | 'chats'): void {
  const section = layout.value.sections[name];
  const before = sizes.value;
  layout.value = { ...layout.value, sections: { ...layout.value.sections, [name]: { ...section, collapsed: !section.collapsed } } };
  if (name !== 'chats' && section.collapsed) yieldSections(before, name, layout.value.sections[name].size);
  report();
}

// The user expanded `name`: it keeps `size`, and the sizes the others give way to are stored.
function yieldSections(base: SectionSizes, name: SizedSection, size: number): void {
  if (sidebarHeight.value <= 0 || !fixedSections.value.includes(name)) return;
  const next = yieldTo(base, fixedSections.value, sectionRoom.value, minSection.value, name, size);
  const current = layout.value.sections;
  layout.value = {
    ...layout.value,
    sections: { ...current, ...Object.fromEntries(SIZED_SECTIONS.map((each) => [each, { ...current[each], size: next[each] }])) },
  };
}

// The sash below the `index`th section moved to `position`: the open sections other than the filler keep their new sizes, and
// the filler takes what they leave.
function moveRowSash(index: number, position: number): void {
  const base = dragBase?.index === index ? dragBase : { index, items: splitItems.value, position: sashes.value[index]!.position };
  const next = moveSash(base.items, index, position - base.position);
  const current = layout.value.sections;
  const moved = order.value.flatMap((name, at) => (isSizedSection(name) && name !== filler.value && !current[name].collapsed ? [[name, { ...current[name], size: Math.round(next[at]!) }]] : []));
  layout.value = { ...layout.value, sections: { ...current, ...Object.fromEntries(moved) } };
}

function startRowDrag(index: number): void {
  rowDragging.value = true;
  dragBase = { index, items: splitItems.value, position: sashes.value[index]!.position };
}

function endRowDrag(): void {
  rowDragging.value = false;
  dragBase = undefined;
  report();
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

// The Repositories rows the user expanded in a project (AD8), that project now the newest; main takes the report only within
// the bounds boundRepositoryViewStates keeps.
function saveRepositoryRows(projectKey: string, rows: readonly string[]): void {
  const { [projectKey]: _previous, ...others } = layout.value.repositories;
  layout.value = { ...layout.value, repositories: boundRepositoryViewStates({ ...others, [projectKey]: rows }) };
  report();
}

// The Graph's ref choice for a repository (AD8), that repository now the newest; main takes the report only within the bounds
// boundGraphChoices keeps.
function saveGraphChoice(root: string, choice: GraphRefChoice): void {
  const { [root]: _previous, ...others } = layout.value.graph;
  layout.value = { ...layout.value, graph: boundGraphChoices({ ...others, [root]: choice }) };
  report();
}

// Source control's View & Sort, one choice for every project as in VS Code.
function saveScmView(patch: Partial<ScmViewOptions>): void {
  layout.value = { ...layout.value, scm: { ...layout.value.scm, ...patch } };
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
    class="relative flex shrink-0 flex-col overflow-hidden border-r border-(--d-border) bg-(--d-panel) [reading-flow:flex-visual]"
    :class="rowDragging ? '' : 'sidebar-sections-animated'"
    :style="slideStyle"
    @transitionrun="onSlide($event, true)"
    @transitionend="onSlide($event, false)"
    @transitioncancel="onSlide($event, false)"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
  >
    <ProjectsSection
      ref="projects"
      :api="api"
      :projects="state.projects"
      :selected-key="state.selected.projectKey"
      :collapsed="layout.sections.projects.collapsed"
      :body-size="bodySize('projects')"
      @toggle="toggleSection('projects')"
    />
    <!-- Its value is its position, so it grows the sections above it as it moves down. -->
    <Sash
      v-for="sash in sashes"
      :key="sash.index"
      orientation="horizontal"
      pane="before"
      data-testid="section-sash"
      :data-between="`${sash.above} ${sash.below}`"
      class="relative z-3 shrink-0"
      :style="{ height: `${ROW_SASH_REM}rem`, marginBlock: `-${ROW_SASH_OVERLAP_REM}rem`, order: sash.order }"
      :label="t('sidebar.resizeBetween', { above: t(SECTION_TITLES[sash.above]), below: t(SECTION_TITLES[sash.below]) })"
      :value="sash.position"
      :min="sash.min"
      :max="sash.max"
      :disabled="sash.disabled"
      @start="startRowDrag(sash.index)"
      @resize="moveRowSash(sash.index, $event)"
      @commit="endRowDrag()"
    />
    <ChatsSection
      ref="chats"
      :api="api"
      :project-key="state.selected.projectKey"
      :state-revision="state.revision"
      :project-name="selectedProject?.name ?? t('projects.home')"
      :selected-chat-id="state.selected.chatId"
      :new-chat-shortcut="state.shortcuts.newChat"
      :new-chat-in-worktree-shortcut="state.shortcuts.newChatInWorktree"
      :collapsed="layout.sections.chats.collapsed"
      @toggle="toggleSection('chats')"
    />
    <!-- Files lists an open project; the home folder a chat may run in is no project, so it shows the open-a-project hint. -->
    <FilesSection
      ref="files"
      :api="api"
      :project-key="viewKey"
      :shown="shownFolder"
      :new-chat-in-worktree-shortcut="state.shortcuts.newChatInWorktree"
      :project-name="selectedProject?.name ?? t('projects.home')"
      :platform="state.platform"
      :collapsed="layout.sections.files.collapsed"
      :body-size="bodySize('files')"
      @toggle="toggleSection('files')"
      @expand="expand('files')"
    />
    <!-- In SIDEBAR_SECTIONS' order, so the default layout's DOM order is its visual order. -->
    <ScmSection
      :api="api"
      :project-key="viewKey"
      :shown="shownFolder"
      :new-chat-in-worktree-shortcut="state.shortcuts.newChatInWorktree"
      :project-name="selectedProject?.name ?? t('projects.home')"
      :platform="state.platform"
      :view-mode="layout.scm.viewMode"
      :sort-key="layout.scm.sortKey"
      :collapsed="layout.sections.scm.collapsed"
      :body-size="bodySize('scm')"
      @toggle="toggleSection('scm')"
      @expand="expand('scm')"
      @view-options="saveScmView"
    />
    <GraphSection
      :api="api"
      :project-key="viewKey"
      :choices="layout.graph"
      :collapsed="layout.sections.graph.collapsed"
      :body-size="bodySize('graph')"
      @toggle="toggleSection('graph')"
      @choice="saveGraphChoice"
    />
    <RepositoriesSection
      :api="api"
      :project-key="viewKey"
      :platform="state.platform"
      :expanded="selectedProject ? layout.repositories[selectedProject.key] : undefined"
      :collapsed="layout.sections.repos.collapsed"
      :body-size="bodySize('repos')"
      @toggle="toggleSection('repos')"
      @expanded="selectedProject && saveRepositoryRows(selectedProject.key, $event)"
    />
    <SearchSection
      :api="api"
      :project-key="viewKey"
      :project-name="selectedProject?.name ?? t('projects.home')"
      :platform="state.platform"
      :saved="selectedProject ? layout.search[selectedProject.key] : undefined"
      :settings="state.search"
      :shortcuts="state.shortcuts"
      :collapsed="layout.sections.search.collapsed"
      :body-size="bodySize('search')"
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
    <p
      data-testid="sidebar-announcement"
      class="sr-only"
      role="status"
      aria-live="polite"
    >
      {{ announcement }}
    </p>
  </nav>
</template>
