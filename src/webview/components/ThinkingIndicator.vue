<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Brain, ChevronRight } from 'lucide-vue-next';
import { useTextStreaming } from '@/composables/useTextStreaming';
import { useStickToBottom } from '@/composables/useStickToBottom';
import MarkdownRenderer from './MarkdownRenderer.vue';
import EffortBadge from './EffortBadge.vue';
import type { EffortBadgeLevel } from '@shared/effort-badge';

const { t } = useI18n();

const props = defineProps<{
  thinking?: string | undefined;
  isStreaming?: boolean | undefined;
  duration?: number | undefined;
  /** Start expanded (and stay open). Used where the indicator can't persist its expanded state across
   * a re-mount — e.g. a sealed subagent thought replacing the live streaming one. */
  defaultExpanded?: boolean | undefined;
  effort?: EffortBadgeLevel | undefined;
}>();

const thinkingRef = computed(() => props.thinking ?? '');
const isStreamingRef = computed(() => props.isStreaming ?? false);
const { displayedContent } = useTextStreaming(thinkingRef, isStreamingRef);
const contentScroll = ref<HTMLElement | null>(null);
// A finished block opens at its start; one still streaming opens on its latest line.
useStickToBottom(contentScroll, { startFollowing: () => isStreamingRef.value });

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
    class="flex flex-col text-13"
  >
    <div class="flex items-center gap-2">
      <CollapsibleTrigger
        class="inline-flex items-center gap-1.75 self-start rounded-full py-0.75 pr-2.25 pl-1.75 text-xs text-(--d-muted) transition-colors enabled:hover:bg-(--d-hover) disabled:cursor-default"
        :disabled="!hasContent"
        data-testid="thinking-trigger"
      >
        <Brain
          class="size-3.25 text-(--d-info)"
          :class="isStreaming && 'animate-[d-pulse_1.2s_infinite]'"
          aria-hidden="true"
        />
        <span
          v-if="isStreaming"
          class="d-glint"
        >{{ t('thinking.thinking') }}<span
          class="d-glint-window text-(--d-text)"
          aria-hidden="true"
        ><span>{{ t('thinking.thinking') }}</span></span></span>
        <span v-else>{{ t('thinking.thought') }}</span>
        <span
          v-if="isStreaming || displaySeconds > 0"
          class="tabular-nums text-(--d-faint)"
        >{{ displaySeconds }}s</span>
        <ChevronRight
          v-if="hasContent"
          class="size-3 transition-transform duration-200 ease-out"
          :class="isExpanded && 'rotate-90'"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <EffortBadge
        v-if="effort"
        :effort="effort"
      />
    </div>

    <CollapsibleContent>
      <div
        v-if="hasContent"
        ref="contentScroll"
        class="thinking-content mt-1.5 mb-0.5 ml-3.5 max-h-64 overflow-y-auto border-l-2 border-(--d-border2) py-1 pl-3.5 text-12.5 text-(--d-muted) italic"
      >
        <MarkdownRenderer :content="(isStreaming ? displayedContent : thinking) ?? ''" />
      </div>
    </CollapsibleContent>
  </Collapsible>
</template>

<style scoped>
.thinking-content :deep(.markdown-renderer) {
  color: var(--d-muted);
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
