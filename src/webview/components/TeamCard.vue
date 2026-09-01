<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TeamState } from '@shared/types/team';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { IconCheck, IconXCircle, IconBan } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import { formatElapsed, formatTokenCount } from '@/composables/useTeamFormatting';
import { useCostLabel } from '@/composables/useCostLabel';
import { useElapsedTimer } from '@/composables/useElapsedTimer';

const { t } = useI18n();
const { costLabel, costTitle, teamDollarBilled } = useCostLabel();

const props = defineProps<{
  team: TeamState;
}>();

defineEmits<{
  (e: 'expand'): void;
}>();

const { elapsedMs } = useElapsedTimer(
  () => props.team.status === 'running',
  () => props.team.startTime,
  () => props.team.endTime,
);

const activeAgentCount = computed(() =>
  props.team.agents.filter(a => a.status === 'running' || a.status === 'awaiting-review' || a.status === 'standby' || a.status === 'monitoring').length
);

const totalAgentCount = computed(() => props.team.agents.length);

const progressLine = computed(() =>
  t('team.agentActiveProgress', { active: activeAgentCount.value, total: totalAgentCount.value })
);

const totalTokens = computed(() =>
  props.team.agents.reduce((sum, a) => sum + a.totalInputTokens + a.totalOutputTokens, 0)
);
const totalCost = computed(() =>
  props.team.agents.reduce((sum, a) => sum + a.costUsd, 0)
);
// Each agent carries its own flag and a reload restores it, so the total is labelled from the agents
// rather than from the panel account.
const totalBilled = computed(() => teamDollarBilled(props.team.agents));

const cardClass = computed(() => {
  switch (props.team.status) {
    case 'running':
      return 'border-primary/50 hover:border-primary/70';
    case 'completed':
      return 'border-success/50 hover:border-success/70';
    case 'failed':
      return 'border-error/50 hover:border-error/70';
    case 'cancelled':
      return 'border-warning/50 hover:border-warning/70';
    default:
      return 'border-border';
  }
});

const statusBadgeClass = computed(() => {
  switch (props.team.status) {
    case 'running':
      return 'bg-primary/30 text-primary border-primary/30';
    case 'completed':
      return 'bg-success/30 text-success border-success/30';
    case 'failed':
      return 'bg-error/30 text-error border-error/30';
    case 'cancelled':
      return 'bg-warning/30 text-warning border-warning/30';
    default:
      return 'bg-primary/30 text-primary border-primary/30';
  }
});
</script>

<template>
  <Card
    class="text-sm overflow-hidden cursor-pointer transition-colors"
    :class="cardClass"
    @click="$emit('expand')"
  >
    <CardHeader class="flex flex-row items-center gap-2 px-3 py-2 bg-foreground/5 border-b border-border/50 space-y-0">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-primary shrink-0"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      <span class="text-foreground font-medium truncate flex-1">{{ team.title }}</span>
      <Badge variant="secondary" class="bg-foreground/10 text-foreground/70 border-foreground/20 gap-1 shrink-0">
        {{ t('team.agentCount', { n: totalAgentCount }) }}
      </Badge>
      <Badge variant="secondary" :class="statusBadgeClass" class="gap-1 shrink-0 items-center">
        <LoadingSpinner v-if="team.status === 'running'" :size="10" class="shrink-0" />
        <IconCheck v-else-if="team.status === 'completed'" :size="10" class="shrink-0" />
        <IconXCircle v-else-if="team.status === 'failed'" :size="10" class="shrink-0" />
        <IconBan v-else-if="team.status === 'cancelled'" :size="10" class="shrink-0" />
        <span class="leading-none">{{ t('team.status.' + team.status) }}</span>
      </Badge>
    </CardHeader>

    <div
      v-if="team.status === 'running'"
      class="px-3 py-1.5 text-xs text-primary/80 italic truncate border-b border-border/30"
    >
      {{ progressLine }}
    </div>

    <CardContent class="px-3 py-2 flex items-center justify-between">
      <div class="flex items-center gap-1.5 text-xs text-foreground/70 leading-none">
        <span>{{ t('team.toolCount', { n: team.totalToolCount }) }}</span>
        <span class="text-foreground/40">•</span>
        <span>{{ formatElapsed(elapsedMs) }}</span>
        <template v-if="totalTokens > 0">
          <span class="text-foreground/40">•</span>
          <span>{{ formatTokenCount(totalTokens) }} tokens</span>
        </template>
        <template v-if="totalCost > 0">
          <span class="text-foreground/40">•</span>
          <span class="font-medium" :title="costTitle(totalBilled)">{{ costLabel(totalCost, totalBilled) }}</span>
        </template>
      </div>
      <div class="flex items-center">
        <LoadingSpinner v-if="team.status === 'running'" :size="14" class="text-primary" />
        <IconCheck v-else-if="team.status === 'completed'" :size="14" class="text-success" />
        <IconXCircle v-else-if="team.status === 'failed'" :size="14" class="text-error" />
      </div>
    </CardContent>
  </Card>
</template>
