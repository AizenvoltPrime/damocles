<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { Bot, Check, ChevronRight, Eye, MessageCircleQuestion, MessageSquare, SendHorizontal } from 'lucide-vue-next';
import DOMPurify from 'dompurify';
import { ListboxRoot, ListboxItem } from 'reka-ui';
import DockPromptOptions from './DockPromptOptions.vue';
import { Textarea } from '@/components/ui/textarea';
import SlidingIndicator from './SlidingIndicator.vue';
import { useSlidingIndicator } from '@/composables/useSlidingIndicator';
import { useDockPromptDigits } from '@/composables/useDockPrompt';
import { useQuestionStore } from '@/stores/useQuestionStore';
import type { Question, QuestionAnnotations } from '@shared/types/permissions';

const { t } = useI18n();

defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: 'submit', answers: Record<string, string>, annotations?: QuestionAnnotations): void;
  (e: 'cancel'): void;
}>();

const store = useQuestionStore();
const textareaRef = ref<{ $el?: HTMLElement } | null>(null);
const customInputValue = ref('');
const previewingOptionLabel = ref<string | null>(null);
const cardRef = ref<HTMLElement | null>(null);
const tabRow = ref<HTMLElement | null>(null);
const { box: tabBox, animate: tabAnimate } = useSlidingIndicator(tabRow, '[data-question-tab]', () => store.currentTabIndex);

const hasAgentDescription = computed(() => !!store.pendingQuestion?.agentDescription);
const agentDescription = computed(() => store.pendingQuestion?.agentDescription ?? '');

const currentQuestion = computed(() => store.currentQuestion);
const isOnSubmitTab = computed(() => store.isOnSubmitTab);
const isCustomInputMode = computed(() => store.isCustomInputMode);
const allAnswered = computed(() => store.allAnswered);

const currentSelections = computed(() => store.currentSelections);
const currentCustomInput = computed(() => store.currentCustomInput);

const isMultiSelect = computed(() => currentQuestion.value?.multiSelect ?? false);

const activePreview = computed(() => {
  const q = currentQuestion.value;
  if (!q || !previewingOptionLabel.value) return null;
  const option = q.options.find(o => o.label === previewingOptionLabel.value);
  const raw = option?.preview;
  if (!raw) return null;
  // Model-written markup must not restyle or cover the panel, so it keeps no styles and none of the app's classes.
  return DOMPurify.sanitize(raw, { FORBID_TAGS: ['style'], FORBID_ATTR: ['style', 'class'] });
});

const hasCustomInput = computed(() => currentCustomInput.value.trim().length > 0);

const customInputPreview = computed(() => {
  const text = currentCustomInput.value.trim();
  if (text.length > 40) {
    return text.slice(0, 40) + '...';
  }
  return text;
});

const isLastQuestionTab = computed(() =>
  store.currentTabIndex === store.questions.length - 1
);

const tabHeaders = computed(() => {
  const headers = store.questions.map((q, idx) => ({
    index: idx,
    label: q.header || t('question.questionTab', { n: idx + 1 }),
    isComplete: hasAnswerFor(q),
  }));
  headers.push({
    index: store.questions.length,
    label: t('question.submitTab'),
    isComplete: false,
  });
  return headers;
});

function hasAnswerFor(question: Question): boolean {
  const selections = store.selectedOptions.get(question.question);
  const customInput = store.customInputs.get(question.question);
  return Boolean((selections && selections.size > 0) || (customInput && customInput.trim().length > 0));
}

function isOptionSelected(optionLabel: string): boolean {
  return currentSelections.value.has(optionLabel);
}

function togglePreview(optionLabel: string) {
  previewingOptionLabel.value = previewingOptionLabel.value === optionLabel ? null : optionLabel;
}

function handleTabClick(index: number) {
  previewingOptionLabel.value = null;
  store.goToTab(index);
}

function handleOptionSelect(optionLabel: string) {
  if (!currentQuestion.value) return;
  store.toggleOption(currentQuestion.value.question, optionLabel, isMultiSelect.value);
}

