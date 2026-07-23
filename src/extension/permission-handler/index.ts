import * as vscode from 'vscode';
import { DiffManager } from './diff-manager';
import { PermissionState } from './state';
import { ApprovalManager } from './managers/approval-manager';
import { QuestionManager } from './managers/question-manager';
import { FormManager } from './managers/form-manager';
import { PlanManager } from './managers/plan-manager';
import { SkillManager } from './managers/skill-manager';
import { SubagentManager } from './managers/subagent-manager';
import { EvaluatorManager } from './managers/evaluator-manager';
import { ElicitationManager } from './managers/elicitation-manager';
import type { ElicitationRequest, ElicitationResult } from '../../shared/types/elicitation';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { PermissionMode } from '../../shared/types/settings';
import type { PermissionUpdate } from '../../shared/types/permissions';
import type { PermissionResult, CanUseToolContext } from './types';
import type { FormValues } from '../../shared/types/forms';
import { TOOL_EXIT_PLAN_MODE, TOOL_ASK_USER_QUESTION, TOOL_BROWSER_REQUEST_INPUT, TOOL_EDIT, TOOL_WRITE, TOOL_SKILL, isShellTool } from '../../shared/tool-names';

export type { PermissionResult, CanUseToolContext };

export class PermissionHandler {
  private state: PermissionState;
  private diffManager: DiffManager;
  private approvalManager: ApprovalManager;
  private questionManager: QuestionManager;
  private formManager: FormManager;
  private planManager: PlanManager;
  private skillManager: SkillManager;
  private subagentManager: SubagentManager;
  private evaluatorManager: EvaluatorManager;
  private elicitationManager: ElicitationManager;

  constructor(_extensionUri: vscode.Uri) {
    this.state = new PermissionState();
    this.diffManager = new DiffManager();

    const getPostMessage = () => this.state.postMessageToWebview;

    this.approvalManager = new ApprovalManager(
      this.state,
      this.diffManager,
      getPostMessage,
      () => this.state.permissionRequiredNotifier
    );
    this.questionManager = new QuestionManager(
      this.state,
      getPostMessage
    );
    this.formManager = new FormManager(this.state, getPostMessage);
    this.planManager = new PlanManager(
      this.state,
      getPostMessage
    );
    this.skillManager = new SkillManager(
      this.state,
      getPostMessage
    );
    this.subagentManager = new SubagentManager(
      this.state,
      this.diffManager,
      getPostMessage
    );
    this.evaluatorManager = new EvaluatorManager(this.state);
    this.elicitationManager = new ElicitationManager(getPostMessage);

    const config = vscode.workspace.getConfiguration('damocles');
    this.state.permissionMode = config.get<PermissionMode>('permissionMode', 'default');
    this.state.dangerouslySkipPermissions = config.get<boolean>('dangerouslySkipPermissions', false);
  }

  setPermissionMode(mode: PermissionMode): void {
    this.state.permissionMode = mode;
  }

  getPermissionMode(): PermissionMode {
    return this.state.permissionMode;
  }

  setSessionAborting(value: boolean): void {
    this.state.sessionAborting = value;
  }

  setDangerouslySkipPermissions(enabled: boolean): void {
    this.state.dangerouslySkipPermissions = enabled;
  }

  /** Reset YOLO to the workspace default — used when a panel starts a fresh conversation (clear/strategy switch). */
  applyDefaultDangerouslySkipPermissions(): void {
    const config = vscode.workspace.getConfiguration('damocles');
    this.state.dangerouslySkipPermissions = config.get<boolean>('dangerouslySkipPermissions', false);
  }

  getDangerouslySkipPermissions(): boolean {
    return this.state.dangerouslySkipPermissions;
  }

  setPostMessage(fn: (msg: ExtensionToWebviewMessage) => void): void {
    this.state.postMessageToWebview = fn;
  }

  /** Wire the `permission_required` notifier (US-009); supplied by PiSession with its sessionId + cwd. */
  setPermissionRequiredNotifier(fn: import('./types').PermissionRequiredNotifier | null): void {
    this.state.permissionRequiredNotifier = fn;
  }

  /** Wire the canonical plan reader (the session's on-disk plan); used to source plan approval/handoff
   *  from the file instead of the ExitPlanMode summary. Supplied by PiSession. */
  setPlanContentResolver(fn: () => Promise<string | null>): void {
    this.planManager.setPlanContentResolver(fn);
  }

