<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SubagentState } from '@shared/types/subagents';
import type { ChatMessage, ToolCall } from '@shared/types/session';
import { isImageBlock, type ContentBlock, type ImageBlock } from '@shared/types/content';
import { effortBadgeLabelKey } from '@shared/effort-badge';
import { agentCacheHitRate, agentTotalTokens } from '@shared/usage-accounting';
import { Bot, CircleAlert, ClipboardList, Compass, Database, FileText, Gauge, Loader, LoaderCircle, Receipt, SearchCheck, Send, Square, Timer, Wrench, Zap } from 'lucide-vue-next';
import ToolCallCard from './ToolCallCard.vue';
import TranscriptNotice from './TranscriptNotice.vue';
import ErrorMessageText from './ErrorMessageText.vue';
import ThinkingIndicator from './ThinkingIndicator.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import OverlayShell from './OverlayShell.vue';
import OverlayHeaderAction from './OverlayHeaderAction.vue';
import AgentChip from './agent-view/AgentChip.vue';
import AgentPromptDisclosure from './agent-view/AgentPromptDisclosure.vue';
import AgentResult from './agent-view/AgentResult.vue';
import AgentSteerBar from './agent-view/AgentSteerBar.vue';
import SteerImageChips from './SteerImageChips.vue';
import ImageLightbox from './ImageLightbox.vue';
import { stripSteerPrefix } from '@shared/steer';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useCostLabel } from '@/composables/useCostLabel';
import { useModelIdentity } from '@/composables/useModelIdentity';
import { useOverlaySteer } from '@/composables/useOverlaySteer';
import { useSubagentStop } from '@/composables/useSubagentStop';
import { useAppendedIds } from '@/composables/useAppendedIds';
import { agentStatusChip, formatElapsed, formatTokenCount } from '@/composables/useTeamFormatting';
import { useBackgroundTaskStore } from '@/stores/useBackgroundTaskStore';
import { subagentTypeLabelKey } from '@/utils/subagentTypeLabel';
import { ownEntry } from '@/utils/ownEntry';
import { imageBlockToDataUrl } from '@/utils/imageUtils';
import { cacheHitPercent } from '@/utils/cacheHitPercent';
import { subagentHeading, subagentStatusLine, subagentToolCount } from '@/stores/useSubagentStore';

const { t, locale } = useI18n();
const { postMessage } = usePlatformBridge();
const { costLabel, costTitle } = useCostLabel();
const modelIdentity = useModelIdentity();
const backgroundTaskStore = useBackgroundTaskStore();

interface StreamingState {
  content?: string;
  thinking?: string;
  thinkingDuration?: number;
  isThinkingPhase?: boolean;
}

const props = defineProps<{
  subagent: SubagentState;
  streaming?: StreamingState | undefined;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'openLog', agentId: string): void;
}>();

const lightboxImageUrl = ref<string | null>(null);

function openLightbox(block: ImageBlock): void {
  lightboxImageUrl.value = imageBlockToDataUrl(block);
}
const elapsedSeconds = ref(0);
let timerInterval: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  updateElapsed();
  if (props.subagent.status === 'running') timerInterval = setInterval(updateElapsed, 1000);
});

onUnmounted(() => {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
});

function updateElapsed(): void {
  const endTime = props.subagent.endTime ?? Date.now();
  elapsedSeconds.value = Math.floor((endTime - props.subagent.startTime) / 1000);
}

const AGENT_ICONS: Record<string, Component> = {
  'code-reviewer': SearchCheck,
  Explore: Compass,
  Plan: ClipboardList,
  'general-purpose': Bot,
};

const agentIcon = computed((): Component => {
  const type = props.subagent.agentType;
  return (type !== undefined ? ownEntry(AGENT_ICONS, type) : undefined) ?? Bot;
});

const chip = computed(() => agentStatusChip(props.subagent.status));
const isRunning = computed(() => props.subagent.status === 'running');
const workingLine = computed(() => subagentStatusLine(props.subagent, t) ?? t('overlays.agent.working'));

const statusBadge = computed(() => ({ label: t(chip.value.labelKey), class: chip.value.color, pulse: chip.value.live }));

const displayAgentType = computed((): string | null => {
  const type = props.subagent.agentType;
  if (type === undefined) return null;
  const key = subagentTypeLabelKey(type);
  return key ? t(key) : type;
});

const subtitle = computed(() => [
  displayAgentType.value !== null ? t('overlays.agent.subagentOfType', { type: displayAgentType.value }) : t('overlays.agent.subagent'),
  props.subagent.isBackground ? t('overlays.agent.inBackground') : null,
  t('overlays.agent.startedByMain'),
].filter(Boolean).join(' · '));

const hasPrompt = computed(() => Boolean(props.subagent.prompt?.trim()));

const hasStreamingContent = computed(() =>
  props.streaming && (props.streaming.content || props.streaming.thinking || props.streaming.isThinkingPhase)
);

const resultContent = computed(() =>
  props.subagent.result?.content || props.subagent.lastAssistantMessage
);
const hasResult = computed(() => Boolean(resultContent.value));

const toolCount = computed(() => subagentToolCount(props.subagent));

