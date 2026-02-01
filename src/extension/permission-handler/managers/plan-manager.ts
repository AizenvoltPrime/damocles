import type { PermissionState } from '../state';
import type {
  CanUseToolContext,
  PermissionResult,
  PlanApprovalResult,
  EnterPlanApprovalResult,
  PostMessageFn,
} from '../types';
import { buildDenyResultWithInterrupt, buildAllowResult } from '../utils';

export class PlanManager {
  private state: PermissionState;
  private getPostMessage: () => PostMessageFn | null;

  constructor(
    state: PermissionState,
    getPostMessage: () => PostMessageFn | null
  ) {
    this.state = state;
    this.getPostMessage = getPostMessage;
  }

  async handleEnterPlanMode(context: CanUseToolContext, input: Record<string, unknown>): Promise<PermissionResult> {
    if (this.state.permissionMode === 'plan') {
      return buildAllowResult(input);
    }

    if (this.state.dangerouslySkipPermissions) {
      return buildAllowResult(input);
    }

    const result = await this.requestEnterPlanApprovalFromWebview(context);

    if (!result.approved) {
      return buildDenyResultWithInterrupt(result.customMessage, 'User chose not to enter plan mode');
    }

    return buildAllowResult(input);
  }

  async handleExitPlanMode(input: Record<string, unknown>, context: CanUseToolContext): Promise<PermissionResult> {
    const result = await this.requestPlanApprovalFromWebview(input, context);

    if (!result.approved) {
      const message = result.feedback
        ? `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user provided the following reason for the rejection: ${result.feedback}`
        : 'User wants to revise the plan';
      return {
        behavior: 'deny',
        message,
      };
    }

    return {
      behavior: 'allow',
      updatedInput: {
        ...input,
        approved: true,
        approvalMode: result.approvalMode,
      },
    };
  }

  private async requestEnterPlanApprovalFromWebview(
    context: CanUseToolContext
  ): Promise<EnterPlanApprovalResult> {
    const toolUseId = context.toolUseID;
    const postMessage = this.getPostMessage();
    if (!toolUseId || !postMessage) {
      return { approved: false };
    }

    return new Promise<EnterPlanApprovalResult>((resolve) => {
      const abortHandler = () => {
        this.state.pendingEnterPlanApprovals.delete(toolUseId);
        resolve({ approved: false });
      };

      const cleanup = () => {
        context.signal.removeEventListener('abort', abortHandler);
      };

      this.state.addPendingEnterPlanApproval(toolUseId, { resolve, cleanup });
      context.signal.addEventListener('abort', abortHandler, { once: true });

      postMessage({
        type: 'requestEnterPlanMode',
        toolUseId,
        ...(context.parentToolUseId !== undefined ? { parentToolUseId: context.parentToolUseId } : {}),
      });
    });
  }

  private async requestPlanApprovalFromWebview(
    input: Record<string, unknown>,
    context: CanUseToolContext
  ): Promise<PlanApprovalResult> {
    const toolUseId = context.toolUseID;
    const postMessage = this.getPostMessage();
    if (!toolUseId || !postMessage) {
      return { approved: false };
    }

    const planContent = typeof input['plan'] === 'string' ? input['plan'] : '';

    return new Promise<PlanApprovalResult>((resolve) => {
      const abortHandler = () => {
        this.state.pendingPlanApprovals.delete(toolUseId);
        resolve({ approved: false });
      };

      const cleanup = () => {
        context.signal.removeEventListener('abort', abortHandler);
      };

      this.state.addPendingPlanApproval(toolUseId, { resolve, cleanup });
      context.signal.addEventListener('abort', abortHandler, { once: true });

      postMessage({
        type: 'requestPlanApproval',
        toolUseId,
        planContent,
        ...(context.parentToolUseId !== undefined ? { parentToolUseId: context.parentToolUseId } : {}),
      });
    });
  }

  resolveEnterPlanApproval(
    toolUseId: string,
    approved: boolean,
    options?: { customMessage?: string }
  ): void {
    const pending = this.state.removePendingEnterPlanApproval(toolUseId);
    if (!pending) {
      return;
    }

    pending.cleanup();
    pending.resolve({
      approved,
      ...(options?.customMessage !== undefined ? { customMessage: options.customMessage } : {}),
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
      ...(options?.approvalMode !== undefined ? { approvalMode: options.approvalMode } : {}),
      ...(options?.feedback !== undefined ? { feedback: options.feedback } : {}),
    });
  }
}
