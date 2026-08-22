<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall } from '@shared/types/session';
import { useMonitorStore } from '@/stores/useMonitorStore';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { IconCheck, IconXCircle, IconBan } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';

const { t } = useI18n();

const props = defineProps<{
  toolCall: ToolCall;
}>();

const emit = defineEmits<{
  (e: 'expand', toolId: string): void;
}>();

const monitorStore = useMonitorStore();

const state = computed(() => monitorStore.getByToolUseId(props.toolCall.id));

const command = computed(() => {
  const input = props.toolCall.input;
  return typeof input?.command === 'string' ? input.command : '';
});

const description = computed(() => {
  const input = props.toolCall.input;
  return typeof input?.description === 'string' ? input.description : '';
});

const persistent = computed(() => {
  return state.value?.persistent ?? (props.toolCall.input?.persistent === true);
});

const timeoutMs = computed(() => {
  return state.value?.timeoutMs ?? (typeof props.toolCall.input?.timeout_ms === 'number' ? props.toolCall.input.timeout_ms : 300000);
});

const status = computed(() => state.value?.status ?? 'starting');
const eventCount = computed(() => state.value?.eventCount ?? 0);

const elapsedSeconds = ref(0);
let timerInterval: ReturnType<typeof setInterval> | null = null;

function startTimer(): void {
  if (timerInterval) return;
  updateElapsed();
  timerInterval = setInterval(updateElapsed, 1000);
}

function stopTimer(): void {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

watch(status, (s) => {
  if (s === 'starting' || s === 'monitoring') {
    startTimer();
  } else {
    stopTimer();
  }
}, { immediate: true });

onUnmounted(stopTimer);

function updateElapsed(): void {
  const startTime = state.value?.startTime ?? Date.now();
  elapsedSeconds.value = Math.floor((Date.now() - startTime) / 1000);
}

const formattedDuration = computed(() => {
  const elapsed = elapsedSeconds.value;
  if (elapsed < 60) return `${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
});

const formattedTimeout = computed(() => {
  const ms = timeoutMs.value;
  if (ms >= 60000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 1000)}s`;
});

const cardClass = computed(() => {
  switch (status.value) {
    case 'starting':
    case 'monitoring':
      return 'border-primary/50';
    case 'completed':
      return 'border-muted/50';
    case 'failed':
      return 'border-destructive/50';
    case 'stopped':
      return 'border-warning/50';
    default:
      return 'border-border';
  }
});

const statusText = computed(() => {
  switch (status.value) {
    case 'starting':
      return t('monitor.starting');
    case 'monitoring':
      return eventCount.value > 0
        ? t('monitor.monitoring') + ` (${eventCount.value} ${t('monitor.events')})`
        : t('monitor.monitoring');
    case 'completed':
      return eventCount.value > 0
        ? t('monitor.completed') + ` (${eventCount.value} ${t('monitor.events')})`
        : t('monitor.completed');
    case 'failed':
      return t('monitor.failed');
    case 'stopped':
      return t('monitor.stopped');
    default:
      return '';
  }
});

const isActive = computed(() => status.value === 'starting' || status.value === 'monitoring');
</script>

<template>
  <Card class="text-sm overflow-hidden cursor-pointer hover:border-primary/50 transition-colors" :class="cardClass" @click="emit('expand', props.toolCall.id)">
    <CardHeader class="flex flex-row items-center gap-2 px-3 py-2 bg-foreground/5 border-b border-border/50 space-y-0">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-primary shrink-0">
        <path d="M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
        <path d="M12 7a5 5 0 1 0 5 5" />
        <path d="M13 3.055A9 9 0 1 0 20.941 11" />
        <path d="M15 6v3h3l3 -3h-3V3z" />
      </svg>
      <span class="text-foreground font-medium truncate flex-1">{{ description || command }}</span>

      <Badge v-if="persistent" variant="secondary" class="bg-blue-500/15 text-blue-400 border-blue-500/30 shrink-0">
        {{ t('monitor.persistent') }}
      </Badge>

      <div class="flex items-center gap-1.5 shrink-0">
        <span class="text-xs text-foreground/60">{{ statusText }}</span>
        <LoadingSpinner v-if="status === 'starting'" :size="14" class="text-primary" />
        <span v-else-if="status === 'monitoring'" class="inline-block w-2.5 h-2.5 rounded-full bg-primary animate-pulse" />
        <IconCheck v-else-if="status === 'completed'" :size="14" class="text-success" />
        <IconXCircle v-else-if="status === 'failed'" :size="14" class="text-destructive" />
        <IconBan v-else-if="status === 'stopped'" :size="14" class="text-warning" />
      </div>
    </CardHeader>

    <CardContent class="px-3 py-2 flex items-center justify-between">
      <code class="text-[11px] text-foreground/60 truncate max-w-[70%]">{{ command }}</code>
      <div class="flex items-center gap-1.5 text-xs text-foreground/70 leading-none">
        <template v-if="!persistent">
          <span>{{ t('monitor.timeout') }}: {{ formattedTimeout }}</span>
          <span class="text-foreground/40">&#x2022;</span>
        </template>
        <span v-if="isActive">{{ formattedDuration }}</span>
        <span v-if="eventCount > 0 && !isActive">{{ eventCount }} {{ t('monitor.events') }}</span>
      </div>
    </CardContent>
  </Card>
</template>