// The extension resolves the authoritative display label (custom providers included), so it is matched
// to a listed model only for its logo and otherwise shown verbatim.
const model = computed(() => modelIdentity(props.subagent.model));

const totalTokens = computed(() => (props.subagent.usage ? agentTotalTokens(props.subagent.usage) : 0));
const cachePct = computed(() => {
  const rate = props.subagent.usage ? agentCacheHitRate(props.subagent.usage) : null;
  return rate === null ? 0 : cacheHitPercent(rate);
});

function openTemplate(): void {
  if (props.subagent.templatePath) {
    postMessage({ type: 'openFile', filePath: props.subagent.templatePath });
  }
}

const subagentStop = useSubagentStop();
const stopping = computed(() => subagentStop.isStopping(props.subagent));

function stop(): void {
  if (props.subagent.sdkAgentId) subagentStop.stop(props.subagent.sdkAgentId);
}

const canSteer = computed(() => isRunning.value && Boolean(props.subagent.sdkAgentId));
const steer = useOverlaySteer(() => props.subagent.sdkAgentId);

// Streamed text seals into a new message, so only steers and tool cards play an entrance.
const arrived = useAppendedIds(() => props.subagent.messages.map((message) => message.id));

// Messages are replaced, never mutated, so a cached array stays correct and keeps the chips' props stable across renders.
const steerImageCache = new WeakMap<ChatMessage, ImageBlock[]>();

function steerImages(message: ChatMessage): ImageBlock[] {
  let images = steerImageCache.get(message);
  if (!images) {
    images = message.contentBlocks?.filter(isImageBlock) ?? [];
    steerImageCache.set(message, images);
  }
  return images;
}

function isTextBlock(block: ContentBlock): block is { type: 'text'; text: string } {
  return block.type === 'text';
}

function isToolUseBlock(block: ContentBlock): block is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } {
  return block.type === 'tool_use';
}

function isThinkingBlock(block: ContentBlock): block is { type: 'thinking'; thinking: string } {
  return block.type === 'thinking';
}

/** Zero or one entry, so the template can `v-for` over it and get a narrowed `ToolCall`. */
function toolCallsById(message: ChatMessage, toolId: string): ToolCall[] {
  const tool = message.toolCalls?.find(t => t.id === toolId);
  return tool ? [tool] : [];
}

function getBlockKey(block: ContentBlock, index: number): string {
  if (isToolUseBlock(block)) return `tool-${block.id}`;
  return `block-${index}`;
}

// A user-role message in a subagent transcript is a steer (the leading prompt is stripped upstream):
// the live echo carries plain `content`, the on-disk transcript maps it into text blocks — read either.
// The injected priority marker is stripped so the overlay shows the raw instruction (already labelled).
function userMessageText(message: ChatMessage): string {
  const raw = message.content?.trim()
    ? message.content
    : (message.contentBlocks ?? [])
        .filter(isTextBlock)
        .map((b) => b.text)
        .join('\n');
  return stripSteerPrefix(raw);
}
</script>

