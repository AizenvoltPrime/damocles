<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { GitCommitHorizontal, X } from "lucide-vue-next";
import type { CommitAttachmentInfo } from "@shared/types/chat-attachment";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HOVER_CLOSE_MS, HOVER_OPEN_MS, useHoverPreview } from "@/composables/useHoverPreview";
import { commitAttachmentLabel, shortHash } from "@/utils/chat-attachment-label";
import { commitTime } from "@/utils/clock";

// A commit the Graph attached to a message: a chip naming its short hash and subject that previews the commit's start on
// hover or click, removable while it waits in the composer. Its pop-in and exit are the attachment strip's.
const props = defineProps<{ attachment: CommitAttachmentInfo; removable?: boolean }>();
const emit = defineEmits<{ remove: [id: string] }>();
const { t, locale } = useI18n();

const { open, schedule, onTriggerPress, onOpenChange, onOpenAutoFocus } = useHoverPreview();

const label = computed(() => commitAttachmentLabel(props.attachment, t));
const short = computed(() => shortHash(props.attachment.hash));
const date = computed(() => commitTime(props.attachment.authorDate, locale.value).full);
const details = computed(() => [short.value, props.attachment.author, date.value].filter((part) => part !== "").join(" · "));
const shownLines = computed(() => (props.attachment.preview === "" ? 0 : props.attachment.preview.split("\n").length));
const notShown = computed(() =>
  props.attachment.omittedAtLeast
    ? t("commitAttachment.omittedAtLeast", { n: props.attachment.omittedLines.toLocaleString(locale.value) })
    : t("commitAttachment.omitted", { n: props.attachment.omittedLines.toLocaleString(locale.value) }, props.attachment.omittedLines),
);
</script>

<template>
  <div
    class="commit-attachment-chip group/chip inline-flex h-7 max-w-full min-w-0 items-center rounded-full border border-(--d-border2) bg-(--d-card) text-xs text-(--d-text) transition-colors hover:border-(--d-accent)"
    data-testid="commit-attachment-chip"
    :data-attachment-id="attachment.id"
    :data-hash="attachment.hash"
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
          :title="label"
          :aria-label="t('commitAttachment.preview', { label })"
          data-testid="commit-attachment-preview-button"
          @pointerenter="schedule(true, HOVER_OPEN_MS)"
          @pointerleave="schedule(false, HOVER_CLOSE_MS)"
          @pointerdown="onTriggerPress"
          @keydown="onTriggerPress"
        >
          <span
            class="d-tone-accent flex size-5.5 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--tone)_16%,transparent)]"
            aria-hidden="true"
          >
            <GitCommitHorizontal class="size-3" />
          </span>
          <span
            class="shrink-0 font-mono text-11.5"
            aria-hidden="true"
            data-testid="commit-attachment-hash"
          >{{ short }}</span>
          <span
            class="max-w-60 min-w-0 truncate text-(--d-muted)"
            aria-hidden="true"
            data-testid="commit-attachment-subject"
          >{{ attachment.subject }}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        class="w-lg max-w-[calc(100vw-2rem)] border-(--d-border2) bg-(--d-card) p-0 text-(--d-text)"
        data-testid="commit-attachment-preview"
        @open-auto-focus="onOpenAutoFocus"
        @pointerenter="schedule(true, 0)"
        @pointerleave="schedule(false, HOVER_CLOSE_MS)"
      >
        <div class="flex items-start gap-2 border-b border-(--d-border) px-3 py-2">
          <GitCommitHorizontal
            class="mt-0.5 size-3.5 shrink-0 text-(--d-muted)"
            aria-hidden="true"
          />
          <div class="min-w-0 flex-1">
            <p class="line-clamp-2 text-11.5 wrap-break-word text-(--d-text)">
              {{ attachment.subject }}
            </p>
            <p
              class="mt-0.5 text-11 text-(--d-muted)"
              data-testid="commit-attachment-details"
            >
              {{ details }}
            </p>
          </div>
        </div>
        <p
          v-if="shownLines < attachment.lineCount"
          class="border-b border-(--d-border) px-3 py-1 text-10.5 text-(--d-faint)"
        >
          {{ t("commitAttachment.previewHead", { n: shownLines }, shownLines) }}
        </p>
        <!-- A plain-text pre with native scrolling: its height follows the text up to the cap, which ScrollArea cannot size. -->
        <pre
          tabindex="0"
          :aria-label="t('commitAttachment.previewRegion')"
          class="max-h-60 overflow-auto px-3 py-2 font-mono text-11/normal whitespace-pre text-(--d-text) outline-none focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-inset"
          data-testid="commit-attachment-preview-text"
        >{{ attachment.preview }}</pre>
        <p
          v-if="attachment.omittedLines > 0"
          class="border-t border-(--d-border) px-3 py-1 text-10.5 text-(--d-faint)"
        >
          {{ notShown }}
        </p>
      </PopoverContent>
    </Popover>
    <Button
      v-if="removable"
      variant="ghost"
      size="icon"
      class="d-press me-0.75 size-5 shrink-0 rounded-full text-(--d-faint) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3"
      :aria-label="t('commitAttachment.remove', { label })"
      :title="t('commitAttachment.removeTitle')"
      data-testid="commit-attachment-remove"
      @click="emit('remove', attachment.id)"
    >
      <X aria-hidden="true" />
    </Button>
  </div>
</template>
