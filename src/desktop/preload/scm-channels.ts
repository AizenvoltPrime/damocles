// Source control's channels (plan AD4, IPC), shared by the shell preload, main and (as types only) the shell app.
// Main issues every repoId for the run and keys everything it persists by the repository's root path; the renderer names a
// file only as a repo-relative path, which main validates here and core confines again.

import { hasUnsafeWindowsSegment, isRelativeFilePath } from '../../shared/relative-path';

export const SCM_CHANNELS = {
  // renderer → main, invoke
  // → ScmShellState
  getState: 'damocles:scm:get-state',
  // ScmSelectRequest; persisted per project by the repository's root path. The reply precedes the view naming the selection,
  // so the shell never infers the selected repository from it.
  select: 'damocles:scm:select',
  // ScmRunRequest → ScmRunResult
  run: 'damocles:scm:run',
  // ScmCommitRequest → ScmCommitResult
  commit: 'damocles:scm:commit',
  // ScmRepoRef → ScmGenerateResult; a failure leaves the box as it is and main posts the notice
  generateMessage: 'damocles:scm:generate-message',
  // ScmFileDiffRequest → ScmFileDiffResult
  fileDiff: 'damocles:scm:file-diff',
  // ScmCopyRequest; main composes the text from its own data and writes the clipboard
  copy: 'damocles:scm:copy',
  // ScmRepoRef → ScmCommitInput
  commitInput: 'damocles:scm:commit-input',
  // ScmAmendReport: the selected repository's commit box amend mode, which titles the palette's and menu's commit commands
  amend: 'damocles:scm:amend',
  // main → renderer
  // ScmView, for one project, on every change
  view: 'damocles:scm:view',
  // ScmRepoSnapshot, coalesced per repository
  state: 'damocles:scm:state',
  // ScmDecorations, for one project, on every change
  decorations: 'damocles:scm:decorations',
  // ScmSettings on every change of a damocles.desktop.git.* key the shell reads
  settings: 'damocles:scm:settings',
  // ScmShellCommand: a palette command the shell carries out (it holds the commit drafts)
  command: 'damocles:scm:command',
  // ScmSetInput: text main put in a repository's commit box, whatever started it
  setInput: 'damocles:scm:set-input',
} as const;

// Bounds main checks; anything outside is refused, never clamped.
export const MAX_SCM_ID_LENGTH = 200;
export const MAX_SCM_PATHS = 10_000;
// A commit message's characters; must equal MAX_MESSAGE_CHARS in src/core/scm/repository.ts.
export const MAX_COMMIT_MESSAGE_CHARS: number = 64 * 1024;
// VS Code's git.statusLimit default: past it a status lists only the first entries and the snapshot says so. Must equal
// STATUS_LIMIT in src/core/scm/repository.ts.
export const SCM_STATUS_LIMIT = 10_000;

// A change's status: VS Code's Status enum names (extensions/git/src/api/git.d.ts).
export const SCM_STATUSES = [
  'INDEX_MODIFIED',
  'INDEX_ADDED',
  'INDEX_DELETED',
  'INDEX_RENAMED',
  'INDEX_COPIED',
  'MODIFIED',
  'DELETED',
  'UNTRACKED',
  'IGNORED',
  'INTENT_TO_ADD',
  'INTENT_TO_RENAME',
  'TYPE_CHANGED',
  'ADDED_BY_US',
  'ADDED_BY_THEM',
  'DELETED_BY_US',
  'DELETED_BY_THEM',
  'BOTH_ADDED',
  'BOTH_DELETED',
  'BOTH_MODIFIED',
] as const;
export type ScmStatus = (typeof SCM_STATUSES)[number];

// The letter VS Code's resource decoration shows; S marks a submodule, ! a conflict.
export type ScmLetter = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | 'T' | '!' | 'S' | 'I';
export type ScmTone = 'modified' | 'added' | 'deleted' | 'untracked' | 'conflict' | 'renamed' | 'submodule' | 'ignored';

export const SCM_GROUPS = ['merge', 'index', 'workingTree', 'untracked'] as const;
export type ScmGroup = (typeof SCM_GROUPS)[number];

export interface ScmChange {
  // repo-relative, '/' separated
  readonly path: string;
  // a rename's or copy's source, repo-relative
  readonly originalPath?: string;
  readonly status: ScmStatus;
  readonly letter: ScmLetter;
  readonly tone: ScmTone;
  // deleted in this group: the row and the decoration strike the name through
  readonly strike: boolean;
  // the path is a submodule of the repository
  readonly submodule?: true;
}

export type ScmRepoKind = 'root' | 'nested' | 'submodule' | 'parent';

