import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useQuestionStore } from '../useQuestionStore';
import type { Question, PendingQuestionInfo } from '@shared/types/permissions';

const opt = (label: string, preview?: string) => ({ label, description: `${label} desc`, ...(preview && { preview }) });

const singleSelectQuestion = (overrides: Partial<Question> = {}): Question => ({
  question: 'Which one?',
  header: 'Q1',
  multiSelect: false,
  options: [opt('A'), opt('B'), opt('C', '<b>preview-c</b>')],
  ...overrides,
});

const multiSelectQuestion = (overrides: Partial<Question> = {}): Question => ({
  question: 'Which features?',
  header: 'Q2',
  multiSelect: true,
  options: [opt('X', '<i>preview-x</i>'), opt('Y'), opt('Z')],
  ...overrides,
});

const pending = (questions: Question[]): PendingQuestionInfo => ({
  toolUseId: 'test-id',
  questions,
});

describe('useQuestionStore.compiledAnswers', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('joins multi-select selections with ", " (matches review display)', () => {
    const store = useQuestionStore();
    const q = multiSelectQuestion();
    store.setQuestion(pending([q]));
    store.toggleOption(q.question, 'X', true);
    store.toggleOption(q.question, 'Z', true);
    expect(store.compiledAnswers[q.question]).toBe('X, Z');
  });

  it('single-select returns the one selected label without separator overhead', () => {
    const store = useQuestionStore();
    const q = singleSelectQuestion();
    store.setQuestion(pending([q]));
    store.toggleOption(q.question, 'B', false);
    expect(store.compiledAnswers[q.question]).toBe('B');
  });

  it('appends custom input alongside selections', () => {
    const store = useQuestionStore();
    const q = multiSelectQuestion();
    store.setQuestion(pending([q]));
    store.toggleOption(q.question, 'Y', true);
    store.setCustomInput(q.question, 'something else', true);
    expect(store.compiledAnswers[q.question]).toBe('Y, something else');
  });

  it('serialization separator matches the review-tab display separator', () => {
    const store = useQuestionStore();
    const q = multiSelectQuestion();
    store.setQuestion(pending([q]));
    store.toggleOption(q.question, 'X', true);
    store.toggleOption(q.question, 'Y', true);
    const submitted = store.compiledAnswers[q.question];
    const displayed = ['X', 'Y'].join(', ');
    expect(submitted).toBe(displayed);
  });
});

describe('useQuestionStore.compiledAnnotations', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('emits preview for single-select selected option', () => {
    const store = useQuestionStore();
    const q = singleSelectQuestion();
    store.setQuestion(pending([q]));
    store.toggleOption(q.question, 'C', false);
    expect(store.compiledAnnotations).toEqual({
      [q.question]: { preview: '<b>preview-c</b>' },
    });
  });

  it('omits preview for multi-select even when selected options have previews', () => {
    const store = useQuestionStore();
    const q = multiSelectQuestion();
    store.setQuestion(pending([q]));
    store.toggleOption(q.question, 'X', true);
    expect(store.compiledAnnotations).toBeUndefined();
  });

  it('emits notes when user adds them, regardless of selection', () => {
    const store = useQuestionStore();
    const q = singleSelectQuestion();
    store.setQuestion(pending([q]));
    store.toggleOption(q.question, 'A', false);
    store.setAnnotationNotes(q.question, 'extra context');
    expect(store.compiledAnnotations).toEqual({
      [q.question]: { notes: 'extra context' },
    });
  });

  it('combines preview and notes for single-select', () => {
    const store = useQuestionStore();
    const q = singleSelectQuestion();
    store.setQuestion(pending([q]));
    store.toggleOption(q.question, 'C', false);
    store.setAnnotationNotes(q.question, 'note');
    expect(store.compiledAnnotations).toEqual({
      [q.question]: { preview: '<b>preview-c</b>', notes: 'note' },
    });
  });

  it('returns undefined when no questions have annotations', () => {
    const store = useQuestionStore();
    const q = singleSelectQuestion();
    store.setQuestion(pending([q]));
    store.toggleOption(q.question, 'A', false);
    expect(store.compiledAnnotations).toBeUndefined();
  });
});
