<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconRepeat, IconTrash } from '@/components/icons';
import OverlayShell from './OverlayShell.vue';
import { useLoopJobsStore } from '@/stores/useLoopJobsStore';
import { useVSCode } from '@/composables/useVSCode';
import { cronToIntervalLabel } from '@shared/utils/cron';
import type { LoopJob } from '@shared/types/loop-jobs';

const store = useLoopJobsStore();
const { postMessage } = useVSCode();

defineEmits<{
  (e: 'close'): void;
}>();

const activeCount = computed(() => store.jobs.filter(j => j.status === 'active' || j.status === 'cancelling').length);

const tick = ref(0);
let tickTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => { tickTimer = setInterval(() => tick.value++, 30_000); });
onUnmounted(() => { if (tickTimer) clearInterval(tickTimer); });

function statusColor(status: LoopJob['status']): string {
  switch (status) {
    case 'active': return 'bg-emerald-500/15 text-emerald-400';
    case 'cancelling': return 'bg-amber-500/15 text-amber-400';
    case 'stopped': return 'bg-muted text-muted-foreground';
    case 'expired': return 'bg-muted text-muted-foreground';
  }
}

function cancelJob(taskId: string): void {
  postMessage({ type: 'cancelLoopJob', taskId });
}

function formatAge(timestamp: number): string {
  void tick.value;
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
</script>

<template>
  <OverlayShell
    title="Scheduled Jobs"
    :icon="IconRepeat"
    icon-class="text-amber-400"
    @close="$emit('close')"
  >
    <template #header-actions>
      <Badge v-if="activeCount > 0" variant="secondary" class="bg-emerald-500/15 text-emerald-400 shrink-0">
        {{ activeCount }} active
      </Badge>
    </template>

    <!-- Empty state -->
    <div v-if="store.jobs.length === 0" class="flex-1 flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
      <IconRepeat :size="32" class="opacity-40" />
      <p class="text-sm font-medium">No scheduled jobs</p>
      <p class="text-xs opacity-70">Use /loop to schedule recurring prompts</p>
    </div>

    <!-- Job list -->
    <div v-else class="p-3 space-y-2">
      <div
        v-for="job in store.jobs"
        :key="job.taskId"
        class="rounded-lg border border-border/30 bg-card p-3 space-y-2"
      >
        <!-- Header row: status + interval + cancel -->
        <div class="flex items-center gap-2">
          <Badge variant="secondary" :class="statusColor(job.status)" class="text-xs shrink-0">
            <span v-if="job.status === 'cancelling'" class="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse mr-1" />
            {{ job.status }}
          </Badge>
          <span class="text-xs font-medium text-foreground">{{ job.intervalLabel || cronToIntervalLabel(job.cron) }}</span>
          <span class="text-xs text-muted-foreground font-mono">{{ job.cron }}</span>
          <div class="flex-1" />
          <Button
            v-if="job.status === 'active'"
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground hover:text-rose-400 hover:bg-rose-500/10 h-6 w-6"
            title="Delete job"
            @click="cancelJob(job.taskId)"
          >
            <IconTrash :size="12" />
          </Button>
        </div>

        <!-- Prompt text -->
        <p class="text-xs text-foreground/80 leading-relaxed line-clamp-3">{{ job.prompt }}</p>

        <!-- Stats row -->
        <div class="flex items-center gap-3 text-xs text-muted-foreground">
          <span>Created {{ formatAge(job.createdAt) }}</span>
        </div>
      </div>
    </div>
  </OverlayShell>
</template>
