// A chat session's worktree facts (AD12 Sessions): where it works, whether it is read-only, its isolation (D62), its shell
// environment (D32) and its `worktreeState` (slice 12a rule 20), all derived from the session's latest worktree entry.
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { Disposable } from '../../platform/disposable';
import type { ChatPlace, ExtensionToWebviewMessage, WorktreeFinishAction, WorktreePhase, WorktreeStateData } from '../../shared/types/messages';
import { folderKey } from '../workspace-folders/folder-key';
import { log } from '../logger';
import { worktreeEnvironment } from '../worktrees/environment';
import { latestWorktreeEntry, worktreeEntryOf, type WorktreeEntryData } from '../worktrees/worktree-entry';
import type { SetupStep, WorktreeHostServices } from '../worktrees/host';
import { aheadBehind, isRewritten, settlePendingBase, targetBranch } from '../worktrees/integrate';
import type { ChatWorktreeRecord } from '../worktrees/registry';
import { piSessionDir } from './session-store/session-dir';
import { extractFirstUserMessage } from './session-store/metadata';
import type { HandOff } from './chat-changes';
import type { WorktreeIsolation } from './worktree-isolation';

/** The panel's part of the state: an opt-in not yet created, or creation and setup under way (rule 4). */
export interface PanelWorktreeView {
  readonly phase: Extract<WorktreePhase, 'pending' | 'creating' | 'settingUp' | 'setupFailed' | 'createFailed'>;
  readonly branch?: string;
  readonly uncommittedCount?: number;
  readonly exitCode?: number;
  readonly error?: string;
  readonly setupStep?: SetupStep;
  readonly heldPrompt?: { readonly text: string; readonly imageCount: number };
}

/** What the panel layer adds to a session's worktree state. */
export interface PanelWorktreeBinding {
  view(): PanelWorktreeView | undefined;
  /** Other chats of the project whose latest entry places them in worktree `worktreeId`, the session `sessionId` excluded. */
  sharedWith(worktreeId: string, projectPath: string, sessionId: string | undefined): Promise<number>;
  /** The finish action running on worktree `worktreeId`. */
  finishing(worktreeId: string): WorktreeFinishAction | undefined;
  /** A hand-off of the panel's chat is in flight. */
  moving(): boolean;
  projectName(projectPath: string): string | undefined;
}

const UNBOUND: PanelWorktreeBinding = {
  view: () => undefined,
  sharedWith: async () => 0,
  finishing: () => undefined,
  moving: () => false,
  projectName: () => undefined,
};

export interface WorktreeStateEvent {
  readonly state: WorktreeStateData;
  readonly projectPath: string;
  readonly worktreeId?: string;
  readonly workingFolder: string;
  readonly busy: boolean;
}

export interface SessionWorktreeDeps {
  readonly cwd: string;
  readonly host: () => WorktreeHostServices | undefined;
  readonly enabled: () => boolean;
  readonly isTrusted: (folder: string) => boolean;
  /** The live session's entries in file order; undefined before it starts. */
  readonly entries: () => readonly unknown[] | undefined;
  /** The live session's id; undefined before it starts. */
  readonly sessionId: () => string | undefined;
  readonly sessionFile: () => string | undefined;
  readonly append: (data: WorktreeEntryData) => void;
  readonly emit: (message: ExtensionToWebviewMessage) => void;
  /** Running, waiting on the user, or subagents or a team working (D33). */
  readonly busy: () => boolean;
  readonly hasConversation: () => boolean;
}

interface GitFacts {
  readonly baseBranch?: string;
  readonly behind?: number;
  readonly targetRewritten?: boolean;
}

// lastKey after the chat stopped having a state; a JSON event key never equals it.
const NO_STATE_KEY = 'none';
// lastKey once a panel binds: its webview may still show another session's state, so the first publish says what this one has.
const UNKNOWN_KEY = 'unknown';

/** Why a chat is history only (rules 17 and 18). */
export type ReadOnlyReason = 'deleted' | 'hostWithoutWorktrees';