useDockPromptDigits(cardRef, (digit) => {
  const option = isOnSubmitTab.value || isCustomInputMode.value ? undefined : currentQuestion.value?.options[digit - 1];
  if (!option) return false;
  handleOptionSelect(option.label);
  return true;
});

function handleNextOrSubmit() {
  if (isLastQuestionTab.value) {
    store.goToTab(store.questions.length);
  } else {
    store.nextTab();
  }
}

function handleCustomInputClick() {
  customInputValue.value = currentCustomInput.value;
  store.enterCustomInputMode();
  nextTick(() => {
    textareaRef.value?.$el?.focus();
  });
}

function handleCustomInputKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleCustomInputSave();
  } else if (event.key === 'Escape') {
    handleCustomInputBack();
  }
}

function handleCustomInputSave() {
  if (!currentQuestion.value) return;
  store.setCustomInput(currentQuestion.value.question, customInputValue.value, isMultiSelect.value);
  store.exitCustomInputMode();
}

function handleCustomInputBack() {
  customInputValue.value = '';
  store.exitCustomInputMode();
}

function handleSubmit() {
  emit('submit', store.compiledAnswers, store.compiledAnnotations);
}

function handleCancel() {
  emit('cancel');
}

function getAnswerSummary(question: Question): string {
  const selections = store.selectedOptions.get(question.question) ?? new Set();
  const customInput = store.customInputs.get(question.question) ?? '';
  const parts = [...selections];
  if (customInput.trim()) {
    parts.push(customInput.trim());
  }
  return parts.join(', ') || t('question.noAnswer');
}

watch(() => store.currentTabIndex, () => {
  previewingOptionLabel.value = null;
});
</script>

