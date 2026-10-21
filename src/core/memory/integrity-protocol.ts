// Host to memory integrity worker and back. The worker gets the database path from the host and imports neither vscode nor pi.

export const MEMORY_INTEGRITY_WORKER_MARKER = 'damocles-memory-integrity-worker';

/** A request with no answer by then fails, and its worker is stopped. */
export const MEMORY_INTEGRITY_TIMEOUT_MS = 60_000;

/** Written when damage needs a repair before the store is opened; the next start repairs it (docs/invariants.md "Memory store"). */
export function repairMarkerPath(dbPath: string): string {
  return `${dbPath}.needs-repair`;
}

/** The marker's JSON. `salvageFrom` names the quarantined file, in the store's folder, that a stopped salvage copies from again. */
export interface RepairMarker {
  salvageFrom?: string;
}

/**
 * `check` reads only. `rebuildFts` rebuilds the full-text index and checks again; it never moves the
 * file, because this process keeps it open. `repair` runs before this process opens the store.
 */
export type IntegrityRequest =
  | { type: 'check'; dbPath: string }
  | { type: 'rebuildFts'; dbPath: string }
  | { type: 'repair'; dbPath: string };

/**
 * `fts`: every finding is one the full-text tables' own checks report, so a rebuild can clear it; `rebuildFts`
 * never answers `fts`. `ahead`: a newer schema, which this build never checks.
 */
export type IntegrityVerdict = 'ok' | 'fts' | 'corrupt' | 'ahead';

/** `intact` and `salvaged` removed the marker; `ahead` and `failed` keep it. */
export type RepairOutcome =
  | { kind: 'intact' }
  | { kind: 'ahead' }
  | { kind: 'salvaged'; quarantinedFrom: string; salvagedMemories: number }
  /** The damage stays: the file could not be moved aside (on Windows, while another Damocles app holds it open). */
  | { kind: 'failed' };

export interface IntegrityResults {
  check: IntegrityVerdict;
  rebuildFts: IntegrityVerdict;
  repair: RepairOutcome;
}

export interface MemoryIntegrityWorkerData {
  marker: typeof MEMORY_INTEGRITY_WORKER_MARKER;
  request: IntegrityRequest;
}

/** A worker answers its one request with `result` or `error`, then exits. */
export type IntegrityEvent =
  | { type: 'log'; message: string }
  | { type: 'result'; result: IntegrityResults[IntegrityRequest['type']] }
  | { type: 'error'; message: string };
