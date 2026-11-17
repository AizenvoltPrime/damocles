// The relocation runner (docs/invariants.md "Project relocation"): one runner per relocation across processes, holding
// <lockDir>/<id>.lock; the steps run in order, each idempotent, and a run pauses with a coded failure or finishes.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as lockfile from 'proper-lockfile';
import { RELOCATION_LOCK_DIR } from '../paths';
import { SESSION_LEASE_STALE_MS, SESSION_LEASE_UPDATE_MS } from '../pi-session/session-store/session-lease';
import type { AliasSource } from './aliases';
import { isPendingRecord, relocationsSnapshot, type RelocationsSnapshot } from './current';
import { pausedBy, RelocationPause, type StepOutcome } from './steps/outcome';
import type { RelocationStore } from './store';
import { folderKey } from '../workspace-folders/folder-key';
import { RELOCATION_STEPS, type Coded, type RelocationFolder, type RelocationPauseAfter, type RelocationRecord, type RelocationStepName, type RelocationStepState } from './types';

// A lock its holder stopped refreshing turns stale after SESSION_LEASE_STALE_MS; a retry then takes it over.
const LOCK_RETRY_MS = SESSION_LEASE_STALE_MS + 2 * SESSION_LEASE_UPDATE_MS;

export interface StepContext {
  readonly record: RelocationRecord;
  /** The journal as the relocations before this one left it: where each folder is, and the checkpoint bindings. */
  readonly before: RelocationsSnapshot;
  progress(done: number, total: number): void;
  /** The sessions step calls it after each session it commits. */
  sessionCommitted(): Promise<void>;
}

export type StepRunner = (context: StepContext) => Promise<StepOutcome>;

export type RelocationInput = Omit<RelocationRecord, 'seq' | 'state' | 'steps' | 'startedAt' | 'finishedAt'>;

export interface RelocationEngineOptions {
  readonly store: RelocationStore;
  readonly steps: Readonly<Record<RelocationStepName, StepRunner>>;
  readonly lockDir?: string;
  readonly log: (line: string) => void;
  /** A run's progress or its record changed. */
  readonly onChange?: () => void;
}

/** 'pendingRelocation' when a pending relocation names one of `folders`' paths, from or to; `foreignPending`: another version's. */
export function pendingRefusal(records: readonly RelocationRecord[], folders: readonly RelocationFolder[], foreignPending: readonly AliasSource[] = []): Coded | undefined {
  const keys = new Set(folders.flatMap((folder) => [folderKey(folder.from), folderKey(folder.to)]));
  for (const pending of [...records.filter(isPendingRecord), ...foreignPending]) {
    for (const folder of pending.folders) {
      for (const named of [folder.from, folder.to]) if (keys.has(folderKey(named))) return { code: 'pendingRelocation', params: { path: named } };
    }
  }
  return undefined;
}

/** Whether `record` has work left: pending, or finished with a step waiting on something outside the run; never once abandoned. */
export function needsRun(record: RelocationRecord): boolean {
  if (record.state === 'abandoned') return false;
  return record.state !== 'coreDone' || RELOCATION_STEPS.some((name) => record.steps[name].state === 'waiting');
}

export class RelocationEngine {
  private readonly store: RelocationStore;
  private readonly steps: Readonly<Record<RelocationStepName, StepRunner>>;
  private readonly lockDir: string;
  private readonly log: (line: string) => void;
  private readonly onChange: () => void;
  private readonly runs = new Map<string, Promise<void>>();
  // retried while their run was in flight: each runs once more when that run ends
  private readonly rerun = new Set<string>();
  private readonly progressById = new Map<string, { done: number; total: number }>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pauseAfter: RelocationPauseAfter | null = null;
  private disposed = false;

  constructor(options: RelocationEngineOptions) {
    this.store = options.store;
    this.steps = options.steps;
    this.lockDir = options.lockDir ?? RELOCATION_LOCK_DIR;
    this.log = options.log;
    this.onChange = options.onChange ?? (() => undefined);
  }

