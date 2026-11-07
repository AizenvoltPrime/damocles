import { describe, it, expect } from 'vitest';
import {
  MAX_QUESTION_PREVIEW_CHARS,
  QUESTION_PREVIEW_FORM,
  parseQuestionPreview,
  persistedQuestionInput,
  persistedQuestionPreview,
} from '../question-preview';

describe('parseQuestionPreview', () => {
  it('accepts a markdown preview and keeps only its typed fields', () => {
    expect(parseQuestionPreview({ kind: 'markdown', content: '- a\n- b', extra: 1 })).toEqual({ ok: true, preview: { kind: 'markdown', content: '- a\n- b' } });
  });

  it('accepts a design preview with a path', () => {
    expect(parseQuestionPreview({ kind: 'design', path: 'designs/a.html' })).toEqual({ ok: true, preview: { kind: 'design', path: 'designs/a.html' } });
  });

  it.each([
    ['a bare string', '<p>hi</p>', 'got a string'],
    ['null', null, 'got null'],
    ['an array', [], 'got an array'],
    ['a number', 42, 'got number'],
  ])('refuses %s, naming the typed form', (_name, raw, got) => {
    const parsed = parseQuestionPreview(raw);
    expect(parsed).toEqual({ ok: false, reason: `preview must be an object of the form ${QUESTION_PREVIEW_FORM}, ${got}` });
  });

  it('refuses an unknown kind, naming the typed form', () => {
    const parsed = parseQuestionPreview({ kind: 'html', content: '<p>hi</p>' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain(QUESTION_PREVIEW_FORM);
  });

  it('refuses markdown without string content and a design without a path', () => {
    expect(parseQuestionPreview({ kind: 'markdown', content: 3 })).toEqual({ ok: false, reason: 'preview.content must be a string' });
    expect(parseQuestionPreview({ kind: 'design', path: ' ' })).toEqual({ ok: false, reason: 'preview.path must be a non-empty string' });
  });

  it('bounds markdown content to 20,000 characters', () => {
    expect(parseQuestionPreview({ kind: 'markdown', content: 'x'.repeat(MAX_QUESTION_PREVIEW_CHARS) }).ok).toBe(true);
    expect(parseQuestionPreview({ kind: 'markdown', content: 'x'.repeat(MAX_QUESTION_PREVIEW_CHARS + 1) })).toEqual({
      ok: false,
      reason: `preview.content must be at most 20000 characters, got ${MAX_QUESTION_PREVIEW_CHARS + 1}`,
    });
  });
});

describe('persistedQuestionPreview', () => {
  it('reads a string preview from an older session as markdown, bounded', () => {
    expect(persistedQuestionPreview('<b>Two columns</b>')).toEqual({ kind: 'markdown', content: '<b>Two columns</b>' });
    expect(persistedQuestionPreview('x'.repeat(MAX_QUESTION_PREVIEW_CHARS + 5))).toEqual({ kind: 'markdown', content: 'x'.repeat(MAX_QUESTION_PREVIEW_CHARS) });
    expect(persistedQuestionPreview('')).toBeUndefined();
  });

  it('passes typed previews through and drops malformed ones', () => {
    expect(persistedQuestionPreview({ kind: 'markdown', content: 'hi' })).toEqual({ kind: 'markdown', content: 'hi' });
    expect(persistedQuestionPreview({ kind: 'design', path: 'a.html' })).toEqual({ kind: 'design', path: 'a.html' });
    expect(persistedQuestionPreview({ kind: 'html', content: 'hi' })).toBeUndefined();
    expect(persistedQuestionPreview(7)).toBeUndefined();
  });
});

describe('persistedQuestionInput', () => {
  it('types every option preview and leaves the rest of the input alone', () => {
    const input = {
      questions: [{
        question: 'Which?',
        header: 'Pick',
        multiSelect: false,
        options: [
          { label: 'A', description: 'a', preview: '# Old' },
          { label: 'B', description: 'b', preview: 42 },
          { label: 'C', description: 'c' },
        ],
      }],
    };

    expect(persistedQuestionInput(input)).toEqual({
      questions: [{
        question: 'Which?',
        header: 'Pick',
        multiSelect: false,
        options: [
          { label: 'A', description: 'a', preview: { kind: 'markdown', content: '# Old' } },
          { label: 'B', description: 'b' },
          { label: 'C', description: 'c' },
        ],
      }],
    });
  });

  it('returns an input without a questions array as it is', () => {
    const input = { other: true };
    expect(persistedQuestionInput(input)).toBe(input);
  });
});
