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
  private getPlanContent: (() => Promise<string | null>) | null = null;

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

  setPlanContentResolver(fn: () => Promise<string | null>): void {
    this.getPlanContent = fn;
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

  async handleExitPlanMode(_input: Record<string, unknown>, context: CanUseToolContext): Promise<PermissionResult> {
    const resolved = await this.getPlanContent?.();
    const planContent = resolved && resolved.trim() ? resolved : null;
    if (!planContent) {
      return {
        behavior: 'deny',
        message:
          'No plan file found for this session. Write your complete plan to your plan file (the path named ' +
          'in your system prompt / EnterPlanMode result) before calling ExitPlanMode.',
      };
    }

    const result = await this.requestPlanApprovalFromWebview(planContent, context);

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
      const abortHandler = () => {
        const approved = !this.state.sessionAborting;
        log('[PlanManager] Abort signal on plan approval: toolUseId=%s, approved=%s', toolUseId, approved);
        this.state.pendingPlanApprovals.delete(toolUseId);
        this.getPostMessage()?.({
          type: 'permissionAutoResolved',
          toolUseId,
          ...(context.parentToolUseId !== undefined ? { parentToolUseId: context.parentToolUseId } : {}),
        });
        resolve({ approved, ...(approved ? { approvalMode: 'acceptEdits' } : {}) });
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
