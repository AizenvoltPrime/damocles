<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { storeToRefs } from "pinia";
import { Search } from "lucide-vue-next";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { IconChevronRight, IconChevronDown } from "@/components/icons";
import { usePromptNavigatorStore } from "@/stores/usePromptNavigatorStore";
import { useSessionStore } from "@/stores";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useEnrichedPrompts, type EnrichedPrompt } from "@/composables/useEnrichedPrompts";
import { injectMessageListRef } from "@/composables/useMessageListRef";
import ToolBadge from "./ToolBadge.vue";
import PromptKebabMenu from "./PromptKebabMenu.vue";
import { getToolColorClass } from "./toolBadgeColors";
import {
  buildVisibleRows,
  canRewindForPrompt,
  countVisibleRows,
  filterPrompts,
  groupByNode,
  highlight as buildHighlight,
  type VisibleRow,
} from "./promptNavigatorLogic";
import { metaKeyShortcut } from "@/composables/usePlatformKey";

const toggleShortcut = metaKeyShortcut("k");

const { t } = useI18n();
const navigatorStore = usePromptNavigatorStore();
const { isOpen, query, activeIndex, collapsedNodes } = storeToRefs(navigatorStore);
const { checkpointMessages } = storeToRefs(useSessionStore());
const { activeContextStrategy } = storeToRefs(useSettingsStore());
const isRecallMode = computed(() => activeContextStrategy.value === "recall");

const emit = defineEmits<{
  editAndResend: [text: string];
  rewind: [messageId: string];
}>();

function canRewindFor(prompt: EnrichedPrompt): boolean {
  return canRewindForPrompt(prompt, checkpointMessages.value);
}

function handleEditAndResend(text: string): void {
  emit("editAndResend", text);
}

function handleRewind(messageId: string): void {
  emit("rewind", messageId);
}

const enrichedPrompts = useEnrichedPrompts();
const totalCount = computed(() => enrichedPrompts.value.length);

const filteredPrompts = computed<EnrichedPrompt[]>(() => filterPrompts(enrichedPrompts.value, query.value));

const groups = computed(() => groupByNode(filteredPrompts.value, t("promptNavigator.noNode")));

const visibleRows = computed<VisibleRow[]>(() => buildVisibleRows(groups.value, collapsedNodes.value));

const visibleRowCount = computed(() => countVisibleRows(visibleRows.value));

const searchInputRef = ref<HTMLInputElement | null>(null);
const footerStatusOverride = ref<string | null>(null);
let footerStatusTimer: ReturnType<typeof setTimeout> | null = null;

const messageListRef = injectMessageListRef();

function clearFooterStatusTimer(): void {
  if (footerStatusTimer !== null) {
    clearTimeout(footerStatusTimer);
    footerStatusTimer = null;
  }
}

function setFooterStatus(message: string, durationMs: number): void {
  clearFooterStatusTimer();
  footerStatusOverride.value = message;
  footerStatusTimer = setTimeout(() => {
    footerStatusOverride.value = null;
    footerStatusTimer = null;
  }, durationMs);
}

watch(isOpen, (next) => {
  if (next) {
    nextTick(() => {
      searchInputRef.value?.focus();
    });
    navigatorStore.setActiveIndex(0);
  } else {
    clearFooterStatusTimer();
    footerStatusOverride.value = null;
  }
});

watch(query, () => {
  navigatorStore.setActiveIndex(0);
});

function handleOpenChange(next: boolean): void {
  if (next) {
    navigatorStore.open();
  } else {
    navigatorStore.close();
  }
}

function rowDomId(flatIndex: number): string {
  return `prompt-nav-row-${flatIndex}`;
}

const activeRowId = computed(() => rowDomId(activeIndex.value));

function selectActiveRow(): void {
  for (const row of visibleRows.value) {
    if (row.kind === "row" && row.flatIndex === activeIndex.value) {
      jumpToPrompt(row.prompt);
      return;
    }
  }
}

function jumpToPrompt(prompt: EnrichedPrompt): void {
  const listInstance = messageListRef?.value;
  const found = listInstance?.scrollToMessageId?.(prompt.messageId) ?? false;
  if (found) {
    navigatorStore.flashMessage(prompt.messageId);
    navigatorStore.close();
    return;
  }
  setFooterStatus(t("promptNavigator.notFound"), 2000);
}

function handleRowClick(prompt: EnrichedPrompt): void {
  jumpToPrompt(prompt);
}

function handleRowHover(flatIndex: number): void {
  navigatorStore.setActiveIndex(flatIndex);
}

function handleHeaderClick(key: string): void {
  navigatorStore.toggleNodeCollapsed(key);
}

function handleSearchKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    const max = visibleRowCount.value - 1;
    if (max < 0) return;
    navigatorStore.setActiveIndex(Math.min(activeIndex.value + 1, max));
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (visibleRowCount.value === 0) return;
    navigatorStore.setActiveIndex(Math.max(activeIndex.value - 1, 0));
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    selectActiveRow();
    return;
  }
}

function isActiveRow(flatIndex: number): boolean {
  return flatIndex === activeIndex.value;
}

function highlightHtml(text: string): string {
  return buildHighlight(text, query.value);
}

function rowText(prompt: EnrichedPrompt): string {
  if (prompt.text === "" && prompt.hasNonTextAttachments) {
    return t("promptNavigator.imagePlaceholder");
  }
  return prompt.text;
}
</script>

