<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { storeToRefs } from "pinia";
import { Check, Copy, List, PencilLine, RotateCcw, Search } from "lucide-vue-next";
import OverlayShell from "./OverlayShell.vue";
import SlidingIndicator from "./SlidingIndicator.vue";
import { usePromptNavigatorStore } from "@/stores/usePromptNavigatorStore";
import { useMessageHighlightStore } from "@/stores/useMessageHighlightStore";
import { useSessionStore } from "@/stores";
import { useEnrichedPrompts, type EnrichedPrompt } from "@/composables/useEnrichedPrompts";
import { injectMessageListRef } from "@/composables/useMessageListRef";
import { useSlidingIndicator } from "@/composables/useSlidingIndicator";
import { metaKeyShortcut } from "@/composables/usePlatformKey";
import { useCopyToClipboard } from "@/composables/useCopyToClipboard";
import { canRewindForPrompt, filterPrompts, highlight as buildHighlight } from "./promptNavigatorLogic";

const MAX_TOOL_CHIPS = 4;
const toggleShortcut = metaKeyShortcut("k");

const { t } = useI18n();
const navigatorStore = usePromptNavigatorStore();
const highlightStore = useMessageHighlightStore();
const { query, activeIndex } = storeToRefs(navigatorStore);
const { checkpointMessages } = storeToRefs(useSessionStore());

const emit = defineEmits<{
  editAndResend: [text: string];
  rewind: [messageId: string];
}>();

const enrichedPrompts = useEnrichedPrompts();
const totalCount = computed(() => enrichedPrompts.value.length);
const filteredPrompts = computed<EnrichedPrompt[]>(() => filterPrompts(enrichedPrompts.value, query.value));

const statusOverride = ref<string | null>(null);
let statusTimer: ReturnType<typeof setTimeout> | null = null;
const copiedId = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

// Rows rise in only while the overlay opens; a filter keystroke re-renders them in place.
const arriving = ref(true);
let arrivalTimer: ReturnType<typeof setTimeout> | null = null;
onMounted(() => {
  navigatorStore.setActiveIndex(0);
  arrivalTimer = setTimeout(() => (arriving.value = false), 500);
});
onBeforeUnmount(() => {
  for (const timer of [statusTimer, copiedTimer, arrivalTimer]) if (timer !== null) clearTimeout(timer);
});

watch(query, () => navigatorStore.setActiveIndex(0));

const list = shallowRef<HTMLElement | null>(null);
const { box, animate } = useSlidingIndicator(list, '[role="option"]', activeIndex);

const messageListRef = injectMessageListRef();
const { copyToClipboard } = useCopyToClipboard();

function showStatus(message: string): void {
  if (statusTimer !== null) clearTimeout(statusTimer);
  statusOverride.value = message;
  statusTimer = setTimeout(() => {
    statusOverride.value = null;
    statusTimer = null;
  }, 2000);
}

function rowId(index: number): string {
  return `prompt-nav-row-${index}`;
}

function jumpTo(prompt: EnrichedPrompt): void {
  const found = messageListRef?.value?.scrollToMessageId?.(prompt.messageId) ?? false;
  if (!found) {
    showStatus(t("promptNavigator.notFound"));
    return;
  }
  highlightStore.flashMessage(prompt.messageId);
  navigatorStore.close();
}

function scrollActiveIntoView(): void {
  list.value?.querySelectorAll<HTMLElement>('[role="option"]')[activeIndex.value]?.scrollIntoView({ block: "nearest" });
}

function onSearchKeydown(event: KeyboardEvent): void {
  const count = filteredPrompts.value.length;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (count === 0) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    navigatorStore.setActiveIndex(Math.min(Math.max(activeIndex.value + step, 0), count - 1));
    scrollActiveIntoView();
  } else if (event.key === "Enter") {
    event.preventDefault();
    const prompt = filteredPrompts.value[activeIndex.value];
    if (prompt) jumpTo(prompt);
  }
}

