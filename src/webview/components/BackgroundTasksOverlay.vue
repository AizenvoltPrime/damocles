<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { IconLoader, IconArrowLeft, IconStop, IconTrash, IconCheck, IconXCircle, IconBan, IconGear, IconClock } from '@/components/icons';
import OverlayShell from './OverlayShell.vue';
import LoadingSpinner from './LoadingSpinner.vue';
import { useBackgroundTaskStore } from '@/stores/useBackgroundTaskStore';
import { useVSCode } from '@/composables/useVSCode';
import type { BackgroundTask } from '@shared/types/background-tasks';

const { t } = useI18n();
const store = useBackgroundTaskStore();
const { postMessage } = useVSCode();

defineEmits<{
  (e: 'close'): void;
}>();

const tick = ref(0);
let tickTimer: ReturnType<typeof setInterval> | null = null;

function startTick(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => tick.value++, 1_000);
}

function stopTick(): void {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

const overlayTasks = computed(() => store.tasks);
const overlayActiveCount = computed(() => overlayTasks.value.filter(task => task.status === 'running').length);
const hasActiveTasks = computed(() => overlayActiveCount.value > 0);

watch(hasActiveTasks, (active) => {
  if (active) startTick();
  else stopTick();
}, { immediate: true });

onUnmounted(() => stopTick());


function statusIcon(status: BackgroundTask['status']) {
  switch (status) {
    case 'running': return LoadingSpinner;
    case 'completed': return IconCheck;
    case 'failed': return IconXCircle;
    case 'stopped': return IconBan;
  }
}

function statusColor(status: BackgroundTask['status']): string {
  switch (status) {
    case 'running': return 'text-primary';
    case 'completed': return 'text-success';
    case 'failed': return 'text-error';
    case 'stopped': return 'text-muted-foreground';
  }
}

function cardBorderClass(status: BackgroundTask['status']): string {
  switch (status) {
    case 'running': return 'border-primary/40 hover:border-primary/60';
    case 'completed': return 'border-success/40 hover:border-success/60';
    case 'failed': return 'border-error/40 hover:border-error/60';
    case 'stopped': return 'border-border';
  }
}

function statusBadgeClass(status: BackgroundTask['status']): string {
  switch (status) {
    case 'running': return 'bg-primary/20 text-primary border-primary/30';
    case 'completed': return 'bg-success/20 text-success border-success/30';
    case 'failed': return 'bg-error/20 text-error border-error/30';
    case 'stopped': return 'bg-muted text-muted-foreground';
  }
}

function statusLabel(status: BackgroundTask['status']): string {
  switch (status) {
    case 'running': return t('backgroundTask.initializing');
    case 'completed': return t('backgroundTask.statusCompleted');
    case 'failed': return t('backgroundTask.statusFailed');
    case 'stopped': return t('backgroundTask.statusStopped');
  }
}

function stopTask(taskId: string): void {
  postMessage({ type: 'stopBackgroundTask', taskId });
}

function formatElapsed(startTime: number, endTime: number | null): string {
  void tick.value;
  const end = endTime ?? Date.now();
  const seconds = Math.floor((end - startTime) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
</script>

<template>
  <OverlayShell
    :title="t('backgroundTask.title')"
    :icon="IconLoader"
    icon-class="text-blue-400"
    @close="$emit('close')"
  >
    <template #header-actions>
      <Badge v-if="overlayActiveCount > 0" variant="secondary" class="bg-primary/20 text-primary shrink-0 gap-1">
        <LoadingSpinner :size="10" class="text-primary" />
        {{ overlayActiveCount }} {{ t('backgroundTask.running') }}
      </Badge>
    </template>

    <!-- Detail view -->
    <div v-if="store.selectedTask" class="flex flex-col h-full">
      <div class="px-3 pt-3 pb-2">
        <Button
          variant="ghost"
          size="sm"
          class="text-muted-foreground hover:text-foreground -ml-1 gap-1.5"
          @click="store.backToList()"
        >
          <IconArrowLeft :size="14" />
          {{ t('backgroundTask.backToList') }}
        </Button>
      </div>

      <div class="flex-1 overflow-y-auto px-3 pb-3">
        <Card :class="cardBorderClass(store.selectedTask.status)">
          <CardContent class="p-3 space-y-3">
            <!-- Top row: status + type + action -->
            <div class="flex items-center gap-2">
              <Badge variant="secondary" :class="statusBadgeClass(store.selectedTask.status)" class="gap-1 shrink-0">
                <component :is="statusIcon(store.selectedTask.status)" :size="store.selectedTask.status === 'running' ? 12 : 10" />
                {{ store.selectedTask.status }}
              </Badge>
              <span v-if="store.selectedTask.taskType" class="text-xs text-muted-foreground font-mono truncate flex-1">{{ store.selectedTask.taskType }}</span>
              <div class="shrink-0 ml-auto">
                <Button
                  v-if="store.selectedTask.status === 'running'"
                  variant="ghost"
                  size="sm"
                  class="text-muted-foreground hover:text-error hover:bg-error/10 gap-1.5 h-7"
                  @click="stopTask(store.selectedTask.taskId)"
                >
                  <IconStop :size="12" />
                  {{ t('backgroundTask.stop') }}
                </Button>
                <Button
                  v-else
                  variant="ghost"
                  size="sm"
                  class="text-muted-foreground hover:text-foreground gap-1.5 h-7"
                  @click="store.removeTask(store.selectedTask.taskId)"
                >
                  <IconTrash :size="12" />
                  {{ t('backgroundTask.dismiss') }}
                </Button>
              </div>
            </div>

            <!-- Description -->
            <p class="text-sm text-foreground leading-relaxed">{{ store.selectedTask.description }}</p>

            <!-- Elapsed time -->
            <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
              <IconClock :size="12" />
              <span class="tabular-nums font-medium">{{ formatElapsed(store.selectedTask.startTime, store.selectedTask.endTime) }}</span>
            </div>

            <!-- Progress (running) -->
            <div v-if="store.selectedTask.progressSummary && store.selectedTask.status === 'running'" class="pl-1 space-y-0.5">
              <p class="text-xs font-semibold text-foreground/80">{{ t('backgroundTask.progress') }}</p>
              <p class="text-xs text-foreground/60 leading-relaxed">{{ store.selectedTask.progressSummary }}</p>
            </div>

            <!-- Summary (completed/failed/stopped) -->
            <div v-if="store.selectedTask.summary && store.selectedTask.status !== 'running'" class="pl-1 space-y-0.5">
              <p class="text-xs font-semibold text-foreground/80">{{ t('backgroundTask.summary') }}</p>
              <p class="text-xs text-foreground/60 leading-relaxed">{{ store.selectedTask.summary }}</p>
            </div>

            <!-- Last tool -->
            <p v-if="store.selectedTask.lastToolName" class="text-xs text-muted-foreground">
              {{ t('backgroundTask.lastTool') }}: <span class="text-foreground/60 font-mono">{{ store.selectedTask.lastToolName }}</span>
            </p>

            <!-- Stats footer -->
            <div v-if="store.selectedTask.usage" class="flex items-center gap-3 text-xs text-primary/80 pt-1 border-t border-border/20">
              <span class="font-medium">{{ formatTokens(store.selectedTask.usage.totalTokens) }} {{ t('common.tokens') }}</span>
              <span class="font-medium">{{ store.selectedTask.usage.toolUses }} {{ t('backgroundTask.tools') }}</span>
              <span class="font-medium">{{ formatElapsed(store.selectedTask.startTime, store.selectedTask.endTime) }}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>

    <!-- List view -->
    <template v-else>
      <!-- Empty state -->
      <div v-if="overlayTasks.length === 0" class="flex-1 flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
        <div class="w-12 h-12 rounded-full bg-muted/50 flex items-center justify-center">
          <IconLoader :size="24" class="opacity-30" />
        </div>
        <div class="text-center">
          <p class="text-sm font-medium">{{ t('backgroundTask.noTasks') }}</p>
          <p class="text-xs opacity-60 mt-0.5">{{ t('backgroundTask.noTasksHint') }}</p>
        </div>
      </div>

      <!-- Task list -->
      <div v-else class="p-3 space-y-2">
        <Card
          v-for="task in overlayTasks"
          :key="task.taskId"
          class="overflow-hidden cursor-pointer transition-colors"
          :class="cardBorderClass(task.status)"
          @click="store.selectTask(task.taskId)"
        >
          <!-- Card header -->
          <div class="flex items-center gap-2 px-3 py-2 bg-foreground/5 border-b border-border/30">
            <component :is="statusIcon(task.status)" :size="task.status === 'running' ? 14 : 12" :class="statusColor(task.status)" />
            <span class="text-sm text-foreground font-medium truncate flex-1">{{ task.description }}</span>
            <span class="text-xs text-muted-foreground tabular-nums shrink-0">{{ formatElapsed(task.startTime, task.endTime) }}</span>
          </div>

          <!-- Card body -->
          <CardContent class="px-3 py-2 flex items-center justify-between">
            <div class="flex items-center gap-1.5 text-xs text-foreground/60 min-w-0">
              <template v-if="task.status === 'running'">
                <span v-if="task.progressSummary" class="truncate italic text-primary/70">{{ task.progressSummary }}</span>
                <span v-else class="text-muted-foreground">{{ t('backgroundTask.initializing') }}</span>
              </template>
              <template v-else-if="task.usage">
                <IconGear :size="12" class="shrink-0" />
                <span>{{ task.usage.toolUses }} {{ t('backgroundTask.tools') }}</span>
                <span class="text-foreground/30">·</span>
                <span>{{ formatTokens(task.usage.totalTokens) }} {{ t('common.tokens') }}</span>
              </template>
              <template v-else-if="task.summary">
                <span class="truncate">{{ task.summary }}</span>
              </template>
              <template v-else>
                <span class="text-muted-foreground">{{ statusLabel(task.status) }}</span>
              </template>
            </div>

            <div class="flex items-center gap-1 shrink-0 ml-2">
              <Button
                v-if="task.status === 'running'"
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground hover:text-error hover:bg-error/10 h-6 w-6"
                :title="t('backgroundTask.stopTask')"
                @click.stop="stopTask(task.taskId)"
              >
                <IconStop :size="12" />
              </Button>
              <Button
                v-if="task.status !== 'running'"
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground hover:text-foreground h-6 w-6"
                :title="t('backgroundTask.dismiss')"
                @click.stop="store.removeTask(task.taskId)"
              >
                <IconTrash :size="12" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </template>
  </OverlayShell>
</template>
