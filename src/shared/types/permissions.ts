export type PermissionBehavior = 'allow' | 'deny' | 'ask';
export type PermissionUpdateDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session';

export interface PermissionRuleValue {
  toolName: string;
  ruleContent?: string;
}

export type PermissionUpdate =
  | {
      type: 'addRules';
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: 'setMode';
      mode: 'default' | 'acceptEdits' | 'plan';
      destination: PermissionUpdateDestination;
    };

export interface PendingPermissionInfo {
  toolUseId: string;
  toolName: string;
  filePath?: string;
  originalContent?: string;
  proposedContent?: string;
  command?: string;
  parentToolUseId?: string | null;
  agentDescription?: string;
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
  decisionReason?: string;
}

export const ASK_USER_QUESTION_LIMITS = {
  MIN_QUESTIONS: 1,
  MAX_QUESTIONS: 4,
  MIN_OPTIONS: 2,
  MAX_OPTIONS: 4,
  MAX_HEADER_LENGTH: 12,
} as const;

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export type QuestionAnnotations = Record<string, { preview?: string; notes?: string }>;

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface PersistedQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface PersistedQuestion {
  question: string;
  header?: string;
  options: PersistedQuestionOption[];
  multiSelect?: boolean;
}

export interface PendingQuestionInfo {
  toolUseId: string;
  questions: Question[];
  parentToolUseId?: string | null;
  agentDescription?: string;
}
