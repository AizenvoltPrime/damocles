<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { Brain, Folder, FolderX, GitBranch, Globe, MessageCircleQuestion, Settings, SquareTerminal } from 'lucide-vue-next';
import { Toggle } from '@/components/ui/toggle';
import WorkspaceFolderChip from '@/components/WorkspaceFolderChip.vue';
import PromptNavigatorChip from '@/components/PromptNavigatorChip.vue';
import PinnedPromptButton from './PinnedPromptButton.vue';
import ConsolidationIndicator from '@/components/ConsolidationIndicator.vue';
import McpStatusIndicator from '@/components/McpStatusIndicator.vue';
import ToolsStatusIndicator from '@/components/ToolsStatusIndicator.vue';
import PlanMenu from './PlanMenu.vue';
import HeaderMoreMenu from './HeaderMoreMenu.vue';
import ChatChangesCounter from './ChatChangesCounter.vue';
import HandOffMenu from './HandOffMenu.vue';
import WorktreeHeaderChip from './WorktreeHeaderChip.vue';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { chatOffline } from '@/composables/useChatHost';
import type { ChatPlace } from '@shared/types/messages';
import { visibleText } from '@shared/visible-text';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import { useBtwStore } from '@/stores/useBtwStore';
import type { HeaderAction } from './headerActions';
import type { ChatMessage } from '@shared/types/session';

// pinnedPrompt: the prompt the message list would pin while the user keeps its pinned header hidden
defineProps<{ pinnedPrompt?: ChatMessage | null }>();
const emit = defineEmits<{ action: [action: HeaderAction]; restorePin: [] }>();

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { workspaceFolders, panelWorkspaceFolderKey, mcpServers, toolsSnapshot, hostCapabilities } = storeToRefs(settingsStore);
const { selectedSessionDisplayName, isAwaitingUserAction } = storeToRefs(useSessionStore());
const { isProcessing, terminalShown, toggleTerminalShortcut, chatChanges, worktree } = storeToRefs(useUIStore());
const { postMessage } = usePlatformBridge();
const btwStore = useBtwStore();
// A mirrored transcript's view answers nothing but ready, so its header keeps only the controls that work on the page itself.
const transcript = chatOffline() !== undefined;

// Chat Panel.dc.html folds the header by the panel's width: Memory consolidation below 45rem (720px at the default
// font), the plan, memory, browser, MCP and tools controls and the desktop terminal toggle below 35rem (560px), all into the More menu.
const WIDE_REM = 45;
const ROOMY_REM = 35;
// A live worktree chip takes up to 11rem beside the project name, so the toolbar folds this much earlier while it shows.
const CHIP_FOLD_REM = 8;
const rootRef = ref<HTMLElement | null>(null);
const widthRem = ref(Number.POSITIVE_INFINITY);
const foldAt = (rem: number): number => rem + (worktreeChip.value && !worktreeChip.value.gone ? CHIP_FOLD_REM : 0);
const wide = computed(() => widthRem.value >= foldAt(WIDE_REM));
const roomy = computed(() => widthRem.value >= foldAt(ROOMY_REM));
// Hand off keeps its icon button down to 25rem (400px at the default font) and folds into More below it, so the header still
// fits the narrowest panel.
const HAND_OFF_REM = 25;
const fitsHandOff = computed(() => widthRem.value >= HAND_OFF_REM);

let observer: ResizeObserver | null = null;
onMounted(() => {
  // The header spans the panel, so its border box is the panel's width. Its height is rem, so a host font change
  // resizes it too and the root size is read again here.
  observer = new ResizeObserver(([entry]) => {
    const size = entry?.borderBoxSize[0];
    if (size) widthRem.value = size.inlineSize / parseFloat(getComputedStyle(document.documentElement).fontSize);
  });
  if (rootRef.value) observer.observe(rootRef.value);
});
onBeforeUnmount(() => observer?.disconnect());

const title = computed(() => selectedSessionDisplayName.value || t('chatHeader.newChat'));
const status = computed(() => {
  if (isAwaitingUserAction.value) return { dot: 'bg-(--d-warning)', label: t('chatHeader.statusWaiting') };
  if (isProcessing.value) return { dot: 'bg-(--d-accent)', label: t('chatHeader.statusWorking') };
  return null;
});

// A worktree chat's folder is no project of the list, so its project and branch come from its worktree state.
const panelFolder = computed(() => workspaceFolders.value.find((f) => f.key === panelWorkspaceFolderKey.value));
const branch = computed(() => panelFolder.value?.branch ?? (worktree.value?.place === 'project' ? worktree.value.baseBranch : undefined));
const worktreeProject = computed(() => {
  const name = panelFolder.value ? undefined : worktree.value?.projectName;
  return name === undefined ? undefined : visibleText(name);
});
const mcpConnected = computed(() => mcpServers.value.filter((s) => s.status === 'connected').length);
const toolsEnabled = computed(() => toolsSnapshot.value.tools.filter((tool) => tool.toggleable && tool.enabled).length);

