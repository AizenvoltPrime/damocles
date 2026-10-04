<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { Sparkles } from 'lucide-vue-next';
import { useConsolidationStore } from '@/stores/useConsolidationStore';

const { t } = useI18n();
const store = useConsolidationStore();
const { pendingCount, isRunning, lastResult, isOverlayOpen } = storeToRefs(store);

defineEmits<{ (e: 'click'): void }>();

// A failed pass releases its turns back to the queue, so the failure takes the dot's place while it lasts.
const failed = computed(() => !isOverlayOpen.value && !isRunning.value && lastResult.value?.status === 'failed');

const label = computed(() => {
  const parts = [t('chatHeader.consolidation')];
  if (isRunning.value) parts.push(t('consolidation.consolidating'));
  else if (failed.value) parts.push(t('consolidation.lastFailed'));
  if (pendingCount.value > 0) parts.push(t('consolidation.turnsQueued', { n: pendingCount.value }, pendingCount.value));
  return parts.join(' · ');
});
</script>

<template>
  <button
    type="button"
    class="d-tool-btn relative w-7.5 px-0"
    :title="label"
    :aria-label="label"
    data-testid="chat-header-consolidation"
    @click="$emit('click')"
  >
    <Sparkles
      class="size-3.75"
      :class="isRunning ? 'd-pulsing text-(--d-accent)' : ''"
      aria-hidden="true"
    />
    <span
      v-if="failed"
      class="pointer-events-none absolute right-1.25 top-1 size-1.5 rounded-full bg-(--d-danger)"
      aria-hidden="true"
    />
    <span
      v-else-if="pendingCount > 0"
      class="pointer-events-none absolute right-1.5 top-1.25 size-1.25 rounded-full bg-(--d-accent)"
      aria-hidden="true"
    />
  </button>
</template>
