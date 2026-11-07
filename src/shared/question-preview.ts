import type { QuestionPreview } from './types/permissions';

export const MAX_QUESTION_PREVIEW_CHARS = 20_000;

/** The form every refusal names. It leaves out the design kind, which only a chat whose rules allow it describes to the model. */
export const QUESTION_PREVIEW_FORM = '{ "kind": "markdown", "content": "<markdown>" }';

export type QuestionPreviewParse = { ok: true; preview: QuestionPreview } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A preview as the model sent it: typed objects only, with markdown content bounded to MAX_QUESTION_PREVIEW_CHARS. */
export function parseQuestionPreview(raw: unknown): QuestionPreviewParse {
  if (!isRecord(raw)) {
    const got = typeof raw === 'string' ? 'a string' : raw === null ? 'null' : Array.isArray(raw) ? 'an array' : typeof raw;
    return { ok: false, reason: `preview must be an object of the form ${QUESTION_PREVIEW_FORM}, got ${got}` };
  }
  if (raw['kind'] === 'markdown') {
    const content = raw['content'];
    if (typeof content !== 'string') return { ok: false, reason: 'preview.content must be a string' };
    if (content.length > MAX_QUESTION_PREVIEW_CHARS) {
      return { ok: false, reason: `preview.content must be at most ${MAX_QUESTION_PREVIEW_CHARS} characters, got ${content.length}` };
    }
    return { ok: true, preview: { kind: 'markdown', content } };
  }
  if (raw['kind'] === 'design') {
    const path = raw['path'];
    if (typeof path !== 'string' || !path.trim()) return { ok: false, reason: 'preview.path must be a non-empty string' };
    return { ok: true, preview: { kind: 'design', path } };
  }
  return { ok: false, reason: `preview.kind must be "markdown", in the form ${QUESTION_PREVIEW_FORM}` };
}

/** A preview read back from a stored session: a string from before typed previews is that text as markdown. */
export function persistedQuestionPreview(raw: unknown): QuestionPreview | undefined {
  if (typeof raw === 'string') {
    return raw ? { kind: 'markdown', content: raw.slice(0, MAX_QUESTION_PREVIEW_CHARS) } : undefined;
  }
  const parsed = parseQuestionPreview(raw);
  return parsed.ok ? parsed.preview : undefined;
}

function persistedOption(option: unknown): unknown {
  if (!isRecord(option) || !('preview' in option)) return option;
  const { preview, ...rest } = option;
  const typed = persistedQuestionPreview(preview);
  return typed ? { ...rest, preview: typed } : rest;
}

/** An AskUserQuestion input read back from a stored session, with every option preview typed or dropped. */
export function persistedQuestionInput(input: Record<string, unknown>): Record<string, unknown> {
  const questions = input['questions'];
  if (!Array.isArray(questions)) return input;
  return {
    ...input,
    questions: questions.map((q: unknown) => (isRecord(q) && Array.isArray(q['options']) ? { ...q, options: q['options'].map(persistedOption) } : q)),
  };
}