const run = (action: HeaderAction) => emit('action', action);

// D30, D61: shown only once the host sent a worktree state, so VS Code's header is unchanged.
const worktreeChip = computed(() => {
  const state = worktree.value;
  if (!state) return null;
  if (state.phase === 'deleted') return { gone: true as const };
  if (state.place !== 'worktree' || !state.branch || state.phase === 'pending' || state.phase === 'none') return null;
  const base = state.baseBranch === undefined ? undefined : visibleText(state.baseBranch);
  const note = base === undefined ? undefined : state.targetRewritten ? { text: t('worktree.rewritten', { branch: base }), warning: true } : state.behind ? { text: t('worktree.behind', { n: state.behind, branch: base }), warning: false } : undefined;
  return { gone: false as const, branch: state.branch, note };
});
const handOff = computed(() => {
  const state = worktree.value;
  return hostCapabilities.value.worktrees && state && (state.phase === 'none' || state.phase === 'ready') ? state : null;
});
const moveChat = (to: ChatPlace) => postMessage({ type: 'chatMove', to });
// D60: only a host that opens the review tab shows the counter, and only once the chat changed a file
const changes = computed(() => (hostCapabilities.value.chatReview && chatChanges.value.files > 0 ? chatChanges.value : null));
const terminalTitle = computed(() => (toggleTerminalShortcut.value ? t('chatHeader.toggleTerminalShortcut', { shortcut: toggleTerminalShortcut.value }) : t('chatHeader.toggleTerminal')));
</script>

