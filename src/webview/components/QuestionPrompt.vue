<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import DOMPurify from 'dompurify';
import { ListboxRoot, ListboxItem, ListboxContent } from 'reka-ui';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { IconEye } from '@/components/icons';
import { useQuestionStore } from '@/stores/useQuestionStore';
import type { Question, QuestionAnnotations } from '@shared/types/permissions';

const { t } = useI18n();

const props = defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: 'submit', answers: Record<string, string>, annotations?: QuestionAnnotations): void;
  (e: 'cancel'): void;
}>();

const store = useQuestionStore();
const listboxRef = ref<InstanceType<typeof ListboxRoot> | null>(null);
const textareaRef = ref<{ $el?: HTMLElement } | null>(null);
const customInputValue = ref('');
const previewingOptionLabel = ref<string | null>(null);

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
  return DOMPurify.sanitize(raw);
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
  return (selections && selections.size > 0) || (customInput && customInput.trim().length > 0);
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
  nextTick(() => {
    (listboxRef.value?.$el as HTMLElement)?.focus();
  });
}

function handleCustomInputBack() {
  customInputValue.value = '';
  store.exitCustomInputMode();
  nextTick(() => {
    (listboxRef.value?.$el as HTMLElement)?.focus();
  });
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

watch(() => props.visible, (visible) => {
  if (visible) {
    nextTick(() => {
      (listboxRef.value?.$el as HTMLElement)?.focus();
    });
  }
});

watch(() => store.currentTabIndex, () => {
  previewingOptionLabel.value = null;
  if (!isOnSubmitTab.value && !isCustomInputMode.value) {
    nextTick(() => {
      (listboxRef.value?.$el as HTMLElement)?.focus();
    });
  }
});
</script>

<template>
  <div
    v-if="visible && store.pendingQuestion"
    class="border-t border-border bg-background"
    role="region"
    aria-label="Question prompt"
  >
    <!-- Header with agent badge -->
    <div v-if="hasAgentDescription" class="px-4 pt-2 flex items-center gap-2">
      <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-primary/20 text-primary border border-border">
        <span class="text-primary">🤖</span>
        {{ agentDescription }}
      </span>
    </div>

    <!-- Tab navigation -->
    <div class="px-4 pt-2 pb-1 flex flex-wrap gap-1.5">
      <button
        v-for="tab in tabHeaders"
        :key="tab.index"
        type="button"
        class="px-2.5 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer"
        :class="[
          store.currentTabIndex === tab.index
            ? 'bg-primary text-primary-foreground'
            : tab.isComplete
              ? 'bg-card text-foreground border border-primary/50'
              : 'bg-card text-muted-foreground border border-border hover:border-primary/30'
        ]"
        @click="handleTabClick(tab.index)"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- Question content (not on submit tab) -->
    <template v-if="!isOnSubmitTab && currentQuestion">
      <!-- Question text -->
      <div class="px-4 py-3 text-sm text-foreground">
        {{ currentQuestion.question }}
      </div>

      <!-- Options list -->
      <template v-if="!isCustomInputMode">
        <ListboxRoot
          ref="listboxRef"
          class="flex flex-col outline-none"
          orientation="vertical"
        >
          <ListboxContent>
            <ListboxItem
              v-for="option in currentQuestion.options"
              :key="option.label"
              :value="option.label"
              class="flex items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors cursor-pointer outline-none data-highlighted:bg-primary data-highlighted:text-primary-foreground hover:bg-card text-foreground"
              @select="handleOptionSelect(option.label)"
            >
              <!-- Selection indicator -->
              <span class="shrink-0 w-4 h-4 flex items-center justify-center">
                <template v-if="isMultiSelect">
                  <!-- Checkbox indicator -->
                  <span
                    class="w-3.5 h-3.5 rounded border flex items-center justify-center text-xs"
                    :class="isOptionSelected(option.label)
                      ? 'bg-primary border-primary text-primary-foreground'
                      : 'border-muted-foreground/50'"
                  >
                    <span v-if="isOptionSelected(option.label)">✓</span>
                  </span>
                </template>
                <template v-else>
                  <!-- Radio indicator -->
                  <span
                    class="w-3.5 h-3.5 rounded-full border flex items-center justify-center"
                    :class="isOptionSelected(option.label)
                      ? 'border-primary'
                      : 'border-muted-foreground/50'"
                  >
                    <span
                      v-if="isOptionSelected(option.label)"
                      class="w-2 h-2 rounded-full bg-primary"
                    />
                  </span>
                </template>
              </span>

              <!-- Option content -->
              <span class="flex-1 min-w-0">
                <span class="block">{{ option.label }}</span>
                <span v-if="option.description" class="block text-xs text-muted-foreground mt-0.5">
                  {{ option.description }}
                </span>
              </span>

              <!-- Preview toggle -->
              <button
                v-if="option.preview"
                type="button"
                class="shrink-0 p-1 rounded transition-colors hover:bg-primary/20 cursor-pointer"
                :class="previewingOptionLabel === option.label ? 'text-primary' : 'text-muted-foreground'"
                :title="previewingOptionLabel === option.label ? t('question.hidePreview') : t('question.showPreview')"
                @click.stop.prevent="togglePreview(option.label)"
              >
                <IconEye :size="14" />
              </button>
            </ListboxItem>

            <!-- Custom input option -->
            <ListboxItem
              value="__custom__"
              class="flex items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors cursor-pointer outline-none data-highlighted:bg-primary data-highlighted:text-primary-foreground hover:bg-card border-t border-border/30"
              :class="hasCustomInput ? 'text-foreground' : 'text-muted-foreground'"
              @select="handleCustomInputClick"
            >
              <!-- Show checkmark when custom input is saved -->
              <span class="shrink-0 w-4 h-4 flex items-center justify-center">
                <span
                  v-if="hasCustomInput"
                  class="w-3.5 h-3.5 rounded border flex items-center justify-center text-xs bg-primary border-primary text-primary-foreground"
                >✓</span>
                <span v-else class="w-3.5 h-3.5" />
              </span>
              <span class="flex-1 min-w-0">
                <template v-if="hasCustomInput">
                  <span class="block text-primary">{{ t('question.customResponse') }}</span>
                  <span class="block text-xs text-muted-foreground mt-0.5 truncate">{{ customInputPreview }}</span>
                </template>
                <template v-else>
                  <span>{{ t('question.customPlaceholder') }}</span>
                </template>
              </span>
            </ListboxItem>

            <!-- Next/Submit action for multi-select -->
            <ListboxItem
              v-if="isMultiSelect"
              value="__next__"
              class="flex items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors cursor-pointer outline-none data-highlighted:bg-primary data-highlighted:text-primary-foreground hover:bg-card border-t border-border/30 text-primary font-medium"
              @select="handleNextOrSubmit"
            >
              <span class="w-4 h-4" />
              <span>{{ isLastQuestionTab ? t('question.reviewAnswers') : t('question.nextQuestion') }}</span>
            </ListboxItem>
          </ListboxContent>
        </ListboxRoot>

        <!-- Preview pane for toggled option -->
        <div
          v-if="activePreview"
          class="mx-4 mb-3 p-3 rounded border border-border bg-card text-sm overflow-auto max-h-48"
          v-html="activePreview"
        />
      </template>

      <!-- Custom input mode -->
      <div v-else class="px-4 pb-4">
        <Textarea
          ref="textareaRef"
          v-model="customInputValue"
          class="min-h-20 bg-card border-border resize-none focus:border-primary mb-3 max-h-32"
          :placeholder="t('question.customTextareaPlaceholder')"
          @keydown="handleCustomInputKeydown"
        />
        <div class="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            @click="handleCustomInputBack"
          >
            {{ t('common.back') }}
          </Button>
          <Button
            size="sm"
            @click="handleCustomInputSave"
          >
            {{ t('common.save') }}
          </Button>
        </div>
      </div>
    </template>

    <!-- Submit tab - review answers -->
    <template v-else-if="isOnSubmitTab">
      <div class="px-4 py-3 text-sm text-foreground font-medium">
        {{ t('question.reviewHeading') }}
      </div>

      <div class="px-4 pb-3 space-y-2">
        <div
          v-for="question in store.questions"
          :key="question.question"
          class="p-2 rounded bg-card text-sm"
        >
          <div class="text-muted-foreground text-xs mb-1">{{ question.header || t('question.questionHeader') }}</div>
          <div class="text-foreground max-h-24 overflow-y-auto whitespace-pre-wrap break-words">{{ getAnswerSummary(question) }}</div>
          <Textarea
            class="mt-2 min-h-8 h-8 bg-background border-border resize-none text-xs"
            :placeholder="t('question.notesPlaceholder')"
            :model-value="store.annotationNotes.get(question.question) ?? ''"
            @update:model-value="(v: string) => store.setAnnotationNotes(question.question, v)"
          />
        </div>
      </div>

      <div class="px-4 pb-4 flex justify-end gap-2 border-t border-border/30 pt-3">
        <Button
          variant="ghost"
          size="sm"
          @click="handleCancel"
        >
          {{ t('common.cancel') }}
        </Button>
        <Button
          size="sm"
          :disabled="!allAnswered"
          @click="handleSubmit"
        >
          {{ t('common.submit') }}
        </Button>
      </div>
    </template>

  </div>
</template>
