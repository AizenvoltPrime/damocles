<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { storeToRefs } from "pinia";
import type { ChatMessage } from "@shared/types/session";
import { isImageBlock, type ImageBlock } from "@shared/types/content";
import MarkdownRenderer from "./MarkdownRenderer.vue";
import UserMessageImageChip from "./UserMessageImageChip.vue";
import TerminalAttachmentChip from "./TerminalAttachmentChip.vue";
import { ArrowUp, Check, ChevronDown, ChevronRight, ChevronUp, Copy, Database, Pin, RotateCcw, X } from "lucide-vue-next";
import { formatClock } from "@/utils/clock";
import { useCopyToClipboard } from "@/composables/useCopyToClipboard";
import { useUserMessageMaxHeight } from "@/composables/useUserMessageMaxHeight";
import { useMessageHighlightStore } from "@/stores/useMessageHighlightStore";
import { USER_PROMPT_FILTER } from "@/composables/useEnrichedPrompts";

const { t, locale } = useI18n();

const props = withDefaults(
  defineProps<{
    message: ChatMessage;
    messageIndex: number;
    canRewind: boolean;
    promptIndex: number;
    mode?: "canvas" | "pinned" | undefined;
    offset?: number | undefined;
    expanded?: boolean | undefined;
  }>(),
  {
    mode: "canvas",
    offset: 0,
    expanded: false,
  },
);

const emit = defineEmits<{
  (e: "rewind", message: ChatMessage): void;
  (e: "viewContext", promptIndex: number): void;
  (e: "openLightbox", block: ImageBlock): void;
  (e: "scrollToPrimary"): void;
  (e: "toggle-expanded"): void;
  (e: "hide-pinned"): void;
}>();

const { hasCopied, copyToClipboard } = useCopyToClipboard(2000);

const imageBlocks = computed<ImageBlock[]>(() => {
  if (!props.message.contentBlocks) return [];
  return props.message.contentBlocks.filter(isImageBlock);
});

const isInjectedOrQueued = computed(() => !USER_PROMPT_FILTER(props.message));

const { flashedMessageId } = storeToRefs(useMessageHighlightStore());
const isHighlighted = computed(() => flashedMessageId.value === props.message.id);

const borderColorClass = computed(() => {
  if (isHighlighted.value) return "border-(--d-accent)";
  if (isInjectedOrQueued.value) return "border-[color-mix(in_srgb,var(--d-warning)_35%,var(--d-border2))]";
  return "border-(--d-border2)";
});

const time = computed(() => formatClock(props.message.timestamp, locale.value));

function handleCopy(): void {
  if (props.message.content) void copyToClipboard(props.message.content);
}

const isPinned = computed(() => props.mode === "pinned");
const showScrollUp = computed(() => isPinned.value && props.offset === 0);

/** `max-h-40`, the collapsed card's height. */
const COLLAPSED_REM = 10;
const cardRef = ref<HTMLElement | null>(null);
const contentRef = ref<HTMLElement | null>(null);
const naturalHeight = ref<number>(0);
const isOverflowing = computed(() => naturalHeight.value > COLLAPSED_REM * parseFloat(getComputedStyle(document.documentElement).fontSize));
const isCollapsed = computed(() => !props.expanded && isOverflowing.value);

const surfaceClass = computed(() =>
  isInjectedOrQueued.value ? "bg-[color-mix(in_srgb,var(--d-warning)_8%,var(--d-card))]" : "bg-(--d-card)",
);
const fadeFromClass = computed(() =>
  isInjectedOrQueued.value ? "from-[color-mix(in_srgb,var(--d-warning)_8%,var(--d-card))]" : "from-(--d-card)",
);

const { maxHeightVh, clamp: clampVh } = useUserMessageMaxHeight();
const scrollAreaStyle = computed(() =>
  isCollapsed.value ? undefined : { maxHeight: `max(${maxHeightVh.value}vh, ${COLLAPSED_REM}rem)` },
);

let dragStartY = 0;
let dragStartHeightPx = 0;

function onResizeStart(e: PointerEvent): void {
  e.preventDefault();
  const handle = e.currentTarget as HTMLElement;
  handle.setPointerCapture(e.pointerId);
  dragStartY = e.clientY;
  dragStartHeightPx = (window.innerHeight * maxHeightVh.value) / 100;
  document.body.style.cursor = "ns-resize";
  handle.addEventListener("pointermove", onResizeMove);
  handle.addEventListener("pointerup", onResizeEnd);
  handle.addEventListener("pointercancel", onResizeEnd);
}