export class SessionWorktree implements Disposable {
  private binding: PanelWorktreeBinding = UNBOUND;
  // A place recorded before the session started (a hand-off's resumed session); written first when it starts.
  private pendingPlace: WorktreeEntryData | undefined;
  private listener: ((event: WorktreeStateEvent) => void) | undefined;
  private lastKey: string | undefined;
  private git: GitFacts = {};
  private gitProject: string | undefined;
  private gitRun = 0;
  // gitKey() when the facts were last read.
  private lastGitKey: string | undefined;
  // compute awaits, so only the latest publish may emit; an older one resolving last would emit a stale state.
  private publishRun = 0;
  // The live chat record of this session's folder when it was made; isolation falls back to it once the record is gone.
  private readonly boundRecord: ChatWorktreeRecord | undefined;
  private readonly subscriptions: Disposable[] = [];
  private disposed = false;
  private readonly deps: SessionWorktreeDeps;

  constructor(deps: SessionWorktreeDeps) {
    this.deps = deps;
    const host = deps.host();
    this.boundRecord = host?.registry.liveChatRecordAt(deps.cwd);
    if (host) {
      this.subscriptions.push(host.registry.onDidChange(() => {
        // Most record writes (usedAt, lastAppliedTree) change none of the facts the chips read from git.
        const gitKey = this.gitKey();
        if (gitKey !== this.lastGitKey) this.refreshGit();
        this.publish();
      }));
      // D33: the behind and rewritten chips follow the project repository's refs (AD4's watcher in the host).
      this.subscriptions.push(host.onDidChangeRefs((projectPath) => {
        const record = this.record();
        if (record && record.deletedAt === undefined && folderKey(record.projectPath) === folderKey(projectPath)) this.refreshGit();
      }));
      // Whether the chat shows a state at all follows source control's repository for its project (D9).
      this.subscriptions.push(host.onDidChangeProjectRepository((projectPath) => {
        if (folderKey(this.projectPath()) !== folderKey(projectPath)) return;
        this.refreshGit();
        this.publish();
      }));
    }
  }

  /** The latest worktree entry, which decides where the chat works. */
  entry(): WorktreeEntryData | undefined {
    const entries = this.deps.entries();
    return entries ? latestWorktreeEntry(entries) : undefined;
  }

  /** The chat record of this chat's worktree, live or deleted; undefined for a chat that never had one or without a registry. */
  record(): ChatWorktreeRecord | undefined {
    const registry = this.deps.host()?.registry;
    if (!registry) return undefined;
    const id = this.entry()?.worktreeId;
    const byId = id !== undefined ? registry.get(id) : undefined;
    if (byId?.kind === 'chat') return byId;
    return registry.liveChatRecordAt(this.deps.cwd);
  }

  // The project the chat belongs to: its worktree's, its latest entry's, else its own folder.
  private projectPath(): string {
    return this.record()?.projectPath ?? this.entry()?.projectPath ?? this.deps.cwd;
  }

  /** The chat works in its live worktree, which is this session's folder. */
  inLiveWorktree(): ChatWorktreeRecord | undefined {
    const record = this.record();
    if (!record || record.deletedAt !== undefined || this.entry()?.place === 'project') return undefined;
    return folderKey(record.workingFolder) === folderKey(this.deps.cwd) ? record : undefined;
  }

  place(): ChatPlace {
    return this.entry()?.place ?? (this.inLiveWorktree() ? 'worktree' : 'project');
  }

  /**
   * Rules 17 and 18: a chat whose latest entry places it in a worktree this session is not bound to (a deleted worktree, or a
   * host without the registry), and a chat of a deleted adopted worktree, are history only.
   */
  readOnly(): boolean {
    return this.readOnlyReason() !== undefined;
  }

