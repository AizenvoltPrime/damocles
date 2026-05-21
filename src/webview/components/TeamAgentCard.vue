<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TeamAgent } from '@shared/types/team';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { IconCheck, IconXCircle, IconBan, IconClock, IconEye } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import { getAgentColor, formatElapsed, statusBadgeClass, formatTokenCount, formatCost } from '@/composables/useTeamFormatting';
import { useElapsedTimer } from '@/composables/useElapsedTimer';
import { useVSCode } from '@/composables/useVSCode';
import { useTeamStore } from '@/stores/useTeamStore';

const { t } = useI18n();

const props = defineProps<{
  agent: TeamAgent;
  index: number;
}>();

const teamStore = useTeamStore();
function openAgentDetail(): void {
  teamStore.openAgentOverlay(props.agent.agentId);
}

const isAlive = () => {
  const s = props.agent.status;
  return s === 'running' || s === 'awaiting-review' || s === 'standby' || s === 'monitoring';
};
const { elapsedMs } = useElapsedTimer(
  isAlive,
  () => props.agent.startTime,
  () => props.agent.endTime,
);

const { postMessage } = useVSCode();
const color = computed(() => getAgentColor(props.index));
const badgeClass = computed(() => statusBadgeClass(props.agent.status));

const canCancel = computed(() => {
  const team = teamStore.selectedTeam;
  if (!team) return false;
  const agentActive = props.agent.status === 'running' || props.agent.status === 'pending' || props.agent.status === 'awaiting-review' || props.agent.status === 'standby';
  const teamActive = team.status === 'running' && team.phase !== 'synthesizing';
  return agentActive && teamActive;
});

function cancelAgent(e: Event): void {
  e.stopPropagation();
  const team = teamStore.selectedTeam;
  if (!team) return;
  postMessage({ type: 'cancelTeamAgent', teamId: team.teamId, agentId: props.agent.agentId });
}
</script>

<template>
  <Card class="text-sm overflow-hidden cursor-pointer hover:bg-foreground/[0.02] transition-colors" @click="openAgentDetail">
    <div class="h-[3px]" :class="color.stripe" />
    <CardContent class="px-3 py-2.5 space-y-2">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <div class="w-2 h-2 rounded-full shrink-0" :class="color.dot" />
          <span class="font-medium text-foreground">{{ agent.name }}</span>
          <Badge variant="secondary" class="text-[10px] px-1.5 py-0">{{ agent.role }}</Badge>
        </div>
        <Badge variant="secondary" :class="badgeClass" class="gap-1 items-center">
          <LoadingSpinner v-if="agent.status === 'running'" :size="10" class="shrink-0" />
          <IconCheck v-else-if="agent.status === 'completed'" :size="10" class="shrink-0" />
          <IconXCircle v-else-if="agent.status === 'failed'" :size="10" class="shrink-0" />
          <IconBan v-else-if="agent.status === 'cancelled'" :size="10" class="shrink-0" />
          <IconClock v-else-if="agent.status === 'awaiting-review'" :size="10" class="shrink-0" />
          <IconClock v-else-if="agent.status === 'standby'" :size="10" class="shrink-0" />
          <IconEye v-else-if="agent.status === 'monitoring'" :size="10" class="shrink-0" />
          <span class="leading-none">{{ t('team.status.' + agent.status) }}</span>
        </Badge>
      </div>

      <p v-if="agent.specialization" class="text-xs text-foreground/60 truncate">
        {{ agent.specialization }}
      </p>

      <div v-if="agent.model" class="flex items-center">
        <Badge variant="secondary" class="text-[10px] px-1.5 py-0">{{ agent.model }}</Badge>
      </div>

      <div class="flex items-center gap-1.5 text-xs text-foreground/50 pt-1 border-t border-border/30">
        <span>{{ t('team.toolCount', { n: agent.toolCount }) }}</span>
        <span v-if="agent.startTime" class="text-foreground/30">•</span>
        <span v-if="agent.startTime">{{ formatElapsed(elapsedMs) }}</span>
        <span v-if="agent.totalInputTokens > 0 || agent.totalOutputTokens > 0" class="text-foreground/30">•</span>
        <span
          v-if="agent.totalInputTokens > 0 || agent.totalOutputTokens > 0"
          :title="`In: ${agent.totalInputTokens.toLocaleString()} Out: ${agent.totalOutputTokens.toLocaleString()}` + (agent.cacheReadTokens > 0 ? ` Cache read: ${agent.cacheReadTokens.toLocaleString()}` : '') + (agent.cacheCreationTokens > 0 ? ` Cache write: ${agent.cacheCreationTokens.toLocaleString()}` : '')"
        >{{ formatTokenCount(agent.totalInputTokens + agent.totalOutputTokens) }} tokens</span>
        <span v-if="agent.costUsd > 0" class="text-foreground/30">•</span>
        <span v-if="agent.costUsd > 0" class="font-medium text-foreground/60">{{ formatCost(agent.costUsd) }}</span>
        <span v-if="agent.lastToolName" class="text-foreground/30">•</span>
        <span v-if="agent.lastToolName" class="truncate">{{ agent.lastToolName }}</span>
        <span class="ml-auto" />
        <button
          v-if="agent.logFilePath"
          class="text-foreground/40 hover:text-foreground transition-colors cursor-pointer"
          :title="t('team.agentOverlay.openLogFile')"
          @click.stop="postMessage({ type: 'openFile', filePath: agent.logFilePath! })"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
        </button>
        <button
          v-if="canCancel"
          class="text-error/50 hover:text-error transition-colors cursor-pointer"
          :title="t('team.agentOverlay.cancelAgent')"
          @click="cancelAgent"
        >
          <IconBan :size="12" />
        </button>
      </div>
    </CardContent>
  </Card>
</template>