<template>
  <header
    ref="rootRef"
    class="flex h-11.5 shrink-0 items-center gap-2.5 border-b border-(--d-border) bg-(--d-panel) ps-4 pe-2.5 text-(--d-text)"
    :data-width="wide ? 'wide' : roomy ? 'roomy' : 'narrow'"
    data-testid="chat-header"
  >
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="flex min-w-0 items-center gap-2">
        <h1
          class="truncate text-13.5/5 font-semibold tracking-[-.005em]"
          data-testid="chat-header-title"
        >
          {{ title }}
        </h1>
        <Transition name="t-fade">
          <span
            v-if="status"
            class="size-1.75 shrink-0 rounded-full animate-[d-pulse_1.6s_ease-in-out_infinite]"
            :class="status.dot"
            role="img"
            :aria-label="status.label"
            :title="status.label"
            data-testid="chat-header-status"
          />
        </Transition>
      </div>
      <div class="flex min-w-0 items-center gap-1.5 text-11.5/4 text-(--d-faint)">
        <WorkspaceFolderChip v-if="!worktreeProject" />
        <span
          v-else
          class="inline-flex min-w-0 shrink items-center gap-1"
          :title="worktreeProject"
          data-testid="chat-header-folder"
        >
          <Folder
            class="size-2.75 shrink-0"
            aria-hidden="true"
          />
          <span class="truncate">{{ worktreeProject }}</span>
        </span>
        <Transition
          name="t-chip"
          mode="out-in"
        >
          <span
            v-if="worktreeChip?.gone"
            key="gone"
            class="flex h-4.5 min-w-0 items-center gap-1 rounded-full bg-(--d-hover) px-1.5 text-10.5 text-(--d-faint-text)"
            :title="t('worktree.deleted')"
            data-testid="chat-header-worktree"
            data-state="deleted"
          >
            <FolderX
              class="size-2.5 shrink-0"
              aria-hidden="true"
            />
            <span class="truncate">{{ t('worktree.deletedChip') }}</span>
          </span>
          <WorktreeHeaderChip
            v-else-if="worktreeChip"
            key="live"
            :branch="worktreeChip.branch"
            :note="worktreeChip.note"
            :narrow="!roomy"
            @new-chat-here="postMessage({ type: 'worktreeAction', action: 'newChatInWorktree' })"
          />
        </Transition>
        <!-- The note gives way before the chip; narrow, it folds into the chip as an icon. -->
        <Transition name="t-fade">
          <span
            v-if="worktreeChip && !worktreeChip.gone && worktreeChip.note && roomy"
            class="min-w-0 shrink-4 truncate"
            :class="worktreeChip.note.warning ? 'text-(--d-warning-text)' : 'text-(--d-faint-text)'"
            data-testid="chat-header-worktree-note"
          >{{ worktreeChip.note.text }}</span>
        </Transition>
        <span
          v-if="branch && !worktreeChip"
          class="flex min-w-0 items-center gap-1 font-mono"
          dir="ltr"
          :title="t('chatHeader.branch', { branch: visibleText(branch) })"
          data-testid="chat-header-branch"
        >
          <GitBranch
            class="size-2.75 shrink-0"
            aria-hidden="true"
          />
          <span class="truncate">{{ visibleText(branch) }}</span>
        </span>
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-0.5">
      <Transition name="t-pop">
        <PinnedPromptButton
          v-if="pinnedPrompt"
          :message="pinnedPrompt"
          @restore="emit('restorePin')"
        />
      </Transition>
      <PromptNavigatorChip :show-shortcut="wide" />
      <ConsolidationIndicator
        v-if="wide && !transcript"
        @click="run('consolidation')"
      />
      <button
        v-if="btwStore.hasAside"
        type="button"
        class="d-tool-btn relative w-7.5 px-0 text-(--d-accent)"
        :title="t('chatHeader.viewAside')"
        :aria-label="t('chatHeader.viewAside')"
        data-testid="chat-header-aside"
        @click="run('viewAside')"
      >
        <MessageCircleQuestion
          class="size-3.75"
          aria-hidden="true"
        />
        <span
          v-if="btwStore.aside?.isStreaming"
          class="pointer-events-none absolute inset-0.75 rounded-lg border-2 border-transparent border-t-(--d-accent) animate-[d-spin_.9s_linear_infinite]"
          aria-hidden="true"
        />
      </button>
      <template v-if="roomy && !transcript">
        <span
          class="mx-1.5 h-4 w-px bg-(--d-border2)"
          aria-hidden="true"
        />
        <PlanMenu @action="run" />
        <button
          type="button"
          class="d-tool-btn w-7.5 px-0"
          :title="t('chatHeader.memory')"
          :aria-label="t('chatHeader.memory')"
          data-testid="chat-header-memory"
          @click="run('memory')"
        >
          <Brain
            class="size-3.75"
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          class="d-tool-btn w-7.5 px-0"
          :title="t('chatHeader.openBrowser')"
          :aria-label="t('chatHeader.openBrowser')"
          data-testid="chat-header-browser"
          @click="run('browser')"
        >
          <Globe
            class="size-3.75"
            aria-hidden="true"
          />
        </button>
        <span
          class="mx-1.5 h-4 w-px bg-(--d-border2)"
          aria-hidden="true"
        />
        <McpStatusIndicator
          :servers="mcpServers"
          :disabled="isProcessing"
          @click="run('mcp')"
        />
        <ToolsStatusIndicator
          :snapshot="toolsSnapshot"
          :disabled="isProcessing"
          @click="run('tools')"
        />
        <Transition name="t-pop">
          <ChatChangesCounter
            v-if="changes"
            :added="changes.added"
            :removed="changes.removed"
            :files="changes.files"
            @open="run('reviewChanges')"
          />
        </Transition>
      </template>
      <template v-if="!transcript">
        <Transition name="t-pop">
          <HandOffMenu
            v-if="handOff && fitsHandOff"
            :state="handOff"
            :project-branch="branch"
            :wide="wide"
            @move="moveChat"
          />
        </Transition>
        <slot name="history" />
        <!-- Pressed while the desktop window shows its terminal pane; the host toggles the pane and reports the new state. -->
        <Toggle
          v-if="hostCapabilities.windowLayout && roomy"
          :model-value="terminalShown"
          size="sm"
          data-testid="chat-header-terminal"
          class="d-press ms-1 h-7 min-w-7 gap-1.5 rounded-7 border border-(--d-border2) px-2 text-xs font-medium text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 data-[state=on]:border-(--d-accent) data-[state=on]:bg-(--d-accent-soft) data-[state=on]:text-(--d-accent-text) data-[state=on]:hover:bg-(--d-accent-soft) [&_svg]:size-3.5"
          :title="terminalTitle"
          :aria-label="t('chatHeader.terminal')"
          @update:model-value="run('terminal')"
        >
          <SquareTerminal aria-hidden="true" />
          <span v-if="wide">{{ t('chatHeader.terminal') }}</span>
        </Toggle>
        <HeaderMoreMenu
          :wide="wide"
          :roomy="roomy"
          :mcp-connected="mcpConnected"
          :tools-enabled="toolsEnabled"
          :panels-disabled="isProcessing"
          :has-aside="btwStore.hasAside"
          :terminal="hostCapabilities.windowLayout"
          :terminal-shortcut="toggleTerminalShortcut"
          :changes="changes"
          :hand-off="fitsHandOff ? null : handOff"
          @action="run"
          @hand-off="moveChat"
        />
        <button
          v-if="hostCapabilities.settingsInPanel"
          type="button"
          class="d-tool-btn w-7.5 px-0 text-(--d-accent) hover:text-(--d-accent)"
          :title="t('common.settings')"
          :aria-label="t('common.settings')"
          data-testid="chat-settings-button"
          @click="run('settings')"
        >
          <Settings
            class="size-3.75"
            aria-hidden="true"
          />
        </button>
      </template>
    </div>
  </header>
</template>
