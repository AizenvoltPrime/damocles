import type { PermissionDetail, PermissionUpdate } from '../types/permissions';
import type { RemoteEndpoint } from './bindings';

// The agent's GitHub and GitLab tools as they cross processes (docs/invariants.md "GitHub and GitLab accounts", agent
// tools): a call names a working folder's repository by its remote endpoints, never a host; an answer is bounded, redacted and
// masked text, never a token, a temp-file path of this computer or an account's secret.

/** The daemon feature of user.forge.tool and user.forge.describe. */
export const USER_FORGE_FEATURE = 'user.forge';

/** A remote chat's answer while the group is off on the computer that relays it; the model reads it, so it is English. */
export const FORGE_TOOLS_OFF_HERE = 'GitHub and GitLab tools are off on the computer that shows this chat.';

/** The most characters an answer's text carries across a process; the tools cap their output at 20 KB first. */
export const MAX_FORGE_TOOL_TEXT_CHARS: number = 64 * 1024;

/** A chat's repository as its own host's core reads it: the project folder, its remotes and the working folder's branch. */
export interface ForgeRepository {
  /** The project folder: a chat worktree's project, never the worktree. */
  readonly projectPath: string;
  /** The project's name as the refused notice shows it. */
  readonly project: string;
  readonly endpoints: readonly RemoteEndpoint[];
  /** The branch's upstream remote (`%(upstream:remotename)`), not git's push remote. */
  readonly pushRemote?: string;
  readonly branch?: string;
}

/** A chat's repository, or why the tools cannot read it; projectKey: the project's key in the reading core's source control. */
export type ChatRepository = { readonly ok: true; readonly repository: ForgeRepository; readonly projectKey?: string } | { readonly ok: false; readonly text: string };

/**
 * What the gate decided a call acts on: the server, the repository, the account, an opened merge request's branches and
 * fork as its card showed them, and the hash of the text its card showed. The call runs only on this target, and sends
 * nothing when any of them resolves otherwise by then.
 */
export interface ForgeTarget {
  readonly serverId: string;
  readonly repoPath: string;
  readonly accountId: string;
  readonly sourceBranch?: string;
  readonly targetBranch?: string;
  /** An opened merge request's fork on the same server, which the remote pushes to while it fetches repoPath. */
  readonly sourceRepoPath?: string;
  /** SHA-256 (hex) of the text the card showed: a comment's body, a merge request's posted title and description. */
  readonly contentHash?: string;
}

/** What user.forge.describe answers: the target before the gate's rules, with a write's card when asked for. */
export type ForgeDescribeAnswer =
  | { readonly ok: true; readonly project: string; readonly target: ForgeTarget; readonly detail?: PermissionDetail; readonly suggestion?: PermissionUpdate }
  | { readonly ok: false; readonly answer: ForgeToolAnswer };

/** A remote chat's call as its daemon's core sends it (user.forge.tool): the project folder on the host and its remotes. */
export interface RelayedForgeRequest {
  readonly toolCallId: string;
  /** The chat's project folder on the host, which main checks against that host's projects. */
  readonly folder: string;
  readonly endpoints: readonly RemoteEndpoint[];
  /** The branch's upstream remote, as ForgeRepository names it. */
  readonly pushRemote?: string;
  readonly branch?: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** The target the gate decided; absent only for a call no gate resolved (a PreToolUse hook's force-allow). */
  readonly expected?: ForgeTarget;
}

/** One agent tool call on a chat's repository, as the local core runs it. */
export interface ForgeToolRequest {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** 'local', or the remote chat's authority. */
  readonly authorityKey: string;
  /** The chat's project, whose binding and remotes scope the call; absent outside a project. */
  readonly projectKey?: string;
  /** The project's name as the refused notice shows it. */
  readonly project: string;
  readonly endpoints: readonly RemoteEndpoint[];
  /** The current branch's upstream remote; origin when absent. */
  readonly pushRemote?: string;
  /** The current branch, which ForgePipelines and ForgeOpenMergeRequest use when the input names none. */
  readonly branch?: string;
  /** The target the gate decided for this call (ForgeTarget). */
  readonly expected?: ForgeTarget;
}

/** Why a call reached no account: none resolved for the server, or an organization keeps the account out. */
export interface ForgeToolRefusal {
  readonly serverId: string;
  readonly serverLabel: string;
  /** The project's name; "" outside a project. */
  readonly project: string;
  readonly account: { readonly id: string; readonly login: string; readonly avatarKey?: string } | null;
  readonly reason: 'noAccount' | 'orgAccess';
  readonly org?: { readonly name: string; readonly kind: 'sso' | 'approval' };
}

/** A tool's result: the text the model reads, and the refused notice when no account could answer. */
export interface ForgeToolAnswer {
  readonly text: string;
  readonly isError?: true;
  readonly refusal?: ForgeToolRefusal;
}

/** A write's approval card, resolved before the prompt shows: its words and facts, and option 2's rule for this project. */
export type ForgeApprovalAnswer =
  | { readonly ok: true; readonly project: string; readonly detail: PermissionDetail; readonly suggestion: PermissionUpdate; readonly target: ForgeTarget }
  | { readonly ok: false; readonly answer: ForgeToolAnswer };
