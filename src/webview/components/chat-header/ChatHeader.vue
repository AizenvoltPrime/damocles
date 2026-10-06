<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { Brain, GitBranch, Globe, MessageCircleQuestion, Settings } from 'lucide-vue-next';
import WorkspaceFolderChip from '@/components/WorkspaceFolderChip.vue';
import PromptNavigatorChip from '@/components/PromptNavigatorChip.vue';
import ConsolidationIndicator from '@/components/ConsolidationIndicator.vue';
import McpStatusIndicator from '@/components/McpStatusIndicator.vue';
import ToolsStatusIndicator from '@/components/ToolsStatusIndicator.vue';
import PlanMenu from './PlanMenu.vue';
import HeaderMoreMenu from './HeaderMoreMenu.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import { useBtwStore } from '@/stores/useBtwStore';
import type { HeaderAction } from './headerActions';

const emit = defineEmits<{ action: [action: HeaderAction] }>();

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { workspaceFolders, panelWorkspaceFolderKey, mcpServers, toolsSnapshot, hostCapabilities } = storeToRefs(settingsStore);
const { selectedSessionDisplayName, isAwaitingUserAction } = storeToRefs(useSessionStore());
const { isProcessing } = storeToRefs(useUIStore());
const btwStore = useBtwStore();

// Chat Panel.dc.html folds the header by the panel's width: Memory consolidation below 45rem (720px at the default
// font), the plan, memory, browser, MCP and tools controls below 35rem (560px), all into the More menu.
const WIDE_REM = 45;
const ROOMY_REM = 35;
const rootRef = ref<HTMLElement | null>(null);
const widthRem = ref(Number.POSITIVE_INFINITY);
const wide = computed(() => widthRem.value >= WIDE_REM);
const roomy = computed(() => widthRem.value >= ROOMY_REM);

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

const branch = computed(() => workspaceFolders.value.find((f) => f.key === panelWorkspaceFolderKey.value)?.branch);
const mcpConnected = computed(() => mcpServers.value.filter((s) => s.status === 'connected').length);
const toolsEnabled = computed(() => toolsSnapshot.value.tools.filter((tool) => tool.toggleable && tool.enabled).length);

const run = (action: HeaderAction) => emit('action', action);
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
        <WorkspaceFolderChip />
        <span
          v-if="branch"
          class="flex min-w-0 items-center gap-1 font-mono"
          dir="ltr"
          :title="t('chatHeader.branch', { branch })"
          data-testid="chat-header-branch"
        >
          <GitBranch
            class="size-2.75 shrink-0"
            aria-hidden="true"
          />
          <span class="truncate">{{ branch }}</span>
        </span>
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-0.5">
      <PromptNavigatorChip :show-shortcut="wide" />
      <ConsolidationIndicator
        v-if="wide"
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
      <template v-if="roomy">
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
      </template>
      <slot name="history" />
      <HeaderMoreMenu
        :wide="wide"
        :roomy="roomy"
        :mcp-connected="mcpConnected"
        :tools-enabled="toolsEnabled"
        :panels-disabled="isProcessing"
        :has-aside="btwStore.hasAside"
        @action="run"
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
    </div>
  </header>
</template>
