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
      mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
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
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface PendingQuestionInfo {
  toolUseId: string;
  questions: Question[];
  parentToolUseId?: string | null;
  agentDescription?: string;
}
