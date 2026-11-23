<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DamoclesShellApi, FileRef, ShellFocusPart, ShellState } from '../preload/shell-channels';
import { applyShellLocale } from './i18n';
import { setPageCharacters } from './characters';
import { watchContentBounds } from './content-bounds';
import TitleBar from './components/TitleBar.vue';
import Sidebar from './components/Sidebar.vue';
import LayoutGrid from './layout/LayoutGrid.vue';
import EditorPane from './editor/EditorPane.vue';
import FocusOverlay from './editor/FocusOverlay.vue';
import ConnectionBanner from './components/ConnectionBanner.vue';
import ChatPlaceholder from './components/ChatPlaceholder.vue';
import SafeStartBanner from './components/SafeStartBanner.vue';
import KeepChangesBanner from './components/KeepChangesBanner.vue';
import ShowInWindowStrip from './components/ShowInWindowStrip.vue';
import WallpaperLayer from './themes/WallpaperLayer.vue';
import { watchPageMotion } from './themes/page-motion';
import { watchTimeZone } from './themes/time-zone';
import { Button } from '@/components/ui/button';
import TrustedCheckingNote from '@/components/TrustedCheckingNote.vue';
import { useTrustedVisibility } from '@/composables/useTrustedVisibility';
import { chatTitleText } from './components/chat-title';
import { DESIGN_STRIP } from '@/components/design/design-strip';
import { createEditorStore, EDITOR_STORE } from './editor/editor-store';
import { editorTabElement, enterPage } from './editor/page-focus';
import { createTerminalStore, TERMINAL_STORE } from './terminal/terminal-store';
import { createScmStore, SCM_STORE } from './scm/scm-store';
import { dropTabMarkupSessions } from './editor/markup-session';
import { dropTweaksSession } from './editor/tweaks-session';

const props = defineProps<{ api: DamoclesShellApi }>();
const { t } = useI18n();

const state = shallowRef<ShellState | null>(null);
const titleBar = ref<InstanceType<typeof TitleBar> | null>(null);
const sidebar = ref<InstanceType<typeof Sidebar> | null>(null);
const grid = ref<InstanceType<typeof LayoutGrid> | null>(null);
const sidebarSliding = ref(false);
const keepBanner = ref<InstanceType<typeof KeepChangesBanner> | null>(null);

function keepBannerFocusOut(event: FocusEvent): void {
  const root = keepBanner.value?.$el as HTMLElement | undefined;
  if (event.relatedTarget instanceof Node && root?.contains(event.relatedTarget)) return;
  props.api.reportFocusedPart(null);
}

const editor = createEditorStore(props.api);
provide(EDITOR_STORE, editor);
const terminals = createTerminalStore(props.api);
provide(TERMINAL_STORE, terminals);
const scm = createScmStore(props.api.scm);
provide(SCM_STORE, scm);
watch(() => state.value?.projects, (projects) => {
  if (projects) scm.retainProjects(new Set(projects.map((project) => project.key)));
});

const selectedProject = computed(() => state.value?.projects.find((project) => project.key === state.value?.selected.projectKey));
// The selected project's remote host, whose banner shows under the chat's header while it is offline or waits for a sign-in.
const selectedHost = computed(() => {
  const hostId = selectedProject.value?.authority.hostId;
  return hostId === undefined ? undefined : state.value?.hosts.find((host) => host.hostId === hostId);
});
// The shell cannot see the chat page's design header; a design chat has one for its whole life, so the edge follows its role.
const designEdgeShown = computed(() => state.value?.selectedChat?.design !== undefined && state.value.chatViewShown && !editor.focusOverlay.value);

// The placeholder's Remove project took its focused button away with the project; a cancelled removal leaves it listed.
function projectRemoved(): void {
  sidebar.value?.focusProjects();
}

// Reveals waiting for main to show the sidebar they asked for.
let sidebarWaiters: Array<() => void> = [];

function applyState(next: ShellState): void {
  state.value = next;
  setPageCharacters({ shown: next.characters, selected: next.selected.projectKey });
  void applyShellLocale(next.locale);
  if (!next.layout.sidebarVisible) return;
  for (const resolve of sidebarWaiters.splice(0)) resolve();
}

const stops: Array<() => void> = [];
let stopBounds: (() => void) | undefined;

// F6 landed on a part: the sidebar's current row, the active terminal, or the active editor tab's own focus target (its
// editor, a browser tab's address field, a preview's page view), else that tab in the strip.
function focusPart(part: ShellFocusPart): void {
  if (part === 'keepChanges') {
    keepBanner.value?.focus();
    return;
  }
  if (part === 'sidebar') {
    sidebar.value?.focusCurrentRow();
    return;
  }
  if (part === 'terminal') {
    const terminal = terminals.active.value;
    if (terminal) terminals.requestFocus(terminal.id);
    return;
  }
  const active = editor.activeTab.value;
  if (part !== 'editor' || !active) return;
  if (active.htmlPreview || active.designPreview) {
    void enterPage(props.api, active.id).then((entered) => {
      if (!entered) editorTabElement(active.id)?.focus();
    });
    return;
  }
  editor.requestFocus(active.id);
  void nextTick(() => {
    if (editor.takeFocus(active.id)) editorTabElement(active.id)?.focus();
  });
}

