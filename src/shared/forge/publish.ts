// Publish and fork on a denied push as the overlay shows them (docs/invariants.md "GitHub and GitLab accounts", publish
// and fork). Main drives both flows and pushes each dialog's whole state; the overlay sends back only ids, the Owner value core
// issued, a typed name and a visibility, and never sees a URL or a token.
import type { ForgeKind } from './accounts';

export const PUBLISH_VISIBILITIES = ['private', 'internal', 'public'] as const;
export type PublishVisibility = (typeof PUBLISH_VISIBILITIES)[number];

/** GitHub's repository name limit; GitLab allows more. */
export const MAX_REPOSITORY_NAME_CHARS = 100;
/** An Owner value: "<server>|<login>|personal", or "<server>|<login>|<org or group full path>". */
export const MAX_OWNER_VALUE_CHARS = 1024;

/**
 * A name as VS Code's publish sanitizes it (extensions/github/src/publish.ts sanitizeRepositoryName, MIT, Copyright (c)
 * Microsoft Corporation): trimmed, and each character other than a letter, digit, '_' or '.' becomes '-'.
 */
export function sanitizeRepositoryName(value: string): string {
  return value.trim().replace(/[^a-z0-9_.]/gi, '-');
}

/** The Name field as the user types it: sanitizeRepositoryName without the trim, so a typed space becomes a dash at once. */
export function typedRepositoryName(value: string): string {
  return value.replace(/[^a-z0-9_.]/gi, '-');
}

/** A sanitized name the servers can hold: not empty, not '.' or '..', within MAX_REPOSITORY_NAME_CHARS. */
export function isRepositoryName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_REPOSITORY_NAME_CHARS && /^[A-Za-z0-9_.-]+$/.test(name) && name !== '.' && name !== '..';
}

/** VS Code's PR_TEMPLATE_FILES (extensions/github/src/pushErrorHandler.ts) in its order, .github's lowercase name included; the first HEAD holds is used. */
export const GITHUB_TEMPLATE_FILES: readonly string[] = [
  'pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
];
/** GitLab's default merge request description template. */
export const GITLAB_TEMPLATE_FILES: readonly string[] = ['.gitlab/merge_request_templates/Default.md'];
/** A template longer than this is left out of the create page's address. */
export const MAX_TEMPLATE_CHARS = 4000;

export type PublishNamespaceKind = 'personal' | 'org' | 'group';

export interface PublishNamespace {
  /** The Owner select's value, opaque to the overlay; core resolves it only against the namespaces it listed. */
  readonly value: string;
  readonly kind: PublishNamespaceKind;
  /** The login for personal, the organization or group's full path otherwise ("grp/platform"): the Name prefix's middle. */
  readonly path: string;
  /** Internal is offered: GitLab, and a GitHub Enterprise Server organization. */
  readonly internal: boolean;
}

/** One account's group of the Owner select as the dialog opens: its own namespace at once; organizations or groups load in the dialog. */
export interface PublishAccount {
  readonly accountId: string;
  readonly serverName: string;
  readonly login: string;
  readonly kind: ForgeKind;
  /** The account's own namespace (kind personal), always a valid owner. */
  readonly personal: PublishNamespace;
}

/**
 * One account's organizations or groups; Text is core's LocalizedText until main renders it. loaded: by path, the personal one
 * not repeated; truncated: the server had more than the listing's page bound, so only these are offered. error: why none are
 * listed, with Try again. cancelled: its caller aborted it, as the dialog does for a newer request of the account and on close.
 */
export type PublishOwnersAnswerOf<Text> =
  | { readonly status: 'loaded'; readonly owners: readonly PublishNamespace[]; readonly truncated: boolean }
  | { readonly status: 'error'; readonly message: Text }
  | { readonly status: 'cancelled' };
export type PublishOwnersAnswer = PublishOwnersAnswerOf<string>;

