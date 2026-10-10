<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { CircleAlert, Database, FileText, Gauge, IdCard, LoaderCircle, Receipt, Send, Square, Timer, UserRound, Wrench, Zap } from 'lucide-vue-next';
import { STEER_INSTRUCTION_PREFIX, stripSteerPrefix } from '@shared/steer';
import { effortBadgeLabelKey } from '@shared/effort-badge';
import { agentCacheHitRate, agentTotalTokens } from '@shared/usage-accounting';
import type { ImageBlock } from '@shared/types/content';
import type { TeamAgentStatus } from '@shared/types/team';
import OverlayShell from './OverlayShell.vue';
import OverlayHeaderAction from './OverlayHeaderAction.vue';
import AgentChip from './agent-view/AgentChip.vue';
import AgentPromptDisclosure from './agent-view/AgentPromptDisclosure.vue';
import AgentResult from './agent-view/AgentResult.vue';
import AgentSteerBar from './agent-view/AgentSteerBar.vue';
import SteerImageChips from './SteerImageChips.vue';
import ImageLightbox from './ImageLightbox.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import ThinkingIndicator from './ThinkingIndicator.vue';
import ToolCallCard from './ToolCallCard.vue';
import TranscriptNotice from './TranscriptNotice.vue';
import ErrorMessageText from './ErrorMessageText.vue';
import StopTeamConfirm from './StopTeamConfirm.vue';
import { useTeamStore, type AgentChatMessage } from '@/stores/useTeamStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useCostLabel } from '@/composables/useCostLabel';
import { useModelIdentity } from '@/composables/useModelIdentity';
import { useOverlaySteer } from '@/composables/useOverlaySteer';
import { useAppendedIds } from '@/composables/useAppendedIds';
import { imageBlockToDataUrl } from '@/utils/imageUtils';
import { cacheHitPercent } from '@/utils/cacheHitPercent';
import { formatClock } from '@/utils/clock';
import { agentStatusChip, formatElapsed, formatTokenCount, getAgentColor } from '@/composables/useTeamFormatting';
import { useElapsedTimer } from '@/composables/useElapsedTimer';
import { useStopTeam, useStopTeamAgent } from '@/composables/useStopTeam';

const { t, locale } = useI18n();
const { postMessage } = usePlatformBridge();
const { costLabel, costTitle } = useCostLabel();
const modelIdentity = useModelIdentity();
const teamStore = useTeamStore();
const sessionStore = useSessionStore();
const { selectedTeam, selectedAgent, currentAgentMessages, currentAgentStreaming, isAgentOverlayOpen, agentRetry } = storeToRefs(teamStore);

const ALIVE: ReadonlySet<TeamAgentStatus> = new Set(['running', 'pending', 'awaiting-review', 'standby', 'monitoring']);
const WAITING: ReadonlySet<TeamAgentStatus> = new Set(['pending', 'awaiting-review', 'standby', 'monitoring']);

const agentIndex = computed(() => {
  if (!selectedTeam.value || !selectedAgent.value) return -1;
  return selectedTeam.value.agents.findIndex(a => a.agentId === selectedAgent.value?.agentId);
});

const color = computed(() => getAgentColor(agentIndex.value));
const awaitingUser = computed(() => Boolean(selectedTeam.value && selectedAgent.value && sessionStore.teamAgentsAwaitingUser.get(selectedTeam.value.teamId)?.has(selectedAgent.value.agentId)));
const chip = computed(() => (selectedAgent.value ? agentStatusChip(selectedAgent.value.status, awaitingUser.value) : null));
const model = computed(() => modelIdentity(selectedAgent.value?.model));

const lightboxImageUrl = ref<string | null>(null);

function openLightbox(block: ImageBlock): void {
  lightboxImageUrl.value = imageBlockToDataUrl(block);
}

// The marker opens an operator /steer and a resumed lead's prompt alike, so the label must not name a sender.
function isSteer(content: string): boolean {
  return content.startsWith(STEER_INSTRUCTION_PREFIX);
}

// The note format core's agent-runner.ts delivers a teammate's message in.
const PEER_MESSAGE = /^\[Message from ([^\]]+)\]: ([\s\S]*)$/;

const { elapsedMs } = useElapsedTimer(
  () => selectedAgent.value?.runningSince != null,
  () => selectedAgent.value ?? null,
);

