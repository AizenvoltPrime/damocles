import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { PermissionMode } from '../../shared/types/settings';
import type { PermissionUpdate, QuestionAnnotations } from '../../shared/types/permissions';
import type { FormValues } from '../../shared/types/forms';

export interface PermissionResult {
  behavior: 'allow' | 'deny';
  message?: string;
  updatedInput?: unknown;
  interrupt?: boolean;
  updatedPermissions?: PermissionUpdate[];
}

export interface CanUseToolContext {
  signal: AbortSignal;
  toolUseID: string | null;
  agentID?: string;
  parentToolUseId?: string | null;
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
  decisionReason?: string;
}

export interface ApprovalResult {
  approved: boolean;
  customMessage?: string;
  updatedPermissions?: PermissionUpdate[];
}

export interface PendingApproval {
  resolve: (result: ApprovalResult) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  diffId?: string;
  parentToolUseId?: string | null;
}

export interface QuestionResult {
  approved: boolean;
  answers?: Record<string, string>;
  annotations?: QuestionAnnotations;
}

export interface PendingQuestion {
  resolve: (result: QuestionResult) => void;
  cleanup: () => void;
}

/**
 * Result of the `BrowserRequestInput` form prompt (in-process only). `values` is present only on
 * submit and is keyed by `FormFieldSchema.id`; it is read into the tool's `execute` local scope and
 * injected into the live page, then discarded. It is NEVER persisted, logged, or returned to the model.
 */
export interface FormResolveResult {
  approved: boolean;
  values?: FormValues;
}

/**
 * A pending `BrowserRequestInput` form awaiting the user's answer. Same shape family as
 * `PendingQuestion` so it satisfies the `clearAll` cleanup contract (`resolve({ approved: false })`).
 */
export interface PendingForm {
  resolve: (result: FormResolveResult) => void;
  cleanup: () => void;
}

export interface PlanApprovalResult {
  approved: boolean;
  approvalMode?: 'acceptEdits' | 'manual';
  feedback?: string;
}

export interface PendingPlanApproval {
  resolve: (result: PlanApprovalResult) => void;
  cleanup: () => void;
}

export interface SkillApprovalResult {
  approved: boolean;
  approvalMode?: 'acceptEdits' | 'manual';
  customMessage?: string;
}

export interface PendingSkillApproval {
  resolve: (result: SkillApprovalResult) => void;
  cleanup: () => void;
}

export type PostMessageFn = (msg: ExtensionToWebviewMessage) => void;

/**
 * The "agent is blocked waiting for your approval" signal (US-009, the Claude Code Notification
 * analogue). Emitted only at the two real wait points (file Edit/Write, shell Bash/PowerShell); the
 * implementation (PiSession) maps it onto the `permission_required` hook and is a no-op when none is
 * configured. Auto-resolved approvals never reach the wait points, so this never false-alarms.
 */
export interface PermissionRequiredInfo {
  toolName: string;
  toolInput: Record<string, unknown>;
  message: string;
  filePath?: string;
  command?: string;
  parentToolUseId?: string;
}

export type PermissionRequiredNotifier = (info: PermissionRequiredInfo) => void;

export type { PermissionMode };
