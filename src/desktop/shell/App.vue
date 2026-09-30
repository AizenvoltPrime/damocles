<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { MessageSquarePlus, PanelLeftClose, PanelLeftOpen, PanelRight } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DamoclesShellApi, ShellState } from '../preload/shell-channels';
import { applyShellLocale } from './i18n';
import { watchContentBounds } from './content-bounds';
import TabStrip from './components/TabStrip.vue';
import ProjectList from './components/ProjectList.vue';
import ToastRegion from './components/ToastRegion.vue';
import { TAB_PANEL_ID, tabDomId } from './tab-ids';

const props = defineProps<{ api: DamoclesShellApi }>();
const { t } = useI18n();

const state = shallowRef<ShellState | null>(null);
const sidebarOpen = ref(true);
const header = ref<HTMLElement | null>(null);
const toasts = ref<InstanceType<typeof ToastRegion> | null>(null);
const content = ref<HTMLElement | null>(null);

const selectedTab = computed(() => state.value?.tabs.find((tab) => tab.id === state.value?.selectedTabId));
const paneToggleTitle = computed(() => {
  const shortcut = state.value?.paneShortcutLabel ?? '';
  return state.value?.pane?.open ? t('pane.hide', { shortcut }) : t('pane.show', { shortcut });
});

function applyState(next: ShellState): void {
  state.value = next;
  applyShellLocale(next.locale);
}

let stopState: (() => void) | undefined;
let stopBounds: (() => void) | undefined;

onMounted(async () => {
  // Subscribed before the first read, so a change between the two is not lost.
  stopState = props.api.onState(applyState);
  applyState(await props.api.getState());
});

watch(content, (element) => {
  stopBounds?.();
  stopBounds = undefined;
  const toastElement = toasts.value?.$el as HTMLElement | undefined;
  if (!element || !header.value || !toastElement) return;
  stopBounds = watchContentBounds(element, [header.value, toastElement], (bounds) => props.api.reportContentBounds(bounds));
}, { flush: 'post' });

onBeforeUnmount(() => {
  stopState?.();
  stopBounds?.();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background text-foreground">
    <header
      ref="header"
      class="flex h-9 shrink-0 items-stretch border-b border-border bg-card"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        class="h-9 w-9 shrink-0 rounded-none"
        :aria-label="sidebarOpen ? t('projects.hide') : t('projects.show')"
        :title="sidebarOpen ? t('projects.hide') : t('projects.show')"
        :aria-expanded="sidebarOpen"
        aria-controls="shell-projects"
        @click="sidebarOpen = !sidebarOpen"
      >
        <PanelLeftClose
          v-if="sidebarOpen"
          aria-hidden="true"
        />
        <PanelLeftOpen
          v-else
          aria-hidden="true"
        />
      </Button>
      <TabStrip
        v-if="state"
        :api="api"
        :tabs="state.tabs"
        :selected-tab-id="state.selectedTabId"
        :platform="state.platform"
      />
      <Button
        v-if="state?.pane && selectedTab"
        variant="ghost"
        size="icon-sm"
        :class="cn('h-9 w-9 shrink-0 rounded-none border-l border-border', state.pane.open && 'bg-secondary text-primary')"
        :aria-label="t('pane.toggleName')"
        :aria-pressed="state.pane.open"
        :title="paneToggleTitle"
        @click="api.togglePane(selectedTab.id)"
      >
        <PanelRight aria-hidden="true" />
      </Button>
    </header>

    <ToastRegion
      ref="toasts"
      :api="api"
    />

    <div class="flex min-h-0 flex-1">
      <ProjectList
        v-show="sidebarOpen"
        id="shell-projects"
        :api="api"
        :projects="state?.projects ?? []"
      />
      <!-- main lays the selected tab's native view over exactly this element's rectangle -->
      <div
        v-if="selectedTab"
        :id="TAB_PANEL_ID"
        ref="content"
        role="tabpanel"
        :aria-labelledby="tabDomId(selectedTab.id)"
        class="min-w-0 flex-1"
      />
      <div
        v-else
        ref="content"
        class="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <p class="text-sm font-medium">
          {{ t('content.empty') }}
        </p>
        <p class="text-xs text-muted-foreground">
          {{ t('content.emptyHint') }}
        </p>
        <Button
          size="sm"
          @click="api.newTab()"
        >
          <MessageSquarePlus aria-hidden="true" />
          {{ t('content.newConversation') }}
        </Button>
      </div>
    </div>
  </div>
</template>
