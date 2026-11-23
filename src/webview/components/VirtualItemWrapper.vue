<script setup lang="ts">
import { onMounted, onUnmounted, provide, ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleAlert, Loader } from 'lucide-vue-next';
import type { VirtualItem } from '@/composables/useVirtualizedMessages';
import type { SubagentState } from '@shared/types/subagents';
import type { ImageBlock } from '@shared/types/content';
import type { ChatMessage } from '@shared/types/session';
import UserMessageBlock from './UserMessageBlock.vue';
import ToolCallRouter from './ToolCallRouter.vue';
import ThinkingIndicator from './ThinkingIndicator.vue';
import MessageContent from './MessageContent.vue';
import CompactMarker from './CompactMarker.vue';
import CacheMissNotice from './CacheMissNotice.vue';
import CompactionAbortedNotice from './CompactionAbortedNotice.vue';
import ThinkingDroppedNotice from './ThinkingDroppedNotice.vue';
import RefusalCard from './RefusalCard.vue';
import TranscriptNotice from './TranscriptNotice.vue';
import EffortBadge from './EffortBadge.vue';
import ErrorMessageText from './ErrorMessageText.vue';
import AuthFailureNotice from './AuthFailureNotice.vue';
import ForgeRefusedNotice from './ForgeRefusedNotice.vue';
import DesignResultCard from './design/DesignResultCard.vue';
import DesignBriefNote from './design/DesignBriefNote.vue';
import { errorRowText } from '@/composables/useLocalizedText';
import { useForgeRefusalStore } from '@/stores/useForgeRefusalStore';
import { IN_TRANSCRIPT } from '@/composables/transcript-scope';

const { t } = useI18n();

const props = defineProps<{
  item: VirtualItem;
  top: number;
  /** True only briefly after the row arrived live; never true for a row mounted by scrolling or replayed history. */
  arriving: boolean;
  canRewind: boolean;
  promptIndex: number;
  subagents?: Record<string, SubagentState> | undefined;
  isPinnedInSticky?: boolean | undefined;
  userMessageExpanded?: boolean | undefined;
}>();

const emit = defineEmits<{
  (e: 'rewind', message: ChatMessage): void;
  (e: 'rewindToCompaction', entryId: string): void;
  (e: 'expandSubagent', subagentId: string): void;
  (e: 'viewContext', promptIndex: number): void;
  (e: 'openLightbox', image: string | ImageBlock): void;
  (e: 'toggleUserMessageExpanded'): void;
  (e: 'mounted', el: HTMLElement): void;
  (e: 'unmounted'): void;
}>();

provide(IN_TRANSCRIPT, true);

const wrapperRef = ref<HTMLElement | null>(null);

const forgeRefusals = useForgeRefusalStore();
const forgeRefusal = computed(() => (props.item.type === 'tool-call' && props.item.toolCall ? forgeRefusals.refusals.get(props.item.toolCall.id) : undefined));

const userMessageId = computed<string | null>(() => {
  if (props.item.type !== 'user-message') return null;
  return props.item.message.id;
});

