<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { MessageSquarePlus } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { DamoclesShellApi, FileRef, ShellFocusPart, ShellState } from '../preload/shell-channels';
import { applyShellLocale } from './i18n';
import { watchContentBounds } from './content-bounds';
import TitleBar from './components/TitleBar.vue';
import Sidebar from './components/Sidebar.vue';
import LayoutGrid from './layout/LayoutGrid.vue';
import EditorPane from './editor/EditorPane.vue';
import FocusOverlay from './editor/FocusOverlay.vue';
import { createEditorStore, EDITOR_STORE } from './editor/editor-store';
import { createTerminalStore, TERMINAL_STORE } from './terminal/terminal-store';

const props = defineProps<{ api: DamoclesShellApi }>();
const { t } = useI18n();

const state = shallowRef<ShellState | null>(null);
const titleBar = ref<InstanceType<typeof TitleBar> | null>(null);
const sidebar = ref<InstanceType<typeof Sidebar> | null>(null);
const grid = ref<InstanceType<typeof LayoutGrid> | null>(null);

const editor = createEditorStore(props.api);
provide(EDITOR_STORE, editor);
const terminals = createTerminalStore(props.api);
provide(TERMINAL_STORE, terminals);

// Reveals waiting for main to show the sidebar they asked for.
let sidebarWaiters: Array<() => void> = [];

function applyState(next: ShellState): void {
  state.value = next;
  applyShellLocale(next.locale);
  if (!next.layout.sidebarVisible) return;
  for (const resolve of sidebarWaiters.splice(0)) resolve();
}

const stops: Array<() => void> = [];
let stopBounds: (() => void) | undefined;

// F6 landed on a part: the sidebar's current row, the active terminal, or the active editor tab's own focus target (its
// editor, a page tab's address field), else that tab in the strip.
function focusPart(part: ShellFocusPart): void {
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
  editor.requestFocus(active.id);
  void nextTick(() => {
    if (editor.takeFocus(active.id)) document.querySelector<HTMLElement>(`[data-editor-tab][data-tab-id="${CSS.escape(active.id)}"]`)?.focus();
  });
}

onMounted(async () => {
  // Subscribed before the first read, so a change between the two is not lost.
  stops.push(props.api.onState(applyState));
  stops.push(props.api.onFocusPart(focusPart));
  // A folder link in a terminal opens it in Files, as Reveal in Files does.
  stops.push(props.api.terminal.onRevealInFiles((file) => void revealInFiles(file)));
  applyState(await props.api.getState());
  await Promise.all([editor.start(), terminals.start()]);
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
  editor.stop();
  terminals.stop();
});
</script>

<template>
  <div
    v-if="state"
    class="flex h-full min-h-0 flex-col bg-(--d-bg) text-(--d-text)"
  >
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
    <div class="flex min-h-0 flex-1 overflow-hidden">
      <div
        class="contents"
        :inert="editor.focusOverlay.value"
      >
        <Sidebar
          ref="sidebar"
          :api="api"
          :state="state"
        />
      </div>
      <LayoutGrid
        ref="grid"
        :api="api"
        :state="state"
        :focus-overlay="editor.focusOverlay.value"
      >
        <template #chat>
          <FocusOverlay
            v-if="editor.focusOverlay.value && state.selectedChat"
            :title="state.selectedChat.title || t('chats.newChat')"
            :status="state.selectedChat.status"
          />
          <template v-else-if="state.selected.chatId === undefined">
            <p class="text-sm font-medium">
              {{ t('content.empty') }}
            </p>
            <Button
              type="button"
              class="h-auto gap-1.5 rounded-lg px-3 py-1.5 text-xs hover:bg-primary [&_svg]:size-3.5"
              @click="api.newChat()"
            >
              <MessageSquarePlus
                aria-hidden="true"
                class="size-3.5"
              />
              {{ t('content.newChat') }}
            </Button>
          </template>
        </template>
        <template #editor>
          <EditorPane
            :api="api"
            :state="state"
            @reveal-in-files="void revealInFiles($event)"
          />
        </template>
      </LayoutGrid>
    </div>
    <!-- The focus overlay's scrim dims the whole window below the expanded editor; a click on it returns the editor to its slot.
         z-40 stays below .editor-focus's z-index (style.css). -->
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
