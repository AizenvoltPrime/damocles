<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SubagentState } from '@shared/types/subagents';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  IconClipboard,
  IconSearch,
  IconCompass,
  IconRobot,
  IconCheck,
  IconXCircle,
  IconBan,
  IconGear,
} from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import { useVSCode } from '@/composables/useVSCode';
import { subagentTypeLabelKey } from '@/utils/subagentTypeLabel';

const { t } = useI18n();
const { postMessage } = useVSCode();

const props = defineProps<{
  subagent: SubagentState;
}>();

defineEmits<{
  (e: 'expand'): void;
}>();

const hasTemplate = computed(() => Boolean(props.subagent.templatePath));

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

const agentIcon = computed((): Component => {
  const icons: Record<string, Component> = {
    'code-reviewer': IconSearch,
    Explore: IconCompass,
    Plan: IconClipboard,
    'general-purpose': IconRobot,
  };
  return icons[props.subagent.agentType] || IconClipboard;
});

const toolCount = computed(() => {
  if (props.subagent.result?.totalToolUseCount) {
    return props.subagent.result.totalToolUseCount;
  }
  let count = props.subagent.toolCalls.length;
  for (const message of props.subagent.messages) {
    if (message.toolCalls) {
      count += message.toolCalls.length;
    }
  }
  return count;
});

const cardClass = computed(() => {
  switch (props.subagent.status) {
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
  switch (props.subagent.status) {
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

const displayAgentType = computed(() => {
  const key = subagentTypeLabelKey(props.subagent.agentType);
  return key ? t(key) : props.subagent.agentType;
});

// Render the extension-resolved display label verbatim (custom providers like StepFun included); never
// re-parse it as a model id. Identical value on fresh streaming and on history restore.
const displayModel = computed(() => props.subagent.model ?? null);

const formattedToolCount = computed(() => t('subagentDisplay.tools', { n: toolCount.value }, toolCount.value));

const metadataItems = computed(() => [
  formattedToolCount.value,
  formattedDuration.value,
  displayModel.value,
].filter(Boolean));
</script>

<template>
  <Card
    class="text-sm overflow-hidden cursor-pointer transition-colors"
    :class="cardClass"
    @click="$emit('expand')"
  >
    <CardHeader class="flex flex-row items-center gap-2 px-3 py-2 bg-foreground/5 border-b border-border/50 space-y-0">
      <component :is="agentIcon" :size="18" class="text-primary shrink-0" />
      <span class="text-foreground font-medium truncate flex-1">{{ subagent.description }}</span>
      <Badge v-if="subagent.isBackground" variant="secondary" class="bg-blue-500/15 text-blue-400 border-blue-500/30 gap-1 shrink-0">
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/></svg>
        <span>{{ t('backgroundTask.background') }}</span>
      </Badge>
      <Badge
        variant="secondary"
        :class="[statusBadgeClass, hasTemplate ? 'cursor-pointer hover:brightness-125 transition' : '']"
        class="gap-1 shrink-0"
        :title="hasTemplate ? t('subagentDisplay.openTemplate', { path: subagent.templatePath }) : undefined"
        @click.stop="hasTemplate && openTemplate()"
      >
        <component :is="agentIcon" :size="12" />
        <span>{{ displayAgentType }}</span>
      </Badge>
    </CardHeader>

    <div
      v-if="subagent.status === 'running' && subagent.progressSummary"
      class="px-3 py-1.5 text-xs text-primary/80 italic truncate border-b border-border/30"
    >
      {{ subagent.progressSummary }}
    </div>

    <CardContent class="px-3 py-2 flex items-center justify-between">
      <div class="flex items-center gap-1.5 text-xs text-foreground/70 leading-none">
        <IconGear :size="12" class="shrink-0" />
        <template v-for="(item, index) in metadataItems" :key="index">
          <span v-if="index > 0" class="text-foreground/40">•</span>
          <span>{{ item }}</span>
        </template>
      </div>

      <div class="flex items-center">
        <LoadingSpinner
          v-if="subagent.status === 'running'"
          :size="14"
          class="text-primary"
        />
        <IconCheck
          v-else-if="subagent.status === 'completed'"
          :size="14"
          class="text-success"
        />
        <IconXCircle
          v-else-if="subagent.status === 'failed'"
          :size="14"
          class="text-error"
        />
        <IconBan
          v-else-if="subagent.status === 'cancelled'"
          :size="14"
          class="text-warning"
        />
      </div>
    </CardContent>
  </Card>
</template>