<template>
  <OverlayShell
    :title="subagentHeading(subagent, t).title"
    :subtitle="subtitle"
    :icon="agentIcon"
    icon-class="text-(--d-info)"
    :status-badge="statusBadge"
    :follow-key="subagent.id"
    :has-draft="steer.text.value.trim() !== ''"
    @close="emit('close')"
  >
    <template #header-actions>
      <OverlayHeaderAction
        v-if="subagent.sdkAgentId"
        :label="t('overlays.agent.log')"
        :title="t('subagentDisplay.openLog')"
        :icon="FileText"
        @click="emit('openLog', subagent.sdkAgentId)"
      />
      <OverlayHeaderAction
        v-if="subagentStop.canStop(subagent)"
        :label="stopping ? t('toolCall.stopping') : t('overlays.agent.stop')"
        :title="stopping ? t('toolCall.stopping') : t('agentStop.stopSubagent')"
        :icon="Square"
        :busy="stopping"
        :disabled="stopping"
        data-testid="subagent-stop"
        @click="stop"
      />
    </template>

    <div class="sticky top-0 z-3 flex gap-1.5 overflow-x-auto border-b border-(--d-border) bg-(--d-bg) px-4.5 pt-3 pb-2.5 [scrollbar-width:none] @min-[35rem]/overlay:flex-wrap">
      <AgentChip
        v-if="displayAgentType !== null"
        :icon="agentIcon"
        icon-class="text-(--d-info)"
        value-class="text-(--d-info)"
        :value="displayAgentType"
        :clickable="Boolean(subagent.templatePath)"
        :title="subagent.templatePath ? t('subagentDisplay.openTemplate', { path: subagent.templatePath }) : undefined"
        data-testid="subagent-type-chip"
        @click="openTemplate"
      />
      <AgentChip
        v-if="subagent.isBackground"
        :icon="Loader"
        :value="t('backgroundTask.background')"
        clickable
        :title="t('overlays.agent.openBackgroundTasks')"
        data-testid="subagent-background-chip"
        @click="backgroundTaskStore.openOverlay()"
      />
      <AgentChip
        v-if="model"
        :logo="model.logo"
        :value="model.name"
      />
      <AgentChip
        v-if="subagent.effort"
        :icon="Gauge"
        :value="t(effortBadgeLabelKey(subagent.effort))"
        :unit="t('overlays.agent.unit.effort')"
      />
      <AgentChip
        :icon="Timer"
        data-part="elapsed"
        :value="formatElapsed(elapsedSeconds * 1000)"
        mono
        :title="t('overlays.agent.elapsed')"
      />
      <AgentChip
        v-if="toolCount > 0"
        :icon="Wrench"
        :value="toolCount"
        :unit="t('overlays.agent.unit.tools', toolCount)"
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
        v-if="subagent.usage && subagent.usage.costUsd > 0"
        :icon="Receipt"
        data-part="cost"
        :value="costLabel(subagent.usage.costUsd, subagent.dollarBilled)"
        mono
        :title="costTitle(subagent.dollarBilled)"
      />
    </div>

    <div class="flex flex-col gap-3 px-4.5 pt-3.5 pb-4.5">
      <AgentPromptDisclosure
        v-if="hasPrompt"
        :prompt="subagent.prompt"
        :from="t('overlays.agent.fromMainAgent')"
      />

      <div class="flex flex-col gap-2.25">
        <template
          v-for="message in subagent.messages"
          :key="message.id"
        >
          <div
            v-if="message.role === 'user'"
            class="flex justify-end"
            :class="arrived.has(message.id) && 'd-arrive'"
            data-testid="agent-steer-message"
          >
            <div class="max-w-[85%] rounded-[0.875rem_0.875rem_0.3125rem_0.875rem] border border-[color-mix(in_srgb,var(--d-warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--d-warning)_7%,transparent)] px-3 pt-2 pb-2.25">
              <div class="mb-0.5 flex items-center gap-1.5 text-11 font-semibold text-(--d-warning-text)">
                <Send
                  class="size-2.75"
                  aria-hidden="true"
                />{{ t('subagentDisplay.steered') }}
              </div>
              <SteerImageChips
                :images="steerImages(message)"
                @open-lightbox="openLightbox"
              />
              <MarkdownRenderer
                :content="userMessageText(message)"
                class="text-12.5 [&_.markdown-p]:my-0"
              />
            </div>
          </div>
          <TranscriptNotice
            v-else-if="message.role === 'error'"
            tone="danger"
            :icon="CircleAlert"
            :title="t('common.error')"
            data-testid="agent-error"
          >
            <ErrorMessageText
              class="text-12.5 wrap-break-word whitespace-pre-wrap text-(--d-text)"
              :text="message.content"
            />
          </TranscriptNotice>
          <template v-else-if="message.contentBlocks?.length">
            <template
              v-for="(block, blockIndex) in message.contentBlocks"
              :key="getBlockKey(block, blockIndex)"
            >
              <ThinkingIndicator
                v-if="isThinkingBlock(block)"
                :thinking="block.thinking"
                :default-expanded="true"
              />
              <MarkdownRenderer
                v-else-if="isTextBlock(block)"
                class="text-13 leading-[1.6]"
                :content="block.text"
              />
              <template v-else-if="isToolUseBlock(block)">
                <ToolCallCard
                  v-for="tc in toolCallsById(message, block.id)"
                  :key="tc.id"
                  :class="arrived.has(message.id) && 'd-arrive'"
                  :tool-call="tc"
                  source="subagent"
                />
              </template>
            </template>
          </template>
        </template>

        <!-- Live streaming tool calls (rare: a tool normally seals into its message before it executes) -->
        <ToolCallCard
          v-for="tool in subagent.toolCalls"
          :key="tool.id"
          :tool-call="tool"
          source="subagent"
        />

        <!-- Live in-flight message rendered last, in source order (thinking → text), like the main session -->
        <ThinkingIndicator
          v-if="hasStreamingContent && (streaming?.thinking || streaming?.isThinkingPhase)"
          :thinking="streaming?.thinking"
          :is-streaming="streaming?.isThinkingPhase"
          :duration="streaming?.thinkingDuration"
        />

        <MarkdownRenderer
          v-if="hasStreamingContent && streaming?.content"
          :content="streaming.content"
          class="text-13 leading-[1.6] opacity-80"
        />

        <div
          v-if="isRunning"
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
          <span class="font-mono text-11 text-(--d-faint)">{{ formatElapsed(elapsedSeconds * 1000) }}</span>
        </div>

        <p
          v-else-if="!hasResult && subagent.messages.length === 0 && subagent.toolCalls.length === 0"
          class="py-6 text-center text-12.5 text-(--d-faint)"
        >
          {{ t('subagentDisplay.noActivity') }}
        </p>
      </div>

      <AgentResult
        v-if="hasResult"
        :content="resultContent!"
        :status="subagent.status"
        :destination="t('overlays.agent.returnedToMain')"
      />
    </div>

    <template
      v-if="canSteer"
      #footer
    >
      <AgentSteerBar
        v-model="steer.text.value"
        :placeholder="t('overlays.agent.steerSubagent')"
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
  </OverlayShell>
</template>
