<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { IconSparkles } from '@/components/icons';
import { useWorkflowStore } from '@/stores/useWorkflowStore';

const { t } = useI18n();
const store = useWorkflowStore();

defineEmits<{
  (e: 'click'): void;
}>();
</script>

<template>
  <button
    v-if="store.activeWorkflowCount > 0"
    class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium
           bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 transition-colors cursor-pointer border-0"
    @click="$emit('click')"
  >
    <IconSparkles :size="12" class="animate-pulse" />
    <span class="tabular-nums">{{ store.activeWorkflowCount }}</span>
    <span>{{ store.activeWorkflowCount === 1 ? t('workflowTask.workflow') : t('workflowTask.workflows') }}</span>
  </button>
</template>