async function copyPrompt(prompt: EnrichedPrompt): Promise<void> {
  if (!(await copyToClipboard(prompt.text))) {
    showStatus(t("promptNavigator.copyFailed"));
    return;
  }
  copiedId.value = prompt.messageId;
  if (copiedTimer !== null) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copiedId.value = null;
    copiedTimer = null;
  }, 1200);
}

function canRewind(prompt: EnrichedPrompt): boolean {
  return canRewindForPrompt(prompt, checkpointMessages.value);
}

function rowText(prompt: EnrichedPrompt): string {
  return prompt.text === "" && prompt.hasNonTextAttachments ? t("promptNavigator.imagePlaceholder") : prompt.text;
}

const statusText = computed(() => statusOverride.value ?? t("promptNavigator.status", { filtered: filteredPrompts.value.length, total: totalCount.value }));
</script>

<template>
  <OverlayShell
    :title="t('overlays.navigator.title')"
    :subtitle="t('overlays.navigator.subtitle')"
    :icon="List"
    data-testid="prompt-navigator"
    @close="navigatorStore.close()"
  >
    <div class="flex flex-col gap-2.5 px-4 pt-3 pb-4">
      <label class="flex h-9 items-center gap-2 rounded-10 border border-(--d-border2) bg-(--d-input) px-3 transition-[border-color,box-shadow] focus-within:border-(--d-accent) focus-within:shadow-[0_0_0_4px_var(--d-accent-soft)]">
        <Search
          class="size-3.5 flex-none text-(--d-faint)"
          aria-hidden="true"
        />
        <span class="sr-only">{{ t("promptNavigator.searchPlaceholder") }}</span>
        <input
          v-model="query"
          type="text"
          class="min-w-0 flex-1 border-0 bg-transparent text-(--d-text) outline-none placeholder:text-(--d-faint)"
          :placeholder="t('promptNavigator.searchPlaceholder')"
          role="combobox"
          aria-controls="prompt-nav-listbox"
          :aria-expanded="filteredPrompts.length > 0"
          :aria-activedescendant="filteredPrompts.length > 0 ? rowId(activeIndex) : undefined"
          aria-autocomplete="list"
          data-overlay-initial-focus
          data-testid="prompt-navigator-search"
          @keydown="onSearchKeydown"
        >
        <span
          class="flex-none text-11 whitespace-nowrap text-(--d-faint)"
          role="status"
          data-testid="prompt-navigator-status"
        >{{ statusText }}</span>
      </label>

      <p
        v-if="filteredPrompts.length === 0"
        class="p-7.5 text-center text-(--d-faint)"
      >
        {{ totalCount === 0 ? t("promptNavigator.emptySession") : t("promptNavigator.noMatches", { query }) }}
      </p>

      <div
        v-else
        id="prompt-nav-listbox"
        ref="list"
        role="listbox"
        :aria-label="t('promptNavigator.listLabel')"
        class="relative flex flex-col gap-2.5"
      >
        <SlidingIndicator
          variant="ring"
          :box="box"
          :radius="11"
          :animate="animate"
          class="z-1 text-(--d-accent)"
        />
        <div
          v-for="(prompt, index) in filteredPrompts"
          :id="rowId(index)"
          :key="prompt.messageId"
          role="option"
          :aria-selected="index === activeIndex"
          class="group flex gap-3 rounded-11 border border-(--d-border) bg-(--d-card) px-3 py-2.5"
          :class="arriving && 'd-arrive'"
          :style="arriving ? { animationDelay: `${Math.min(index, 8) * 25}ms` } : undefined"
          data-testid="prompt-navigator-row"
          @mouseenter="navigatorStore.setActiveIndex(index)"
          @click="jumpTo(prompt)"
        >
          <span
            class="relative z-2 flex size-6 flex-none items-center justify-center rounded-7 bg-(--d-hover) font-mono text-11 text-(--d-muted)"
            aria-hidden="true"
          >{{ prompt.promptIndex + 1 }}</span>
          <div class="relative z-2 min-w-0 flex-1">
            <div
              class="line-clamp-2 text-pretty [&_mark]:rounded-sm [&_mark]:bg-(--d-accent-soft) [&_mark]:px-0.5 [&_mark]:text-(--d-accent-text)"
              v-html="buildHighlight(rowText(prompt), query)"
            />
            <div
              class="mt-1.25 flex flex-wrap items-center gap-1.25 text-11"
              :class="index === activeIndex ? 'text-(--d-faint-text)' : 'text-(--d-faint)'"
            >
              <span class="tabular-nums">{{ prompt.time }}</span>
              <span
                v-if="prompt.errored"
                class="size-1.5 rounded-full bg-(--d-danger)"
                role="img"
                :aria-label="t('common.error')"
              />
              <span
                v-for="tool in prompt.tools.slice(0, MAX_TOOL_CHIPS)"
                :key="tool"
                class="rounded-5 bg-(--d-hover) px-1.5 font-mono text-10.5 text-(--d-muted)"
              >{{ tool }}</span>
              <span
                v-if="prompt.tools.length > MAX_TOOL_CHIPS"
                class="rounded-5 bg-(--d-hover) px-1.5 font-mono text-10.5 text-(--d-muted)"
              >+{{ prompt.tools.length - MAX_TOOL_CHIPS }}</span>
            </div>
          </div>
          <!-- Only the active row's actions are in the Tab order: Tab from the search box reaches them, never three stops per row. -->
          <div
            class="relative z-2 flex flex-none items-start gap-0.5 transition-opacity duration-150"
            :class="index === activeIndex ? 'opacity-100' : 'opacity-35 group-focus-within:opacity-100'"
          >
            <button
              type="button"
              class="flex rounded-md p-1.25 transition-colors hover:bg-(--d-border2) hover:text-(--d-text)"
              :class="copiedId === prompt.messageId ? 'text-(--d-success)' : 'text-(--d-muted)'"
              :title="copiedId === prompt.messageId ? t('promptNavigator.kebab.copied') : t('promptNavigator.kebab.copy')"
              :aria-label="copiedId === prompt.messageId ? t('promptNavigator.kebab.copied') : t('promptNavigator.kebab.copy')"
              :tabindex="index === activeIndex ? undefined : -1"
              data-testid="prompt-navigator-copy"
              @click.stop="copyPrompt(prompt)"
            >
              <Check
                v-if="copiedId === prompt.messageId"
                class="size-3.25"
                aria-hidden="true"
              />
              <Copy
                v-else
                class="size-3.25"
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              class="flex rounded-md p-1.25 text-(--d-muted) transition-colors hover:bg-(--d-border2) hover:text-(--d-text)"
              :title="t('promptNavigator.kebab.editTooltip')"
              :aria-label="t('promptNavigator.kebab.editAndResend')"
              :tabindex="index === activeIndex ? undefined : -1"
              data-testid="prompt-navigator-draft"
              @click.stop="emit('editAndResend', prompt.text)"
            >
              <PencilLine
                class="size-3.25"
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              class="flex rounded-md p-1.25 text-(--d-muted) transition-colors enabled:hover:bg-(--d-border2) enabled:hover:text-(--d-text) disabled:opacity-40"
              :disabled="!canRewind(prompt)"
              :title="canRewind(prompt) ? t('promptNavigator.kebab.rewind') : t('promptNavigator.kebab.rewindDisabledTooltip')"
              :aria-label="t('promptNavigator.kebab.rewind')"
              :tabindex="index === activeIndex ? undefined : -1"
              data-testid="prompt-navigator-rewind"
              @click.stop="emit('rewind', prompt.messageId)"
            >
              <RotateCcw
                class="size-3.25"
                aria-hidden="true"
              />
            </button>
          </div>
        </div>
      </div>

      <div
        class="flex justify-center gap-3.5 pt-1 font-mono text-11 text-(--d-faint)"
        aria-hidden="true"
      >
        <span>{{ t("promptNavigator.kbd.nav") }}</span>
        <span>{{ t("promptNavigator.kbd.jump") }}</span>
        <span>{{ t("promptNavigator.kbd.toggle", { key: toggleShortcut }) }}</span>
      </div>
    </div>
  </OverlayShell>
</template>
