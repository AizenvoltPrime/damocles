<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { IconLoader } from '@/components/icons';
import { useBackgroundTaskStore } from '@/stores/useBackgroundTaskStore';

const { t } = useI18n();
const store = useBackgroundTaskStore();

defineEmits<{
  (e: 'click'): void;
}>();
</script>

<template>
  <button
    v-if="store.activeTaskCount > 0"
    class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium
           bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 transition-colors cursor-pointer border-0"
    @click="$emit('click')"
  >
    <IconLoader :size="12" class="animate-spin" style="animation-duration: 2s" />
    <span class="tabular-nums">{{ store.activeTaskCount }}</span>
    <span>{{ store.activeTaskCount === 1 ? t('backgroundTask.task') : t('backgroundTask.tasks') }}</span>
  </button>
</template>