function onResizeMove(e: PointerEvent): void {
  const deltaPx = e.clientY - dragStartY;
  const newPx = dragStartHeightPx + deltaPx;
  maxHeightVh.value = clampVh((newPx / window.innerHeight) * 100);
}

function onResizeEnd(e: PointerEvent): void {
  const handle = e.currentTarget as HTMLElement;
  try {
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
  } finally {
    document.body.style.cursor = "";
    handle.removeEventListener("pointermove", onResizeMove);
    handle.removeEventListener("pointerup", onResizeEnd);
    handle.removeEventListener("pointercancel", onResizeEnd);
  }
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  const el = contentRef.value;
  if (!el) return;
  naturalHeight.value = el.scrollHeight;
  resizeObserver = new ResizeObserver(() => {
    if (contentRef.value) naturalHeight.value = contentRef.value.scrollHeight;
  });
  resizeObserver.observe(el);
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<template>
  <div :class="isPinned ? '' : 'flex justify-end pt-1.5'">
    <div
      ref="cardRef"
      class="group relative min-w-0 border bubble-fade-transitions"
      :class="[
        surfaceClass,
        borderColorClass,
        isHighlighted && 'is-highlighted',
        isPinned
          ? 'w-full rounded-[0.875rem] px-3.5 pt-2.25 pb-2.75 shadow-(--d-shadow) animate-[d-pop_.18s_var(--ease-out)]'
          : 'max-w-[88%] rounded-[1rem_1rem_0.3125rem_1rem] px-3.75 pt-2.75 pb-3 shadow-[inset_0_1px_0_rgba(255,255,255,.03)]',
      ]"
    >
      <div
        class="mb-1 flex min-w-0 flex-wrap items-center gap-2 text-11 whitespace-nowrap"
        :class="isInjectedOrQueued ? 'text-(--d-faint-text)' : 'text-(--d-faint)'"
      >
        <Pin
          v-if="isPinned"
          class="size-3 flex-none text-(--d-accent)"
          aria-hidden="true"
        />
        <span class="flex-none font-semibold text-(--d-muted)">{{ t("pinned.you") }}</span>
        <span
          class="flex-none tabular-nums"
          data-testid="user-message-time"
        >{{ time }}</span>
        <span
          v-if="isPinned && !isInjectedOrQueued"
          class="min-w-0 truncate font-mono"
          data-testid="pinned-prompt-index"
        >· {{ t("pinned.prompt", { n: promptIndex + 1 }) }}</span>
        <template v-if="isInjectedOrQueued">
          <span
            v-if="message.steerTarget"
            class="max-w-[16rem] truncate rounded-5 bg-[color-mix(in_srgb,var(--d-warning)_14%,transparent)] px-1.5 font-medium text-(--d-warning-text)"
          >
            {{ t("steerCommand.youSteered", { agent: message.steerTarget.description ?? message.steerTarget.agentId.slice(0, 8) }) }}
          </span>
          <span
            v-else-if="message.isCommandEcho"
            class="rounded-5 bg-[color-mix(in_srgb,var(--d-warning)_14%,transparent)] px-1.5 font-medium text-(--d-warning-text)"
            data-user-label="command"
          >{{ t("welcome.commandEcho") }}</span>
          <template v-else>
            <span
              class="rounded-5 bg-[color-mix(in_srgb,var(--d-warning)_14%,transparent)] px-1.5 font-medium text-(--d-warning-text)"
              data-user-label="mid-stream"
            >{{ t("welcome.sentMidStream") }}</span>
            <span
              v-if="message.isQueued"
              class="rounded-5 bg-[color-mix(in_srgb,var(--d-warning)_14%,transparent)] px-1.5 font-medium text-(--d-warning-text)"
            >{{ t("welcome.queued") }}</span>
          </template>
        </template>
        <span class="min-w-0 flex-1" />
        <div class="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          <button
            v-if="isOverflowing"
            type="button"
            class="flex flex-none rounded-5 p-0.75 transition-colors hover:bg-(--d-hover) hover:text-(--d-text)"
            :title="props.expanded ? t('common.collapse') : t('common.expand')"
            :aria-label="props.expanded ? t('common.collapse') : t('common.expand')"
            :aria-expanded="props.expanded"
            data-testid="user-message-expand"
            @click="emit('toggle-expanded')"
          >
            <ChevronUp
              v-if="props.expanded"
              class="size-3"
              aria-hidden="true"
            />
            <ChevronDown
              v-else
              class="size-3"
              aria-hidden="true"
            />
          </button>
          <button
            v-if="showScrollUp"
            type="button"
            class="flex flex-none rounded-5 p-0.75 transition-colors hover:bg-(--d-hover) hover:text-(--d-text)"
            :title="t('userMessage.scrollToTopTitle')"
            :aria-label="t('userMessage.scrollToTopTitle')"
            data-testid="pinned-scroll-to"
            @click="emit('scrollToPrimary')"
          >
            <ArrowUp
              class="size-3"
              aria-hidden="true"
            />
          </button>
          <button
            v-if="canRewind && !isInjectedOrQueued"
            type="button"
            class="flex flex-none rounded-5 p-0.75 transition-colors hover:bg-(--d-hover) hover:text-(--d-text)"
            :title="t('userMessage.rewindAria')"
            :aria-label="t('userMessage.rewindAria')"
            data-testid="user-message-rewind"
            @click="emit('rewind', props.message)"
          >
            <RotateCcw
              class="size-3"
              aria-hidden="true"
            />
          </button>
          <button
            v-if="message.content"
            type="button"
            class="flex flex-none rounded-5 p-0.75 transition-colors hover:bg-(--d-hover) hover:text-(--d-text)"
            :class="{ 'text-(--d-success)': hasCopied }"
            :title="hasCopied ? t('userMessage.copiedTitle') : t('userMessage.copyTitle')"
            :aria-label="hasCopied ? t('userMessage.copiedAria') : t('userMessage.copyAria')"
            data-testid="user-message-copy"
            @click="handleCopy"
          >
            <Check
              v-if="hasCopied"
              class="size-3"
              aria-hidden="true"
            />
            <Copy
              v-else
              class="size-3"
              aria-hidden="true"
            />
          </button>
          <button
            v-if="isPinned"
            type="button"
            class="flex flex-none rounded-5 p-0.75 transition-colors hover:bg-(--d-hover) hover:text-(--d-text)"
            :title="t('userMessage.hidePinnedTitle')"
            :aria-label="t('userMessage.hidePinnedAria')"
            data-testid="pinned-hide"
            @click="emit('hide-pinned')"
          >
            <X
              class="size-3"
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      <div
        class="relative"
        :class="isCollapsed && 'max-h-40 overflow-hidden'"
      >
        <div
          ref="contentRef"
          class="overflow-x-hidden overflow-y-auto overscroll-contain"
          :style="scrollAreaStyle"
        >
          <div
            v-if="message.terminalAttachments?.length"
            class="mb-2 flex flex-wrap gap-1.5"
            data-testid="user-message-terminal-attachments"
          >
            <TerminalAttachmentChip
              v-for="attachment in message.terminalAttachments"
              :key="attachment.id"
              :attachment="attachment"
            />
          </div>
          <div
            v-if="imageBlocks.length > 0"
            class="mb-2 flex flex-wrap gap-1.5"
          >
            <UserMessageImageChip
              v-for="(img, index) in imageBlocks"
              :key="index"
              :block="img"
              @open-lightbox="emit('openLightbox', $event)"
            />
          </div>
          <MarkdownRenderer
            v-if="message.content"
            :content="message.content"
            class="text-(--d-text)"
          />
        </div>
        <div
          v-if="isCollapsed"
          aria-hidden="true"
          class="pointer-events-none absolute inset-x-0 bottom-0 h-8.5 bg-linear-to-t to-transparent"
          :class="fadeFromClass"
        />
      </div>

      <div
        v-if="!isCollapsed && isOverflowing"
        class="group/resize flex cursor-ns-resize touch-none justify-center pt-2 select-none"
        :title="t('userMessage.resizeTitle')"
        data-testid="user-message-resize"
        @pointerdown="onResizeStart"
      >
        <div class="h-1 w-10 rounded-full bg-(--d-border2) transition-colors group-hover/resize:bg-(--d-accent)" />
      </div>

      <span
        class="sr-only"
        role="status"
        aria-live="polite"
      >
        {{ hasCopied ? t("userMessage.copiedAnnouncement") : "" }}
      </span>

      <button
        v-if="!isInjectedOrQueued && !isCollapsed"
        type="button"
        class="mt-2.25 inline-flex max-w-full items-center gap-1.5 rounded-full bg-(--d-accent-soft) px-2.25 py-0.5 text-11 font-medium text-(--d-accent-text) transition-colors hover:bg-[color-mix(in_srgb,var(--d-accent)_22%,transparent)]"
        :title="t('contextInjection.viewContext')"
        data-testid="user-message-context"
        @click.stop="emit('viewContext', promptIndex)"
      >
        <Database
          class="size-2.5 shrink-0"
          aria-hidden="true"
        />
        <span class="min-w-0">{{ t("contextInjection.viewContext") }}</span>
        <ChevronRight
          class="size-2.5 shrink-0"
          aria-hidden="true"
        />
      </button>
    </div>
  </div>
</template>
