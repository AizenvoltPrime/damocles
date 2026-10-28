// Source control in main (plan AD4, "Who does what"): the damocles:scm:* requests, the user flows keyed by op, the selected
// repository per project, the pushes to the shell, the editor tabs and the palette's entry points.
import { authorityKeyOfProject, isInsideFolder, pathFor } from '../../../shared/project-location';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SettingsStore } from '../../../platform/settings-store';
import { isInside, samePath } from '../../../core/scm/discovery';
import { gitErrorText, gitFailureCode, GitUntrustedError, redactUrls, RemoteCancelledError, StashKeptError, SyncBranchChangedError, type SyncBranch } from '../../../core/scm/errors';
import { isRemoteName, isRemoteUrl, type Remote } from '../../../core/scm/remotes';
import { isObjectName, type CommitPairDiff, type StashArtifact, type WorktreeArtifact } from '../../../core/scm/artifacts';
import type { Change, ChangeGroup } from '../../../core/scm/repository';
import type { StageRefusal, TextCodec } from '../../../core/scm/staging';
import type { ProjectView } from '../../../core/scm/scm-service';
import { SCM_SETTING_KEYS, type OpenAfterClone, type PostCommitCommand, type PromptToSaveFilesBeforeCommit } from '../../../core/scm/settings-keys';
import { canStashStaged } from '../../../core/scm/stash';
import type { CommitAttachmentInput } from '../../../shared/types/chat-attachment';
import { folderKey, folderKeyOn } from '../../../core/workspace-folders/folder-key';
import { inputProblem } from '../../../shared/input-validation';
import { visibleText } from '../../../shared/visible-text';
import type { FileRef, ShellFileGit } from '../../preload/shell-channels';
import {
  parseScmAmend,
  parseScmArtifacts,
  parseScmCommit,
  parseScmCommitDetails,
  parseScmHistory,
  parseScmHistoryCursor,
  scmHistoryCursor,
  MAX_SCM_HISTORY_SKIP,
  SCM_HISTORY_PAGE,
  type ScmCommitDetailsResult,
  type ScmHistoryResult,
  type ScmHistoryCursor,
  parseScmCopy,
  parseScmFileDiff,
  parseScmMergeFile,
  parseScmPath,
  parseScmRepoRef,
  parseScmResource,
  parseScmRun,
  parseScmSelect,
  parseScmTimeline,
  parseScmTimelineCursor,
  type ScmBlameResult,
  type ScmCommitFile,
  type ScmMergeFileResult,
  type ScmMergeInputsResult,
  type ScmQuickDiffBaseResult,
  type ScmResource,
  type ScmStageRangesRequest,
  type ScmTimelineResult,
  type ScmUnstageRangesRequest,
  type ScmRangeAction,
  type ScmRangeRefusal,
  type ScmArtifactGroup,
  type ScmCopyKind,
  type ScmCopyRequest,
  type ScmArtifactsChanged,
  type ScmRefsChange,
  type ScmArtifactsResult,
  type ScmCapabilities,
  type ScmDiffSource,
  type ScmChangesTab,
  type ScmCommitInput,
  type ScmCommitResult,
  type ScmCloneState,
  type ScmCommitVariant,
  type ScmDecorations,
  type ScmFileDiffResult,
  type ScmGenerateResult,
  type ScmOp,
  type ScmOperation,
  type ScmRepoSnapshot,
  type ScmRunRequest,
  type ScmRunResult,
  type ScmSetInput,
  type ScmSettings,
  type ScmShellCommand,
  type ScmStashScope,
  type ScmShellState,
  type ScmView,
  type ScmWorktreeArtifact,
  type ScmWorktreeChat,
  type ScmPostCommit,
  type SCM_DISCARD_ALL_SCOPES,
  type SCM_FETCH_SCOPES,
  type SCM_STAGE_ALL_SCOPES,
} from '../../preload/scm-channels';
import { isDesktopSettingValue } from '../../local-services/desktop-configuration';
import { confineExisting, type Project } from '../../local-services/confine';
import { parseRootKey } from '../../preload/folder-root';
import type { Document, DocumentService, Location } from '../documents/document-service';
import type { EditorPane, NotShownSide } from '../editor-pane';
import type { AskMessage } from '../message-dialog';
import type { AskInput } from '../overlay';
import { MAX_OVERLAY_LABEL_LENGTH, type OverlayQuickPickIcon } from '../../preload/overlay-channels';
import { decodeDocument } from '../platform/editor-document';
import { CANCELLED, OK, pickEntry, RefFlows, remote, TOLD, type PickEntry } from './ref-flows';
import type { ScmRepository, ScmServiceClient } from './scm-client';

// OverlayQuickPickItem's fields main's pickers use
export interface ScmQuickPickItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: OverlayQuickPickIcon;
  readonly hint?: string;
  readonly group?: string;
  readonly current?: boolean;
  readonly alwaysShow?: true;
  readonly echoQuery?: true;
  readonly info?: true;
}

export interface ScmWorktreeDeps {
  // D33's Delete when a live chat worktree of the authority's registry has its root at worktreePath; false for any other worktree
  deleteChatWorktreeAt(authority: string, worktreePath: string): Promise<boolean>;
  // the adopted record of a worktree holding an open project, before its delete (rule 16)
  adopt(project: Project, worktree: WorktreeArtifact, repositoryRoot: string, mainProject: Project | undefined): Promise<void>;
  // Create Worktree's adopted record, under the project the repository belongs to (rule 16)
  adoptCreated(projectKey: string, repositoryRoot: string, worktreePath: string, branch: string | undefined): Promise<void>;
  // git removed the worktree: its adopted record is marked deleted, so its chats list read-only
  markRemoved(worktreePath: string): Promise<void>;
  // closes a project and its chats as Remove Project does, asking first about terminals running a process
  closeProject(projectKey: string): Promise<'closed' | 'cancelled' | { readonly reason: string }>;
  // Open on a chat worktree's row of the authority's registry: its most recently viewed chat, or undefined for any other worktree
  chatOf(authority: string, worktreePath: string): ScmWorktreeChat | undefined;
  // New Chat in This Worktree's target for the row: a live chat worktree of an open, trusted project of the authority
  newChatTargetAt(authority: string, worktreePath: string): { readonly projectKey: string; readonly worktreeId: string } | undefined;
  selectChat(chatId: string): Promise<void>;
  // Open on the worktree holding the project folder: the views show the project folder again (D31)
  showProjectFolder(projectKey: string): void;
  // B40: where the project folder holds a file of the chat worktree root, confined like any project file; undefined for any
  // other root or a file outside the working folder
  projectCopyOf(rootKey: string, absolutePath: string): { readonly project: Project; readonly relativePath: string } | undefined;
}

// The host's name from this computer's host store, and the setting change that turns forwarding on (it reconnects the host).
export interface AgentForwardingOffer {
  readonly hostName: string;
  enable(): Promise<void>;
}

// the operations that reach a remote, whose publickey failure forwarding can fix
const REMOTE_OPS: ReadonlySet<string> = new Set(['fetch', 'pull', 'pullFrom', 'push', 'sync', 'publish', 'pushTags']);

export interface ScmHostDeps {
  // A remote repository's file as the project file it is: a path its core answered, inside one of that authority's projects
  // by the target's own path rules; undefined for any other path (another root, a UNC or drive path, another authority).
  readonly remoteFileRef: (authority: string, targetPath: string) => FileRef | undefined;
  readonly hostName: (authority: string) => string;
  // the OS whose path rules an authority's paths follow: this computer's, or the target's
  readonly authorityOs: (authority: string) => NodeJS.Platform;
  // core's ScmService (scm-client.ts)
  readonly service: ScmServiceClient;
  readonly settings: SettingsStore;
  // the editor's documents: a stage reads the buffer from here, and every editor git read the document's encoding
  readonly documents: DocumentService;
  readonly projects: () => readonly Project[];
  // the selected project, whose selected repository the palette and the menu act on
  readonly selectedProjectKey: () => string | undefined;
  readonly editorPane: EditorPane;
  // each project's selected repository root, persisted in window-layout.json (AD8)
  readonly selection: { get(projectKey: string): string | undefined; set(projectKey: string, root: string): void };
  readonly notify: {
    info(message: string, ...actions: string[]): Promise<string | undefined>;
    warn(message: string, ...actions: string[]): Promise<string | undefined>;
    error(message: string, ...actions: string[]): Promise<string | undefined>;
  };
  readonly t: (message: string, ...args: Array<string | number>) => string;
  readonly showGitLog: () => void;
  // a remote authority's offer to turn on agent forwarding: its POSIX host with forwarding off, else undefined
  readonly agentForwarding: (authority: string) => AgentForwardingOffer | undefined;
  readonly copy: (text: string) => Promise<void>;
  readonly reveal: (absolutePath: string) => Promise<void>;
  readonly openExternal: (url: string) => Promise<void>;
  // the OS folder picker; title names what the folder is for, buttonLabel its confirm button
  readonly pickFolder: (defaultPath: string, title?: string, buttonLabel?: string) => Promise<string | undefined>;
  // adds a folder of the authority to the project list, asking for trust as any added project does (Clone, a worktree's Open)
  readonly addProject: (authority: string, folder: string) => Promise<void>;
  // selects a project of the list, as its Projects row does (a worktree's Open)
  readonly selectProject: (projectKey: string) => Promise<void>;
  // worktree chats (slice 12a): D33's delete, rule 14's close-first order and the registry's adopted records
  readonly worktrees: ScmWorktreeDeps;
  // git was found, whatever any project's trust (Clone's palette clause)
  readonly gitFound: boolean;
  // the picked item's id and the filter text as typed; undefined for Escape, or when it could not show (its asker told the user)
  readonly quickPick: (placeholder: string, items: readonly ScmQuickPickItem[]) => Promise<{ readonly id: string; readonly query: string } | undefined>;
  // a question main's own flows ask (the save-before-commit prompt): the overlay dialog (D41)
  readonly ask: AskMessage;
  // the overlay QuickInput; undefined for Escape, or when it could not show (its asker told the user)
  readonly askInput: AskInput;
  readonly mention: (target: FileRef | { readonly path: string }) => Promise<void>;
  // the selected chat's pending attachment, else a new chat's in projectKey; prompt, when given, joins the composer's draft
  readonly addToChat: (projectKey: string, attachment: CommitAttachmentInput, prompt: string | undefined) => Promise<void>;
  readonly send: {
    view(view: ScmView): void;
    state(snapshot: ScmRepoSnapshot): void;
    decorations(decorations: ScmDecorations): void;
    settings(settings: ScmSettings): void;
    command(command: ScmShellCommand): void;
    setInput(input: ScmSetInput): void;
    clone(state: ScmCloneState): void;
    artifactsChanged(changed: ScmArtifactsChanged): void;
    // the Files tree lists the project's shown folders again, so their ignored flags follow git
    filesChanged(projectKey: string): void;
  };
  // MenuState's scm fields changed
  readonly menuChanged: () => void;
  readonly log: (line: string) => void;
  readonly platform: NodeJS.Platform;
}

// An authority's path rules, which its repositories' paths follow: this computer's, or the target's.
export interface PathRules {
  readonly os: NodeJS.Platform;
  readonly flavor: path.PlatformPath;
  same(a: string, b: string): boolean;
  inside(folder: string, target: string): boolean;
}

type Resource = { readonly repoId: string; readonly relativePath: string; readonly group?: ChangeGroup };

export type ScmPaletteRequest =
  | { readonly op: 'init' | 'openRepository' | 'reopenClosed' | 'openParentRepositories' | 'manageUnsafeRepositories' }
  | { readonly op: 'showOutput' | 'closeAllUnmodifiedEditors' }
  | { readonly op: 'openAllChanges' | 'closeAllDiffEditors' }
  | { readonly op: 'closeRepository' | 'closeOtherRepositories' | 'refresh' | 'unstageAll' | 'abortOperation' | 'undoLastCommit' }
  | { readonly op: 'stageAll'; readonly scope: (typeof SCM_STAGE_ALL_SCOPES)[number] }
  | { readonly op: 'discardAll'; readonly scope: (typeof SCM_DISCARD_ALL_SCOPES)[number] }
  | { readonly op: 'openGroupChanges'; readonly group: ChangeGroup }
  | { readonly op: 'fetch'; readonly scope: (typeof SCM_FETCH_SCOPES)[number] }
  | { readonly op: 'pull' | 'sync'; readonly rebase: boolean }
  | { readonly op: 'pullFrom' | 'publish' | 'addRemote' | 'removeRemote' }
  | { readonly op: 'push'; readonly to: boolean; readonly force: boolean; readonly followTags: boolean }
  | { readonly op: 'clone'; readonly recursive: boolean }
  | { readonly op: 'checkout'; readonly detached: boolean }
  | { readonly op: 'createBranch'; readonly from: boolean }
  | { readonly op: 'renameBranch' | 'deleteBranch' | 'deleteRemoteBranch' | 'merge' | 'rebase' | 'cherryPick' | 'stashDropAll' | 'createTag' | 'deleteTag' | 'deleteRemoteTag' | 'pushTags' | 'createWorktree' | 'deleteWorktree' }
  | { readonly op: 'stash'; readonly scope: ScmStashScope }
  | { readonly op: 'stashApply'; readonly pop: boolean; readonly target: 'latest' | 'pick' }
  | { readonly op: 'stashDrop' | 'viewStash'; readonly target: 'pick' };
export type ScmActiveFileOp = 'stage' | 'unstage' | 'discard' | 'openChanges' | 'openFile' | 'openFileHead' | 'addToGitignore' | 'rename' | 'delete';

export interface ScmMenuState {
  // git was found and the selected project is trusted (VS Code's config.git.enabled && !git.missing)
  readonly available: boolean;
  // repositories open in the selected project (VS Code's gitOpenRepositoryCount)
  readonly openRepositoryCount: number;
  readonly closedRepositoryCount: number;
  // the selected repository's operation in progress
  readonly operation: ScmOperation | null;
  readonly unsafeRepositoryCount: number;
  readonly parentRepositoryCount: number;
  readonly untrackedChanges: ScmSettings['untrackedChanges'];
  // the active editor's file has changes in an open repository (VS Code's scmActiveResourceHasChanges)
  readonly activeFileHasChanges: boolean;
  // the active editor's file lies in an open repository (scmActiveResourceRepository)
  readonly activeFileInRepository: boolean;
  // the active editor shows a file on disk (resourceScheme == file)
  readonly activeEditorFile: boolean;
  // config.git.allowNoVerifyCommit: the No Verify commit commands are listed
  readonly allowNoVerifyCommit: boolean;
  // the selected repository's commit box is in amend mode, so every commit command amends
  readonly amending: boolean;
  // git was found, whatever the selected project's trust (VS Code's !git.missing), which Clone needs alone
  readonly gitFound: boolean;
  // config.git.allowForcePush: the force push commands exist
  readonly allowForcePush: boolean;
  // a remote operation runs on the selected repository (VS Code's operationInProgress for the remote commands)
  readonly remoteRunning: boolean;
  // git 2.35 or later: Stash Staged is listed (VS Code's gitVersion2.35)
  readonly stashStaged: boolean;
}

// Before startup finished: nothing open.
export const NO_SCM_MENU_STATE: ScmMenuState = {
  available: false,
  openRepositoryCount: 0,
  closedRepositoryCount: 0,
  operation: null,
  unsafeRepositoryCount: 0,
  parentRepositoryCount: 0,
  untrackedChanges: 'mixed',
  activeFileHasChanges: false,
  activeFileInRepository: false,
  activeEditorFile: false,
  allowNoVerifyCommit: false,
  amending: false,
  gitFound: false,
  allowForcePush: false,
  remoteRunning: false,
  stashStaged: false,
};

type Flow<K extends ScmOp> = (host: ScmHost, request: Extract<ScmRunRequest, { op: K }>) => Promise<ScmRunResult>;
type FlowRegistry = { readonly [K in ScmOp]: Flow<K> };

const SCM_GROUP_NAMES: readonly ChangeGroup[] = ['merge', 'index', 'workingTree', 'untracked'];

