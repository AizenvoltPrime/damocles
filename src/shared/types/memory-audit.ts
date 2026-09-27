/** What an accepted proposal does to its memory row or profile. */
export type MemoryAuditAction = "forget" | "rescope_global" | "rescope_workspace" | "to_episode" | "profile_rewrite";

/** `stale`: the row or section changed after grading, or a newer run started before a decision. */
export type MemoryAuditProposalStatus = "pending" | "applied" | "rejected" | "stale" | "reverted";

export type MemoryAuditRunStatus = "running" | "completed" | "cancelled" | "failed";

/** `forget_reason` of a row an applied audit proposal forgot; the extension writes it and the panel badges it. */
export const QUALITY_AUDIT_FORGET_REASON = "quality_audit";

/** The memory panel offers a first audit once this many memories are eligible. */
export const MEMORY_AUDIT_BANNER_MIN_ELIGIBLE = 20;

/** The small/fast sub-call model that grades, with its API rates in USD per million tokens. */
export interface MemoryAuditModel {
  provider: string;
  id: string;
  inputPerMTok: number;
  outputPerMTok: number;
  /** False on a flat subscription, where `costUsd` is an API-equivalent figure rather than a charge (useCostLabel). */
  dollarBilled: boolean;
}

export interface MemoryAuditEstimate {
  /** Live unpinned fact/preference/episode/observation rows the run grades. */
  memoryCount: number;
  /** Existing profiles, one rewrite call each. */
  profileCount: number;
  batchCount: number;
  /**
   * Every call's system prompt (sent twice), output schema and prompt, the known-workspace list
   * included, scaled by the measured tokenizer ratio, plus the measured per-call framing.
   */
  inputTokens: number;
  /** The measured output per graded memory and per grading call, plus the measured output per profile call. */
  outputTokens: number;
  /** Null when no sub-call model is configured. */
  model: MemoryAuditModel | null;
  /** The model has no input or output rate, so the run cannot be priced; `costUsd` is then null. */
  unpriced: boolean;
  /** Null when `model` is null or `unpriced`. */
  costUsd: number | null;
}

export interface MemoryAuditRunView {
  id: string;
  status: MemoryAuditRunStatus;
  startedAt: number;
  finishedAt: number | null;
  /** Units of work: memories + profiles. */
  total: number;
  /** Units graded successfully so far (memories + profiles). */
  graded: number;
  failedBatches: number;
  rubricVersion: number;
  /** False when another window holds or held the lease. */
  ownedByThisWindow: boolean;
  /** Running with a heartbeat inside the lease: no window can start a new run. */
  leaseActive: boolean;
}

export interface MemoryAuditProfileText {
  static: string;
  dynamic: string;
}

export interface MemoryAuditProposalView {
  id: string;
  runId: string;
  action: MemoryAuditAction;
  status: MemoryAuditProposalStatus;
  reason: string;
  /** Null for profile_rewrite. */
  memoryId: string | null;
  kind: string | null;
  title: string | null;
  contentPreview: string | null;
  /** Row state when graded (or when applied, once applied). */
  currentScope: string | null;
  currentWorkspace: string | null;
  /** rescope_workspace only, in the database's spelling. */
  targetWorkspace: string | null;
  profileScope: "project" | "global" | null;
  profileWorkspace: string | null;
  /** profile_rewrite only. */
  profileBefore: MemoryAuditProfileText | null;
  profileAfter: MemoryAuditProfileText | null;
}

/** The review overlay's full state; the memory panel reads {@link MemoryAuditSummary} instead. */
export interface MemoryAuditStatePayload {
  /** The latest run by start time. */
  run: MemoryAuditRunView | null;
  /** Proposals of the latest run. */
  proposals: MemoryAuditProposalView[];
  estimate: MemoryAuditEstimate;
  hasAnyRun: boolean;
  eligibleCount: number;
  /**
   * The latest run still has pending or applied proposals. Starting a new run marks its pending
   * proposals stale and leaves only the new run reviewable, which ends revert of this one.
   */
  startEndsLatestRun: boolean;
}

/** What the memory panel's banner needs, without rendering or token-counting any memory. */
export interface MemoryAuditSummary {
  hasAnyRun: boolean;
  /** Rows a run would grade; the banner shows while `!hasAnyRun && eligibleCount >= MEMORY_AUDIT_BANNER_MIN_ELIGIBLE`. */
  eligibleCount: number;
  /** A run holds a live lease in some window. */
  running: boolean;
  /** That live run belongs to this window. */
  runningHere: boolean;
  /** Proposals of the latest run still awaiting a decision. */
  pendingCount: number;
}

export interface MemoryAuditProgress {
  runId: string;
  graded: number;
  total: number;
  failedBatches: number;
  status: MemoryAuditRunStatus;
}

/** Proposals named in neither list stay pending. */
export interface MemoryAuditApplyResult {
  applied: number;
  /** Accepted, but the row or section changed after grading, so nothing was written. */
  stale: number;
  rejected: number;
}

export interface MemoryAuditRevertResult {
  reverted: number;
  /** Applied proposals left alone because their row or section changed after apply. */
  skipped: number;
}

/** Sent to the panel that asked, after the state and memory list broadcasts. */
export type MemoryAuditResult =
  | ({ action: "apply" } & MemoryAuditApplyResult)
  | ({ action: "revert" } & MemoryAuditRevertResult);

/**
 * The definite answer to `cancelMemoryAudit`: `cancelled` when this window's run (or its start) was
 * stopped and has settled, `held-elsewhere` when the live run belongs to another window and cannot be
 * cancelled from here, `not-running` when no run was live.
 */
export type MemoryAuditCancelResult = "cancelled" | "held-elsewhere" | "not-running";

/**
 * Carried as `code` on a `memoryError` with source `audit`; `message` is English for logs only.
 * - `unavailable`: the memory store is disabled or failed to open.
 * - `busy`: a run is already live in this or another window.
 * - `no-model`: no sub-call model with a configured credential.
 * - `lease-lost`: another window took over this window's run.
 * - `all-failed`: every grading and profile call failed.
 * - `run-failed`: the run stopped on an unexpected error.
 * - `request-failed`: an audit request (apply, revert, ...) threw.
 */
export type MemoryAuditErrorCode =
  | "unavailable"
  | "busy"
  | "no-model"
  | "lease-lost"
  | "all-failed"
  | "run-failed"
  | "request-failed";
