import type { PermissionState } from '../state';
import type {
  CanUseToolContext,
  PermissionResult,
  PlanApprovalResult,
  PostMessageFn,
} from '../types';
import { log } from '../../logger';

export class PlanManager {
  private state: PermissionState;
  private getPostMessage: () => PostMessageFn | null;
  private onPlanModeActivated: (() => Promise<void>) | null = null;

  constructor(
    state: PermissionState,
    getPostMessage: () => PostMessageFn | null
  ) {
    this.state = state;
    this.getPostMessage = getPostMessage;
  }

  setOnPlanModeActivated(callback: () => Promise<void>): void {
    this.onPlanModeActivated = callback;
  }

  async activatePlanMode(): Promise<void> {
    if (this.state.permissionMode === 'plan') {
      return;
    }

    this.state.permissionMode = 'plan';

    try {
      await this.onPlanModeActivated?.();
    } catch (err) {
      log('[PlanManager] activatePlanMode callback failed:', err);
    }
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
