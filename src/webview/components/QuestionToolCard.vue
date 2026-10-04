<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall } from '@shared/types/session';
import type { PersistedQuestion } from '@shared/types/permissions';

import { Ban, CircleCheck, CircleQuestionMark, CircleX } from 'lucide-vue-next';
import ToolCardFrame from './ToolCardFrame.vue';
import ToolCardNote from './ToolCardNote.vue';

const { t } = useI18n();

const props = defineProps<{
  toolCall: ToolCall;
}>();

const parsedResult = computed(() => {
  if (!props.toolCall.result) return null;
  try {
    return JSON.parse(props.toolCall.result);
  } catch {
    return null;
  }
});

const questions = computed((): PersistedQuestion[] => {
  const input = props.toolCall.input;
  if ('questions' in input && Array.isArray(input.questions)) {
    return input.questions as PersistedQuestion[];
  }
  const result = parsedResult.value;
  if (result && 'questions' in result && Array.isArray(result.questions)) {
    return result.questions as PersistedQuestion[];
  }
  return [];
});

const answers = computed((): Record<string, string> | null => {
  const result = parsedResult.value;
  if (result && typeof result === 'object' && 'answers' in result) {
    return result.answers as Record<string, string>;
  }
  return null;
});

const isAwaitingApproval = computed(() => props.toolCall.status === 'awaiting_approval');
const isCompleted = computed(() => props.toolCall.status === 'completed');
const isDenied = computed(() => props.toolCall.status === 'denied');
const isAbandoned = computed(() => props.toolCall.status === 'abandoned');

const headerText = computed(() => {
  const count = questions.value.length;
  if (count === 0) return t('questionTool.askingQuestion');
  if (count === 1) return t('questionTool.hasQuestion');
  return t('questionTool.hasQuestions', { n: count });
});

function getAnswerForQuestion(question: PersistedQuestion): string | null {
  if (!answers.value) return null;
  return answers.value[question.question] ?? null;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}
</script>

<template>
  <ToolCardFrame
    :icon="CircleQuestionMark"
    :name="headerText"
    :status="toolCall.status"
    data-testid="question-tool-card"
  >
    <div
      v-for="(question, idx) in questions"
      :key="idx"
      class="flex flex-col gap-1.5 border-t border-(--d-border) px-3 py-2"
    >
      <span
        v-if="question.header"
        class="self-start rounded-5 bg-(--d-hover) px-1.5 py-px text-10.5 font-medium text-(--d-muted)"
      >{{ question.header }}</span>
      <p class="text-12.5 text-(--d-text) text-pretty">
        {{ truncateText(question.question, 100) }}
      </p>
      <div
        v-if="isAwaitingApproval && question.options.length > 0"
        class="flex flex-wrap gap-1"
      >
        <span
          v-for="option in question.options.slice(0, 3)"
          :key="option.label"
          class="rounded-full border border-(--d-border2) px-2 text-11/4.5 text-(--d-muted)"
        >{{ truncateText(option.label, 20) }}</span>
        <span
          v-if="question.options.length > 3"
          class="px-1 text-11/4.5 text-(--d-faint)"
        >{{ t('questionTool.moreOptions', { n: question.options.length - 3 }) }}</span>
      </div>
      <div
        v-else-if="isCompleted && getAnswerForQuestion(question)"
        class="flex items-start gap-1.5 text-xs text-(--d-success)"
      >
        <CircleCheck
          class="size-3 mt-0.5 flex-none"
          aria-hidden="true"
        />
        <span>{{ truncateText(getAnswerForQuestion(question) || '', 60) }}</span>
      </div>
    </div>
    <ToolCardNote
      v-if="isAwaitingApproval"
      tone="text-(--d-warning)"
      waiting
      :text="t('questionTool.waitingResponse')"
    />
    <ToolCardNote
      v-else-if="isDenied"
      tone="text-(--d-danger)"
      :icon="CircleX"
      :text="t('questionTool.cancelled')"
    />
    <ToolCardNote
      v-else-if="isAbandoned"
      tone="text-(--d-muted)"
      :icon="Ban"
      :text="t('questionTool.movedOn')"
    />
  </ToolCardFrame>
</template>
