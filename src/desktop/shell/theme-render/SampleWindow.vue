<script setup lang="ts">
import { computed, provide, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useElementSize } from '@vueuse/core';
import { characterState } from '@shared/themes/characters';
import type { RenderAppearance } from '@shared/themes/agent';
import { MIN_SECTION_SIZE, SIDEBAR_SECTIONS, type GridPane, type ShellGridLayout, type SidebarSectionId } from '../../preload/shell-channels';
import { remPx } from '@/composables/useRemPx';
import { atRootScale, GRID_SASH_REM, SIDEBAR_SECTION_CHROME_REM, storedMinimum } from '../layout';
import { COLUMN_MIN_PX, gridAreas, gridTemplate, ROW_MIN_PX, slotOf, slotSizes } from '../layout/layout-model';
import { fillerSection, fitSections, isSizedSection, SIZED_SECTIONS, type SectionSizes } from '../layout/section-sizes';
import { chatListRowRem, chatListRows } from '../chat-list';
import { createPageCharacters, PAGE_CHARACTERS } from '../characters';
import TitleBar from '../components/TitleBar.vue';
import SidebarFrame from '../components/SidebarFrame.vue';
import SidebarSection from '../components/SidebarSection.vue';
import ProjectRow from '../components/ProjectRow.vue';
import ChatRow from '../components/ChatRow.vue';
import ChatGroupLabel from '../components/ChatGroupLabel.vue';
import Sash from '../layout/Sash.vue';
import WallpaperLayer from '../themes/WallpaperLayer.vue';
import { inertTitleBarApi } from './render-bridge';
import { SAMPLE_SELECTED_CHAT, SAMPLE_SELECTED_PROJECT, sampleChats, sampleProjects, sampleTitleBarState } from './sample-window';

// The drawn preview's window: the shell's own title bar, sidebar, wallpaper layer and grid, with sample content, laid out in
// the appearance's arrangement (geometry only). The editor and terminal panes are their themed surfaces; the chat pane's
// slot takes the sample transcript, which the page mounts as its own app.
const props = defineProps<{ appearance: RenderAppearance; now: number }>();
const { t } = useI18n();

const arrangement = computed(() => props.appearance.arrangement);
const projects = computed(() => sampleProjects(props.appearance.platform));
const chatRows = computed(() => chatListRows(sampleChats(props.now), new Date(props.now)));
const titleBarState = computed(() => sampleTitleBarState(props.appearance.platform, props.appearance.kind, arrangement.value, props.now));

const titleBarApi = inertTitleBarApi(props.appearance.platform);

const pageCharacters = createPageCharacters({
  shown: props.appearance.characters,
  states: Object.fromEntries(projects.value.map((project) => [project.key, characterState(project)])),
  selected: SAMPLE_SELECTED_PROJECT,
});
provide(PAGE_CHARACTERS, pageCharacters.characters);

// main sends the window's whole arrangement; a section it leaves out, or a sized one without its size, is a bug in the job
const sectionLayout = computed(() => Object.fromEntries(SIDEBAR_SECTIONS.map((id) => {
  const section = arrangement.value.sections[id];
  if (!section || (isSizedSection(id) && section.size === undefined)) throw new Error(`The render job's arrangement has no ${id} section size`);
  return [id, { collapsed: section.collapsed, size: section.size ?? 0 }];
})) as Record<SidebarSectionId, { readonly collapsed: boolean; readonly size: number }>);

// The sidebar's sections as Sidebar.vue sizes them: the filler takes what the others leave, the others keep their sizes and
// shrink in proportion when the sidebar is too short.
const frame = ref<InstanceType<typeof SidebarFrame> | null>(null);
const { height: sidebarHeight } = useElementSize(computed(() => frame.value?.root ?? null));
const minSection = computed(() => storedMinimum(MIN_SECTION_SIZE));
const filler = computed(() => fillerSection(sectionLayout.value));
const fixedSections = computed(() => arrangement.value.sectionOrder.filter(isSizedSection).filter((id) => !sectionLayout.value[id].collapsed && filler.value !== id));
const sectionSizes = computed(() => {
  const stored = Object.fromEntries(SIZED_SECTIONS.map((id) => [id, sectionLayout.value[id].size])) as SectionSizes;
  return fitSections(stored, fixedSections.value, sidebarHeight.value - remPx(SIDEBAR_SECTION_CHROME_REM) - minSection.value, minSection.value);
});
const bodySize = (id: SidebarSectionId): number | undefined => (isSizedSection(id) && filler.value !== id ? sectionSizes.value[id] : undefined);

// The grid as LayoutGrid places it, from the same geometry.
const gridRoot = ref<HTMLElement | null>(null);
const { width: gridWidth, height: gridHeight } = useElementSize(gridRoot);
const grid = computed<ShellGridLayout>(() => ({ ...arrangement.value.grid, maximized: null }));
const areas = computed(() => gridAreas(grid.value));
const slots = computed(() => slotSizes(grid.value, gridWidth.value, gridHeight.value, remPx(GRID_SASH_REM), atRootScale(COLUMN_MIN_PX), atRootScale(ROW_MIN_PX)));
const gridStyle = computed(() => gridTemplate(areas.value, GRID_SASH_REM, slots.value.sideWidth, slots.value.bottomHeight));
const area = (pane: GridPane): string => slotOf(grid.value, pane);
const shown = (pane: GridPane): boolean => areas.value[slotOf(grid.value, pane)];

const wallpaperLayer = ref<InstanceType<typeof WallpaperLayer> | null>(null);
const chatSlot = ref<HTMLElement | null>(null);