onMounted(async () => {
  // Subscribed before the first read, so a change between the two is not lost.
  stops.push(props.api.onState(applyState));
  stops.push(props.api.onFocusPart(focusPart));
  stops.push(props.api.onDesignPreviewClosed(dropTabMarkupSessions));
  stops.push(props.api.onDesignPreviewClosed(dropTweaksSession));
  // One project's shown folder (D31) between full states; the next state carries it too.
  stops.push(props.api.onShownFolder((shown) => {
    if (state.value) state.value = { ...state.value, shownFolders: { ...state.value.shownFolders, [shown.projectKey]: shown } };
  }));
  // A folder link in a terminal opens it in Files, as Reveal in Files does.
  stops.push(props.api.terminal.onRevealInFiles((file) => void revealInFiles(file)));
  stops.push(watchPageMotion((motion) => props.api.reportPageMotion(motion)));
  stops.push(watchTimeZone((zone) => props.api.reportTimeZone(zone)));
  applyState(await props.api.getState());
  await Promise.all([editor.start(), terminals.start(), scm.start()]);
});

// Main lays the selected chat's view over exactly the chat slot's rectangle; the grid's panes are its neighbours, since a
// pane that grows or shrinks moves the chat slot without resizing it.
const chatSlot = computed(() => grid.value?.chatSlot ?? null);
watch(chatSlot, (element) => {
  stopBounds?.();
  stopBounds = undefined;
  const header = titleBar.value?.$el as HTMLElement | undefined;
  const gridRoot = grid.value?.root;
  if (!element || !header || !gridRoot) return;
  const panes = [...gridRoot.querySelectorAll<HTMLElement>('[data-testid^="grid-pane-"]')];
  stopBounds = watchContentBounds(element, [header, gridRoot, ...panes], (bounds) => props.api.reportContentBounds(bounds));
}, { flush: 'post' });

// The theme editor dock's slot: main places the dock's view on it, and hides the view while the shell shows none.
const dockSlot = ref<HTMLElement | null>(null);
const bodyRow = ref<HTMLElement | null>(null);
let stopDockBounds: (() => void) | undefined;
watch(dockSlot, (element) => {
  stopDockBounds?.();
  stopDockBounds = undefined;
  if (!element) {
    props.api.reportThemeDockBounds(null);
    return;
  }
  const header = titleBar.value?.$el as HTMLElement | undefined;
  stopDockBounds = watchContentBounds(element, [...(header ? [header] : []), ...(bodyRow.value ? [bodyRow.value] : [])], (bounds) => props.api.reportThemeDockBounds(bounds));
}, { flush: 'post' });

// The dock's peek bar takes focus as the peek starts; Escape on the bar brings the dock back, under the bar's visibility hold.
const peekBack = ref<InstanceType<typeof Button> | null>(null);
const peekBar = ref<HTMLElement | null>(null);
const { isVisible: peekBarVisible, explain: peekBarExplain } = useTrustedVisibility(peekBar, true);
watch(() => state.value?.dockPeek === true, (peeking) => {
  if (peeking) void nextTick(() => (peekBack.value?.$el as HTMLElement | undefined)?.focus());
});
function peekEscape(event: KeyboardEvent): void {
  event.preventDefault();
  void props.api.endThemeDockPeek();
}

// As VS Code's reveal opens the side bar: the focus overlay closes, and a hidden sidebar is shown by main (show only, so
// two reveals never toggle it shut) before the reveal, which an inert sidebar would ignore.
async function revealInFiles(file: FileRef): Promise<void> {
  await editor.setFocusOverlay(false);
  if (state.value?.layout.sidebarVisible === false) {
    const shown = new Promise<void>((resolve) => sidebarWaiters.push(resolve));
    try {
      await props.api.showSidebar();
    } catch {
      return;
    }
    await shown;
  }
  await sidebar.value?.revealFile(file);
}

onBeforeUnmount(() => {
  for (const stop of stops) stop();
  sidebarWaiters = [];
  stopBounds?.();
  stopDockBounds?.();
  editor.stop();
  terminals.stop();
  scm.stop();
});
</script>