  /** Why the chat is read-only; undefined for a writable chat or one whose session has not started. */
  readOnlyReason(): ReadOnlyReason | undefined {
    const entry = this.entry();
    const registry = this.deps.host()?.registry;
    if (entry?.place === 'worktree') {
      if (this.inLiveWorktree() !== undefined) return undefined;
      return registry ? 'deleted' : 'hostWithoutWorktrees';
    }
    if (entry !== undefined) return undefined;
    const file = this.deps.sessionFile();
    if (!file || !registry) return undefined;
    const dir = folderKey(path.dirname(file));
    if (dir === folderKey(piSessionDir(this.deps.cwd))) return undefined;
    return registry.records().some((r) => r.kind === 'adopted' && r.deletedAt !== undefined && folderKey(piSessionDir(r.workingFolder)) === dir) ? 'deleted' : undefined;
  }

  /** Records that a session in a chat worktree works there: a new session, a `/clear` or a fork (AD12 Sessions). */
  ensureEntry(): void {
    const pending = this.pendingPlace;
    this.pendingPlace = undefined;
    if (pending) this.deps.append(pending);
    const registry = this.deps.host()?.registry;
    const record = registry?.liveChatRecordAt(this.deps.cwd);
    if (!record) return;
    const entry = this.entry();
    if (entry?.worktreeId === record.id && entry.place === 'worktree') return;
    this.deps.append({ worktreeId: record.id, projectPath: record.projectPath, place: 'worktree' });
  }

  /**
   * D61 back to the project folder: the chat keeps its worktree, and the next resume binds to the project. A session that has
   * not started yet writes it first thing when it starts, before it publishes.
   */
  appendPlace(place: ChatPlace, record: ChatWorktreeRecord): void {
    const data: WorktreeEntryData = { worktreeId: record.id, projectPath: record.projectPath, place };
    if (this.deps.entries() === undefined) this.pendingPlace = data;
    else this.deps.append(data);
  }

  /** Other chats of the project working in this chat's live worktree; 0 outside one. */
  async sharedWith(): Promise<number> {
    const live = this.inLiveWorktree();
    if (!live || this.entry()?.place === 'project') return 0;
    return this.binding.sharedWith(live.id, live.projectPath, this.deps.sessionId());
  }

  /** What the user typed as the first prompt, as the session list shows it, for a worktree a hand-off creates (its branch slug). */
  firstPromptText(): string {
    return extractFirstUserMessage((this.deps.entries() ?? []) as readonly SessionEntry[]);
  }

  /** Running, waiting on the user, or subagents or a team working (D33, D61). */
  busy(): boolean {
    return this.deps.busy();
  }

  /** The finish action holding this chat's live worktree (D33), during which core refuses the chat's sends. */
  finishing(): WorktreeFinishAction | undefined {
    const live = this.inLiveWorktree();
    return live ? this.binding.finishing(live.id) : undefined;
  }

  shellEnvironment(): Readonly<Record<string, string>> | undefined {
    const record = this.inLiveWorktree();
    return record ? worktreeEnvironment(record) : undefined;
  }

  /**
   * D62 for a chat working in its chat worktree. When the record is gone or deleted while the latest entry still places the
   * session in a worktree folder (a turn running as registry.json is removed), the chat stays isolated: from the record this
   * session was made with, else from the entry's project as both project folder and repository.
   */
  isolation(): Omit<WorktreeIsolation, 'environment' | 'commandPrefix' | 'shellPath'> | undefined {
    const registry = this.deps.host()?.registry;
    if (!registry) return undefined;
    const live = this.inLiveWorktree();
    const entry = this.entry();
    let place: Pick<ChatWorktreeRecord, 'id' | 'workingFolder' | 'projectPath' | 'repositoryRoot'>;
    if (live) {
      place = live;
    } else if (entry?.place === 'worktree' && folderKey(entry.projectPath) !== folderKey(this.deps.cwd)) {
      const bound = this.boundRecord;
      place = bound && bound.id === entry.worktreeId
        ? bound
        : { id: entry.worktreeId, workingFolder: this.deps.cwd, projectPath: entry.projectPath, repositoryRoot: entry.projectPath };
    } else {
      return undefined;
    }
    return {
      workingFolder: place.workingFolder,
      projectPath: place.projectPath,
      repositoryRoot: place.repositoryRoot,
      otherWorktrees: registry.liveChatRecords(place.projectPath).filter((r) => r.id !== place.id).map((r) => r.worktreeRoot),
      homeDir: os.homedir(),
    };
  }

