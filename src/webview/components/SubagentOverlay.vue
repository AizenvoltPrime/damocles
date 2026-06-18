<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SubagentState } from '@shared/types/subagents';
import type { ChatMessage, ToolCall } from '@shared/types/session';
import type { ContentBlock } from '@shared/types/content';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  IconClipboard,
  IconSearch,
  IconCompass,
  IconRobot,
  IconCheck,
  IconXCircle,
  IconBan,
  IconChevronDown,
  IconFile,
} from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import ToolCallCard from './ToolCallCard.vue';
import ThinkingIndicator from './ThinkingIndicator.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import OverlayShell from './OverlayShell.vue';
import { useVSCode } from '@/composables/useVSCode';

const { t } = useI18n();
const { postMessage } = useVSCode();

interface StreamingState {
  content?: string;
  thinking?: string;
  thinkingDuration?: number;
  isThinkingPhase?: boolean;
}

const props = defineProps<{
  subagent: SubagentState;
  streaming?: StreamingState;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'openLog', agentId: string): void;
}>();

const isPromptExpanded = ref(false);
const elapsedSeconds = ref(0);
let timerInterval: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  if (props.subagent.status === 'running') {
    updateElapsed();
    timerInterval = setInterval(updateElapsed, 1000);
  } else {
    updateElapsed();
  }
});

onUnmounted(() => {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
});

function updateElapsed(): void {
  const endTime = props.subagent.endTime ?? Date.now();
  elapsedSeconds.value = Math.floor((endTime - props.subagent.startTime) / 1000);
}

