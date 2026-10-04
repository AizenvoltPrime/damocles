<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useBackgroundTaskStore } from '@/stores/useBackgroundTaskStore';

const { t } = useI18n();
const store = useBackgroundTaskStore();

const activeCount = computed(() => store.activeTasks.length);
const finishedCount = computed(() => store.tasks.length - activeCount.value);
const label = computed(() =>
  activeCount.value > 0
    ? t('composer.backgroundRunning', { n: activeCount.value }, activeCount.value)
    : t('composer.backgroundFinished', { n: finishedCount.value }, finishedCount.value),
);

defineEmits<{
  (e: 'click'): void;
}>();
</script>

<template>
  <button
    v-if="store.tasks.length > 0"
    type="button"
    class="flex shrink-0 items-center gap-1.25 rounded-full bg-(--d-hover) px-2 py-0.5 transition-colors hover:bg-(--d-border2) hover:text-(--d-text)"
    :title="t('backgroundTask.title')"
    data-testid="composer-background"
    @click="$emit('click')"
  >
    <span
      class="size-1.5 rounded-full"
      :class="activeCount > 0 ? 'bg-(--d-accent) animate-[d-pulse_1.6s_ease-in-out_infinite]' : 'bg-(--d-faint)'"
      aria-hidden="true"
    />
    <span class="tabular-nums @max-[43rem]:sr-only">{{ label }}</span>
  </button>
</template>
