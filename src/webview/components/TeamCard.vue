<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TeamState, TeamRunSummary } from '@shared/types/team';
import { ChevronRight, LoaderCircle, Square, Users } from 'lucide-vue-next';
import AgentUsageStats from './AgentUsageStats.vue';
import StopTeamConfirm from './StopTeamConfirm.vue';
import { agentStatusChip, formatElapsed, formatTokenCount, getAgentColor, workingAgentCount } from '@/composables/useTeamFormatting';
import { useTeamStore } from '@/stores/useTeamStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useCostLabel } from '@/composables/useCostLabel';
import { useElapsedTimer } from '@/composables/useElapsedTimer';
import { useStopTeam } from '@/composables/useStopTeam';
import { runStopwatch } from '@shared/team-stopwatch';

const { t, locale } = useI18n();
const { teamDollarBilled } = useCostLabel();
const teamStore = useTeamStore();
const sessionStore = useSessionStore();

// Status, time and totals come from `run`; the team supplies the title, roster and billing flags.
const props = defineProps<{
  team: TeamState;
  run: TeamRunSummary;
}>();

defineEmits<{
  (e: 'expand'): void;
}>();

const isRunning = computed(() => props.run.status === 'running');
// Every run but the one its create_team call started is a resume_team call.
const isResume = computed(() => props.run.toolUseId !== props.team.toolUseId);

const { elapsedMs } = useElapsedTimer(() => isRunning.value, () => runStopwatch(props.run));

const stopTeam = useStopTeam(() => props.team);
const stopLabel = computed(() => (stopTeam.stopping.value ? t('toolCall.stopping') : t('agentStop.stopTeam')));

const activeAgentCount = computed(() => workingAgentCount(props.team.agents));

const totalAgentCount = computed(() => props.team.agents.length);

// Only the running run's card speaks for the live team, so an earlier run's card never claims a prompt.
const awaitingAgents = computed<ReadonlySet<string>>(() => (isRunning.value ? sessionStore.teamAgentsAwaitingUser.get(props.team.teamId) : undefined) ?? new Set());

const progressLine = computed(() => {
  const waiting = awaitingAgents.value.size;
  if (isRunning.value && waiting > 0) return t('cards.team.activeWaitingOf', { active: activeAgentCount.value, total: totalAgentCount.value, waiting }, waiting);
  if (isRunning.value) return t('cards.team.activeOf', { active: activeAgentCount.value, total: totalAgentCount.value });
  return props.run.status === 'completed' ? t('cards.team.finished') : t('cards.team.stopped');
});

// Each agent carries its own flag and a reload restores it, so the total is labelled from the agents
// rather than from the panel account.
const totalBilled = computed(() => teamDollarBilled(props.team.agents));

const cardClass = computed(() => {
  switch (props.run.status) {
    case 'running':
      return awaitingAgents.value.size > 0
        ? 'border-[color-mix(in_srgb,var(--d-warning)_45%,var(--d-border))]'
        : 'border-[color-mix(in_srgb,var(--d-accent)_35%,var(--d-border))]';
    case 'failed':
      return 'border-[color-mix(in_srgb,var(--d-danger)_45%,var(--d-border))]';
    default:
      return 'border-(--d-border)';
  }
});

const chip = computed(() => agentStatusChip(props.run.status, awaitingAgents.value.size > 0));

const members = computed(() => props.team.agents.map((agent, index) => ({
  agent,
  color: getAgentColor(index),
  initial: agent.name.charAt(0).toUpperCase(),
  chip: agentStatusChip(agent.status, awaitingAgents.value.has(agent.agentId)),
})));

// The agent opens over its team, so Back returns to the team (Chat Panel.dc.html member chips).
function openMember(agentId: string): void {
  teamStore.openOverlay(props.team.teamId);
  teamStore.openAgentOverlay(agentId);
}
</script>

