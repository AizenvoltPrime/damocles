import type { Platform } from '../../platform/platform';
import type { SettingsFolder } from '../../platform/settings-store';
import { DiffManager } from './diff-manager';
import { PermissionState } from './state';
import { ApprovalManager } from './managers/approval-manager';
import { QuestionManager } from './managers/question-manager';
import { FormManager } from './managers/form-manager';
import { PlanManager } from './managers/plan-manager';
import { SkillManager } from './managers/skill-manager';
import { EvaluatorManager } from './managers/evaluator-manager';
import { ElicitationManager } from './managers/elicitation-manager';
import type { ElicitationRequest, ElicitationResult } from '../../shared/types/elicitation';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { PermissionMode } from '../../shared/types/settings';
import type { PermissionUpdate, PromptApprover, PromptOwner } from '../../shared/types/permissions';
import { log } from '../logger';
import type { PermissionResult, CanUseToolContext, SettledApproval, McpToolIdentity } from './types';
import { buildUnaskedDenyResult } from './utils';
import { IMAGE_MODEL_SETTING } from '../pi-session/tools/image-tool-specs';
import type { FormValues } from '../../shared/types/forms';
import type { RaisedPrompt } from '../pi-session/session-state';
import { TOOL_EXIT_PLAN_MODE, TOOL_ASK_USER_QUESTION, TOOL_BROWSER_REQUEST_INPUT, TOOL_EDIT, TOOL_WRITE, TOOL_GENERATE_IMAGE, TOOL_SKILL, isShellTool } from '../../shared/tool-names';

export type { PermissionResult, CanUseToolContext };

export class PermissionHandler {
  private state: PermissionState;
  private diffManager: DiffManager;
  private approvalManager: ApprovalManager;
  private questionManager: QuestionManager;
  private formManager: FormManager;
  private planManager: PlanManager;
  private skillManager: SkillManager;
  private evaluatorManager: EvaluatorManager;
  private elicitationManager: ElicitationManager;
  private readonly platform: Platform;
  private onPlanModeActivated: (() => Promise<void>) | null = null;

  // panelId is the chat panel this handler belongs to; proposal diffs are shown there on hosts that render editors in the panel.
  /** `settingsFolder` is the chat's folder, whose permission-mode and YOLO defaults seed this handler. */
  constructor(platform: Platform, panelId?: string, settingsFolder?: SettingsFolder) {
    this.platform = platform;
    this.state = new PermissionState();
    this.diffManager = new DiffManager(platform.editor, panelId);

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
    this.evaluatorManager = new EvaluatorManager(this.state, platform);
    this.elicitationManager = new ElicitationManager(this.state, getPostMessage);

    this.state.permissionMode = platform.settings.get<PermissionMode>('damocles.permissionMode', 'default', settingsFolder);
    this.state.dangerouslySkipPermissions = platform.settings.get<boolean>('damocles.dangerouslySkipPermissions', false, settingsFolder);
  }

  /** Every mode change goes through here, so open prompts the new mode would not ask about are approved. */
  setPermissionMode(mode: PermissionMode): void {
    this.state.permissionMode = mode;
    this.approveUnaskedPrompts();
  }

  getPermissionMode(): PermissionMode {
    return this.state.permissionMode;
  }

  setDangerouslySkipPermissions(enabled: boolean): void {
    this.state.dangerouslySkipPermissions = enabled;
    this.approveUnaskedPrompts();
  }

  /**
   * Start a fresh conversation's permissions: YOLO back to the workspace default and every session-scoped
   * approval dropped, so none outlives the conversation or folder it was granted in. The mode stays.
   */
  resetForNewConversation(settingsFolder: SettingsFolder | undefined): void {
    // Open prompts belong to the conversation being replaced, so this YOLO change never approves them.
    this.state.dangerouslySkipPermissions = this.platform.settings.get<boolean>('damocles.dangerouslySkipPermissions', false, settingsFolder);
    this.state.autoApprovedSkills.clear();
  }