<template>
  <Dialog :open="isOpen" @update:open="handleOpenChange">
    <DialogContent
      class="max-w-[620px] w-[90vw] max-h-[60vh] p-0 gap-0 overflow-hidden flex flex-col"
      :aria-describedby="undefined"
      :show-close="false"
    >
      <div class="flex items-center gap-2.5 px-3 h-11 border-b border-border shrink-0">
        <Search class="w-4 h-4 text-muted-foreground shrink-0" />
        <input
          ref="searchInputRef"
          v-model="query"
          type="text"
          :placeholder="t('promptNavigator.searchPlaceholder')"
          class="flex-1 bg-transparent outline-none text-sm text-foreground placeholder:text-muted-foreground"
          role="combobox"
          aria-controls="prompt-nav-listbox"
          :aria-activedescendant="visibleRowCount > 0 ? activeRowId : undefined"
          aria-autocomplete="list"
          @keydown="handleSearchKeydown"
        />
        <kbd class="text-[10px] font-mono px-1.5 py-0.5 rounded border border-border text-muted-foreground">esc</kbd>
      </div>

      <div
        id="prompt-nav-listbox"
        role="listbox"
        aria-label="prompt navigator"
        class="flex-1 overflow-y-auto pb-1.5"
      >
        <template v-if="totalCount === 0">
          <div class="px-4 py-10 text-center text-xs text-muted-foreground">
            {{ t("promptNavigator.emptySession") }}
          </div>
        </template>
        <template v-else-if="visibleRowCount === 0">
          <div class="px-4 py-10 text-center text-xs text-muted-foreground">
            {{ t("promptNavigator.noMatches", { query }) }}
          </div>
        </template>
        <template v-else>
          <template v-for="row in visibleRows" :key="row.kind === 'header' ? `h-${row.key}` : `r-${row.flatIndex}`">
            <button
              v-if="row.kind === 'header'"
              type="button"
              class="flex items-center gap-1.5 w-full px-3 pt-0 pb-1 text-left hover:bg-accent/40 sticky top-0 bg-popover z-[1]"
              @click="handleHeaderClick(row.key)"
            >
              <span class="text-muted-foreground inline-flex items-center leading-none">
                <component :is="row.collapsed ? IconChevronRight : IconChevronDown" :size="10" />
              </span>
              <span class="text-[10px] font-mono uppercase tracking-wider text-muted-foreground leading-none">
                {{ row.title }}
              </span>
              <span class="text-[10px] font-mono text-muted-foreground/70 leading-none">({{ row.count }})</span>
            </button>
            <div
              v-else
              :id="rowDomId(row.flatIndex)"
              role="option"
              :aria-selected="isActiveRow(row.flatIndex)"
              :class="[
                'group flex items-start gap-2 px-3 py-2 cursor-pointer transition-colors',
                isActiveRow(row.flatIndex) ? 'bg-accent' : 'hover:bg-accent/50',
              ]"
              @mouseenter="handleRowHover(row.flatIndex)"
              @click="handleRowClick(row.prompt)"
            >
              <span class="text-[10px] font-mono text-muted-foreground w-6 shrink-0 mt-0.5">
                #{{ row.prompt.promptIndex }}
              </span>
              <div class="flex-1 min-w-0">
                <div
                  class="text-[12.5px] text-foreground leading-snug line-clamp-2"
                  v-html="highlightHtml(rowText(row.prompt))"
                />
                <div class="flex flex-wrap items-center gap-1.5 mt-1">
                  <Badge
                    v-if="isRecallMode"
                    variant="outline"
                    class="text-[9px] font-mono px-1.5 py-0.5 leading-none border bg-emerald-500/10 text-emerald-300 border-emerald-500/25"
                  >
                    {{ row.prompt.nodeTitle }}
                  </Badge>
                  <span class="text-[9px] font-mono text-muted-foreground">{{ row.prompt.time }}</span>
                  <span
                    v-if="row.prompt.errored"
                    class="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-error)]"
                    :aria-label="t('common.error')"
                  />
                  <ToolBadge v-for="toolName in row.prompt.tools.slice(0, 4)" :key="toolName" :name="toolName" />
                  <Badge
                    v-if="row.prompt.tools.length > 4"
                    variant="outline"
                    :class="['text-[9px] font-mono px-1.5 py-0.5 leading-none border', getToolColorClass('__overflow__')]"
                  >
                    +{{ row.prompt.tools.length - 4 }}
                  </Badge>
                </div>
              </div>
              <kbd
                v-if="isActiveRow(row.flatIndex)"
                class="text-[9px] font-mono px-1 py-0.5 rounded border border-border self-center shrink-0 text-muted-foreground"
                >↩</kbd
              >
              <PromptKebabMenu
                :prompt="row.prompt"
                :can-rewind="canRewindFor(row.prompt)"
                @edit-and-resend="handleEditAndResend"
                @rewind="handleRewind"
              />
            </div>
          </template>
        </template>
      </div>

      <div class="flex items-center justify-between px-3 h-7 border-t border-border bg-card/50 text-[10px] font-mono text-muted-foreground shrink-0">
        <span>
          {{
            footerStatusOverride
              ?? t("promptNavigator.status", { filtered: filteredPrompts.length, total: totalCount })
          }}
        </span>
        <div class="flex items-center gap-3">
          <kbd class="px-1.5 py-0.5 rounded text-[10px] bg-muted">{{ t("promptNavigator.kbd.nav") }}</kbd>
          <kbd class="px-1.5 py-0.5 rounded text-[10px] bg-muted">{{ t("promptNavigator.kbd.jump") }}</kbd>
          <kbd class="px-1.5 py-0.5 rounded text-[10px] bg-muted">{{ t("promptNavigator.kbd.toggle", { key: toggleShortcut }) }}</kbd>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
