<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TeamAgent } from '@shared/types/team';
import { effortBadgeLabelKey } from '@shared/effort-badge';
import { Ban, FileText, LoaderCircle, Wrench } from 'lucide-vue-next';
import { agentStatusChip, formatElapsed, getAgentColor } from '@/composables/useTeamFormatting';
import AgentUsageStats from './AgentUsageStats.vue';
import { useElapsedTimer } from '@/composables/useElapsedTimer';
import { useModelIdentity } from '@/composables/useModelIdentity';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useStopTeamAgent } from '@/composables/useStopTeam';
import { useTeamStore } from '@/stores/useTeamStore';

const { t } = useI18n();

const props = defineProps<{
  agent: TeamAgent;
  index: number;
}>();

const emit = defineEmits<{
  /** The lead stops only with its team, so its Stop asks the team overlay to confirm a Stop team. */
  (e: 'stopTeam'): void;
}>();

const teamStore = useTeamStore();
const { postMessage } = usePlatformBridge();
const modelIdentity = useModelIdentity();

function openAgentDetail(): void {
  teamStore.openAgentOverlay(props.agent.agentId);
}

// The stopwatch, not the status, says the run is live: an approved member's run keeps counting until it settles.
const { elapsedMs } = useElapsedTimer(() => props.agent.runningSince !== null, () => props.agent);
const hasRun = computed(() => props.agent.activeMs > 0 || props.agent.runningSince !== null);

const color = computed(() => getAgentColor(props.index));
const chip = computed(() => agentStatusChip(props.agent.status));
const model = computed(() => modelIdentity(props.agent.model));

const memberStop = useStopTeamAgent(() => teamStore.selectedTeam, () => props.agent);

function openLog(): void {
  if (props.agent.logFilePath) postMessage({ type: 'openFile', filePath: props.agent.logFilePath });
}

const isLead = computed(() => props.agent.role === 'lead');
const stopping = computed(() => (isLead.value
  ? teamStore.selectedTeam !== null && teamStore.isCancelPending(teamStore.selectedTeam.teamId)
  : memberStop.stopping.value));
const stopLabel = computed(() => {
  if (stopping.value) return t('toolCall.stopping');
  return isLead.value ? t('agentStop.stopTeam') : t('team.agentOverlay.cancelAgent');
});

function cancelAgent(): void {
  if (isLead.value) emit('stopTeam');
  else memberStop.stop();
}
</script>

