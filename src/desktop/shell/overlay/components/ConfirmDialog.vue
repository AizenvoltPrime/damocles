<script setup lang="ts">
import { computed } from 'vue';
import { CircleAlert, LoaderCircle, Trash2 } from 'lucide-vue-next';
import type { OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import OverlayDialog, { type DialogButton } from './OverlayDialog.vue';

const props = defineProps<{ request: Extract<OverlayRequest, { kind: 'confirm' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();

// A destructive confirmation focuses Cancel first, so Enter alone never confirms it.
const CANCEL = 0;
const buttons = computed((): DialogButton[] => [
  { label: props.request.cancelLabel, variant: 'plain', testId: 'overlay-confirm-cancel' },
  { label: props.request.confirmLabel, variant: 'fill', testId: 'overlay-confirm-accept', ...(props.request.danger ? { icon: Trash2 } : {}) },
]);
</script>

<template>
  <OverlayDialog
    :severity="request.danger ? 'danger' : 'info'"
    :title="request.title"
    :message="request.message"
    :buttons="buttons"
    :initial-focus="request.danger ? CANCEL : 1"
    :cancel-index="CANCEL"
    test-id="overlay-confirm"
    @choose="emit('answer', { kind: 'confirm', confirmed: $event !== CANCEL })"
  >
    <div
      v-if="request.detail || request.warning"
      class="rounded-9 bg-(--d-hover) px-3 py-2.5"
    >
      <template v-if="request.detail">
        <div class="mb-0.75 text-11 text-(--d-faint-text)">
          {{ request.detail.label }}
        </div>
        <div class="max-h-40 overflow-y-auto text-13 wrap-break-word whitespace-pre-wrap">
          {{ request.detail.text }}
        </div>
      </template>
      <p
        v-if="request.warning"
        data-testid="overlay-confirm-warning"
        class="flex items-center gap-1.5 text-11.5 text-(--d-warning-text)"
        :class="request.detail ? 'mt-1.5' : ''"
      >
        <LoaderCircle
          v-if="request.warning.running"
          aria-hidden="true"
          class="size-2.75 shrink-0 d-spinning"
        />
        <CircleAlert
          v-else
          aria-hidden="true"
          class="size-2.75 shrink-0"
        />
        {{ request.warning.text }}
      </p>
    </div>
  </OverlayDialog>
</template>
