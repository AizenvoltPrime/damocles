<script setup lang="ts">
import { ref, computed, nextTick, type ComponentPublicInstance } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolCall } from "@shared/types/session";
import { LIVE_OUTPUT_TOOLS } from "@shared/tool-names";
import { Button } from "@/components/ui/button";
import { useToolCancel } from "@/composables/useToolCancel";
import type { ExpandedToolSource } from "@/stores/useUIStore";

const { t } = useI18n();

const props = defineProps<{
  toolCall: ToolCall;
  source: ExpandedToolSource;
}>();

const { requestCancel, isCancelPending } = useToolCancel(() => props.source);

/** The extension registers a cancellable entry inside execute, so only a running shell call has one. */
const isVisible = computed(() => props.toolCall.status === "running" && LIVE_OUTPUT_TOOLS.has(props.toolCall.name));

/** The local half survives a call no store could mark, so only the extension's rejection clears it. */
const isStopping = computed(() => props.toolCall.cancelRequested === true || isCancelPending(props.toolCall.id));

const isNoteMode = ref(false);
const note = ref("");
const noteInput = ref<HTMLTextAreaElement | null>(null);
const stopButton = ref<ComponentPublicInstance | null>(null);

/** Roughly four lines of the note field; past this the textarea scrolls instead of growing the card. */
const MAX_NOTE_HEIGHT = 72;

function adjustNoteHeight(): void {
  const textarea = noteInput.value;
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_NOTE_HEIGHT)}px`;
  textarea.style.overflowY = textarea.scrollHeight > MAX_NOTE_HEIGHT ? "auto" : "hidden";
}

async function openNote(): Promise<void> {
  if (isStopping.value) return;
  isNoteMode.value = true;
  await nextTick();
  noteInput.value?.focus();
  adjustNoteHeight();
}

/** The trigger is aria-disabled rather than disabled so closing the note has somewhere to put focus. */
async function restoreTriggerFocus(): Promise<void> {
  await nextTick();
  const el = stopButton.value?.$el;
  if (el instanceof HTMLElement) el.focus();
}

function closeNote(): void {
  isNoteMode.value = false;
  note.value = "";
  void restoreTriggerFocus();
}

/** Send-versus-newline matches the main composer in ChatInput.vue, so the muscle memory transfers. */
function handleNoteKeydown(event: KeyboardEvent): void {
  // An IME commits its candidate with Enter, and Windows reports that commit as keyCode 229 only.
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key !== "Enter") return;

  if (event.shiftKey) {
    event.preventDefault();
    const textarea = noteInput.value;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    note.value = note.value.substring(0, start) + "\n" + note.value.substring(end);
    void nextTick(() => {
      textarea.selectionStart = textarea.selectionEnd = start + 1;
      adjustNoteHeight();
      textarea.scrollTop = textarea.scrollHeight;
    });
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  submit();
}

function submit(): void {
  if (isStopping.value) return;
  const trimmed = note.value.trim();
  if (trimmed.length > 0) {
    requestCancel(props.toolCall.id, trimmed);
  } else {
    requestCancel(props.toolCall.id);
  }
  closeNote();
}
</script>

<template>
  <!-- Stops the click so pressing Stop or typing a note never expands the card underneath. -->
  <div v-if="isVisible" class="flex items-center gap-1 shrink-0" @click.stop>
    <template v-if="isNoteMode && !isStopping">
      <textarea
        ref="noteInput"
        v-model="note"
        rows="1"
        maxlength="500"
        :placeholder="t('toolCall.cancelNotePlaceholder')"
        :aria-label="t('toolCall.cancelNotePlaceholder')"
        :style="{ maxHeight: `${MAX_NOTE_HEIGHT}px` }"
        class="w-44 min-h-6 resize-none overflow-hidden rounded-md border border-input bg-background px-2 py-1 text-xs leading-4 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        @keydown="handleNoteKeydown"
        @keydown.esc.stop.prevent="closeNote"
        @input="adjustNoteHeight"
      ></textarea>
      <Button variant="secondary" size="sm" class="h-6 px-2 text-xs" @click="submit">
        {{ t("toolCall.cancelNoteSubmit") }}
      </Button>
      <Button variant="ghost" size="sm" class="h-6 px-2 text-xs" @click="closeNote">
        {{ t("toolCall.cancelNoteBack") }}
      </Button>
    </template>
    <Button
      v-else
      ref="stopButton"
      variant="secondary"
      size="sm"
      class="h-6 px-2 text-xs"
      :class="isStopping ? 'opacity-60 cursor-not-allowed' : ''"
      :aria-disabled="isStopping"
      :aria-busy="isStopping"
      :aria-label="isStopping ? undefined : t('toolCall.stopWithNote')"
      @click="openNote"
    >
      {{ isStopping ? t("toolCall.stopping") : t("toolCall.stop") }}
    </Button>
  </div>
</template>