// The retry pi waits out before re-sending a failed call outranks the progress summary.
const workingLine = computed(() => {
  const retry = selectedAgent.value ? agentRetry.value[selectedAgent.value.agentId] : undefined;
  if (retry) return t('status.retrying', { attempt: retry.attempt, max: retry.maxAttempts });
  return selectedAgent.value?.progressSummary || t('overlays.agent.working');
});

const statusBadge = computed(() => (chip.value ? { label: t(chip.value.labelKey), class: chip.value.color, pulse: chip.value.live || chip.value.attention } : undefined));

const subtitle = computed(() => {
  if (!selectedAgent.value || !selectedTeam.value) return '';
  return `${t(`overlays.team.role.${selectedAgent.value.role}`)} · ${selectedTeam.value.title}`;
});

const totalTokens = computed(() => (selectedAgent.value ? agentTotalTokens(selectedAgent.value) : 0));
const cachePct = computed(() => {
  const rate = selectedAgent.value ? agentCacheHitRate(selectedAgent.value) : null;
  return rate === null ? 0 : cacheHitPercent(rate);
});

const teamRunning = computed(() => selectedTeam.value?.status === 'running');

const canSteer = computed(() => Boolean(selectedAgent.value && ALIVE.has(selectedAgent.value.status) && teamRunning.value));
const steer = useOverlaySteer(() => selectedAgent.value?.agentId);

// A loaded history opens with the member's dispatch; live-only messages may start anywhere, so nothing is promoted then.
const prompt = computed(() => {
  const agent = selectedAgent.value;
  const first = currentAgentMessages.value[0];
  if (!agent || !first || first.role !== 'user' || !teamStore.isAgentHistoryLoaded(agent.agentId)) return null;
  if (isSteer(first.content) || PEER_MESSAGE.test(first.content)) return null;
  return first;
});

const promptFrom = computed(() => {
  if (selectedAgent.value?.role === 'lead') return t('overlays.agent.fromMainAgent');
  return selectedTeam.value?.agents.find((agent) => agent.role === 'lead')?.name ?? t('overlays.agent.fromLead');
});

const transcript = computed(() => (prompt.value ? currentAgentMessages.value.slice(1) : currentAgentMessages.value));
// Streamed text seals into a new message, so only steers, peer messages and tool cards play an entrance.
const arrived = useAppendedIds(() => transcript.value.map((message) => message.id));

function peerMessage(message: AgentChatMessage): { from: string; body: string; color: ReturnType<typeof getAgentColor> } | null {
  if (message.role !== 'user') return null;
  const match = PEER_MESSAGE.exec(message.content);
  if (!match) return null;
  const from = match[1] ?? '';
  return { from, body: match[2] ?? '', color: getAgentColor(selectedTeam.value?.agents.findIndex((agent) => agent.name === from) ?? -1) };
}

function close(): void {
  teamStore.closeAgentOverlay();
}

// The lead stops only with its team, so its Stop is the team's, behind the same confirmation.
const stopTeam = useStopTeam(() => selectedTeam.value);
const memberStop = useStopTeamAgent(() => selectedTeam.value, () => selectedAgent.value);
const isLead = computed(() => selectedAgent.value?.role === 'lead');
const stopping = computed(() => (isLead.value ? stopTeam.stopping.value : memberStop.stopping.value));

function cancelAgent(): void {
  if (isLead.value) stopTeam.request();
  else memberStop.stop();
}

function openLog(): void {
  if (!selectedAgent.value?.logFilePath) return;
  postMessage({ type: 'openFile', filePath: selectedAgent.value.logFilePath });
}

function requestAgentHistory(): void {
  if (!selectedAgent.value || !selectedTeam.value) return;
  postMessage({
    type: 'requestTeamAgentData',
    teamId: selectedTeam.value.teamId,
    agentId: selectedAgent.value.agentId,
  });
}

// Live messages start where this panel began listening, so a member resumed after a reload has its
// earlier turns only on disk even while its list is not empty.
watch(() => selectedAgent.value?.agentId, (agentId) => {
  if (agentId && !teamStore.isAgentHistoryLoaded(agentId)) requestAgentHistory();
}, { immediate: true });

watch(() => selectedAgent.value?.status, (newStatus, oldStatus) => {
  if (oldStatus === 'running' && newStatus && newStatus !== 'running' && currentAgentMessages.value.length === 0) {
    requestAgentHistory();
  }
});
</script>

