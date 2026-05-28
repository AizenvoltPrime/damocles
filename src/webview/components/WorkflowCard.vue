<script setup lang="ts">
import { computed, watchEffect, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall } from '@shared/types/session';
import type { WorkflowStatus } from '@shared/types/workflows';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconSparkles, IconCheck, IconXCircle, IconBan, IconFile } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import { useWorkflowStore } from '@/stores/useWorkflowStore';
import { useVSCode } from '@/composables/useVSCode';
import { parseWorkflowMeta, parseTranscriptDir, parseTaskId } from '@/lib/workflow-meta';
import { formatTokens, formatDuration } from '@/lib/workflow-format';

const { t } = useI18n();
const store = useWorkflowStore();
const { postMessage } = useVSCode();

const props = defineProps<{ toolCall: ToolCall }>();
const emit = defineEmits<{ (e: 'expand', toolUseId: string): void }>();

const toolUseId = computed(() => props.toolCall.id);

watchEffect(() => {
  const script = typeof props.toolCall.input['script'] === 'string' ? (props.toolCall.input['script'] as string) : '';
  const meta = parseWorkflowMeta(script);
  const result = props.toolCall.result ?? '';
  store.upsertMeta(toolUseId.value, {
    name: meta.name,
    description: meta.description,
    phases: meta.phases,
    transcriptDir: result ? parseTranscriptDir(result) : null,
    taskId: result ? parseTaskId(result) : null,
  });
});

const run = computed(() => store.runs[toolUseId.value] ?? null);
const status = computed<WorkflowStatus>(() => run.value?.status ?? 'running');
const displayName = computed(() => run.value?.name || run.value?.description || t('workflowTask.unnamed'));
const usage = computed(() => run.value?.usage ?? null);
const phaseCount = computed(() => run.value?.phases.length ?? 0);
const transcriptDir = computed(() => run.value?.transcriptDir ?? null);

function openJournal(): void {
  if (transcriptDir.value) {
    postMessage({ type: 'openWorkflowJournal', transcriptDir: transcriptDir.value });
  }
}

const statusIcon = computed<Component | null>(() => {
  switch (status.value) {
    case 'completed': return IconCheck;
    case 'failed': return IconXCircle;
    case 'stopped': return IconBan;
    default: return null;
  }
});

const statusClass = computed(() => {
  switch (status.value) {
    case 'completed': return 'text-success';
    case 'failed': return 'text-error';
    case 'stopped': return 'text-muted-foreground';
    default: return 'text-primary';
  }
});

const statusBadgeClass = computed(() => {
  switch (status.value) {
    case 'completed': return 'bg-success/20 text-success border-success/30';
    case 'failed': return 'bg-error/20 text-error border-error/30';
    case 'stopped': return 'bg-muted text-muted-foreground';
    default: return 'bg-primary/20 text-primary border-primary/30';
  }
});

const cardClass = computed(() => {
  switch (status.value) {
    case 'failed': return 'border-error/40 hover:border-error/60';
    case 'completed': return 'border-success/40 hover:border-success/60';
    default: return 'border-primary/30 hover:border-primary/50';
  }
});
</script>

<template>
  <Card
    class="text-sm overflow-hidden cursor-pointer transition-colors"
    :class="cardClass"
    @click="emit('expand', toolUseId)"
  >
    <div class="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 bg-gradient-to-r from-primary/10 to-transparent">
      <IconSparkles :size="18" class="shrink-0 text-primary" />
      <span class="text-foreground font-medium shrink-0">{{ t('workflowTask.workflowLabel') }}</span>
      <span class="text-muted-foreground text-xs truncate min-w-0 flex-1">{{ displayName }}</span>
      <Button
        v-if="transcriptDir"
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-foreground h-6 w-6 shrink-0"
        :title="t('workflowTask.openLog')"
        @click.stop="openJournal"
      >
        <IconFile :size="13" />
      </Button>
      <Badge variant="secondary" class="shrink-0 gap-1" :class="statusBadgeClass">{{ status }}</Badge>
    </div>

    <CardContent class="p-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span v-if="phaseCount" class="font-medium">{{ t('workflowTask.phaseCount', { count: phaseCount }) }}</span>
      <template v-if="usage">
        <span v-if="usage.agentCount > 0">{{ usage.agentCount }} {{ t('workflowTask.agents') }}</span>
        <span>{{ formatTokens(usage.subagentTokens) }} {{ t('common.tokens') }}</span>
        <span>{{ usage.toolUses }} {{ t('workflowTask.tools') }}</span>
        <span>{{ formatDuration(usage.durationMs) }}</span>
      </template>
      <LoadingSpinner v-if="status === 'running'" :size="14" class="ml-auto text-primary shrink-0" />
      <component v-else :is="statusIcon" :size="16" class="ml-auto shrink-0" :class="statusClass" />
    </CardContent>
  </Card>
</template>
