<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { SquareTerminal, X } from "lucide-vue-next";
import type { TerminalAttachmentInfo } from "@shared/types/terminal-attachment";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { terminalAttachmentLabel, terminalAttachmentParts } from "@/utils/terminal-attachment-label";

// Terminal output attached to a message: a chip that previews the output on hover or click, removable while it waits in
// the composer.
const props = defineProps<{ attachment: TerminalAttachmentInfo; removable?: boolean }>();
const emit = defineEmits<{ remove: [id: string] }>();
const { t } = useI18n();

// ms the pointer rests on the chip before the preview opens, and may wander off before it closes.
const HOVER_OPEN_MS = 450;
const HOVER_CLOSE_MS = 160;

const parts = computed(() => terminalAttachmentParts(props.attachment, t));
const label = computed(() => terminalAttachmentLabel(props.attachment, t));
const tone = computed(() => {
  if (props.attachment.exitCode === null) return "accent";
  return props.attachment.exitCode === 0 ? "success" : "danger";
});
const previewTitle = computed(() =>
  props.attachment.source === "command" && props.attachment.commandLine
    ? props.attachment.commandLine
    : t("terminalAttachment.selectionFrom", { terminal: props.attachment.terminalTitle }),
);
const shownLines = computed(() => (props.attachment.preview === "" ? 0 : props.attachment.preview.split("\n").length));

const open = ref(false);
// A preview the pointer opened neither takes focus nor outlives the pointer; one opened by a click or key does both.
const openedByHover = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

function schedule(next: boolean, ms: number): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (next && !open.value) {
      openedByHover.value = true;
      open.value = true;
    } else if (!next && openedByHover.value) open.value = false;
  }, ms);
}

function onOpenChange(next: boolean): void {
  clearTimeout(timer);
  openedByHover.value = false;
  open.value = next;
}

function onOpenAutoFocus(event: Event): void {
  if (openedByHover.value) event.preventDefault();
}

onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div
    class="terminal-attachment-chip group/chip inline-flex h-7 max-w-full min-w-0 items-center rounded-full border border-(--d-border2) bg-(--d-card) text-xs text-(--d-text) transition-colors hover:border-(--d-accent)"
    data-testid="terminal-attachment-chip"
    :data-attachment-id="attachment.id"
    :data-tone="tone"
  >
    <Popover
      :open="open"
      @update:open="onOpenChange"
    >
      <PopoverTrigger as-child>
        <Button
          variant="ghost"
          class="d-press h-full min-w-0 gap-1.5 rounded-full py-0 ps-0.75 hover:bg-transparent hover:text-(--d-text)"
          :class="removable ? 'pe-1' : 'pe-2.5'"
          :aria-label="t('terminalAttachment.preview', { label })"
          data-testid="terminal-attachment-preview-button"
          @pointerenter="schedule(true, HOVER_OPEN_MS)"
          @pointerleave="schedule(false, HOVER_CLOSE_MS)"
        >
          <span
            class="flex size-5.5 shrink-0 items-center justify-center rounded-full"
            :class="`d-tone-${tone} bg-[color-mix(in_srgb,var(--tone)_16%,transparent)]`"
            aria-hidden="true"
          >
            <SquareTerminal class="size-3" />
          </span>
          <span class="min-w-0 truncate font-mono text-11.5">{{ parts.head }}</span>
          <span
            v-for="(detail, index) in parts.details"
            :key="index"
            class="shrink-0 text-11 text-(--d-muted)"
            aria-hidden="true"
          ><span class="px-0.5 text-(--d-faint)">·</span>{{ detail }}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        class="w-lg max-w-[calc(100vw-2rem)] border-(--d-border2) bg-(--d-card) p-0 text-(--d-text)"
        data-testid="terminal-attachment-preview"
        @open-auto-focus="onOpenAutoFocus"
        @pointerenter="schedule(true, 0)"
        @pointerleave="schedule(false, HOVER_CLOSE_MS)"
      >
        <div class="flex items-start gap-2 border-b border-(--d-border) px-3 py-2">
          <SquareTerminal
            class="mt-0.5 size-3.5 shrink-0 text-(--d-muted)"
            aria-hidden="true"
          />
          <div class="min-w-0 flex-1">
            <p class="line-clamp-2 font-mono text-11.5 break-all text-(--d-text)">
              {{ previewTitle }}
            </p>
            <p class="mt-0.5 text-11 text-(--d-muted)">
              {{ parts.details.join(" · ") }}
            </p>
          </div>
        </div>
        <p
          v-if="attachment.omittedLines > 0"
          class="border-b border-(--d-border) px-3 py-1 text-10.5 text-(--d-faint)"
        >
          {{ t("terminalAttachment.omitted", { n: attachment.omittedLines }, attachment.omittedLines) }}
        </p>
        <p
          v-if="shownLines < attachment.lineCount"
          class="border-b border-(--d-border) px-3 py-1 text-10.5 text-(--d-faint)"
        >
          {{ t("terminalAttachment.previewTail", { n: shownLines }, shownLines) }}
        </p>
        <!-- A plain-text pre with native scrolling: its height follows the output up to the cap, which ScrollArea cannot size. -->
        <pre
          tabindex="0"
          :aria-label="t('terminalAttachment.previewRegion')"
          class="max-h-60 overflow-auto px-3 py-2 font-mono text-11/normal whitespace-pre text-(--d-text) outline-none focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-inset"
          data-testid="terminal-attachment-preview-text"
        >{{ attachment.preview || t("terminalAttachment.empty") }}</pre>
      </PopoverContent>
    </Popover>
    <Button
      v-if="removable"
      variant="ghost"
      size="icon"
      class="d-press me-0.75 size-5 shrink-0 rounded-full text-(--d-faint) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3"
      :aria-label="t('terminalAttachment.remove', { label })"
      :title="t('terminalAttachment.removeTitle')"
      data-testid="terminal-attachment-remove"
      @click="emit('remove', attachment.id)"
    >
      <X aria-hidden="true" />
    </Button>
  </div>
</template>
