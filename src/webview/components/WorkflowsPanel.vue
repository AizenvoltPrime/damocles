<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  IconSparkles,
  IconStop,
  IconCheck,
  IconXCircle,
  IconBan,
  IconCompass,
  IconClipboard,
  IconSearch,
  IconRobot,
  IconFile,
} from '@/components/icons';
import OverlayShell from './OverlayShell.vue';
import LoadingSpinner from './LoadingSpinner.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import StructuredResult from './StructuredResult.vue';
import WorkflowAgentView from './WorkflowAgentView.vue';
import { useWorkflowStore } from '@/stores/useWorkflowStore';
import { useVSCode } from '@/composables/useVSCode';
import { formatTokens, formatDuration } from '@/lib/workflow-format';
import type { WorkflowRun, WorkflowStatus, WorkflowAgentTranscript } from '@shared/types/workflows';

const { t } = useI18n();
const store = useWorkflowStore();
const { postMessage } = useVSCode();

const emit = defineEmits<{ (e: 'close'): void }>();

const selected = computed(() => store.selectedWorkflow);
const selectedAgent = computed(() => store.selectedAgent);
const workflows = computed(() => store.workflowList);

function statusIcon(status: WorkflowStatus): Component | null {
  switch (status) {
    case 'completed': return IconCheck;
    case 'failed': return IconXCircle;
    case 'stopped': return IconBan;
    default: return null;
  }
}

function statusClass(status: WorkflowStatus): string {
  switch (status) {
    case 'completed': return 'text-success';
    case 'failed': return 'text-error';
    case 'stopped': return 'text-muted-foreground';
    default: return 'text-primary';
  }
}

function statusBadgeClass(status: WorkflowStatus): string {
  switch (status) {
    case 'completed': return 'bg-success/20 text-success border-success/30';
    case 'failed': return 'bg-error/20 text-error border-error/30';
    case 'stopped': return 'bg-muted text-muted-foreground';
    default: return 'bg-primary/20 text-primary border-primary/30';
  }
}

function cardBorderClass(status: WorkflowStatus): string {
  switch (status) {
    case 'failed': return 'border-error/40 hover:border-error/60';
    case 'completed': return 'border-success/40 hover:border-success/60';
    case 'stopped': return 'border-border';
    default: return 'border-primary/40 hover:border-primary/60';
  }
}

function workflowLabel(run: WorkflowRun): string {
  return run.name || run.description || t('workflowTask.unnamed');
}

function agentTypeIcon(agentType: string | null): Component {
  switch (agentType) {
    case 'Explore': return IconCompass;
    case 'Plan': return IconClipboard;
    case 'code-reviewer': return IconSearch;
    default: return IconRobot;
  }
}

function agentCardClass(running: boolean): string {
  return running
    ? 'border-primary/50 hover:border-primary/70 cursor-pointer'
    : 'border-success/50 hover:border-success/70 cursor-pointer';
}

// A workflow's result reaches the panel two ways: live (from the task output file, raw) and
// from history (re-derived from the persisted <task-notification>, whose XML body is HTML-entity
// encoded). Decode before JSON-parsing/markdown so both paths render identically.
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, '&');
}

const decodedResult = computed(() => decodeEntities(selected.value?.result ?? ''));

// A workflow's result is JSON when the script returns an object; render that structurally,
// and fall back to markdown for a plain-text result.
const parsedResult = computed<unknown>(() => {
  if (!decodedResult.value) return null;
  try {
    return JSON.parse(decodedResult.value);
  } catch {
    return null;
  }
});

const hasResult = computed(() => decodedResult.value.trim().length > 0);

const detailTabs = ['agents', 'result'] as const;
type DetailTab = typeof detailTabs[number];
const activeTab = ref<DetailTab>('agents');

function detailTabLabel(tab: DetailTab): string {
  return tab === 'result' ? t('workflowTask.result') : t('workflowTask.agentsSection');
}

function setDetailTab(tab: DetailTab): void {
  if (tab === 'result' && !hasResult.value) return;
  activeTab.value = tab;
}

