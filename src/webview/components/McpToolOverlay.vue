<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { McpToolData } from '@shared/types/session';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  IconMcp,
  IconCheck,
  IconXCircle,
  IconWarning,
  IconChevronDown,
} from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import CodeBlock from './CodeBlock.vue';
import OverlayShell from './OverlayShell.vue';

const { t } = useI18n();

interface ContentBlock {
  type: string;
  text?: string;
}

const props = defineProps<{
  tool: McpToolData;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const isInputExpanded = ref(true);
const isResponseExpanded = ref(true);

const parsedToolName = computed(() => {
  const name = props.tool.name;
  if (!name.startsWith('mcp__')) {
    return { serverName: '', toolName: name };
  }
  const parts = name.split('__');
  return {
    serverName: parts[1] || '',
    toolName: parts.slice(2).join('__') || name,
  };
});

const parsedResult = computed(() => {
  if (!props.tool.result) return '';

  try {
    const parsed = JSON.parse(props.tool.result);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.type === 'text') {
      return parsed
        .filter((block: ContentBlock) => block.type === 'text' && block.text)
        .map((block: ContentBlock) => block.text)
        .join('\n\n');
    }
    return props.tool.result;
  } catch {
    return props.tool.result;
  }
});

const isRunning = computed(() =>
  props.tool.status === 'running' || props.tool.status === 'pending'
);

const isFailed = computed(() => props.tool.status === 'failed');

const isCompleted = computed(() => props.tool.status === 'completed');

const statusBadge = computed(() => {
  if (isRunning.value) {
    return { label: t('toolOverlay.statusRunning'), class: 'bg-primary/30 text-primary border-primary/30', showSpinner: true };
  }
  if (isCompleted.value) {
    return { label: t('toolOverlay.statusCompleted'), class: 'bg-success/30 text-success border-success/30', icon: IconCheck };
  }
  if (isFailed.value) {
    return { label: t('toolOverlay.statusFailed'), class: 'bg-error/30 text-error border-error/30', icon: IconXCircle };
  }
  return { label: props.tool.status, class: 'bg-muted text-muted-foreground border-muted', icon: IconWarning };
});

const hasResult = computed(() => Boolean(parsedResult.value?.trim()));

const hasInput = computed(() => Object.keys(props.tool.input ?? {}).length > 0);

const inputAsJson = computed(() => JSON.stringify(props.tool.input ?? {}, null, 2));

function tryParseJson(str: string): unknown | null {
  const trimmed = str.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null;
  }
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

const parsedResponseJson = computed(() => tryParseJson(parsedResult.value));

const responseIsJson = computed(() => parsedResponseJson.value !== null);

const formattedResponse = computed(() => {
  if (parsedResponseJson.value !== null) {
    return JSON.stringify(parsedResponseJson.value, null, 2);
  }
  return parsedResult.value;
});

</script>

<template>
  <OverlayShell
    :title="parsedToolName.toolName"
    :subtitle="parsedToolName.serverName || undefined"
    :icon="IconMcp"
    icon-class="text-primary"
    :status-badge="statusBadge"
    @close="emit('close')"
  >
    <div class="p-4 space-y-4">
      <div v-if="isFailed && tool.errorMessage" class="text-error">
        <div class="flex items-center gap-2 mb-2 text-xs font-medium">
          <IconXCircle :size="14" />
          <span>{{ t('common.error') }}</span>
        </div>
        <div class="pl-2 font-mono text-sm">{{ tool.errorMessage }}</div>
      </div>

      <div v-else-if="isRunning" class="text-center text-muted-foreground text-sm py-8">
        <LoadingSpinner :size="24" class="mx-auto mb-2" />
        <p>{{ t('mcpToolOverlay.running') }}</p>
      </div>

      <template v-else>
        <!-- Input Section -->
        <Collapsible v-model:open="isInputExpanded">
          <CollapsibleTrigger
            class="group flex items-center gap-2 py-1.5 px-2 -mx-2 rounded-md transition-colors cursor-pointer hover:bg-muted/50 w-full"
          >
            <IconChevronDown
              :size="14"
              class="text-muted-foreground transition-transform duration-200"
              :class="{ '-rotate-90': !isInputExpanded }"
            />
            <span class="text-xs font-medium text-muted-foreground">{{ t('mcpToolOverlay.input') }}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div class="mt-2">
              <CodeBlock v-if="hasInput" :code="inputAsJson" language="json" />
              <div v-else class="text-sm text-muted-foreground italic pl-6">
                {{ t('mcpToolOverlay.noInput') }}
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <!-- Response Section -->
        <Collapsible v-if="hasResult" v-model:open="isResponseExpanded">
          <CollapsibleTrigger
            class="group flex items-center gap-2 py-1.5 px-2 -mx-2 rounded-md transition-colors cursor-pointer hover:bg-muted/50 w-full"
          >
            <IconChevronDown
              :size="14"
              class="text-primary transition-transform duration-200"
              :class="{ '-rotate-90': !isResponseExpanded }"
            />
            <span class="text-xs font-medium text-primary">{{ t('mcpToolOverlay.response') }}</span>
            <IconCheck :size="14" class="text-primary" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div class="mt-2">
              <template v-if="responseIsJson">
                <CodeBlock :code="formattedResponse" language="json" />
              </template>
              <template v-else>
                <div class="pl-2">
                  <MarkdownRenderer :content="formattedResponse" />
                </div>
              </template>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <!-- No Response State -->
        <div v-else class="text-center text-muted-foreground text-sm py-8">
          <p>{{ t('mcpToolOverlay.noResponse') }}</p>
        </div>
      </template>
    </div>
  </OverlayShell>
</template>
