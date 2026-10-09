<script setup lang="ts">
import { computed } from 'vue';
import type { OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import OverlayDialog, { type DialogButton } from './OverlayDialog.vue';

// A question main asks (D41): the message heads it, the detail explains, Cancel comes first and answers null. A question with
// no cancelLabel (Save or Don't Save) shows its actions only; Escape and the scrim still cancel it.
const props = defineProps<{ request: Extract<OverlayRequest, { kind: 'message' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();

const cancelButton = computed(() => props.request.cancelLabel !== undefined);
// The index Escape and the scrim choose: the Cancel button, or one past the buttons when there is none.
const cancel = computed(() => (cancelButton.value ? 0 : -1));
const firstAction = computed(() => (cancelButton.value ? 1 : 0));
const buttons = computed((): DialogButton[] => [
  ...(props.request.cancelLabel === undefined ? [] : [{ label: props.request.cancelLabel, variant: 'plain' as const, testId: 'overlay-message-cancel' }]),
  ...props.request.actions.map((label, index): DialogButton => ({ label, variant: index === 0 ? 'fill' : 'plain', testId: `overlay-message-action-${index}` })),
]);
const initialFocus = computed(() => (props.request.defaultAction === undefined ? Math.max(0, cancel.value) : props.request.defaultAction + firstAction.value));

// Main draws a preview's control characters as Control Pictures (U+2400 to U+2426) or <U+XXXX>. They show as warning chips,
// larger than the text, since the fallback font draws them small and they are what the reader most needs to see.
const CONTROL = /([\u2400-\u2426]|<U\+[0-9A-F]{4,6}>)/;
const previewLines = computed(() => (props.request.preview ?? []).map((line) => line.split(CONTROL).filter((text) => text !== '').map((text) => ({ text, control: CONTROL.test(text) }))));
</script>

<template>
  <OverlayDialog
    :severity="request.severity"
    :title="request.message"
    :message="request.detail"
    :buttons="buttons"
    :initial-focus="initialFocus"
    :cancel-index="cancel"
    test-id="overlay-message"
    @choose="emit('answer', { kind: 'message', action: $event === cancel ? null : $event - firstAction })"
  >
    <!-- Main bounded the lines and drew their control characters as visible symbols; they show verbatim, as code. -->
    <div
      v-if="previewLines.length > 0"
      data-testid="overlay-message-preview"
      class="max-h-40 overflow-auto rounded-7 border border-(--d-border) bg-(--d-code) px-2.5 py-2 font-mono text-11.5/relaxed text-(--d-text)"
    >
      <div
        v-for="(line, index) in previewLines"
        :key="index"
        class="min-h-lh whitespace-pre"
      >
        <span
          v-for="(part, partIndex) in line"
          :key="partIndex"
          :class="part.control ? 'mx-px rounded-xs bg-(--d-warning)/15 px-0.5 text-13 leading-none text-(--d-warning-text)' : ''"
          :data-control="part.control ? '' : undefined"
          v-text="part.text"
        />
      </div>
    </div>
  </OverlayDialog>
</template>