  /** D60 across a hand-off: from each entry that changed the folder on, records belong to the folder it names. */
  handOffs(): { initialFolder: string; handOffs: HandOff[] } {
    const entries = this.deps.entries() ?? [];
    const registry = this.deps.host()?.registry;
    const folderOf = (data: WorktreeEntryData): string | undefined => {
      if (data.place === 'project') return data.projectPath;
      const record = registry?.get(data.worktreeId);
      return record?.workingFolder;
    };
    const handOffs: HandOff[] = [];
    let initialFolder: string | undefined;
    let current: string | undefined;
    let conversationSeen = false;
    for (const entry of entries) {
      if ((entry as { type?: string }).type === 'message') conversationSeen = true;
      const data = worktreeEntryOf(entry);
      if (!data) continue;
      const folder = folderOf(data);
      if (folder === undefined) continue;
      if (initialFolder === undefined) {
        // A chat that talked before its first entry began in its project folder, so that entry is a hand-off.
        initialFolder = conversationSeen ? data.projectPath : folder;
        current = initialFolder;
        if (!conversationSeen || folderKey(folder) === folderKey(current)) continue;
      }
      if (folderKey(folder) === folderKey(current!)) continue;
      current = folder;
      handOffs.push({ entryId: (entry as { id: string }).id, folder });
    }
    return { initialFolder: initialFolder ?? this.deps.cwd, handOffs };
  }

  bindPanel(binding: PanelWorktreeBinding): void {
    this.binding = binding;
  }

  setListener(listener: ((event: WorktreeStateEvent) => void) | undefined): void {
    this.listener = listener;
    this.lastKey = UNKNOWN_KEY;
  }

  // The record fields the git facts are read from.
  private gitKey(): string {
    const record = this.record();
    if (!record) return '';
    return JSON.stringify([record.id, record.deletedAt !== undefined, record.projectPath, record.repositoryRoot, record.workingFolder, record.branch, record.baseCommit, record.pendingBase ?? null]);
  }

  /** Re-reads the git facts the chips show (behind, rewritten, the project's branch), then publishes. */
  refreshGit(): void {
    const record = this.record();
    const host = this.deps.host();
    const runner = host?.git();
    const project = record?.projectPath ?? this.deps.cwd;
    this.lastGitKey = this.gitKey();
    // Bumped first, so a read still running when the facts stop applying never lands.
    const run = ++this.gitRun;
    if (!record || record.deletedAt !== undefined || !host || !runner || !this.deps.isTrusted(project)) {
      this.git = {};
      return;
    }
    void (async (): Promise<GitFacts> => {
      await settlePendingBase(record, runner, host.registry);
      const baseBranch = await targetBranch(record, runner);
      if (baseBranch === undefined) return {};
      const [{ behind }, targetRewritten] = await Promise.all([aheadBehind(record, runner, baseBranch), isRewritten(record, runner, baseBranch)]);
      return { baseBranch, behind, targetRewritten };
    })().then((facts) => {
      if (run !== this.gitRun || this.disposed) return;
      this.git = facts;
      this.gitProject = project;
      this.publish();
    }, (err: unknown) => log('[SessionWorktree] reading the worktree state of %s failed: %O', record.worktreeRoot, err));
  }

  /** Publishes again even when nothing changed, for a webview that (re)started with no state. */
  republish(): void {
    this.lastKey = undefined;
    this.publish();
  }