const animationClass = computed(() => {
  if (!props.arriving) return '';
  return props.item.isStreaming ? 'd-fade-in' : 'd-arrive';
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
    :class="['chat-column absolute inset-x-0', animationClass, isPinnedInSticky && 'invisible']"
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

    <!-- Each content block is a transcript scope root (data-theme-scope), never this row or the list: a tool card that is
         trusted UI (ExitPlanModeToolCard) must have no scoped ancestor. -->
    <div
      v-else-if="item.type === 'compact-marker' && item.marker"
      data-theme-scope="transcript"
    >
      <CompactMarker
        :marker="item.marker"
        @rewind-to-compaction="(entryId: string) => emit('rewindToCompaction', entryId)"
      />
    </div>

    <div
      v-else-if="item.type === 'cache-miss-notice' && item.notice"
      data-theme-scope="transcript"
    >
      <CacheMissNotice :notice="item.notice" />
    </div>

    <div
      v-else-if="item.type === 'compaction-aborted-notice' && item.compactionAborted"
      data-theme-scope="transcript"
    >
      <CompactionAbortedNotice :notice="item.compactionAborted" />
    </div>

    <div
      v-else-if="item.type === 'thinking-dropped-notice' && item.thinkingDropped"
      data-theme-scope="transcript"
    >
      <ThinkingDroppedNotice :notice="item.thinkingDropped" />
    </div>

    <ThinkingIndicator
      v-else-if="item.type === 'thinking-block'"
      data-theme-scope="transcript"
      :thinking="item.message.thinking || item.message.thinkingContent"
      :is-streaming="item.message.isThinkingPhase"
      :duration="item.message.thinkingDuration"
      :effort="item.effort"
    />

    <div
      v-else-if="item.type === 'text-block'"
      data-theme-scope="transcript"
    >
      <EffortBadge
        v-if="item.effort"
        :effort="item.effort"
        class="mb-1"
      />
      <MessageContent
        :content="item.text ?? ''"
        :is-streaming="false"
        :is-thinking-phase="false"
      />
    </div>

    <div
      v-else-if="item.type === 'streaming-text'"
      data-theme-scope="transcript"
    >
      <EffortBadge
        v-if="item.effort"
        :effort="item.effort"
        class="mb-1"
      />
      <MessageContent
        :content="item.text ?? ''"
        :is-streaming="true"
        :is-thinking-phase="item.message.isThinkingPhase ?? false"
      />
    </div>

    <div v-else-if="item.type === 'tool-call' && item.toolCall">
      <ToolCallRouter
        :tool-call="item.toolCall"
        :tool-use-id="item.toolCall.id"
        :tool-name="item.toolCall.name"
        :message="item.message"
        :subagents="subagents"
        @expand-subagent="emit('expandSubagent', $event)"
        @open-lightbox="emit('openLightbox', $event)"
      />
      <ForgeRefusedNotice
        v-if="forgeRefusal"
        :refusal="forgeRefusal"
        data-theme-scope="transcript"
      />
    </div>

    <!-- A wrapper, not the card: theme CSS reaches only a root's descendants, and the card's frame is the card's own root.
         A root clips what it holds, so the padding is the room of the card's shadow; it overlaps the rows around it and takes no pointer. -->
    <div
      v-else-if="item.type === 'design-result' && item.designCard?.kind === 'result'"
      class="pointer-events-none -mx-3 -mt-2 -mb-6 px-3 pt-2 pb-6"
      data-theme-scope="transcript"
    >
      <DesignResultCard
        class="pointer-events-auto"
        :result="item.designCard.result"
        :entry-id="item.designCard.entryId"
      />
    </div>

    <DesignBriefNote
      v-else-if="item.type === 'design-brief' && item.designCard?.kind === 'brief'"
      :brief="item.designCard.brief"
      data-theme-scope="transcript"
    />

    <AuthFailureNotice
      v-else-if="item.type === 'error-message' && item.message.authFailure"
      :failure="item.message.authFailure"
      :details="errorRowText(item.message)"
      data-theme-scope="transcript"
    />

    <TranscriptNotice
      v-else-if="item.type === 'error-message'"
      data-theme-scope="transcript"
      tone="danger"
      :icon="CircleAlert"
      :title="t('common.error')"
    >
      <ErrorMessageText
        class="text-12.5 wrap-break-word whitespace-pre-wrap text-(--d-text)"
        :text="errorRowText(item.message)"
      />
    </TranscriptNotice>

    <RefusalCard
      v-else-if="item.type === 'refusal-message'"
      :explanation="item.message.refusalExplanation ?? null"
      :category="item.message.refusalCategory ?? null"
      data-theme-scope="transcript"
    />

    <div
      v-else-if="item.type === 'background-label'"
      class="mb-1 flex items-center gap-2"
      data-theme-scope="transcript"
    >
      <span class="inline-flex items-center gap-1.5 rounded-full bg-[color-mix(in_srgb,var(--d-info-fill)_14%,transparent)] px-2.5 py-1 text-xs font-medium text-(--d-info-text)">
        <Loader
          class="size-3"
          aria-hidden="true"
        />
        {{ item.text || t('backgroundTask.taskResult') }}
      </span>
    </div>
  </div>
</template>
