import type { Question, QuestionAnnotations } from '../../../shared/types/permissions';
import type { PermissionState } from '../state';
import type { CanUseToolContext, PermissionResult, QuestionResult, PostMessageFn } from '../types';

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
    const questions = input['questions'] as Question[] | undefined;
    if (!questions || questions.length === 0) {
      return { behavior: 'allow', updatedInput: { questions: [], answers: {} } };
    }

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
