<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SubagentState } from '@shared/types/subagents';
import { Bot, ChevronRight, ClipboardList, Compass, Loader, LoaderCircle, Search, Square } from 'lucide-vue-next';
import AgentUsageStats from './AgentUsageStats.vue';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useSubagentStop } from '@/composables/useSubagentStop';
import { useModelIdentity } from '@/composables/useModelIdentity';
import { agentStatusChip } from '@/composables/useTeamFormatting';
import { useBackgroundTaskStore } from '@/stores/useBackgroundTaskStore';
import { effortBadgeLabelKey } from '@shared/effort-badge';
import { subagentTypeLabelKey } from '@/utils/subagentTypeLabel';
import { ownEntry } from '@/utils/ownEntry';
import { subagentHeading, subagentStatusLine, subagentToolCount } from '@/stores/useSubagentStore';

const { t } = useI18n();
const { postMessage } = usePlatformBridge();
const modelIdentity = useModelIdentity();
const backgroundTaskStore = useBackgroundTaskStore();
const subagentStop = useSubagentStop();

const props = defineProps<{
  subagent: SubagentState;
}>();

defineEmits<{
  (e: 'expand'): void;
}>();

const hasTemplate = computed(() => Boolean(props.subagent.templatePath));

const heading = computed(() => subagentHeading(props.subagent, t));
const statusLine = computed(() => subagentStatusLine(props.subagent, t));

function openTemplate(): void {
  if (props.subagent.templatePath) {
    postMessage({ type: 'openFile', filePath: props.subagent.templatePath });
  }
}

const elapsedSeconds = ref(0);
let timerInterval: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  if (props.subagent.status === 'running') {
    updateElapsed();
    timerInterval = setInterval(updateElapsed, 1000);
  } else {
    updateElapsed();
  }
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