  /**
   * Writes the record ahead of any change and starts its run; resolves once the record is on disk. Refused when a pending
   * relocation the journal holds names one of its folders.
   */
  async begin(input: RelocationInput): Promise<RelocationRecord | { readonly refusal: Coded }> {
    const steps = Object.fromEntries(RELOCATION_STEPS.map((name) => [name, { state: 'pending' }])) as Record<RelocationStepName, RelocationStepState>;
    const written = await this.store.add((seq) => ({ ...input, seq, state: 'running', steps, startedAt: Date.now() }), (records, foreign) => pendingRefusal(records, input.folders, foreign));
    if ('refusal' in written) return written;
    void this.run(written.id);
    return written;
  }

  /** Runs the relocation's remaining steps while holding its lock; one held elsewhere is tried again once it can turn stale. */
  run(id: string): Promise<void> {
    const running = this.runs.get(id);
    if (running) return running;
    const run = this.runLocked(id)
      .catch((err: unknown) => this.log(`[ProjectRelocations] run of ${id} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`))
      .finally(() => {
        this.runs.delete(id);
        this.onChange();
        if (this.rerun.delete(id) && !this.disposed) this.retry(id).catch((err: unknown) => this.log(`[ProjectRelocations] running ${id} again failed: ${err instanceof Error ? err.message : String(err)}`));
      });
    this.runs.set(id, run);
    return run;
  }

