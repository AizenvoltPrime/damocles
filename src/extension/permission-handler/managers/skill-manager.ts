import { loadSkillDescription } from '../../skills/utils';
import { registerAbortablePrompt, type PermissionState } from '../state';
import type { CanUseToolContext, PermissionResult, SkillApprovalResult, PostMessageFn } from '../types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { buildUserDenyResult, buildUnaskedDenyResult, buildAllowResult } from '../utils';

const ABORTED_BEFORE_ANSWER = 'The session was aborted before this skill approval was answered';

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
    const skillName = typeof input['skill'] === 'string' ? input['skill'] : '';

    if (this.state.autoApprovedSkills.has(skillName) || this.state.dangerouslySkipPermissions) {
      return buildAllowResult(input);
    }

    const skillDescription = await loadSkillDescription(skillName, this.state.workspacePath);
    const result = await this.requestSkillApprovalFromWebview(skillName, skillDescription, context);

    if (!result.approved) {
      return result.userAnswered
        ? buildUserDenyResult(result.customMessage, `User denied permission for skill "${skillName}"`)
        : buildUnaskedDenyResult(result.customMessage, `Damocles could not ask the user to approve the skill "${skillName}", so it was denied`);
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
    if (!toolUseId) {
      return { approved: false, customMessage: 'Cannot request skill approval: no tool use ID' };
    }

    const postMessage = this.getPostMessage();
    if (!postMessage) {
      return { approved: false, customMessage: 'Cannot request skill approval: webview not available' };
    }

    return new Promise<SkillApprovalResult>((resolve) => {
      const abortHandler = () => {
        this.state.removePendingSkillApproval(toolUseId);
        resolve({ approved: false, customMessage: ABORTED_BEFORE_ANSWER });
      };

      const cleanup = () => {
        context.signal.removeEventListener('abort', abortHandler);
      };

      const request: ExtensionToWebviewMessage = {
        type: 'requestSkillApproval',
        toolUseId,
        skillName,
        ...(skillDescription !== undefined ? { skillDescription } : {}),
        ...(context.parentToolUseId !== undefined ? { parentToolUseId: context.parentToolUseId } : {}),
      };

      registerAbortablePrompt({
        signal: context.signal,
        toolUseId,
        register: () => {
          this.state.addPendingSkillApproval(toolUseId, { resolve, cleanup, request });
          postMessage(request);
        },
        onAborted: abortHandler,
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
      userAnswered: true,
      ...(options?.approvalMode !== undefined ? { approvalMode: options.approvalMode } : {}),
      ...(options?.customMessage !== undefined ? { customMessage: options.customMessage } : {}),
    });
  }
}
