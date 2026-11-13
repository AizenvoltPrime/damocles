// The Git hosting accounts' channels between the shell, the overlay and main (main/forge/forge-host.ts). Main maps a repository
// id to its project and authority itself; the renderers pass ids back verbatim and never see a token or a remote URL.
import type { ChooseAccountAnswer, ChooseAccountRequest, ChooseAccountRows, ForgeGitOperation, RepoAccountsView } from '../../shared/forge/bindings';
import type { CiAction, CiStatusView, CiTarget, CommitStatusView, JobLogView } from '../../shared/forge/ci';
import type { HostColor } from '../../shared/host-colors';
import type { CloneAccountsView, ClonePasteAnswer, CloneSearchAnswer, CloneSource, CloneStartAnswer } from '../../shared/forge/clone';
import type { ForgeLinkRequest } from '../../shared/forge/links';
import type { AuthorAvatars, ContainingChange, HistoryAuthor, HistoryForgeContext } from '../../shared/forge/history';
import type { ForgeReference } from '../../shared/forge/references';

export const FORGE_CHANNELS = {
  // renderer → main, invoke
  // { repoId, recheck? } → RepoAccountsView | null (null: not an open repository, or no remote endpoints yet); recheck runs
  // the access check again for the servers whose last check failed (the account chip's Try again)
  repoAccounts: 'damocles:forge:repoAccounts',
  // { repoId, serverId, accountId: string | null } → boolean: binds the project (null: Use Git's own credentials); false: not saved
  chooseAccount: 'damocles:forge:chooseAccount',
  // { authorityKey } → HostDefaultsView
  hostDefaults: 'damocles:forge:hostDefaults',
  // { authorityKey, serverId, accountId: string | null } → boolean (null: No default); false: not saved
  setHostDefault: 'damocles:forge:setHostDefault',
  // { serverId?, signIn? } → void: Settings › Models & accounts › Git hosting, at that server's row with its sign-in panel open when signIn
  openAccounts: 'damocles:forge:openAccounts',
  // main → renderer: ForgeChanged; the renderer asks again for what it shows
  changed: 'damocles:forge:changed',
  // { repoId } → CiStatusView | null (null: no chip: no remote on a known server, no account, or ciStatus off)
  ciStatus: 'damocles:forge:ci:status',
  // { repoId, visible }: Source Control shows the repository (visible) or hides it; main also pauses on window blur
  ciWatch: 'damocles:forge:ci:watch',
  // { repoId, anchor } → void once the popover closed: the job list, end-aligned to the chip
  showPipeline: 'damocles:forge:ci:show-pipeline',
  // { repoId, jobId } → void: opens or focuses the job's jobLog editor tab
  jobLogOpen: 'damocles:forge:ci:job-log-open',
  // { repoId, target: CiTarget, action: CiAction } → boolean (false: refused, or the repository is gone)
  jobAction: 'damocles:forge:ci:job-action',
  // { repoId, target: CiTarget } → string | null: main opens the address it built and answers the server's name
  openOnServer: 'damocles:forge:ci:open-on-server',
  // { repoId, sha, retry? } → CommitStatusView | null (null: no account for the server, so the row is absent)
  commitStatus: 'damocles:forge:ci:commit-status',
  // history details: { repoId } → HistoryForgeContext | null (null: no remote on a server with an account)
  historyContext: 'damocles:forge:history:context',
  // { repoId, authors: HistoryAuthor[] } (one history page, at most 100, deduplicated by email) → AuthorAvatars; {} when
  // showAvatars is off, nothing is found, or the lookup failed (core logs it)
  authorAvatars: 'damocles:forge:history:avatars',
  // { repoId, sha } → ContainingChange | null (null: none merged, no account, or a failure core logged)
  containingChange: 'damocles:forge:history:containing',
  // main → renderer: CiChanged
  ciChanged: 'damocles:forge:ci:changed',
  // { tabId } → JobLogView: the tab's whole log so far (reset), then appends on jobLogUpdate
  jobLog: 'damocles:forge:ci:job-log',
  // { tabId } → void once read: the tab's log read now (Try again over a kept log); what it reads comes as jobLogUpdate
  jobLogRead: 'damocles:forge:ci:job-log-read',
  // main → renderer: JobLogUpdate
  jobLogUpdate: 'damocles:forge:ci:job-log-update',
  // renderer → main, send: { tabId, visible }; a hidden tab's log is not read
  jobLogVisible: 'damocles:forge:ci:job-log-visible',
  // ForgeLinkRequest → void: main opens or copies the link as the user's click and tells the user; the address stays in main.
  // openReference carries only { sigil, number, path? }; core builds the page on the repository's server
  link: 'damocles:forge:link',
  // the clone picker, each answering closed unless it is open: {} → CloneAccountsView
  cloneAccounts: 'damocles:forge:clone:accounts',
  // { accountId, query, requestId } → CloneSearchAnswer, one account's section; the overlay drops answers of older requestIds
  cloneSearch: 'damocles:forge:clone:search',
  // { text } → ClonePasteAnswer: whether the text is a repository address, as the single "Clone from URL" row
  clonePaste: 'damocles:forge:clone:paste',
  // CloneSource → CloneStartAnswer; started: main goes on with the folder pick and the clone, and the overlay closes;
  // cancelled: the picker closed before core answered, and nothing was cloned
  cloneStart: 'damocles:forge:clone:start',
  // the Publish dialog, answering closed unless its request is open: { requestId, owner, name, visibility } → void; its
  // state follows on OVERLAY_CHANNELS.forgePublishState
  publishSubmit: 'damocles:forge:publish:submit',
  // the fork dialog, answering closed unless its request is open: { requestId } → void; its state follows on
  // OVERLAY_CHANNELS.forgeForkState
  forkStart: 'damocles:forge:fork:start',
  // { requestId, accountId } → PublishOwnersAnswer: one account's organizations or groups for the open Publish dialog; a newer
  // request for the account, or the dialog's close, aborts it down to core's fetch and it answers cancelled
  publishOwners: 'damocles:forge:publish:owners',
  // the protected-branch dialog, answering closed unless its request is open: { requestId, name } → BranchNameCheck
  protectedCheckName: 'damocles:forge:protected:check-name',
  // { requestId, name } → void; main checks the name again and its state follows on OVERLAY_CHANNELS.forgeProtectedState
  protectedPush: 'damocles:forge:protected:push',
} as const;

