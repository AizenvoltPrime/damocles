<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, type Component } from 'vue';
import type { SubagentState } from '@shared/types/subagents';
import { Badge } from '@/components/ui/badge';
import { usePhraseCycler } from '../composables/usePhraseCycler';
import { AGENT_PHRASES } from '../data/wittyPhrases';
import {
  IconSearch,
  IconCompass,
  IconClipboard,
  IconRobot,
  IconCheck,
  IconXCircle,
} from '@/components/icons';

const props = defineProps<{
  subagent: SubagentState;
}>();

defineEmits<{
  (e: 'click', subagentId: string): void;
}>();

const isRunning = computed(() => props.subagent.status === 'running');
const isCompleted = computed(() => props.subagent.status === 'completed');

const phrases = computed(() =>
  AGENT_PHRASES[props.subagent.agentType] || AGENT_PHRASES['general-purpose']
);

const { currentPhrase } = usePhraseCycler(() => isRunning.value, phrases.value);

const elapsedSeconds = ref(0);
let timerInterval: ReturnType<typeof setInterval> | null = null;

function updateElapsed(): void {
  const endTime = props.subagent.endTime ?? Date.now();
  elapsedSeconds.value = Math.floor((endTime - props.subagent.startTime) / 1000);
}

onMounted(() => {
  updateElapsed();
  if (isRunning.value) {
    timerInterval = setInterval(updateElapsed, 1000);
  }
});

onUnmounted(() => {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
});

const formattedDuration = computed(() => {
  const elapsed = elapsedSeconds.value;
  if (elapsed < 60) return `${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
});

const displayText = computed(() =>
  isRunning.value ? currentPhrase.value : props.subagent.description
);

const badgeClass = computed(() => {
  switch (props.subagent.status) {
    case 'running':
      return 'bg-primary/30 text-primary border-primary/30 hover:bg-primary/50';
    case 'completed':
      return 'bg-success/30 text-success border-success/30 hover:bg-success/50';
    case 'failed':
      return 'bg-error/30 text-error border-error/30 hover:bg-error/50';
    case 'cancelled':
      return 'bg-warning/30 text-warning border-warning/30 hover:bg-warning/50';
    default:
      return 'bg-muted text-muted-foreground border-border hover:bg-muted/80';
  }
});

function getAgentIcon(type: string): Component {
  const icons: Record<string, Component> = {
    'code-reviewer': IconSearch,
    explorer: IconCompass,
    planner: IconClipboard,
    'general-purpose': IconRobot,
    default: IconRobot,
  };
  return icons[type] || IconRobot;
}
</script>

<template>
  <Badge
    variant="secondary"
    :class="['gap-1.5 cursor-pointer transition-colors', badgeClass]"
    @click="$emit('click', subagent.id)"
  >
    <component
      :is="isRunning ? getAgentIcon(subagent.agentType) : isCompleted ? IconCheck : IconXCircle"
      :size="14"
      :class="{ 'animate-pulse': isRunning }"
      class="shrink-0"
    />
    <span class="max-w-40 truncate" :title="displayText">{{ displayText }}</span>
    <span class="opacity-50 font-mono text-xs">{{ formattedDuration }}</span>
  </Badge>
</template>
