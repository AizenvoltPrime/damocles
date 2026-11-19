// The relocation journal's record and the protocol's views of it (docs/invariants.md "Project relocation"). Types only.

/** A coded reason; core never renders text, each host renders the code in its own language. */
export interface Coded {
  readonly code: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

export const RELOCATION_STEPS = ['checkpoints', 'sessions', 'worktrees', 'repair', 'memory', 'compass', 'hostState'] as const;
export type RelocationStepName = (typeof RELOCATION_STEPS)[number];

export type RelocationRequester = 'desktop' | 'vscode' | 'daemon';
export type RelocationMode = 'locate' | 'merge';
/** abandoned: a paused relocation the user stopped, finished as it stands; no step of it runs again. */
export type RelocationState = 'running' | 'paused' | 'coreDone' | 'abandoned';
/** A relocation's state as its view reports it: an abandoned relocation has no view. */
export type RelocationViewState = Exclude<RelocationState, 'abandoned'>;

/** project: the moved folder; worktree: a chat worktree of the project, by its working folder, which stays where it is. */
export interface RelocationFolder {
  readonly kind: 'project' | 'worktree';
  readonly from: string;
  readonly to: string;
  readonly worktreeId?: string;
  /** The folder checkpoint repo `to` writes new checkpoints to; absent: its own (`folderIdFor(to)`). */
  readonly checkpointRepo?: string;
}

/** A chat worktree whose git links the repair step could not re-link. */
export interface WorktreeRepairFailure {
  readonly worktreeId: string;
  readonly failure: Coded;
}

export interface RelocationStepState {
  readonly state: 'pending' | 'done' | 'waiting';
  readonly failure?: Coded;
}

export interface RelocationRecord {
  readonly id: string;
  readonly seq: number;
  readonly requestedBy: RelocationRequester;
  readonly mode: RelocationMode;
  readonly folders: readonly RelocationFolder[];
  readonly repository?: string;
  /** The project's chats preflight counted. */
  readonly chats: number;
  readonly state: RelocationState;
  /** The repair step's last run: the worktrees it left unlinked, which Retry and each start repair again. */
  readonly repairFailures?: readonly WorktreeRepairFailure[];
  readonly steps: Readonly<Record<RelocationStepName, RelocationStepState>>;
  readonly startedAt: number;
  readonly finishedAt?: number;
}

/** What preflight answers; refusal and notice codes are listed in docs/invariants.md "Project relocation". */
export type PreflightAnswer =
  | { readonly ok: true; readonly mode: RelocationMode; readonly chats: number; readonly worktrees: number; readonly notices: readonly Coded[] }
  | { readonly ok: false; readonly refusal: Coded };

export interface RelocationRequest {
  readonly from: string;
  readonly to: string;
  /** The host's listed project paths, for the mode and the insideProject notice. */
  readonly listed: readonly string[];
}

/** ignore: a chat a panel of this core holds does not refuse, since the host closes those chats before it relocates. */
export interface PreflightRequest extends RelocationRequest {
  readonly heldHere?: 'ignore';
  // skip: neither folder's repository identity is read, so the answer has no otherRepository notice (feature
  // projects.preflightSkipIdentity; an older core ignores it and reads them)
  readonly identity?: 'skip';
}

export interface RelocationView {
  readonly id: string;
  readonly seq: number;
  readonly requestedBy: RelocationRequester;
  readonly mode: RelocationMode;
  readonly from: string;
  readonly to: string;
  readonly state: RelocationViewState;
  /** The record's startedAt, on the relocating core's clock; absent from a core that predates it. */
  readonly startedAt?: number;
  /** The step running or waiting, or the last one once coreDone. */
  readonly step: RelocationStepName;
  /** Chats moved of those to move; read from this core's run, else from the step states. */
  readonly progress: { readonly done: number; readonly total: number };
  readonly failure?: Coded;
  /** Every waiting step's failure, in step order; absent when none waits, and from a core that predates it. */
  readonly waiting?: readonly Coded[];
  readonly chats: number;
  /** The project's chat worktrees: each one's working folder, from and to. */
  readonly worktrees?: readonly RelocatedWorktree[];
  readonly repairFailures?: readonly WorktreeRepairFailure[];
}

/** A missing project folder whose chats a newly opened folder of the same repository may take over (projects.movedFrom). */
export interface MovedFromCandidate {
  readonly from: string;
  /** The chats a relocation would move. */
  readonly chats: number;
}

export interface RelocatedWorktree {
  readonly worktreeId: string;
  readonly from: string;
  readonly to: string;
}

/** `memoryReadOnly`'s reason: memory is off, its store could not be opened, or the store is read only in this process. */
export const MEMORY_WAIT_REASONS = ['disabled', 'unavailable', 'readOnly'] as const;
export type MemoryWaitReason = (typeof MEMORY_WAIT_REASONS)[number];

/** What a waiting step waits on; earlierMove: a relocation before it that shares a folder path has not moved its memories yet. */
export type RelocationWait =
  | { readonly code: 'memoryReadOnly'; readonly params: { readonly reason: MemoryWaitReason } }
  | { readonly code: 'earlierMove'; readonly params: { readonly path: string } }
  | { readonly code: 'untrusted'; readonly params: { readonly count: number } }
  | { readonly code: 'repairFailed'; readonly params: { readonly count: number } }
  | { readonly code: 'repositoryLayout'; readonly params: { readonly path: string } };

/** Why preflight, `begin` or Stop moving refuses (docs/invariants.md "Project relocation"). */
export const RELOCATION_REFUSAL_CODES = [
  'otherAuthority', 'sameFolder', 'insideDamocles', 'chatWorktree', 'fromExists', 'toMissing', 'toNotDirectory', 'pendingRelocation',
  'chatHeld', 'registryUnreadable', 'worktreeFinishing', 'worktreeHandOff', 'repositoryLayout', 'noRepository', 'notPaused', 'relocationRunning',
  'agentRunHeld', 'checksBusy',
] as const;
export type RelocationRefusalCode = (typeof RELOCATION_REFUSAL_CODES)[number];

/** Why a step paused its relocation. */
export const RELOCATION_PAUSE_CODES = ['conflict', 'io', 'locked', 'stopped', 'registryUnreadable', 'agentRunning'] as const;
export type RelocationPauseCode = (typeof RELOCATION_PAUSE_CODES)[number];

export const RELOCATION_WAIT_CODES: ReadonlyArray<RelocationWait['code']> = ['memoryReadOnly', 'earlierMove', 'untrusted', 'repairFailed', 'repositoryLayout'];

/** What preflight notes about a relocation it allows. */
export const RELOCATION_NOTICE_CODES = ['unreachable', 'worktreesNotRelinkable', 'merge', 'insideProject', 'otherRepository'] as const;
export type RelocationNoticeCode = (typeof RELOCATION_NOTICE_CODES)[number];

/** Every code a relocation's refusal, pause, waiting step or notice carries; a newer core may send one this version lacks. */
export type RelocationCode = RelocationRefusalCode | RelocationPauseCode | RelocationWait['code'] | RelocationNoticeCode;

export interface RelocationPauseAfter {
  readonly sessions: number | null;
  readonly mode: 'pause' | 'hang';
}
