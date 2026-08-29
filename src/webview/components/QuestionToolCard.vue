<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall } from '@shared/types/session';
import type { PersistedQuestion } from '@shared/types/permissions';

import { Card, CardHeader, CardContent } from '@/components/ui/card';
import {
  IconQuestionCircle,
  IconCheckCircle,
  IconXCircle,
  IconBan,
} from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import { useToolCardStatus } from '@/composables/useToolCardStatus';

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

const isPending = computed(() => props.toolCall.status === 'pending');
const isRunning = computed(() => props.toolCall.status === 'running');
const isAwaitingApproval = computed(() => props.toolCall.status === 'awaiting_approval');
const isCompleted = computed(() => props.toolCall.status === 'completed');
const isDenied = computed(() => props.toolCall.status === 'denied');
const isAbandoned = computed(() => props.toolCall.status === 'abandoned');

const { statusIcon, statusClass, cardClass } = useToolCardStatus(() => props.toolCall.status);

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
  <Card class="text-sm overflow-hidden" :class="cardClass">
    <CardHeader class="flex flex-row items-center gap-2 px-3 py-2 bg-primary/10 border-b border-border/50 space-y-0">
      <IconQuestionCircle :size="18" class="text-primary shrink-0" />
      <span class="text-foreground font-medium flex-1">{{ headerText }}</span>

      <LoadingSpinner v-if="isPending || isRunning || isAwaitingApproval" :size="16" :class="statusClass" class="shrink-0" />
      <component v-else-if="statusIcon" :is="statusIcon" :size="16" :class="statusClass" class="shrink-0" />
    </CardHeader>

    <CardContent class="p-0">
      <!-- Questions list -->
      <div class="divide-y divide-border/30">
        <div
          v-for="(question, idx) in questions"
          :key="idx"
          class="px-3 py-2"
        >
          <!-- Question header badge -->
          <div v-if="question.header" class="mb-1">
            <span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">
              {{ question.header }}
            </span>
          </div>

          <!-- Question text -->
          <div class="text-xs text-foreground/90 mb-1.5">
            {{ truncateText(question.question, 100) }}
          </div>

          <!-- Options preview (when awaiting) -->
          <div v-if="isAwaitingApproval && question.options.length > 0" class="flex flex-wrap gap-1">
            <span
              v-for="option in question.options.slice(0, 3)"
              :key="option.label"
              class="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-card border border-border/50 text-muted-foreground"
            >
              {{ truncateText(option.label, 20) }}
            </span>
            <span
              v-if="question.options.length > 3"
              class="inline-flex items-center px-1.5 py-0.5 text-xs text-muted-foreground"
            >
              {{ t('questionTool.moreOptions', { n: question.options.length - 3 }) }}
            </span>
          </div>

          <!-- Answer (when completed) -->
          <div v-else-if="isCompleted && getAnswerForQuestion(question)" class="flex items-start gap-1.5">
            <IconCheckCircle :size="12" class="text-success shrink-0 mt-0.5" />
            <span class="text-xs text-success/90">
              {{ truncateText(getAnswerForQuestion(question) || '', 60) }}
            </span>
          </div>
        </div>
      </div>

      <!-- Status messages -->
      <div v-if="isAwaitingApproval" class="px-3 py-2 bg-primary/10 border-t border-primary/20">
        <div class="flex items-center gap-2 text-xs text-primary">
          <span class="inline-block w-2 h-2 rounded-full bg-primary animate-pulse" />
          <span>{{ t('questionTool.waitingResponse') }}</span>
        </div>
      </div>

      <div v-else-if="isDenied" class="px-3 py-2 bg-error/10 border-t border-error/20">
        <div class="flex items-center gap-2 text-xs text-error/80">
          <IconXCircle :size="12" />
          <span>{{ t('questionTool.cancelled') }}</span>
        </div>
      </div>

      <div v-else-if="isAbandoned" class="px-3 py-2 bg-muted/30 border-t border-border/30">
        <div class="flex items-center gap-2 text-xs text-muted-foreground">
          <IconBan :size="12" />
          <span>{{ t('questionTool.movedOn') }}</span>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
