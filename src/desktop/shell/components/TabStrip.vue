<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { MessageSquare, Plus, X } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DamoclesShellApi, ShellPlatform, ShellTab } from '../../preload/shell-channels';
import { TAB_PANEL_ID, tabDomId } from '../tab-ids';

const props = defineProps<{
  api: DamoclesShellApi;
  tabs: readonly ShellTab[];
  selectedTabId: string | undefined;
  platform: ShellPlatform;
}>();
const { t } = useI18n();

const tablist = ref<HTMLElement | null>(null);
const focusedId = ref<string | undefined>();
const draggedId = ref<string | undefined>();

// Roving tabindex: the one tab in the page's Tab order is the last one focused, else the selected one.
const tabbableId = computed(() => {
  if (focusedId.value !== undefined && props.tabs.some((tab) => tab.id === focusedId.value)) return focusedId.value;
  return props.selectedTabId ?? props.tabs[0]?.id;
});

const selectedTab = computed(() => props.tabs.find((tab) => tab.id === props.selectedTabId));
// A new selection becomes the tab keyboard focus enters the strip on, as the tabs pattern requires.
watch(() => props.selectedTabId, () => {
  focusedId.value = undefined;
});
const modifierLabel = computed(() => (props.platform === 'darwin' ? 'Cmd' : 'Ctrl'));

function titleOf(tab: ShellTab): string {
  return tab.title !== '' ? tab.title : t('tabs.newConversation');
}

function labelOf(tab: ShellTab): string {
  const title = titleOf(tab);
  const label = tab.projectName ? t('tabs.labelWithProject', { title, project: tab.projectName }) : title;
  return tab.busy ? t('tabs.busy', { label }) : label;
}

async function focusTab(id: string): Promise<void> {
  focusedId.value = id;
  await nextTick();
  tablist.value?.querySelector<HTMLElement>(`[id="${CSS.escape(tabDomId(id))}"]`)?.focus();
}

function close(id: string): void {
  const index = props.tabs.findIndex((tab) => tab.id === id);
  const neighbour = props.tabs[index + 1] ?? props.tabs[index - 1];
  void props.api.closeTab(id);
  if (neighbour && document.activeElement?.closest('[role="tablist"]')) void focusTab(neighbour.id);
}

function move(id: string, toIndex: number): void {
  if (toIndex < 0 || toIndex >= props.tabs.length) return;
  void props.api.moveTab(id, toIndex);
}

function onKeydown(event: KeyboardEvent, tab: ShellTab, index: number): void {
  const count = props.tabs.length;
  const reorder = event.shiftKey && (props.platform === 'darwin' ? event.metaKey : event.ctrlKey);
  let target: ShellTab | undefined;
  switch (event.key) {
    case 'ArrowRight':
      if (reorder) move(tab.id, index + 1);
      else target = props.tabs[(index + 1) % count];
      break;
    case 'ArrowLeft':
      if (reorder) move(tab.id, index - 1);
      else target = props.tabs[(index - 1 + count) % count];
      break;
    case 'Home':
      target = props.tabs[0];
      break;
    case 'End':
      target = props.tabs[count - 1];
      break;
    case 'Enter':
    case ' ':
      void props.api.selectTab(tab.id);
      break;
    case 'Delete':
      close(tab.id);
      break;
    case 'Backspace':
      // The Mac keyboard's delete key sends Backspace.
      if (props.platform !== 'darwin') return;
      close(tab.id);
      break;
    default:
      return;
  }
  event.preventDefault();
  if (target) void focusTab(target.id);
}

// Main asks for this when F6 (View > Focus Tab Strip) moves keyboard focus out of a tab view.
let stopFocusRequests: (() => void) | undefined;
onMounted(() => {
  stopFocusRequests = props.api.onFocusTabStrip(() => {
    focusedId.value = undefined;
    const id = tabbableId.value;
    if (id !== undefined) void focusTab(id);
  });
});
onBeforeUnmount(() => stopFocusRequests?.());

function onDrop(index: number): void {
  const id = draggedId.value;
  draggedId.value = undefined;
  if (id !== undefined) move(id, index);
}
</script>

<template>
  <div class="flex min-w-0 flex-1 items-stretch">
    <div
      ref="tablist"
      role="tablist"
      :aria-label="t('tabs.listLabel')"
      :aria-description="t('tabs.keyboardHelp', { modifier: modifierLabel })"
      class="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]"
    >
      <div
        v-for="(tab, index) in tabs"
        :id="tabDomId(tab.id)"
        :key="tab.id"
        role="tab"
        :aria-selected="tab.id === selectedTabId"
        :aria-controls="tab.id === selectedTabId ? TAB_PANEL_ID : undefined"
        :aria-label="labelOf(tab)"
        :tabindex="tab.id === tabbableId ? 0 : -1"
        :title="labelOf(tab)"
        draggable="true"
        :class="cn(
          'group relative flex min-w-24 max-w-56 shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-border px-2.5 text-xs outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
          tab.id === selectedTabId
            ? 'bg-background text-foreground after:absolute after:inset-x-0 after:top-0 after:h-0.5 after:bg-primary'
            : 'text-muted-foreground hover:bg-muted',
        )"
        @click="api.selectTab(tab.id)"
        @auxclick="$event.button === 1 && close(tab.id)"
        @focus="focusedId = tab.id"
        @keydown="onKeydown($event, tab, index)"
        @dragstart="draggedId = tab.id"
        @dragend="draggedId = undefined"
        @dragover.prevent
        @drop.prevent="onDrop(index)"
      >
        <MessageSquare
          class="size-3.5 shrink-0"
          aria-hidden="true"
        />
        <span class="min-w-0 truncate">{{ titleOf(tab) }}</span>
        <span
          v-if="tab.projectName"
          class="min-w-0 shrink truncate text-[11px] text-muted-foreground"
        >{{ tab.projectName }}</span>
        <span
          v-if="tab.busy"
          class="size-1.5 shrink-0 animate-pulse rounded-full bg-info"
          aria-hidden="true"
        />
        <!-- Mouse affordance only; keyboard users close with Delete or the close button after the strip. -->
        <span
          aria-hidden="true"
          class="ml-auto flex size-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-muted group-hover:opacity-100 group-aria-selected:opacity-70"
          @click.stop="close(tab.id)"
        >
          <X class="size-3" />
        </span>
      </div>
    </div>
    <Button
      variant="ghost"
      size="icon-sm"
      class="h-9 w-9 shrink-0 rounded-none"
      :disabled="!selectedTab"
      :aria-label="selectedTab ? t('tabs.closeTab', { title: titleOf(selectedTab) }) : t('tabs.noTabToClose')"
      :title="selectedTab ? t('tabs.closeTab', { title: titleOf(selectedTab) }) : t('tabs.noTabToClose')"
      @click="selectedTab && api.closeTab(selectedTab.id)"
    >
      <X aria-hidden="true" />
    </Button>
    <Button
      variant="ghost"
      size="icon-sm"
      class="h-9 w-9 shrink-0 rounded-none"
      :aria-label="t('tabs.newTab')"
      :title="t('tabs.newTab')"
      @click="api.newTab()"
    >
      <Plus aria-hidden="true" />
    </Button>
  </div>
</template>
