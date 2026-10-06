import { registerAbortablePrompt, type PermissionState } from '../state';
import type {
  CanUseToolContext,
  PermissionResult,
  PlanApprovalResult,
  PostMessageFn,
} from '../types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { log } from '../../logger';
import { buildUnaskedDenyResult } from '../utils';

const NOT_SHOWN = 'Damocles could not show the plan to the user for approval, so this tool call was denied';
const ABORTED_BEFORE_ANSWER = 'The session was aborted before the user answered this plan';

export class PlanManager {
  private state: PermissionState;
  private getPostMessage: () => PostMessageFn | null;
  private getPlanContent: (() => Promise<string | null>) | null = null;

  constructor(
    state: PermissionState,
    getPostMessage: () => PostMessageFn | null
  ) {
    this.state = state;
    this.getPostMessage = getPostMessage;
  }

  setPlanContentResolver(fn: () => Promise<string | null>): void {
    this.getPlanContent = fn;
  }

  async handleExitPlanMode(_input: Record<string, unknown>, context: CanUseToolContext): Promise<PermissionResult> {
    const resolved = await this.getPlanContent?.();
    const planContent = resolved && resolved.trim() ? resolved : null;
    if (!planContent) {
      return buildUnaskedDenyResult(
        undefined,
        'No plan file found for this session. Write your complete plan to your plan file (the path named ' +
          'in your system prompt / EnterPlanMode result) before calling ExitPlanMode.',
      );
    }

    const result = await this.requestPlanApprovalFromWebview(planContent, context);

    const shown = result.shown ? { planShown: true as const } : {};
    if (!result.approved && !result.userAnswered) {
      return { ...buildUnaskedDenyResult(result.customMessage, NOT_SHOWN), ...shown };
    }
    if (!result.approved) {
      const message = result.feedback
        ? `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user provided the following reason for the rejection: ${result.feedback}`
        : 'User wants to revise the plan';
      return {
        behavior: 'deny',
        message,
        ...shown,
      };
    }

    return {
      ...shown,
      behavior: 'allow',
      updatedInput: {
        approved: true,
        approvalMode: result.approvalMode,
      },
    };
  }

  private async requestPlanApprovalFromWebview(
    planContent: string,
    context: CanUseToolContext
  ): Promise<PlanApprovalResult> {
    const toolUseId = context.toolUseID;
    const postMessage = this.getPostMessage();
    if (!toolUseId || !postMessage) {
      return { approved: false };
    }

    return new Promise<PlanApprovalResult>((resolve) => {
      let shown = false;
      // Every way the request settles goes through here, so a result after the post says the plan was shown.
      const settle = (result: PlanApprovalResult) => resolve(shown ? { ...result, shown: true } : result);
      const abortHandler = () => {
        log('[PlanManager] Abort signal on plan approval: toolUseId=%s', toolUseId);
        this.state.removePendingPlanApproval(toolUseId);
        this.getPostMessage()?.({
          type: 'permissionAutoResolved',
          toolUseId,
          ...(context.parentToolUseId !== undefined ? { parentToolUseId: context.parentToolUseId } : {}),
        });
        settle({ approved: false, customMessage: ABORTED_BEFORE_ANSWER });
      };

      const cleanup = () => {
        context.signal.removeEventListener('abort', abortHandler);
      };

      const request: ExtensionToWebviewMessage = {
        type: 'requestPlanApproval',
        toolUseId,
        planContent,
        ...(context.planVersion !== undefined ? { planVersion: context.planVersion } : {}),
        owner: this.state.promptOwner(context.parentToolUseId),
        ...(context.parentToolUseId !== undefined ? { parentToolUseId: context.parentToolUseId } : {}),
      };

      registerAbortablePrompt({
        signal: context.signal,
        toolUseId,
        register: () => {
          this.state.addPendingPlanApproval(toolUseId, { resolve: settle, cleanup, request });
          // Set before posting: a webview can answer within the post.
          shown = true;
          postMessage(request);
        },
        onAborted: abortHandler,
      });
    });
  }

  resolvePlanApproval(
    toolUseId: string,
    approved: boolean,
    options?: { approvalMode?: 'acceptEdits' | 'manual'; feedback?: string }
  ): void {
    const pending = this.state.removePendingPlanApproval(toolUseId);
    if (!pending) {
      return;
    }

    pending.cleanup();
    pending.resolve({
      approved,
      userAnswered: true,
      ...(options?.approvalMode !== undefined ? { approvalMode: options.approvalMode } : {}),
      ...(options?.feedback !== undefined ? { feedback: options.feedback } : {}),
    });
  }
}