<template>
  <!-- The name button stretches over the card, so the whole card opens the agent and its own buttons sit above it. -->
  <div
    class="d-arrive relative flex flex-col overflow-hidden rounded-11 border border-(--d-border) bg-(--d-card) text-13 transition-colors hover:border-(--d-border2) has-[[data-card-open]:focus-visible]:outline-2 has-[[data-card-open]:focus-visible]:outline-offset-2 has-[[data-card-open]:focus-visible]:outline-(--d-accent) has-[[data-card-open]:focus-visible]:outline-solid"
    :style="{ animationDelay: `${index * 40}ms` }"
    data-testid="team-agent-card"
  >
    <div class="flex flex-1 flex-col gap-2 px-3 pt-2.75">
      <div class="flex min-w-0 items-center gap-2">
        <span
          class="flex size-6 flex-none items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--tone,currentColor)_18%,transparent)] text-11 font-bold"
          :class="color.avatar"
          aria-hidden="true"
        >{{ agent.name.charAt(0).toUpperCase() }}</span>
        <button
          type="button"
          class="flex-none whitespace-nowrap font-semibold outline-none after:absolute after:inset-0 after:content-['']"
          :aria-label="t('cards.team.openAgent', { name: agent.name })"
          :title="t('cards.team.openAgent', { name: agent.name })"
          data-card-open
          @click="openAgentDetail"
        >
          {{ agent.name }}
        </button>
        <span class="min-w-0 truncate rounded-5 bg-(--d-hover) px-1.5 text-10.5 text-(--d-muted)">{{ t(`overlays.team.role.${agent.role}`) }}</span>
        <span class="flex-1" />
        <span
          class="flex flex-none items-center gap-1 whitespace-nowrap rounded-full bg-[color-mix(in_srgb,var(--tone,currentColor)_14%,transparent)] px-1.75 py-px text-10.5 font-medium @max-[34.9375rem]/overlay:p-1"
          :class="chip.color"
          :title="t(chip.labelKey)"
          data-testid="team-agent-status"
        >
          <component
            :is="chip.icon"
            class="size-2.5"
            :class="chip.live && 'd-spinning'"
            aria-hidden="true"
          />
          <span class="@max-[34.9375rem]/overlay:sr-only">{{ t(chip.labelKey) }}</span>
        </span>
      </div>

      <p
        v-if="agent.specialization"
        class="text-xs text-(--d-muted) text-pretty"
      >
        {{ agent.specialization }}
      </p>

      <div
        v-if="model || agent.effort"
        class="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-11 text-(--d-faint)"
      >
        <!-- eslint-disable vue/no-v-html -- a vendored static logo constant (provider-logos.ts) -->
        <span
          v-if="model?.logo"
          class="size-3 flex-none [&>svg]:size-full"
          aria-hidden="true"
          v-html="model.logo"
        />
        <!-- eslint-enable vue/no-v-html -->
        <span
          v-if="model"
          class="min-w-0 truncate text-(--d-text)"
        >{{ model.name }}</span>
        <template v-if="agent.effort">
          <span v-if="model">·</span>
          <span
            class="flex-none"
            data-testid="team-agent-effort"
          >{{ t('overlays.agent.effortLevel', { level: t(effortBadgeLabelKey(agent.effort)) }) }}</span>
        </template>
      </div>

      <div
        v-if="agent.lastToolName"
        class="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-11 text-(--d-faint)"
      >
        <Wrench
          class="size-2.75 flex-none"
          aria-hidden="true"
        />
        <span class="flex-none">{{ t('overlays.team.lastTool') }}</span>
        <span class="min-w-0 truncate font-mono text-(--d-muted)">{{ agent.lastToolName }}</span>
      </div>
    </div>

    <div class="mt-2.25 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 whitespace-nowrap border-t border-(--d-border) py-1.5 pr-2 pl-3 font-mono text-10.5 text-(--d-faint)">
      <span>{{ t('team.toolCount', { n: agent.toolCount }, agent.toolCount) }}</span>
      <span
        v-if="hasRun"
        class="tabular-nums"
      >{{ formatElapsed(elapsedMs) }}</span>
      <AgentUsageStats
        :usage="agent"
        :dollar-billed="agent.dollarBilled"
        variant="card"
        separator-class="hidden"
        cost-class="text-(--d-muted)"
      />
      <span class="min-w-0 flex-1" />
      <button
        v-if="agent.logFilePath"
        type="button"
        class="relative flex rounded-5 p-0.75 transition-colors hover:bg-(--d-hover) hover:text-(--d-text)"
        :title="t('team.agentOverlay.openLogFile')"
        :aria-label="t('team.agentOverlay.openLogFile')"
        @click="openLog"
      >
        <FileText
          class="size-3"
          aria-hidden="true"
        />
      </button>
      <button
        v-if="memberStop.canStop.value"
        type="button"
        class="relative flex rounded-5 p-0.75 text-(--d-danger) opacity-75 transition-[opacity,background-color] enabled:hover:bg-[color-mix(in_srgb,var(--d-danger)_12%,transparent)] enabled:hover:opacity-100 disabled:opacity-60"
        :title="stopLabel"
        :aria-label="stopLabel"
        :aria-busy="stopping || undefined"
        :disabled="stopping"
        data-testid="team-agent-card-stop"
        @click="cancelAgent"
      >
        <LoaderCircle
          v-if="stopping"
          class="size-3 d-spinning"
          aria-hidden="true"
        />
        <Ban
          v-else
          class="size-3"
          aria-hidden="true"
        />
      </button>
    </div>
  </div>
</template>
