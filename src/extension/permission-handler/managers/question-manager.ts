import { ASK_USER_QUESTION_LIMITS, type Question, type QuestionAnnotations } from '../../../shared/types/permissions';
import type { PermissionState } from '../state';
import type { CanUseToolContext, PermissionResult, QuestionResult, PostMessageFn } from '../types';

export type ValidationResult =
  | { ok: true; questions: Question[] }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateQuestions(input: unknown): ValidationResult {
  if (!Array.isArray(input)) {
    return { ok: false, reason: 'questions must be an array' };
  }
  const { MIN_QUESTIONS, MAX_QUESTIONS, MIN_OPTIONS, MAX_OPTIONS, MAX_HEADER_LENGTH } = ASK_USER_QUESTION_LIMITS;
  if (input.length < MIN_QUESTIONS || input.length > MAX_QUESTIONS) {
    return { ok: false, reason: `questions must have ${MIN_QUESTIONS}-${MAX_QUESTIONS} items, got ${input.length}` };
  }
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
    if (header.length > MAX_HEADER_LENGTH) {
      return { ok: false, reason: `questions[${i}].header exceeds ${MAX_HEADER_LENGTH} chars (got ${header.length})` };
    }
    const multiSelect = q['multiSelect'];
    if (typeof multiSelect !== 'boolean') {
      return { ok: false, reason: `questions[${i}].multiSelect must be a boolean` };
    }
    const options = q['options'];
    if (!Array.isArray(options) || options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      return { ok: false, reason: `questions[${i}].options must have ${MIN_OPTIONS}-${MAX_OPTIONS} items` };
    }
    for (let j = 0; j < options.length; j++) {
      const o = options[j];
      if (!isRecord(o)) {
        return { ok: false, reason: `questions[${i}].options[${j}] must be an object` };
      }
      const label = o['label'];
      if (typeof label !== 'string' || !label.trim()) {
        return { ok: false, reason: `questions[${i}].options[${j}].label must be a non-empty string` };
      }
      if (typeof o['description'] !== 'string') {
        return { ok: false, reason: `questions[${i}].options[${j}].description must be a string` };
      }
      const preview = o['preview'];
      if (preview !== undefined && typeof preview !== 'string') {
        return { ok: false, reason: `questions[${i}].options[${j}].preview must be a string when provided` };
      }
    }
  }
  return { ok: true, questions: input as Question[] };
}

export class QuestionManager {
  private state: PermissionState;
  private getPostMessage: () => PostMessageFn | null;

  constructor(
    state: PermissionState,
    getPostMessage: () => PostMessageFn | null
  ) {
    this.state = state;
    this.getPostMessage = getPostMessage;
  }

  async handleQuestion(
    input: Record<string, unknown>,
    context: CanUseToolContext
  ): Promise<PermissionResult> {
    const validated = validateQuestions(input['questions']);
    if (!validated.ok) {
      return { behavior: 'deny', message: `AskUserQuestion input invalid: ${validated.reason}` };
    }
    const questions = validated.questions;

    const result = await this.requestQuestionFromWebview(questions, context);

    if (!result.approved || !result.answers) {
      return { behavior: 'deny', message: 'User cancelled the question prompt' };
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
        this.state.pendingQuestions.delete(toolUseId);
        resolve({ approved: false });
      };

      const cleanup = () => {
        context.signal.removeEventListener('abort', abortHandler);
      };

      this.state.addPendingQuestion(toolUseId, { resolve, cleanup });
      context.signal.addEventListener('abort', abortHandler, { once: true });

      postMessage({
        type: 'requestQuestion',
        toolUseId,
        questions,
        ...(context.parentToolUseId !== undefined ? { parentToolUseId: context.parentToolUseId } : {}),
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
      ...(answers !== null ? { answers } : {}),
      ...(annotations && { annotations }),
    });
  }
}
