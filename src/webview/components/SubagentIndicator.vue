<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SubagentState } from '@shared/types/subagents';
import AgentBadge from './AgentBadge.vue';

const { t } = useI18n();

const props = defineProps<{
  subagents: Record<string, SubagentState>;
}>();

defineEmits<{
  (e: 'expand', subagentId: string): void;
}>();

const subagentList = computed(() => Object.values(props.subagents));

const hasSubagents = computed(() => subagentList.value.length > 0);

const hasRunningSubagent = computed(() =>
  subagentList.value.some(s => s.status === 'running')
);

const indicatorLabel = computed(() =>
  hasRunningSubagent.value ? t('subagentIndicator.active') : t('subagentIndicator.recent')
);

const indicatorBgClass = computed(() =>
  hasRunningSubagent.value ? 'bg-info/20' : 'bg-success/10'
);
</script>

<template>
  <div
    v-if="hasSubagents"
    :class="['flex items-center gap-2 px-3 py-1.5 text-xs border-b border-border/30', indicatorBgClass]"
  >
    <span class="opacity-70 shrink-0">{{ indicatorLabel }}</span>
    <div class="flex items-center gap-2 flex-wrap">
      <AgentBadge
        v-for="subagent in subagentList"
        :key="subagent.id"
        :subagent="subagent"
        @click="$emit('expand', $event)"
      />
    </div>
  </div>
</template>
