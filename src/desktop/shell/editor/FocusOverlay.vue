<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleAlert, LoaderCircle, MessageSquare } from 'lucide-vue-next';
import type { ChatStatus } from '../../preload/shell-channels';

// AD1 focus overlay: main hides the chat view while the editor covers the window, so the chat slot shows this card under the
// shell's scrim, naming the chat and what it is doing.
const props = defineProps<{ title: string; status: ChatStatus }>();
const { t } = useI18n();

const tone = computed(() => ({ running: 'accent', waiting: 'warning', idle: 'faint' } as const)[props.status]);
</script>

<template>
  <div
    data-testid="focus-overlay-placeholder"
    class="d-fade-in flex w-full max-w-80 flex-col items-center gap-2.5 rounded-xl border border-(--d-border) bg-(--d-panel) px-6 py-5 text-center"
  >
    <span class="flex size-9 items-center justify-center rounded-lg bg-(--d-accent-soft) text-(--d-accent-text)">
      <MessageSquare
        aria-hidden="true"
        class="size-4.5"
      />
    </span>
    <p class="w-full truncate text-13 font-semibold text-(--d-text)">
      {{ title }}
    </p>
    <span
      class="flex items-center gap-1.5 rounded-full px-2 py-0.5 text-11 font-medium"
      :class="`d-tone-${tone} bg-[color-mix(in_srgb,var(--tone)_14%,transparent)]`"
    >
      <LoaderCircle
        v-if="status === 'running'"
        aria-hidden="true"
        class="d-spinning size-3"
      />
      <CircleAlert
        v-else-if="status === 'waiting'"
        aria-hidden="true"
        class="size-3"
      />
      {{ t(`editor.focus.status.${status}`) }}
    </span>
    <p class="text-11.5 text-(--d-faint)">
      {{ t('editor.focus.hint') }}
    </p>
  </div>
</template>
