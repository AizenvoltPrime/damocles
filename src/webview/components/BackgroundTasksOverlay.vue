<script setup lang="ts">
import { computed, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { useNow } from '@vueuse/core';
import { Bot, ClipboardList, Compass, Loader, LoaderCircle, SearchCheck, Square, Trash2 } from 'lucide-vue-next';
import type { BackgroundTask } from '@shared/types/background-tasks';
import type { SubagentState } from '@shared/types/subagents';
import OverlayShell from './OverlayShell.vue';
import AgentUsageStats from './AgentUsageStats.vue';
import { useBackgroundTaskStore } from '@/stores/useBackgroundTaskStore';
import { subagentStatusLine, subagentToolCount, useSubagentStore } from '@/stores/useSubagentStore';
import { useSubagentStop } from '@/composables/useSubagentStop';
import { useModelIdentity } from '@/composables/useModelIdentity';
import { agentStatusChip, formatElapsed } from '@/composables/useTeamFormatting';
import { subagentTypeLabelKey } from '@/utils/subagentTypeLabel';
import { ownEntry } from '@/utils/ownEntry';

const { t } = useI18n();
const store = useBackgroundTaskStore();
const subagentStore = useSubagentStore();
const subagentStop = useSubagentStop();
const modelIdentity = useModelIdentity();
const now = useNow({ interval: 1000 });

defineEmits<{
  (e: 'close'): void;
}>();

const AGENT_ICONS: Record<string, Component> = { 'code-reviewer': SearchCheck, Explore: Compass, Plan: ClipboardList, 'general-purpose': Bot };

// A task's own status is the authority for Stop and Dismiss; its subagent card supplies the details.
const TASK_STATUS: Record<BackgroundTask['status'], SubagentState['status']> = { running: 'running', completed: 'completed', failed: 'failed', stopped: 'cancelled' };

// Every task gets a row, so a running task always has its Stop button.
const rows = computed(() => store.tasks.map((task) => {
  const subagent = subagentStore.subagents[task.toolUseId];
  const status = TASK_STATUS[task.status];
  return { task, subagent, status, chip: agentStatusChip(status) };
}));

const runningCount = computed(() => store.tasks.filter((task) => task.status === 'running').length);

const statusBadge = computed(() => (runningCount.value > 0
  ? { label: t('overlays.bgTasks.running', { n: runningCount.value }), class: 'd-tone-accent', pulse: true }
  : undefined));

function agentType(subagent: SubagentState): string {
  const type = subagent.agentType;
  if (type === undefined) return t('overlays.agent.subagent');
  const key = subagentTypeLabelKey(type);
  return key ? t(key) : type;
}

function duration(subagent: SubagentState): string {
  return formatElapsed((subagent.endTime ?? now.value.getTime()) - subagent.startTime);
}

function statusLine(subagent: SubagentState): string | undefined {
  return subagentStatusLine(subagent, t);
}
</script>

<template>
  <OverlayShell
    :title="t('backgroundTask.title')"
    :subtitle="t('overlays.bgTasks.subtitle')"
    :icon="Loader"
    :status-badge="statusBadge"
    @close="$emit('close')"
  >
    <div
      v-if="rows.length === 0"
      class="flex flex-col items-center gap-2.5 pt-8.5 pb-7.5 text-(--d-muted)"
    >
      <span class="flex size-11.5 items-center justify-center rounded-full bg-(--d-hover)">
        <Loader
          class="size-5.5 opacity-40"
          aria-hidden="true"
        />
      </span>
      <div class="text-center">
        <p class="text-13 font-medium">
          {{ t('backgroundTask.noTasks') }}
        </p>
        <p class="mt-0.5 text-11.5 text-(--d-faint)">
          {{ t('backgroundTask.noTasksHint') }}
        </p>
      </div>
    </div>

    <div
      v-else
      class="flex flex-col gap-2 px-4 pt-3 pb-4.5"
    >
      <div
        v-for="{ task, subagent, status, chip } in rows"
        :key="task.taskId"
        class="d-arrive flex items-center gap-1.5"
      >
        <button
          v-if="subagent"
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2.5 rounded-11 border bg-(--d-card) px-2.5 py-2 text-left transition-colors hover:border-(--d-border2)"
          :class="status === 'running' ? 'border-[color-mix(in_srgb,var(--d-accent)_35%,var(--d-border))]' : 'border-(--d-border)'"
          :title="t('overlays.bgTasks.openSubagent')"
          data-testid="bg-subagent-row"
          @click="subagentStore.expandSubagent(subagent.id)"
        >
          <span class="flex size-6.5 flex-none items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--d-info)_14%,transparent)] text-(--d-info)">
            <component
              :is="(subagent.agentType !== undefined ? ownEntry(AGENT_ICONS, subagent.agentType) : undefined) ?? Bot"
              class="size-3.25"
              aria-hidden="true"
            />
          </span>
          <span class="flex min-w-0 flex-1 flex-col gap-px">
            <span class="truncate text-12.5 font-semibold">{{ subagent.description || task.description }}</span>
            <span class="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-11 text-(--d-faint)">
              <span class="font-semibold text-(--d-info)">{{ agentType(subagent) }}</span>
              <template v-if="modelIdentity(subagent.model)">
                <span>·</span>
                <span class="flex items-center gap-1">
                  <!-- eslint-disable vue/no-v-html -- a vendored static logo constant (provider-logos.ts) -->
                  <span
                    v-if="modelIdentity(subagent.model)?.logo"
                    class="size-2.75 flex-none [&>svg]:size-full"
                    aria-hidden="true"
                    v-html="modelIdentity(subagent.model)?.logo"
                  />
                  <!-- eslint-enable vue/no-v-html -->
                  {{ modelIdentity(subagent.model)?.name }}
                </span>
              </template>
              <span>·</span>
              <span class="font-mono">{{ duration(subagent) }}</span>
              <span>·</span>
              <span>{{ t('subagentDisplay.tools', { n: subagentToolCount(subagent) }, subagentToolCount(subagent)) }}</span>
              <AgentUsageStats
                v-if="subagent.usage"
                :usage="subagent.usage"
                :dollar-billed="subagent.dollarBilled"
                variant="card"
                separator="·"
                separator-class=""
              />
            </span>
            <span
              v-if="status === 'running' && statusLine(subagent)"
              class="truncate text-11.5 text-(--d-accent) italic"
            >{{ statusLine(subagent) }}</span>
          </span>
          <span
            class="flex flex-none items-center gap-1.25 rounded-full bg-[color-mix(in_srgb,var(--tone,currentColor)_14%,transparent)] px-2 py-0.5 text-11 font-medium @max-[34.9375rem]/overlay:p-1"
            :class="chip.color"
            :title="t(chip.labelKey)"
          >
            <component
              :is="chip.icon"
              class="size-2.75"
              :class="chip.live && 'd-spinning'"
              aria-hidden="true"
            />
            <span class="@max-[34.9375rem]/overlay:sr-only">{{ t(chip.labelKey) }}</span>
          </span>
        </button>
        <div
          v-else
          class="flex min-w-0 flex-1 items-center gap-2.5 rounded-11 border border-(--d-border) px-3 py-2.25 text-12.5 text-(--d-muted)"
          data-testid="task-fallback-row"
        >
          <component
            :is="chip.icon"
            class="size-3.25 flex-none"
            :class="[chip.color, chip.live && 'd-spinning']"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate">{{ task.description }}</span>
        </div>
        <button
          v-if="task.status === 'running'"
          type="button"
          class="flex size-7.5 flex-none items-center justify-center rounded-lg text-(--d-muted) transition-colors enabled:hover:bg-[color-mix(in_srgb,var(--d-danger)_12%,transparent)] enabled:hover:text-(--d-danger)"
          data-action="stop"
          :title="subagentStop.isTaskStopping(task) ? t('toolCall.stopping') : t('backgroundTask.stopTask')"
          :aria-label="subagentStop.isTaskStopping(task) ? t('toolCall.stopping') : t('backgroundTask.stopTask')"
          :aria-busy="subagentStop.isTaskStopping(task) || undefined"
          :disabled="subagentStop.isTaskStopping(task)"
          @click="subagentStop.stop(task.taskId)"
        >
          <LoaderCircle
            v-if="subagentStop.isTaskStopping(task)"
            class="size-3.25 d-spinning"
            aria-hidden="true"
          />
          <Square
            v-else
            class="size-3.25"
            aria-hidden="true"
          />
        </button>
        <button
          v-else
          type="button"
          class="flex size-7.5 flex-none items-center justify-center rounded-lg text-(--d-muted) transition-colors hover:bg-(--d-hover) hover:text-(--d-text)"
          data-action="dismiss"
          :title="t('backgroundTask.dismiss')"
          :aria-label="t('backgroundTask.dismiss')"
          @click="store.removeTask(task.taskId)"
        >
          <Trash2
            class="size-3.25"
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  </OverlayShell>
</template>
