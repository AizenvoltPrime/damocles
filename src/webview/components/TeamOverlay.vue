<script setup lang="ts">
import { computed, nextTick, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { Activity, Database, Receipt, Square, Timer, Users, Wrench, Zap } from 'lucide-vue-next';
import OverlayShell from './OverlayShell.vue';
import OverlayHeaderAction from './OverlayHeaderAction.vue';
import StopTeamConfirm from './StopTeamConfirm.vue';
import SlidingIndicator from './SlidingIndicator.vue';
import AgentChip from './agent-view/AgentChip.vue';
import TeamAgentCard from './TeamAgentCard.vue';
import TeamTimeline from './TeamTimeline.vue';
import TeamScratchpad from './TeamScratchpad.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import { useTeamStore } from '@/stores/useTeamStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useSlidingIndicator } from '@/composables/useSlidingIndicator';
import { agentStatusChip, formatElapsed, formatTokenCount, workingAgentCount } from '@/composables/useTeamFormatting';
import { useCostLabel } from '@/composables/useCostLabel';
import { useElapsedTimer } from '@/composables/useElapsedTimer';
import { useStopTeam } from '@/composables/useStopTeam';
import { cacheHitPercent } from '@/utils/cacheHitPercent';
import { addAgentUsage, agentCacheHitRate, agentTotalTokens, emptyAgentUsage } from '@shared/usage-accounting';
import { runsStopwatch } from '@shared/team-stopwatch';

const { t, locale } = useI18n();
const { teamDollarBilled, costLabel, costTitle } = useCostLabel();
const { postMessage } = usePlatformBridge();

const teamStore = useTeamStore();
const sessionStore = useSessionStore();
const { selectedTeam, activeTab, isOverlayOpen } = storeToRefs(teamStore);

watch([selectedTeam, isOverlayOpen], ([team, open]) => {
  if (open && team && team.teamId.startsWith('pending-') && team.toolUseId) {
    postMessage({ type: 'requestTeamDataByToolUse', toolUseId: team.toolUseId });
  }
}, { immediate: true });

const TABS = ['agents', 'timeline', 'scratchpad', 'result'] as const;
type Tab = (typeof TABS)[number];

const isRunning = computed(() => selectedTeam.value?.status === 'running');

// The result exists only once the team finishes; a team that ended without one says so on the tab.
function isTabDisabled(tab: Tab): boolean {
  return tab === 'result' && !selectedTeam.value?.result && isRunning.value;
}

function tabCount(tab: Tab): number {
  const team = selectedTeam.value;
  if (!team) return 0;
  if (tab === 'agents') return team.agents.length;
  if (tab === 'timeline') return team.messages.length;
  if (tab === 'scratchpad') return team.scratchpad.length;
  return 0;
}

const tablist = shallowRef<HTMLElement | null>(null);
const activeIndex = computed(() => TABS.indexOf(activeTab.value));
const { box: tabBox, animate: tabAnimate } = useSlidingIndicator(tablist, '[role="tab"]', activeIndex);
// The reference underline: 2px, inset 8px from each side of the tab, on its bottom edge.
const underline = computed(() => tabBox.value && { x: tabBox.value.x + 8, y: tabBox.value.y + tabBox.value.height - 2, width: tabBox.value.width - 16, height: 2 });

function selectTab(tab: Tab): void {
  if (!isTabDisabled(tab)) teamStore.setActiveTab(tab);
}

function onTabKeydown(event: KeyboardEvent): void {
  const enabled = TABS.filter((tab) => !isTabDisabled(tab));
  const current = enabled.indexOf(activeTab.value);
  let next: Tab | undefined;
  if (event.key === 'ArrowRight') next = enabled[(current + 1) % enabled.length];
  else if (event.key === 'ArrowLeft') next = enabled[(current - 1 + enabled.length) % enabled.length];
  else if (event.key === 'Home') next = enabled[0];
  else if (event.key === 'End') next = enabled.at(-1);
  if (!next) return;
  event.preventDefault();
  selectTab(next);
  const index = TABS.indexOf(next);
  void nextTick(() => tablist.value?.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus());
}

const statusBadge = computed(() => {
  const team = selectedTeam.value;
  if (!team) return undefined;
  const awaiting = isRunning.value && (sessionStore.teamAgentsAwaitingUser.get(team.teamId)?.size ?? 0) > 0;
  const chip = agentStatusChip(team.status, awaiting);
  return { label: t(chip.labelKey), class: chip.color, pulse: chip.live || chip.attention };
});

const { elapsedMs } = useElapsedTimer(
  () => isRunning.value,
  () => (selectedTeam.value ? runsStopwatch(selectedTeam.value.runs) : null),
);

const totalUsage = computed(() => (selectedTeam.value?.agents ?? []).reduce(addAgentUsage, emptyAgentUsage()));
// Each agent carries its own flag and a reload restores it, so the total is labelled from the agents
// rather than from the panel account.
const totalBilled = computed(() => teamDollarBilled(selectedTeam.value?.agents ?? []));
const totalTokens = computed(() => agentTotalTokens(totalUsage.value));
const cachePct = computed(() => {
  const rate = agentCacheHitRate(totalUsage.value);
  return rate === null ? 0 : cacheHitPercent(rate);
});
const activeCount = computed(() => workingAgentCount(selectedTeam.value?.agents ?? []));

const stopTeam = useStopTeam(() => selectedTeam.value);

function close(): void {
  teamStore.closeOverlay();
}
</script>

