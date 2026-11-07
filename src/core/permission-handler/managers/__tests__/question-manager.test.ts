import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { designPreviewRefusal, questionPreviewRefusal, QuestionManager, validateQuestions } from '../question-manager';
import { PermissionState } from '../../state';
import type { CanUseToolContext } from '../../types';
import { MAX_QUESTION_PREVIEW_CHARS, QUESTION_PREVIEW_FORM } from '../../../../shared/question-preview';

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

  it('accepts header of arbitrary length', () => {
    const result = validateQuestions([validQuestion({ header: 'a'.repeat(50) })]);
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

  it('refuses a bare string preview, naming the typed form', () => {
    const result = validateQuestions([
      validQuestion({ options: [{ label: 'A', description: 'd', preview: '<p>hi</p>' }, validOption('B')] }),
    ]);
    expect(result).toEqual({
      ok: false,
      reason: `questions[0].options[0].preview must be an object of the form ${QUESTION_PREVIEW_FORM}, got a string`,
    });
  });

  it('refuses a preview of an unknown kind', () => {
    const result = validateQuestions([
      validQuestion({ options: [{ label: 'A', description: 'd', preview: { kind: 'html', content: '<p>hi</p>' } }, validOption('B')] }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(QUESTION_PREVIEW_FORM);
  });

  it('refuses a design preview in this chat', () => {
    const result = validateQuestions([
      validQuestion({ options: [{ label: 'A', description: 'd', preview: { kind: 'design', path: 'designs/a.html' } }, validOption('B')] }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/^questions\[0\]\.options\[0\]\.preview: design previews are not available/);
  });

  it('accepts a markdown preview and keeps only its typed fields', () => {
    const result = validateQuestions([
      validQuestion({ options: [{ label: 'A', description: 'd', preview: { kind: 'markdown', content: '# hi', style: 'x' } }, validOption('B')] }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.questions[0]!.options[0]!.preview).toEqual({ kind: 'markdown', content: '# hi' });
  });

  it('refuses markdown content past the bound', () => {
    const result = validateQuestions([
      validQuestion({ options: [{ label: 'A', description: 'd', preview: { kind: 'markdown', content: 'x'.repeat(MAX_QUESTION_PREVIEW_CHARS + 1) } }, validOption('B')] }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/preview\.content must be at most 20000 characters/);
  });

  it('rejects null question entry', () => {
    const result = validateQuestions([null]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/must be an object/);
  });
});

describe('design-kind previews (PD-18)', () => {
  const designOption = (label: string, path: string) => ({ label, description: 'd', preview: { kind: 'design', path } });
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  });
  function designFolder(): string {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'question-design-'));
    folders.push(folder);
    fs.mkdirSync(path.join(folder, 'variants', 'a'), { recursive: true });
    fs.mkdirSync(path.join(folder, 'screens'));
    fs.writeFileSync(path.join(folder, 'variants', 'a', 'S1.html'), '<html></html>');
    fs.writeFileSync(path.join(folder, 'screens', 'S1.html'), '<html></html>');
    fs.writeFileSync(path.join(folder, 'design.md'), '# d');
    return folder;
  }

  it('takes an .html below screens/ or variants/ only in a design chat', () => {
    const question = validQuestion({ options: [designOption('A', 'variants/a/S1.html'), designOption('B', 'screens/S1.html')] });
    expect(validateQuestions([question], true)).toMatchObject({ ok: true, questions: [{ options: [{ preview: { kind: 'design', path: 'variants/a/S1.html' } }, { preview: { kind: 'design', path: 'screens/S1.html' } }] }] });
    expect(validateQuestions([question], false).ok).toBe(false);
    expect(questionPreviewRefusal([question], false)).toMatch(/design previews are not available in this chat/);
    expect(questionPreviewRefusal([question], true)).toBeUndefined();
  });

  it.each(['design.md', 'variants/a/../../../etc/S1.html', '../S1.html', 'screens/S1.css', '/tmp/screens/S1.html', 'screens\\S1.html', 'screens/CON.html', 'manifest.json'])('refuses %s', (target) => {
    const result = validateQuestions([validQuestion({ options: [designOption('A', target), validOption('B')] })], true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/preview\.path must be an \.html file of this design below screens\/ or variants\//);
  });

  it('refuses a question that mixes design and markdown previews, naming the question and the fix, and takes each kind in its own question', () => {
    const markdownOption = (label: string) => ({ label, description: 'd', preview: { kind: 'markdown', content: '- a' } });
    const mixed = validateQuestions([
      validQuestion({ options: [designOption('A', 'variants/a/S1.html'), validOption('B')] }),
      validQuestion({ question: 'Which?', options: [designOption('A', 'variants/a/S1.html'), markdownOption('B')] }),
    ], true);
    expect(mixed).toEqual({ ok: false, reason: expect.stringMatching(/^questions\[1\]\.options mix markdown and design previews; give every preview of one question the same kind/) });

    const separate = validateQuestions([
      validQuestion({ multiSelect: true, options: [designOption('A', 'variants/a/S1.html'), designOption('B', 'variants/b/S1.html')] }),
      validQuestion({ question: 'Which?', multiSelect: true, options: [markdownOption('A'), markdownOption('B')] }),
    ], true);
    expect(separate.ok).toBe(true);
  });

  it('asks only once every design preview names an existing screen of the chat\'s own folder', async () => {
    const folder = designFolder();
    const present = validateQuestions([validQuestion({ options: [designOption('A', 'variants/a/S1.html'), designOption('B', 'screens/S1.html')] })], true);
    if (!present.ok) throw new Error(present.reason);
    expect(await designPreviewRefusal(present.questions, folder)).toBeUndefined();
    const missing = validateQuestions([validQuestion({ options: [designOption('A', 'variants/b/S1.html'), validOption('B')] })], true);
    if (!missing.ok) throw new Error(missing.reason);
    expect(await designPreviewRefusal(missing.questions, folder)).toMatch(/variants\/b\/S1\.html is not a screen of this design \(missing\)/);
  });

  it('refuses a screen reached through a link out of the folder', async () => {
    const folder = designFolder();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'question-outside-'));
    folders.push(outside);
    fs.writeFileSync(path.join(outside, 'S1.html'), '<html></html>');
    fs.symlinkSync(outside, path.join(folder, 'variants', 'out'), 'junction');
    const linked = validateQuestions([validQuestion({ options: [designOption('A', 'variants/out/S1.html'), validOption('B')] })], true);
    if (!linked.ok) throw new Error(linked.reason);
    expect(await designPreviewRefusal(linked.questions, folder)).toMatch(/is not a screen of this design \(outside\)/);
  });

  it('QuestionManager refuses a design preview outside a design chat and one whose file is missing, before it asks', async () => {
    const posted: unknown[] = [];
    const manager = new QuestionManager(new PermissionState(), () => (message) => posted.push(message));
    const context = { toolUseID: 'q1', signal: new AbortController().signal } as unknown as CanUseToolContext;
    const input = { questions: [validQuestion({ options: [designOption('A', 'variants/a/S1.html'), validOption('B')] })] };
    expect(await manager.handleQuestion(input, context)).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/design previews are not available in this chat/) });
    const folder = designFolder();
    manager.setDesignFolder(() => folder);
    const gone = { questions: [validQuestion({ options: [designOption('A', 'variants/z/S1.html'), validOption('B')] })] };
    expect(await manager.handleQuestion(gone, context)).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/is not a screen of this design/) });
    expect(posted).toEqual([]);
  });
});