export type ScmHead =
  | { readonly type: 'branch'; readonly name: string }
  | { readonly type: 'detached'; readonly commit: string }
  | { readonly type: 'unborn'; readonly name: string };

export type ScmOperation = 'merge' | 'rebase' | 'cherryPick';

export interface ScmRepoSummary {
  readonly repoId: string;
  // the root folder's name
  readonly label: string;
  // project-relative ('' for the project folder itself), or absolute for a parent repository
  readonly displayPath: string;
  readonly kind: ScmRepoKind;
}

export interface ScmRepoSnapshot {
  readonly repoId: string;
  readonly projectKey: string;
  readonly head: ScmHead | null;
  // HEAD's commit and its message's first line (the amend banner); null on an unborn branch
  readonly commit: { readonly hash: string; readonly subject: string } | null;
  readonly operation: ScmOperation | null;
  // MERGE_MSG without its comment lines, while a merge or cherry-pick is in progress: the box's prefill
  readonly mergeMessage?: string;
  // untracked is non-empty only at untrackedChanges 'separate'; at 'mixed' untracked files sit in workingTree, at 'hidden' nowhere
  readonly groups: { readonly [G in ScmGroup]: readonly ScmChange[] };
  // the status held more than SCM_STATUS_LIMIT entries and the groups hold the first ones
  readonly tooManyChanges: boolean;
  // an index-writing operation runs (stage, unstage, discard, commit, continue, abort): its buttons show busy
  readonly busy: boolean;
}

// loading: the project's discovery runs. noRepository covers closed ones too: closedCount tells the shell which text to show.
export type ScmViewState = 'loading' | 'untrusted' | 'gitMissing' | 'noRepository' | 'ready';

export interface ScmView {
  readonly projectKey: string;
  readonly state: ScmViewState;
  // picker order: the repository holding the project folder first, then by path
  readonly repos: readonly ScmRepoSummary[];
  readonly selectedRepoId: string | null;
  // repositories of this project the user closed (Reopen Closed Repositories...)
  readonly closedCount: number;
  // repositories git refused for dubious ownership, as display paths (Manage Unsafe Repositories)
  readonly unsafePaths: readonly string[];
  // parent repositories waiting on the D9 prompt's answer (Open Repositories In Parent Folders)
  readonly parentCount: number;
}

export interface ScmDecoration {
  // absent for ignored entries, which only fade
  readonly letter?: ScmLetter;
  readonly tone: ScmTone;
  // the change is staged (index group); unstaged changes win where a file has both
  readonly staged: boolean;
  readonly strike: boolean;
  // absent for a submodule folder and an ignored entry
  readonly status?: ScmStatus;
  readonly submodule?: true;
}

export interface ScmDecorations {
  readonly projectKey: string;
  // by project-relative path; files outside the project (a parent repository's) are not listed
  readonly files: { readonly [projectRelativePath: string]: ScmDecoration };
}

export interface ScmSettings {
  readonly untrackedChanges: 'mixed' | 'separate' | 'hidden';
  readonly inputValidation: boolean;
  readonly inputValidationSubjectLength: number;
  readonly inputValidationLength: number;
  // the No Verify commit variants show only while this is on
  readonly allowNoVerifyCommit: boolean;
}

export interface ScmShellState {
  // one per open project
  readonly views: readonly ScmView[];
  // every open repository of every view
  readonly snapshots: readonly ScmRepoSnapshot[];
  readonly decorations: readonly ScmDecorations[];
  readonly settings: ScmSettings;
}

export interface ScmSelectRequest {
  readonly projectKey: string;
  readonly repoId: string;
}

export interface ScmRepoRef {
  readonly repoId: string;
}

// amending: every commit action of repoId's box amends (the store's amendingIn)
export interface ScmAmendReport {
  readonly repoId: string;
  readonly amending: boolean;
}

// The source of a diff: one group's side pair.
export type ScmDiffSource = { readonly kind: ScmGroup };

export const SCM_STAGE_ALL_SCOPES = ['all', 'tracked', 'untracked', 'merge'] as const;
export const SCM_DISCARD_ALL_SCOPES = ['all', 'tracked', 'untracked'] as const;

