<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { IconChevronDown } from '@/components/icons';
import CodeBlock from './CodeBlock.vue';
import { formatDuration } from '@/utils/stringUtils';
import type { GraphNodeState } from '@shared/types/graph';

const { t } = useI18n();

const props = defineProps<{
  nodeState: GraphNodeState | null;
}>();

const statusVariant = computed(() => {
  switch (props.nodeState?.status) {
    case 'completed': return 'default';
    case 'error': return 'destructive';
    case 'running': return 'secondary';
    default: return 'outline';
  }
});

const nodeSummary = computed(() => {
  if (!props.nodeState?.outputState) return null;
  const out = props.nodeState.outputState;
  const name = props.nodeState.name;

  if (name === 'intentAnalysis') {
    return {
      badges: [
        out['intent'] ? `Intent: ${out['intent']}` : null,
        out['secondaryIntent'] ? `Secondary: ${out['secondaryIntent']}` : null,
        Array.isArray(out['keyEntities']) ? `${(out['keyEntities'] as unknown[]).length} entities` : null,
      ].filter(Boolean) as string[],
    };
  }

  if (name === 'recallRepl') {
    const traj = out['recallTrajectory'] as Record<string, unknown> | undefined;
    return {
      badges: [
        traj?.['shortCircuited'] ? 'Short-circuited' : null,
        typeof traj?.['totalDurationMs'] === 'number' ? formatDuration(traj['totalDurationMs'] as number) : null,
        Array.isArray(traj?.['iterations']) ? `${(traj['iterations'] as unknown[]).length} iterations` : null,
      ].filter(Boolean) as string[],
    };
  }

  if (name === 'stateUpdate') {
    const trace = out['sessionTrace'] as Record<string, unknown> | undefined;
    const entries = trace?.['entries'];
    return {
      badges: [
        Array.isArray(entries) ? `${entries.length} trace entries` : null,
      ].filter(Boolean) as string[],
    };
  }

  return null;
});

function formatJson(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}
</script>

<template>
  <div v-if="nodeState" class="mt-3 rounded-xl border border-border bg-muted/60 p-3 space-y-2 animate-fade-in">
    <!-- Header -->
    <div class="flex items-center gap-2 flex-wrap">
      <Badge variant="secondary" class="text-[10px] font-mono">{{ nodeState.name }}</Badge>
      <Badge :variant="statusVariant" class="text-[10px]">{{ nodeState.status }}</Badge>
      <span v-if="nodeState.durationMs !== undefined" class="text-[10px] text-muted-foreground tabular-nums">
        {{ formatDuration(nodeState.durationMs) }}
      </span>
    </div>

    <!-- Error -->
    <div
      v-if="nodeState.error"
      class="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-[11px] text-red-400"
    >
      {{ nodeState.error }}
    </div>

    <!-- Node-specific summary badges -->
    <div v-if="nodeSummary" class="flex items-center gap-1.5 flex-wrap">
      <Badge
        v-for="(badge, i) in nodeSummary.badges"
        :key="i"
        variant="outline"
        class="text-[9px] px-1.5 py-0"
      >{{ badge }}</Badge>
    </div>

    <!-- Input State -->
    <Collapsible v-if="nodeState.inputState">
      <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer">
        <IconChevronDown :size="12" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
        <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{{ t('contextInjection.graphInputState') }}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div class="mt-1">
          <CodeBlock :code="formatJson(nodeState.inputState)" language="json" />
        </div>
      </CollapsibleContent>
    </Collapsible>

    <!-- Output State -->
    <Collapsible v-if="nodeState.outputState" :default-open="true">
      <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer">
        <IconChevronDown :size="12" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
        <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{{ t('contextInjection.graphOutputState') }}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div class="mt-1">
          <CodeBlock :code="formatJson(nodeState.outputState)" language="json" />
        </div>
      </CollapsibleContent>
    </Collapsible>
  </div>
</template>