  setOnPlanModeActivated(callback: () => Promise<void>): void {
    this.planManager.setOnPlanModeActivated(callback);
  }

  async activatePlanMode(): Promise<void> {
    return this.planManager.activatePlanMode();
  }

  preApproveSkill(skillName: string): void {
    this.skillManager.preApproveSkill(skillName);
  }

  revokeSkillPreApproval(skillName: string): void {
    this.skillManager.revokeSkillPreApproval(skillName);
  }

  autoApproveSubagent(parentToolUseId: string): void {
    this.subagentManager.autoApproveSubagent(parentToolUseId);
  }

  clearSubagentAutoApprovals(): void {
    this.subagentManager.clearSubagentAutoApprovals();
  }

  /**
   * Lightweight evaluation for PreToolUse hook.
   * Only returns allow/deny for definitive pattern matches.
   * Returns 'ask' for everything else, letting SDK's canUseTool handle prompts.
   */
  async evaluatePermission(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<'allow' | 'deny' | 'ask'> {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    return this.evaluatorManager.evaluate(toolName, input, workspacePath);
  }

  async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    context: CanUseToolContext
  ): Promise<PermissionResult> {
    if (toolName === TOOL_EXIT_PLAN_MODE && this.state.permissionMode === 'plan') {
      return this.planManager.handleExitPlanMode(input, context);
    }

    if (toolName === TOOL_ASK_USER_QUESTION) {
      return this.questionManager.handleQuestion(input, context);
    }

    if (toolName === TOOL_BROWSER_REQUEST_INPUT) {
      return this.formManager.handleForm(input, context);
    }

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

    const evaluation = await this.evaluatorManager.evaluate(toolName, input, workspacePath);

    if (evaluation === 'allow') {
      return { behavior: 'allow', updatedInput: input };
    }

    if (evaluation === 'deny') {
      return {
        behavior: 'deny',
        message: 'Permission denied by settings rule',
      };
    }

    if (toolName === TOOL_EDIT || toolName === TOOL_WRITE) {
      return this.approvalManager.handleFilePermission(toolName, input, context);
    }

    if (isShellTool(toolName)) {
      return this.approvalManager.handleShellPermission(toolName, input, context);
    }

    if (toolName === TOOL_SKILL) {
      return this.skillManager.handleSkillApproval(input, context);
    }

    const allowLabel = vscode.l10n.t("Allow");
    const denyLabel = vscode.l10n.t("Deny");
    const result = await vscode.window.showInformationMessage(
      vscode.l10n.t("Damocles wants to use the \"{0}\" tool. Allow?", toolName),
      { modal: true },
      allowLabel,
      denyLabel
    );

    if (result === allowLabel) {
      return { behavior: 'allow', updatedInput: input };
    }

    return {
      behavior: 'deny',
      message: `User denied permission for ${toolName}`,
    };
  }

  async resolveApproval(
    toolUseId: string,
    approved: boolean,
    options?: { customMessage?: string; updatedPermissions?: PermissionUpdate[] }
  ): Promise<void> {
    return this.approvalManager.resolveApproval(toolUseId, approved, options);
  }

  resolveQuestion(toolUseId: string, answers: Record<string, string> | null, annotations?: import('../../shared/types/permissions').QuestionAnnotations): void {
    this.questionManager.resolveQuestion(toolUseId, answers, annotations);
  }

  resolveForm(toolUseId: string, values: FormValues | null): void {
    this.formManager.resolveForm(toolUseId, values);
  }

  resolvePlanApproval(
    toolUseId: string,
    approved: boolean,
    options?: { approvalMode?: 'acceptEdits' | 'manual'; feedback?: string }
  ): void {
    this.planManager.resolvePlanApproval(toolUseId, approved, options);
  }

  resolveSkillApproval(
    toolUseId: string,
    approved: boolean,
    options?: { approvalMode?: 'acceptEdits' | 'manual'; customMessage?: string }
  ): void {
    this.skillManager.resolveSkillApproval(toolUseId, approved, options);
  }

  async requestElicitation(request: ElicitationRequest, signal: AbortSignal): Promise<ElicitationResult> {
    return this.elicitationManager.requestElicitation(request, signal);
  }

  resolveElicitation(elicitationId: string, result: ElicitationResult): void {
    this.elicitationManager.resolveElicitation(elicitationId, result);
  }

  async dispose(): Promise<void> {
    this.state.clearAll();
    this.elicitationManager.clearAll();
    this.evaluatorManager.dispose();
    await this.diffManager.dispose();
  }
}