const formattedDuration = computed(() => {
  const elapsed = elapsedSeconds.value;
  if (elapsed < 60) return `${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
});

const AGENT_TYPE_ICONS: Record<string, Component> = {
  'code-reviewer': Search,
  Explore: Compass,
  Plan: ClipboardList,
  'general-purpose': Bot,
};

const agentIcon = computed((): Component => {
  const type = props.subagent.agentType;
  return (type !== undefined ? ownEntry(AGENT_TYPE_ICONS, type) : undefined) ?? Bot;
});

const toolCount = computed(() => subagentToolCount(props.subagent));

const cardClass = computed(() => {
  switch (props.subagent.status) {
    case 'running':
      return 'border-[color-mix(in_srgb,var(--d-accent)_35%,var(--d-border))]';
    case 'failed':
      return 'border-[color-mix(in_srgb,var(--d-danger)_45%,var(--d-border))]';
    default:
      return 'border-(--d-border)';
  }
});

const chip = computed(() => agentStatusChip(props.subagent.status));

const displayAgentType = computed((): string | null => {
  const type = props.subagent.agentType;
  if (type === undefined) return null;
  const key = subagentTypeLabelKey(type);
  return key ? t(key) : type;
});

// Render the extension-resolved display label verbatim (custom providers like StepFun included); never
// re-parse it as a model id. Identical value on fresh streaming and on history restore.
const model = computed(() => modelIdentity(props.subagent.model));

const formattedToolCount = computed(() => t('subagentDisplay.tools', { n: toolCount.value }, toolCount.value));

const stopping = computed(() => subagentStop.isStopping(props.subagent));
const stopLabel = computed(() => (stopping.value ? t('toolCall.stopping') : t('agentStop.stopSubagentNamed', { name: heading.value.title })));

function stop(): void {
  if (props.subagent.sdkAgentId) subagentStop.stop(props.subagent.sdkAgentId);
}
</script>

<template>
  <div
    class="cursor-pointer overflow-hidden rounded-xl border bg-(--d-card) text-13 transition-colors duration-200 hover:border-(--d-border2)"
    :class="cardClass"
    data-testid="subagent-card"
    @click="$emit('expand')"
  >
    <div class="flex items-center gap-2.5 px-3 pt-2.25 pb-2">
      <span
        class="flex size-7 flex-none items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--d-info)_14%,transparent)] text-(--d-info)"
        aria-hidden="true"
      >
        <component
          :is="agentIcon"
          class="size-3.5"
        />
      </span>
      <div class="flex min-w-0 flex-1 flex-col gap-px">
        <div class="flex min-w-0 items-center gap-2">
          <span class="truncate font-semibold">{{ heading.title }}</span>
          <span
            v-if="heading.resumed"
            class="flex-none rounded-full bg-(--d-accent-soft) px-1.5 text-10.5/4 font-medium text-(--d-accent-text)"
          >{{ t('subagentDisplay.resumed') }}</span>
        </div>
        <div class="flex min-w-0 items-center gap-1.5 overflow-hidden text-11 whitespace-nowrap text-(--d-faint)">
          <button
            v-if="displayAgentType !== null && hasTemplate"
            type="button"
            class="font-semibold text-(--d-info) hover:underline"
            :title="t('subagentDisplay.openTemplate', { path: subagent.templatePath })"
            @click.stop="openTemplate()"
          >
            {{ displayAgentType }}
          </button>
          <span
            v-else-if="displayAgentType !== null"
            class="font-semibold text-(--d-info)"
          >{{ displayAgentType }}</span>
          <template v-if="subagent.isBackground">
            <span aria-hidden="true">·</span>
            <button
              type="button"
              class="flex items-center gap-1 rounded-full bg-(--d-hover) px-1.5 leading-4 text-(--d-muted) transition-colors hover:bg-(--d-border2) hover:text-(--d-text)"
              :title="t('overlays.agent.openBackgroundTasks')"
              data-testid="subagent-card-background"
              @click.stop="backgroundTaskStore.openOverlay()"
            >
              <Loader
                class="size-2.5"
                :class="subagent.status === 'running' && 'd-spinning'"
                aria-hidden="true"
              />{{ t('backgroundTask.background') }}
            </button>
          </template>
          <template v-if="model">
            <span aria-hidden="true">·</span>
            <span class="flex min-w-0 items-center gap-1">
              <!-- eslint-disable vue/no-v-html -- a vendored static logo constant (provider-logos.ts) -->
              <span
                v-if="model.logo"
                class="size-2.75 flex-none [&>svg]:size-full"
                aria-hidden="true"
                v-html="model.logo"
              />
              <!-- eslint-enable vue/no-v-html -->
              <span class="truncate">{{ model.name }}</span>
            </span>
          </template>
          <template v-if="subagent.effort">
            <span aria-hidden="true">·</span>
            <span
              class="flex-none"
              data-testid="subagent-card-effort"
            >{{ t('overlays.agent.effortLevel', { level: t(effortBadgeLabelKey(subagent.effort)) }) }}</span>
          </template>
        </div>
      </div>
      <span
        class="flex flex-none items-center gap-1.25 rounded-full bg-[color-mix(in_srgb,var(--tone,currentColor)_13%,transparent)] px-2 py-0.5 text-11 font-medium"
        :class="chip.color"
        data-testid="subagent-status"
      >
        <component
          :is="chip.icon"
          class="size-2.75"
          :class="chip.live && 'd-spinning'"
          aria-hidden="true"
        />{{ t(chip.labelKey) }}
      </span>
    </div>

    <div
      v-if="subagent.status === 'running' && statusLine"
      class="-mt-0.5 mr-3 mb-2 ml-12.5 truncate text-xs text-(--d-accent) italic"
      data-testid="subagent-status-line"
    >
      {{ statusLine }}
    </div>

    <div
      class="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-(--d-border) py-1.5 pr-3 pl-12.5 font-mono text-11 text-(--d-faint)"
      data-testid="subagent-stats"
    >
      <span>{{ formattedToolCount }}</span>
      <span class="tabular-nums">{{ formattedDuration }}</span>
      <AgentUsageStats
        v-if="subagent.usage"
        :usage="subagent.usage"
        :dollar-billed="subagent.dollarBilled"
        variant="card"
        separator-class="hidden"
        cost-class="text-(--d-muted)"
      />
      <span class="flex-1" />
      <button
        v-if="subagentStop.canStop(subagent)"
        type="button"
        class="flex rounded-5 p-0.75 text-(--d-danger) opacity-75 transition-[opacity,background-color] enabled:hover:bg-[color-mix(in_srgb,var(--d-danger)_12%,transparent)] enabled:hover:opacity-100 disabled:opacity-60"
        :title="stopLabel"
        :aria-label="stopLabel"
        :aria-busy="stopping || undefined"
        :disabled="stopping"
        data-testid="subagent-card-stop"
        @click.stop="stop"
      >
        <LoaderCircle
          v-if="stopping"
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
        :aria-label="t('cards.subagent.open', { name: heading.title })"
        @click.stop="$emit('expand')"
      >
        {{ t('cards.details') }}<ChevronRight
          class="size-2.75"
          aria-hidden="true"
        />
      </button>
    </div>
  </div>
</template>