const GIT_DOWNLOAD: Readonly<Partial<Record<NodeJS.Platform, string>>> = { win32: 'https://git-scm.com/download/win', darwin: 'https://git-scm.com/download/mac' };

// The user flows, one per op.
const FLOWS: FlowRegistry = {
  init: async (host, request) => {
    await host.deps.service.init(request.projectKey);
    return OK;
  },
  openRepository: (host, request) => host.openRepository(request.projectKey),
  reopenClosed: (host, request) => host.reopenClosed(request.projectKey),
  openParentRepositories: async (host, request) => {
    await host.deps.service.openParents(request.projectKey);
    return OK;
  },
  manageUnsafeRepositories: (host, request) => host.manageUnsafe(request.projectKey),
  showOutput: async (host) => {
    host.deps.showGitLog();
    return OK;
  },
  openGitDownload: async (host) => {
    await host.deps.openExternal(GIT_DOWNLOAD[host.deps.platform] ?? 'https://git-scm.com/download/linux');
    return OK;
  },
  closeRepository: async (host, request) => {
    await host.deps.service.close([request.repoId]);
    return OK;
  },
  closeOtherRepositories: async (host, request) => {
    const others = host.projectOfRepo(request.repoId)?.repos.filter((repo) => repo.repoId !== request.repoId).map((repo) => repo.repoId) ?? [];
    await host.deps.service.close(others);
    return OK;
  },
  refresh: async (host, request) => {
    host.deps.service.refresh(request.repoId);
    return OK;
  },
  stage: async (host, request) => ((await host.deps.service.stage(request.repoId, request.paths)) ? OK : CANCELLED),
  unstage: async (host, request) => {
    await host.deps.service.unstage(request.repoId, request.paths);
    return OK;
  },
  discard: async (host, request) => ((await host.deps.service.discard(request.repoId, request.paths)) ? OK : CANCELLED),
  stageAll: async (host, request) => ((await host.deps.service.stageAll(request.repoId, request.scope)) ? OK : CANCELLED),
  unstageAll: async (host, request) => {
    await host.deps.service.unstage(request.repoId, 'all');
    return OK;
  },
  discardAll: async (host, request) => ((await host.deps.service.discardAll(request.repoId, request.scope)) ? OK : CANCELLED),
  abortOperation: async (host, request) => {
    await host.deps.service.abortOperation(request.repoId);
    return OK;
  },
  addToGitignore: async (host, request) => {
    const file = await host.deps.service.addToGitignore(request.repoId, request.paths);
    await host.openRepoFile(host.repo(request.repoId), file);
    return OK;
  },
  // a target's path is never shown in this computer's file manager
  reveal: async (host, request) => {
    const repo = host.repo(request.repoId);
    if (repo.authority === 'local') await host.deps.reveal(await repo.confinedEntry(request.path));
    return OK;
  },
  mention: async (host, request) => {
    const repo = host.repo(request.repoId);
    const absolute = await repo.confinedEntry(request.path);
    if (repo.authority === 'local') {
      await host.deps.mention(host.fileRefOf(absolute) ?? { path: absolute });
      return OK;
    }
    await host.deps.mention(host.remoteRef(repo, absolute));
    return OK;
  },
  openChanges: (host, request) => host.openChanges(request.repoId, request.path, request.group),
  openFile: async (host, request) => {
    const repo = host.repo(request.repoId);
    await host.openRepoFile(repo, await repo.confinedEntry(request.path));
    return OK;
  },
  openFileHead: (host, request) => host.openFileHead(request.repoId, request.path),
  openGroupChanges: (host, request) => host.openGroupChanges(request.repoId, request.group),
  undoLastCommit: (host, request) => host.undoLastCommit(request.repoId),
  restoreCommitTemplate: async (host, request) => {
    const template = await host.repo(request.repoId).commitTemplate();
    host.deps.send.setInput({ repoId: request.repoId, message: template ?? '', cause: 'template' });
    return OK;
  },
  fetch: (host, request) => host.fetch(request.repoId, request.scope),
  pull: (host, request) => host.pull(request.repoId, request.rebase),
  pullFrom: (host, request) => host.pullFrom(request.repoId),
  push: (host, request) => host.push(request.repoId, request),
  sync: (host, request) => host.sync(request.repoId, request.rebase),
  publish: (host, request) => host.publish(request.repoId),
  addRemote: async (host, request) => {
    const added = await host.addRemote(request.repoId);
    return typeof added === 'string' ? OK : added;
  },
  removeRemote: (host, request) => host.removeRemote(request.repoId),
  clone: (host, request) => host.clone(request.recursive),
  cancel: async (host, request) => {
    host.deps.service.cancel(request.repoId);
    return OK;
  },
  cancelClone: async (host) => {
    host.deps.service.cancelClone();
    return OK;
  },
  checkout: (host, request) => (request.commit !== undefined ? host.withCommit(request.repoId, request.commit, () => host.refs.checkoutCommit(request.repoId, request.commit!)) : host.refs.checkout(request.repoId, request.detached, request.ref)),
  createBranch: (host, request) =>
    request.commit !== undefined ? host.withCommit(request.repoId, request.commit, () => host.refs.createBranch(request.repoId, false, undefined, '', request.commit)) : host.refs.createBranch(request.repoId, request.from, request.ref),
  renameBranch: (host, request) => host.refs.renameBranch(request.repoId),
  deleteBranch: (host, request) => host.refs.deleteBranch(request.repoId, request.ref),
  deleteRemoteBranch: (host, request) => host.refs.deleteRemoteBranch(request.repoId, request.ref),
  merge: (host, request) => host.refs.integrate(request.repoId, 'merge', request.ref),
  rebase: (host, request) => host.refs.integrate(request.repoId, 'rebase', request.ref),
  stash: (host, request) => host.refs.stash(request.repoId, request.scope),
  stashChanges: (host, request) => host.refs.stashChanges(request.repoId, request.paths),
  stashApply: (host, request) => host.refs.stashApply(request.repoId, request.pop, request.target),
  stashDrop: (host, request) => host.refs.stashDrop(request.repoId, request.target),
  stashDropAll: (host, request) => host.refs.stashDropAll(request.repoId),
  viewStash: (host, request) => host.refs.viewStash(request.repoId, request.target),
  createTag: (host, request) => (request.commit !== undefined ? host.withCommit(request.repoId, request.commit, () => host.refs.createTag(request.repoId, request.commit)) : host.refs.createTag(request.repoId)),
  deleteTag: (host, request) => host.refs.deleteTag(request.repoId, request.ref),
  deleteRemoteTag: (host, request) => host.refs.deleteRemoteTag(request.repoId),
  pushTags: (host, request) => host.refs.pushTags(request.repoId, () => void host.runRequest({ op: 'addRemote', repoId: request.repoId })),
  createWorktree: (host, request) => host.refs.createWorktree(request.repoId),
  deleteWorktree: (host, request) => host.refs.deleteWorktree(request.repoId, request.path),
  compareRef: (host, request) => host.refs.compareRef(request.repoId, request.ref),
  openWorktree: (host, request) => host.openWorktree(request.repoId, request.path),
  compareWithWorkspace: (host, request) => host.compareWithWorkspace(request.repoId, request.path),
  stageRanges: (host, request) => host.stageRanges(request),
  unstageRanges: (host, request) => host.stageRanges(request),
  refuseRanges: async (host, request) => host.refuseRanges(request.action, request.reason),
  completeMerge: (host, request) => host.completeMerge(request.repoId, request.path, request.documentId),
  openCommit: (host, request) => host.withCommit(request.repoId, request.commit, () => host.openCommit(request.repoId, request.commit, request.path)),
  openTimeline: (host, request) => host.openTimeline(request.repoId, request.path),
  openMergeEditor: (host, request) => host.openMergeEditor(request.repoId, request.path),
  compareCommits: (host, request) => host.withCommit(request.repoId, request.left.commit, () => host.withCommit(request.repoId, request.right.commit, () => host.compareCommits(request.repoId, request.left, request.right))),
  compareCommit: (host, request) => host.withCommit(request.repoId, request.commit, () => host.refs.compareCommit(request.repoId, request.commit)),
  compareWithRemote: (host, request) => host.withCommit(request.repoId, request.commit, () => host.compareWithHeadRef(request.repoId, request.commit, 'upstream')),
  compareWithMergeBase: (host, request) => host.withCommit(request.repoId, request.commit, () => host.compareWithHeadRef(request.repoId, request.commit, 'base')),
  cherryPick: (host, request) => host.cherryPick(request.repoId, request.commit),
  addCommitToChat: (host, request) => host.withCommit(request.repoId, request.commit, () => host.commitToChat(request.repoId, request.commit, false)),
  explainCommit: (host, request) => host.withCommit(request.repoId, request.commit, () => host.commitToChat(request.repoId, request.commit, true)),
  openGraphChanges: (host, request) => host.openGraphChanges(request.repoId, request.direction),
};

// A text document's encoding and byte order mark, which its file's blobs are read and written in.
function codecOf(document: Extract<Document, { kind: 'text' }>): TextCodec {
  return { encoding: document.encoding, bom: document.bom };
}

const shortHash = (hash: string): string => hash.slice(0, 7);

// VS Code's ~ expansion of git.defaultCloneDirectory.
function expandHome(folder: string): string {
  return folder.replace(/^~(?=$|[/\\])/, os.homedir());
}