defineExpose({
  chatSlot,
  // settles once the wallpaper layer has drawn; a window with no wallpaper has nothing to wait for
  whenDrawn: (): Promise<void> => wallpaperLayer.value?.whenDrawn() ?? Promise.resolve(),
});
</script>

<template>
  <!-- isolate: the wallpaper layer paints over this background and under every pane -->
  <div
    class="relative isolate flex h-full min-h-0 flex-col bg-(--d-bg) text-(--d-text)"
    data-testid="sample-window"
  >
    <WallpaperLayer
      v-if="appearance.wallpapers"
      ref="wallpaperLayer"
      :wallpapers="appearance.wallpapers"
      :paused="true"
    />
    <TitleBar
      :api="titleBarApi"
      :state="titleBarState"
    />
    <div class="@container/body relative flex min-h-0 flex-1 overflow-hidden">
      <SidebarFrame
        ref="frame"
        data-render-region="sidebar"
        data-testid="sample-sidebar"
        :width="arrangement.sidebarWidth"
        :visible="true"
        :resizing="false"
        :sections-animated="false"
      >
        <SidebarSection
          v-for="id in arrangement.sectionOrder"
          :key="id"
          :section="id"
          :data-testid="`sample-section-${id}`"
          :count="id === 'projects' ? projects.length : id === 'chats' ? chatRows.filter((row) => row.kind === 'chat').length : undefined"
          :collapsed="sectionLayout[id].collapsed"
          :body-size="bodySize(id)"
        >
          <div
            v-if="id === 'projects'"
            role="listbox"
            :aria-label="t('projects.listLabel')"
            class="flex min-h-0 flex-1 flex-col gap-px overflow-hidden px-1.5 pt-0.5 pb-1.5"
          >
            <ProjectRow
              v-for="project in projects"
              :key="project.key"
              :project="project"
              :selected="project.key === SAMPLE_SELECTED_PROJECT"
              :active="false"
              :grouped="false"
              :flip="false"
            />
          </div>
          <div
            v-else-if="id === 'chats'"
            role="listbox"
            :aria-label="t('chats.listLabel', { project: projects[0]!.name })"
            class="min-h-0 flex-1 overflow-hidden px-1.5 pb-2"
          >
            <div
              v-for="(row, index) in chatRows"
              :key="row.kind === 'chat' ? row.chat.id : row.group"
              role="none"
              :style="{ height: `${chatListRowRem(row)}rem` }"
              :class="row.kind === 'chat' ? 'py-px' : ''"
            >
              <ChatGroupLabel
                v-if="row.kind === 'group'"
                :group="row.group"
              />
              <ChatRow
                v-else
                :chat="row.chat"
                :option-id="`sample-chat-${index}`"
                :selected="row.chat.id === SAMPLE_SELECTED_CHAT"
                :active="false"
                :renaming="false"
              />
            </div>
          </div>
        </SidebarSection>
      </SidebarFrame>
      <div
        ref="gridRoot"
        data-testid="sample-grid"
        class="layout-grid relative grid min-h-0 min-w-0 flex-1"
        :style="gridStyle"
      >
        <Sash
          v-if="areas.sideSash"
          orientation="vertical"
          class="relative z-2 [grid-area:vs]"
          :label="t('grid.resizeSide')"
          :value="slots.sideWidth"
          :min="slots.sideMin"
          :max="slots.sideMax"
          disabled
        />
        <Sash
          v-if="areas.bottomSash"
          orientation="horizontal"
          class="relative z-2 [grid-area:hs]"
          :label="t('grid.resizeBottom')"
          :value="slots.bottomHeight"
          :min="slots.bottomMin"
          :max="slots.bottomMax"
          disabled
        />
        <div
          v-show="shown('chat')"
          data-testid="sample-pane-chat"
          data-wallpaper-panel="chat"
          :data-slot="area('chat')"
          class="flex min-h-0 min-w-0 overflow-hidden bg-(--d-pane-chat)"
          :style="{ gridArea: area('chat') }"
        >
          <!-- The chat gutter's top cell continues the chat header. -->
          <div class="flex w-4 shrink-0 flex-col">
            <span class="h-11.5 shrink-0 border-b border-(--d-border) bg-(--d-panel)" />
          </div>
          <main
            ref="chatSlot"
            data-testid="sample-chat-slot"
            class="flex min-h-0 min-w-0 flex-1 flex-col"
          />
        </div>
        <section
          v-show="shown('editor')"
          data-testid="sample-pane-editor"
          data-wallpaper-panel="editor"
          :data-slot="area('editor')"
          :aria-label="t('editor.label')"
          class="flex min-h-0 min-w-0 flex-col overflow-hidden bg-(--d-pane-editor)"
          :style="{ gridArea: area('editor') }"
        >
          <div class="flex h-11.5 shrink-0 items-stretch border-b border-(--d-border) bg-(--d-panel)">
            <span class="w-4 shrink-0" />
            <div
              data-theme-scope="editorChrome"
              class="relative flex min-w-0 flex-1"
            />
          </div>
        </section>
        <section
          v-show="shown('terminal')"
          data-testid="sample-pane-terminal"
          data-wallpaper-panel="terminal"
          :data-slot="area('terminal')"
          :aria-label="t('grid.terminal.title')"
          class="flex min-h-0 min-w-0 flex-col overflow-hidden bg-(--d-pane-terminal)"
          :style="{ gridArea: area('terminal') }"
        >
          <div class="flex h-11.5 shrink-0 border-b border-(--d-border) bg-(--d-panel)" />
          <div class="flex min-h-0 flex-1 justify-end">
            <div
              data-theme-scope="terminalChrome"
              class="terminal-list relative min-h-0 w-[11.875rem] shrink-0 border-l border-(--d-border) p-1"
            />
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
