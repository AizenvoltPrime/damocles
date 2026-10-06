<script setup lang="ts">
import { computed } from 'vue';
import type { OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import OverlayDialog, { type DialogButton } from './OverlayDialog.vue';

// A question main asks (D41): the message heads it, the detail explains, Cancel comes first and answers null.
const props = defineProps<{ request: Extract<OverlayRequest, { kind: 'message' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();

const CANCEL = 0;
const buttons = computed((): DialogButton[] => [
  { label: props.request.cancelLabel, variant: 'plain', testId: 'overlay-message-cancel' },
  ...props.request.actions.map((label, index): DialogButton => ({ label, variant: index === 0 ? 'fill' : 'plain', testId: `overlay-message-action-${index}` })),
]);
</script>

<template>
  <OverlayDialog
    :severity="request.severity"
    :title="request.message"
    :message="request.detail"
    :buttons="buttons"
    :initial-focus="request.defaultAction === undefined ? CANCEL : request.defaultAction + 1"
    :cancel-index="CANCEL"
    test-id="overlay-message"
    @choose="emit('answer', { kind: 'message', action: $event === CANCEL ? null : $event - 1 })"
  />
</template>
