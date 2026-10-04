<script setup lang="ts">
import { computed, type Component } from 'vue';
import { AlertDialogDescription, AlertDialogTitle } from '@/components/ui/alert-dialog';

// Place inside an AlertDialogContent with `gap-0 overflow-hidden p-0`; this draws the header, body and footer.
const props = withDefaults(defineProps<{
  icon: Component;
  tone?: 'accent' | 'warning' | 'danger';
  title: string;
  description?: string | undefined;
  /** The default footer's Cancel and confirm buttons need both labels; a `footer` slot replaces those buttons. */
  confirmLabel?: string | undefined;
  cancelLabel?: string | undefined;
  /** The confirm button is destructive. */
  danger?: boolean;
  confirmDisabled?: boolean;
}>(), { tone: 'accent', description: undefined, confirmLabel: undefined, cancelLabel: undefined, danger: false, confirmDisabled: false });

const emit = defineEmits<{
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();

const toneVar = computed(() => `var(--d-${props.tone})`);
</script>

<template>
  <header class="flex items-start gap-3 px-4.5 pt-4.5 pb-3">
    <span
      class="flex size-8 flex-none items-center justify-center rounded-10"
      :style="{ background: `color-mix(in srgb, ${toneVar} 14%, transparent)`, color: toneVar }"
      aria-hidden="true"
    >
      <component
        :is="icon"
        class="size-4"
      />
    </span>
    <div class="min-w-0 flex-1 pt-0.5">
      <AlertDialogTitle class="text-15 font-semibold tracking-[-.01em]">
        {{ title }}
      </AlertDialogTitle>
      <AlertDialogDescription class="mt-1 text-12.5 text-pretty text-(--d-muted)">
        <slot name="description">
          {{ description }}
        </slot>
      </AlertDialogDescription>
    </div>
  </header>

  <div
    v-if="$slots.default"
    class="flex min-h-0 flex-col gap-3 overflow-y-auto px-4.5 pb-4"
  >
    <slot />
  </div>

  <footer class="flex flex-wrap items-center justify-end gap-2 border-t border-(--d-border) bg-(--d-panel) px-3.5 py-2.5">
    <slot name="footer">
      <button
        type="button"
        class="d-press flex h-7.5 items-center rounded-9 border border-(--d-border2) px-3 text-12.5 transition-colors hover:bg-(--d-hover)"
        data-testid="confirm-cancel"
        @click="emit('cancel')"
      >
        {{ cancelLabel }}
      </button>
      <button
        type="button"
        class="d-press flex h-7.5 items-center gap-1.5 rounded-9 px-3.5 text-12.5 font-semibold transition-[filter] enabled:hover:brightness-110 disabled:opacity-40"
        :class="danger ? 'bg-(--d-danger) text-(--d-on-danger)' : 'bg-(--d-accent) text-(--d-on-accent)'"
        :disabled="confirmDisabled"
        data-testid="confirm-action"
        @click="emit('confirm')"
      >
        {{ confirmLabel }}
      </button>
    </slot>
  </footer>
</template>