  /**
   * Approve every open approval and skill prompt whose call the gate would now run unasked
   * (`CanUseToolContext.runsUnasked`), as the user's yes would. A check that throws leaves its prompt open.
   */
  private approveUnaskedPrompts(): void {
    const approvedBy: PromptApprover = this.state.dangerouslySkipPermissions ? 'yolo' : this.state.permissionMode;
    const runsUnasked = (id: string, pending: { runsUnasked?: () => boolean }): boolean => {
      try {
        return pending.runsUnasked?.() ?? false;
      } catch (err) {
        log('[PermissionHandler] re-checking open prompt %s failed, leaving it open: %O', id, err);
        return false;
      }
    };
    let approved = 0;
    for (const [id, pending] of [...this.state.pendingApprovals]) {
      if (!runsUnasked(id, pending)) continue;
      approved++;
      void this.approvalManager.approveUnasked(id, approvedBy);
    }
    for (const [id, pending] of [...this.state.pendingSkillApprovals]) {
      if (!runsUnasked(id, pending)) continue;
      approved++;
      this.skillManager.approveUnasked(id, approvedBy);
    }
    if (approved > 0) log('[PermissionHandler] %s approved %d open prompts', approvedBy, approved);
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

  /** Wire the session-state publisher to every pending-prompt change. Supplied by PiSession. */
  setPendingPromptsListener(fn: (() => void) | null): void {
    this.state.onPendingChanged = fn;
  }

  /** Wire who raised each prompt, resolved as it is raised and stated on its message. Supplied by PiSession. */
  setPromptOwnerResolver(fn: ((parentToolUseId: string | null | undefined) => PromptOwner) | null): void {
    this.state.promptOwnerResolver = fn;
  }

  /** The unanswered prompts on this panel's `PermissionState`, in the order raised. */
  pendingPrompts(): RaisedPrompt[] {
    return this.state.pendingPrompts();
  }

  /**
   * Post every live prompt again, for a webview that restarted and came back with an empty dialog
   * store while the awaiters behind those dialogs are still blocked.
   *
   * Each entry carries the exact message it was first posted with, so nothing is rebuilt and a
   * re-posted prompt cannot drift from what its awaiter is waiting on. The dialogs go back in the
   * order they were raised.
   */
  repostPendingPrompts(): void {
    const postMessage = this.state.postMessageToWebview;
    if (!postMessage) return;
    for (const request of this.state.pendingPromptRequests.values()) {
      postMessage(request);
    }
  }

  /** Wire the canonical plan reader (the session's on-disk plan); used to source plan approval/handoff
   *  from the file instead of the ExitPlanMode summary. Supplied by PiSession. */
  setPlanContentResolver(fn: () => Promise<string | null>): void {
    this.planManager.setPlanContentResolver(fn);
  }

  setOnPlanModeActivated(callback: () => Promise<void>): void {
    this.onPlanModeActivated = callback;
  }

  async activatePlanMode(): Promise<void> {
    if (this.state.permissionMode === 'plan') {
      return;
    }

    this.setPermissionMode('plan');

    try {
      await this.onPlanModeActivated?.();
    } catch (err) {
      log('[PermissionHandler] activatePlanMode callback failed:', err);
    }
  }

  preApproveSkill(skillName: string): void {
    this.skillManager.preApproveSkill(skillName);
  }

  revokeSkillPreApproval(skillName: string): void {
    this.skillManager.revokeSkillPreApproval(skillName);
  }

  /** The panel's project folder, or null when it has no project scope; project rules and skills load from it. */
  setWorkspacePath(workspacePath: string | null): void {
    this.state.workspacePath = workspacePath;
  }

  /** The panel session's cwd, which file rules resolve `file_path` against exactly as the tools do. */
  setCwd(cwd: string): void {
    this.state.cwd = cwd;
  }

  /** The evaluator's verdict on a call: the settings rule it matches, then YOLO, the mode and the tool defaults. */
  async evaluatePermission(
    toolName: string,
    input: Record<string, unknown>,
    mcpTool?: McpToolIdentity,
  ): Promise<'allow' | 'deny' | 'ask'> {
    return this.evaluatorManager.evaluate(toolName, input, this.state.workspacePath, mcpTool);
  }

  /** The behavior of the settings rule the call matches, or null when none does or YOLO is on. */
  async matchRule(toolName: string, input: Record<string, unknown>, mcpTool?: McpToolIdentity): Promise<'allow' | 'deny' | 'ask' | null> {
    return this.evaluatorManager.matchRule(toolName, input, this.state.workspacePath, mcpTool);
  }

  /** `evaluatePermission` for a call whose settings rule is already known, under the current mode and YOLO. */
  decide(toolName: string, input: Record<string, unknown>, rule: 'allow' | 'deny' | 'ask' | null): 'allow' | 'deny' | 'ask' {
    return this.evaluatorManager.decide(toolName, input, rule);
  }

  /** Whether a `Read` deny or ask rule covers a file, for Grep and Glob to leave it out of their results. */
  async readRuleFilter(): Promise<(filePath: string) => boolean> {
    return this.evaluatorManager.readRuleFilter(this.state.workspacePath);
  }

  /** Whether an Edit or Write of `filePath` targets a plan file, resolved against the session cwd. */
  isPlanFile(filePath: string): boolean {
    return this.evaluatorManager.isPlanFile(filePath);
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

    const evaluation = context.rule !== undefined
      ? this.decide(toolName, input, context.rule)
      : await this.evaluatePermission(toolName, input, context.mcpTool);

    if (evaluation === 'allow') {
      return { behavior: 'allow', updatedInput: input };
    }

    if (evaluation === 'deny') {
      return buildUnaskedDenyResult(undefined, 'Permission denied by settings rule');
    }

    if (toolName === TOOL_EDIT || toolName === TOOL_WRITE) {
      return this.approvalManager.handleFilePermission(toolName, input, context);
    }

    if (toolName === TOOL_GENERATE_IMAGE) {
      return this.approvalManager.handleImagePermission(input, context, this.platform.settings.get<string>(IMAGE_MODEL_SETTING, ''));
    }

    if (isShellTool(toolName)) {
      return this.approvalManager.handleShellPermission(toolName, input, context);
    }

    if (toolName === TOOL_SKILL) {
      return this.skillManager.handleSkillApproval(input, context);
    }

    return this.approvalManager.handleToolPermission(toolName, input, context);
  }

  /** The image model the user approved for this GenerateImage call, removed as it is read; undefined when no prompt ran. */
  takeApprovedImageModel(toolUseId: string): string | undefined {
    const model = this.state.approvedImageModels.get(toolUseId);
    this.state.approvedImageModels.delete(toolUseId);
    return model;
  }

  async resolveApproval(
    toolUseId: string,
    approved: boolean,
    options?: { customMessage?: string; updatedPermissions?: PermissionUpdate[] }
  ): Promise<SettledApproval | null> {
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
    this.evaluatorManager.dispose();
    await this.diffManager.dispose();
  }
}
