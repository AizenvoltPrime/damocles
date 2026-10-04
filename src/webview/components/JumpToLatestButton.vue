<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { ArrowDown } from 'lucide-vue-next';

const { t } = useI18n();
</script>

<template>
  <!-- The parent positions it and wires the click to its view's `useStickToBottom().jumpToLatest`. -->
  <button
    type="button"
    class="d-press flex size-8.5 items-center justify-center rounded-full bg-(--d-accent) text-(--d-on-accent) shadow-[0_6px_20px_color-mix(in_srgb,var(--d-accent)_35%,transparent)]"
    :title="t('session.scrollToBottom')"
    :aria-label="t('session.scrollToBottom')"
    data-testid="scroll-to-bottom"
  >
    <ArrowDown
      class="size-4"
      aria-hidden="true"
    />
  </button>
</template>
