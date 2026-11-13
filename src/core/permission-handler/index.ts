import { randomUUID } from 'node:crypto';
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
import { DesignVersionManager, type DesignVersionAsk } from './managers/design-version-manager';
import { DesignApprovalManager, type DesignApprovalAsk } from './managers/design-approval-manager';
import type { DesignApprovalChoice, DesignVersionChoice } from '../../shared/types/design';
import type { ElicitationRequest, ElicitationResult } from '../../shared/types/elicitation';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { LocalizedText } from '../../shared/localized-text';
import type { PermissionMode } from '../../shared/types/settings';
import type { PermissionUpdate, PromptApprover, PromptOwner, Question } from '../../shared/types/permissions';
import { log } from '../logger';
import { bypassAllowed, hostDefaultMode } from '../client-snapshots';
import type { PermissionResult, CanUseToolContext, SettledApproval, McpToolIdentity, ChatPermissions, MatchRuleOptions, DesignApprovalAnswer } from './types';
import { buildUnaskedDenyResult } from './utils';
import type { McpResourceRuleFilter } from './mcp-resource-rule';
import { IMAGE_MODEL_SETTING } from '../pi-session/tools/image-tool-specs';
import type { FormValues } from '../../shared/types/forms';
import type { RaisedPrompt } from '../pi-session/session-state';
import { TOOL_EXIT_PLAN_MODE, TOOL_ASK_USER_QUESTION, TOOL_BROWSER_REQUEST_INPUT, TOOL_EDIT, TOOL_WRITE, TOOL_GENERATE_IMAGE, TOOL_SKILL, isShellTool } from '../../shared/tool-names';

