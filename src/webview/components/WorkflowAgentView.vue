<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { WorkflowAgentTranscript, WorkflowAgentToolCall } from '@shared/types/workflows';
import type { ToolCall } from '@shared/types/session';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { IconChevronDown, IconCheck } from '@/components/icons';
import MarkdownRenderer from './MarkdownRenderer.vue';
import StructuredResult from './StructuredResult.vue';
import ThinkingIndicator from './ThinkingIndicator.vue';
import ToolCallCard from './ToolCallCard.vue';

const { t } = useI18n();
const props = defineProps<{ agent: WorkflowAgentTranscript }>();

const isPromptExpanded = ref(false);
const hasPrompt = computed(() => Boolean(props.agent.prompt?.trim()));
const hasResult = computed(() => {
  const result = props.agent.result;
  if (result === null || result === undefined || result === '') return false;
  if (Array.isArray(result)) return result.length > 0;
  if (typeof result === 'object') return Object.keys(result).length > 0;
  return true;
});

function toToolCall(toolCall: WorkflowAgentToolCall): ToolCall {
  return {
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
    status: 'completed',
    ...(toolCall.result !== null ? { result: toolCall.result } : {}),
  };
}
</script>

<template>
  <div class="p-4 space-y-4">
    <Collapsible v-if="hasPrompt" v-model:open="isPromptExpanded">
      <CollapsibleTrigger as-child>
        <Button variant="ghost" size="sm" class="h-auto py-1 px-2 gap-2 text-primary hover:text-primary/80 hover:bg-muted">
          <IconChevronDown :size="14" class="transition-transform duration-200" :class="{ '-rotate-90': !isPromptExpanded }" />
          <span class="text-sm">{{ t('subagentDisplay.viewPrompt') }}</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div class="mt-2 py-2 px-3 border-l-2 border-border bg-muted/70 rounded-r-md overflow-hidden max-h-48 overflow-y-auto">
          <MarkdownRenderer :content="agent.prompt" class="text-sm text-muted-foreground" />
        </div>
      </CollapsibleContent>
    </Collapsible>

    <template v-for="(block, index) in agent.blocks" :key="index">
      <ThinkingIndicator v-if="block.type === 'thinking'" :thinking="block.thinking" />
      <div v-else-if="block.type === 'text'" class="pl-2">
        <MarkdownRenderer :content="block.text" />
      </div>
      <ToolCallCard v-else-if="block.type === 'tool_use'" :tool-call="toToolCall(block.toolCall)" />
    </template>

    <div v-if="hasResult" class="mt-4 pt-4 border-t border-border/30">
      <div class="flex items-center gap-2 mb-2 text-xs text-primary font-medium">
        <IconCheck :size="14" />
        <span>{{ t('subagentDisplay.result') }}</span>
      </div>
      <div class="pl-2">
        <StructuredResult :value="agent.result" />
      </div>
    </div>

    <div v-if="agent.blocks.length === 0 && !hasResult" class="text-center text-muted-foreground text-sm py-8">
      {{ t('workflowTask.noActivity') }}
    </div>
  </div>
</template>
