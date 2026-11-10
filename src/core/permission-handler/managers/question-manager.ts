import { ASK_USER_QUESTION_LIMITS, type Question, type QuestionAnnotations, type QuestionOption, type QuestionPreview } from '../../../shared/types/permissions';
import { parseQuestionPreview, QUESTION_PREVIEW_FORM } from '../../../shared/question-preview';
import { statDesignFile } from '../../design/design-file-read';
import { isDesignPreviewPath, MAX_SCREEN_BYTES } from '../../design/design-paths';
import { MAX_REFERENCE_ROW_REF_CHARS, referenceRowFormatRefusal, referenceSourceRefusal } from '../../design/references';
import { registerAbortablePrompt, type PermissionState } from '../state';
import type { CanUseToolContext, PermissionResult, QuestionResult, PostMessageFn } from '../types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { buildUnaskedDenyResult } from '../utils';

/** A validated question; `reference` ('R<n>#<element>', design work only) stays in core and never reaches the prompt. */
export type AskedQuestion = Question & { reference?: string };

export type ValidationResult =
  | { ok: true; questions: AskedQuestion[] }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function invalidQuestionInput(reason: string): string {
  return `AskUserQuestion input invalid: ${reason}`;
}

function optionPreview(raw: unknown, at: string, designPreviews: boolean): { ok: true; preview: QuestionPreview } | { ok: false; reason: string } {
  const parsed = parseQuestionPreview(raw);
  if (!parsed.ok) return { ok: false, reason: `${at}.${parsed.reason}` };
  if (parsed.preview.kind === 'design') {
    if (!designPreviews) return { ok: false, reason: `${at}.preview: design previews are not available in this chat; use ${QUESTION_PREVIEW_FORM}` };
    const { path } = parsed.preview;
    if (!isDesignPreviewPath(path)) {
      return { ok: false, reason: `${at}.preview.path must be an .html file of this design below screens/ or variants/, relative to the design folder, such as variants/a/S1.html` };
    }
  }
  return parsed;
}

/** The first option preview `validateQuestions` refuses; the tool checks it ahead of pi's schema validation, whose error names no form. */
export function questionPreviewRefusal(questions: unknown, designPreviews: boolean): string | undefined {
  if (!Array.isArray(questions)) return undefined;
  for (const [i, q] of questions.entries()) {
    const options: unknown[] = isRecord(q) && Array.isArray(q['options']) ? q['options'] : [];
    for (const [j, o] of options.entries()) {
      if (!isRecord(o) || o['preview'] === undefined) continue;
      const checked = optionPreview(o['preview'], `questions[${i}].options[${j}]`, designPreviews);
      if (!checked.ok) return checked.reason;
    }
  }
  return undefined;
}

/**
 * `designPreviews`: design work's, which also takes `{kind:'design', path}` (its file is checked by `designPreviewRefusal`) and a
 * question's `reference` (its row is checked by `questionReferenceRefusal`).
 */
export function validateQuestions(input: unknown, designPreviews = false): ValidationResult {
  if (!Array.isArray(input)) {
    return { ok: false, reason: 'questions must be an array' };
  }
  const { MIN_QUESTIONS, MAX_QUESTIONS, MIN_OPTIONS, MAX_OPTIONS } = ASK_USER_QUESTION_LIMITS;
  if (input.length < MIN_QUESTIONS || input.length > MAX_QUESTIONS) {
    return { ok: false, reason: `questions must have ${MIN_QUESTIONS}-${MAX_QUESTIONS} items, got ${input.length}` };
  }
  const questions: Question[] = [];
  for (let i = 0; i < input.length; i++) {
    const q = input[i];
    if (!isRecord(q)) {
      return { ok: false, reason: `questions[${i}] must be an object` };
    }
    const question = q['question'];
    if (typeof question !== 'string' || !question.trim()) {
      return { ok: false, reason: `questions[${i}].question must be a non-empty string` };
    }
    const header = q['header'];
    if (typeof header !== 'string' || !header.trim()) {
      return { ok: false, reason: `questions[${i}].header must be a non-empty string` };
    }
    const multiSelect = q['multiSelect'];
    if (typeof multiSelect !== 'boolean') {
      return { ok: false, reason: `questions[${i}].multiSelect must be a boolean` };
    }
    const options = q['options'];
    if (!Array.isArray(options) || options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      return { ok: false, reason: `questions[${i}].options must have ${MIN_OPTIONS}-${MAX_OPTIONS} items` };
    }
    const reference = q['reference'];
    if (reference !== undefined) {
      if (!designPreviews) return { ok: false, reason: `questions[${i}].reference: a reference is available only in a design chat; leave it out` };
      if (typeof reference !== 'string' || reference.length > MAX_REFERENCE_ROW_REF_CHARS) {
        return { ok: false, reason: `questions[${i}].reference must be a string of at most ${MAX_REFERENCE_ROW_REF_CHARS} characters` };
      }
      const malformed = referenceRowFormatRefusal(reference);
      if (malformed) return { ok: false, reason: `questions[${i}].reference: ${malformed}` };
    }
    const parsedOptions: QuestionOption[] = [];
    for (let j = 0; j < options.length; j++) {
      const o = options[j];
      if (!isRecord(o)) {
        return { ok: false, reason: `questions[${i}].options[${j}] must be an object` };
      }
      const label = o['label'];
      if (typeof label !== 'string' || !label.trim()) {
        return { ok: false, reason: `questions[${i}].options[${j}].label must be a non-empty string` };
      }
      const description = o['description'];
      if (typeof description !== 'string') {
        return { ok: false, reason: `questions[${i}].options[${j}].description must be a string` };
      }
      if (o['preview'] === undefined) {
        parsedOptions.push({ label, description });
        continue;
      }
      const preview = optionPreview(o['preview'], `questions[${i}].options[${j}]`, designPreviews);
      if (!preview.ok) return preview;
      parsedOptions.push({ label, description, preview: preview.preview });
    }
    // A design preview turns the question into a grid of screens, which has no place for a markdown preview.
    const kinds = new Set(parsedOptions.flatMap((option) => (option.preview ? [option.preview.kind] : [])));
    if (kinds.size > 1) {
      return { ok: false, reason: `questions[${i}].options mix markdown and design previews; give every preview of one question the same kind, or ask the markdown comparison as a separate question` };
    }
    questions.push({ question, header, multiSelect, options: parsedOptions, ...(typeof reference === 'string' ? { reference } : {}) });
  }
  return { ok: true, questions };
}

