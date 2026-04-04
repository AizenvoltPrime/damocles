<script setup lang="ts">
import { h, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { IconCheck, IconXCircle } from '@/components/icons';
import OverlayShell from './OverlayShell.vue';
import TeamAgentCard from './TeamAgentCard.vue';
import TeamTimeline from './TeamTimeline.vue';
import TeamScratchpad from './TeamScratchpad.vue';
import { useTeamStore } from '@/stores/useTeamStore';
import { formatElapsed } from '@/composables/useTeamFormatting';
import { useElapsedTimer } from '@/composables/useElapsedTimer';
import MarkdownRenderer from './MarkdownRenderer.vue';

const { t } = useI18n();

const teamStore = useTeamStore();
const { selectedTeam, activeTab } = storeToRefs(teamStore);

function close(): void {
  teamStore.closeOverlay();
}

const tabs = ['agents', 'timeline', 'scratchpad', 'result'] as const;

function tabLabel(tab: typeof tabs[number]): string {
  return t(`team.tabs.${tab}`);
}

function isTabDisabled(tab: typeof tabs[number]): boolean {
  if (tab === 'result') return !selectedTeam.value?.result;
  return false;
}

const statusBadge = computed(() => {
  if (!selectedTeam.value) return undefined;
  const team = selectedTeam.value;
  switch (team.status) {
    case 'running':
      return { label: t('team.statusLabel.running'), class: 'bg-primary/30 text-primary border-primary/30', showSpinner: true };
    case 'completed':
      return { label: t('team.statusLabel.completed'), class: 'bg-success/30 text-success border-success/30', icon: IconCheck };
    case 'failed':
    case 'cancelled':
      return { label: t('team.statusLabel.' + team.status), class: 'bg-error/30 text-error border-error/30', icon: IconXCircle };
    default:
      return undefined;
  }
});

const { elapsedMs } = useElapsedTimer(
  () => selectedTeam.value?.status === 'running',
  () => selectedTeam.value?.startTime ?? null,
  () => selectedTeam.value?.endTime ?? null,
);

const subtitle = computed(() => {
  if (!selectedTeam.value) return '';
  const team = selectedTeam.value;
  return t('team.overlay.subtitle', { agents: team.agents.length, tools: team.totalToolCount, elapsed: formatElapsed(elapsedMs.value) });
});

const TeamIcon = {
  render() {
    return h('svg', {
      xmlns: 'http://www.w3.org/2000/svg', width: '20', height: '20', viewBox: '0 0 24 24',
      fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    }, [
      h('path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }),
      h('circle', { cx: '9', cy: '7', r: '4' }),
      h('path', { d: 'M22 21v-2a4 4 0 0 0-3-3.87' }),
      h('path', { d: 'M16 3.13a4 4 0 0 1 0 7.75' }),
    ]);
  },
};
</script>

<template>
  <OverlayShell
    v-if="selectedTeam"
    :title="selectedTeam.title"
    :subtitle="subtitle"
    :icon="TeamIcon"
    icon-class="text-primary"
    :status-badge="statusBadge"
    @close="close"
  >
    <div class="flex flex-col h-full">
      <div class="flex border-b border-border/30 px-4 shrink-0">
        <button
          v-for="tab in tabs"
          :key="tab"
          :disabled="isTabDisabled(tab)"
          class="px-3 py-2 text-xs font-medium transition-colors relative"
          :class="[
            activeTab === tab
              ? 'text-primary cursor-default'
              : isTabDisabled(tab)
                ? 'text-foreground/20 cursor-not-allowed'
                : 'text-foreground/60 hover:text-foreground cursor-pointer',
          ]"
          @click="!isTabDisabled(tab) && teamStore.setActiveTab(tab)"
        >
          {{ tabLabel(tab) }}
          <Badge
            v-if="tab === 'timeline' && selectedTeam.messages.length > 0"
            variant="secondary"
            class="ml-1 text-[10px] px-1 py-0 bg-foreground/10"
          >
            {{ selectedTeam.messages.length }}
          </Badge>
          <div
            v-if="activeTab === tab"
            class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary"
          />
        </button>
      </div>

      <div class="flex-1 min-h-0">
        <ScrollArea v-if="activeTab === 'agents'" class="h-full">
          <div class="p-3 grid gap-2">
            <TeamAgentCard
              v-for="(agent, idx) in selectedTeam.agents"
              :key="agent.agentId"
              :agent="agent"
              :index="idx"
            />
          </div>
        </ScrollArea>

        <TeamTimeline
          v-else-if="activeTab === 'timeline'"
          :messages="selectedTeam.messages"
          :agents="selectedTeam.agents"
        />

        <TeamScratchpad
          v-else-if="activeTab === 'scratchpad'"
          :entries="selectedTeam.scratchpad"
          :agents="selectedTeam.agents"
        />

        <ScrollArea v-else-if="activeTab === 'result'" class="h-full">
          <div class="p-4">
            <div v-if="selectedTeam.result" class="text-sm text-foreground">
              <MarkdownRenderer :content="selectedTeam.result" />
            </div>
            <div v-else class="text-sm text-foreground/40 text-center py-8">
              {{ t('team.overlay.noResult') }}
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  </OverlayShell>
</template>
