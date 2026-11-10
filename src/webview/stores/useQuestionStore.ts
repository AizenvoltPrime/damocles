import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { PendingQuestionInfo, Question, QuestionAnnotations } from '@shared/types/permissions';

export const useQuestionStore = defineStore('question', () => {
  const pendingQuestion = ref<PendingQuestionInfo | null>(null);
  // Questions raised while one is on screen, oldest first; core holds each open until it is answered, cancelled or closed.
  const queue = ref<PendingQuestionInfo[]>([]);
  const currentTabIndex = ref(0);
  const selectedOptions = ref<Map<string, Set<string>>>(new Map());
  const customInputs = ref<Map<string, string>>(new Map());
  const isCustomInputMode = ref(false);
  const annotationNotes = ref<Map<string, string>>(new Map());

  const questions = computed(() => pendingQuestion.value?.questions ?? []);

  /** How many questions the queued prompts hold, shown after the one on screen. */
  const waitingCount = computed(() => queue.value.reduce((count, info) => count + info.questions.length, 0));

  const totalTabs = computed(() => questions.value.length + 1);

  const isOnSubmitTab = computed(() => currentTabIndex.value >= questions.value.length);

  const currentQuestion = computed<Question | null>(() => {
    if (isOnSubmitTab.value) return null;
    return questions.value[currentTabIndex.value] ?? null;
  });

  const currentSelections = computed(() => {
    const q = currentQuestion.value;
    if (!q) return new Set<string>();
    return selectedOptions.value.get(q.question) ?? new Set<string>();
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
      // Copies: the desktop bridge structured-clones messages, which refuses the store's reactive proxy.
      const selectedPreviews = q.options.flatMap(o => (selections.has(o.label) && o.preview ? [[o.label, { ...o.preview }] as const] : []));
      const preview = q.multiSelect ? undefined : selectedPreviews[0]?.[1];
      const previews = q.multiSelect && selectedPreviews.length > 0 ? Object.fromEntries(selectedPreviews) : undefined;
      if (preview || previews || notes?.trim()) {
        result[q.question] = {
          ...(preview && { preview }),
          ...(previews && { previews }),
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

  function show(info: PendingQuestionInfo | null) {
    pendingQuestion.value = info;
    currentTabIndex.value = 0;
    selectedOptions.value = new Map();
    customInputs.value = new Map();
    annotationNotes.value = new Map();
    isCustomInputMode.value = false;
  }

  function setQuestion(info: PendingQuestionInfo) {
    // The extension re-posts every pending prompt when the webview reports ready, and the answer the
    // user has already typed for this same prompt outlives that replay.
    if (pendingQuestion.value?.toolUseId === info.toolUseId) {
      pendingQuestion.value = info;
      return;
    }
    if (queue.value.some((queued) => queued.toolUseId === info.toolUseId)) {
      queue.value = queue.value.map((queued) => (queued.toolUseId === info.toolUseId ? info : queued));
      return;
    }
    if (pendingQuestion.value) {
      queue.value = [...queue.value, info];
      return;
    }
    show(info);
  }

  /** The question on screen is settled: the next queued one takes its place. */
  function clearQuestion() {
    const [next, ...rest] = queue.value;
    queue.value = rest;
    show(next ?? null);
  }

  /**
   * Drops the questions core no longer holds open (`openIds`, from the session state), such as an aborted
   * agent's. Core publishes a question's id before it posts the question, so a question just raised is never dropped.
   */
  function dropClosed(openIds: ReadonlySet<string>) {
    queue.value = queue.value.filter((queued) => openIds.has(queued.toolUseId));
    if (pendingQuestion.value && !openIds.has(pendingQuestion.value.toolUseId)) clearQuestion();
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

  /** A single-select choice that stays on its tab: a design grid's radios check as the arrow keys move. */
  function chooseOption(questionText: string, optionLabel: string) {
    selectedOptions.value = new Map(selectedOptions.value).set(questionText, new Set([optionLabel]));
    customInputs.value = new Map(customInputs.value).set(questionText, '');
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
    queue.value = [];
    show(null);
  }

  return {
    pendingQuestion,
    queue,
    waitingCount,
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
    dropClosed,
    goToTab,
    nextTab,
    prevTab,
    toggleOption,
    chooseOption,
    setCustomInput,
    enterCustomInputMode,
    exitCustomInputMode,
    $reset,
  };
});
