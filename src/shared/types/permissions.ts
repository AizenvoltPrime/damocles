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

/**
 * Who raised a prompt, as core resolved it when the prompt was raised: the chat's own agent, a subagent by its
 * record id, or a member of the chat's running team. The team's names are model text, sanitized at capture.
 */
export type PromptOwner =
  | { readonly kind: 'main' }
  | { readonly kind: 'subagent'; readonly agentId: string }
  | { readonly kind: 'team'; readonly teamId: string; readonly agentId: string; readonly teamTitle?: string; readonly agentName?: string };

/** The permission state that approved an open prompt because it no longer asks for that call: a mode, or YOLO. */
export type PromptApprover = 'default' | 'acceptEdits' | 'plan' | 'yolo';

/** An unanswered prompt and who raised it, as the session state names it. */
export interface PendingPromptOwner {
  readonly id: string;
  readonly owner: PromptOwner;
}

export interface PendingPermissionInfo {
  toolUseId: string;
  owner: PromptOwner;
  toolName: string;
  /** What the generic prompt shows for a tool with no dedicated view. */
  toolInput?: Record<string, unknown>;
  filePath?: string;
  /** GenerateImage only: the text sent to the image model. */
  prompt?: string;
  /** GenerateImage only: the OpenRouter image model the call is billed for. */
  imageModel?: string;
  /** Edit and Write: the change's patch with real line numbers, or why there is none. */
  patch?: string;
  patchOmitted?: import('./file-patch').FilePatchOmitted;
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
