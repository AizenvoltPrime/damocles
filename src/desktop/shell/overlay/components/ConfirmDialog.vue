<script setup lang="ts">
import { nextTick, onMounted, ref, useId } from 'vue';
import { CircleAlert, LoaderCircle, Trash2, TriangleAlert } from 'lucide-vue-next';
import type { OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import { trapTab } from '../focus-trap';

defineProps<{ request: Extract<OverlayRequest, { kind: 'confirm' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();

const titleId = useId();
const messageId = useId();
const root = ref<HTMLElement | null>(null);
const cancel = ref<HTMLButtonElement | null>(null);

function onKeydown(event: KeyboardEvent): void {
  if (root.value) trapTab(event, root.value);
}

// The safe answer takes focus first, so Enter alone never confirms a destructive action.
onMounted(() => void nextTick(() => cancel.value?.focus()));
</script>

<template>
  <div
    class="fixed inset-0 flex animate-[d-fade_.15s] items-center justify-center bg-(--d-scrim) p-5"
    @click.self="emit('answer', { kind: 'dismissed' })"
    @contextmenu.self.prevent="emit('answer', { kind: 'dismissed' })"
  >
    <div
      ref="root"
      role="alertdialog"
      aria-modal="true"
      data-testid="overlay-confirm"
      :aria-labelledby="titleId"
      :aria-describedby="messageId"
      class="flex w-[min(440px,100%)] animate-[d-pop_.18s_ease-out] flex-col gap-3.5 rounded-[14px] border border-(--d-border2) bg-(--d-card) px-[18px] pt-[18px] pb-4 text-(--d-text) shadow-(--d-shadow)"
      @keydown="onKeydown"
    >
      <h2
        :id="titleId"
        class="flex items-center gap-2.5 text-[15px] font-semibold"
      >
        <span
          v-if="request.danger"
          aria-hidden="true"
          class="flex size-[30px] shrink-0 items-center justify-center rounded-[9px] bg-(--d-danger)/15 text-(--d-danger)"
        >
          <TriangleAlert class="size-4" />
        </span>
        {{ request.title }}
      </h2>
      <p
        :id="messageId"
        class="text-[13px] text-pretty"
      >
        {{ request.message }}
      </p>
      <div
        v-if="request.detail || request.warning"
        class="rounded-[9px] bg-(--d-hover) px-3 py-2.5"
      >
        <template v-if="request.detail">
          <div class="mb-[3px] text-[11px] text-(--d-faint)">
            {{ request.detail.label }}
          </div>
          <div class="max-h-40 overflow-y-auto text-[13px] break-words whitespace-pre-wrap">
            {{ request.detail.text }}
          </div>
        </template>
        <p
          v-if="request.warning"
          data-testid="overlay-confirm-warning"
          class="flex items-center gap-1.5 text-[11.5px] text-(--d-warning)"
          :class="request.detail ? 'mt-1.5' : ''"
        >
          <LoaderCircle
            v-if="request.warning.running"
            aria-hidden="true"
            class="size-[11px] shrink-0 d-spinning"
          />
          <CircleAlert
            v-else
            aria-hidden="true"
            class="size-[11px] shrink-0"
          />
          {{ request.warning.text }}
        </p>
      </div>
      <div class="flex justify-end gap-2">
        <button
          ref="cancel"
          type="button"
          data-testid="overlay-confirm-cancel"
          class="flex h-8 items-center rounded-[9px] px-3.5 text-[12.5px] hover:bg-(--d-hover)"
          @click="emit('answer', { kind: 'confirm', confirmed: false })"
        >
          {{ request.cancelLabel }}
        </button>
        <button
          type="button"
          data-testid="overlay-confirm-accept"
          class="flex h-8 items-center gap-1.5 rounded-[9px] px-3.5 text-[12.5px] font-semibold hover:brightness-110"
          :class="request.danger ? 'bg-(--d-danger) text-(--d-on-danger)' : 'bg-(--d-accent) text-(--d-on-accent)'"
          @click="emit('answer', { kind: 'confirm', confirmed: true })"
        >
          <Trash2
            v-if="request.danger"
            aria-hidden="true"
            class="size-[13px]"
          />
          {{ request.confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