<template>
  <div
    class="cursor-pointer overflow-hidden rounded-xl border bg-(--d-card) text-13 transition-colors duration-200 hover:border-(--d-border2)"
    :class="cardClass"
    data-testid="team-card"
    @click="$emit('expand')"
  >
    <div class="flex items-center gap-2.5 px-3 pt-2.25 pb-2">
      <span
        class="flex size-7 flex-none items-center justify-center rounded-lg bg-(--d-accent-soft) text-(--d-accent)"
        aria-hidden="true"
      >
        <Users class="size-3.5" />
      </span>
      <div class="flex min-w-0 flex-1 flex-col gap-px">
        <div class="flex min-w-0 items-center gap-2">
          <span class="truncate font-semibold">{{ team.title }}</span>
          <span
            v-if="isResume"
            class="flex-none rounded-full bg-(--d-accent-soft) px-1.5 text-10.5/4 font-medium text-(--d-accent-text)"
          >{{ t('team.resumed') }}</span>
        </div>
        <div class="truncate text-11 text-(--d-faint)">
          <span class="font-semibold text-(--d-accent)">{{ t('cards.team.label') }}</span>
          · {{ t('team.agentCount', { n: totalAgentCount }) }} · {{ progressLine }}
        </div>
      </div>
      <span
        class="flex flex-none items-center gap-1.25 rounded-full bg-[color-mix(in_srgb,var(--tone,currentColor)_13%,transparent)] px-2 py-0.5 text-11 font-medium"
        :class="chip.color"
        data-testid="team-status"
      >
        <component
          :is="chip.icon"
          class="size-2.75"
          :class="[chip.live && 'd-spinning', chip.attention && 'd-pulsing']"
          aria-hidden="true"
        />{{ t(chip.labelKey) }}
      </span>
    </div>

    <div
      v-if="members.length > 0"
      class="flex flex-wrap gap-1.5 pr-3 pb-2.25 pl-12.5"
    >
      <button
        v-for="member in members"
        :key="member.agent.agentId"
        type="button"
        class="flex h-6 items-center gap-1.5 rounded-full border border-(--d-border) bg-(--d-panel) pr-2 pl-1 text-11.5 transition-colors hover:border-(--d-border2)"
        :title="`${member.agent.name} · ${t(`overlays.team.role.${member.agent.role}`)} · ${t(member.chip.labelKey)}`"
        :aria-label="t('cards.team.openAgentStatus', { name: member.agent.name, status: t(member.chip.labelKey) })"
        data-testid="team-card-member"
        @click.stop="openMember(member.agent.agentId)"
      >
        <span
          class="flex size-4 flex-none items-center justify-center rounded-full text-[0.59375rem] font-bold text-(--d-bg)"
          :class="member.color.dot"
          aria-hidden="true"
        >{{ member.initial }}</span>
        <span class="font-medium">{{ member.agent.name }}</span>
        <span class="text-(--d-faint)">{{ t(`overlays.team.role.${member.agent.role}`) }}</span>
        <component
          :is="member.chip.icon"
          class="size-2.75"
          :class="[member.chip.color, isRunning && member.chip.live && 'd-spinning', member.chip.attention && 'd-pulsing']"
          aria-hidden="true"
        />
      </button>
    </div>

    <div class="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-(--d-border) py-1.5 pr-3 pl-12.5 font-mono text-11 text-(--d-faint)">
      <span>{{ t('team.toolCount', { n: run.toolCount }, run.toolCount) }}</span>
      <span class="tabular-nums">{{ formatElapsed(elapsedMs) }}</span>
      <span
        v-if="run.legacyTokens"
        data-part="tokens"
      >{{ t('agentUsage.tokens', { n: formatTokenCount(run.legacyTokens, locale) }, run.legacyTokens) }}</span>
      <AgentUsageStats
        :usage="run.usage"
        :dollar-billed="totalBilled"
        variant="card"
        separator-class="hidden"
        cost-class="text-(--d-muted)"
      />
      <span class="flex-1" />
      <button
        v-if="isRunning && stopTeam.canStop.value"
        type="button"
        class="flex rounded-5 p-0.75 text-(--d-danger) opacity-75 transition-[opacity,background-color] enabled:hover:bg-[color-mix(in_srgb,var(--d-danger)_12%,transparent)] enabled:hover:opacity-100 disabled:opacity-60"
        :title="stopLabel"
        :aria-label="stopLabel"
        :aria-busy="stopTeam.stopping.value || undefined"
        :disabled="stopTeam.stopping.value"
        data-testid="team-card-stop"
        @click.stop="stopTeam.request"
      >
        <LoaderCircle
          v-if="stopTeam.stopping.value"
          class="size-3 d-spinning"
          aria-hidden="true"
        />
        <Square
          v-else
          class="size-3"
          aria-hidden="true"
        />
      </button>
      <button
        type="button"
        class="flex items-center gap-0.75 rounded font-sans text-(--d-muted) hover:text-(--d-text) focus-visible:outline-2 focus-visible:outline-(--d-accent)"
        :aria-label="t('cards.team.open', { name: team.title })"
        @click.stop="$emit('expand')"
      >
        {{ t('cards.details') }}<ChevronRight
          class="size-2.75"
          aria-hidden="true"
        />
      </button>
    </div>

    <StopTeamConfirm
      :open="stopTeam.confirming.value"
      :working-count="stopTeam.workingCount.value"
      @confirm="stopTeam.confirm"
      @cancel="stopTeam.cancel"
    />
  </div>
</template>