// User flows main runs, keyed by op. Questions (discard confirmations, the parent prompt, safe.directory) go through the
// overlay dialog; failures are notices with Show Git Output.
export type ScmRunRequest =
  | { readonly op: 'init'; readonly projectKey: string }
  | { readonly op: 'openRepository'; readonly projectKey: string }
  | { readonly op: 'reopenClosed'; readonly projectKey: string }
  | { readonly op: 'openParentRepositories'; readonly projectKey: string }
  | { readonly op: 'manageUnsafeRepositories'; readonly projectKey: string }
  | { readonly op: 'showOutput' }
  // the git-not-installed state's link: main opens https://git-scm.com/download/<os> itself
  | { readonly op: 'openGitDownload' }
  | { readonly op: 'closeRepository'; readonly repoId: string }
  | { readonly op: 'closeOtherRepositories'; readonly repoId: string }
  | { readonly op: 'refresh'; readonly repoId: string }
  | { readonly op: 'stage'; readonly repoId: string; readonly paths: readonly string[] }
  | { readonly op: 'unstage'; readonly repoId: string; readonly paths: readonly string[] }
  | { readonly op: 'discard'; readonly repoId: string; readonly paths: readonly string[] }
  | { readonly op: 'stageAll'; readonly repoId: string; readonly scope: (typeof SCM_STAGE_ALL_SCOPES)[number] }
  | { readonly op: 'unstageAll'; readonly repoId: string }
  | { readonly op: 'discardAll'; readonly repoId: string; readonly scope: (typeof SCM_DISCARD_ALL_SCOPES)[number] }
  | { readonly op: 'abortOperation'; readonly repoId: string }
  | { readonly op: 'addToGitignore'; readonly repoId: string; readonly paths: readonly string[] }
  | { readonly op: 'reveal'; readonly repoId: string; readonly path: string }
  | { readonly op: 'mention'; readonly repoId: string; readonly path: string }
  | { readonly op: 'openChanges'; readonly repoId: string; readonly path: string; readonly group: ScmGroup }
  | { readonly op: 'openFile'; readonly repoId: string; readonly path: string }
  | { readonly op: 'openFileHead'; readonly repoId: string; readonly path: string }
  | { readonly op: 'openGroupChanges'; readonly repoId: string; readonly group: ScmGroup }
  // the undone commit's message and the template come back through setInput
  | { readonly op: 'undoLastCommit'; readonly repoId: string }
  | { readonly op: 'restoreCommitTemplate'; readonly repoId: string };
export type ScmOp = ScmRunRequest['op'];

// cancelled: the user said no to a question; failed: main told the user; unknown: the repoId or projectKey is not main's
export type ScmRunResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'cancelled' | 'failed' | 'unknown' };

export const SCM_COMMIT_SCOPES = ['auto', 'staged', 'all'] as const;

// VS Code's commit commands: auto is Commit, staged Commit Staged (the same behaviour), all Commit All; the flags combine.
export interface ScmCommitVariant {
  readonly scope: (typeof SCM_COMMIT_SCOPES)[number];
  readonly amend: boolean;
  readonly signoff: boolean;
  readonly noVerify: boolean;
  readonly empty: boolean;
}

// While a merge or cherry-pick is in progress Commit concludes it with the message; while a rebase is, Commit is Continue
// Rebase, which reuses git's prepared message and ignores this one. With amend, an empty message keeps HEAD's.
export interface ScmCommitRequest {
  readonly repoId: string;
  readonly message: string;
  readonly variant: ScmCommitVariant;
}

export type ScmCommitFailure = 'emptyMessage' | 'nothingToCommit' | 'unresolvedConflicts' | 'missingUserConfig' | 'cancelled' | 'failed' | 'unknown';
// The shell shows emptyMessage, nothingToCommit, unresolvedConflicts and missingUserConfig inline and nothing for cancelled (the
// user answered a question so); main posts a notice with Show Git Output for failed only. The shell keeps the draft; a success
// replaces it through setInput.
// ok carries the box's new text (the template or nothing) and the commit input read after core recorded the commit, so the
// shell applies both as the commit settles; commitInput is absent when main could not read it, and the shell reads it again
export type ScmCommitResult =
  | { readonly ok: true; readonly message: string; readonly commitInput?: ScmCommitInput }
  | { readonly ok: false; readonly reason: ScmCommitFailure };

export interface ScmCommitInput {
  // the commit.template file's text, comment lines dropped; null when the repository has none
  readonly template: string | null;
  // committed messages of this repository's root, newest first
  readonly history: readonly string[];
  // HEAD's full message, which amend mode fills an empty box with; null on an unborn branch
  readonly headMessage: string | null;
}

// undo: Undo Last Commit's message; template: Restore Commit Template. A commit's text comes back in its ScmCommitResult.
export interface ScmSetInput {
  readonly repoId: string;
  readonly message: string;
  readonly cause: 'undo' | 'template';
  // undo: the commit input read after core undid the commit, so the box and its history change together; absent when main
  // could not read it, and the shell reads it again
  readonly commitInput?: ScmCommitInput;
}

