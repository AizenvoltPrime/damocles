<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { VirtualItem } from '@/composables/useVirtualizedMessages';
import type { SubagentState } from '@shared/types/subagents';
import type { ImageBlock } from '@shared/types/content';
import type { ChatMessage } from '@shared/types/session';
import type { ExpandedDiff } from '@/stores/useDiffStore';
import UserMessageBlock from './UserMessageBlock.vue';
import ToolCallRouter from './ToolCallRouter.vue';
import ThinkingIndicator from './ThinkingIndicator.vue';
import MessageContent from './MessageContent.vue';
import CompactMarker from './CompactMarker.vue';
import RefusalCard from './RefusalCard.vue';

const { t } = useI18n();

const props = defineProps<{
  item: VirtualItem;
  top: number;
  isNew: boolean;
  canRewind: boolean;
  promptIndex: number;
  subagents?: Record<string, SubagentState>;
  isPinnedInSticky?: boolean;
  userMessageExpanded?: boolean;
}>();

const emit = defineEmits<{
  (e: 'rewind', message: ChatMessage): void;
  (e: 'rewindToCompaction', entryId: string): void;
  (e: 'expandSubagent', subagentId: string): void;
  (e: 'expandTool', toolId: string): void;
  (e: 'expandDiff', diff: ExpandedDiff): void;
  (e: 'viewContext', promptIndex: number): void;
  (e: 'openLightbox', block: ImageBlock): void;
  (e: 'toggleUserMessageExpanded'): void;
  (e: 'mounted', el: HTMLElement): void;
  (e: 'unmounted'): void;
}>();

const wrapperRef = ref<HTMLElement | null>(null);

const userMessageId = computed<string | null>(() => {
  if (props.item.type !== 'user-message') return null;
  return props.item.message.id;
});

const animationClass = computed(() => {
  if (!props.isNew) return '';
  if (props.item.isStreaming) return 'animate-fade-in';
  return 'animate-message-enter';
});

const wrapperClass = computed(() => {
  const base = props.item.type === 'user-message' ? 'absolute w-full' : 'absolute w-full px-4';
  return props.isPinnedInSticky ? `${base} invisible` : base;
});

onMounted(() => {
  if (wrapperRef.value) emit('mounted', wrapperRef.value);
});

onUnmounted(() => {
  emit('unmounted');
});
</script>

<template>
  <div
    ref="wrapperRef"
    :class="[wrapperClass, animationClass]"
    :style="{ top: `${top}px` }"
    :data-index="item.originalMessageIndex"
    :data-type="item.type"
    :data-message-id="userMessageId ?? undefined"
  >
    <UserMessageBlock
      v-if="item.type === 'user-message'"
      mode="canvas"
      :message="item.message"
      :message-index="item.originalMessageIndex"
      :can-rewind="canRewind"
      :prompt-index="promptIndex"
      :expanded="userMessageExpanded"
      @rewind="(msg: ChatMessage) => emit('rewind', msg)"
      @view-context="emit('viewContext', $event)"
      @open-lightbox="emit('openLightbox', $event)"
      @toggle-expanded="emit('toggleUserMessageExpanded')"
    />

    <div v-else-if="item.type === 'compact-marker' && item.marker">
      <CompactMarker :marker="item.marker" @rewind-to-compaction="(entryId: string) => emit('rewindToCompaction', entryId)" />
    </div>

    <ThinkingIndicator
      v-else-if="item.type === 'thinking-block'"
      :thinking="item.message.thinking || item.message.thinkingContent"
      :is-streaming="item.message.isThinkingPhase"
      :duration="item.message.thinkingDuration"
    />

    <div v-else-if="item.type === 'text-block'" class="pl-4">
      <MessageContent :content="item.text ?? ''" :is-streaming="false" :is-thinking-phase="false" />
    </div>

    <div v-else-if="item.type === 'streaming-text'" class="pl-4">
      <MessageContent :content="item.text ?? ''" :is-streaming="true" :is-thinking-phase="item.message.isThinkingPhase ?? false" />
    </div>

    <div v-else-if="item.type === 'tool-call' && item.toolCall" class="pl-4">
      <ToolCallRouter
        :tool-call="item.toolCall"
        :tool-use-id="item.toolCall.id"
        :tool-name="item.toolCall.name"
        :message="item.message"
        :subagents="subagents"
        @expand-tool="emit('expandTool', $event)"
        @expand-diff="emit('expandDiff', $event)"
        @expand-subagent="emit('expandSubagent', $event)"
      />
    </div>

    <div v-else-if="item.type === 'error-message'" class="pl-4 text-error">
      {{ t('common.error') }}: {{ item.text }}
    </div>

    <RefusalCard
      v-else-if="item.type === 'refusal-message'"
      :explanation="item.message.refusalExplanation ?? null"
      :category="item.message.refusalCategory ?? null"
    />

    <div v-else-if="item.type === 'background-label'" class="pl-4 flex items-center gap-2 mb-1">
      <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-500/15 text-blue-400 ring-1 ring-blue-500/25">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/></svg>
        {{ item.text || t('backgroundTask.taskResult') }}
      </span>
    </div>
  </div>
</template>