export interface CiChanged {
  readonly repoId: string;
  readonly status: CiStatusView | null;
}

export interface JobLogUpdate {
  readonly tabId: string;
  readonly view: JobLogView;
}

/** The chip's rectangle in the shell's CSS px. */
export interface CiAnchor {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** projectKeys absent: anything may have changed (accounts, servers, host defaults). */
export interface ForgeChanged {
  readonly projectKeys?: readonly string[];
  /** Set once, right after the Choose account dialog's answer was bound: the shell's polite status names the choice and the operation. */
  // operation: absent for a credential request's choice, which names no git operation
  readonly chosen?: { readonly projectKey: string; readonly serverId: string; readonly accountId: string | null; readonly operation?: ForgeGitOperation };
}

/** The Choose account dialog as main's overlay shows it: core's request plus the where-line's host badge for a remote project. */
export interface ForgeChooseAccountDialog extends ChooseAccountRequest {
  readonly where?: { readonly hostName: string; readonly color?: HostColor };
}

export type { ChooseAccountAnswer, ChooseAccountRows };
export type { CloneAccountsView, ClonePasteAnswer, CloneSearchAnswer, CloneSource, CloneStartAnswer, ForgeLinkRequest };

export interface DamoclesForgeShellApi {
  repoAccounts(repoId: string, recheck?: boolean): Promise<RepoAccountsView | null>;
  chooseAccount(repoId: string, serverId: string, accountId: string | null): Promise<boolean>;
  openAccounts(target: { readonly serverId?: string; readonly signIn?: boolean }): Promise<void>;
  onChanged(listener: (changed: ForgeChanged) => void): () => void;
  ciStatus(repoId: string): Promise<CiStatusView | null>;
  // visible=false while Source Control is hidden; main also pauses on window blur
  ciWatch(repoId: string, visible: boolean): Promise<void>;
  // settles once the popover closed
  showPipeline(repoId: string, anchor: CiAnchor): Promise<void>;
  jobLogOpen(repoId: string, jobId: number): Promise<void>;
  jobAction(repoId: string, target: CiTarget, action: CiAction): Promise<boolean>;
  // the server's name for the polite status; null: nothing was opened
  openOnServer(repoId: string, target: CiTarget): Promise<string | null>;
  commitStatus(repoId: string, sha: string, retry?: boolean): Promise<CommitStatusView | null>;
  // null: no links, no avatars and no merged change for this repository
  historyContext(repoId: string): Promise<HistoryForgeContext | null>;
  // one call per history page, at most 100 authors deduplicated by email; keys by lower-cased email
  authorAvatars(repoId: string, authors: readonly HistoryAuthor[]): Promise<AuthorAvatars>;
  containingChange(repoId: string, sha: string): Promise<ContainingChange | null>;
  onCiChanged(listener: (changed: CiChanged) => void): () => void;
  // the jobLog tab's id from its descriptor; the first answer is the whole log so far (reset)
  jobLog(tabId: string): Promise<JobLogView>;
  jobLogRead(tabId: string): Promise<void>;
  onJobLog(listener: (update: JobLogUpdate) => void): () => void;
  jobLogVisible(tabId: string, visible: boolean): void;
  // a user's click or command: main opens or copies the link and shows the outcome; no address comes back
  link(request: ForgeLinkRequest): Promise<void>;
}

export type { CiAction, CiStatusView, CiTarget, CommitStatusView, JobLogView };
export type { AuthorAvatars, ContainingChange, ForgeReference, HistoryAuthor, HistoryForgeContext };