export type { PermissionResult, CanUseToolContext, ChatPermissions };

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
  private designVersionManager: DesignVersionManager;
  private designApprovalManager: DesignApprovalManager;
  private readonly platform: Platform;
  private onPlanModeActivated: (() => Promise<void>) | null = null;
  private fixedMode: () => boolean = () => false;
  private onPermissionsChanged: (() => void) | null = null;

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
      getPostMessage,
      () => bypassAllowed(platform),
    );
    this.evaluatorManager = new EvaluatorManager(this.state, platform);
    this.elicitationManager = new ElicitationManager(this.state, getPostMessage);
    this.designVersionManager = new DesignVersionManager(this.state, getPostMessage);
    this.designApprovalManager = new DesignApprovalManager(this.state, getPostMessage);

    // a daemon's core starts a new chat in the mode the acting client configured for this host, else the settings' default
    this.state.permissionMode = hostDefaultMode(platform) ?? platform.settings.get<PermissionMode>('damocles.permissionMode', 'default', settingsFolder);
    this.state.dangerouslySkipPermissions = this.allowedBypass(platform.settings.get<boolean>('damocles.dangerouslySkipPermissions', false, settingsFolder));
  }

  // Every write of YOLO passes here: a daemon's core keeps it off while the pinned client's policy refuses it, whichever
  // door it came through (a settings file, a restore's permissions, a fork, the setter).
  private allowedBypass(requested: boolean): boolean {
    if (!requested || bypassAllowed(this.platform)) return requested;
    log('[PermissionHandler] YOLO refused: the policy of this host does not allow it');
    return false;
  }

  /** Every mode change goes through here, so open prompts the new mode would not ask about are approved. */
  setPermissionMode(mode: PermissionMode): void {
    this.state.permissionMode = mode;
    this.onPermissionsChanged?.();
    this.approveUnaskedPrompts();
  }

  getPermissionMode(): PermissionMode {
    return this.state.permissionMode;
  }

  /** The mode the pinned (else acting) client's turn runs in, which every plan mode check reads; differs from the chat's only for a refused YOLO. */
  turnPermissionMode(): PermissionMode {
    return this.evaluatorManager.mode();
  }

  /** False when the host's policy refused YOLO, which then stays off. */
  setDangerouslySkipPermissions(enabled: boolean): boolean {
    const allowed = this.allowedBypass(enabled);
    this.state.dangerouslySkipPermissions = allowed;
    this.onPermissionsChanged?.();
    this.approveUnaskedPrompts();
    return allowed === enabled;
  }

  getPermissions(): ChatPermissions {
    return { permissionMode: this.state.permissionMode, dangerouslySkipPermissions: this.state.dangerouslySkipPermissions };
  }

  /** Called after every change of the mode or YOLO, including a new conversation's YOLO reset. */
  setPermissionsListener(fn: (() => void) | null): void {
    this.onPermissionsChanged = fn;
  }

  /**
   * Start a fresh conversation's permissions: YOLO back to the workspace default and every session-scoped
   * approval dropped, so none outlives the conversation or folder it was granted in. The mode stays.
   */
  resetForNewConversation(settingsFolder: SettingsFolder | undefined): void {
    // Open prompts belong to the conversation being replaced, so this YOLO change never approves them.
    this.state.dangerouslySkipPermissions = this.allowedBypass(this.platform.settings.get<boolean>('damocles.dangerouslySkipPermissions', false, settingsFolder));
    this.onPermissionsChanged?.();
    this.dropSessionApprovals();
  }

  /** Drop every session-scoped approval, which belongs to the folder it was granted in; the mode and YOLO stay. */
  dropSessionApprovals(): void {
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

  /** "Always allow" is saving a rule: the chat's next call is decided by the files as `save` leaves them. */
  savingPermissionRules(save: Promise<unknown>): void {
    this.evaluatorManager.savingRules(save);
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

  /**
   * Raises the token broker's Sign-in needed prompt for a turn whose device is away, or whose device's sign-ins are not known
   * yet (reason says why); disposing it (the wait ended) tells the webview. continueWith and cancel are the broker's.
   */
  raiseSignIn(provider: string, actions: { readonly continueWith: (clientId: string) => void; readonly cancel: () => void }, reason?: LocalizedText): { dispose(): void } {
    const requestId = `signin-${randomUUID()}`;
    const request = { type: 'signInRequest' as const, requestId, provider, ...(reason !== undefined ? { reason } : {}) };
    this.state.addPendingSignIn(requestId, { request, ...actions });
    this.state.postMessageToWebview?.(request);
    return {
      dispose: () => {
        if (!this.state.pendingSignIns.has(requestId)) return;
        this.state.removePendingSignIn(requestId);
        this.state.postMessageToWebview?.({ type: 'signInResolved', requestId });
      },
    };
  }

  /** "Continue with my sign-in" clicked: the turn moves to the device whose view sent the click, never to any other. */
  continueWithSignIn(requestId: string): void {
    const signIn = this.state.pendingSignIns.get(requestId);
    const clientId = this.platform.remote?.clients.actor();
    if (signIn === undefined || clientId === undefined) {
      log('[PermissionHandler] Continue with my sign-in for %s: %s', requestId, signIn === undefined ? 'no such prompt is open' : 'the click names no device');
      return;
    }
    signIn.continueWith(clientId);
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

  /** Fixes the chat's mode at default while `fixed` (a design chat, PD-25): no mode change and no plan mode. */
  setModeFixed(fixed: () => boolean): void {
    this.fixedMode = fixed;
  }

  /** The questions of the open AskUserQuestion prompt `toolUseId`, else undefined. */
  openQuestions(toolUseId: string): readonly Question[] | undefined {
    const request = this.state.pendingQuestions.get(toolUseId)?.request;
    return request?.type === 'requestQuestion' ? request.questions : undefined;
  }

  /** The design folder of a design chat, whose questions take design-kind previews (PD-18); undefined for any other chat. */
  setDesignQuestionFolder(folder: () => string | undefined): void {
    this.questionManager.setDesignFolder(folder);
  }

  /** The chat's mode is fixed at default; a mode change is ignored. */
  modeFixed(): boolean {
    return this.fixedMode();
  }

  async activatePlanMode(): Promise<void> {
    if (this.state.permissionMode === 'plan' || this.fixedMode()) {
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

  /** The behavior of the settings rule the call matches, or null when none does or YOLO is on; `ignoreBypass` as `EvaluatorManager.matchRule`. */
  async matchRule(toolName: string, input: Record<string, unknown>, mcpTool?: McpToolIdentity, options: MatchRuleOptions = {}): Promise<'allow' | 'deny' | 'ask' | null> {
    return this.evaluatorManager.matchRule(toolName, input, this.state.workspacePath, mcpTool, options);
  }

  /** The session cwd, which a tool resolves a relative path against. */
  sessionCwd(): string {
    return this.evaluatorManager.sessionCwd();
  }

  /** `evaluatePermission` for a call whose settings rule is already known, under the current mode and YOLO; `requiresUser` and `reachesNetwork` as `EvaluatorManager.decide`. */
  decide(toolName: string, input: Record<string, unknown>, rule: 'allow' | 'deny' | 'ask' | null, requiresUser = false, reachesNetwork = false): 'allow' | 'deny' | 'ask' {
    return this.evaluatorManager.decide(toolName, input, rule, requiresUser, reachesNetwork);
  }

  /** Whether a `Read` deny or ask rule covers a file, for Grep and Glob to leave it out of their results. */
  async readRuleFilter(): Promise<(filePath: string) => boolean> {
    return this.evaluatorManager.readRuleFilter(this.state.workspacePath);
  }

  /** Whether a deny or ask `WebFetch(domain:…)` rule covers a URL's host, which WebFetch and ImportAsset then never contact on a step of their own. */
  async webHostFilter(): Promise<(url: string) => boolean> {
    return this.evaluatorManager.webHostFilter(this.state.workspacePath);
  }

  /** What the settings rules hide from an MCP resource list call of `toolName` (`McpResourceRuleFilter`). */
  async mcpResourceRuleFilter(toolName: string): Promise<McpResourceRuleFilter> {
    return this.evaluatorManager.mcpResourceRuleFilter(toolName, this.state.workspacePath);
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
    if (toolName === TOOL_EXIT_PLAN_MODE && this.turnPermissionMode() === 'plan') {
      return this.planManager.handleExitPlanMode(input, context);
    }

    if (toolName === TOOL_ASK_USER_QUESTION) {
      return this.questionManager.handleQuestion(input, context);
    }

    if (toolName === TOOL_BROWSER_REQUEST_INPUT) {
      return this.formManager.handleForm(input, context);
    }

    const evaluation = context.requiresUser
      ? this.decide(toolName, input, context.rule, true)
      : context.rule !== undefined
        ? this.decide(toolName, input, context.rule, false, context.reachesNetwork === true)
        : await this.evaluatePermission(toolName, input, context.mcpTool);

    if (evaluation === 'allow') {
      return { behavior: 'allow', updatedInput: input };
    }

    if (evaluation === 'deny') {
      return buildUnaskedDenyResult(undefined, 'Permission denied by settings rule');
    }

    // Its diff would read the file, which on a network host sends the user's Windows credentials there before they answer.
    if ((toolName === TOOL_EDIT || toolName === TOOL_WRITE) && context.reachesNetwork !== true) {
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

  /** Raises the version pause's prompt (PD-29) until the user answers or `signal` aborts (undefined). */
  requestDesignVersionDecision(ask: DesignVersionAsk, signal: AbortSignal): Promise<DesignVersionChoice | undefined> {
    return this.designVersionManager.requestDesignVersionDecision(ask, signal);
  }

  resolveDesignVersionDecision(promptId: string, choice: DesignVersionChoice): void {
    this.designVersionManager.resolveDesignVersionDecision(promptId, choice);
  }

  /** Raises FinishDesign's approval prompt until the user answers or `signal` aborts (undefined); in every mode, YOLO included. */
  requestDesignApproval(ask: DesignApprovalAsk, signal: AbortSignal): Promise<DesignApprovalAnswer | undefined> {
    return this.designApprovalManager.requestDesignApproval(ask, signal);
  }

  resolveDesignApproval(promptId: string, choice: DesignApprovalChoice, feedback: string | undefined): void {
    this.designApprovalManager.resolveDesignApproval(promptId, choice, feedback);
  }

  async dispose(): Promise<void> {
    this.state.clearAll();
    this.evaluatorManager.dispose();
    await this.diffManager.dispose();
  }
}
