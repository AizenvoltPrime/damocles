// A push the server refused on a branch it protects for the account, as the overlay shows it (docs/invariants.md "GitHub and
// GitLab accounts", protected branch on push). Main drives the flow and pushes its whole state; the overlay sends back only the
// request id and a typed branch name, and never sees a URL or a token.
import type { ForgeKind } from './accounts';
import type { FlowStep } from './publish';

/** A branch name the dialog sends main; a longer one is malformed. */
export const MAX_BRANCH_NAME_CHARS = 255;

/** The protected-branch dialog as main opens it, after the server's rules said the refused branch is protected for this account. */
export interface ProtectedBranchDialog {
  readonly requestId: string;
  /** The branch the server refused, as the server names it ("main"). */
  readonly branch: string;
  /** The managed server's name ("github.com"). */
  readonly serverName: string;
  /** github: pull request wording; gitlab: merge request wording. */
  readonly kind: ForgeKind;
  /** The account the push authenticated as. */
  readonly login: string;
  /** The remote the push went to; the new branch goes there too. */
  readonly remote: string;
  /** The local branch HEAD is on, which is left as it is. */
  readonly localBranch: string;
  /** Commits HEAD has that no branch of remote holds as last fetched. */
  readonly unpushedCount: number;
  /** The Branch name field's first value; '' when no default is valid and free. */
  readonly suggestedName: string;
}

/**
 * Why a name cannot be the new branch's. invalid: `git check-ref-format --branch` refuses it; existsOnRemote: the remote's
 * branch as last fetched; conflicts: the name is a folder of an existing local or remote-tracking branch, or one of them is a
 * folder of the name, which git cannot hold together.
 */
export type BranchNameProblem = 'empty' | 'invalid' | 'existsLocally' | 'existsOnRemote' | 'conflicts';

/** name echoes the checked name, so the overlay drops an answer for a value it no longer shows; no problem: the name can be used. */
export interface BranchNameCheck {
  readonly name: string;
  readonly problem?: BranchNameProblem;
}

export const PROTECTED_PUSH_STEPS = ['branch', 'push'] as const;
export type ProtectedPushStepId = (typeof PROTECTED_PUSH_STEPS)[number];

/**
 * The dialog's state after Push to a New Branch, pushed whole. refused: main's own check refused the name, and the name step
 * shows problem. running: the steps under way. failed: a step's failure; after the branch step the user is on the new branch.
 * done: pushed, with Open Pull Request or Open Merge Request.
 */
export type ProtectedPushState =
  | { readonly requestId: string; readonly phase: 'refused'; readonly name: string; readonly problem: BranchNameProblem }
  | { readonly requestId: string; readonly phase: 'running' | 'failed' | 'done'; readonly name: string; readonly steps: readonly FlowStep<ProtectedPushStepId>[] };
