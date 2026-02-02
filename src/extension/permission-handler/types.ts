import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { PermissionMode } from '../../shared/types/settings';

export interface PermissionResult {
  behavior: 'allow' | 'deny';
  message?: string;
  updatedInput?: unknown;
  interrupt?: boolean;
}

export interface CanUseToolContext {
  signal: AbortSignal;
  toolUseID: string | null;
  agentID?: string;
  parentToolUseId?: string | null;
}

export interface ApprovalResult {
  approved: boolean;
  customMessage?: string;
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
}

export interface PendingQuestion {
  resolve: (result: QuestionResult) => void;
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

export type { PermissionMode };