export type ScmGenerateResult = { readonly ok: true; readonly message: string } | { readonly ok: false };

export interface ScmFileDiffRequest {
  readonly repoId: string;
  readonly source: ScmDiffSource;
  // repo-relative
  readonly path: string;
}

// patch: one file's unified diff (parseUnifiedDiff); missing: the path is no longer in that group
export type ScmFileDiffResult =
  | { readonly kind: 'patch'; readonly patch: string }
  | { readonly kind: 'binary' }
  | { readonly kind: 'tooLarge' }
  | { readonly kind: 'missing' };

export const SCM_COPY_KINDS = ['path', 'relativePath'] as const;
export type ScmCopyKind = (typeof SCM_COPY_KINDS)[number];

// value: the repo-relative path; path copies the absolute path, relativePath the project-relative one (repo-relative for a
// parent repository's file outside the project)
export interface ScmCopyRequest {
  readonly repoId: string;
  readonly kind: ScmCopyKind;
  readonly value: string;
}

// A palette commit command: the shell commits its draft for repoId with the variant.
export type ScmShellCommand = { readonly command: 'commit'; readonly repoId: string; readonly variant: ScmCommitVariant };

// The editor's multi-file diff tab (EditorTabKind 'changes'); main keeps entries current while the tab is open.
export interface ScmChangesTab {
  readonly repoId: string;
  readonly source: ScmDiffSource;
  readonly entries: readonly ScmChange[];
}

export interface DamoclesScmApi {
  getState(): Promise<ScmShellState>;
  // each returns the unsubscribe
  onView(listener: (view: ScmView) => void): () => void;
  onState(listener: (snapshot: ScmRepoSnapshot) => void): () => void;
  onDecorations(listener: (decorations: ScmDecorations) => void): () => void;
  onSettings(listener: (settings: ScmSettings) => void): () => void;
  onCommand(listener: (command: ScmShellCommand) => void): () => void;
  onSetInput(listener: (input: ScmSetInput) => void): () => void;
  select(request: ScmSelectRequest): Promise<void>;
  run(request: ScmRunRequest): Promise<ScmRunResult>;
  commit(request: ScmCommitRequest): Promise<ScmCommitResult>;
  generateMessage(repoId: string): Promise<ScmGenerateResult>;
  fileDiff(request: ScmFileDiffRequest): Promise<ScmFileDiffResult>;
  copy(request: ScmCopyRequest): Promise<void>;
  commitInput(repoId: string): Promise<ScmCommitInput>;
  reportAmend(report: ScmAmendReport): Promise<void>;
}

// Validators main runs on every invoke before anything reaches core. Each payload carries exactly its fields.

function exact(raw: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)) ? value : undefined;
}

const isScmId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_SCM_ID_LENGTH;

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value);
}

/**
 * A repo-relative path a renderer may name: isRelativeFilePath's rules (no '..', no root, no backslash, no NUL) and, on
 * Windows, no segment Win32 would resolve to another entry.
 */
export const isRepoPath = (value: unknown): value is string => isRelativeFilePath(value) && !(process.platform === 'win32' && hasUnsafeWindowsSegment(value));

function repoPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCM_PATHS) return undefined;
  return (value as unknown[]).every(isRepoPath) ? [...(value as string[])] : undefined;
}

export function parseScmSelect(raw: unknown): ScmSelectRequest | undefined {
  const value = exact(raw, ['projectKey', 'repoId']);
  return value && isScmId(value['projectKey']) && isScmId(value['repoId']) ? { projectKey: value['projectKey'], repoId: value['repoId'] } : undefined;
}

export function parseScmRepoRef(raw: unknown): ScmRepoRef | undefined {
  const value = exact(raw, ['repoId']);
  return value && isScmId(value['repoId']) ? { repoId: value['repoId'] } : undefined;
}

export function parseScmAmend(raw: unknown): ScmAmendReport | undefined {
  const value = exact(raw, ['repoId', 'amending']);
  return value && isScmId(value['repoId']) && typeof value['amending'] === 'boolean' ? { repoId: value['repoId'], amending: value['amending'] } : undefined;
}

