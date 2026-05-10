import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { PendingQuestionInfo, Question, QuestionAnnotations } from '@shared/types/permissions';

export const useQuestionStore = defineStore('question', () => {
  const pendingQuestion = ref<PendingQuestionInfo | null>(null);
  const currentTabIndex = ref(0);
  const selectedOptions = ref<Map<string, Set<string>>>(new Map());
  const customInputs = ref<Map<string, string>>(new Map());
  const isCustomInputMode = ref(false);
  const annotationNotes = ref<Map<string, string>>(new Map());

  const questions = computed(() => pendingQuestion.value?.questions ?? []);

  const totalTabs = computed(() => questions.value.length + 1);

  const isOnSubmitTab = computed(() => currentTabIndex.value >= questions.value.length);

  const currentQuestion = computed<Question | null>(() => {
    if (isOnSubmitTab.value) return null;
    return questions.value[currentTabIndex.value] ?? null;
  });

  const currentSelections = computed(() => {
    const q = currentQuestion.value;
    if (!q) return new Set<string>();
    return selectedOptions.value.get(q.question) ?? new Set();
  });

  const currentCustomInput = computed(() => {
    const q = currentQuestion.value;
    if (!q) return '';
    return customInputs.value.get(q.question) ?? '';
  });

  const allAnswered = computed(() => {
    for (const q of questions.value) {
      const selections = selectedOptions.value.get(q.question);
      const customInput = customInputs.value.get(q.question);
      const hasSelection = selections && selections.size > 0;
      const hasCustom = customInput && customInput.trim().length > 0;
      if (!hasSelection && !hasCustom) return false;
    }
    return true;
  });

  const compiledAnswers = computed<Record<string, string>>(() => {
    const result: Record<string, string> = {};
    for (const q of questions.value) {
      const selections = selectedOptions.value.get(q.question) ?? new Set();
      const customInput = customInputs.value.get(q.question) ?? '';

      const parts: string[] = [...selections];
      if (customInput.trim()) {
        parts.push(customInput.trim());
      }

      result[q.question] = parts.join(', ');
    }
    return result;
  });

  const compiledAnnotations = computed<QuestionAnnotations | undefined>(() => {
    const result: QuestionAnnotations = {};
    let hasEntries = false;
    for (const q of questions.value) {
      const selections = selectedOptions.value.get(q.question) ?? new Set();
      const notes = annotationNotes.value.get(q.question);
      const selectedPreview = !q.multiSelect
        ? q.options.find(o => selections.has(o.label) && o.preview)?.preview
        : undefined;
      if (selectedPreview || notes?.trim()) {
        result[q.question] = {
          ...(selectedPreview && { preview: selectedPreview }),
          ...(notes?.trim() && { notes: notes.trim() }),
        };
        hasEntries = true;
      }
    }
    return hasEntries ? result : undefined;
  });

  function setAnnotationNotes(questionText: string, notes: string) {
    annotationNotes.value = new Map(annotationNotes.value).set(questionText, notes);
  }

  function setQuestion(info: PendingQuestionInfo) {
    pendingQuestion.value = info;
    currentTabIndex.value = 0;
    selectedOptions.value = new Map();
    customInputs.value = new Map();
    annotationNotes.value = new Map();
    isCustomInputMode.value = false;
  }

  function clearQuestion() {
    pendingQuestion.value = null;
    currentTabIndex.value = 0;
    selectedOptions.value = new Map();
    customInputs.value = new Map();
    annotationNotes.value = new Map();
    isCustomInputMode.value = false;
  }

  function goToTab(index: number) {
    if (index >= 0 && index < totalTabs.value) {
      currentTabIndex.value = index;
      isCustomInputMode.value = false;
    }
  }

  function nextTab() {
    if (currentTabIndex.value < totalTabs.value - 1) {
      currentTabIndex.value++;
      isCustomInputMode.value = false;
    }
  }

  function prevTab() {
    if (currentTabIndex.value > 0) {
      currentTabIndex.value--;
      isCustomInputMode.value = false;
    }
  }

  function toggleOption(questionText: string, optionLabel: string, isMultiSelect: boolean) {
    const current = selectedOptions.value.get(questionText) ?? new Set();

    if (isMultiSelect) {
      const newSet = new Set(current);
      if (newSet.has(optionLabel)) {
        newSet.delete(optionLabel);
      } else {
        newSet.add(optionLabel);
      }
      selectedOptions.value = new Map(selectedOptions.value).set(questionText, newSet);
    } else {
      const newSet = new Set([optionLabel]);
      selectedOptions.value = new Map(selectedOptions.value).set(questionText, newSet);
      customInputs.value = new Map(customInputs.value).set(questionText, '');
      if (!isOnSubmitTab.value) {
        const isLastQuestion = currentTabIndex.value === questions.value.length - 1;
        if (!isLastQuestion || allAnswered.value) {
          nextTab();
        }
      }
    }
  }

  function setCustomInput(questionText: string, value: string, isMultiSelect: boolean) {
    customInputs.value = new Map(customInputs.value).set(questionText, value);
    if (!isMultiSelect && value.trim()) {
      selectedOptions.value = new Map(selectedOptions.value).set(questionText, new Set());
    }
  }

  function enterCustomInputMode() {
    isCustomInputMode.value = true;
  }

  function exitCustomInputMode() {
    isCustomInputMode.value = false;
  }

  function $reset() {
    clearQuestion();
  }

  return {
    pendingQuestion,
    currentTabIndex,
    selectedOptions,
    customInputs,
    isCustomInputMode,
    questions,
    totalTabs,
    isOnSubmitTab,
    currentQuestion,
    currentSelections,
    currentCustomInput,
    allAnswered,
    compiledAnswers,
    annotationNotes,
    compiledAnnotations,
    setAnnotationNotes,
    setQuestion,
    clearQuestion,
    goToTab,
    nextTab,
    prevTab,
    toggleOption,
    setCustomInput,
    enterCustomInputMode,
    exitCustomInputMode,
    $reset,
  };
});