const unpreviewableBecause: Record<'missing' | 'outside' | 'tooLarge', string> = {
  missing: 'is not a file of this design yet; write it first.',
  outside: 'leads outside the design folder through a link, so it cannot be previewed.',
  tooLarge: `is over the preview size limit of ${MAX_SCREEN_BYTES / (1024 * 1024)} MiB, so it cannot be previewed.`,
};

/** The first design-kind preview whose file is not a readable screen of `folder`; every path check runs before the read. */
export async function designPreviewRefusal(questions: readonly Question[], folder: string): Promise<string | undefined> {
  for (const [i, question] of questions.entries()) {
    for (const [j, option] of question.options.entries()) {
      if (option.preview?.kind !== 'design') continue;
      const file = await statDesignFile(folder, option.preview.path, MAX_SCREEN_BYTES);
      if (file.kind !== 'file') return `questions[${i}].options[${j}].preview.path: ${option.preview.path} ${unpreviewableBecause[file.kind]}`;
    }
  }
  return undefined;
}

/** The first question whose `reference` names no mapping row of a reference of `folder`. */
export async function questionReferenceRefusal(questions: readonly AskedQuestion[], folder: string): Promise<string | undefined> {
  for (const [i, question] of questions.entries()) {
    if (question.reference === undefined) continue;
    const refusal = await referenceSourceRefusal(folder, question.reference);
    if (refusal) return `questions[${i}].reference: ${refusal}`;
  }
  return undefined;
}

export class QuestionManager {
  private state: PermissionState;
  private getPostMessage: () => PostMessageFn | null;
  // the design folder of a design chat, whose questions take design-kind previews; undefined elsewhere
  private designFolder: () => string | undefined = () => undefined;

  constructor(
    state: PermissionState,
    getPostMessage: () => PostMessageFn | null
  ) {
    this.state = state;
    this.getPostMessage = getPostMessage;
  }

  setDesignFolder(folder: () => string | undefined): void {
    this.designFolder = folder;
  }

  async handleQuestion(
    input: Record<string, unknown>,
    context: CanUseToolContext
  ): Promise<PermissionResult> {
    const folder = this.designFolder();
    const validated = validateQuestions(input['questions'], folder !== undefined);
    if (!validated.ok) {
      return buildUnaskedDenyResult(undefined, invalidQuestionInput(validated.reason));
    }
    const questions = validated.questions;
    const missing = folder === undefined ? undefined : (await designPreviewRefusal(questions, folder)) ?? (await questionReferenceRefusal(questions, folder));
    if (missing) return buildUnaskedDenyResult(undefined, invalidQuestionInput(missing));

    const result = await this.requestQuestionFromWebview(questions.map(({ reference: _reference, ...shown }) => shown), context);

    if (!result.approved || !result.answers) {
      return result.userAnswered
        ? { behavior: 'deny', message: 'User cancelled the question prompt' }
        : buildUnaskedDenyResult(undefined, 'Damocles could not ask the user the question, so this tool call was denied');
    }

    return {
      behavior: 'allow',
      updatedInput: {
        questions,
        answers: result.answers,
        ...(result.annotations && { annotations: result.annotations }),
      },
    };
  }

  private async requestQuestionFromWebview(
    questions: Question[],
    context: CanUseToolContext
  ): Promise<QuestionResult> {
    const postMessage = this.getPostMessage();
    if (!postMessage) {
      return { approved: false };
    }

    const toolUseId = context.toolUseID;
    if (!toolUseId) {
      return { approved: false };
    }

    return new Promise<QuestionResult>((resolve) => {
      const abortHandler = () => {
        this.state.removePendingQuestion(toolUseId);
        resolve({ approved: false });
      };

      const cleanup = () => {
        context.signal.removeEventListener('abort', abortHandler);
      };

      const request: ExtensionToWebviewMessage = {
        type: 'requestQuestion',
        toolUseId,
        questions,
        owner: this.state.promptOwner(context.parentToolUseId),
        ...(context.parentToolUseId !== undefined ? { parentToolUseId: context.parentToolUseId } : {}),
      };

      registerAbortablePrompt({
        signal: context.signal,
        toolUseId,
        register: () => {
          this.state.addPendingQuestion(toolUseId, { resolve, cleanup, request });
          postMessage(request);
        },
        onAborted: abortHandler,
      });
    });
  }

  resolveQuestion(toolUseId: string, answers: Record<string, string> | null, annotations?: QuestionAnnotations): void {
    const pending = this.state.removePendingQuestion(toolUseId);
    if (!pending) {
      return;
    }

    pending.cleanup();
    pending.resolve({
      approved: answers !== null,
      userAnswered: true,
      ...(answers !== null ? { answers } : {}),
      ...(annotations && { annotations }),
    });
  }
}
