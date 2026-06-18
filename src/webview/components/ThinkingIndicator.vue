<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { IconBrain, IconChevronDown } from '@/components/icons';
import { useTextStreaming } from '@/composables/useTextStreaming';
import MarkdownRenderer from './MarkdownRenderer.vue';

const { t } = useI18n();

const props = defineProps<{
  thinking?: string;
  isStreaming?: boolean;
  duration?: number;
  /** Start expanded (and stay open). Used where the indicator can't persist its expanded state across
   * a re-mount — e.g. a sealed subagent thought replacing the live streaming one. */
  defaultExpanded?: boolean;
}>();

const thinkingRef = computed(() => props.thinking ?? '');
const isStreamingRef = computed(() => props.isStreaming ?? false);
const { displayedContent } = useTextStreaming(thinkingRef, isStreamingRef);

const isExpanded = ref(props.defaultExpanded ?? false);
const elapsedSeconds = ref(0);
let startTime: number | null = null;
let intervalId: number | null = null;

const hasContent = computed(() => Boolean(props.thinking?.trim()));

const displaySeconds = computed(() => {
  if (props.isStreaming) {
    return elapsedSeconds.value;
  }
  return props.duration ?? 0;
});

function startTimer() {
  if (intervalId !== null) return;
  startTime = Date.now();
  elapsedSeconds.value = 0;
  intervalId = window.setInterval(() => {
    if (startTime) {
      elapsedSeconds.value = Math.floor((Date.now() - startTime) / 1000);
    }
  }, 1000);
}

function stopTimer() {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
    startTime = null;
  }
}

watch(() => props.isStreaming, (streaming) => {
  if (streaming) {
    startTimer();
    if (hasContent.value) {
      isExpanded.value = true;
    }
  } else {
    stopTimer();
  }
}, { immediate: true });

watch(() => props.thinking, () => {
  if (props.isStreaming && props.thinking) {
    isExpanded.value = true;
  }
});

onMounted(() => {
  if (props.isStreaming) {
    startTimer();
  }
});

onUnmounted(() => {
  stopTimer();
});
</script>

<template>
  <Collapsible
    v-if="isStreaming || hasContent || duration"
    v-model:open="isExpanded"
    class="thinking-indicator"
  >
    <CollapsibleTrigger
      :class="[
        'group flex items-center gap-2 py-1 px-2 -mx-2 rounded-md transition-colors',
        hasContent ? 'cursor-pointer hover:bg-muted/50' : 'cursor-default'
      ]"
      :disabled="!hasContent"
    >
      <!-- Brain icon with subtle animation -->
      <div class="relative flex items-center justify-center">
        <IconBrain
          :size="14"
          :class="[
            'text-muted-foreground transition-all',
            isStreaming && 'animate-pulse'
          ]"
        />
      </div>

      <!-- Label and duration -->
      <div class="flex items-center gap-2">
        <span class="text-sm text-muted-foreground">
          {{ isStreaming ? t('thinking.thinking') : t('thinking.thought') }}
        </span>
        <span
          v-if="isStreaming || displaySeconds > 0"
          class="text-xs text-muted-foreground/70 tabular-nums"
        >
          {{ displaySeconds }}s
        </span>
      </div>

      <!-- Chevron indicator -->
      <IconChevronDown
        v-if="hasContent"
        :size="14"
        :class="[
          'text-muted-foreground/60 transition-transform duration-200',
          isExpanded && '-rotate-180'
        ]"
      />
    </CollapsibleTrigger>

    <CollapsibleContent>
      <div
        v-if="hasContent"
        class="thinking-container mt-2 py-2 px-3 border-l-2 border-border rounded-r-md overflow-hidden max-h-64 overflow-y-auto"
      >
        <div class="thinking-content text-xs text-muted-foreground font-mono">
          <MarkdownRenderer :content="isStreaming ? displayedContent : thinking" />
        </div>
      </div>
    </CollapsibleContent>
  </Collapsible>
</template>

<style scoped>
.thinking-indicator {
  font-size: var(--vscode-font-size, 0.813rem);
}

.thinking-container {
  background-color: var(--vscode-textCodeBlock-background, hsl(var(--muted) / 0.5));
}

.thinking-content :deep(.markdown-renderer) {
  color: var(--vscode-descriptionForeground);
}

.thinking-content :deep(.markdown-p) {
  margin: 0.25rem 0;
}

.thinking-content :deep(.markdown-heading) {
  margin-top: 0.5rem;
  margin-bottom: 0.25rem;
  font-size: 0.9em;
}

.thinking-content :deep(.inline-code) {
  font-size: 0.9em;
}
</style>
