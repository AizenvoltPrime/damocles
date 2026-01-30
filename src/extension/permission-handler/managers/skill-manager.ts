import { loadSkillDescription } from '../../skills/utils';
import type { PermissionState } from '../state';
import type { CanUseToolContext, PermissionResult, SkillApprovalResult, PostMessageFn } from '../types';
import { buildDenyResultWithInterrupt, buildAllowResult } from '../utils';

export class SkillManager {
  private state: PermissionState;
  private getPostMessage: () => PostMessageFn | null;

  constructor(
    state: PermissionState,
    getPostMessage: () => PostMessageFn | null
  ) {
    this.state = state;
    this.getPostMessage = getPostMessage;
  }

  preApproveSkill(skillName: string): void {
    this.state.autoApprovedSkills.add(skillName);
  }

  revokeSkillPreApproval(skillName: string): void {
    this.state.autoApprovedSkills.delete(skillName);
  }

  async handleSkillApproval(
    input: Record<string, unknown>,
    context: CanUseToolContext
  ): Promise<PermissionResult> {
    const skillName = typeof input.skill === 'string' ? input.skill : '';

    if (this.state.autoApprovedSkills.has(skillName) || this.state.dangerouslySkipPermissions) {
      return buildAllowResult(input);
    }

    const skillDescription = await loadSkillDescription(skillName);
    const result = await this.requestSkillApprovalFromWebview(skillName, skillDescription, context);

    if (!result.approved) {
      return buildDenyResultWithInterrupt(result.customMessage, `User denied permission for skill "${skillName}"`);
    }

    if (result.approvalMode === 'acceptEdits') {
      this.state.autoApprovedSkills.add(skillName);
    }

    return buildAllowResult(input);
  }

  private async requestSkillApprovalFromWebview(
    skillName: string,
    skillDescription: string | undefined,
    context: CanUseToolContext
  ): Promise<SkillApprovalResult> {
    const toolUseId = context.toolUseID;
    const postMessage = this.getPostMessage();
    if (!toolUseId || !postMessage) {
      return { approved: false };
    }

    return new Promise<SkillApprovalResult>((resolve) => {
      const abortHandler = () => {
        this.state.pendingSkillApprovals.delete(toolUseId);
        resolve({ approved: false });
      };

      const cleanup = () => {
        context.signal.removeEventListener('abort', abortHandler);
      };

      this.state.addPendingSkillApproval(toolUseId, { resolve, cleanup });
      context.signal.addEventListener('abort', abortHandler, { once: true });

      postMessage({
        type: 'requestSkillApproval',
        toolUseId,
        skillName,
        skillDescription,
        parentToolUseId: context.parentToolUseId,
      });
    });
  }

  resolveSkillApproval(
    toolUseId: string,
    approved: boolean,
    options?: { approvalMode?: 'acceptEdits' | 'manual'; customMessage?: string }
  ): void {
    const pending = this.state.removePendingSkillApproval(toolUseId);
    if (!pending) {
      return;
    }

    pending.cleanup();
    pending.resolve({
      approved,
      approvalMode: options?.approvalMode,
      customMessage: options?.customMessage,
    });
  }
}