  /**
   * The place a stored session's file gives (`PanelWorktrees.resumeFolder`, `placeOf`), for a webview waiting to hear it
   * before the session starts. A session already running stored session `sessionId` (any, when none is named) sends its live
   * state instead, so the file's never replaces it; one running another conversation is about to switch, so the file's goes.
   */
  publishStored(state: WorktreeStateData | null, sessionId?: string): void {
    if (this.disposed || !this.deps.enabled()) return;
    if (this.deps.entries() !== undefined && (sessionId === undefined || this.deps.sessionId() === sessionId)) {
      this.republish();
      return;
    }
    // The start's publish sends the live state over this one, whatever it is.
    this.lastKey = UNKNOWN_KEY;
    this.deps.emit(state ? { type: 'worktreeState', ...state } : { type: 'noWorktreeState' });
  }

  /** With `publishStored`, the one publisher of `worktreeState` (rule 20): sent only with HostCapabilities.worktrees, deduplicated. */
  publish(): void {
    // Before the session starts its entries, and so its place, are unknown; the start publishes.
    if (this.disposed || !this.deps.enabled() || this.deps.entries() === undefined) return;
    const run = ++this.publishRun;
    void this.compute().then((event) => {
      if (this.disposed || run !== this.publishRun) return;
      if (!event) {
        // A chat with no state says so once where the webview may show one: it had one (trust revoked, its repository
        // closed), or the panel's previous session's.
        if (this.lastKey === undefined || this.lastKey === NO_STATE_KEY) return;
        this.lastKey = NO_STATE_KEY;
        this.deps.emit({ type: 'noWorktreeState' });
        return;
      }
      const key = JSON.stringify(event);
      if (key === this.lastKey) return;
      this.lastKey = key;
      this.deps.emit({ type: 'worktreeState', ...event.state });
      this.listener?.(event);
    }, (err: unknown) => log('[SessionWorktree] publishing the worktree state failed: %O', err));
  }

  private async compute(): Promise<WorktreeStateEvent | undefined> {
    const record = this.record();
    const view = this.binding.view();
    const readOnly = this.readOnly();
    const project = this.projectPath();
    // Only a chat of a trusted project with a repository source control has open (D9), or one that is history only, has a
    // worktree state to show.
    if (!readOnly && (!this.deps.isTrusted(project) || this.deps.host()?.projectRepository(project) === undefined)) return undefined;
    const live = this.inLiveWorktree();
    const phase: WorktreePhase = readOnly ? 'deleted' : view?.phase ?? (live ? 'ready' : 'none');
    const busy = this.deps.busy();
    const git = this.gitProject === project ? this.git : {};
    const branch = record?.branch ?? view?.branch;
    const projectName = record || view ? this.binding.projectName(project) : undefined;
    const sharedWith = readOnly ? 0 : await this.sharedWith();
    const finishing = this.finishing();
    const state: WorktreeStateData = {
      phase,
      place: this.place(),
      canHandOff: !busy && !readOnly && finishing === undefined && !this.binding.moving() && (phase === 'none' || phase === 'ready') && this.deps.hasConversation(),
      ...(branch !== undefined ? { branch } : {}),
      ...(git.baseBranch !== undefined ? { baseBranch: git.baseBranch } : {}),
      ...(view?.uncommittedCount !== undefined ? { uncommittedCount: view.uncommittedCount } : {}),
      ...(git.behind !== undefined && git.behind > 0 ? { behind: git.behind } : {}),
      ...(git.targetRewritten ? { targetRewritten: true } : {}),
      ...(view?.exitCode !== undefined ? { exitCode: view.exitCode } : {}),
      ...(view?.error !== undefined ? { error: view.error } : {}),
      ...(projectName !== undefined ? { projectName } : {}),
      ...(sharedWith > 0 ? { sharedWith } : {}),
      ...(view?.setupStep !== undefined ? { setupStep: { ...view.setupStep } } : {}),
      ...(view?.heldPrompt !== undefined ? { heldPrompt: { ...view.heldPrompt } } : {}),
      ...(finishing !== undefined ? { finishing } : {}),
    };
    return {
      state,
      projectPath: project,
      ...(record ? { worktreeId: record.id } : {}),
      workingFolder: this.deps.cwd,
      busy,
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.listener = undefined;
  }
}