const formattedDuration = computed(() => {
  const elapsed = elapsedSeconds.value;
  if (elapsed < 60) return `${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
});

const agentIcon = computed((): Component => {
  const icons: Record<string, Component> = {
    'code-reviewer': IconSearch,
    Explore: IconCompass,
    Plan: IconClipboard,
    'general-purpose': IconRobot,
  };
  return icons[props.subagent.agentType] || IconClipboard;
});

const statusBadgeClass = computed(() => {
  switch (props.subagent.status) {
    case 'running':
      return 'bg-primary/30 text-primary border-primary/30';
    case 'completed':
      return 'bg-success/30 text-success border-success/30';
    case 'failed':
      return 'bg-error/30 text-error border-error/30';
    case 'cancelled':
      return 'bg-warning/30 text-warning border-warning/30';
    default:
      return 'bg-primary/30 text-primary border-primary/30';
  }
});

const displayStatus = computed(() => {
  const statusMap: Record<string, string> = {
    running: t('subagent.running'),
    completed: t('subagent.completed'),
    failed: t('subagent.failed'),
    cancelled: t('subagent.cancelled'),
  };
  return statusMap[props.subagent.status] || props.subagent.status;
});

const displayAgentType = computed(() => {
  const typeMap: Record<string, string> = {
    'code-reviewer': t('subagentTypes.codeReviewer'),
    Explore: t('subagentTypes.explorer'),
    Plan: t('subagentTypes.planner'),
    'general-purpose': t('subagentTypes.agent'),
    'claude-code-guide': t('subagentTypes.guide'),
    'statusline-setup': t('subagentTypes.setup'),
  };
  return typeMap[props.subagent.agentType] || props.subagent.agentType;
});

const hasPrompt = computed(() => Boolean(props.subagent.prompt?.trim()));

const hasStreamingContent = computed(() =>
  props.streaming && (props.streaming.content || props.streaming.thinking || props.streaming.isThinkingPhase)
);

const resultContent = computed(() =>
  props.subagent.result?.content || props.subagent.lastAssistantMessage
);
const hasResult = computed(() => Boolean(resultContent.value));

const formattedTokens = computed(() => {
  const tokens = props.subagent.result?.totalTokens;
  if (!tokens) return null;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
});

const formattedToolCount = computed(() => {
  if (props.subagent.result?.totalToolUseCount) {
    const count = props.subagent.result.totalToolUseCount;
    return t('subagentDisplay.tools', { n: count }, count);
  }

  let liveCount = props.subagent.toolCalls.length;
  for (const message of props.subagent.messages) {
    if (message.toolCalls) {
      liveCount += message.toolCalls.length;
    }
  }

  if (liveCount === 0) return null;
  return t('subagentDisplay.tools', { n: liveCount }, liveCount);
});

// The extension resolves the authoritative display label (incl. custom providers like StepFun), so
// render it verbatim — never re-parse it as a model id (that drops space-separated names like
// "StepFun Step 3.7 Flash"). Same value flows from live streaming and from a restored transcript.
const displayModel = computed(() => props.subagent.model ?? null);

const hasTemplate = computed(() => Boolean(props.subagent.templatePath));

function openTemplate(): void {
  if (props.subagent.templatePath) {
    postMessage({ type: 'openFile', filePath: props.subagent.templatePath });
  }
}

// Metadata after the agent type (which renders separately so it can be a clickable template link).
const metadataTail = computed(() => [
  formattedDuration.value,
  formattedToolCount.value,
  formattedTokens.value ? `${formattedTokens.value} tokens` : null,
  displayModel.value,
].filter(Boolean));

const overlayStatusBadge = computed(() => {
  const iconMap: Record<string, Component | undefined> = {
    running: undefined,
    completed: IconCheck,
    failed: IconXCircle,
    cancelled: IconBan,
  };
  return {
    label: displayStatus.value,
    class: statusBadgeClass.value,
    icon: iconMap[props.subagent.status],
    showSpinner: props.subagent.status === 'running',
  };
});

const hasLogFile = computed(() => Boolean(props.subagent.sdkAgentId));

function isTextBlock(block: ContentBlock): block is { type: 'text'; text: string } {
  return block.type === 'text';
}

function isToolUseBlock(block: ContentBlock): block is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } {
  return block.type === 'tool_use';
}

function isThinkingBlock(block: ContentBlock): block is { type: 'thinking'; thinking: string } {
  return block.type === 'thinking';
}

function getToolCallById(message: ChatMessage, toolId: string): ToolCall | undefined {
  return message.toolCalls?.find(t => t.id === toolId);
}

function getBlockKey(block: ContentBlock, index: number): string {
  if (isToolUseBlock(block)) return `tool-${block.id}`;
  return `block-${index}`;
}
</script>

<template>
  <OverlayShell
    :title="subagent.description"
    :icon="agentIcon"
    icon-class="text-primary"
    :status-badge="overlayStatusBadge"
    @close="emit('close')"
  >
    <template #subtitle>
      <span class="inline-flex items-center">
        <button
          v-if="hasTemplate"
          type="button"
          class="cursor-pointer text-primary hover:underline"
          :title="t('subagentDisplay.openTemplate', { path: subagent.templatePath })"
          @click="openTemplate"
        >{{ displayAgentType }}</button>
        <span v-else>{{ displayAgentType }}</span>
        <span v-if="metadataTail.length">&nbsp;•&nbsp;{{ metadataTail.join(' • ') }}</span>
      </span>
    </template>

    <template #header-actions>
      <Button
        v-if="hasLogFile"
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-foreground hover:bg-background shrink-0"
        :title="t('subagentDisplay.openLog')"
        @click="emit('openLog', subagent.sdkAgentId!)"
      >
        <IconFile :size="16" />
      </Button>
    </template>

    <div class="p-4 space-y-4">
      <Collapsible v-if="hasPrompt" v-model:open="isPromptExpanded">
        <CollapsibleTrigger as-child>
          <Button
            variant="ghost"
            size="sm"
            class="h-auto py-1 px-2 gap-2 text-primary hover:text-primary/80 hover:bg-muted"
          >
            <IconChevronDown
              :size="14"
              class="transition-transform duration-200"
              :class="{ '-rotate-90': !isPromptExpanded }"
            />
            <span class="text-sm">{{ t('subagentDisplay.viewPrompt') }}</span>
          </Button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div class="mt-2 py-2 px-3 border-l-2 border-border bg-muted/70 rounded-r-md overflow-hidden max-h-48 overflow-y-auto">
            <MarkdownRenderer :content="subagent.prompt" class="text-sm text-muted-foreground" />
          </div>
        </CollapsibleContent>
      </Collapsible>

      <!-- Interleaved message rendering -->
      <template v-for="message in subagent.messages" :key="message.id">
        <template v-if="message.contentBlocks?.length">
          <template v-for="(block, blockIndex) in message.contentBlocks" :key="getBlockKey(block, blockIndex)">
            <ThinkingIndicator
              v-if="isThinkingBlock(block)"
              :thinking="block.thinking"
              :default-expanded="true"
            />

            <div v-else-if="isTextBlock(block)" class="pl-2">
              <MarkdownRenderer :content="block.text" />
            </div>

            <template v-else-if="isToolUseBlock(block)">
              <ToolCallCard
                v-for="tc in [getToolCallById(message, block.id)].filter(Boolean)"
                :key="tc.id"
                :tool-call="tc"
              />
            </template>
          </template>
        </template>
      </template>

      <!-- Live streaming tool calls (rare: a tool normally seals into its message before it executes) -->
      <div v-if="subagent.toolCalls.length > 0" class="space-y-2">
        <ToolCallCard
          v-for="tool in subagent.toolCalls"
          :key="tool.id"
          :tool-call="tool"
        />
      </div>

      <!-- Live in-flight message rendered last, in source order (thinking → text), like the main session -->
      <ThinkingIndicator
        v-if="hasStreamingContent && (streaming?.thinking || streaming?.isThinkingPhase)"
        :thinking="streaming?.thinking"
        :is-streaming="streaming?.isThinkingPhase"
        :duration="streaming?.thinkingDuration"
      />

      <div v-if="hasStreamingContent && streaming?.content" class="pl-2">
        <MarkdownRenderer :content="streaming.content" class="opacity-80" />
      </div>

      <!-- Agent's final result summary -->
      <div v-if="hasResult" class="mt-4 pt-4 border-t border-border/30">
        <div class="flex items-center gap-2 mb-2 text-xs text-primary font-medium">
          <IconCheck :size="14" />
          <span>{{ t('subagentDisplay.result') }}</span>
        </div>
        <div class="pl-2">
          <MarkdownRenderer :content="resultContent!" />
        </div>
      </div>

      <div v-if="!hasStreamingContent && !hasResult && subagent.messages.length === 0 && subagent.toolCalls.length === 0" class="text-center text-muted-foreground text-sm py-8">
        <LoadingSpinner v-if="subagent.status === 'running'" :size="24" class="mx-auto mb-2" />
        <p>{{ subagent.status === 'running' ? t('subagentDisplay.working') : t('subagentDisplay.noActivity') }}</p>
      </div>
    </div>
  </OverlayShell>
</template>