<template>
  <!-- isolate: the wallpaper layer paints over this background and under every pane -->
  <div
    v-if="state"
    class="relative isolate flex h-full min-h-0 flex-col bg-(--d-bg) text-(--d-text)"
  >
    <WallpaperLayer
      v-if="state.wallpapers"
      :wallpapers="state.wallpapers"
      :paused="(state.wallpaperPaused?.length ?? 0) > 0"
    />
    <!-- The focus overlay holds focus: the title bar, sidebar and other panes under its scrim are inert meanwhile. -->
    <div
      class="contents"
      :inert="editor.focusOverlay.value"
    >
      <TitleBar
        ref="titleBar"
        :api="api"
        :state="state"
      />
    </div>
    <SafeStartBanner
      v-if="state.safeStart"
      :reason="state.safeStart.reason"
      @use-mine="void api.useMyTheme()"
      @open-settings="void api.openSettings('appearance')"
    />
    <!-- F6 parts: focus anywhere in the banner is its part; main keeps it in the cycle only while it counts. -->
    <KeepChangesBanner
      v-if="state.keepChanges"
      ref="keepBanner"
      :state="state.keepChanges"
      @keep="void api.keepThemeChanges()"
      @revert="void api.revertThemeChanges()"
      @focusin="api.reportFocusedPart('keepChanges')"
      @focusout="keepBannerFocusOut"
    />
    <ShowInWindowStrip
      v-if="state.themeProposal"
      :proposal="state.themeProposal"
      @stop="void api.stopShowingProposal()"
    />
    <!-- Peek at the window: the editor dock that covered it steps aside until this button or Escape. -->
    <div
      v-if="state.dockPeek"
      ref="peekBar"
      data-trusted
      class="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-(--d-border2) bg-(--d-card) py-1.5 ps-4 pe-3 text-12 text-(--d-text)"
      data-testid="theme-dock-peek"
      @keydown.esc="peekEscape"
    >
      <div class="relative min-w-0 flex-1">
        <span class="text-(--d-muted)">{{ t('themes.peek.hint') }}</span>
        <TrustedCheckingNote
          cover
          :shown="peekBarExplain"
          :text="t('themes.checkingVisible')"
        />
      </div>
      <Button
        ref="peekBack"
        type="button"
        variant="outline"
        size="sm"
        class="h-7 rounded-8 border-(--d-border2) bg-transparent px-3 text-12"
        :aria-disabled="!peekBarVisible || undefined"
        @click="void api.endThemeDockPeek()"
      >
        {{ t('themes.peek.back') }}
      </Button>
    </div>
    <div
      ref="bodyRow"
      class="@container/body relative flex min-h-0 flex-1 overflow-hidden"
    >
      <div
        class="contents"
        :inert="editor.focusOverlay.value"
      >
        <Sidebar
          ref="sidebar"
          :api="api"
          :state="state"
          @slide="sidebarSliding = $event"
        />
      </div>
      <LayoutGrid
        ref="grid"
        :api="api"
        :state="state"
        :focus-overlay="editor.focusOverlay.value"
        :sidebar-sliding="sidebarSliding"
      >
        <!-- Every banner sits under a header, a chat page's or the placeholder's, and the gutter's strip continues it; a kept
             chat of another project is another host's or local, so it gets no strip. A design chat's page puts its design
             header between the two, so the gutter does too. -->
        <template
          v-if="state.selected.chatId !== undefined || !state.chatViewShown"
          #chatGutter
        >
          <div
            v-if="designEdgeShown"
            aria-hidden="true"
            data-testid="design-header-edge"
            :class="DESIGN_STRIP"
          />
          <ConnectionBanner
            :key="selectedHost?.hostId ?? 'none'"
            :host="selectedHost"
            edge
          />
        </template>
        <template #chat>
          <div
            v-if="editor.focusOverlay.value && state.selectedChat"
            class="flex min-h-0 flex-1 flex-col items-center justify-center p-6"
          >
            <FocusOverlay
              :title="chatTitleText(state.selectedChat, t)"
              :status="state.selectedChat.status"
            />
          </div>
          <ChatPlaceholder
            v-else-if="!state.chatViewShown"
            :api="api"
            :project="selectedProject"
            :host="selectedHost"
            @removed="projectRemoved"
          />
        </template>
        <template #editor>
          <EditorPane
            :api="api"
            :state="state"
            @reveal-in-files="void revealInFiles($event)"
          />
        </template>
      </LayoutGrid>
      <!-- The theme editor dock's place: main lays its own view over it. Docked it takes its width at the right edge and the
           panes reflow; below 48rem of window width it covers the window instead. It paints nothing: until main's view
           lands on it, a ground here would show as a block over the window's wallpaper. -->
      <div
        v-if="state.dockInset > 0 && !state.dockPeek"
        ref="dockSlot"
        class="absolute inset-0 @min-[48rem]/body:static @min-[48rem]/body:w-(--dock-width) @min-[48rem]/body:min-w-72 @min-[48rem]/body:flex-none"
        :style="{ '--dock-width': `${state.dockInset}rem` }"
        data-testid="theme-dock-slot"
      />
    </div>
    <!-- The focus overlay's scrim dims the whole window below the expanded editor; a click on it returns the editor to its slot.
         z-40 stays below the focus overlay, which the overlay stack places from its base of 50 (EditorPane.vue). -->
    <Transition name="t-fade">
      <div
        v-if="editor.focusOverlay.value"
        data-testid="focus-overlay-scrim"
        class="fixed inset-0 z-40 bg-(--d-scrim) backdrop-blur-xs"
        @click="editor.setFocusOverlay(false)"
      />
    </Transition>
  </div>
</template>