  /**
   * A paused relocation runs again from the step that paused; a waiting step is tried again. One whose run is in flight runs once
   * more after it, since that run may have passed the step the caller wants run.
   */
  async retry(id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record || !needsRun(record)) return;
    const running = this.runs.get(id);
    if (running) {
      this.rerun.add(id);
      return running;
    }
    // another process may have abandoned it since this one read the journal
    if (record.state === 'paused') await this.store.update(id, (r) => (r.state === 'paused' ? { ...r, state: 'running' } : r));
    await this.run(id);
  }

  /**
   * Stops a paused relocation for good, under its lock: what it moved stays where it landed and no step of it runs again
   * (docs/invariants.md "Project relocation"). Refused unless the journal holds it paused and no runner holds it.
   */
  async abandon(id: string): Promise<Coded | undefined> {
    if (this.runs.has(id)) return { code: 'relocationRunning' };
    const release = await this.tryLock(id, () => undefined);
    if (!release) return { code: 'relocationRunning' };
    try {
      this.store.reload();
      if (this.store.get(id)?.state !== 'paused') return { code: 'notPaused' };
      let abandoned = false;
      await this.store.update(id, (r) => {
        if (r.state !== 'paused') return r;
        abandoned = true;
        return { ...r, state: 'abandoned', finishedAt: Date.now() };
      });
      this.rerun.delete(id);
      return abandoned ? undefined : { code: 'notPaused' };
    } finally {
      await release().catch((err: unknown) => this.log(`[ProjectRelocations] releasing the lock of ${id} failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /**
   * Every core start: each relocation with work left whose lock this process can take, one at a time in seq order, since a
   * waiting memory step re-keys by path and only the order the moves happened in keeps a reused path's rows apart.
   */
  async resumeAtStart(): Promise<void> {
    for (const record of this.store.records().filter(needsRun).sort((a, b) => a.seq - b.seq)) await this.retry(record.id);
  }

  isRunning(id: string): boolean {
    return this.runs.has(id);
  }

  progressOf(id: string): { done: number; total: number } | undefined {
    return this.progressById.get(id);
  }

  /** e2e only: after this many sessions are committed, pause the run as `stopped` or hang holding the lock; once. */
  setPauseAfter(pauseAfter: RelocationPauseAfter | null): void {
    this.pauseAfter = pauseAfter?.sessions === null ? null : pauseAfter;
  }

  /** Settles once no run of this engine is in flight. */
  async whenIdle(): Promise<void> {
    while (this.runs.size > 0) await Promise.all([...this.runs.values()]);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  private async runLocked(id: string): Promise<void> {
    const timer = this.retryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(id);
    let compromised = false;
    const release = await this.tryLock(id, () => {
      compromised = true;
    });
    if (!release) {
      this.retryLater(id);
      return;
    }
    try {
      // another process may have finished or paused the record before this one's watcher reported it
      this.store.reload();
      await this.runSteps(id, () => compromised);
    } finally {
      await release().catch((err: unknown) => this.log(`[ProjectRelocations] releasing the lock of ${id} failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private async tryLock(id: string, onCompromised: () => void): Promise<(() => Promise<void>) | undefined> {
    const lockPath = path.join(this.lockDir, `${id}.lock`);
    await fs.promises.mkdir(this.lockDir, { recursive: true });
    try {
      return await lockfile.lock(lockPath, {
        lockfilePath: lockPath,
        realpath: false,
        stale: SESSION_LEASE_STALE_MS,
        update: SESSION_LEASE_UPDATE_MS,
        onCompromised: (err) => {
          this.log(`[ProjectRelocations] lock of ${id} lost: ${err.message}`);
          onCompromised();
        },
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ELOCKED' || (process.platform === 'win32' && code === 'EPERM')) return undefined;
      throw err;
    }
  }

  private retryLater(id: string): void {
    if (this.disposed || this.retryTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      const record = this.store.get(id);
      if (record && needsRun(record) && record.state !== 'paused') void this.run(id);
    }, LOCK_RETRY_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.retryTimers.set(id, timer);
  }

  private async runSteps(id: string, lost: () => boolean): Promise<void> {
    const start = this.store.get(id);
    if (!start || !needsRun(start)) return;
    if (start.state === 'paused') return;
    const before = relocationsSnapshot(this.store.records().filter((r) => r.seq < start.seq), this.store.aliasSources().filter((source) => source.seq < start.seq));
    let committed = 0;
    for (const name of RELOCATION_STEPS) {
      if (this.disposed || lost()) return;
      const record = this.store.get(id);
      if (!record) return;
      if (record.steps[name].state === 'done') continue;
      const context: StepContext = {
        record,
        before,
        progress: (done, total) => {
          this.progressById.set(id, { done, total });
          this.onChange();
        },
        sessionCommitted: async () => {
          committed++;
          const pauseAfter = this.pauseAfter;
          if (!pauseAfter || pauseAfter.sessions === null || committed < pauseAfter.sessions) return;
          this.pauseAfter = null;
          if (pauseAfter.mode === 'pause') throw new RelocationPause({ code: 'stopped' });
          await new Promise<never>(() => undefined);
        },
      };
      const outcome = await this.steps[name](context).catch((err: unknown) => {
        if (!(err instanceof RelocationPause)) this.log(`[ProjectRelocations] ${id}: ${name} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        return pausedBy(err);
      });
      if (lost()) return;
      if (outcome.kind === 'paused') {
        this.log(`[ProjectRelocations] ${id} paused at ${name}: ${JSON.stringify(outcome.failure)}`);
        await this.store.update(id, (r) => ({ ...r, state: 'paused', steps: { ...r.steps, [name]: { state: 'pending', failure: outcome.failure } } }));
        return;
      }
      const step: RelocationStepState = outcome.kind === 'done' ? { state: 'done' } : { state: 'waiting', failure: outcome.failure };
      if (outcome.kind === 'waiting') this.log(`[ProjectRelocations] ${id}: ${name} waits: ${JSON.stringify(outcome.failure)}`);
      await this.store.update(id, (r) => {
        if (name !== 'repair') return { ...r, steps: { ...r.steps, [name]: step } };
        // the last run of the repair step alone decides which worktrees are still unlinked
        const { repairFailures: _previous, ...rest } = r;
        const failures = outcome.kind === 'waiting' ? outcome.repairFailures ?? [] : [];
        return { ...rest, steps: { ...r.steps, [name]: step }, ...(failures.length > 0 ? { repairFailures: failures } : {}) };
      });
    }
    await this.store.update(id, (r) => (r.state === 'running' ? { ...r, state: 'coreDone', finishedAt: Date.now() } : r));
  }
}