export function parseScmRun(raw: unknown): ScmRunRequest | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !Object.hasOwn(raw, 'op')) return undefined;
  const op = (raw as Record<string, unknown>)['op'];
  switch (op) {
    case 'init':
    case 'openRepository':
    case 'reopenClosed':
    case 'openParentRepositories':
    case 'manageUnsafeRepositories': {
      const value = exact(raw, ['op', 'projectKey']);
      return value && isScmId(value['projectKey']) ? { op, projectKey: value['projectKey'] } : undefined;
    }
    case 'showOutput':
    case 'openGitDownload':
      return exact(raw, ['op']) ? { op } : undefined;
    case 'closeRepository':
    case 'closeOtherRepositories':
    case 'refresh':
    case 'unstageAll':
    case 'abortOperation':
    case 'undoLastCommit':
    case 'restoreCommitTemplate': {
      const value = exact(raw, ['op', 'repoId']);
      return value && isScmId(value['repoId']) ? { op, repoId: value['repoId'] } : undefined;
    }
    case 'stage':
    case 'unstage':
    case 'discard':
    case 'addToGitignore': {
      const value = exact(raw, ['op', 'repoId', 'paths']);
      const paths = value ? repoPaths(value['paths']) : undefined;
      return value && isScmId(value['repoId']) && paths ? { op, repoId: value['repoId'], paths } : undefined;
    }
    case 'stageAll': {
      const value = exact(raw, ['op', 'repoId', 'scope']);
      return value && isScmId(value['repoId']) && oneOf(SCM_STAGE_ALL_SCOPES, value['scope']) ? { op, repoId: value['repoId'], scope: value['scope'] } : undefined;
    }
    case 'discardAll': {
      const value = exact(raw, ['op', 'repoId', 'scope']);
      return value && isScmId(value['repoId']) && oneOf(SCM_DISCARD_ALL_SCOPES, value['scope']) ? { op, repoId: value['repoId'], scope: value['scope'] } : undefined;
    }
    case 'reveal':
    case 'mention':
    case 'openFile':
    case 'openFileHead': {
      const value = exact(raw, ['op', 'repoId', 'path']);
      return value && isScmId(value['repoId']) && isRepoPath(value['path']) ? { op, repoId: value['repoId'], path: value['path'] } : undefined;
    }
    case 'openChanges': {
      const value = exact(raw, ['op', 'repoId', 'path', 'group']);
      return value && isScmId(value['repoId']) && isRepoPath(value['path']) && oneOf(SCM_GROUPS, value['group'])
        ? { op, repoId: value['repoId'], path: value['path'], group: value['group'] }
        : undefined;
    }
    case 'openGroupChanges': {
      const value = exact(raw, ['op', 'repoId', 'group']);
      return value && isScmId(value['repoId']) && oneOf(SCM_GROUPS, value['group']) ? { op, repoId: value['repoId'], group: value['group'] } : undefined;
    }
    default:
      return undefined;
  }
}

function parseCommitVariant(raw: unknown): ScmCommitVariant | undefined {
  const value = exact(raw, ['scope', 'amend', 'signoff', 'noVerify', 'empty']);
  if (!value || !oneOf(SCM_COMMIT_SCOPES, value['scope'])) return undefined;
  const { amend, signoff, noVerify, empty } = value;
  return typeof amend === 'boolean' && typeof signoff === 'boolean' && typeof noVerify === 'boolean' && typeof empty === 'boolean'
    ? { scope: value['scope'], amend, signoff, noVerify, empty }
    : undefined;
}

export function parseScmCommit(raw: unknown): ScmCommitRequest | undefined {
  const value = exact(raw, ['repoId', 'message', 'variant']);
  const message = value?.['message'];
  const variant = value ? parseCommitVariant(value['variant']) : undefined;
  return value && isScmId(value['repoId']) && typeof message === 'string' && message.length <= MAX_COMMIT_MESSAGE_CHARS && !message.includes('\0') && variant
    ? { repoId: value['repoId'], message, variant }
    : undefined;
}

function parseDiffSource(raw: unknown): ScmDiffSource | undefined {
  const value = exact(raw, ['kind']);
  return value && oneOf(SCM_GROUPS, value['kind']) ? { kind: value['kind'] } : undefined;
}

export function parseScmFileDiff(raw: unknown): ScmFileDiffRequest | undefined {
  const value = exact(raw, ['repoId', 'source', 'path']);
  const source = value ? parseDiffSource(value['source']) : undefined;
  return value && isScmId(value['repoId']) && source && isRepoPath(value['path']) ? { repoId: value['repoId'], source, path: value['path'] } : undefined;
}

export function parseScmCopy(raw: unknown): ScmCopyRequest | undefined {
  const value = exact(raw, ['repoId', 'kind', 'value']);
  return value && isScmId(value['repoId']) && oneOf(SCM_COPY_KINDS, value['kind']) && isRepoPath(value['value'])
    ? { repoId: value['repoId'], kind: value['kind'], value: value['value'] }
    : undefined;
}