// Reset to the Agents tab whenever a different workflow is opened.
watch(() => store.selectedToolUseId, () => { activeTab.value = 'agents'; });

const transcripts = computed(() => {
  const run = selected.value;
  return run ? store.transcripts[run.toolUseId] ?? null : null;
});

const transcriptsLoading = computed(() => {
  const run = selected.value;
  return run ? store.transcriptsLoading[run.toolUseId] === true : false;
});

const transcriptsError = computed(() => {
  const run = selected.value;
  return run ? store.transcriptsError[run.toolUseId] ?? null : null;
});

const displayAgentCount = computed(() => {
  const fromUsage = selected.value?.usage?.agentCount ?? 0;
  return fromUsage > 0 ? fromUsage : transcripts.value?.length ?? 0;
});

function fetchTranscripts(run: WorkflowRun): void {
  if (!run.transcriptDir) return;
  store.markTranscriptsLoading(run.toolUseId);
  postMessage({ type: 'getWorkflowTranscripts', toolUseId: run.toolUseId, transcriptDir: run.transcriptDir });
}

// Fetch transcripts once when a workflow is opened whose transcripts aren't already loaded.
// Live runs are kept fresh by the extension, which pushes `workflowTranscripts` on each
// task_progress and on completion — so no polling here; this fetch only seeds the initial
// view (notably for history-loaded runs, which have no live push). transcriptDir is a watch
// dependency because the overlay can open before the launch result lands in the store.
watch(
  () => {
    const run = selected.value;
    return run ? { toolUseId: run.toolUseId, transcriptDir: run.transcriptDir } : null;
  },
  (curr) => {
    const run = selected.value;
    if (!curr || !run || !curr.transcriptDir) return;
    if (store.transcripts[curr.toolUseId] === undefined && !store.transcriptsLoading[curr.toolUseId]) {
      fetchTranscripts(run);
    }
  },
  { immediate: true },
);

const shellTitle = computed(() => {
  if (selectedAgent.value) return selectedAgent.value.label;
  if (selected.value) return workflowLabel(selected.value);
  return t('workflowTask.title');
});

const shellSubtitle = computed(() => {
  const agent = selectedAgent.value;
  if (!agent) return undefined;
  return [agent.model, t('workflowTask.toolCount', { count: agent.toolUseCount }, agent.toolUseCount)]
    .filter(Boolean)
    .join(' • ');
});

function stopWorkflow(run: WorkflowRun): void {
  if (run.taskId) {
    postMessage({ type: 'stopWorkflow', taskId: run.taskId, toolUseId: run.toolUseId });
  }
}

function openWorkflowAgentLog(agent: WorkflowAgentTranscript): void {
  postMessage({ type: 'openWorkflowAgentLog', logFile: agent.logFile });
}

function openWorkflowJournal(run: WorkflowRun): void {
  if (run.transcriptDir) {
    postMessage({ type: 'openWorkflowJournal', transcriptDir: run.transcriptDir });
  }
}

function handleShellClose(): void {
  if (store.selectedAgentId) {
    store.closeAgent();
    return;
  }
  if (store.selectedToolUseId && workflows.value.length > 1) {
    store.selectWorkflow(null);
    return;
  }
  emit('close');
}
</script>