// A deleted change's folder may be gone, so its lexical path under the root names it; never opened, only shown or copied.
async function entryOrLexical(repo: ScmRepository, relativePath: string): Promise<string> {
  try {
    return await repo.confinedEntry(relativePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    return path.join(repo.root, ...relativePath.split('/'));
  }
}

export class ScmHost {
  readonly deps: ScmHostDeps;
  private readonly pending = { views: new Set<string>(), repos: new Set<string>(), decorations: new Set<string>(), ignores: new Set<string>(), artifacts: new Map<string, Set<ScmArtifactGroup>>(), refs: new Map<string, ScmRefsChange>(), clone: false };
  readonly refs: RefFlows;
  // the commit pairs of View Stash and Compare tabs, by pairKey, dropped once no open tab holds them; commits never change, so
  // an entry stays valid
  private readonly pairs = new Map<string, CommitPairDiff>();
  private flushScheduled = false;
  private disposed = false;
  // the repository whose commit box amends, from the shell's last report; cleared wherever the box leaves amend mode
  private amendingRepoId: string | undefined;
  private readonly subscriptions: Array<{ dispose(): void }>;

  constructor(deps: ScmHostDeps) {
    this.deps = deps;
    this.refs = new RefFlows({
      deps,
      repo: (repoId) => this.repo(repoId),
      pathsOf: (authority) => this.pathsOf(authority),
      setting: (key, fallback) => this.read(key, fallback),
      closeStashTabs: (repoId, hash) => this.closeStashTabs(repoId, hash),
      openStash: (repoId, stash) => this.openStash(repoId, stash),
      openRefsChanges: (repoId, left, right) => this.openRefsChanges(repoId, left, right),
      worktreeProject: (repoId, worktreePath) => this.worktreeProject(repoId, worktreePath),
      runRequest: (request) => this.runRequest(request),
    });
    this.subscriptions = [
      deps.service.onDidChange((event) => {
        if (event.kind === 'view') this.pending.views.add(event.projectKey);
        else if (event.kind === 'repository') this.pending.repos.add(event.repoId);
        else if (event.kind === 'ignores') this.pending.ignores.add(event.projectKey);
        else if (event.kind === 'clone') this.pending.clone = true;
        else if (event.kind === 'artifacts') {
          const groups = this.pending.artifacts.get(event.repoId) ?? new Set<ScmArtifactGroup>();
          for (const group of event.groups) groups.add(group);
          this.pending.artifacts.set(event.repoId, groups);
          // an engine change within the coalesced batch wins, since the shell reloads on it whatever its scroll
          if (event.refs !== undefined && this.pending.refs.get(event.repoId) !== 'engine') this.pending.refs.set(event.repoId, event.refs);
        }
        else this.pending.decorations.add(event.projectKey);
        this.scheduleFlush();
      }),
      deps.settings.onDidChange('damocles.desktop.git', () => {
        deps.send.settings(this.settings());
        deps.menuChanged();
      }),
      deps.editorPane.onDidChangeActiveContext(() => deps.menuChanged()),
    ];
  }

  setProjects(projects: readonly Project[]): void {
    this.deps.service.setProjects(projects.map((project) => ({ key: project.key, path: project.fsPath })));
    this.selectedProjectChanged();
  }

  /** The repository holding a root's folder, the first a view lists, and its last status; undefined until one opened. */
  rootRepository(rootKey: string): { readonly repoId: string; readonly hasRemote: boolean; readonly detached: boolean; readonly branch?: string } | undefined {
    const repo = this.deps.service.view(rootKey)?.repos.find((candidate) => candidate.kind === 'root');
    const status = repo ? this.deps.service.snapshot(repo.repoId)?.status : undefined;
    if (!repo) return undefined;
    const head = status?.head;
    return { repoId: repo.repoId, hasRemote: (status?.remotes.length ?? 0) > 0, detached: head?.type === 'detached', ...(head?.type === 'branch' ? { branch: head.name } : {}) };
  }

  /** D30 and D9: the root of the repository holding the project folder that source control opened, its own or a parent's. */
  projectRepository(projectKey: string): string | undefined {
    const repo = this.deps.service.view(projectKey)?.repos.find((candidate) => candidate.kind === 'root') ?? this.deps.service.view(projectKey)?.repos.find((candidate) => candidate.kind === 'parent');
    return repo ? this.deps.service.repository(repo.repoId)?.repo.root : undefined;
  }

  /** projectRepository once the project's discovery settled. */
  async projectRepositoryWhenReady(projectKey: string): Promise<string | undefined> {
    await this.discovered(projectKey);
    return this.projectRepository(projectKey);
  }

  /** The repository of a root once its discovery settled (the root is in the list setProjects last gave). */
  async rootRepositoryWhenReady(rootKey: string): Promise<string | undefined> {
    await this.discovered(rootKey);
    return this.rootRepository(rootKey)?.repoId;
  }

  private async discovered(rootKey: string): Promise<void> {
    // a root main lists but has not handed to the service yet (setProjects follows a project change) has not settled either
    const settled = (): boolean => {
      const view = this.deps.service.view(rootKey);
      return view ? view.state !== 'loading' : !this.deps.projects().some((project) => project.key === rootKey);
    };
    if (!settled()) {
      await new Promise<void>((resolve) => {
        const subscription = this.deps.service.onDidChange((event) => {
          if (event.kind !== 'view' || !settled()) return;
          subscription.dispose();
          resolve();
        });
      });
    }
  }

  /** Autofetch follows the selected project (AD4). */
  selectedProjectChanged(): void {
    this.deps.service.setAutofetchProject(this.deps.selectedProjectKey());
  }

  /** One autofetch round of the selected project now; only the gated e2e hook calls it. Settles once core started it. */
  autofetchNow(): Promise<void> {
    return this.deps.service.autofetchNow();
  }

  state(): ScmShellState {
    const views = this.deps.service.projectKeys().flatMap((key) => {
      const view = this.view(key);
      return view ? [view] : [];
    });
    const snapshots = views.flatMap((view) => view.repos.flatMap((repo) => {
      const snapshot = this.snapshot(repo.repoId);
      return snapshot ? [snapshot] : [];
    }));
    return { views, snapshots, decorations: views.map((view) => this.decorations(view.projectKey)), settings: this.settings(), clone: this.deps.service.cloneState(), capabilities: this.capabilities() };
  }

  /** Selects a repository; the view naming it follows through the coalesced flush, after this returns. */
  select(raw: unknown): void {
    const request = parseScmSelect(raw);
    if (!request) throw new Error('Malformed source control selection from the shell');
    const view = this.deps.service.view(request.projectKey);
    const repo = view?.repos.find((candidate) => candidate.repoId === request.repoId);
    // closed or removed since the shell's last view, which the next view corrects
    if (!view || !repo) return;
    if (this.amendingRepoId !== repo.repoId) this.amendingRepoId = undefined;
    this.deps.selection.set(request.projectKey, repo.root);
    this.pending.views.add(request.projectKey);
    this.scheduleFlush();
    this.deps.menuChanged();
  }

  /** The shell's amend mode for its selected repository; a repository main no longer has is answered and dropped. */
  amend(raw: unknown): void {
    const report = parseScmAmend(raw);
    if (!report) throw new Error('Malformed amend report from the shell');
    if (!this.deps.service.repository(report.repoId)) return;
    this.setAmending(report.amending ? report.repoId : undefined);
  }

  async run(raw: unknown): Promise<ScmRunResult> {
    const request = parseScmRun(raw);
    if (!request) throw new Error('Malformed source control request from the shell');
    return this.runRequest(request);
  }

  async runRequest(request: ScmRunRequest): Promise<ScmRunResult> {
    if ('repoId' in request && !this.deps.service.repository(request.repoId)) return { ok: false, reason: 'unknown' };
    if ('projectKey' in request && !this.deps.service.view(request.projectKey)) return { ok: false, reason: 'unknown' };
    const flow = FLOWS[request.op] as Flow<typeof request.op>;
    try {
      return await flow(this, request as never);
    } catch (err) {
      // a repository closed while its flow waited (a picker, a question) is answered as one main no longer has
      if ('repoId' in request && !this.deps.service.repository(request.repoId)) return { ok: false, reason: 'unknown' };
      this.deps.log(`[scm] ${request.op} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof StashKeptError && 'repoId' in request) return this.stashKept(request.repoId, err);
      if (err instanceof SyncBranchChangedError) {
        void this.deps.notify.warn(this.syncBranchChanged(err));
        return TOLD;
      }
      this.failed(gitErrorText(err), this.forwardingOffer(request, err));
      return TOLD;
    }
  }

  // The engine's stash or git's autostash could not be applied back: the operation's failure or conflict first, then where the
  // changes are, with View Stash when the stash is still listed.
  private async stashKept(repoId: string, err: StashKeptError): Promise<ScmRunResult> {
    const t = this.deps.t;
    if (err.outcome === 'failed') this.failed(gitErrorText(err.cause ?? err));
    else if (err.outcome === 'conflict') void this.deps.notify.warn(t('There are merge conflicts. Please resolve them before committing your changes.'));
    const listed = err.stash === undefined || !this.deps.service.repository(repoId) ? undefined : await this.deps.service.artifacts(repoId, 'stashes').catch(() => undefined);
    const stash = listed?.group === 'stashes' ? listed.rows.find((row) => row.hash === err.stash) : undefined;
    if (!stash) {
      void this.deps.notify.warn(err.message);
      return TOLD;
    }
    const view = t('View Stash');
    void this.deps.notify.warn(t('Your changes were stashed for this operation and could not be applied back, so they are kept in the stash list as stash #{0}: {1}.', stash.index, visibleText(stash.description)), view).then((choice) => {
      if (choice === view) void this.runRequest({ op: 'viewStash', repoId, target: { index: stash.index, hash: stash.hash } });
    });
    return TOLD;
  }

  private syncBranchChanged(err: SyncBranchChangedError): string {
    const t = this.deps.t;
    const named = (branch: SyncBranch | null): string => (branch ? t('"{0}" tracking "{1}/{2}"', visibleText(branch.branch), visibleText(branch.remote), visibleText(branch.upstreamBranch)) : t('no branch with an upstream'));
    return err.stage === 'pull'
      ? t('The sync was confirmed for {0}, but the repository is now on {1}, so nothing was pulled or pushed.', named(err.confirmed), named(err.found))
      : t('The sync was confirmed for {0}, but after the pull the repository is on {1}, so nothing was pushed.', named(err.confirmed), named(err.found));
  }

  /**
   * A commit (VS Code's smartCommit): the save-before-commit prompt here, then core's questions and the protected branch's name
   * input, the commit, the box's new text and the post-commit command. The reasons the shell shows inline get no notice;
   * failed gets one with Show Git Output.
   */
  async commit(raw: unknown): Promise<ScmCommitResult> {
    const request = parseScmCommit(raw);
    if (!request) throw new Error('Malformed commit from the shell');
    const target = this.deps.service.repository(request.repoId);
    if (!target) return { ok: false, reason: 'unknown' };
    try {
      // Commit Empty skips the save prompt, as VS Code's empty option does
      // a remote repository's files are saved through its own workspace, never matched against this computer's buffers
      const saved = request.variant.empty || target.repo.authority !== 'local' ? [] : await this.saveBeforeCommit(request.repoId, target.repo.root);
      if (saved === undefined) return { ok: false, reason: 'cancelled' };
      const outcome = await this.deps.service.commit(request.repoId, request.message, request.variant, { saved, branchName: () => this.askBranchName() });
      if (!outcome.ok) {
        if (outcome.reason === 'failed') this.failed(gitErrorText(outcome.error));
        return { ok: false, reason: outcome.reason };
      }
      this.leaveAmend(request.repoId);
      const commitInput = await this.freshCommitInput(request.repoId);
      this.runPostCommitCommand(request.repoId, request.postCommit);
      // VS Code's commitOperationCleanup puts getInputTemplate in the box: a MERGE_MSG the commit left (a rebase's next pick), else the template
      const inputTemplate = this.deps.service.snapshot(request.repoId)?.status?.mergeMessage ?? commitInput?.template ?? '';
      return { ok: true, message: inputTemplate, ...(commitInput ? { commitInput } : {}) };
    } catch (err) {
      this.deps.log(`[scm] commit failed: ${err instanceof Error ? err.message : String(err)}`);
      this.failed(gitErrorText(err));
      return { ok: false, reason: 'failed' };
    }
  }

  /** The commit box's template, history and HEAD message; empty for an id main no longer knows. */
  async commitInput(raw: unknown): Promise<ScmCommitInput> {
    const request = parseScmRepoRef(raw);
    if (!request) throw new Error('Malformed request from the shell');
    const empty: ScmCommitInput = { template: null, history: [], headMessage: null };
    if (!this.deps.service.repository(request.repoId)) return empty;
    return this.whileOpen(request.repoId, () => this.deps.service.commitInput(request.repoId), empty);
  }

  // A read of a repository that closed while it ran (a chat worktree's root leaving source control, or its folder removed)
  // answers as one main no longer has, since the shell learns of the close only from the next view; any other failure rejects.
  private async whileOpen<T>(repoId: string, read: () => Promise<T>, closed: T): Promise<T> {
    try {
      return await read();
    } catch (err) {
      if (this.deps.service.repository(repoId)) throw err;
      this.deps.log(`[scm] a read of a repository that closed meanwhile answers as closed: ${gitErrorText(err)}`);
      return closed;
    }
  }

  async generateMessage(raw: unknown): Promise<ScmGenerateResult> {
    const request = parseScmRepoRef(raw);
    if (!request) throw new Error('Malformed request from the shell');
    const target = this.deps.service.repository(request.repoId);
    if (!target) return { ok: false };
    const t = this.deps.t;
    const result = await this.deps.service.generateMessage(request.repoId).catch((err: unknown) => {
      this.deps.log(`[scm] generating a commit message failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false as const, reason: 'failed' as const };
    });
    if (result.ok) return result;
    const reasons: Record<typeof result.reason, string> = {
      noChanges: t('There are no changes to describe.'),
      unreachable: t('No model could be reached. Check the Background model in Settings.'),
      credential: t('The Background model\'s provider refused the sign-in. Sign in again in Settings › Models & accounts.'),
      forbidden: t('The Background model\'s provider refused access.'),
      rejected: t('The model refused the request.'),
      unanswered: t('The model gave no usable message.'),
      failed: t('Git could not read the changes.'),
    };
    void this.deps.notify.warn(`${t('Couldn\'t generate a commit message')}. ${reasons[result.reason]}`);
    return { ok: false };
  }

  /** The quick diff's base for an open text document of a file in this repository, or why the file gets no marks. */
  async quickDiffBase(raw: unknown): Promise<ScmQuickDiffBaseResult> {
    const request = parseScmPath(raw);
    if (!request) throw new Error('Malformed quick diff request from the shell');
    const repo = this.deps.service.repository(request.repoId)?.repo;
    if (!repo) return { ok: false, reason: 'unknown' };
    const document = this.documentOf(repo, request.path);
    if (document && document.kind !== 'text') return { ok: false, reason: document.kind === 'notDisplayed' && document.reason === 'tooLarge' ? 'tooLarge' : 'binary' };
    if (document?.readOnlyReason === 'tooLarge') return { ok: false, reason: 'tooLarge' };
    const base = await this.whileOpen(request.repoId, () => this.deps.service.quickDiffBase(request.repoId, request.path, document ? codecOf(document) : undefined), undefined);
    if (!base) return { ok: false, reason: 'unknown' };
    return base.ok ? { ok: true, indexText: base.indexText, indexOid: base.indexOid, headText: base.headText, headOid: base.headOid, hasStaged: base.hasStaged } : base;
  }

  /** HEAD's blame of a file; a git failure is logged and answers failed. */
  async blame(raw: unknown): Promise<ScmBlameResult> {
    const request = parseScmPath(raw);
    if (!request) throw new Error('Malformed blame request from the shell');
    if (!this.deps.service.repository(request.repoId)) return { ok: false, reason: 'unknown' };
    try {
      const read = await this.whileOpen(request.repoId, () => this.deps.service.blame(request.repoId, request.path), undefined);
      if (!read) return { ok: false, reason: 'unknown' };
      return read.ok ? { ok: true, head: read.blame.head, commits: read.blame.commits, lines: read.blame.lines } : read;
    } catch (err) {
      this.deps.log(`[scm] blame failed: ${gitErrorText(err)}`);
      return { ok: false, reason: 'failed' };
    }
  }

  /** One page of a file's timeline; a git failure is logged and answers failed. */
  async timeline(raw: unknown): Promise<ScmTimelineResult> {
    const request = parseScmTimeline(raw);
    if (!request) throw new Error('Malformed timeline request from the shell');
    if (!this.deps.service.repository(request.repoId)) return { ok: false, reason: 'unknown' };
    const after = request.cursor === undefined ? undefined : parseScmTimelineCursor(request.cursor);
    try {
      const page = await this.whileOpen(request.repoId, () => this.deps.service.timeline(request.repoId, request.path, after), undefined);
      if (!page) return { ok: false, reason: 'unknown' };
      return {
        ok: true,
        entries: page.entries,
        ...(page.next !== undefined ? { cursor: `${page.next.hash}:${page.next.path}` } : {}),
        hasStaged: page.hasStaged,
        committed: after !== undefined || page.entries.length > 0,
      };
    } catch (err) {
      this.deps.log(`[scm] the timeline failed: ${gitErrorText(err)}`);
      return { ok: false, reason: 'failed' };
    }
  }

  /**
   * One Graph page. A request without a cursor is a load: the ref choice resolves to commits once, and the cursor carries
   * them, so every later page reads that snapshot. A git failure is logged and answers failed.
   */
  async history(raw: unknown): Promise<ScmHistoryResult> {
    const request = parseScmHistory(raw);
    if (!request) throw new Error('Malformed history request from the shell');
    if (!this.deps.service.repository(request.repoId)) return { ok: false, reason: 'noRepository' };
    const next = (cursor: Omit<ScmHistoryCursor, 'skip'>, skip: number, count: number): { cursor?: string } =>
      count === SCM_HISTORY_PAGE && skip + count <= MAX_SCM_HISTORY_SKIP ? { cursor: scmHistoryCursor({ ...cursor, skip: skip + count }) } : {};
    try {
      if (request.cursor !== undefined) {
        const cursor = parseScmHistoryCursor(request.cursor)!;
        const commits = await this.deps.service.historyPage(request.repoId, cursor.tips, cursor.skip, cursor.baseRef);
        return { ok: true, page: { commits, ...next(cursor, cursor.skip, commits.length) } };
      }
      const loaded = await this.deps.service.historyLoad(request.repoId, request.refs);
      if (!loaded) return { ok: false, reason: 'empty' };
      const { load, commits } = loaded;
      const baseRef = load.headRefs.base?.id;
      return {
        ok: true,
        page: {
          commits,
          ...next({ ...(baseRef !== undefined ? { baseRef } : {}), tips: load.tips }, 0, commits.length),
          load: { headRefs: load.headRefs, ...(load.mergeBase !== undefined ? { mergeBase: load.mergeBase } : {}), ahead: load.ahead, behind: load.behind, resolvedRefs: load.resolvedRefs },
        },
      };
    } catch (err) {
      if (!this.deps.service.repository(request.repoId)) return { ok: false, reason: 'noRepository' };
      if (err instanceof GitUntrustedError) return { ok: false, reason: 'untrusted' };
      this.deps.log(`[scm] reading the history failed: ${gitErrorText(err)}`);
      return { ok: false, reason: 'failed' };
    }
  }

  /** An expanded Graph commit: its message, stat and files, for a hash main checks is a commit of the repository. */
  async commitDetails(raw: unknown): Promise<ScmCommitDetailsResult> {
    const request = parseScmCommitDetails(raw);
    if (!request) throw new Error('Malformed commit details request from the shell');
    if (!this.deps.service.repository(request.repoId)) return { ok: false, reason: 'noRepository' };
    try {
      if (!(await this.deps.service.isCommit(request.repoId, request.hash))) return { ok: false, reason: 'notCommit' };
      return { ok: true, details: await this.deps.service.commitDetails(request.repoId, request.hash) };
    } catch (err) {
      if (!this.deps.service.repository(request.repoId)) return { ok: false, reason: 'noRepository' };
      if (err instanceof GitUntrustedError) return { ok: false, reason: 'untrusted' };
      this.deps.log(`[scm] reading a commit's details failed: ${gitErrorText(err)}`);
      return { ok: false, reason: 'failed' };
    }
  }

  /** The merge editor's three inputs and labels, decoded with the conflicted file's document encoding. */
  async mergeInputs(raw: unknown): Promise<ScmMergeInputsResult> {
    const request = parseScmPath(raw);
    if (!request) throw new Error('Malformed merge request from the shell');
    const repo = this.deps.service.repository(request.repoId)?.repo;
    if (!repo) return { ok: false, reason: 'unknown' };
    const document = this.documentOf(repo, request.path);
    if (document?.kind !== 'text') return { ok: false, reason: document ? 'binary' : 'notOpen' };
    try {
      return await this.deps.service.mergeInputs(request.repoId, request.path, codecOf(document), document.text);
    } catch (err) {
      this.deps.log(`[scm] reading the merge inputs failed: ${gitErrorText(err)}`);
      return { ok: false, reason: 'failed' };
    }
  }

  /** Compute Conflicts With Git (Diff3): git merge-file's result for the Result buffer. */
  async mergeFile(raw: unknown): Promise<ScmMergeFileResult> {
    const request = parseScmMergeFile(raw);
    if (!request) throw new Error('Malformed merge request from the shell');
    const repo = this.deps.service.repository(request.repoId)?.repo;
    if (!repo) return { ok: false, reason: 'unknown' };
    const document = this.documentOf(repo, request.path);
    if (document?.kind !== 'text') return { ok: false, reason: document ? 'binary' : 'notOpen' };
    try {
      return await this.deps.service.mergeFile(request.repoId, request.path, codecOf(document), request.diff3, document.text);
    } catch (err) {
      this.deps.log(`[scm] git merge-file failed: ${gitErrorText(err)}`);
      return { ok: false, reason: 'failed' };
    }
  }

  /** The open repository holding a project file, for the Files menu's Open Timeline; null outside every open repository. */
  resource(raw: unknown): ScmResource | null {
    const request = parseScmResource(raw);
    if (!request) throw new Error('Malformed resource request from the shell');
    const project = this.deps.projects().find((candidate) => candidate.key === request.projectKey);
    if (!project) return null;
    const authority = authorityKeyOfProject(project.key);
    const segments = request.relativePath.split('/');
    const found = authority === 'local'
      ? this.resourceAt(path.join(this.projectFolders(project)[0]!, ...segments))
      : this.resourceOf({ path: this.pathsOf(authority).flavor.join(project.fsPath, ...segments), projectKey: project.key, relativePath: request.relativePath });
    return found ? { repoId: found.repoId, path: found.relativePath } : null;
  }

  /** A file's place in an open repository of its own authority (ShellEditorTab.git); untrusted projects have none open. */
  gitOf(location: Location): ShellFileGit | undefined {
    const found = this.resourceOf(location);
    return found ? { repoId: found.repoId, path: found.relativePath } : undefined;
  }

  async fileDiff(raw: unknown): Promise<ScmFileDiffResult> {
    const request = parseScmFileDiff(raw);
    if (!request) throw new Error('Malformed diff request from the shell');
    const repo = this.deps.service.repository(request.repoId)?.repo;
    const source = request.source;
    if (!repo) return { kind: 'missing' };
    if (source.kind === 'stash' || source.kind === 'refs') return this.pairPatch(request.repoId, source, request.path);
    return this.whileOpen(request.repoId, () => repo.diff(source.kind, request.path), { kind: 'missing' } as const);
  }

  /**
   * Copies a path of a change, or a field of a stash, branch, tag or worktree row (VS Code's git.repositories.* copy commands);
   * nothing for a repository main no longer has. A copy that fails (a git read, or a row that changed since the shell listed
   * it) is told as a failed run is, since the page cannot show it; only a malformed request rejects.
   */
  async copy(raw: unknown): Promise<void> {
    const request = parseScmCopy(raw);
    if (!request) throw new Error('Malformed copy from the shell');
    const repo = this.deps.service.repository(request.repoId)?.repo;
    if (!repo) return;
    try {
      await this.copyField(repo, request);
    } catch (err) {
      this.deps.log(`[scm] copy failed: ${err instanceof Error ? err.message : String(err)}`);
      this.failed(gitErrorText(err));
    }
  }

  private async copyField(repo: ScmRepository, request: ScmCopyRequest): Promise<void> {
    if (request.kind === 'commitId' || request.kind === 'commitMessage') {
      if (!(await this.deps.service.isCommit(request.repoId, request.value))) {
        void this.deps.notify.warn(this.deps.t('The commit {0} is not in this repository.', shortHash(request.value)));
        return;
      }
      await this.deps.copy(request.kind === 'commitId' ? request.value : await this.deps.service.commitMessage(request.repoId, request.value));
      return;
    }
    if (request.kind !== 'path' && request.kind !== 'relativePath') {
      const text = await this.rowText(request.repoId, request.kind, request.value);
      // gone meanwhile (a terminal, another window): its row is about to leave the list
      if (text === undefined) {
        const t = this.deps.t;
        void this.deps.notify.info(isObjectName(request.value) ? t('The stash is no longer in this repository.') : t('"{0}" is no longer in this repository.', visibleText(request.value)));
        return;
      }
      await this.deps.copy(text);
      return;
    }
    // only a path of the repository's own status, so the text is main's data and never a renderer's
    const groups = repo.lastStatus?.groups;
    const known = groups !== undefined && SCM_GROUP_NAMES.some((group) => groups[group].some((change) => change.path === request.value || change.originalPath === request.value));
    if (!known) throw new Error('Copy names a path that is not a change of the repository');
    const absolute = await entryOrLexical(repo, request.value);
    const ref = this.fileRefOf(absolute);
    const relative = ref ? ref.relativePath : request.value;
    await this.deps.copy(request.kind === 'path' ? absolute : relative.split('/').join(path.sep));
  }

  // The copied field of the row a stash hash, a full refname or a worktree path names, read from main's fresh list; undefined
  // when the row is gone. The validator matched each kind to the forms it may name.
  private async rowText(repoId: string, kind: Exclude<ScmCopyKind, 'path' | 'relativePath' | 'commitId' | 'commitMessage'>, value: string): Promise<string | undefined> {
    const service = this.deps.service;
    if (isObjectName(value)) {
      const listed = await service.artifacts(repoId, 'stashes');
      const stash = listed.group === 'stashes' ? listed.rows.find((row) => row.hash === value) : undefined;
      if (!stash) return undefined;
      if (kind === 'stashName') return stash.description;
      if (stash.branch === null) throw new Error('Copy names a stash made on no branch');
      return stash.branch;
    }
    if (value.startsWith('refs/')) {
      const listed = await service.artifacts(repoId, value.startsWith('refs/tags/') ? 'tags' : 'branches');
      const row = listed.group === 'branches' || listed.group === 'tags' ? listed.rows.find((candidate) => candidate.ref === value) : undefined;
      if (!row) return undefined;
      if (kind !== 'commitHash') return row.name;
      if (!row.commit) throw new Error('Copy names a ref with no commit');
      return row.commit.hash;
    }
    const listed = await service.artifacts(repoId, 'worktrees');
    const paths = this.pathsOf(this.repo(repoId).authority);
    const worktree = listed.group === 'worktrees' ? listed.rows.find((row) => paths.same(row.path, value)) : undefined;
    if (!worktree) return undefined;
    if (kind === 'worktreePath') return worktree.path;
    const text = kind === 'commitHash' ? worktree.commit?.hash : worktree.branch;
    if (text === undefined || text === null) throw new Error(`Copy names a worktree with no ${kind === 'commitHash' ? 'commit' : 'branch'}`);
    return text;
  }

  /** One group's rows, read fresh; a failure was logged to the Git output by the runner and answers failed. */
  async artifacts(raw: unknown): Promise<ScmArtifactsResult> {
    const request = parseScmArtifacts(raw);
    if (!request) throw new Error('Malformed artifacts request from the shell');
    if (!this.deps.service.repository(request.repoId)) return { ok: false, reason: 'unknown' };
    try {
      const artifacts = await this.deps.service.artifacts(request.repoId, request.group);
      if (artifacts.group !== 'worktrees') return { ok: true, artifacts };
      // a worktree path names a chat or a project of its repository's own authority only
      const authority = this.repo(request.repoId).authority;
      const rows = artifacts.rows.map((row): ScmWorktreeArtifact => {
        const chat = this.deps.worktrees.chatOf(authority, row.path);
        const newChatIn = this.deps.worktrees.newChatTargetAt(authority, row.path);
        const target = newChatIn ? { newChatIn } : {};
        if (chat) return { ...row, opens: 'chat', chat, ...target };
        return { ...row, opens: this.worktreeProject(request.repoId, row.path) === undefined ? 'addProject' : 'project', ...target };
      });
      return { ok: true, artifacts: { group: 'worktrees', rows } };
    } catch (err) {
      this.deps.log(`[scm] reading ${request.group} failed: ${gitErrorText(err)}`);
      return { ok: false, reason: 'failed' };
    }
  }

  /** The Files tree's ignored entries for one listed folder. */
  ignored(projectKey: string, relativeDir: string, entries: ReadonlyArray<{ readonly name: string; readonly kind: 'file' | 'dir' }>): Promise<ReadonlySet<string>> {
    return this.deps.service.ignoredIn(projectKey, relativeDir, entries.map((entry) => ({ name: entry.name, dir: entry.kind === 'dir' })));
  }

  menuState(): ScmMenuState {
    const view = this.selectedView();
    const selected = view?.selectedRepoId ?? null;
    const active = this.activeResource();
    const settings = this.settings();
    return {
      available: view !== undefined && view.state !== 'untrusted' && view.state !== 'gitMissing',
      openRepositoryCount: view?.repos.length ?? 0,
      closedRepositoryCount: view?.closedCount ?? 0,
      operation: selected ? (this.snapshot(selected)?.operation ?? null) : null,
      unsafeRepositoryCount: view?.unsafePaths.length ?? 0,
      parentRepositoryCount: view?.parentCount ?? 0,
      untrackedChanges: settings.untrackedChanges,
      activeFileHasChanges: active?.group !== undefined,
      activeFileInRepository: active !== undefined,
      activeEditorFile: this.deps.editorPane.activeContext()?.filePath !== undefined,
      allowNoVerifyCommit: settings.allowNoVerifyCommit,
      amending: selected !== null && this.amendingRepoId === selected && this.deps.service.repository(selected) !== undefined,
      gitFound: this.deps.gitFound,
      allowForcePush: settings.allowForcePush,
      remoteRunning: selected !== null && (this.deps.service.snapshot(selected)?.running ?? null) !== null,
      stashStaged: this.capabilities().stashStaged,
    };
  }

  /**
   * A palette command on the selected project's selected repository, or its project. One that needs a repository while none
   * is open gets VS Code's error, as its pickRepository gives.
   */
  paletteRun(request: ScmPaletteRequest): void {
    switch (request.op) {
      case 'showOutput':
        void this.runRequest({ op: request.op });
        return;
      case 'closeAllUnmodifiedEditors':
        void this.guarded(request.op, () => this.closeAllUnmodified());
        return;
      case 'init':
      case 'openRepository':
      case 'reopenClosed':
      case 'openParentRepositories':
      case 'manageUnsafeRepositories': {
        const projectKey = this.deps.selectedProjectKey();
        if (projectKey !== undefined) void this.runRequest({ op: request.op, projectKey });
        return;
      }
      case 'clone':
        void this.runRequest(request);
        return;
    }
    const repoId = this.selectedView()?.selectedRepoId ?? undefined;
    if (repoId === undefined) {
      void this.deps.notify.error(this.deps.t('There are no available repositories'));
      return;
    }
    switch (request.op) {
      case 'openAllChanges':
        void this.guarded(request.op, () => this.openAllChanges(repoId));
        return;
      case 'closeAllDiffEditors':
        void this.guarded(request.op, () => this.deps.editorPane.closeScmDiffs(repoId));
        return;
      default:
        void this.runRequest({ ...request, repoId });
    }
  }

  /** A commit command from the palette: the shell holds the drafts, so it commits the selected repository's with the variant. */
  paletteCommit(variant: ScmCommitVariant): void {
    const repoId = this.selectedView()?.selectedRepoId;
    if (repoId) this.deps.send.command({ command: 'commit', repoId, variant });
  }

  /** Stage, Unstage, Discard, Open Changes, Open File, Open File (HEAD), Add to .gitignore, Rename and Delete on the active editor's file. */
  activeFile(op: ScmActiveFileOp): void {
    const active = this.activeResource();
    if (!active) return;
    const { repoId, relativePath, group } = active;
    if (op === 'rename' || op === 'delete') {
      void this.guarded(op, () => (op === 'rename' ? this.rename(repoId, relativePath) : this.delete(repoId, relativePath, group !== undefined)));
      return;
    }
    const request: ScmRunRequest | undefined =
      op === 'stage' || op === 'unstage' || op === 'discard' || op === 'addToGitignore'
        ? { op, repoId, paths: [relativePath] }
        : op === 'openChanges'
          ? group === undefined ? undefined : { op, repoId, path: relativePath, group }
          : { op, repoId, path: relativePath };
    if (request) void this.runRequest(request);
  }

  /** A code tab's Open Changes. */
  async openChangesOf(location: Location): Promise<void> {
    const found = this.resourceOf(location);
    if (found?.group === undefined) return;
    await this.runRequest({ op: 'openChanges', repoId: found.repoId, path: found.relativePath, group: found.group });
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  // flows

  // VS Code's git.fetch, fetchPrune and fetchAll: with several remotes, Fetch picks one or all of them.
  async fetch(repoId: string, scope: (typeof SCM_FETCH_SCOPES)[number]): Promise<ScmRunResult> {
    const t = this.deps.t;
    const remotes = await this.deps.service.remotes(repoId);
    if (remotes.length === 0) {
      void this.deps.notify.warn(t('This repository has no remotes configured to fetch from.'));
      return TOLD;
    }
    if (scope === 'prune') return remote(() => this.deps.service.fetch(repoId, { prune: true }));
    if (scope === 'all' || remotes.length === 1) return remote(() => this.deps.service.fetch(repoId, { all: scope === 'all' }));
    const upstreamRemote = this.repo(repoId).lastStatus?.upstream?.remote;
    const ordered = [...remotes.filter((entry) => entry.name === upstreamRemote), ...remotes.filter((entry) => entry.name !== upstreamRemote)];
    const ALL = { kind: 'all' } as const;
    const picked = await this.pick<Remote | typeof ALL>(t('Select a remote to fetch'), [
      ...ordered.map((entry) => remoteEntry(entry, 'fetch')),
      { value: ALL, item: { label: t('Fetch From All Remotes') } },
    ]);
    if (picked === undefined) return CANCELLED;
    if (picked === ALL) return remote(() => this.deps.service.fetch(repoId, { all: true }));
    const chosen = picked as Remote;
    return remote(() => this.deps.service.fetch(repoId, { remote: chosen.name }));
  }

  async pull(repoId: string, rebase: boolean): Promise<ScmRunResult> {
    if (!(await this.hasRemotes(repoId, 'pull'))) return TOLD;
    return remote(() => this.deps.service.pull(repoId, { rebase }));
  }

  // VS Code's git.pullFrom: a remote (skipped with one), then one of its fetched branches.
  async pullFrom(repoId: string): Promise<ScmRunResult> {
    const t = this.deps.t;
    const remotes = (await this.deps.service.remotes(repoId)).filter((entry) => entry.fetchUrl !== undefined);
    if (remotes.length === 0) {
      void this.deps.notify.warn(t('Your repository has no remotes configured to pull from.'));
      return TOLD;
    }
    const chosen = remotes.length === 1 ? remotes[0] : await this.pick(t('Pick a remote to pull the branch from'), remotes.map((entry) => remoteEntry(entry, 'fetch')));
    if (!chosen) return CANCELLED;
    const branches = await this.deps.service.remoteBranches(repoId, chosen.name);
    if (branches.length === 0) {
      void this.deps.notify.warn(t('The remote "{0}" has no fetched branches. Fetch it first.', visibleText(chosen.name)));
      return TOLD;
    }
    const branch = await this.pick(t('Pick a branch to pull from'), branches.map((name) => ({ value: name, item: { label: `${chosen.name}/${name}` } })));
    if (branch === undefined) return CANCELLED;
    return remote(() => this.deps.service.pull(repoId, { rebase: false, remote: chosen.name, branch }));
  }

  // VS Code's _push: Push to the upstream, Push to... a picked remote, Push (Follow Tags) as push.default says, each with its
  // force variant, which is refused unless allowForcePush and always confirmed. A branch with no upstream offers Publish.
  async push(repoId: string, request: { readonly to: boolean; readonly force: boolean; readonly followTags: boolean }): Promise<ScmRunResult> {
    const t = this.deps.t;
    if (request.force && !this.settings().allowForcePush) {
      void this.deps.notify.error(t('Force push is not allowed, please enable it with the "Allow force push" setting.'));
      return TOLD;
    }
    const remotes = await this.deps.service.remotes(repoId);
    if (remotes.length === 0) {
      const add = t('Add Remote');
      void this.deps.notify.warn(t('Your repository has no remotes configured to push to.'), add).then((choice) => {
        if (choice === add) void this.runRequest({ op: 'addRemote', repoId });
      });
      return TOLD;
    }
    const base = { setUpstream: false, followTags: false, force: request.force };
    if (request.followTags && !request.to) return remote(() => this.deps.service.push(repoId, { ...base, followTags: true }));
    const status = this.repo(repoId).lastStatus;
    const head = status?.head;
    if (head?.type !== 'branch') {
      void this.deps.notify.warn(t('Please check out a branch to push to a remote.'));
      return TOLD;
    }
    if (!request.to) {
      const upstream = status?.upstream;
      if (upstream) return remote(() => this.deps.service.push(repoId, { ...base, remote: upstream.remote, branch: head.name, toBranch: upstream.branch }));
      const choice = await this.deps.ask({ severity: 'warning', message: t('The branch "{0}" has no remote branch. Would you like to publish this branch?', visibleText(head.name)), actions: [t('OK')], cancelLabel: t('Cancel'), defaultAction: 0 });
      return choice === 0 ? this.publish(repoId) : CANCELLED;
    }
    const target = await this.pickPushRemote(repoId, remotes.filter((entry) => entry.pushUrl !== undefined), head.name);
    if (typeof target !== 'string') return target;
    return remote(() => this.deps.service.push(repoId, { ...base, remote: target, branch: head.name }));
  }

  // VS Code's _sync: a detached HEAD or a branch without an upstream pushes (which warns, or offers Publish); otherwise core's
  // confirmSync, pull and push.
  async sync(repoId: string, rebase: boolean): Promise<ScmRunResult> {
    const status = this.repo(repoId).lastStatus;
    if (status?.head?.type !== 'branch' || !status.upstream) return this.push(repoId, { to: false, force: false, followTags: false });
    return remote(() => this.deps.service.sync(repoId, rebase));
  }

  // VS Code's git.publish: push -u to the one remote, or to a picked one (or one Add Remote... creates).
  async publish(repoId: string): Promise<ScmRunResult> {
    const t = this.deps.t;
    const head = this.repo(repoId).lastStatus?.head;
    if (head?.type !== 'branch') {
      void this.deps.notify.warn(t('Please check out a branch to push to a remote.'));
      return TOLD;
    }
    const remotes = await this.deps.service.remotes(repoId);
    if (remotes.length === 0) {
      void this.deps.notify.warn(t('Your repository has no remotes configured to publish to.'));
      return TOLD;
    }
    const target = remotes.length === 1 ? remotes[0]!.name : await this.pickPushRemote(repoId, remotes, head.name);
    if (typeof target !== 'string') return target;
    return remote(() => this.deps.service.push(repoId, { remote: target, branch: head.name, setUpstream: true, followTags: false, force: false }));
  }

  // VS Code's git.addRemote: a URL, then a name, then a fetch of the new remote. Resolves the name, or the result when nothing
  // was added: cancelled, or told when the user was told why.
  async addRemote(repoId: string): Promise<string | ScmRunResult> {
    const t = this.deps.t;
    const url = (await this.deps.askInput({ title: t('Add Remote'), prompt: t('Provide repository URL'), placeholder: t('Repository URL') }))?.trim();
    if (!url) return CANCELLED;
    if (!isRemoteUrl(url)) {
      void this.deps.notify.warn(t('"{0}" is not a repository URL Damocles can use.', visibleText(redactUrls(url))));
      return TOLD;
    }
    const name = (await this.deps.askInput({ title: t('Add Remote'), prompt: t('Please provide a remote name'), placeholder: t('Remote name'), validation: 'remoteName' }))?.trim();
    if (!name) return CANCELLED;
    if (!isRemoteName(name)) {
      void this.deps.notify.warn(t('Remote name format invalid'));
      return TOLD;
    }
    if ((await this.deps.service.remotes(repoId)).some((entry) => entry.name === name)) {
      void this.deps.notify.warn(t('Remote "{0}" already exists.', name));
      return TOLD;
    }
    await this.deps.service.addRemote(repoId, name, url);
    await this.deps.service.fetch(repoId, { remote: name }).catch((err: unknown) => {
      if (!(err instanceof RemoteCancelledError)) throw err;
    });
    return name;
  }

  async removeRemote(repoId: string): Promise<ScmRunResult> {
    const t = this.deps.t;
    const remotes = await this.deps.service.remotes(repoId);
    if (remotes.length === 0) {
      void this.deps.notify.error(t('Your repository has no remotes.'));
      return TOLD;
    }
    const chosen = await this.pick(t('Pick a remote to remove'), remotes.map((entry) => remoteEntry(entry, 'fetch')));
    if (!chosen) return CANCELLED;
    await this.deps.service.removeRemote(repoId, chosen.name);
    return OK;
  }

  // VS Code's clone: a URL, a folder from the OS picker opened at defaultCloneDirectory (else the home folder), the clone, then
  // openAfterClone. Clone runs no code of an existing repository, so no project's trust decides it; the clone joins the
  // projects untrusted, and adding it asks for trust as any added project does.
  async clone(recursive: boolean): Promise<ScmRunResult> {
    const t = this.deps.t;
    const typed = (await this.deps.askInput({ title: recursive ? t('Clone (Recursive)') : t('Clone'), prompt: t('Provide repository URL'), placeholder: t('Repository URL') }))?.trim();
    const url = typed?.replace(/^git\s+clone\s+/, '');
    if (!url) return CANCELLED;
    if (!isRemoteUrl(url)) {
      void this.deps.notify.warn(t('"{0}" is not a repository URL Damocles can use.', visibleText(redactUrls(url))));
      return TOLD;
    }
    const configured = expandHome(this.read(SCM_SETTING_KEYS.defaultCloneDirectory, '').trim());
    const opensAt = path.isAbsolute(configured) ? configured : os.homedir();
    const parent = await this.deps.pickFolder(opensAt, t('Choose a folder to clone {0} into', visibleText(redactUrls(url))), t('Select as Repository Destination'));
    if (parent === undefined) return CANCELLED;
    let target: string;
    try {
      target = await this.deps.service.clone(url, parent, recursive);
    } catch (err) {
      if (err instanceof RemoteCancelledError) return CANCELLED;
      throw err;
    }
    const mode = this.read<OpenAfterClone>(SCM_SETTING_KEYS.openAfterClone, 'prompt');
    if (mode === 'prompt') {
      const choice = await this.deps.ask({ severity: 'info', message: t('Would you like to open the cloned repository?'), detail: visibleText(target), actions: [t('Add Project')], cancelLabel: t('Cancel'), defaultAction: 0 });
      if (choice !== 0) return OK;
    }
    await this.deps.addProject('local', target);
    return OK;
  }

  // Push to... and Publish's remote picker; Add a new remote... adds one first. Resolves the remote's name, or the result
  // when there is none.
  private async pickPushRemote(repoId: string, remotes: readonly Remote[], branch: string): Promise<string | ScmRunResult> {
    const t = this.deps.t;
    const ADD = { kind: 'add' } as const;
    const picked = await this.pick<Remote | typeof ADD>(placeholderNaming(t, 'Pick a remote to publish the branch "{0}" to:', branch), [
      ...remotes.map((entry) => remoteEntry(entry, 'push')),
      { value: ADD, item: { label: t('Add a new remote...') } },
    ]);
    if (picked === undefined) return CANCELLED;
    return picked === ADD ? this.addRemote(repoId) : (picked as Remote).name;
  }

  private async hasRemotes(repoId: string, purpose: 'pull'): Promise<boolean> {
    if ((await this.deps.service.remotes(repoId)).length > 0) return true;
    if (purpose === 'pull') void this.deps.notify.warn(this.deps.t('Your repository has no remotes configured to pull from.'));
    return false;
  }

  // VS Code's undoCommit: the undone commit's message goes back in the box.
  async undoLastCommit(repoId: string): Promise<ScmRunResult> {
    const outcome = await this.deps.service.undoLastCommit(repoId);
    if (outcome.kind === 'noCommit') {
      void this.deps.notify.warn(this.deps.t('Can\'t undo because HEAD doesn\'t point to any commit.'));
      return OK;
    }
    if (outcome.kind === 'cancelled') return CANCELLED;
    this.leaveAmend(repoId);
    const commitInput = await this.freshCommitInput(repoId);
    this.deps.send.setInput({ repoId, message: outcome.message, cause: 'undo', ...(commitInput ? { commitInput } : {}) });
    return OK;
  }

  // Read after the change landed, which already happened: a failed read is logged and the shell reads the input again.
  private freshCommitInput(repoId: string): Promise<ScmCommitInput | undefined> {
    return this.deps.service.commitInput(repoId).catch((err: unknown) => {
      this.deps.log(`[scm] reading the commit input after a commit or undo failed: ${gitErrorText(err)}`);
      return undefined;
    });
  }

  // VS Code's git.rename on the active file: git mv, then its tabs follow it as a Files rename's do, keeping unsaved edits; a
  // file outside every project, or moved to another project, closes and opens again at its new path, as VS Code's command
  // does. A remote repository's files are named only as its host's project files (remoteRef), both before git runs.
  async rename(repoId: string, from: string): Promise<void> {
    const repo = this.repo(repoId);
    const t = this.deps.t;
    const answer = await this.deps.askInput({
      title: t('Rename'),
      prompt: t('Press \'Enter\' to confirm your input or \'Escape\' to cancel'),
      value: from,
      valueSelection: [from.length - path.posix.basename(from).length, from.length],
      validation: 'path',
    });
    const to = answer?.trim();
    if (!to || to === from) return;
    // the answer passed validation before the trim, and core refuses a Windows-unsafe name with a generic failure
    if (inputProblem('path', to, { windows: this.pathsOf(repo.authority).os === 'win32' }) !== undefined) {
      void this.deps.notify.warn(t('{0} is not a valid file or folder name.', visibleText(to)));
      return;
    }
    const remote = repo.authority !== 'local';
    const source = remote ? this.remotePathRef(repo, from) : this.fileRefOf(path.join(repo.root, ...from.split('/')));
    const target = remote ? this.remotePathRef(repo, to) : this.fileRefOf(path.join(repo.root, ...to.split('/')));
    if (source && target && source.projectKey === target.projectKey) {
      await this.deps.editorPane.fileRenamed(source.projectKey, source.relativePath, async () => {
        await this.deps.service.move(repoId, from, to);
        return { ok: true, relativePath: target.relativePath };
      });
      return;
    }
    await this.deps.service.move(repoId, from, to);
    await this.deps.editorPane.closeActive(source ?? { path: path.join(repo.root, ...from.split('/')) }, { cleanOnly: false });
    await this.openRepoFile(repo, await repo.confinedEntry(to));
  }

  // VS Code's git.delete: a file with uncommitted changes is refused; otherwise git rm, and its tab closes unless it is dirty.
  // A remote repository's file is its host's project file (remoteRef), resolved before git runs.
  async delete(repoId: string, relativePath: string, changed: boolean): Promise<void> {
    if (changed) {
      void this.deps.notify.info(this.deps.t('Git: Delete can only be performed on committed files without uncommitted changes.'));
      return;
    }
    const repo = this.repo(repoId);
    const file = repo.authority === 'local' ? { path: path.join(repo.root, ...relativePath.split('/')) } : this.remotePathRef(repo, relativePath);
    await this.deps.service.remove(repoId, [relativePath]);
    await this.deps.editorPane.closeActive(file, { cleanOnly: true });
  }

  // VS Code's git.openAllChanges: every working tree and untracked change that still exists, opened without taking the active tab.
  async openAllChanges(repoId: string): Promise<void> {
    const repo = this.repo(repoId);
    const groups = repo.lastStatus?.groups;
    const gone: ReadonlySet<string> = new Set(['DELETED', 'DELETED_BY_THEM', 'DELETED_BY_US', 'BOTH_DELETED']);
    const files: Array<{ readonly path: string } | { readonly file: FileRef }> = [];
    for (const change of [...(groups?.workingTree ?? []), ...(groups?.untracked ?? [])]) {
      if (gone.has(change.status) || change.submodule) continue;
      files.push(repo.authority === 'local' ? { path: await repo.confinedEntry(change.path) } : { file: this.remotePathRef(repo, change.path) });
    }
    await this.deps.editorPane.openInBackground(files);
  }

  // VS Code's git.closeAllUnmodifiedEditors: a clean text tab closes unless its file has a change in any open repository.
  async closeAllUnmodified(): Promise<void> {
    await this.deps.editorPane.closeUnmodified((location) => this.resourceOf(location)?.group !== undefined);
  }

  async openRepository(projectKey: string): Promise<ScmRunResult> {
    const project = this.deps.projects().find((candidate) => candidate.key === projectKey);
    if (!project) return { ok: false, reason: 'unknown' };
    // the folder picker browses this computer only
    this.refuseRemote(authorityKeyOfProject(projectKey));
    const folder = await this.deps.pickFolder(project.fsPath);
    if (folder === undefined) return CANCELLED;
    const t = this.deps.t;
    const outcome = await this.deps.service.openFolder(projectKey, folder);
    if (outcome === 'outside') void this.deps.notify.warn(t('Open Repository opens a repository inside the project folder only.'));
    else if (outcome === 'notRepository') void this.deps.notify.warn(t('There is no Git repository in that folder.'));
    return outcome === 'opened' || outcome === 'parent' || outcome === 'unsafe' ? OK : CANCELLED;
  }

  async reopenClosed(projectKey: string): Promise<ScmRunResult> {
    const closed = this.deps.service.view(projectKey)?.closedRoots ?? [];
    if (closed.length === 0) return OK;
    const root = await this.pick(this.deps.t('Pick a repository to reopen'), closed.map((entry) => ({ value: entry, item: { label: path.basename(entry), description: entry } })));
    if (root === undefined) return CANCELLED;
    await this.deps.service.reopen(projectKey, [root]);
    return OK;
  }

  async manageUnsafe(projectKey: string): Promise<ScmRunResult> {
    const unsafe = this.deps.service.view(projectKey)?.unsafe ?? [];
    if (unsafe.length === 0) return OK;
    const chosen = unsafe.length === 1
      ? unsafe[0]
      : await this.pick(this.deps.t('Pick a repository to mark as safe and open'), unsafe.map((root) => ({ value: root, item: { label: path.basename(root), description: root } })));
    if (chosen === undefined) return CANCELLED;
    return (await this.deps.service.trustUnsafe(projectKey, chosen)) ? OK : CANCELLED;
  }

  // VS Code's resolveChangeCommand: a diff of its left and right sides, or the one side when there is no left (added,
  // untracked, deleted); a conflicted file opens itself.
  async openChanges(repoId: string, relativePath: string, group: ChangeGroup): Promise<ScmRunResult> {
    const repo = this.repo(repoId);
    const change = repo.lastStatus?.groups[group].find((candidate) => candidate.path === relativePath);
    if (!change) return OK;
    const name = path.basename(change.path);
    if (group === 'merge') {
      await this.openRepoFile(repo, await repo.confinedEntry(change.path));
      return OK;
    }
    const title = (fileName: string): string => titleOf(change.status, fileName, this.deps.t);
    const confined = (): Promise<string> => repo.confinedEntry(change.path);
    switch (change.status) {
      case 'INDEX_MODIFIED':
      case 'INDEX_RENAMED':
      case 'TYPE_CHANGED': {
        const left = await this.gitSide(repo, 'HEAD', change.originalPath ?? change.path, name);
        if (group !== 'index') {
          await this.diff(repo, title, change.path, confined, left, 'file');
          return OK;
        }
        const right = await this.gitSide(repo, 'index', change.path, name);
        await this.diff(repo, title, change.path, () => entryOrLexical(repo, change.path), left, right, { path: change.path, group: 'index' });
        return OK;
      }
      case 'MODIFIED': {
        const left = await this.gitSide(repo, 'index', change.path, name);
        await this.diff(repo, title, change.path, confined, left, 'file', { path: change.path, group: 'workingTree' });
        return OK;
      }
      case 'INDEX_ADDED':
      case 'INDEX_COPIED':
        this.openSide(title(name), await this.gitSide(repo, 'index', change.path, name));
        return OK;
      case 'INDEX_DELETED':
      case 'DELETED':
        this.openSide(title(name), await this.gitSide(repo, 'HEAD', change.path, name));
        return OK;
      default:
        await this.openRepoFile(repo, await repo.confinedEntry(change.path));
        return OK;
    }
  }

  /**
   * Stage or Unstage Selected Ranges. The buffer is read before the first await, so it is the text the shell diffed: the shell
   * sends its pending editor:edit just before this request, and one renderer's messages arrive in order. A stage names the
   * file's document; an unstage may name a git side of the file's open diff tab instead, and then writes in the file's
   * document encoding when it is open, else in the index blob's own. A refusal is a notice.
   */
  async stageRanges(request: ScmStageRangesRequest | ScmUnstageRangesRequest): Promise<ScmRunResult> {
    const named = this.deps.documents.get(request.documentId);
    const buffer = named?.kind === 'text' ? named.text : undefined;
    const repo = this.repo(request.repoId);
    const isFile = named !== undefined && this.sameFile(repo, request.path)(named.location);
    const gitSide = request.op === 'unstageRanges' && this.deps.editorPane.scmDiffTabs().some((tab) => tab.repoId === request.repoId && tab.git.path === request.path && (tab.originalId === request.documentId || tab.modifiedId === request.documentId));
    if (!isFile && !gitSide) throw new Error('The document is not the file the request names');
    const document = isFile ? named : this.documentOf(repo, request.path);
    // an unstage applies HEAD's blob, the one its ranges were computed against, at the path core reads from its own status
    const side = request.op === 'stageRanges' ? { buffer: buffer! } : { headOid: request.headOid };
    const action: ScmRangeAction = request.op === 'stageRanges' ? 'stage' : 'unstage';
    if (!document) {
      const outcome = await this.deps.service.stageRanges(request.repoId, { path: request.path, ranges: request.ranges, indexOid: request.indexOid, ...side });
      return outcome.ok ? OK : this.refuseStage(action, outcome.reason);
    }
    const refusal: StageRefusal | 'readOnly' | undefined =
      document.kind !== 'text'
        ? document.kind === 'notDisplayed' && document.reason === 'tooLarge' ? 'tooLarge' : 'binary'
        : document.readOnlyReason === 'encoding' ? 'encoding' : document.readOnlyReason === 'tooLarge' ? 'tooLarge' : document.readOnlyReason !== undefined ? 'readOnly' : undefined;
    if (refusal !== undefined || document.kind !== 'text') return this.refuseStage(action, refusal ?? 'binary');
    const outcome = await this.deps.service.stageRanges(request.repoId, {
      path: request.path,
      ranges: request.ranges,
      indexOid: request.indexOid,
      codec: codecOf(document),
      ...side,
    });
    return outcome.ok ? OK : this.refuseStage(action, outcome.reason);
  }

  private refuseStage(action: ScmRangeAction, reason: StageRefusal | 'readOnly'): ScmRunResult {
    const t = this.deps.t;
    const stale: Record<ScmRangeAction, { readonly changed: string; readonly outOfRange: string }> = {
      stage: {
        changed: t('The staged version of this file changed since the changes were shown, so nothing was staged. Try again.'),
        outOfRange: t('The file changed while the changes were staged, so nothing was staged. Try again.'),
      },
      unstage: {
        changed: t('The staged version of this file changed since the changes were shown, so nothing was unstaged. Try again.'),
        outOfRange: t('The file changed while the changes were unstaged, so nothing was unstaged. Try again.'),
      },
      revert: {
        changed: t('The file changed since the changes were shown, so nothing was reverted. Try again.'),
        outOfRange: t('The file changed while the changes were reverted, so nothing was reverted. Try again.'),
      },
    };
    const texts: Record<StageRefusal | 'readOnly', string> = {
      changed: stale[action].changed,
      conflicted: t('This file has merge conflicts. Resolve them before staging parts of it.'),
      declined: t('That folder belongs to a project you have not trusted, so source control runs no git there.'),
      symlink: t('Parts of a symbolic link cannot be staged.'),
      submodule: t('Parts of a submodule cannot be staged.'),
      lfs: t('This file is stored with Git LFS, so parts of it cannot be staged.'),
      binary: t('Parts of a binary file cannot be staged.'),
      tooLarge: t('This file is too large to stage parts of it.'),
      encoding: t('This file is not valid in its encoding, so parts of it cannot be staged.'),
      outOfRange: stale[action].outOfRange,
      readOnly: t('This file is read-only in the editor, so parts of it cannot be staged.'),
    };
    void this.deps.notify.warn(texts[reason]);
    return TOLD;
  }

  /** A Selected Ranges action the shell could not apply. */
  refuseRanges(action: ScmRangeAction, reason: ScmRangeRefusal): ScmRunResult {
    const t = this.deps.t;
    if (reason === 'noQuickDiff') {
      void this.deps.notify.warn(t('Source control cannot show this file\'s changes line by line, so the selected ranges were not applied.'));
      return TOLD;
    }
    if (reason !== 'noChanges') return this.refuseStage(action, reason);
    const texts: Record<ScmRangeAction, string> = {
      stage: t('The selection holds no unstaged changes, so nothing was staged.'),
      unstage: t('The selection holds no staged changes, so nothing was unstaged.'),
      revert: t('The selection holds no changes, so nothing was reverted.'),
    };
    void this.deps.notify.warn(texts[action]);
    return TOLD;
  }

  /**
   * Complete Merge: the Result document saved through its authority's workspace, then the file staged as resolved by its
   * repository, and its merge editor closed by the document; a remote Result is its host's project file (sameFile).
   */
  async completeMerge(repoId: string, relativePath: string, documentId: string): Promise<ScmRunResult> {
    const repo = this.repo(repoId);
    const document = this.deps.documents.get(documentId);
    if (document?.kind !== 'text' || !this.sameFile(repo, relativePath)(document.location)) throw new Error('The document is not the file the request names');
    if (!(await this.deps.editorPane.saveDocuments([documentId]))) {
      void this.deps.notify.warn(this.deps.t('The file could not be saved, so the merge was not completed.'));
      return TOLD;
    }
    await this.deps.service.completeMerge(repoId, relativePath);
    await this.deps.editorPane.closeMerge(documentId);
    return OK;
  }

  /** A conflicted file's merge editor when all three stages exist (UU, AA); any other merge row opens the file, as slice 10 does. */
  async openMergeEditor(repoId: string, relativePath: string): Promise<ScmRunResult> {
    const repo = this.repo(repoId);
    const change = repo.lastStatus?.groups.merge.find((candidate) => candidate.path === relativePath);
    if (!change) return OK;
    const absolute = await repo.confinedEntry(relativePath);
    if (change.status !== 'BOTH_MODIFIED' && change.status !== 'BOTH_ADDED') {
      await this.openRepoFile(repo, absolute);
      return OK;
    }
    // a remote Result is its host's project file, opened through that host's workspace
    const ref = repo.authority === 'local' ? this.fileRefOf(absolute) : this.remoteRef(repo, absolute);
    const document = ref ? await this.deps.documents.openProjectFile(ref.projectKey, ref.relativePath) : undefined;
    if (!document?.ok) throw this.notOpened(relativePath, document?.reason ?? 'outside');
    this.deps.editorPane.showMerge({ repoId, path: relativePath }, document.document, this.deps.t('Merging: {0}', path.basename(relativePath)), { focus: true });
    return OK;
  }

  /** B40's Compare with Workspace: the project folder's copy of a changed file of a chat worktree against the worktree's. */
  async compareWithWorkspace(repoId: string, relativePath: string): Promise<ScmRunResult> {
    const target = this.deps.service.repository(repoId);
    if (!target) return { ok: false, reason: 'unknown' };
    const notWorktree = (): ScmRunResult => {
      void this.deps.notify.info(this.deps.t('Compare with Workspace compares a file of a worktree chat with the project folder\'s copy.'));
      return TOLD;
    };
    const title = (fileName: string): string => this.deps.t('{0} (project folder) ↔ {0} (worktree)', fileName);
    if (target.repo.authority !== 'local') {
      // the file is a chat worktree's when its host's roots resolve it inside a worktree root, and its copy is the same path in that project
      const file = this.remotePathRef(target.repo, relativePath);
      const worktreeOf = parseRootKey(file.projectKey);
      if (worktreeOf?.worktreeId === undefined) return notWorktree();
      await this.deps.editorPane.showRemoteDiff(title, file, { file: { projectKey: worktreeOf.projectKey, relativePath: file.relativePath } }, { file }, { focus: true });
      return OK;
    }
    const absolute = await target.repo.confinedEntry(relativePath);
    const projectCopy = this.deps.worktrees.projectCopyOf(target.projectKey, absolute);
    if (projectCopy === undefined) return notWorktree();
    const name = path.basename(absolute);
    // a copy confinement refuses (a link out of the project folder) or one that is missing shows as an empty side
    const confined = await confineExisting(projectCopy.project, projectCopy.relativePath);
    const file = confined.ok && (await fs.promises.stat(confined.path)).isFile() ? confined.path : undefined;
    await this.deps.editorPane.showDiff(
      title,
      absolute,
      file !== undefined ? { path: file } : { name, content: '' },
      { path: absolute },
      { focus: true },
    );
    return OK;
  }

  async openTimeline(repoId: string, relativePath: string): Promise<ScmRunResult> {
    this.repo(repoId);
    this.deps.editorPane.showTimeline({ repoId, path: relativePath }, this.deps.t('Timeline: {0}', path.basename(relativePath)), { focus: true });
    return OK;
  }

  /**
   * Open Commit: with a path, that file at the commit against its first parent, the parent's side at the path it had there (a
   * rename in the commit names its source); without, every file the commit changed as one changes tab. A root commit is
   * compared with the empty tree.
   */
  async openCommit(repoId: string, commit: string, relativePath: string | undefined): Promise<ScmRunResult> {
    const repo = this.repo(repoId);
    const object = await repo.commitObject(commit);
    const parent = object.parents[0] ?? (await this.deps.service.emptyTree(repoId));
    const diff = await this.deps.service.diffRefs(repoId, parent, commit);
    if (relativePath === undefined) {
      const subject = object.message.split('\n', 1)[0]!.trim();
      if (diff.entries.length === 0) {
        void this.deps.notify.info(this.deps.t('Commit {0} changed no files.', shortHash(commit)));
        return OK;
      }
      const source: ScmDiffSource = { kind: 'refs', left: parent, right: commit };
      this.keepPair(pairKey(repoId, source), diff);
      this.deps.editorPane.showChanges({ title: `${shortHash(commit)} - ${subject}`, changes: { repoId, source, entries: diff.entries.map((entry) => toScmChange(entry.change)) } }, { focus: true });
      return OK;
    }
    const before = diff.entries.find((entry) => entry.change.path === relativePath)?.change.originalPath ?? relativePath;
    return this.compareCommits(repoId, { commit: parent, path: before }, { commit, path: relativePath });
  }

  /** One diff tab of two versions of a file, each at its own path; titled as VS Code's timeline titles a diff. */
  async compareCommits(repoId: string, left: ScmCommitFile, right: ScmCommitFile): Promise<ScmRunResult> {
    const repo = this.repo(repoId);
    const [leftSide, rightSide] = await Promise.all([this.commitSide(repoId, left), this.commitSide(repoId, right)]);
    const t = this.deps.t;
    const leftName = path.posix.basename(left.path);
    // each side by its own name across a rename (VS Code's scmHistoryViewPane); fileName is the right side's, following its tab
    const title = (fileName: string): string => (leftName === path.posix.basename(right.path)
      ? t('{0} ({1}) ↔ {0} ({2})', fileName, shortHash(left.commit), shortHash(right.commit))
      : t('{0} ({1}) ↔ {2} ({3})', leftName, shortHash(left.commit), fileName, shortHash(right.commit)));
    await this.diff(repo, title, right.path, async () => path.join(repo.root, ...right.path.split('/')), leftSide, rightSide);
    return OK;
  }

  // A file at a commit as a diff side: its text, or the placeholder of one absent there, too large or binary.
  private async commitSide(repoId: string, file: ScmCommitFile): Promise<GitSide> {
    const name = path.posix.basename(file.path);
    const bytes = await this.deps.service.commitBlob(repoId, file.commit, file.path);
    if (bytes === undefined) return { name, notDisplayed: 'missing' };
    if (bytes === 'tooLarge') return { name, notDisplayed: 'tooLarge' };
    const decoded = decodeDocument(bytes);
    return decoded ? { name, content: decoded.text } : { name, notDisplayed: 'binary', bytes: bytes.length };
  }

  // The open document of a repository's file on disk (never an untitled, settings or Search Editor document).
  private documentOf(repo: ScmRepository, relativePath: string): Document | undefined {
    const isFile = this.sameFile(repo, relativePath);
    return this.deps.documents.all().find((document) => {
      if (document.kind === 'text' && (document.untitled || document.settingsScope !== undefined || document.searchEditor)) return false;
      return isFile(document.location);
    });
  }

  // Whether a location is a repository's file: a local file by its native path, a remote one only as the project file its
  // host's roots resolve the path to (remoteRef), so no document of another authority ever matches.
  private sameFile(repo: ScmRepository, relativePath: string): (location: Location | undefined) => boolean {
    if (repo.authority === 'local') {
      const key = folderKey(path.join(repo.root, ...relativePath.split('/')));
      return (location) => location !== undefined && location.host === undefined && (location.projectKey === undefined || authorityKeyOfProject(location.projectKey) === 'local') && folderKey(location.path) === key;
    }
    const ref = this.remotePathRef(repo, relativePath);
    return (location) => location !== undefined && location.host === undefined && location.projectKey === ref.projectKey && location.relativePath === ref.relativePath;
  }

  async openFileHead(repoId: string, relativePath: string): Promise<ScmRunResult> {
    const repo = this.repo(repoId);
    const change = [...(repo.lastStatus?.groups.index ?? []), ...(repo.lastStatus?.groups.workingTree ?? [])].find((candidate) => candidate.path === relativePath);
    const name = path.basename(relativePath);
    this.openSide(this.deps.t('{0} (HEAD)', name), await this.gitSide(repo, 'HEAD', change?.originalPath ?? relativePath, name));
    return OK;
  }

  // VS Code's git.viewChanges family: one multi-file diff tab per repository and group, titled "<repository>: <group>".
  async openGroupChanges(repoId: string, group: ChangeGroup): Promise<ScmRunResult> {
    const target = this.deps.service.repository(repoId);
    if (!target) return { ok: false, reason: 'unknown' };
    const entries = target.repo.lastStatus?.groups[group] ?? [];
    const t = this.deps.t;
    if (entries.length === 0) {
      const empty = group === 'index' ? t('The repository does not have any staged changes.') : group === 'untracked' ? t('The repository does not have any untracked changes.') : t('The repository does not have any changes.');
      void this.deps.notify.info(empty);
      return OK;
    }
    this.deps.editorPane.showChanges({ title: this.changesTitle(target.repo, group), changes: { repoId, source: { kind: group }, entries: entries.map(toScmChange) } }, { focus: true });
    return OK;
  }

  /**
   * A flow on a commit the renderer named: it runs only when the hash is a commit of the repository (cat-file -t); any other
   * object, or one the repository lacks, is told and runs nothing.
   */
  async withCommit(repoId: string, commit: string, flow: () => Promise<ScmRunResult>): Promise<ScmRunResult> {
    if (await this.deps.service.isCommit(repoId, commit)) return flow();
    void this.deps.notify.warn(this.deps.t('The commit {0} is not in this repository.', shortHash(commit)));
    return TOLD;
  }

  /**
   * VS Code's Add to Chat and Explain Changes on a commit main checked: core reads it, bounded, into a pending attachment of
   * the selected chat; Explain also puts its prompt in the composer. Nothing is sent: the user sends.
   */
  async commitToChat(repoId: string, commit: string, explain: boolean): Promise<ScmRunResult> {
    const projectKey = this.ownProjectKey(repoId);
    if (projectKey === undefined) return { ok: false, reason: 'unknown' };
    const attachment = await this.deps.service.commitAttachment(repoId, commit);
    await this.deps.addToChat(projectKey, attachment, explain ? this.deps.t('Explain the changes in this commit.') : undefined);
    return OK;
  }

  // VS Code's git.graph.compareWithRemote and compareWithMergeBase: the upstream's or the base ref's tip on the left, the
  // commit on the right; refused without one.
  async compareWithHeadRef(repoId: string, commit: string, which: 'upstream' | 'base'): Promise<ScmRunResult> {
    const ref = (await this.deps.service.headRefs(repoId))?.[which];
    if (!ref) {
      const t = this.deps.t;
      void this.deps.notify.info(which === 'upstream' ? t('The current branch has no upstream to compare with.') : t('The current branch has no base to compare with.'));
      return TOLD;
    }
    return this.openRefsChanges(repoId, { hash: ref.revision, label: ref.name }, { hash: commit, label: shortHash(commit) });
  }

  // The Graph's Incoming and Outgoing Changes: the merge base of HEAD and its upstream against the upstream or HEAD, all read now.
  async openGraphChanges(repoId: string, direction: 'incoming' | 'outgoing'): Promise<ScmRunResult> {
    const t = this.deps.t;
    const refs = await this.deps.service.headRefs(repoId);
    const base = refs?.upstream ? await this.deps.service.mergeBase(repoId, refs.head.revision, refs.upstream.revision) : undefined;
    if (!refs?.upstream || base === undefined) {
      void this.deps.notify.info(t('The current branch has no upstream to compare with.'));
      return TOLD;
    }
    const target = direction === 'incoming' ? refs.upstream : refs.head;
    return this.openRefsChanges(repoId, { hash: base, label: shortHash(base) }, { hash: target.revision, label: target.name });
  }

  /**
   * VS Code's cherryPick: a commit the Graph names (checked to be one of the repository), or from the palette one the user
   * types, verified with rev-parse. A conflict warns with Show Changes, which opens the first conflicted file in the merge
   * editor; changes already present abort the cherry-pick and say so; a refusal (a merge commit, local changes in the way) is
   * runRequest's error notice with Show Git Output.
   */
  async cherryPick(repoId: string, commit: string | undefined): Promise<ScmRunResult> {
    const t = this.deps.t;
    let hash = commit;
    if (hash === undefined) {
      const typed = (await this.deps.askInput({ prompt: t('Please provide the commit hash'), placeholder: t('Commit Hash') }))?.trim();
      if (!typed) return CANCELLED;
      hash = await this.deps.service.resolveTypedCommit(repoId, typed);
      if (hash === undefined) {
        void this.deps.notify.warn(t('"{0}" is not a commit of this repository.', visibleText(typed)));
        return TOLD;
      }
    } else if (!(await this.deps.service.isCommit(repoId, hash))) {
      void this.deps.notify.warn(t('The commit {0} is not in this repository.', shortHash(hash)));
      return TOLD;
    }
    const outcome = await this.deps.service.cherryPick(repoId, hash);
    if (outcome === 'empty') void this.deps.notify.info(t('The changes are already present in the current branch.'));
    if (outcome === 'conflict') {
      const show = t('Show Changes');
      void this.deps.notify.warn(t('There were merge conflicts while cherry picking the changes. Resolve the conflicts before committing them.'), show).then((choice) => {
        const conflicted = this.deps.service.repository(repoId)?.repo.lastStatus?.groups.merge[0];
        if (choice === show && conflicted) void this.runRequest({ op: 'openMergeEditor', repoId, path: conflicted.path });
      });
    }
    return OK;
  }

  /**
   * Compare with...'s tab: the files that differ between two commits, as one multi-file diff tab titled
   * "left ↔ right" (VS Code's _openChangesBetweenRefs); the labels name the refs the user picked.
   */
  async openRefsChanges(repoId: string, left: { readonly hash: string; readonly label: string }, right: { readonly hash: string; readonly label: string }): Promise<ScmRunResult> {
    const diff = await this.deps.service.diffRefs(repoId, left.hash, right.hash);
    if (diff.entries.length === 0) {
      void this.deps.notify.info(this.deps.t('There are no changes between "{0}" and "{1}".', visibleText(left.label), visibleText(right.label)));
      return OK;
    }
    const source: ScmDiffSource = { kind: 'refs', left: left.hash, right: right.hash };
    this.keepPair(pairKey(repoId, source), diff);
    this.deps.editorPane.showChanges({ title: `${left.label} \u2194 ${right.label}`, changes: { repoId, source, entries: diff.entries.map((entry) => toScmChange(entry.change)) } }, { focus: true });
    return OK;
  }

  /**
   * A worktree row's Open (D58, in place of VS Code's Open Worktree): the project whose folder the worktree holds is selected;
   * any other worktree is added as a project, which asks for trust as any added project does.
   */
  async openWorktree(repoId: string, worktreePath: string): Promise<ScmRunResult> {
    const { authority } = this.repo(repoId);
    const paths = this.pathsOf(authority);
    const listed = await this.deps.service.artifacts(repoId, 'worktrees');
    const worktree = listed.group === 'worktrees' ? listed.rows.find((row) => paths.same(row.path, worktreePath)) : undefined;
    if (!worktree) {
      void this.deps.notify.warn(this.deps.t('"{0}" is no longer in this repository.', visibleText(worktreePath)));
      return TOLD;
    }
    const chat = this.deps.worktrees.chatOf(authority, worktree.path);
    if (chat) {
      await this.deps.worktrees.selectChat(chat.chatId);
      return OK;
    }
    const project = this.worktreeProject(repoId, worktree.path);
    if (project === undefined) {
      await this.deps.addProject(authority, worktree.path);
      return OK;
    }
    await this.deps.selectProject(project.key);
    if (project.key === this.ownProjectKey(repoId)) this.deps.worktrees.showProjectFolder(project.key);
    return OK;
  }

  // The project a worktree's Open selects: the repository's own project when the worktree holds its folder, else a project of
  // the repository's authority whose folder lies in the worktree, so Open never adds a folder the list already has. Chat
  // worktree roots are no projects.
  private worktreeProject(repoId: string, worktreePath: string): Project | undefined {
    const own = this.ownProjectKey(repoId);
    const { authority } = this.repo(repoId);
    const paths = this.pathsOf(authority);
    const holds = (project: Project): boolean => this.projectFolders(project).some((folder) => paths.inside(worktreePath, folder));
    const projects = this.deps.projects().filter((project) => parseRootKey(project.key)?.worktreeId === undefined && authorityKeyOfProject(project.key) === authority);
    return projects.find((project) => project.key === own && holds(project)) ?? projects.find(holds);
  }

  // The project a repository belongs to; a chat worktree's repository belongs to the worktree's project.
  private ownProjectKey(repoId: string): string | undefined {
    const key = this.deps.service.repository(repoId)?.projectKey;
    return key === undefined ? undefined : parseRootKey(key)?.projectKey;
  }

  // VS Code's _viewStash: the stash's files against its base, titled as VS Code titles it.
  private async openStash(repoId: string, stash: StashArtifact): Promise<ScmRunResult> {
    const diff = await this.deps.service.diffStash(repoId, stash.hash);
    if (diff.entries.length === 0) return OK;
    const source: ScmDiffSource = { kind: 'stash', index: stash.index, hash: stash.hash };
    this.keepPair(pairKey(repoId, source), diff);
    this.deps.editorPane.showChanges({ title: this.deps.t('Git Stash #{0}: {1}', stash.index, stash.description), changes: { repoId, source, entries: diff.entries.map((entry) => toScmChange(entry.change)) } }, { focus: true });
    return OK;
  }

  // One file of an open View Stash or Compare tab: only a tab main opened names the pair, and only a file it lists.
  private async pairPatch(repoId: string, source: Extract<ScmDiffSource, { kind: 'stash' | 'refs' }>, relativePath: string): Promise<ScmFileDiffResult> {
    const key = pairKey(repoId, source);
    const open = this.deps.editorPane.changesTabs().some(({ state }) => state.changes.repoId === repoId && pairKey(repoId, state.changes.source) === key);
    if (!open) return { kind: 'missing' };
    let diff = this.pairs.get(key);
    if (!diff) {
      diff = source.kind === 'stash' ? await this.deps.service.diffStash(repoId, source.hash) : await this.deps.service.diffRefs(repoId, source.left, source.right);
      this.keepPair(key, diff);
    }
    const entry = diff.entries.find((candidate) => candidate.change.path === relativePath);
    return entry ? this.deps.service.entryPatch(repoId, diff.left, entry) : { kind: 'missing' };
  }

  // A pair's diff, cached for its tab's files; pairs no open tab holds any longer are dropped first.
  private keepPair(key: string, diff: CommitPairDiff): void {
    const open = new Set(this.deps.editorPane.changesTabs().map(({ state }) => pairKey(state.changes.repoId, state.changes.source)));
    for (const held of this.pairs.keys()) if (!open.has(held)) this.pairs.delete(held);
    this.pairs.set(key, diff);
  }

  // A picker over values main holds, answered by index.
  private async pick<T>(placeholder: string, entries: ReadonlyArray<PickEntry<T>>): Promise<T | undefined> {
    return (await pickEntry(this.deps.quickPick, placeholder, entries))?.value;
  }

  // A stash that left the list (popped, dropped, cleared, or dropped in a terminal) closes its View Stash tabs.
  private async closeDroppedStashTabs(repoId: string): Promise<void> {
    const open = this.deps.editorPane.changesTabs().filter(({ state }) => state.changes.repoId === repoId && state.changes.source.kind === 'stash');
    if (open.length === 0 || !this.deps.service.repository(repoId)) return;
    const listed = await this.deps.service.artifacts(repoId, 'stashes');
    const kept = new Set(listed.group === 'stashes' ? listed.rows.map((row) => row.hash) : []);
    for (const { state } of open) {
      const source = state.changes.source;
      if (source.kind === 'stash' && !kept.has(source.hash)) await this.closeStashTabs(repoId, source.hash);
    }
  }

  private async closeStashTabs(repoId: string, hash: string): Promise<void> {
    this.pairs.delete(pairKey(repoId, { kind: 'stash', index: 0, hash }));
    await this.deps.editorPane.closeChangesTabs((changes) => changes.repoId === repoId && changes.source.kind === 'stash' && changes.source.hash === hash);
  }

  private capabilities(): ScmCapabilities {
    return { stashStaged: canStashStaged(this.deps.service.gitVersion()) };
  }

  repo(repoId: string): ScmRepository {
    const target = this.deps.service.repository(repoId);
    if (!target) throw new Error('Unknown repository');
    return target.repo;
  }

  private refuseRemote(authority: string): void {
    if (authority === 'local') return;
    throw new Error(this.deps.t('This source control action is not available on {0} yet.', this.deps.hostName(authority)));
  }

  /** An authority's path rules: this computer's for a local repository, its host's for a remote one. */
  pathsOf(authority: string): PathRules {
    if (authority === 'local') return { os: this.deps.platform, flavor: path, same: samePath, inside: isInside };
    const os = this.deps.authorityOs(authority);
    return { os, flavor: pathFor({ os }), same: (a, b) => folderKeyOn(os, a) === folderKeyOn(os, b), inside: (folder, target) => isInsideFolder({ os }, folder, target) };
  }

  // A path a remote repository's core answered, as the project file it is; anything else is refused.
  remoteRef(repo: ScmRepository, targetPath: string): FileRef {
    const ref = this.deps.remoteFileRef(repo.authority, targetPath);
    if (!ref) throw new Error(this.deps.t('{0} named a file outside its projects.', this.deps.hostName(repo.authority)));
    return ref;
  }

  // A remote repository's file by its repository path, joined in its host's path rules and resolved only by remoteRef.
  private remotePathRef(repo: ScmRepository, relativePath: string): FileRef {
    return this.remoteRef(repo, this.pathsOf(repo.authority).flavor.join(repo.root, ...relativePath.split('/')));
  }

  // A repository's file in the editor: a local one as openAbsolute opens it, a remote one only as a file of its projects,
  // which the editor reads through that authority's workspace.
  async openRepoFile(repo: ScmRepository, absolute: string): Promise<void> {
    if (repo.authority === 'local') {
      await this.openAbsolute(absolute);
      return;
    }
    const ref = this.remoteRef(repo, absolute);
    const opened = await this.deps.editorPane.openFromUser(ref.projectKey, ref.relativePath);
    if (!opened.ok) throw this.notOpened(ref.relativePath, opened.reason);
  }

  projectOfRepo(repoId: string): ScmView | undefined {
    const projectKey = this.deps.service.repository(repoId)?.projectKey;
    return projectKey === undefined ? undefined : this.view(projectKey);
  }

  fileRefOf(absolute: string): FileRef | undefined {
    for (const project of this.deps.projects()) {
      if (authorityKeyOfProject(project.key) !== 'local') continue;
      for (const folder of this.projectFolders(project)) {
        if (!isInside(folder, absolute)) continue;
        const relative = path.relative(folder, absolute).split(path.sep).join('/');
        if (relative !== '') return { projectKey: project.key, relativePath: relative };
      }
    }
    return undefined;
  }

  // A file inside a project opens editable through the document service; a parent repository's file outside every project
  // opens read-only as a core-originated document (AD5).
  async openAbsolute(absolute: string): Promise<void> {
    const ref = this.fileRefOf(absolute);
    if (ref) {
      const opened = await this.deps.editorPane.openFromUser(ref.projectKey, ref.relativePath);
      if (!opened.ok) throw this.notOpened(ref.relativePath, opened.reason);
      return;
    }
    await this.deps.editorPane.openPath(absolute, { focus: true });
  }

  // A diff of a repository's file. 'file' is the file on disk as the editable side: a local one at localPath, a remote one only as
  // the project file remotePathRef resolves, opened through its host's workspace. git: a working tree or index change, whose
  // index side refreshes after each status (refreshGitSides).
  private async diff(
    repo: ScmRepository,
    title: (fileName: string) => string,
    relativePath: string,
    localPath: () => Promise<string>,
    left: GitSide,
    right: GitSide | 'file',
    git?: { readonly path: string; readonly group: 'workingTree' | 'index' },
  ): Promise<void> {
    const opts = { focus: true, scm: { repoId: repo.repoId, ...(git ? { git } : {}) } };
    if (repo.authority !== 'local') {
      const file = this.remotePathRef(repo, relativePath);
      await this.deps.editorPane.showRemoteDiff(title, file, left, right === 'file' ? { file } : right, opts);
      return;
    }
    const absolute = await localPath();
    await this.deps.editorPane.showDiff(title, absolute, left, right === 'file' ? { path: absolute } : right, opts);
  }

  // The git sides of the open working tree and index diffs of these repositories, read again after a status: a stage, an
  // unstage or an outside index write shows in place. A side that is no longer text keeps its last text.
  private async refreshGitSides(repoIds: ReadonlySet<string>): Promise<void> {
    for (const tab of this.deps.editorPane.scmDiffTabs()) {
      const repo = repoIds.has(tab.repoId) ? this.deps.service.repository(tab.repoId)?.repo : undefined;
      if (!repo) continue;
      const name = path.posix.basename(tab.git.path);
      // A conflicted file has no stage 0: a working tree diff shows HEAD there, as VS Code's sanitizeRef reads HEAD for a file
      // outside the index group, and an index diff keeps its last index text.
      const conflicted = repo.lastStatus?.groups.merge.some((change) => change.path === tab.git.path) ?? false;
      const sides: Array<readonly [string, 'HEAD' | 'index', string]> =
        tab.git.group === 'workingTree'
          ? [[tab.originalId, conflicted ? 'HEAD' : 'index', tab.git.path]]
          : [
              [tab.originalId, 'HEAD', repo.lastStatus?.groups.index.find((change) => change.path === tab.git.path)?.originalPath ?? tab.git.path],
              ...(conflicted ? [] : [[tab.modifiedId, 'index', tab.git.path] as const]),
            ];
      for (const [documentId, where, file] of sides) {
        const side = await this.gitSide(repo, where, file, name);
        if ('content' in side) this.deps.editorPane.replaceGitSide(documentId, side.content);
      }
    }
  }

  // A git side as text, or the placeholder of one absent there, past MAX_SHOW_BYTES or binary, whose bytes stay in main.
  private async gitSide(repo: ScmRepository, where: 'HEAD' | 'index', file: string, name: string): Promise<GitSide> {
    const bytes = await repo.show(where, file);
    if (bytes === undefined) return { name, notDisplayed: 'missing' };
    if (bytes === 'tooLarge') return { name, notDisplayed: 'tooLarge' };
    const decoded = decodeDocument(bytes);
    return decoded ? { name, content: decoded.text } : { name, notDisplayed: 'binary', bytes: bytes.length };
  }

  private openSide(title: string, side: GitSide): void {
    if ('notDisplayed' in side) this.deps.editorPane.openPlaceholder(title, side);
    else this.deps.editorPane.openReadOnly(title, side.content, side.name, true);
  }

  private setAmending(repoId: string | undefined): void {
    if (this.amendingRepoId === repoId) return;
    this.amendingRepoId = repoId;
    this.deps.menuChanged();
  }

  // The shell's setInput after a commit or an undo ends its amend mode too.
  private leaveAmend(repoId: string): void {
    if (this.amendingRepoId === repoId) this.setAmending(undefined);
  }

  // The project folder's realpath, which repository roots are given in, then the folder as registered.
  private projectFolders(project: Project): string[] {
    const real = this.deps.service.projectRealPath(project.key);
    return real === undefined || samePath(real, project.fsPath) ? [project.fsPath] : [real, project.fsPath];
  }

  // VS Code's save prompt in smartCommit: unsaved files under the root, only the staged ones at 'staged' or when something is
  // staged. Resolves the saved paths, or undefined for Cancel.
  private async saveBeforeCommit(repoId: string, root: string): Promise<string[] | undefined> {
    const mode = this.read<PromptToSaveFilesBeforeCommit>(SCM_SETTING_KEYS.promptToSaveFilesBeforeCommit, 'always');
    if (mode === 'never') return [];
    const status = await this.deps.service.currentStatus(repoId);
    let documents = (await this.deps.editorPane.dirtyFiles()).filter((document) => isInside(root, document.path));
    if (mode === 'staged' || status.groups.index.length > 0) {
      const staged = new Set(status.groups.index.map((change) => folderKey(path.join(root, ...change.path.split('/')))));
      documents = documents.filter((document) => staged.has(folderKey(document.path)));
    }
    if (documents.length === 0) return [];
    const t = this.deps.t;
    const one = documents.length === 1;
    const choice = await this.deps.ask({
      severity: 'warning',
      message: one
        ? t('The following file has unsaved changes which won\'t be included in the commit if you proceed: {0}.', path.basename(documents[0]!.path))
        : t('There are {0} unsaved files.', documents.length),
      detail: one ? t('Would you like to save it before committing?') : t('Would you like to save them before committing?'),
      actions: [t('Save All & Commit Changes'), t('Commit Changes')],
      cancelLabel: t('Cancel'),
      defaultAction: 0,
    });
    if (choice === undefined) return undefined;
    if (choice === 1) return [];
    if (!(await this.deps.editorPane.saveDocuments(documents.map((document) => document.documentId)))) throw new Error(t('The unsaved files could not be saved, so nothing was committed.'));
    return documents.map((document) => document.path);
  }

  // VS Code's promptForBranchName: the box starts with branchPrefix and the caret after it.
  private askBranchName(): Promise<string | undefined> {
    const t = this.deps.t;
    const prefix = this.read(SCM_SETTING_KEYS.branchPrefix, '');
    return this.deps.askInput({
      title: t('Commit to a New Branch'),
      prompt: t('Please provide a new branch name'),
      placeholder: t('Branch name'),
      value: prefix,
      valueSelection: [prefix.length, prefix.length],
      validation: 'branchName',
    });
  }

  // The post-commit command's one place: Commit & Push and Commit & Sync name theirs, otherwise postCommitCommand decides. It
  // runs after the commit's reply, as its own flow with its own questions and notices.
  private runPostCommitCommand(repoId: string, override: ScmPostCommit | undefined): void {
    const command = override ?? this.read<PostCommitCommand>(SCM_SETTING_KEYS.postCommitCommand, 'none');
    if (command === 'push') void this.runRequest({ op: 'push', repoId, to: false, force: false, followTags: false });
    else if (command === 'sync') void this.runRequest({ op: 'sync', repoId, rebase: false });
  }

  // A flow main starts itself (a palette command): a failure gets the notice runRequest gives.
  private async guarded(op: string, flow: () => Promise<void>): Promise<void> {
    try {
      await flow();
    } catch (err) {
      this.deps.log(`[scm] ${op} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.failed(gitErrorText(err));
    }
  }

  private read<T>(key: string, fallback: T): T {
    const value = this.deps.settings.get<unknown>(key);
    return isDesktopSettingValue(key, value) ? (value as T) : fallback;
  }

  private changesTitle(repo: ScmRepository, group: ChangeGroup): string {
    const t = this.deps.t;
    const label = group === 'index' ? t('Staged Changes') : group === 'merge' ? t('Merge Changes') : group === 'untracked' ? t('Untracked Changes') : t('Changes');
    return `${path.basename(repo.root)}: ${label}`;
  }

  // relativePath uses / separators
  private notOpened(relativePath: string, reason: string): Error {
    this.deps.log(`[scm] ${relativePath} could not be opened (${reason})`);
    return new Error(this.deps.t('{0} could not be opened.', path.posix.basename(relativePath)));
  }

  // forward: a remote operation of a host with agent forwarding off failed with Permission denied (publickey)
  private failed(message: string, forward?: AgentForwardingOffer): void {
    const t = this.deps.t;
    const show = t('Show Git Output');
    const enable = forward && t('Forward your SSH agent to {0}', forward.hostName);
    void this.deps.notify.error(message, ...(enable !== undefined ? [enable] : []), show).then((choice) => {
      if (choice === show) this.deps.showGitLog();
      else if (choice !== undefined && choice === enable) forward!.enable().catch((err: unknown) => this.deps.log(`[scm] turning on agent forwarding failed: ${err instanceof Error ? err.message : String(err)}`));
    });
  }

  private forwardingOffer(request: ScmRunRequest, err: unknown): AgentForwardingOffer | undefined {
    if (!REMOTE_OPS.has(request.op) || !('repoId' in request) || gitFailureCode(err) !== 'publickeyDenied') return undefined;
    const authority = this.deps.service.repository(request.repoId)?.repo.authority;
    return authority === undefined || authority === 'local' ? undefined : this.deps.agentForwarding(authority);
  }

  private settings(): ScmSettings {
    return {
      untrackedChanges: this.read(SCM_SETTING_KEYS.untrackedChanges, 'mixed'),
      inputValidation: this.read(SCM_SETTING_KEYS.inputValidation, false),
      inputValidationSubjectLength: this.read(SCM_SETTING_KEYS.inputValidationSubjectLength, 50),
      inputValidationLength: this.read(SCM_SETTING_KEYS.inputValidationLength, 72),
      allowNoVerifyCommit: this.read(SCM_SETTING_KEYS.allowNoVerifyCommit, false),
      allowForcePush: this.read(SCM_SETTING_KEYS.allowForcePush, false),
      blameEditorDecoration: this.read(SCM_SETTING_KEYS.blameEditorDecoration, true),
    };
  }

  private selectedView(): ScmView | undefined {
    const key = this.deps.selectedProjectKey();
    return key === undefined ? undefined : this.view(key);
  }

  private view(projectKey: string): ScmView | undefined {
    const view = this.deps.service.view(projectKey);
    const project = this.deps.projects().find((candidate) => candidate.key === projectKey);
    if (!view || !project) return undefined;
    const folders = this.projectFolders(project);
    return {
      projectKey,
      state: view.state,
      repos: view.repos.map((repo) => ({
        repoId: repo.repoId,
        label: path.basename(repo.root),
        displayPath: repo.kind === 'parent' ? repo.root : path.relative(folders[0]!, repo.root).split(path.sep).join('/'),
        kind: repo.kind,
        root: repo.root,
      })),
      selectedRepoId: this.selectedRepoId(projectKey, view, folders),
      closedCount: view.closedRoots.length,
      unsafePaths: view.unsafe.map((entry) => path.normalize(entry)),
      parentCount: view.parents.length,
    };
  }

  // The persisted root, else the repository holding the project folder, else the first.
  private selectedRepoId(projectKey: string, view: ProjectView, projectFolders: readonly string[]): string | null {
    const saved = this.deps.selection.get(projectKey);
    const sameRoot = (a: string, b: string): boolean => (this.deps.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    const chosen = (saved !== undefined ? view.repos.find((repo) => sameRoot(repo.root, saved)) : undefined)
      ?? view.repos.find((repo) => projectFolders.some((folder) => isInside(repo.root, folder)))
      ?? view.repos[0];
    return chosen?.repoId ?? null;
  }

  private snapshot(repoId: string): ScmRepoSnapshot | undefined {
    const snapshot = this.deps.service.snapshot(repoId);
    if (!snapshot) return undefined;
    const status = snapshot.status;
    const groups = status?.groups;
    return {
      repoId,
      projectKey: snapshot.projectKey,
      head: status?.head ?? null,
      commit: status?.commit ?? null,
      operation: status?.operation ?? null,
      ...(status?.mergeMessage !== undefined ? { mergeMessage: status.mergeMessage } : {}),
      groups: {
        merge: (groups?.merge ?? []).map(toScmChange),
        index: (groups?.index ?? []).map(toScmChange),
        workingTree: (groups?.workingTree ?? []).map(toScmChange),
        untracked: (groups?.untracked ?? []).map(toScmChange),
      },
      tooManyChanges: status?.tooManyChanges ?? false,
      busy: snapshot.busy,
      upstream: status?.upstream ?? null,
      remotes: status?.remotes ?? [],
      running: snapshot.running,
      lastRemote: snapshot.lastRemote,
      revision: snapshot.revision,
    };
  }

  private decorations(projectKey: string): ScmDecorations {
    return { projectKey, files: this.deps.service.decorations(projectKey) };
  }

  // The active editor's file in an open repository, with the group its change sits in (unstaged first, as VS Code's
  // getSCMResource picks the working tree resource).
  private activeResource(): Resource | undefined {
    const location = this.deps.editorPane.activeLocation();
    return location === undefined ? undefined : this.resourceOf(location);
  }

  // A file's place in an open repository of its own authority: a local file by its native path, a remote one only when its path
  // resolves through remoteFileRef to the project file the location names.
  private resourceOf(location: Location): Resource | undefined {
    if (location.host !== undefined) return undefined;
    const authority = location.projectKey === undefined ? 'local' : authorityKeyOfProject(location.projectKey);
    if (authority === 'local') return this.resourceAt(location.path);
    const ref = this.deps.remoteFileRef(authority, location.path);
    if (!ref || ref.projectKey !== location.projectKey || ref.relativePath !== location.relativePath) return undefined;
    // repository roots are the project's realpath on the target, which the registered folder may reach through a link
    const real = this.deps.service.projectRealPath(ref.projectKey);
    return this.resourceIn(authority, real === undefined ? location.path : this.pathsOf(authority).flavor.join(real, ...ref.relativePath.split('/')));
  }

  private resourceAt(absolute: string): Resource | undefined {
    return this.resourceIn('local', absolute);
  }

  // The deepest open repository of the authority holding absolute, a path in that authority's own rules.
  private resourceIn(authority: string, absolute: string): Resource | undefined {
    const paths = this.pathsOf(authority);
    let best: { repoId: string; root: string } | undefined;
    for (const key of this.deps.service.projectKeys()) {
      if (authorityKeyOfProject(key) !== authority) continue;
      for (const repo of this.deps.service.view(key)?.repos ?? []) {
        if (paths.inside(repo.root, absolute) && (!best || repo.root.length > best.root.length)) best = { repoId: repo.repoId, root: repo.root };
      }
    }
    if (!best) return undefined;
    const relativePath = paths.flavor.relative(best.root, absolute).split(paths.flavor.sep).join('/');
    const groups = this.deps.service.repository(best.repoId)?.repo.lastStatus?.groups;
    const group = (['workingTree', 'untracked', 'index', 'merge'] as const).find((candidate) => groups?.[candidate].some((change) => change.path === relativePath));
    return { repoId: best.repoId, relativePath, ...(group ? { group } : {}) };
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      // the editor pane and the shell this writes to are disposed first
      if (!this.disposed) this.flush();
    });
  }

  private flush(): void {
    const { views, repos, decorations, ignores } = this.pending;
    for (const projectKey of views) {
      const view = this.view(projectKey);
      if (view) this.deps.send.view(view);
    }
    for (const repoId of repos) {
      const snapshot = this.snapshot(repoId);
      if (snapshot) this.deps.send.state(snapshot);
    }
    for (const projectKey of decorations) this.deps.send.decorations(this.decorations(projectKey));
    for (const projectKey of ignores) this.deps.send.filesChanged(projectKey);
    if (this.pending.clone) this.deps.send.clone(this.deps.service.cloneState());
    for (const [repoId, groups] of this.pending.artifacts) {
      if (!this.deps.service.repository(repoId)) continue;
      const refs = this.pending.refs.get(repoId);
      const changed: ScmArtifactsChanged = { repoId, groups: [...groups], ...(refs !== undefined ? { refs } : {}) };
      this.deps.send.artifactsChanged(changed);
      if (groups.has('stashes')) void this.closeDroppedStashTabs(repoId).catch((err: unknown) => this.deps.log(`[scm] closing the tabs of dropped stashes failed: ${gitErrorText(err)}`));
    }
    this.pending.artifacts.clear();
    this.pending.refs.clear();
    this.pending.clone = false;
    if (repos.size > 0) {
      this.refreshChangesTabs(repos);
      void this.refreshGitSides(new Set(repos)).catch((err: unknown) => this.deps.log(`[scm] refreshing a diff's git side failed: ${gitErrorText(err)}`));
    }
    if (views.size > 0) this.deps.editorPane.gitChanged();
    if (views.size > 0 || repos.size > 0) this.deps.menuChanged();
    views.clear();
    repos.clear();
    decorations.clear();
    ignores.clear();
  }

  // A repository core no longer has closes its changes and diff tabs, as VS Code closes a closed repository's editors.
  private refreshChangesTabs(repoIds: ReadonlySet<string>): void {
    for (const repoId of repoIds) {
      if (this.deps.service.repository(repoId)) continue;
      if (this.amendingRepoId === repoId) this.amendingRepoId = undefined;
      void this.deps.editorPane.closeChanges(repoId).catch((err: unknown) => this.deps.log(`[scm] closing a closed repository's tabs failed: ${gitErrorText(err)}`));
    }
    for (const { tabId, state } of this.deps.editorPane.changesTabs()) {
      const repo = repoIds.has(state.changes.repoId) ? this.deps.service.repository(state.changes.repoId)?.repo : undefined;
      if (!repo) continue;
      const source = state.changes.source;
      if (source.kind === 'stash' || source.kind === 'refs') continue;
      const entries = (repo.lastStatus?.groups[source.kind] ?? []).map(toScmChange);
      const changes: ScmChangesTab = { repoId: state.changes.repoId, source, entries };
      this.deps.editorPane.updateChanges(tabId, { title: state.title, changes });
    }
  }
}

type GitSide = { readonly name: string; readonly content: string } | NotShownSide;

// A remote in a picker: its name, and its URL without userinfo, since a token can ride in it.
function remoteEntry(entry: Remote, url: 'fetch' | 'push'): PickEntry<Remote> {
  const shown = url === 'fetch' ? entry.fetchUrl : entry.pushUrl;
  return { value: entry, item: { label: entry.name, ...(shown !== undefined ? { description: redactUrls(shown) } : {}) } };
}

// A placeholder naming user data with its control and bidi characters as escapes, which the overlay bounds: the value keeps
// its tail behind '…', as a cut label does.
function placeholderNaming(t: ScmHostDeps['t'], template: string, value: string): string {
  const shown = visibleText(value);
  const whole = t(template, shown);
  const over = whole.length - MAX_OVERLAY_LABEL_LENGTH;
  return over <= 0 ? whole : t(template, `…${shown.slice(over + 1)}`);
}

function toScmChange(change: Change): ScmRepoSnapshot['groups']['merge'][number] {
  return {
    path: change.path,
    ...(change.originalPath !== undefined ? { originalPath: change.originalPath } : {}),
    status: change.status,
    letter: change.letter,
    tone: change.tone,
    strike: change.strike,
    ...(change.submodule ? { submodule: true as const } : {}),
  };
}

// A View Stash tab is its commit, whatever index it showed at; a Compare tab its two commits.
function pairKey(repoId: string, source: ScmDiffSource): string {
  return source.kind === 'stash' ? `${repoId}\0stash\0${source.hash}` : source.kind === 'refs' ? `${repoId}\0refs\0${source.left}\0${source.right}` : `${repoId}\0${source.kind}`;
}

// VS Code's Repository.getTitle, for the file's current name.
function titleOf(status: Change['status'], name: string, t: ScmHostDeps['t']): string {
  switch (status) {
    case 'INDEX_MODIFIED':
    case 'INDEX_RENAMED':
    case 'INDEX_ADDED':
      return t('{0} (Index)', name);
    case 'MODIFIED':
    case 'BOTH_ADDED':
    case 'BOTH_MODIFIED':
      return t('{0} (Working Tree)', name);
    case 'INDEX_DELETED':
    case 'DELETED':
      return t('{0} (Deleted)', name);
    case 'DELETED_BY_US':
      return t('{0} (Theirs)', name);
    case 'DELETED_BY_THEM':
      return t('{0} (Ours)', name);
    case 'UNTRACKED':
      return t('{0} (Untracked)', name);
    case 'INTENT_TO_ADD':
    case 'INTENT_TO_RENAME':
      return t('{0} (Intent to add)', name);
    case 'TYPE_CHANGED':
      return t('{0} (Type changed)', name);
    default:
      return name;
  }
}

