import type { Platform } from '../../platform/platform';
import type { SettingsFolder } from '../../platform/settings-store';
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
import type { PermissionResult, CanUseToolContext, SettledApproval, McpToolIdentity } from './types';
import { buildUnaskedDenyResult } from './utils';
import { IMAGE_MODEL_SETTING } from '../pi-session/tools/image-tool-specs';
import type { FormValues } from '../../shared/types/forms';
import type { PendingKind } from '../pi-session/session-state';
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
  private subagentManager: SubagentManager;
  private evaluatorManager: EvaluatorManager;
  private elicitationManager: ElicitationManager;
  private readonly platform: Platform;

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
    this.subagentManager = new SubagentManager(
      this.state,
      this.diffManager,
      getPostMessage
    );
    this.evaluatorManager = new EvaluatorManager(this.state, platform);
    this.elicitationManager = new ElicitationManager(this.state, getPostMessage);

    this.state.permissionMode = platform.settings.get<PermissionMode>('damocles.permissionMode', 'default', settingsFolder);
    this.state.dangerouslySkipPermissions = platform.settings.get<boolean>('damocles.dangerouslySkipPermissions', false, settingsFolder);
  }

  setPermissionMode(mode: PermissionMode): void {
    this.state.permissionMode = mode;
  }

  getPermissionMode(): PermissionMode {
    return this.state.permissionMode;
  }

  setDangerouslySkipPermissions(enabled: boolean): void {
    this.state.dangerouslySkipPermissions = enabled;
  }

  /**
   * Start a fresh conversation's permissions: YOLO back to the workspace default and every session-scoped
   * approval dropped, so none outlives the conversation or folder it was granted in. The mode stays.
   */
  resetForNewConversation(settingsFolder: SettingsFolder | undefined): void {
    this.state.dangerouslySkipPermissions = this.platform.settings.get<boolean>('damocles.dangerouslySkipPermissions', false, settingsFolder);
    this.state.autoApprovedSkills.clear();
    this.state.autoApprovedSubagents.clear();
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

  /** The kinds of the unanswered prompts on this panel's `PermissionState`; empty when none is open. */
  pendingPromptKinds(): Set<PendingKind> {
    return this.state.pendingKinds();
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

  /** The panel's project folder, or null when it has no project scope; project rules and skills load from it. */
  setWorkspacePath(workspacePath: string | null): void {
    this.state.workspacePath = workspacePath;
  }

  /** The panel session's cwd, which file rules resolve `file_path` against exactly as the tools do. */
  setCwd(cwd: string): void {
    this.state.cwd = cwd;
  }

  /**
   * Lightweight evaluation for PreToolUse hook.
   * Only returns allow/deny for definitive pattern matches.
   * Returns 'ask' for everything else, letting SDK's canUseTool handle prompts.
   */
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

    const evaluation = await this.evaluatorManager.evaluate(toolName, input, this.state.workspacePath, context.mcpTool);

    if (evaluation === 'allow') {
      return { behavior: 'allow', updatedInput: input };
    }

    if (evaluation === 'deny') {
      return buildUnaskedDenyResult(undefined, 'Permission denied by settings rule');
    }

    // An ask rule prompts even for a subagent whose edits the user accepted.
    const askRule = (await this.evaluatorManager.matchRule(toolName, input, this.state.workspacePath, context.mcpTool)) === 'ask';

    if (toolName === TOOL_EDIT || toolName === TOOL_WRITE) {
      return this.approvalManager.handleFilePermission(toolName, input, context, askRule);
    }

    if (toolName === TOOL_GENERATE_IMAGE) {
      return this.approvalManager.handleImagePermission(input, context, this.platform.settings.get<string>(IMAGE_MODEL_SETTING, ''));
    }

    if (isShellTool(toolName)) {
      return this.approvalManager.handleShellPermission(toolName, input, context, askRule);
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