<template>
  <div
    v-if="visible && store.pendingQuestion"
    ref="cardRef"
    class="overflow-hidden rounded-[0.875rem] border border-[color-mix(in_srgb,var(--d-accent)_45%,var(--d-border))] bg-(--d-card) text-(--d-text) shadow-(--d-shadow)"
    role="region"
    :aria-label="t('question.ariaLabel')"
    data-dock-prompt
    data-testid="question-card"
  >
    <header class="flex items-center gap-2.5 border-b border-(--d-border) bg-linear-to-b from-[color-mix(in_srgb,var(--d-accent)_10%,transparent)] to-transparent px-3 py-2">
      <span
        class="d-ring flex size-6.5 flex-none items-center justify-center rounded-lg bg-(--d-accent-soft) text-(--d-accent)"
        aria-hidden="true"
      >
        <MessageCircleQuestion class="size-3.5" />
      </span>
      <div class="min-w-0 flex-1 font-semibold">
        {{ t('question.title') }}
      </div>
      <span
        v-if="hasAgentDescription"
        class="flex min-w-0 items-center gap-1.5 truncate rounded-full bg-(--d-accent-soft) px-2 py-0.5 text-11 font-medium text-(--d-accent-text)"
      >
        <Bot
          class="size-3 flex-none"
          aria-hidden="true"
        />
        <span class="truncate">{{ agentDescription }}</span>
      </span>
    </header>

    <div
      ref="tabRow"
      class="relative flex flex-wrap gap-1.5 px-3 pt-2.5 pb-1"
    >
      <SlidingIndicator
        :box="tabBox"
        radius="pill"
        :animate="tabAnimate"
        class="text-(--d-accent)"
      />
      <button
        v-for="tab in tabHeaders"
        :key="tab.index"
        type="button"
        data-question-tab
        class="relative rounded-full border px-2.5 py-0.75 text-xs font-medium transition-colors duration-200"
        :class="[
          store.currentTabIndex === tab.index
            ? 'border-transparent text-(--d-on-accent)'
            : tab.isComplete
              ? 'border-[color-mix(in_srgb,var(--d-accent)_45%,var(--d-border))] text-(--d-text) hover:bg-(--d-hover)'
              : 'border-(--d-border) text-(--d-muted) hover:bg-(--d-hover)'
        ]"
        :aria-current="store.currentTabIndex === tab.index ? 'step' : undefined"
        @click="handleTabClick(tab.index)"
      >
        {{ tab.label }}
      </button>
    </div>

    <template v-if="!isOnSubmitTab && currentQuestion">
      <div class="px-3.5 pt-1.5 pb-1 text-13 font-medium text-pretty">
        {{ currentQuestion.question }}
      </div>

      <div
        v-if="!isCustomInputMode"
        class="px-1.5 pt-1 pb-1.5"
      >
        <!-- Keyed by question, so each question's options mount and take focus as dock prompt options do. -->
        <ListboxRoot
          :key="currentQuestion.question"
          class="flex flex-col outline-none"
          orientation="vertical"
        >
          <DockPromptOptions :aria-label="currentQuestion.question">
            <ListboxItem
              v-for="(option, index) in currentQuestion.options"
              :key="option.label"
              :value="option.label"
              class="group flex items-center gap-2.5 rounded-9 px-2.5 py-1.25 text-left transition-colors outline-none data-highlighted:bg-(--d-accent-soft) data-highlighted:text-(--d-accent-text)"
              @select="handleOptionSelect(option.label)"
            >
              <span
                class="flex size-5 flex-none items-center justify-center border font-mono text-11 transition-colors"
                :class="[
                  isMultiSelect ? 'rounded-md' : 'rounded-full',
                  isOptionSelected(option.label)
                    ? 'border-(--d-accent) bg-(--d-accent) text-(--d-on-accent)'
                    : 'border-(--d-border2) group-data-highlighted:border-(--d-accent)',
                ]"
                aria-hidden="true"
              >
                <Check
                  v-if="isOptionSelected(option.label)"
                  class="size-3"
                />
                <template v-else>
                  {{ index + 1 }}
                </template>
              </span>
              <span class="min-w-0 flex-1">
                <span class="block font-medium">{{ option.label }}</span>
                <span
                  v-if="option.description"
                  class="block text-xs text-pretty text-(--d-faint) group-data-highlighted:text-(--d-faint-text)"
                >
                  {{ option.description }}
                </span>
              </span>
              <button
                v-if="option.preview && !isMultiSelect"
                type="button"
                class="flex flex-none rounded-md p-1.25 transition-colors hover:bg-(--d-border2)"
                :class="previewingOptionLabel === option.label ? 'text-(--d-accent)' : 'text-(--d-muted)'"
                :title="previewingOptionLabel === option.label ? t('question.hidePreview') : t('question.showPreview')"
                :aria-label="previewingOptionLabel === option.label ? t('question.hidePreview') : t('question.showPreview')"
                :aria-pressed="previewingOptionLabel === option.label"
                @click.stop.prevent="togglePreview(option.label)"
              >
                <Eye
                  class="size-3.25"
                  aria-hidden="true"
                />
              </button>
            </ListboxItem>

            <ListboxItem
              value="__custom__"
              class="mx-1 mt-0.75 flex items-center gap-2 rounded-9 border border-(--d-border) bg-(--d-input) px-2.5 py-1.5 text-left transition-colors outline-none data-highlighted:border-(--d-accent)"
              @select="handleCustomInputClick"
            >
              <Check
                v-if="hasCustomInput"
                class="size-3.25 flex-none text-(--d-accent)"
                aria-hidden="true"
              />
              <MessageSquare
                v-else
                class="size-3.25 flex-none text-(--d-faint)"
                aria-hidden="true"
              />
              <span
                class="min-w-0 flex-1 truncate text-12.5"
                :class="hasCustomInput ? 'text-(--d-text)' : 'text-(--d-faint)'"
              >{{ hasCustomInput ? customInputPreview : t('question.customPlaceholder') }}</span>
              <span class="flex-none text-11 text-(--d-faint)">{{ t('question.otherLabel') }}</span>
            </ListboxItem>

            <ListboxItem
              v-if="isMultiSelect"
              value="__next__"
              class="mt-1 flex items-center justify-end gap-1.5 rounded-9 px-2.5 py-1.25 text-12.5 font-semibold text-(--d-accent) transition-colors outline-none data-highlighted:bg-(--d-accent-soft) data-highlighted:text-(--d-accent-text)"
              @select="handleNextOrSubmit"
            >
              {{ isLastQuestionTab ? t('question.reviewAnswers') : t('question.nextQuestion') }}
              <ChevronRight
                class="size-3.25"
                aria-hidden="true"
              />
            </ListboxItem>
          </DockPromptOptions>
        </ListboxRoot>

        <div
          v-if="activePreview"
          class="mx-1 mt-1.5 max-h-48 overflow-auto rounded-lg border border-(--d-border) bg-(--d-code) p-3 text-xs"
          data-testid="question-option-preview"
          v-html="activePreview"
        />
      </div>

      <div
        v-else
        class="flex flex-col gap-2 px-3 pt-1 pb-3"
      >
        <Textarea
          ref="textareaRef"
          v-model="customInputValue"
          class="max-h-32 min-h-20 resize-none rounded-10 border-(--d-border2) bg-(--d-input) text-12.5 focus:border-(--d-accent)"
          :placeholder="t('question.customTextareaPlaceholder')"
          @keydown="handleCustomInputKeydown"
        />
        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="d-press flex h-7.5 items-center rounded-9 px-3 text-12.5 transition-colors hover:bg-(--d-hover)"
            @click="handleCustomInputBack"
          >
            {{ t('common.back') }}
          </button>
          <button
            type="button"
            class="d-press flex h-7.5 items-center rounded-9 bg-(--d-accent) px-3.5 text-12.5 font-semibold text-(--d-on-accent) transition-[filter] hover:brightness-110"
            @click="handleCustomInputSave"
          >
            {{ t('common.save') }}
          </button>
        </div>
      </div>
    </template>

    <template v-else-if="isOnSubmitTab">
      <div class="px-3.5 pt-1.5 pb-2 text-13 font-medium">
        {{ t('question.reviewHeading') }}
      </div>

      <div class="flex flex-col gap-2 px-3 pb-3">
        <div
          v-for="question in store.questions"
          :key="question.question"
          class="rounded-10 border border-(--d-border) bg-(--d-bg) px-3 py-2"
        >
          <div class="mb-1 text-11 font-semibold tracking-[.06em] text-(--d-faint) uppercase">
            {{ question.header || t('question.questionHeader') }}
          </div>
          <div class="max-h-24 overflow-y-auto text-12.5 wrap-break-word whitespace-pre-wrap">
            {{ getAnswerSummary(question) }}
          </div>
          <Textarea
            class="mt-2 h-8 min-h-8 resize-none rounded-lg border-(--d-border) bg-(--d-input) text-xs"
            :placeholder="t('question.notesPlaceholder')"
            :model-value="store.annotationNotes.get(question.question) ?? ''"
            @update:model-value="(v) => store.setAnnotationNotes(question.question, String(v))"
          />
        </div>
      </div>

      <div class="flex justify-end gap-2 border-t border-(--d-border) bg-(--d-panel) px-3.5 py-2.5">
        <button
          type="button"
          class="d-press flex h-7.5 items-center rounded-9 border border-(--d-border2) px-3 text-12.5 transition-colors hover:bg-(--d-hover)"
          @click="handleCancel"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="d-press flex h-7.5 items-center gap-1.5 rounded-9 bg-(--d-accent) px-3.5 text-12.5 font-semibold text-(--d-on-accent) transition-[filter] hover:brightness-110 disabled:cursor-default disabled:opacity-40 disabled:hover:brightness-100"
          :disabled="!allAnswered"
          @click="handleSubmit"
        >
          <SendHorizontal
            class="size-3.25"
            aria-hidden="true"
          />
          {{ t('common.submit') }}
        </button>
      </div>
    </template>
  </div>
</template>