<template>
  <OverlayShell
    :title="shellTitle"
    :subtitle="shellSubtitle"
    :icon="selectedAgent ? IconRobot : IconSparkles"
    icon-class="text-blue-400"
    @close="handleShellClose"
  >
    <template #header-actions>
      <Button
        v-if="selectedAgent"
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-foreground hover:bg-background shrink-0"
        :title="t('workflowTask.openLog')"
        @click="openWorkflowAgentLog(selectedAgent)"
      >
        <IconFile :size="16" />
      </Button>
      <Button
        v-else-if="selected && selected.transcriptDir"
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-foreground hover:bg-background shrink-0"
        :title="t('workflowTask.openLog')"
        @click="openWorkflowJournal(selected)"
      >
        <IconFile :size="16" />
      </Button>
      <Badge v-else-if="!selected && store.activeWorkflowCount > 0" variant="secondary" class="bg-primary/20 text-primary shrink-0 gap-1">
        <LoadingSpinner :size="10" class="text-primary" />
        {{ store.activeWorkflowCount }} {{ t('workflowTask.running') }}
      </Badge>
    </template>

    <!-- Agent transcript view -->
    <WorkflowAgentView v-if="selectedAgent" :agent="selectedAgent" />

    <!-- Empty state -->
    <div v-else-if="workflows.length === 0" class="flex-1 flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
      <div class="w-12 h-12 rounded-full bg-muted/50 flex items-center justify-center">
        <IconSparkles :size="24" class="opacity-30" />
      </div>
      <div class="text-center max-w-xs">
        <p class="text-sm font-medium">{{ t('workflowTask.noWorkflows') }}</p>
        <p class="text-xs opacity-60 mt-0.5">{{ t('workflowTask.noWorkflowsHint') }}</p>
      </div>
    </div>

    <!-- Detail view -->
    <div v-else-if="selected" class="flex flex-col h-full">
      <!-- Header (persistent across tabs) -->
      <div class="p-3 space-y-2 shrink-0 border-b border-border/30">
        <div class="flex items-start gap-2">
          <component :is="statusIcon(selected.status)" v-if="statusIcon(selected.status)" :size="18" class="shrink-0 mt-0.5" :class="statusClass(selected.status)" />
          <LoadingSpinner v-else :size="16" class="text-primary shrink-0 mt-0.5" />
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-foreground break-words">{{ workflowLabel(selected) }}</p>
            <p v-if="selected.description && selected.description !== selected.name" class="text-xs text-muted-foreground mt-0.5 break-words">{{ selected.description }}</p>
          </div>
          <Badge variant="secondary" :class="statusBadgeClass(selected.status)" class="shrink-0">{{ selected.status }}</Badge>
          <Button
            v-if="selected.status === 'running' && selected.taskId"
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground hover:text-error hover:bg-error/10 h-6 w-6 shrink-0"
            :title="t('workflowTask.stopTask')"
            @click="stopWorkflow(selected)"
          >
            <IconStop :size="12" />
          </Button>
        </div>
        <div v-if="selected.usage" class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-primary/80">
          <span v-if="displayAgentCount > 0" class="font-medium">{{ displayAgentCount }} {{ t('workflowTask.agents') }}</span>
          <span class="font-medium">{{ formatTokens(selected.usage.subagentTokens) }} {{ t('common.tokens') }}</span>
          <span class="font-medium">{{ selected.usage.toolUses }} {{ t('workflowTask.tools') }}</span>
          <span class="font-medium">{{ formatDuration(selected.usage.durationMs) }}</span>
        </div>
      </div>

      <!-- Tab bar -->
      <div class="flex border-b border-border/30 px-4 shrink-0">
        <button
          v-for="tab in detailTabs"
          :key="tab"
          :disabled="tab === 'result' && !hasResult"
          class="px-3 py-2 text-xs font-medium transition-colors relative"
          :class="activeTab === tab
            ? 'text-primary cursor-default'
            : tab === 'result' && !hasResult
              ? 'text-foreground/20 cursor-not-allowed'
              : 'text-foreground/60 hover:text-foreground cursor-pointer'"
          @click="setDetailTab(tab)"
        >
          {{ detailTabLabel(tab) }}
          <Badge v-if="tab === 'agents' && displayAgentCount > 0" variant="secondary" class="ml-1 text-[10px] px-1 py-0 bg-foreground/10">{{ displayAgentCount }}</Badge>
          <div v-if="activeTab === tab" class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
        </button>
      </div>

      <!-- Tab content -->
      <div class="flex-1 min-h-0 overflow-y-auto">
        <!-- Agents tab -->
        <div v-if="activeTab === 'agents'" class="p-3 space-y-3">
          <div v-if="selected.phases.length" class="space-y-1">
            <p class="text-xs font-semibold text-foreground/80">{{ t('workflowTask.phases') }}</p>
            <ol class="space-y-1">
              <li v-for="(phase, idx) in selected.phases" :key="idx" class="flex gap-2 text-xs">
                <span class="text-muted-foreground/60 tabular-nums shrink-0">{{ idx + 1 }}.</span>
                <span class="text-foreground/80 font-medium shrink-0">{{ phase.title }}</span>
                <span v-if="phase.detail" class="text-muted-foreground truncate">— {{ phase.detail }}</span>
              </li>
            </ol>
          </div>

          <div v-if="transcriptsLoading" class="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <LoadingSpinner :size="12" />
            {{ t('workflowTask.loadingTranscripts') }}
          </div>
          <div v-else-if="transcriptsError" class="flex items-start gap-2 text-xs text-error py-2">
            <IconXCircle :size="14" class="shrink-0 mt-0.5" />
            <span class="break-words">{{ t('workflowTask.transcriptsError', { error: transcriptsError }) }}</span>
          </div>
          <div v-else-if="transcripts && transcripts.length" class="space-y-1.5">
            <Card
              v-for="agent in transcripts"
              :key="agent.agentId"
              class="overflow-hidden transition-colors"
              :class="agentCardClass(agent.running)"
              @click="store.openAgent(agent.agentId)"
            >
              <div class="flex items-center gap-2 px-2.5 py-1.5 bg-foreground/5">
                <component :is="agentTypeIcon(agent.agentType)" :size="14" class="shrink-0 text-primary" />
                <span class="text-xs font-medium text-foreground truncate flex-1">{{ agent.label }}</span>
                <span v-if="agent.model" class="text-[10px] text-muted-foreground font-mono shrink-0">{{ agent.model }}</span>
                <span class="text-[10px] text-muted-foreground shrink-0">{{ agent.toolUseCount }} {{ t('workflowTask.tools') }}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="text-muted-foreground hover:text-foreground h-6 w-6 shrink-0"
                  :title="t('workflowTask.openLog')"
                  @click.stop="openWorkflowAgentLog(agent)"
                >
                  <IconFile :size="12" />
                </Button>
                <LoadingSpinner v-if="agent.running" :size="14" class="shrink-0 text-primary" />
                <IconCheck v-else :size="14" class="shrink-0 text-success" />
              </div>
            </Card>
          </div>
          <p v-else class="text-xs text-muted-foreground py-1">{{ t('workflowTask.noTranscripts') }}</p>
        </div>

        <!-- Result tab -->
        <div v-else-if="activeTab === 'result'" class="p-3">
          <StructuredResult v-if="parsedResult !== null" :value="parsedResult" />
          <MarkdownRenderer v-else-if="decodedResult" :content="decodedResult" class="text-sm" />
        </div>
      </div>
    </div>

    <!-- List view -->
    <div v-else class="p-3 space-y-2">
      <Card
        v-for="run in workflows"
        :key="run.toolUseId"
        class="overflow-hidden cursor-pointer transition-colors"
        :class="cardBorderClass(run.status)"
        @click="store.selectWorkflow(run.toolUseId)"
      >
        <div class="flex items-center gap-2 px-3 py-2 bg-foreground/5 border-b border-border/30">
          <component :is="statusIcon(run.status)" v-if="statusIcon(run.status)" :size="14" :class="statusClass(run.status)" class="shrink-0" />
          <LoadingSpinner v-else :size="14" class="text-primary shrink-0" />
          <span class="text-sm text-foreground font-medium truncate flex-1">{{ workflowLabel(run) }}</span>
          <Badge variant="secondary" :class="statusBadgeClass(run.status)" class="gap-1 shrink-0">{{ run.status }}</Badge>
        </div>
        <CardContent v-if="run.usage" class="p-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span v-if="run.usage.agentCount > 0">{{ run.usage.agentCount }} {{ t('workflowTask.agents') }}</span>
          <span>{{ formatTokens(run.usage.subagentTokens) }} {{ t('common.tokens') }}</span>
          <span>{{ formatDuration(run.usage.durationMs) }}</span>
        </CardContent>
      </Card>
    </div>
  </OverlayShell>
</template>