<template>
  <OverlayShell
    v-if="selectedTeam"
    max-width="56.25rem"
    :title="selectedTeam.title"
    :subtitle="t('overlays.team.subtitle', { n: selectedTeam.agents.length })"
    :icon="Users"
    :status-badge="statusBadge"
    @close="close"
  >
    <template #header-actions>
      <OverlayHeaderAction
        v-if="stopTeam.canStop.value"
        :label="stopTeam.stopping.value ? t('toolCall.stopping') : t('agentStop.stopTeam')"
        :icon="Square"
        :busy="stopTeam.stopping.value"
        :disabled="stopTeam.stopping.value"
        data-testid="team-stop"
        @click="stopTeam.request"
      />
    </template>

    <div class="sticky top-0 z-3 bg-(--d-bg)">
      <div class="flex gap-1.5 overflow-x-auto px-4.5 pt-3 [scrollbar-width:none] @min-[35rem]/overlay:flex-wrap">
        <AgentChip
          :icon="Users"
          :value="selectedTeam.agents.length"
          :unit="t('overlays.team.unit.agents', selectedTeam.agents.length)"
        />
        <AgentChip
          :icon="Activity"
          icon-class="text-(--d-accent)"
          :value="activeCount"
          :unit="t('overlays.team.unit.active')"
        />
        <AgentChip
          :icon="Timer"
          data-part="elapsed"
          :value="formatElapsed(elapsedMs)"
          mono
          :title="t('overlays.agent.elapsed')"
        />
        <AgentChip
          :icon="Wrench"
          :value="selectedTeam.totalToolCount"
          :unit="t('overlays.agent.unit.tools', selectedTeam.totalToolCount)"
        />
        <AgentChip
          v-if="totalTokens > 0"
          :icon="Database"
          data-part="tokens"
          :value="formatTokenCount(totalTokens, locale)"
          :unit="t('overlays.agent.unit.tokens', totalTokens)"
        />
        <AgentChip
          v-if="cachePct > 0"
          :icon="Zap"
          data-part="cache"
          :value="`${cachePct}%`"
          :unit="t('overlays.agent.unit.cache')"
          :title="t('agentUsage.cacheHitTooltip')"
        />
        <AgentChip
          v-if="totalUsage.costUsd > 0"
          :icon="Receipt"
          data-part="cost"
          :value="costLabel(totalUsage.costUsd, totalBilled)"
          mono
          :title="costTitle(totalBilled)"
        />
      </div>
      <div
        ref="tablist"
        role="tablist"
        class="relative mt-2.5 flex gap-0.5 overflow-x-auto border-b border-(--d-border) px-3 [scrollbar-width:none]"
        :aria-label="t('overlays.team.tabs')"
        @keydown="onTabKeydown"
      >
        <SlidingIndicator
          :box="underline"
          :radius="1"
          :animate="tabAnimate"
          class="text-(--d-accent)"
        />
        <button
          v-for="tab in TABS"
          :id="`team-tab-${tab}`"
          :key="tab"
          type="button"
          role="tab"
          class="relative flex h-9.5 flex-none items-center gap-1.5 whitespace-nowrap px-2.5 text-12.5 font-medium transition-colors aria-disabled:opacity-45"
          :class="activeTab === tab ? 'text-(--d-text)' : 'text-(--d-muted) hover:text-(--d-text) aria-disabled:hover:text-(--d-muted)'"
          :aria-selected="activeTab === tab"
          :aria-controls="activeTab === tab ? `team-panel-${tab}` : undefined"
          :aria-disabled="isTabDisabled(tab) || undefined"
          :tabindex="activeTab === tab ? 0 : -1"
          :title="isTabDisabled(tab) ? t('overlays.team.resultPending') : undefined"
          :data-testid="`team-tab-${tab}`"
          @click="selectTab(tab)"
        >
          {{ t(`team.tabs.${tab}`) }}
          <span
            v-if="tabCount(tab) > 0"
            class="rounded-full bg-(--d-hover) px-1.5 font-mono text-10.5 text-(--d-muted) @max-[34.9375rem]/overlay:hidden"
          >{{ tabCount(tab) }}</span>
        </button>
      </div>
    </div>

    <Transition
      name="t-fade"
      mode="out-in"
    >
      <div
        :id="`team-panel-${activeTab}`"
        :key="activeTab"
        role="tabpanel"
        :aria-labelledby="`team-tab-${activeTab}`"
        class="px-4.5 pt-3.5 pb-4.5"
      >
        <div
          v-if="activeTab === 'agents'"
          class="grid grid-cols-[repeat(auto-fill,minmax(15.625rem,1fr))] gap-2.5"
        >
          <TeamAgentCard
            v-for="(agent, idx) in selectedTeam.agents"
            :key="agent.agentId"
            :agent="agent"
            :index="idx"
            @stop-team="stopTeam.request"
          />
        </div>

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

        <template v-else>
          <MarkdownRenderer
            v-if="selectedTeam.result"
            :content="selectedTeam.result"
            class="text-13/relaxed"
          />
          <p
            v-else
            class="py-6.5 text-center text-(--d-faint)"
          >
            {{ t('overlays.team.noResult') }}
          </p>
        </template>
      </div>
    </Transition>

    <StopTeamConfirm
      :open="stopTeam.confirming.value"
      :working-count="stopTeam.workingCount.value"
      @confirm="stopTeam.confirm"
      @cancel="stopTeam.cancel"
    />
  </OverlayShell>
</template>
