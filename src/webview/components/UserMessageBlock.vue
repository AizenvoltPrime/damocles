<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { storeToRefs } from "pinia";
import type { ChatMessage } from "@shared/types/session";
import type { ImageBlock } from "@shared/types/content";
import MarkdownRenderer from "./MarkdownRenderer.vue";
import UserMessageImageChip from "./UserMessageImageChip.vue";
import { isImageContentBlock } from "@/utils/imageUtils";
import { Button } from "@/components/ui/button";
import { IconDatabase, IconChevronRight, IconChevronDown, IconChevronUp, IconCopy, IconCheck, IconRotateLeft, IconArrowUp, IconX } from "@/components/icons";
import { useCopyToClipboard } from "@/composables/useCopyToClipboard";
import { useUserMessageMaxHeight } from "@/composables/useUserMessageMaxHeight";
import { usePromptNavigatorStore } from "@/stores/usePromptNavigatorStore";

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    message: ChatMessage;
    messageIndex: number;
    canRewind: boolean;
    promptIndex: number;
    mode?: "canvas" | "pinned";
    offset?: number;
    expanded?: boolean;
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
  return props.message.contentBlocks.filter(isImageContentBlock);
});

const isInjectedOrQueued = computed(() => props.message.isInjected || props.message.isCombinedQueue || props.message.isQueued);

const { flashedMessageId } = storeToRefs(usePromptNavigatorStore());
const isHighlighted = computed(() => flashedMessageId.value === props.message.id);

const borderColorClass = computed(() => {
  if (isHighlighted.value) return "border-primary/70";
  if (isInjectedOrQueued.value) return "border-warning/25";
  return "border-border";
});

function handleCopy(): void {
  if (props.message.content) void copyToClipboard(props.message.content);
}

const isPinned = computed(() => props.mode === "pinned");
const showScrollUp = computed(() => isPinned.value && props.offset === 0);

const COLLAPSED_PX = 160;
const cardRef = ref<HTMLElement | null>(null);
const contentRef = ref<HTMLElement | null>(null);
const naturalHeight = ref<number>(0);
const isOverflowing = computed(() => naturalHeight.value > COLLAPSED_PX);
const isCollapsed = computed(() => !props.expanded && isOverflowing.value);

const fadeFromClass = computed(() =>
  isInjectedOrQueued.value ? "from-[color-mix(in_srgb,var(--color-warning)_10%,var(--background))]" : "from-muted/[0.98]",
);

