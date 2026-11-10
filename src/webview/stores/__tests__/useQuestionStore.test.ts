import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useQuestionStore } from '../useQuestionStore';
import type { Question, PendingQuestionInfo } from '@shared/types/permissions';

const opt = (label: string, content?: string) => ({ label, description: `${label} desc`, ...(content && { preview: { kind: 'markdown' as const, content } }) });

const singleSelectQuestion = (overrides: Partial<Question> = {}): Question => ({
  question: 'Which one?',
  header: 'Q1',
  multiSelect: false,
  options: [opt('A'), opt('B'), opt('C', '**preview-c**')],
  ...overrides,
});

const multiSelectQuestion = (overrides: Partial<Question> = {}): Question => ({
  question: 'Which features?',
  header: 'Q2',
  multiSelect: true,
  options: [opt('X', '_preview-x_'), opt('Y'), opt('Z')],
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

  it('emits the typed preview of the single-select selected option', () => {
    const store = useQuestionStore();
    const q = singleSelectQuestion();
    store.setQuestion(pending([q]));
    store.toggleOption(q.question, 'C', false);
    expect(store.compiledAnnotations).toEqual({
      [q.question]: { preview: { kind: 'markdown', content: '**preview-c**' } },
    });
  });

  it('emits a preview the desktop bridge can structured-clone, as the design grid chooses it without advancing', () => {
    const store = useQuestionStore();
    const q = singleSelectQuestion({ options: [{ label: 'Cards', description: '', preview: { kind: 'design', path: 'variants/b/screens/S1.html' } }, opt('B')] });
    store.setQuestion(pending([q]));
    store.chooseOption(q.question, 'Cards');

    expect(store.currentTabIndex).toBe(0);
    const annotations = store.compiledAnnotations!;
    expect(structuredClone(annotations)).toEqual({ [q.question]: { preview: { kind: 'design', path: 'variants/b/screens/S1.html' } } });
  });

  it('emits every selected multi-select option\'s preview by its label, as structured-cloneable copies', () => {
    const store = useQuestionStore();
    const q = multiSelectQuestion({ options: [opt('X', '_preview-x_'), opt('Y'), opt('Z', '_preview-z_')] });
    store.setQuestion(pending([q]));
    store.toggleOption(q.question, 'X', true);
    store.toggleOption(q.question, 'Y', true);
    store.toggleOption(q.question, 'Z', true);
    expect(structuredClone(store.compiledAnnotations)).toEqual({
      [q.question]: { previews: { X: { kind: 'markdown', content: '_preview-x_' }, Z: { kind: 'markdown', content: '_preview-z_' } } },
    });
  });

  it('emits no multi-select preview when no selected option has one', () => {
    const store = useQuestionStore();
    const q = multiSelectQuestion();
    store.setQuestion(pending([q]));
    store.toggleOption(q.question, 'Y', true);
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
      [q.question]: { preview: { kind: 'markdown', content: '**preview-c**' }, notes: 'note' },
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

describe('useQuestionStore against a re-posted question', () => {
  beforeEach(() => setActivePinia(createPinia()));

  const withId = (id: string, questions: Question[]): PendingQuestionInfo => ({ toolUseId: id, questions });

  it('keeps the answer the user has already typed for the question on screen', () => {
    // The extension re-posts every pending prompt on webview ready, keeping the original toolUseId.
    const store = useQuestionStore();
    const q = multiSelectQuestion();
    store.setQuestion(withId('t1', [q]));
    store.toggleOption(q.question, 'X', true);
    store.setCustomInput(q.question, 'my own answer', true);
    store.setAnnotationNotes(q.question, 'a note');
    store.nextTab();

    store.setQuestion(withId('t1', [q]));

    expect(store.compiledAnswers[q.question]).toBe('X, my own answer');
    expect(store.compiledAnnotations?.[q.question]?.notes).toBe('a note');
    expect(store.currentTabIndex).toBe(1);
  });

  it('clears the answer state when a different question takes the screen after the first is settled', () => {
    const store = useQuestionStore();
    const first = multiSelectQuestion();
    store.setQuestion(withId('t1', [first]));
    store.toggleOption(first.question, 'X', true);

    const second = singleSelectQuestion();
    store.setQuestion(withId('t2', [second]));
    expect(store.compiledAnswers[first.question]).toBe('X');

    store.clearQuestion();
    expect(store.compiledAnswers[second.question]).toBe('');
    expect(store.currentTabIndex).toBe(0);
  });

  it('keeps a re-posted queued question in its place in the queue, not on screen', () => {
    const store = useQuestionStore();
    store.setQuestion(withId('t1', [singleSelectQuestion()]));
    store.setQuestion(withId('t2', [multiSelectQuestion()]));
    store.setQuestion(withId('t3', [singleSelectQuestion()]));

    store.setQuestion(withId('t2', [multiSelectQuestion({ options: [opt('X'), opt('Y')] })]));

    expect(store.pendingQuestion?.toolUseId).toBe('t1');
    expect(store.queue.map((q) => q.toolUseId)).toEqual(['t2', 't3']);
    expect(store.queue[0]!.questions[0]!.options.map((o) => o.label)).toEqual(['X', 'Y']);
  });

  it('takes the re-posted question payload, so a withdrawn option cannot linger', () => {
    const store = useQuestionStore();
    const q = multiSelectQuestion();
    store.setQuestion(withId('t1', [q]));

    const narrowed = multiSelectQuestion({ options: [opt('X'), opt('Y')] });
    store.setQuestion(withId('t1', [narrowed]));

    expect(store.questions[0]!.options.map((o) => o.label)).toEqual(['X', 'Y']);
  });
});

describe('useQuestionStore with several questions open at once', () => {
  beforeEach(() => setActivePinia(createPinia()));

  const withId = (id: string, questions: Question[]): PendingQuestionInfo => ({ toolUseId: id, questions });

  it('shows the first question and queues the later ones, keeping the one on screen and its answer', () => {
    const store = useQuestionStore();
    const first = singleSelectQuestion();
    store.setQuestion(withId('t1', [first]));
    store.toggleOption(first.question, 'B', false);

    store.setQuestion(withId('t2', [multiSelectQuestion(), singleSelectQuestion({ question: 'Which size?' })]));
    store.setQuestion(withId('t3', [singleSelectQuestion()]));

    expect(store.pendingQuestion?.toolUseId).toBe('t1');
    expect(store.compiledAnswers[first.question]).toBe('B');
    expect(store.queue.map((q) => q.toolUseId)).toEqual(['t2', 't3']);
    expect(store.waitingCount).toBe(3);
  });

  it('shows the next queued question, with a fresh answer, once the one on screen is settled', () => {
    const store = useQuestionStore();
    const q = singleSelectQuestion();
    store.setQuestion(withId('t1', [q]));
    store.setQuestion(withId('t2', [q]));
    store.toggleOption(q.question, 'A', false);

    store.clearQuestion();

    expect(store.pendingQuestion?.toolUseId).toBe('t2');
    expect(store.compiledAnswers[q.question]).toBe('');
    expect(store.currentTabIndex).toBe(0);
    expect(store.waitingCount).toBe(0);

    store.clearQuestion();
    expect(store.pendingQuestion).toBeNull();
  });

  it('drops the questions core no longer holds open, on screen and queued', () => {
    const store = useQuestionStore();
    store.setQuestion(withId('t1', [singleSelectQuestion()]));
    store.setQuestion(withId('t2', [singleSelectQuestion()]));
    store.setQuestion(withId('t3', [singleSelectQuestion()]));

    store.dropClosed(new Set(['t1', 't3']));
    expect(store.pendingQuestion?.toolUseId).toBe('t1');
    expect(store.queue.map((q) => q.toolUseId)).toEqual(['t3']);

    store.dropClosed(new Set(['t3', 'other-prompt']));
    expect(store.pendingQuestion?.toolUseId).toBe('t3');
    expect(store.queue).toEqual([]);
  });

  it('forgets every question on reset', () => {
    const store = useQuestionStore();
    store.setQuestion(withId('t1', [singleSelectQuestion()]));
    store.setQuestion(withId('t2', [singleSelectQuestion()]));

    store.$reset();

    expect(store.pendingQuestion).toBeNull();
    expect(store.queue).toEqual([]);
  });
});
