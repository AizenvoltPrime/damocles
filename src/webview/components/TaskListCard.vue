<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronDown, Circle, CircleCheck, ListChecks, LoaderCircle } from 'lucide-vue-next';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { Task } from '@shared/types/subagents';

const { t, locale } = useI18n();

const props = defineProps<{
  tasks: Task[];
  isCollapsed?: boolean;
}>();

const emit = defineEmits<{
  'update:isCollapsed': [value: boolean];
}>();

const completedCount = computed(() => props.tasks.filter(task => task.status === 'completed').length);
const totalCount = computed(() => props.tasks.length);
const openCount = computed(() => totalCount.value - completedCount.value);
const progress = computed(() => (totalCount.value === 0 ? 0 : completedCount.value / totalCount.value));

function blockedBy(task: Task): string {
  const ids = (task.blockedBy ?? []).map(id => `#${id}`);
  return t('task.blocked', { ids: new Intl.ListFormat(locale.value).format(ids) }, ids.length);
}
</script>

<template>
  <Collapsible
    :open="!isCollapsed"
    class="overflow-hidden rounded-xl border border-(--d-border) bg-(--d-card)"
    data-testid="task-list-card"
    @update:open="emit('update:isCollapsed', !$event)"
  >
    <CollapsibleTrigger class="flex w-full items-center gap-2 px-3 py-2 text-xs font-semibold transition-colors hover:bg-(--d-hover)">
      <ListChecks
        class="size-3.5 flex-none text-(--d-accent)"
        aria-hidden="true"
      />
      <span>{{ t('task.title') }}</span>
      <span
        class="font-mono text-11 font-normal text-(--d-faint)"
        :title="t('task.progress', { done: completedCount, open: openCount })"
        data-testid="task-list-progress"
      >{{ completedCount }}/{{ totalCount }}</span>
      <span
        class="ml-1.5 h-0.75 flex-1 overflow-hidden rounded-full bg-(--d-hover)"
        aria-hidden="true"
      >
        <span
          class="block h-full origin-left rounded-full bg-(--d-accent) transition-transform duration-500 ease-out rtl:origin-right"
          :style="{ transform: `scaleX(${progress})` }"
        />
      </span>
      <ChevronDown
        class="size-3.5 flex-none text-(--d-faint) transition-transform duration-200"
        :class="!isCollapsed && 'rotate-180'"
        aria-hidden="true"
      />
    </CollapsibleTrigger>

    <CollapsibleContent>
      <ul class="max-h-48 space-y-0.5 overflow-y-auto px-3 pb-2.5">
        <li
          v-for="task in tasks"
          :key="task.id"
          class="flex items-center gap-2.25 py-0.75 text-12.5 transition-colors duration-300"
          :class="task.status === 'pending' ? 'text-(--d-muted)' : 'text-(--d-text)'"
        >
          <CircleCheck
            v-if="task.status === 'completed'"
            class="size-3.5 flex-none text-(--d-success)"
            aria-hidden="true"
          />
          <LoaderCircle
            v-else-if="task.status === 'in_progress'"
            class="size-3.5 flex-none d-spinning text-(--d-accent)"
            aria-hidden="true"
          />
          <Circle
            v-else
            class="size-3.5 flex-none text-(--d-faint)"
            aria-hidden="true"
          />
          <span
            class="min-w-0 flex-1"
            :class="task.status === 'completed' && 'line-through'"
          >
            <span class="text-(--d-faint)">#{{ task.id }}</span> {{ task.subject }}
          </span>
          <span
            v-if="task.status === 'in_progress'"
            class="max-w-[45%] flex-none truncate rounded-full bg-(--d-accent-soft) px-2 text-11/4.5 text-(--d-accent-text)"
          >{{ task.activeForm || t('task.inProgress') }}</span>
          <span
            v-else-if="(task.blockedBy ?? []).length > 0"
            class="flex-none rounded-full border border-(--d-border2) px-2 text-11/4.5 text-(--d-muted)"
            data-testid="task-blocked-by"
          >{{ blockedBy(task) }}</span>
        </li>
        <li
          v-if="tasks.length === 0"
          class="py-2 text-center text-xs text-(--d-faint)"
        >
          {{ t('task.noTasks') }}
        </li>
      </ul>
    </CollapsibleContent>
  </Collapsible>
</template>