const { maxHeightVh, clamp: clampVh } = useUserMessageMaxHeight();
const scrollAreaStyle = computed(() =>
  isCollapsed.value ? undefined : { maxHeight: `max(${maxHeightVh.value}vh, ${COLLAPSED_PX}px)` },
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
  <div class="flex justify-center px-2 py-2">
    <div class="w-full">
      <div
        ref="cardRef"
        class="group relative rounded-xl border px-4 py-3 bubble-fade-transitions"
        :class="[
          isInjectedOrQueued
            ? isPinned
              ? 'bg-[color-mix(in_srgb,var(--color-warning)_10%,var(--background))]'
              : 'bg-warning/10'
            : isPinned
              ? 'bg-muted/[0.98]'
              : 'bg-muted/75 group-hover:shadow-md',
          borderColorClass,
          isHighlighted && 'is-highlighted',
          isPinned ? 'shadow-md ring-1 ring-border/40' : 'shadow-sm',
          isCollapsed && 'max-h-40 overflow-hidden',
        ]"
      >
        <div v-if="isInjectedOrQueued" class="flex items-center gap-2 mb-2 text-xs text-warning/80">
          <span class="px-1.5 py-0.5 rounded bg-warning/15 border border-warning/30">
            {{ t("welcome.sentMidStream") }}
          </span>
          <span v-if="message.isQueued" class="px-1.5 py-0.5 rounded bg-warning/15 border border-warning/30">
            {{ t("welcome.queued") }}
          </span>
        </div>

        <div ref="contentRef" class="pr-12 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]" :style="scrollAreaStyle">
          <div v-if="imageBlocks.length > 0" class="flex flex-wrap gap-1.5 mb-2">
            <UserMessageImageChip v-for="img in imageBlocks" :key="img.source.data" :block="img" @open-lightbox="emit('openLightbox', $event)" />
          </div>

          <MarkdownRenderer v-if="message.content" :content="message.content" class="text-foreground" />
        </div>

        <div
          v-if="!isCollapsed && isOverflowing"
          class="flex justify-center py-3 touch-none select-none cursor-ns-resize group/resize"
          :title="t('userMessage.resizeTitle')"
          @pointerdown="onResizeStart"
        >
          <div class="h-1 w-10 rounded-full bg-border/60 group-hover/resize:bg-primary/70 motion-safe:transition-colors" />
        </div>

        <div
          v-if="isCollapsed"
          aria-hidden="true"
          class="absolute bottom-0 left-0 right-0 h-10 pointer-events-none bg-gradient-to-t to-transparent"
          :class="fadeFromClass"
        />

        <div
          class="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 motion-safe:transition-opacity motion-safe:duration-150"
        >
          <Button
            v-if="isOverflowing"
            variant="ghost"
            size="icon-sm"
            class="h-6 w-6 text-muted-foreground hover:text-foreground focus-visible:opacity-100"
            :title="props.expanded ? t('common.collapse') : t('common.expand')"
            :aria-expanded="props.expanded"
            @click="emit('toggle-expanded')"
          >
            <IconChevronUp v-if="props.expanded" :size="12" />
            <IconChevronDown v-else :size="12" />
          </Button>
          <Button
            v-if="showScrollUp"
            variant="ghost"
            size="icon-sm"
            class="h-6 w-6 text-muted-foreground hover:text-foreground focus-visible:opacity-100"
            :title="t('userMessage.scrollToTopTitle')"
            @click="emit('scrollToPrimary')"
          >
            <IconArrowUp :size="12" />
          </Button>
          <Button
            v-if="canRewind && !isInjectedOrQueued"
            variant="ghost"
            size="icon-sm"
            class="h-6 w-6 text-muted-foreground hover:text-foreground focus-visible:opacity-100"
            :title="t('welcome.undoChanges')"
            :aria-label="t('userMessage.rewindAria')"
            @click="emit('rewind', props.message)"
          >
            <IconRotateLeft :size="12" />
          </Button>
          <Button
            v-if="message.content"
            variant="ghost"
            size="icon-sm"
            class="h-6 w-6 text-muted-foreground hover:text-foreground focus-visible:opacity-100"
            :class="{ 'text-success': hasCopied }"
            :title="hasCopied ? t('userMessage.copiedTitle') : t('userMessage.copyTitle')"
            :aria-label="hasCopied ? t('userMessage.copiedAria') : t('userMessage.copyAria')"
            @click="handleCopy"
          >
            <IconCheck v-if="hasCopied" :size="12" />
            <IconCopy v-else :size="12" />
          </Button>
          <Button
            v-if="isPinned"
            variant="ghost"
            size="icon-sm"
            class="h-6 w-6 text-muted-foreground hover:text-foreground focus-visible:opacity-100"
            :title="t('userMessage.hidePinnedTitle')"
            :aria-label="t('userMessage.hidePinnedAria')"
            @click="emit('hide-pinned')"
          >
            <IconX :size="12" />
          </Button>
        </div>

        <span class="sr-only" role="status" aria-live="polite">
          {{ hasCopied ? t("userMessage.copiedAnnouncement") : "" }}
        </span>

        <button
          v-if="!isInjectedOrQueued && !isCollapsed"
          type="button"
          class="group/ctx flex items-center gap-1.5 mt-2.5 px-2 py-0.5 rounded-full text-xs font-medium text-primary/50 bg-primary/5 border border-primary/10 hover:text-primary hover:bg-primary/10 hover:border-primary/20 motion-safe:transition-all motion-safe:duration-200 cursor-pointer"
          :title="t('contextInjection.viewContext')"
          @click.stop="emit('viewContext', promptIndex)"
        >
          <span class="relative flex h-1.5 w-1.5 shrink-0">
            <span
              class="absolute inline-flex h-full w-full rounded-full bg-primary opacity-0 group-hover/ctx:opacity-40 group-hover/ctx:animate-ping"
            />
            <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary/70" />
          </span>
          <IconDatabase :size="10" class="shrink-0 opacity-60 group-hover/ctx:opacity-100 motion-safe:transition-opacity" />
          <span>{{ t("contextInjection.viewContext") }}</span>
          <IconChevronRight
            :size="8"
            class="shrink-0 opacity-0 -ml-0.5 group-hover/ctx:opacity-60 group-hover/ctx:ml-0 motion-safe:transition-all motion-safe:duration-200"
          />
        </button>
      </div>
    </div>
  </div>
</template>
