import type { LocalizedText } from '../localized-text';
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

/** One line of a generic prompt's facts list: a forge write names its server, project and account. */
export interface PermissionFact {
  label: LocalizedText;
  /** Data, never translated: a server host, a repository path or a login. */
  value: string;
  /** Data shown muted after the value: the server's host, or the merge request, job or issue title. */
  detail?: string;
  /** Set on an account's fact, which shows its picture (app://damocles/forge/avatar/<key>) when a key is given, else its initial. */
  avatar?: { key?: string };
  /** Words shown muted after the value, such as how the account was chosen. */
  note?: LocalizedText;
}

/** Text a write sends, shown as plain text in a scrollable box, never rendered as HTML; already redacted and bounded by core. */
export interface PermissionContent {
  label: LocalizedText;
  text: string;
}

/** What a generic prompt shows in words beside the tool's input; a forge write carries every field (`approvalOf`, `src/core/forge/tools/run.ts`). */
export interface PermissionDetail {
  /** The action as a question, such as "Comment on merge request !45?". */
  title?: LocalizedText;
  /** Shown after the tool name, such as "writes to the server as you". */
  subtitle?: LocalizedText;
  facts?: PermissionFact[];
  content?: PermissionContent;
  /** Option 2's label; its rule is the request's `suggestions`. */
  alwaysAllowLabel?: LocalizedText;
  /** The card's status after Yes, such as "Allowed once. Posting the comment to !45 as <login> on <server>." */
  approvedStatus?: LocalizedText;
}

export interface PendingPermissionInfo extends PermissionDetail {
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

/** Model input reaches this type only through `parseQuestionPreview` (src/shared/question-preview.ts). */
export type QuestionPreview = { kind: 'markdown'; content: string } | { kind: 'design'; path: string };

export interface QuestionOption {
  label: string;
  description: string;
  preview?: QuestionPreview;
}

/** `preview`: a single-select answer's; `previews`: a multi-select answer's, by option label. */
export type QuestionAnnotations = Record<string, { preview?: QuestionPreview; previews?: Record<string, QuestionPreview>; notes?: string }>;

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface PersistedQuestionOption {
  label: string;
  description?: string;
  preview?: QuestionPreview;
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