/** The Publish dialog as main opens it, before any listing; defaultOwner is the first account's personal value. */
export interface PublishDialog {
  readonly requestId: string;
  readonly project: string;
  readonly branch: string;
  readonly accounts: readonly PublishAccount[];
  readonly defaultOwner: string;
  readonly defaultName: string;
}

/** A dialog's submit as main answers it: started, its steps follow on the state pushes; ignored, nothing runs and no state follows. */
export type FlowStart = 'started' | 'ignored';

export type FlowStepState = 'pending' | 'active' | 'done' | 'failed';

export interface FlowStep<Id extends string> {
  readonly step: Id;
  readonly state: FlowStepState;
  /** With failed: what went wrong, in main's language (the timeline's failure box). */
  readonly failure?: string;
}

export const PUBLISH_STEPS = ['create', 'origin', 'push'] as const;
export type PublishStepId = (typeof PUBLISH_STEPS)[number];

/** What a running or finished publish names: "Create <path> on <serverName>", "Push <branch> as <login>". */
export interface PublishTarget {
  readonly serverName: string;
  /** The new repository's path on the server: "alexios-s/damocles-fork". */
  readonly path: string;
  readonly login: string;
  readonly branch: string;
}

/**
 * The Publish dialog's state after a submit, pushed whole. refused: the server (or the name check) refused the name; the form
 * shows again with the Name field shaken and reason under it. running: cancellable until the push starts. failed: a step failed
 * and shows its failure; the dialog only closes. done: published and bound.
 */
export type PublishState =
  | { readonly requestId: string; readonly phase: 'refused'; readonly reason: string }
  | { readonly requestId: string; readonly phase: 'running'; readonly target: PublishTarget; readonly steps: readonly FlowStep<PublishStepId>[]; readonly cancellable: boolean }
  | { readonly requestId: string; readonly phase: 'failed' | 'done'; readonly target: PublishTarget; readonly steps: readonly FlowStep<PublishStepId>[] };

/** A server's reason shown in the dialog is cut to this many characters. */
export const MAX_REASON_CHARS = 300;

/** The fork dialog as main opens it, after the server confirmed the account cannot push. */
export interface ForkDialog {
  readonly requestId: string;
  readonly serverName: string;
  /** github: "Open Pull Request"; gitlab: "Open Merge Request". */
  readonly kind: ForgeKind;
  /** The repository the push was refused on: "grp/damocles". */
  readonly path: string;
  readonly login: string;
  readonly branch: string;
  /** The remote the push went to, which becomes upstreamName: usually "origin". */
  readonly remote: string;
  /** "upstream", or "upstream-2", "upstream-3"... when a remote already has that name. */
  readonly upstreamName: string;
  /** A remote named upstream exists already: the note that the original becomes upstreamName. */
  readonly upstreamExists: boolean;
}

export const FORK_STEPS = ['fork', 'rename', 'origin', 'push'] as const;
export type ForkStepId = (typeof FORK_STEPS)[number];

/** One row of the success state's remotes table: the remote's name and "<server>/<path>". */
export interface ForkRemoteRow {
  readonly name: string;
  readonly display: string;
}

/**
 * The fork dialog's state after Fork and Push, pushed whole. running: cancellable until the push starts. failed: a step failed
 * and shows its failure; restored: the remotes are as they were before the fork (a failure before the push); restoreFailed: the
 * flow stopped before the push but could not put them back, and the failure says what is left; neither: the push failed, origin
 * is the fork and upstreamName the original. done: the remotes table and Open Merge Request / Open Pull Request.
 */
export type ForkState =
  | { readonly requestId: string; readonly phase: 'running'; readonly steps: readonly FlowStep<ForkStepId>[]; readonly cancellable: boolean }
  | { readonly requestId: string; readonly phase: 'failed'; readonly steps: readonly FlowStep<ForkStepId>[]; readonly restored: boolean; readonly restoreFailed?: true }
  | { readonly requestId: string; readonly phase: 'done'; readonly steps: readonly FlowStep<ForkStepId>[]; readonly remotes: readonly ForkRemoteRow[] };
