<script setup lang="ts">
import { h, ref, computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { IconCheck, IconXCircle, IconBan, IconChevronRight, IconChevronDown, IconClock, IconEye } from '@/components/icons';
import OverlayShell from './OverlayShell.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import LoadingSpinner from './LoadingSpinner.vue';
import { useTeamStore } from '@/stores/useTeamStore';
import { useVSCode } from '@/composables/useVSCode';
import { statusBadgeClass, getAgentColor, formatElapsed, formatTokenCount, formatCost } from '@/composables/useTeamFormatting';
import { useElapsedTimer } from '@/composables/useElapsedTimer';
import type { AgentChatMessage } from '@/stores/useTeamStore';

const { t } = useI18n();
const { postMessage } = useVSCode();
const teamStore = useTeamStore();
const { selectedTeam, selectedAgent, currentAgentMessages, currentAgentStreaming, isAgentOverlayOpen } = storeToRefs(teamStore);

const agentIndex = computed(() => {
  if (!selectedTeam.value || !selectedAgent.value) return -1;
  return selectedTeam.value.agents.findIndex(a => a.agentId === selectedAgent.value?.agentId);
});

const color = computed(() => getAgentColor(agentIndex.value));

const { elapsedMs } = useElapsedTimer(
  () => selectedAgent.value?.status === 'running',
  () => selectedAgent.value?.startTime ?? null,
  () => selectedAgent.value?.endTime ?? null,
);

const subtitle = computed(() => {
  if (!selectedAgent.value) return '';
  const a = selectedAgent.value;
  const parts = [a.role, a.model].filter(Boolean);
  if (a.toolCount > 0) parts.push(`${a.toolCount} tools`);
  parts.push(formatElapsed(elapsedMs.value));
  const totalTokens = a.totalInputTokens + a.totalOutputTokens;
  if (totalTokens > 0) parts.push(`${formatTokenCount(totalTokens)} tokens`);
  if (a.costUsd > 0) parts.push(formatCost(a.costUsd));
  return parts.join(' | ');
});

const statusBadge = computed(() => {
  if (!selectedAgent.value) return undefined;
  const agent = selectedAgent.value;
  switch (agent.status) {
    case 'running':
      return { label: t('team.statusLabel.running'), class: 'bg-primary/30 text-primary border-primary/30', showSpinner: true };
    case 'completed':
      return { label: t('team.statusLabel.completed'), class: 'bg-success/30 text-success border-success/30', icon: IconCheck };
    case 'failed':
      return { label: t('team.statusLabel.failed'), class: 'bg-error/30 text-error border-error/30', icon: IconXCircle };
    case 'cancelled':
      return { label: t('team.statusLabel.cancelled'), class: 'bg-warning/30 text-warning border-warning/30', icon: IconBan };
    case 'awaiting-review':
      return { label: t('team.statusLabel.awaiting-review'), class: 'bg-amber-500/30 text-amber-400 border-amber-500/30', icon: IconClock };
    case 'standby':
      return { label: t('team.statusLabel.standby'), class: 'bg-cyan-500/30 text-cyan-400 border-cyan-500/30', icon: IconClock, showSpinner: true };
    case 'monitoring':
      return { label: t('team.statusLabel.monitoring'), class: 'bg-blue-500/30 text-blue-300 border-blue-500/30', icon: IconEye };
    default:
      return undefined;
  }
});

const canCancel = computed(() => {
  if (!selectedAgent.value || !selectedTeam.value) return false;
  const agentActive = selectedAgent.value.status === 'running' || selectedAgent.value.status === 'pending' || selectedAgent.value.status === 'awaiting-review' || selectedAgent.value.status === 'standby';
  const teamActive = selectedTeam.value.status === 'running' && selectedTeam.value.phase !== 'synthesizing';
  return agentActive && teamActive;
});

function close(): void {
  teamStore.closeAgentOverlay();
}

function cancelAgent(): void {
  if (!selectedTeam.value || !selectedAgent.value) return;
  postMessage({
    type: 'cancelTeamAgent',
    teamId: selectedTeam.value.teamId,
    agentId: selectedAgent.value.agentId,
  });
}

function openLog(): void {
  if (!selectedAgent.value?.logFilePath) return;
  postMessage({ type: 'openFile', filePath: selectedAgent.value.logFilePath });
}

function fetchAgentDataIfNeeded(): void {
  if (selectedAgent.value && currentAgentMessages.value.length === 0 && selectedAgent.value.status !== 'running' && selectedTeam.value) {
    postMessage({
      type: 'requestTeamAgentData',
      teamId: selectedTeam.value.teamId,
      agentId: selectedAgent.value.agentId,
    });
  }
}

const collapsedThinking = ref<Set<string>>(new Set());

function toggleThinking(messageId: string): void {
  const next = new Set(collapsedThinking.value);
  if (next.has(messageId)) {
    next.delete(messageId);
  } else {
    next.add(messageId);
  }
  collapsedThinking.value = next;
}

onMounted(fetchAgentDataIfNeeded);

watch(() => selectedAgent.value?.status, (newStatus, oldStatus) => {
  if (oldStatus === 'running' && newStatus && newStatus !== 'running') {
    fetchAgentDataIfNeeded();
  }
});

const AgentIcon = {
  render() {
    return h('svg', {
      xmlns: 'http://www.w3.org/2000/svg', width: '20', height: '20', viewBox: '0 0 24 24',
      fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    }, [
      h('path', { d: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2' }),
      h('circle', { cx: '12', cy: '7', r: '4' }),
    ]);
  },
};
</script>

<template>
  <OverlayShell
    v-if="selectedAgent && isAgentOverlayOpen"
    :title="selectedAgent.name"
    :subtitle="subtitle"
    :icon="AgentIcon"
    :icon-class="color.text"
    :status-badge="statusBadge"
    @close="close"
  >
    <template #header-actions>
      <Button
        v-if="selectedAgent.logFilePath"
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-foreground cursor-pointer"
        :title="t('team.agentOverlay.openLogFile')"
        @click="openLog"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
      </Button>
      <Button
        v-if="canCancel"
        variant="ghost"
        size="icon-sm"
        class="text-error/70 hover:text-error hover:bg-error/10 cursor-pointer"
        :title="t('team.agentOverlay.cancelAgent')"
        @click="cancelAgent"
      >
        <IconBan :size="14" />
      </Button>
    </template>

    <ScrollArea class="h-full">
      <div class="p-4 space-y-3">
        <template v-if="currentAgentMessages.length === 0 && !currentAgentStreaming">
          <div class="flex flex-col items-center justify-center py-12 text-foreground/40">
            <LoadingSpinner v-if="selectedAgent.status === 'running' || selectedAgent.status === 'pending' || selectedAgent.status === 'standby'" :size="24" class="mb-3" />
            <span class="text-sm">{{ selectedAgent.status === 'running' ? t('team.agentOverlay.waitingForActivity') : t('team.agentOverlay.noConversationData') }}</span>
          </div>
        </template>

        <template v-for="msg in currentAgentMessages" :key="msg.id">
          <div v-if="msg.role === 'user'" class="text-xs text-foreground/50 border-l-2 border-foreground/20 pl-2 py-1">
            <MarkdownRenderer :content="msg.content" />
          </div>

          <div v-else class="space-y-2">
            <div v-if="msg.thinking" class="text-xs text-foreground/40 border-l-2 border-violet-500/30 pl-2 py-1">
              <button
                class="flex items-center gap-1 text-violet-400 text-[10px] font-medium hover:text-violet-300 cursor-pointer"
                @click="toggleThinking(msg.id)"
              >
                <component :is="collapsedThinking.has(msg.id) ? IconChevronRight : IconChevronDown" :size="10" />
                {{ t('team.agentOverlay.thinking') }}
              </button>
              <div v-if="!collapsedThinking.has(msg.id)" class="mt-1 max-h-64 overflow-y-auto italic">
                <MarkdownRenderer :content="msg.thinking" />
              </div>
            </div>

            <div v-if="msg.content" class="text-sm text-foreground">
              <MarkdownRenderer :content="msg.content" />
            </div>

            <div v-if="msg.toolCalls" class="space-y-1">
              <div
                v-for="tool in msg.toolCalls"
                :key="tool.id"
                class="flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-foreground/5 border border-border/30"
              >
                <LoadingSpinner v-if="tool.status === 'running'" :size="10" />
                <IconCheck v-else-if="tool.status === 'completed'" :size="10" class="text-success" />
                <IconXCircle v-else-if="tool.status === 'error'" :size="10" class="text-error" />
                <span class="font-mono text-foreground/70">{{ tool.name }}</span>
                <Badge v-if="tool.status !== 'running'" variant="secondary" class="text-[10px] px-1 py-0 ml-auto">
                  {{ tool.status }}
                </Badge>
              </div>
            </div>
          </div>
        </template>

        <div v-if="currentAgentStreaming" class="space-y-2">
          <div v-if="currentAgentStreaming.isThinkingPhase && currentAgentStreaming.thinking" class="text-xs text-foreground/40 italic border-l-2 border-violet-500/30 pl-2 py-1">
            <span class="text-violet-400 text-[10px] font-medium">{{ t('team.agentOverlay.thinking') }}</span>
            <div class="mt-1 max-h-64 overflow-y-auto">
              <MarkdownRenderer :content="currentAgentStreaming.thinking" />
            </div>
          </div>
          <div v-if="currentAgentStreaming.text" class="text-sm text-foreground">
            <MarkdownRenderer :content="currentAgentStreaming.text" />
          </div>
          <div class="flex items-center gap-1.5 text-xs text-foreground/40">
            <LoadingSpinner :size="10" />
            <span>{{ t('team.agentOverlay.agentWorking') }}</span>
          </div>
        </div>
      </div>
    </ScrollArea>
  </OverlayShell>
</template>
