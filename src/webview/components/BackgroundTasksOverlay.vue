<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconLoader, IconStop, IconTrash } from '@/components/icons';
import OverlayShell from './OverlayShell.vue';
import LoadingSpinner from './LoadingSpinner.vue';
import SubagentCard from './SubagentCard.vue';
import { useBackgroundTaskStore } from '@/stores/useBackgroundTaskStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { useVSCode } from '@/composables/useVSCode';

const { t } = useI18n();
const store = useBackgroundTaskStore();
const subagentStore = useSubagentStore();
const { postMessage } = useVSCode();

defineEmits<{
  (e: 'close'): void;
}>();

// Every task gets a row, so a running task always has its Stop button.
const rows = computed(() => store.tasks.map(task => ({ task, subagent: subagentStore.subagents[task.toolUseId] })));

const runningCount = computed(() => store.tasks.filter(task => task.status === 'running').length);

function stopTask(taskId: string): void {
  postMessage({ type: 'stopBackgroundTask', taskId });
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
      <Badge v-if="runningCount > 0" variant="secondary" class="bg-primary/20 text-primary shrink-0 gap-1">
        <LoadingSpinner :size="10" class="text-primary" />
        {{ runningCount }} {{ t('backgroundTask.running') }}
      </Badge>
    </template>

    <div v-if="rows.length === 0" class="flex-1 flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
      <div class="w-12 h-12 rounded-full bg-muted/50 flex items-center justify-center">
        <IconLoader :size="24" class="opacity-30" />
      </div>
      <div class="text-center">
        <p class="text-sm font-medium">{{ t('backgroundTask.noTasks') }}</p>
        <p class="text-xs opacity-60 mt-0.5">{{ t('backgroundTask.noTasksHint') }}</p>
      </div>
    </div>

    <div v-else class="p-3 space-y-2">
      <div v-for="{ task, subagent } in rows" :key="task.taskId" class="flex items-center gap-1.5">
        <SubagentCard v-if="subagent" class="flex-1 min-w-0" :subagent="subagent" @expand="subagentStore.expandSubagent(subagent.id)" />
        <div
          v-else
          class="flex-1 min-w-0 truncate rounded-md border border-border px-3 py-2 text-sm text-muted-foreground"
          data-testid="task-fallback-row"
        >
          {{ task.description }}
        </div>
        <Button
          v-if="task.status === 'running'"
          variant="ghost"
          size="icon-sm"
          class="shrink-0 text-muted-foreground hover:text-error hover:bg-error/10"
          data-action="stop"
          :title="t('backgroundTask.stopTask')"
          :aria-label="t('backgroundTask.stopTask')"
          @click="stopTask(task.taskId)"
        >
          <IconStop :size="14" />
        </Button>
        <Button
          v-else
          variant="ghost"
          size="icon-sm"
          class="shrink-0 text-muted-foreground hover:text-foreground"
          data-action="dismiss"
          :title="t('backgroundTask.dismiss')"
          :aria-label="t('backgroundTask.dismiss')"
          @click="store.removeTask(task.taskId)"
        >
          <IconTrash :size="14" />
        </Button>
      </div>
    </div>
  </OverlayShell>
</template>
