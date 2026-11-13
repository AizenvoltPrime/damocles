// File and commit links on a repository's server (docs/invariants.md "GitHub and GitLab accounts", links). A renderer names
// the repository by id and gets the outcome back; the address stays in main and core.
import type { ForgeReference } from './references';

export const FORGE_LINK_ACTIONS = ['copyPermalink', 'openFile', 'openCommit', 'openReference'] as const;
export type ForgeLinkAction = (typeof FORGE_LINK_ACTIONS)[number];

/** A full commit id, SHA-1 or SHA-256, as git prints it. */
export const FULL_SHA: RegExp = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface ForgeLinkRequest {
  readonly action: ForgeLinkAction;
  readonly repoId: string;
  /** copyPermalink and openFile: the repository-relative path with '/' separators; openCommit and openReference: absent. */
  readonly path?: string;
  /** A full commit id; absent: HEAD, as the project's own core reports it; openReference: absent. */
  readonly sha?: string;
  /** 1-based lines of a file link, startLine <= endLine; none links the whole file. */
  readonly startLine?: number;
  readonly endLine?: number;
  /** copyPermalink and openFile: the editor's buffer has edits its file on disk lacks, so the lines may not match. */
  readonly modified?: boolean;
  /** openReference only: an issue or merge request a commit message names (shared/forge/references.ts). */
  readonly reference?: ForgeReference;
}

export type ForgeLinkResult =
  /** dirty: the file has uncommitted or unsaved changes, so its lines may not match the link's. */
  | { readonly kind: 'opened' | 'copied'; readonly serverName: string; readonly label: string; readonly dirty: boolean }
  /** The commit is on no remote-tracking branch, so nothing was opened or copied; canPush: pushing HEAD's branch publishes it. */
  | { readonly kind: 'unpushed'; readonly serverName: string; readonly label: string; readonly canPush: boolean }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** A file link's target, a commit's or a reference's; built only on a managed server's web origin (core/forge/links.ts). */
export type ForgeLinkTarget =
  | { readonly kind: 'file'; readonly sha: string; readonly path: string; readonly range?: { readonly start: number; readonly end: number } }
  | { readonly kind: 'commit'; readonly sha: string }
  | { readonly kind: 'reference'; readonly reference: ForgeReference };

/** What ScmService.commitOnRemote reads of a commit (feature scm.commitOnRemote). */
export interface CommitOnRemote {
  /** A remote-tracking branch contains the commit, as last fetched. */
  readonly onRemote: boolean;
  /** HEAD is on a branch that holds the commit, so pushing the branch publishes it. */
  readonly ahead: boolean;
  /** The path given has staged or unstaged changes. */
  readonly dirty: boolean;
}
