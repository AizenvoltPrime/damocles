<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconClipboard } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { IconChevronDown, IconChevronUp } from '@/components/icons';
import type { Task } from '@shared/types/subagents';

const { t } = useI18n();

const props = defineProps<{
  tasks: Task[];
  isCollapsed?: boolean;
}>();

const emit = defineEmits<{
  'update:isCollapsed': [value: boolean];
}>();

const completedCount = computed(() =>
  props.tasks.filter(t => t.status === 'completed').length
);

const totalCount = computed(() => props.tasks.length);

const openCount = computed(() => totalCount.value - completedCount.value);

const hasInProgress = computed(() =>
  props.tasks.some(t => t.status === 'in_progress')
);

function getStatusEmoji(status: Task['status']): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'in_progress':
      return '●';
    case 'pending':
    default:
      return '○';
  }
}

function getStatusClass(status: Task['status']): string {
  switch (status) {
    case 'completed':
      return 'text-success';
    case 'in_progress':
      return 'text-warning animate-pulse';
    case 'pending':
    default:
      return 'text-muted-foreground';
  }
}

function getBlockedByIds(task: Task): string[] {
  return task.blockedBy ?? [];
}

function formatBlockedBy(task: Task): string {
  const ids = getBlockedByIds(task);
  return ids.map(id => `#${id}`).join(', ');
}
</script>

<template>
  <Collapsible
    :open="!isCollapsed"
    @update:open="emit('update:isCollapsed', !$event)"
    class="border border-border rounded-lg bg-card overflow-hidden"
  >
    <CollapsibleTrigger class="w-full px-3 py-2 flex items-center gap-2 bg-foreground/5 hover:bg-foreground/10 transition-colors cursor-pointer">
      <IconClipboard :size="16" class="text-primary" />
      <span class="font-medium text-sm">{{ t('task.title') }}</span>
      <span
        :class="[
          'ml-auto text-xs',
          completedCount === totalCount && totalCount > 0
            ? 'text-success'
            : hasInProgress
              ? 'text-warning'
              : 'text-muted-foreground'
        ]"
      >
        ({{ completedCount }} {{ t('task.done') }}, {{ openCount }} {{ t('task.open') }})
      </span>
      <component
        :is="isCollapsed ? IconChevronDown : IconChevronUp"
        :size="14"
        class="text-muted-foreground"
      />
    </CollapsibleTrigger>

    <CollapsibleContent>
      <div class="px-3 pb-2 space-y-1 max-h-48 overflow-y-auto">
        <div
          v-for="task in tasks"
          :key="task.id"
          class="flex items-center gap-2 py-1 text-sm"
        >
          <span
            class="w-4 text-center shrink-0"
            :class="getStatusClass(task.status)"
          >
            {{ getStatusEmoji(task.status) }}
          </span>
          <span
            :class="[
              'flex-1',
              task.status === 'completed' && 'line-through opacity-50'
            ]"
          >
            <span class="text-muted-foreground">#{{ task.id }}</span> {{ task.subject }}
          </span>
          <Badge
            v-if="task.status === 'in_progress'"
            variant="outline"
            class="text-xs px-1.5 py-0.5 bg-warning/20 text-warning border-warning/30 animate-pulse"
          >
            {{ task.activeForm || t('task.inProgress') }}
          </Badge>
          <Badge
            v-else-if="getBlockedByIds(task).length > 0"
            variant="outline"
            class="text-xs px-1.5 py-0.5 bg-muted text-muted-foreground border-muted-foreground/30"
          >
            {{ t('task.blocked') }} {{ formatBlockedBy(task) }}
          </Badge>
        </div>

        <div
          v-if="tasks.length === 0"
          class="text-xs text-muted-foreground text-center py-2"
        >
          {{ t('task.noTasks') }}
        </div>
      </div>
    </CollapsibleContent>
  </Collapsible>
</template>
