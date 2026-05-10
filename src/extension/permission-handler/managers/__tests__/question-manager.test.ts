import { describe, it, expect } from 'vitest';
import { validateQuestions } from '../question-manager';

const validOption = (label: string) => ({ label, description: `desc for ${label}` });

const validQuestion = (overrides: Record<string, unknown> = {}) => ({
  question: 'Pick one?',
  header: 'Pick',
  multiSelect: false,
  options: [validOption('A'), validOption('B')],
  ...overrides,
});

describe('validateQuestions', () => {
  it('accepts a well-formed single question', () => {
    const result = validateQuestions([validQuestion()]);
    expect(result.ok).toBe(true);
  });

  it('accepts up to 4 questions with up to 4 options each', () => {
    const q = validQuestion({ options: [validOption('A'), validOption('B'), validOption('C'), validOption('D')] });
    const result = validateQuestions([q, q, q, q]);
    expect(result.ok).toBe(true);
  });

  it('rejects non-array input', () => {
    const result = validateQuestions({ not: 'array' });
    expect(result).toEqual({ ok: false, reason: 'questions must be an array' });
  });

  it('rejects empty array (SDK requires minItems: 1)', () => {
    const result = validateQuestions([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/1-4 items/);
  });

  it('rejects more than 4 questions', () => {
    const result = validateQuestions(Array(5).fill(validQuestion()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/got 5/);
  });

  it('rejects question with empty question text', () => {
    const result = validateQuestions([validQuestion({ question: '   ' })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/question must be a non-empty string/);
  });

  it('rejects missing header', () => {
    const result = validateQuestions([validQuestion({ header: undefined })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/header must be a non-empty string/);
  });

  it('rejects header longer than 12 chars', () => {
    const result = validateQuestions([validQuestion({ header: 'a'.repeat(13) })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/exceeds 12 chars/);
  });

  it('accepts header at exactly 12 chars (boundary)', () => {
    const result = validateQuestions([validQuestion({ header: 'a'.repeat(12) })]);
    expect(result.ok).toBe(true);
  });

  it('rejects non-boolean multiSelect', () => {
    const result = validateQuestions([validQuestion({ multiSelect: 'true' })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/multiSelect must be a boolean/);
  });

  it('rejects question with fewer than 2 options', () => {
    const result = validateQuestions([validQuestion({ options: [validOption('A')] })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/options must have 2-4 items/);
  });

  it('rejects question with more than 4 options', () => {
    const opts = Array.from({ length: 5 }, (_, i) => validOption(`O${i}`));
    const result = validateQuestions([validQuestion({ options: opts })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/options must have 2-4 items/);
  });

  it('rejects option with empty label', () => {
    const result = validateQuestions([validQuestion({ options: [{ label: ' ', description: 'd' }, validOption('B')] })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/label must be a non-empty string/);
  });

  it('rejects option missing description', () => {
    const result = validateQuestions([validQuestion({ options: [{ label: 'A' }, validOption('B')] })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/description must be a string/);
  });

  it('accepts option with empty-string description (SDK allows empty string)', () => {
    const result = validateQuestions([validQuestion({ options: [{ label: 'A', description: '' }, validOption('B')] })]);
    expect(result.ok).toBe(true);
  });

  it('rejects non-string preview', () => {
    const result = validateQuestions([
      validQuestion({ options: [{ label: 'A', description: 'd', preview: 42 }, validOption('B')] }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/preview must be a string/);
  });

  it('accepts string preview', () => {
    const result = validateQuestions([
      validQuestion({ options: [{ label: 'A', description: 'd', preview: '<p>hi</p>' }, validOption('B')] }),
    ]);
    expect(result.ok).toBe(true);
  });

  it('rejects null question entry', () => {
    const result = validateQuestions([null]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/must be an object/);
  });
});