<template>
  <OverlayShell
    v-if="selectedAgent && isAgentOverlayOpen"
    max-width="51.25rem"
    :title="selectedAgent.name"
    :subtitle="subtitle"
    :icon="UserRound"
    :icon-class="color.text"
    :status-badge="statusBadge"
    :follow-key="selectedAgent.agentId"
    :has-draft="steer.text.value.trim() !== ''"
    @close="close"
  >
    <template #header-actions>
      <OverlayHeaderAction
        v-if="selectedAgent.logFilePath"
        :label="t('overlays.agent.log')"
        :title="t('team.agentOverlay.openLogFile')"
        :icon="FileText"
        @click="openLog"
      />
      <OverlayHeaderAction
        v-if="memberStop.canStop.value"
        :label="stopping ? t('toolCall.stopping') : isLead ? t('agentStop.stopTeam') : t('overlays.agent.stop')"
        :title="stopping ? t('toolCall.stopping') : isLead ? t('agentStop.stopTeam') : t('team.agentOverlay.cancelAgent')"
        :icon="Square"
        :busy="stopping"
        :disabled="stopping"
        data-testid="team-agent-stop"
        @click="cancelAgent"
      />
    </template>

    <div class="sticky top-0 z-3 flex gap-1.5 overflow-x-auto border-b border-(--d-border) bg-(--d-bg) px-4.5 pt-3 pb-2.5 [scrollbar-width:none] @min-[35rem]/overlay:flex-wrap">
      <AgentChip
        :icon="IdCard"
        :icon-class="color.text"
        :value-class="color.text"
        :value="t(`overlays.team.role.${selectedAgent.role}`)"
        :title="selectedAgent.specialization || undefined"
      />
      <AgentChip
        v-if="model"
        :logo="model.logo"
        :value="model.name"
      />
      <AgentChip
        v-if="selectedAgent.effort"
        :icon="Gauge"
        :value="t(effortBadgeLabelKey(selectedAgent.effort))"
        :unit="t('overlays.agent.unit.effort')"
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
        :value="selectedAgent.toolCount"
        :unit="t('overlays.agent.unit.tools', selectedAgent.toolCount)"
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
        v-if="selectedAgent.costUsd > 0"
        :icon="Receipt"
        data-part="cost"
        :value="costLabel(selectedAgent.costUsd, selectedAgent.dollarBilled)"
        mono
        :title="costTitle(selectedAgent.dollarBilled)"
      />
    </div>

    <div class="flex flex-col gap-3 px-4.5 pt-3.5 pb-4.5">
      <AgentPromptDisclosure
        v-if="prompt"
        :prompt="prompt.content"
        :from="promptFrom"
      />

      <div class="flex flex-col gap-2.25">
        <p
          v-if="transcript.length === 0 && !currentAgentStreaming && !ALIVE.has(selectedAgent.status)"
          class="py-6 text-center text-12.5 text-(--d-faint)"
        >
          {{ t('team.agentOverlay.noConversationData') }}
        </p>

        <div
          v-for="msg in transcript"
          :key="msg.id"
          :class="msg.role === 'user' && arrived.has(msg.id) && 'd-arrive'"
        >
          <div
            v-if="msg.role === 'user' && isSteer(msg.content)"
            class="flex justify-end"
            data-testid="agent-steer-message"
          >
            <div class="max-w-[85%] rounded-[0.875rem_0.875rem_0.3125rem_0.875rem] border border-[color-mix(in_srgb,var(--d-warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--d-warning)_7%,transparent)] px-3 pt-2 pb-2.25">
              <div class="mb-0.5 flex items-center gap-1.5 text-11 font-semibold text-(--d-warning-text)">
                <Send
                  class="size-2.75"
                  aria-hidden="true"
                />{{ t('subagentDisplay.steered') }}
                <span class="font-normal text-(--d-faint-text)">{{ formatClock(msg.timestamp) }}</span>
              </div>
              <SteerImageChips
                :images="msg.images ?? []"
                @open-lightbox="openLightbox"
              />
              <MarkdownRenderer
                :content="stripSteerPrefix(msg.content)"
                class="text-12.5 [&_.markdown-p]:my-0"
              />
            </div>
          </div>
          <div
            v-else-if="peerMessage(msg)"
            class="flex items-start gap-2"
            data-testid="agent-peer-message"
          >
            <span
              class="mt-0.5 flex size-5 flex-none items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--tone,currentColor)_18%,transparent)] text-10 font-bold"
              :class="peerMessage(msg)!.color.avatar"
              aria-hidden="true"
            >{{ peerMessage(msg)!.from.charAt(0).toUpperCase() }}</span>
            <div class="min-w-0 max-w-[85%] flex-1 rounded-[0.3125rem_0.875rem_0.875rem_0.875rem] border border-(--d-border) bg-(--d-card) px-2.75 pt-1.75 pb-2">
              <div
                class="mb-0.5 text-11 font-semibold"
                :class="peerMessage(msg)!.color.text"
              >
                {{ t('overlays.agent.messageFrom', { name: peerMessage(msg)!.from }) }}
              </div>
              <MarkdownRenderer
                :content="peerMessage(msg)!.body"
                class="text-12.5 [&_.markdown-p]:my-0"
              />
            </div>
          </div>
          <div
            v-else-if="msg.role === 'user'"
            class="rounded-10 border border-(--d-border) bg-(--d-card) px-3 py-2 text-12.5 text-(--d-muted)"
          >
            <MarkdownRenderer :content="msg.content" />
          </div>
          <TranscriptNotice
            v-else-if="msg.role === 'error'"
            tone="danger"
            :icon="CircleAlert"
            :title="t('common.error')"
            data-testid="agent-error"
          >
            <ErrorMessageText
              class="text-12.5 wrap-break-word whitespace-pre-wrap text-(--d-text)"
              :text="msg.content"
            />
          </TranscriptNotice>

          <div
            v-else
            class="flex flex-col gap-2.25"
          >
            <ThinkingIndicator
              v-if="msg.thinking"
              :thinking="msg.thinking"
            />
            <MarkdownRenderer
              v-if="msg.content"
              :content="msg.content"
              class="text-13 leading-[1.6]"
            />
            <ToolCallCard
              v-for="tool in msg.toolCalls ?? []"
              :key="tool.id"
              :class="arrived.has(msg.id) && 'd-arrive'"
              :tool-call="tool"
              source="team"
            />
          </div>
        </div>

        <template v-if="currentAgentStreaming">
          <ThinkingIndicator
            v-if="currentAgentStreaming.isThinkingPhase || currentAgentStreaming.thinking"
            :thinking="currentAgentStreaming.thinking"
            :is-streaming="currentAgentStreaming.isThinkingPhase"
          />
          <MarkdownRenderer
            v-if="currentAgentStreaming.text"
            :content="currentAgentStreaming.text"
            class="text-13 leading-[1.6]"
          />
        </template>

        <div
          v-if="selectedAgent.status === 'running'"
          class="flex items-center gap-2 p-0.5 text-12.5"
          data-testid="agent-working"
        >
          <LoaderCircle
            class="size-3.5 d-spinning flex-none text-(--d-accent)"
            aria-hidden="true"
          />
          <span class="d-glint min-w-0 truncate italic text-(--d-muted)">{{ workingLine }}<span
            class="d-glint-window text-(--d-text)"
            aria-hidden="true"
          ><span>{{ workingLine }}</span></span></span>
          <span class="flex-1" />
          <span class="font-mono text-11 text-(--d-faint)">{{ formatElapsed(elapsedMs) }}</span>
        </div>
        <div
          v-else-if="WAITING.has(selectedAgent.status) && chip"
          class="flex items-center gap-2 p-0.5 text-12.5"
          :class="chip.color"
        >
          <component
            :is="chip.icon"
            class="size-3.5"
            aria-hidden="true"
          />
          {{ selectedAgent.progressSummary || t(chip.labelKey) }}
        </div>
      </div>

      <AgentResult
        v-if="selectedAgent.result"
        :content="selectedAgent.result"
        :status="selectedAgent.status"
      />
    </div>

    <template
      v-if="canSteer"
      #footer
    >
      <AgentSteerBar
        v-model="steer.text.value"
        :placeholder="t('overlays.agent.steerMember', { name: selectedAgent.name })"
        :sending="steer.sending.value"
        :failed="steer.failed.value"
        :can-send="steer.canSend.value"
        @send="steer.send"
      />
    </template>

    <ImageLightbox
      :open="lightboxImageUrl !== null"
      :image-url="lightboxImageUrl ?? ''"
      @close="lightboxImageUrl = null"
    />

    <StopTeamConfirm
      :open="stopTeam.confirming.value"
      :working-count="stopTeam.workingCount.value"
      @confirm="stopTeam.confirm"
      @cancel="stopTeam.cancel"
    />
  </OverlayShell>
</template>
