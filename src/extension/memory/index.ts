import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { log } from '../logger';
import { openDatabaseAsync, updateSearchTermsIfUnchanged, getUnexpandedMemoryRows, type UnexpandedRow } from './database';
import { expandMemoryTerms, expandMemoryTermsWithStatus, clearExpansionCache } from './query-expansion';
import { NoteManager } from './managers/note-manager';
import { ObservationManager } from './managers/observation-manager';
import { RetrievalManager } from './managers/retrieval-manager';
import { InjectionManager } from './managers/injection-manager';
import { FileChangeTracker } from './managers/file-change-tracker';
import { FactGraphManager } from './managers/fact-graph-manager';
import { ProfileManager } from './managers/profile-manager';
import { MemoryWriteQueue } from './write-queue';
import { createMemorySubCallRunner, type MemorySubCallRunner } from './subcall-runner';
import { runConsolidation, mergePendingConsolidation, type ConsolidationReason } from './consolidation';
import type {
  ConsolidationResult,
  ConsolidationTrigger,
  ConsolidationFailure,
  ConsolidationPhaseEvent,
  PendingConsolidationCandidate,
} from '@shared/types/consolidation';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import type { ObservationCursor } from '@shared/types/memory';
import { insertWithDedup, deleteMemoriesWithHygiene, type NewMemoryFields } from './dedup-decay';
import type { DatabaseInstance, MemoryRow } from './types';
import { rowToEntry, normalizedContentHash } from './types';
import { buildFtsMatchQuery } from './text-tokenize';
import type { EdgeKind } from './managers/fact-graph-manager';
import { MAX_MEMORY_CONTENT_CHARS } from '@shared/types/memory';
import type {
  MemoryEntry,
  MemoryScope,
  ObservationInput,
  SearchQuery,
  SearchResult,
  UserProfile,
} from '@shared/types/memory';
import type { MemoryInjectionDisplay } from '@shared/types/context-injection';

/** One completed conversation turn queued for extraction. */
interface TurnCandidate {
  sessionId: string;
  promptIndex: number;
  userText: string;
  assistantText: string;
  files: string[];
}

/** Cap on buffered pre-init turn candidates; oldest dropped so a failing init cannot leak memory. */
const MAX_PENDING_TURN_CANDIDATES = 50;

const MAX_CONTENT_CHARS = MAX_MEMORY_CONTENT_CHARS;

export class MemoryService {
  private db: DatabaseInstance | null = null;
  private _initFailed = false;
  private _persistFailureNotified = false;
  private _initPromise: Promise<void> | null = null;
  private noteManager: NoteManager | null = null;
  private observationManager: ObservationManager | null = null;
  private retrievalManager: RetrievalManager | null = null;
  private injectionManager: InjectionManager | null = null;
  private fileChangeTracker: FileChangeTracker | null = null;
  private backfillAbort: AbortController | null = null;
  private writeQueue: MemoryWriteQueue | null = null;
  private runner: MemorySubCallRunner | null = null;
  private factGraph: FactGraphManager | null = null;
  private profileManager: ProfileManager | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Deferred+jittered timer for the first ('start') pass so two windows don't race the startup claim. */
  private startJitterTimer: ReturnType<typeof setTimeout> | null = null;
  /** Stable per-process window identity, stamped onto candidate claims as the cross-window lease holder. */
  private readonly instanceId = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  /** Turns that arrived before the DB was ready; replayed at the end of {@link _doInit}. */
  private pendingTurnCandidates: TurnCandidate[] = [];
  private consolidating = false;
  private consolidationInFlight: Promise<void> | null = null;
  private pendingConsolidation: { reason: ConsolidationReason; sessionId?: string; forceExtract?: boolean } | null = null;
  private extractionPausedNotified = false;
  private consolidationBroadcast: ((msg: ExtensionToWebviewMessage) => void) | null = null;
  private lastConsolidationResult: ConsolidationResult | null = null;
  /** Ordered live-progress events of the in-flight pass, replayed when a panel reopens the overlay mid-pass. */
  private currentPhaseEvents: ConsolidationPhaseEvent[] = [];
  private disposed = false;
  /** Guards the stale-injection-DB sweep so repeated init calls don't re-sweep. */
  private staleSweepDone = false;
  /** Consecutive failed/released passes; drives the idle-timer backoff. Reset to 0 on any non-failed pass. */
  private consecutiveConsolidationFailures = 0;
  /** Upper bound (1h) on the exponential idle-timer backoff. */
  private readonly IDLE_BACKOFF_MAX_MS = 60 * 60 * 1000;
  /**
   * Floor on the backoff branch only. Without it, `idleSeconds = 0` makes the base delay 0 so
   * `0 * 2^failures` stays 0 and a persistently-failing pass would busy-loop the timer.
   */
  private readonly IDLE_BACKOFF_MIN_MS = 30 * 1000;

  // node:sqlite has no bundled asset to resolve, so `_extensionPath` is unused (kept for call-site compat).
  constructor(_extensionPath: string) {}

  /** Register the sink that broadcasts consolidation activity to every open panel. */
  setConsolidationBroadcast(broadcast: (msg: ExtensionToWebviewMessage) => void): void {
    this.consolidationBroadcast = broadcast;
  }

  /** The conversation turns currently queued for the next consolidation pass (global, unconsumed). */
  getPendingCandidates(): PendingConsolidationCandidate[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT id, session_id, user_text, assistant_text, created_at
           FROM memory_candidates WHERE consumed = 0 ORDER BY created_at`,
      )
      .all() as Array<{ id: string; session_id: string | null; user_text: string; assistant_text: string; created_at: number }>;
    return rows.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      userPreview: r.user_text.slice(0, 240),
      assistantPreview: r.assistant_text.slice(0, 240),
      createdAt: r.created_at,
    }));
  }

  /** The most recent pass's extracted memories, replayed when a panel reopens the consolidation overlay. */
  getLastConsolidationResult(): ConsolidationResult | null {
    return this.lastConsolidationResult;
  }

  /** Count of turns queued for the next consolidation pass — drives the header pill badge. */
  getPendingCount(): number {
    if (!this.db) return 0;
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM memory_candidates WHERE consumed = 0').get() as { n: number };
    return row.n;
  }

  /** User-initiated global consolidation pass; forces extraction even if auto-extract is off. */
  async triggerConsolidation(): Promise<void> {
    await this.ensureInitialized();
    // Surface a visible terminal result on init failure so "Run now" never appears inert.
    if (!this.db) {
      this.emitTerminalResult(this.buildUnavailableResult('manual'));
      return;
    }
    await this.runConsolidation({ reason: 'manual', forceExtract: true });
  }

  /** A terminal `failed/unavailable` result for when the memory DB is not initialized / init failed. */
  private buildUnavailableResult(trigger: ConsolidationTrigger): ConsolidationResult {
    const failure: ConsolidationFailure = { kind: 'unavailable' };
    return {
      ranAt: Date.now(),
      trigger,
      status: 'failed',
      extracted: [],
      maintenance: { promoted: 0, decayed: 0, pruned: 0 },
      candidatesReviewed: 0,
      failure,
    };
  }

  /** Single owner of {@link lastConsolidationResult} + the `consolidationResult` broadcast — no second channel to desync. */
  private emitTerminalResult(result: ConsolidationResult): void {
    this.lastConsolidationResult = result;
    this.consolidationBroadcast?.({ type: 'consolidationResult', result });
  }

  /** Live consolidation activity for overlay-open replay: running flag + every phase event so far. */
  getConsolidationActivity(): { running: boolean; phaseEvents: ConsolidationPhaseEvent[] } {
    return { running: this.consolidating, phaseEvents: [...this.currentPhaseEvents] };
  }

  private broadcastPendingCount(): void {
    this.consolidationBroadcast?.({ type: 'consolidationPendingCount', count: this.getPendingCount() });
  }

  get isEnabled(): boolean {
    return vscode.workspace.getConfiguration('damocles.memory').get<boolean>('enabled', true);
  }

  get database(): DatabaseInstance | null {
    return this.db;
  }

  get isAvailable(): boolean {
    return this.isEnabled && !this._initFailed && this.db !== null;
  }

  async ensureInitialized(): Promise<void> {
    if (this.disposed) return; // a late call after dispose() must not reopen the DB or re-arm watchers/timers
    if (!this.isEnabled) return;
    if (this._initFailed) return;
    if (this.db) return;
    if (!this._initPromise) {
      this._initPromise = this._doInit().catch(err => {
        this._initPromise = null;
        this._initFailed = true;
        log('[MemoryService] Unexpected init failure — disabling: %O', err);
      });
    }
    return this._initPromise;
  }

  private async _doInit(): Promise<void> {
    const opened = await openDatabaseAsync({
      onPersistFailure: (n) => this.handlePersistFailure(n),
    });
    if (!opened) {
      this._initFailed = true;
      log('[MemoryService] Database open failed — disabling memory system');
      vscode.window.showErrorMessage('Damocles memory failed to initialize; memory features are disabled.');
      return;
    }

    this.db = opened.db;
    if (opened.quarantinedFrom) {
      const salvaged = opened.salvagedMemories ?? 0;
      vscode.window.showWarningMessage(
        salvaged > 0
          ? `Damocles memory database was corrupt; ${salvaged} memories were recovered into a rebuilt store (original set aside as ${path.basename(opened.quarantinedFrom)}).`
          : `Damocles memory database was corrupt and has been set aside as ${path.basename(opened.quarantinedFrom)}. A fresh memory store was created.`,
      );
    }

    this.writeQueue = new MemoryWriteQueue(this.db);
    this.runner = createMemorySubCallRunner();
    this.factGraph = new FactGraphManager(this.db, this.writeQueue, this.runner);
    this.profileManager = new ProfileManager(this.db, this.writeQueue, this.runner);

    this.noteManager = new NoteManager(this.db);
    this.observationManager = new ObservationManager(this.db);
    this.retrievalManager = new RetrievalManager(this.db, this.runner);
    this.injectionManager = new InjectionManager(this.db, this.profileManager, this.runner);
    this.fileChangeTracker = new FileChangeTracker(this.db, this.writeQueue, this.currentWorkspace);
    this.fileChangeTracker.initialize();

    // Bound accumulation of never-explicitly-deleted per-session injection DBs. Fire-and-forget once
    // per process; a sweep failure must not break init.
    if (!this.staleSweepDone) {
      this.staleSweepDone = true;
      void this.injectionManager.sweepStaleDatabases().catch(err => {
        log('[MemoryService] Stale injection DB sweep failed: %O', err);
      });
    }

    this.startBackfill();

    // Replay turns buffered before the DB was ready, FIFO, before arming the jitter.
    if (this.pendingTurnCandidates.length > 0) {
      const buffered = this.pendingTurnCandidates;
      this.pendingTurnCandidates = [];
      log('[MemoryService] Replaying %d turn candidate(s) buffered before init', buffered.length);
      for (const args of buffered) {
        this.persistTurnCandidate(this.db, args).catch(err =>
          log('[MemoryService] Buffered turn-candidate replay failed: %O', err),
        );
      }
      this.broadcastPendingCount();
    }

    // Defer + jitter the first pass so two windows opening together don't race the startup claim;
    // the lease TTL protects whichever wins.
    this.startJitterTimer = setTimeout(() => {
      this.startJitterTimer = null;
      this.runConsolidation({ reason: 'start' }).catch(err =>
        log('[MemoryService] Startup consolidation failed: %O', err),
      );
    }, 5_000 + Math.random() * 25_000);
  }

  /** Latch a single user-visible error at 3 consecutive write failures; re-arm on recovery (count 0). */
  private handlePersistFailure(consecutiveFailures: number): void {
    if (consecutiveFailures === 0) {
      this._persistFailureNotified = false;
      return;
    }
    if (consecutiveFailures >= 3 && !this._persistFailureNotified) {
      this._persistFailureNotified = true;
      vscode.window.showErrorMessage(
        'Damocles memory writes are failing repeatedly. Your recent memory changes may not be saved.',
      );
    }
  }

  async addNote(content: string, tags?: string[]): Promise<MemoryEntry | null> {
    await this.ensureInitialized();
    const db = this.db, writeQueue = this.writeQueue, noteManager = this.noteManager;
    if (!db || !writeQueue || !noteManager) return null;
    const clamped = content.slice(0, MAX_CONTENT_CHARS);
    const result = await writeQueue.run(() => noteManager.add(clamped, tags));
    if (result) this._expandSearchTerms(result.id, { content: clamped, ...(tags ? { tags } : {}) });
    return result;
  }

  getObservationCount(workspace: string): number {
    return this.observationManager?.countForWorkspace(workspace) ?? 0;
  }

  getObservationPage(workspace: string, cursor?: ObservationCursor, limit: number = 20): { entries: MemoryEntry[]; hasMore: boolean; nextCursor: ObservationCursor | null } {
    if (!this.db || !this.observationManager) return { entries: [], hasMore: false, nextCursor: null };
    const entries = this.observationManager.getRecentForWorkspace(workspace, limit, cursor);
    // A full page implies there may be more; the next request pages from the last row's keyset tuple.
    const hasMore = entries.length === limit;
    const last = entries[entries.length - 1];
    const nextCursor = hasMore && last ? { createdAt: last.createdAt, id: last.id } : null;
    return { entries, hasMore, nextCursor };
  }

  /**
   * Store a durable fact/preference/episode, routed through the same dedup + conflict-resolution path
   * as auto-extraction (exact duplicate bumps source_count; a contradicting one supersedes the older).
   */
  async saveMemory(args: {
    content: string;
    kind: 'fact' | 'preference' | 'episode';
    scope: MemoryScope;
    title?: string;
    tags?: string[];
    sessionId?: string;
    workspace?: string;
  }): Promise<MemoryEntry | null> {
    await this.ensureInitialized();
    if (!this.db || !this.writeQueue || !this.factGraph) return null;

    const content = args.content.slice(0, MAX_CONTENT_CHARS);
    const fields: NewMemoryFields = {
      kind: args.kind,
      scope: args.scope,
      content,
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
      ...(args.scope === 'project' && args.workspace ? { workspace: args.workspace } : {}),
      ...(args.scope === 'session' && args.sessionId ? { sessionId: args.sessionId } : {}),
    };

    const { id, deduped } = await insertWithDedup(this.db, this.writeQueue, fields);
    if (!deduped) {
      if (args.kind === 'fact' || args.kind === 'preference') {
        const fresh = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
        if (fresh) await this.factGraph.resolveConflict(fresh);
      }
      this._expandSearchTerms(id, {
        content,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
      });
    }

    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  /**
   * Live fact/preference/episode/note rows for the panel, excluding superseded versions. Forgotten
   * rows are included so the panel's "show forgotten" toggle can reveal them; observations load via
   * {@link getObservationPage}.
   */
  getPanelMemories(sessionId: string | null, workspace: string): MemoryEntry[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      `SELECT * FROM memories
       WHERE is_latest = 1
         AND kind IN ('fact','preference','episode','note')
         AND (scope = 'global' OR workspace = ? OR (session_id = ? AND scope = 'session'))
       ORDER BY updated_at DESC`
    ).all(workspace, sessionId ?? '') as MemoryRow[];
    return rows.map(rowToEntry);
  }

  /**
   * Apply a user edit. Editing a `fact`/`preference` creates a NEW version row (visible in history);
   * other kinds edit in place. Both recompute `content_hash` and preserve existing tags when `tags`
   * is omitted.
   */
  async updateMemory(id: string, contentRaw: string, tags?: string[]): Promise<MemoryEntry | null> {
    await this.ensureInitialized();
    const db = this.db, writeQueue = this.writeQueue, factGraph = this.factGraph;
    if (!db || !writeQueue) return null;
    const old = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    if (!old) return null;

    const content = contentRaw.slice(0, MAX_CONTENT_CHARS);
    let targetId = id;
    if ((old.kind === 'fact' || old.kind === 'preference') && factGraph) {
      targetId = await factGraph.editAsNewVersion(old, content, tags);
    } else {
      await writeQueue.run(() => {
        const tagsJson = tags === undefined ? old.tags : JSON.stringify(tags);
        db.prepare(
          'UPDATE memories SET content = ?, content_hash = ?, tags = ?, updated_at = ? WHERE id = ?',
        ).run(content, normalizedContentHash(content), tagsJson, Date.now(), id);
      });
    }
    await this.fileChangeTracker?.resetStaleness(targetId);
    this._expandSearchTerms(targetId, { content, ...(tags ? { tags } : {}) });
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(targetId) as MemoryRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  async resetObservationStaleness(id: string): Promise<boolean> {
    await this.ensureInitialized();
    const db = this.db, writeQueue = this.writeQueue;
    if (!db || !writeQueue) return false;
    return this.fileChangeTracker ? await this.fileChangeTracker.resetStaleness(id) : false;
  }

  async deleteMemory(id: string): Promise<boolean> {
    await this.ensureInitialized();
    const db = this.db, writeQueue = this.writeQueue;
    if (!db || !writeQueue) return false;
    const changed = await writeQueue.run(() => {
      const row = db.prepare('SELECT id, parent_id, is_latest FROM memories WHERE id = ?').get(id) as
        { id: string; parent_id: string | null; is_latest: number } | undefined;
      if (!row) return false;
      // Deleting the live head of a version chain: promote its parent to is_latest=1 (in this same
      // transaction, before the delete) so the chain stays reachable. Promote regardless of the
      // parent's forgotten flag — live-query filters handle visibility.
      if (row.is_latest === 1 && row.parent_id) {
        db.prepare('UPDATE memories SET is_latest = 1 WHERE id = ?').run(row.parent_id);
      }
      // Re-link any children of the deleted row to its parent so a mid-chain delete doesn't dangle
      // their parent_id and truncate getVersionHistory for the survivors (parent_id may be NULL,
      // which correctly makes a survivor a new chain root).
      db.prepare('UPDATE memories SET parent_id = ? WHERE parent_id = ?').run(row.parent_id, id);
      deleteMemoriesWithHygiene(db, [id]);
      return true;
    });
    if (changed) this.fileChangeTracker?.removeObservation(id);
    return changed;
  }

  listNotes(tags?: string[]): MemoryEntry[] {
    return this.noteManager?.list(tags) ?? [];
  }

  /** Manual save: a direct insert; dedup/conflict resolution apply only on the auto-extraction path. */
  async addObservation(sessionId: string, workspace: string, input: ObservationInput): Promise<MemoryEntry | null> {
    await this.ensureInitialized();
    const db = this.db, writeQueue = this.writeQueue, observationManager = this.observationManager;
    if (!db || !writeQueue || !observationManager) return null;
    const result = await writeQueue.run(() => observationManager.addRichObservation(sessionId, workspace, input));
    if (result) {
      this.fileChangeTracker?.trackObservation(result.id, input.filesRead ?? [], input.filesModified ?? []);
      this._expandSearchTerms(result.id, {
        content: input.content,
        title: input.title,
        facts: input.facts,
        ...(input.observationTags ? { tags: input.observationTags } : {}),
      });
    }
    return result;
  }

  async searchMemories(query: SearchQuery): Promise<SearchResult[]> {
    return (await this.retrievalManager?.search(query)) ?? [];
  }

  async getMemoryDetails(ids: string[]): Promise<MemoryEntry[]> {
    await this.ensureInitialized();
    const db = this.db, writeQueue = this.writeQueue;
    if (!db || !writeQueue || ids.length === 0) return [];
    return writeQueue.run(() => {
      const ph = ids.map(() => '?').join(',');
      // Don't bump access on a forgotten row, but still resolve it — an explicit fetch of a surfaced forgotten hit must return.
      db.prepare(`UPDATE memories SET access_count = access_count + 1 WHERE id IN (${ph}) AND forgotten = 0`).run(...ids);
      const rows = db.prepare(`SELECT * FROM memories WHERE id IN (${ph})`).all(...ids) as MemoryRow[];
      return rows.map(rowToEntry);
    });
  }

  /** Version chain for a fact, root→latest, for the panel's version drill-down. */
  getMemoryHistory(id: string): MemoryEntry[] {
    return this.factGraph?.getVersionHistory(id).map(rowToEntry) ?? [];
  }

  /** Fact-graph neighbors reached over UPDATES/EXTENDS/DERIVES/SUPERSEDES edges (default depth 2). */
  getRelatedMemories(id: string, maxDepth?: number): MemoryEntry[] {
    const kinds: EdgeKind[] = ['UPDATES', 'EXTENDS', 'DERIVES', 'SUPERSEDES'];
    return this.factGraph?.getRelated(id, kinds, maxDepth ?? 2).map(rowToEntry) ?? [];
  }

  /**
   * Forget a memory by id or content match. `chain` (default) forgets every version sharing the root
   * so no older version resurfaces; `version` forgets only the resolved row. Resolution: exact id
   * first, else (unless `exactId`) top FTS hit over live rows. The panel passes `exactId` so a clicked
   * row whose id is stale (superseded/version-forked) reports "not found" instead of silently
   * content-matching and forgetting an unrelated memory.
   */
  forgetMemory(
    idOrContent: string,
    scope: 'version' | 'chain',
    exactId = false,
  ): Promise<{ forgotten: number; target?: { title: string | null; snippet: string } }> {
    const db = this.db;
    const factGraph = this.factGraph;
    const writeQueue = this.writeQueue;
    if (!db || !factGraph || !writeQueue) return Promise.resolve({ forgotten: 0 });

    return writeQueue.run(() => {
      const targetId = exactId
        ? (db.prepare('SELECT id FROM memories WHERE id = ?').get(idOrContent) as { id: string } | undefined)?.id ?? null
        : this.resolveForgetTarget(db, idOrContent);
      if (!targetId) return { forgotten: 0, forgottenIds: [] as string[] };

      const resolved = db.prepare('SELECT title, content FROM memories WHERE id = ?').get(targetId) as
        | { title: string | null; content: string }
        | undefined;

      const result =
        scope === 'version'
          ? db
              .prepare(
                "UPDATE memories SET forgotten = 1, forget_reason = 'user_forget' WHERE id = ?",
              )
              .run(targetId)
          : db
              .prepare(
                "UPDATE memories SET forgotten = 1, forget_reason = 'user_forget' WHERE COALESCE(root_id, id) = (SELECT COALESCE(root_id, id) FROM memories WHERE id = ?)",
              )
              .run(targetId);

      const forgotten = result.changes;
      // Thread the ids out so they can be untracked from the file-change index after commit (a
      // forgotten observation must accumulate no staleness).
      const forgottenIds =
        forgotten === 0
          ? []
          : scope === 'version'
            ? [targetId]
            : (db
                .prepare(
                  'SELECT id FROM memories WHERE COALESCE(root_id, id) = (SELECT COALESCE(root_id, id) FROM memories WHERE id = ?)',
                )
                .all(targetId) as { id: string }[]).map((r) => r.id);

      if (forgotten === 0 || !resolved) return { forgotten, forgottenIds };
      return {
        forgotten,
        forgottenIds,
        target: { title: resolved.title, snippet: resolved.content.slice(0, 80) },
      };
    }).then(({ forgottenIds, ...rest }) => {
      for (const id of forgottenIds) this.fileChangeTracker?.removeObservation(id);
      return rest;
    });
  }

  /** Restore a forgotten memory. `chain` (default) restores every version sharing the root. */
  unforgetMemory(id: string, scope: 'version' | 'chain' = 'chain'): Promise<{ restored: number }> {
    const db = this.db;
    const writeQueue = this.writeQueue;
    if (!db || !writeQueue) return Promise.resolve({ restored: 0 });

    return writeQueue.run(() => {
      const result =
        scope === 'version'
          ? db
              .prepare('UPDATE memories SET forgotten = 0, forget_reason = NULL WHERE id = ?')
              .run(id)
          : db
              .prepare(
                'UPDATE memories SET forgotten = 0, forget_reason = NULL WHERE COALESCE(root_id, id) = (SELECT COALESCE(root_id, id) FROM memories WHERE id = ?)',
              )
              .run(id);
      return { restored: result.changes };
    });
  }

  /** Read the user profile (static + dynamic) for the panel's profile editor. */
  getProfile(scope: 'project' | 'global', workspace: string): UserProfile {
    return this.profileManager?.getProfile(scope, workspace) ?? { static: '', dynamic: '' };
  }

  /**
   * Persist an edited profile section. Returns `true` only when the upsert committed; `false` when
   * memory is unavailable or the write throws. The panel uses this as the save-confirmation signal —
   * on `false` it keeps the user's draft so a failed save never loses edits.
   */
  async setProfileSection(scope: 'project' | 'global', workspace: string, section: 'static' | 'dynamic', content: string): Promise<boolean> {
    await this.ensureInitialized();
    if (!this.profileManager) return false;
    try {
      await this.profileManager.setProfileSection(scope, workspace, section, content);
      return true;
    } catch (err) {
      log('[MemoryService] setProfileSection failed for %s/%s: %O', scope, section, err);
      return false;
    }
  }

  /** Exact-id match wins; otherwise the top BM25 hit over live rows for the supplied text. */
  private resolveForgetTarget(db: DatabaseInstance, idOrContent: string): string | null {
    const direct = db.prepare('SELECT id FROM memories WHERE id = ?').get(idOrContent) as
      | { id: string }
      | undefined;
    if (direct) return direct.id;

    const match = this.buildForgetMatch(idOrContent);
    if (!match) return null;

    const hit = db
      .prepare(
        `SELECT m.id FROM memories_fts fts
           JOIN memories m ON m.rowid = fts.rowid
          WHERE memories_fts MATCH ?
            AND m.is_latest = 1 AND m.forgotten = 0
          ORDER BY fts.rank
          LIMIT 1`,
      )
      .get(match) as { id: string } | undefined;
    return hit?.id ?? null;
  }

  /** OR-joins the salient tokens of the content text into an FTS5 MATCH expression. */
  private buildForgetMatch(content: string): string | null {
    return buildFtsMatchQuery(content, 12);
  }

  async migrateSessionId(oldId: string, newId: string): Promise<void> {
    await this.ensureInitialized();
    const db = this.db, writeQueue = this.writeQueue;
    if (!db || !writeQueue) return;
    await writeQueue.run(() => {
      db.prepare('UPDATE memories SET session_id = ? WHERE session_id = ?').run(newId, oldId);
      db.prepare('UPDATE memory_candidates SET session_id = ? WHERE session_id = ?').run(newId, oldId);
    });
    // Follow the rename onto the injection DB file so the prompt-0 profile/handoff record survives.
    await this.injectionManager?.renameSession(oldId, newId);
  }

  async deleteSessionMemories(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    const db = this.db, writeQueue = this.writeQueue;
    if (!db || !writeQueue) return;
    await writeQueue.run(() => {
      const ids = (
        db.prepare("SELECT id FROM memories WHERE scope = 'session' AND session_id = ?").all(sessionId) as { id: string }[]
      ).map((r) => r.id);
      deleteMemoriesWithHygiene(db, ids);
      // Also drop the raw turn buffer, else its text is re-extracted later under a dead session_id.
      db.prepare('DELETE FROM memory_candidates WHERE session_id = ?').run(sessionId);
    });
    await this.injectionManager?.deleteSession(sessionId);
  }

  isFirstMessageOfSession(sessionId: string): boolean {
    return this.injectionManager?.isFirstMessageOfSession(sessionId) ?? true;
  }

  markFirstMessageSent(sessionId: string): void {
    this.injectionManager?.markFirstMessageSent(sessionId);
  }

  async buildInjectionContext(sessionId: string | null, workspace: string, activeFile: string | null, userPrompt?: string): Promise<{ context: string; metadata: MemoryInjectionDisplay | null }> {
    await this.ensureInitialized();
    return await this.injectionManager?.buildMemoryCatalog(sessionId, workspace, activeFile, userPrompt) ?? { context: '', metadata: null };
  }

  async pinMemory(id: string): Promise<boolean> {
    await this.ensureInitialized();
    const db = this.db, writeQueue = this.writeQueue, injectionManager = this.injectionManager;
    if (!db || !writeQueue || !injectionManager) return false;
    return writeQueue.run(() => injectionManager.pinMemory(id));
  }

  async unpinMemory(id: string): Promise<boolean> {
    await this.ensureInitialized();
    const db = this.db, writeQueue = this.writeQueue, injectionManager = this.injectionManager;
    if (!db || !writeQueue || !injectionManager) return false;
    return writeQueue.run(() => injectionManager.unpinMemory(id));
  }

  async recordRetrievals(ids: string[], workspace: string): Promise<void> {
    await this.ensureInitialized();
    const db = this.db, writeQueue = this.writeQueue, injectionManager = this.injectionManager;
    if (!db || !writeQueue || !injectionManager) return;
    await writeQueue.run(() => injectionManager.recordRetrievals(ids, workspace));
  }

  async persistMemoryInjection(sessionId: string, promptIndex: number, display: MemoryInjectionDisplay): Promise<void> {
    await this.injectionManager?.persistInjection(sessionId, promptIndex, display);
  }

  async getPersistedMemoryInjection(sessionId: string, promptIndex: number): Promise<MemoryInjectionDisplay | undefined> {
    return await this.injectionManager?.getPersistedInjection(sessionId, promptIndex);
  }

  private _expandSearchTerms(id: string, entry: { content: string; title?: string; tags?: string[]; facts?: string[] }): void {
    if (!this.db) return;
    // Snapshot updated_at before the async expansion so a live edit landing meanwhile isn't
    // overwritten with stale terms — same CAS the backfill path uses.
    const row = this.db.prepare('SELECT updated_at FROM memories WHERE id = ?').get(id) as
      | { updated_at: number }
      | undefined;
    if (!row) return;
    const expectedUpdatedAt = row.updated_at;
    expandMemoryTerms(entry).then(terms => {
      if (terms.length === 0) return;
      return this.writeQueue?.run(() => {
        if (this.db) updateSearchTermsIfUnchanged(this.db, id, terms, expectedUpdatedAt);
      });
    }).catch(err => {
      log('[MemoryService] Search term expansion failed for %s: %O', id, err);
    });
  }

  private startBackfill(): void {
    if (!this.db) return;
    this.backfillAbort = new AbortController();
    this.runBackfill(this.db, this.backfillAbort.signal).catch(err =>
      log('[MemoryService] Search-term backfill failed: %O', err),
    );
  }

  /**
   * Expand search terms for every row that lacks them, in keyset-paginated batches so a single launch
   * drains the whole backlog (not just the first 100) in O(n). Per row: CAS on `updated_at` so a live
   * edit landing during the async expansion is never overwritten with stale terms. Circuit breaker
   * trips after {@link MAX_CONSECUTIVE_FAILURES} batches where every expansion soft-failed.
   */
  private async runBackfill(db: DatabaseInstance, signal: AbortSignal, batchDelayMs = 3000): Promise<void> {
    const IN_FLIGHT_CAP = 5;
    const BATCH_DELAY_MS = batchDelayMs;
    const MAX_CONSECUTIVE_FAILURES = 3;
    let consecutiveFailures = 0;
    // Keyset cursor over (updated_at, id). A successful expansion yielding zero terms leaves the row
    // at search_terms='[]', so advancing the cursor past every fetched row (not just written ones) is
    // what stops it being re-fetched forever — the cursor only ever moves forward.
    let after: UnexpandedRow | undefined;

    for (;;) {
      if (signal.aborted) return;
      const rows = getUnexpandedMemoryRows(db, IN_FLIGHT_CAP, after);
      if (rows.length === 0) return;
      after = rows[rows.length - 1];

      const outcomes = await Promise.all(rows.map(r => this.backfillOne(db, r.id, signal)));
      if (signal.aborted) return;

      const allFailed = outcomes.every(o => o === 'failed');
      consecutiveFailures = allFailed ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log('[MemoryService] Backfill stopped after %d consecutive failed batches', consecutiveFailures);
        return;
      }

      await new Promise<void>(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  /** Expand + CAS-write one row. 'written' | 'failed' (sub-call failed) | 'skipped' (gone / no terms / CAS lost). */
  private async backfillOne(db: DatabaseInstance, id: string, signal: AbortSignal): Promise<'written' | 'failed' | 'skipped'> {
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    if (!row) return 'skipped';
    const entry = {
      content: row.content,
      ...(row.title ? { title: row.title } : {}),
      tags: JSON.parse(row.tags) as string[],
      ...(row.facts && row.facts !== '[]' ? { facts: JSON.parse(row.facts) as string[] } : {}),
    };
    const { terms, failed } = await expandMemoryTermsWithStatus(entry);
    if (signal.aborted) return 'skipped';
    if (failed) return 'failed';
    if (terms.length === 0) return 'skipped';
    const applied = await this.writeQueue?.run(() =>
      updateSearchTermsIfUnchanged(db, id, terms, row.updated_at),
    );
    return applied ? 'written' : 'skipped';
  }

  private get autoExtractEnabled(): boolean {
    return vscode.workspace.getConfiguration('damocles.memory').get<boolean>('autoExtract.enabled', true);
  }

  private get idleSeconds(): number {
    return vscode.workspace.getConfiguration('damocles.memory').get<number>('autoExtract.idleSeconds', 180);
  }

  private get currentWorkspace(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  /**
   * Persist one completed turn as an extraction candidate (no write when memory/auto-extract is off).
   * No LLM runs here — the row is enqueued and the idle timer armed for a later batch pass.
   */
  enqueueTurnCandidate(args: {
    sessionId: string;
    promptIndex: number;
    userText: string;
    assistantText: string;
    files: string[];
  }): void {
    if (this.disposed || !this.isEnabled || !this.autoExtractEnabled) return;
    if (!this.db || !this.writeQueue) {
      // DB not ready: buffer (drop-oldest at the cap), replayed at end of init, then kick init off.
      if (this.pendingTurnCandidates.length >= MAX_PENDING_TURN_CANDIDATES) {
        this.pendingTurnCandidates.shift();
      }
      this.pendingTurnCandidates.push(args);
      void this.ensureInitialized();
      return;
    }

    this.persistTurnCandidate(this.db, args).then(() => {
      if (this.disposed) return;
      this.armIdleTimer();
      this.broadcastPendingCount();
    }).catch(err => log('[MemoryService] Turn-candidate persist failed: %O', err));
  }

  /** Insert one turn candidate through the write queue. Shared by the live path and the init replay. */
  private persistTurnCandidate(db: DatabaseInstance, args: TurnCandidate): Promise<void> {
    if (!this.writeQueue) return Promise.resolve();
    return this.writeQueue.run(() => {
      db.prepare(
        `INSERT INTO memory_candidates (id, session_id, prompt_index, user_text, assistant_text, files, salient, consumed, reprocessed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`,
      ).run(
        crypto.randomUUID(),
        args.sessionId,
        args.promptIndex,
        args.userText,
        args.assistantText,
        JSON.stringify(args.files),
        Date.now(),
      );
    });
  }

  /** Public entry for the session-switch trigger: consolidate one outgoing session's candidates. */
  async consolidateSession(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    await this.runConsolidation({ reason: 'switch', sessionId });
  }

  private armIdleTimer(): void {
    if (this.disposed || !this.isEnabled || !this.autoExtractEnabled) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.runConsolidation({ reason: 'idle' }).catch(err =>
        log('[MemoryService] Idle consolidation failed: %O', err),
      );
    }, this.idleTimerDelayMs());
  }

  /**
   * Idle-timer delay: the configured base window, growing geometrically (`base * 2^failures`, capped
   * at {@link IDLE_BACKOFF_MAX_MS}) on a run of failed/released passes so a released batch is always
   * retried on a timer without a persistent failure busy-looping.
   */
  private idleTimerDelayMs(): number {
    const baseDelay = Math.max(0, this.idleSeconds) * 1000;
    const failures = this.consecutiveConsolidationFailures;
    if (failures <= 0) return baseDelay;
    // Floor the backoff branch so idleSeconds=0 can't collapse the retry to a 0ms busy-loop.
    const flooredBase = Math.max(baseDelay, this.IDLE_BACKOFF_MIN_MS);
    return Math.min(this.IDLE_BACKOFF_MAX_MS, flooredBase * 2 ** failures);
  }

  private runConsolidation(opts: { reason: ConsolidationReason; sessionId?: string; forceExtract?: boolean }): Promise<void> {
    const manual = opts.forceExtract === true;

    // The handler already guards isEnabled and shows memoryError, so stay silent here.
    if (!this.isEnabled) return Promise.resolve();

    // Not initialized: a manual run surfaces a visible failed/unavailable result; background passes
    // stay silent and retry on the next idle timer.
    if (!this.db || !this.writeQueue || !this.runner || !this.factGraph || !this.profileManager) {
      if (manual) this.emitTerminalResult(this.buildUnavailableResult('manual'));
      return Promise.resolve();
    }
    if (this.consolidating) {
      this.pendingConsolidation = mergePendingConsolidation(this.pendingConsolidation, {
        reason: opts.reason,
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        ...(opts.forceExtract !== undefined ? { forceExtract: opts.forceExtract } : {}),
      });
      return this.consolidationInFlight ?? Promise.resolve();
    }

    const db = this.db;
    const writeQueue = this.writeQueue;
    const runner = this.runner;
    const factGraph = this.factGraph;
    const profileManager = this.profileManager;
    const trigger: ConsolidationTrigger = manual ? 'manual' : 'auto';
    this.consolidating = true;
    this.currentPhaseEvents = [];

    this.consolidationBroadcast?.({ type: 'consolidationRunning', running: true });

    const work = (async () => {
      try {
        // runConsolidation is total (returns a terminal result, never throws). This wrapper owns the
        // lifecycle: it broadcasts the phase stream + result before flipping running:false so the two
        // channels cannot desync.
        const result = await runConsolidation({
          db,
          writeQueue,
          runner,
          factGraph,
          profileManager,
          instanceId: this.instanceId,
          reason: opts.reason,
          ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
          workspace: this.currentWorkspace,
          autoExtractEnabled: manual || this.autoExtractEnabled,
          trigger,
          // Skip the pass if the service disposed between scheduling and execution, so it never
          // touches the DB after teardown.
          isDisposed: () => this.disposed,
          onNoModel: () => {
            // Only toast for a manual "Run now". Background passes routinely fire before the sub-call
            // provider is wired and retry on the next timer, so a toast there is a false alarm; the
            // manual run still gets its overlay failure card regardless.
            if (!manual || this.extractionPausedNotified) return;
            this.extractionPausedNotified = true;
            void vscode.window.showWarningMessage(
              'Damocles memory: extraction paused — no model available.',
            );
          },
          onPhase: (event: ConsolidationPhaseEvent) => {
            this.currentPhaseEvents.push(event);
            this.consolidationBroadcast?.({ type: 'consolidationProgress', event });
          },
        });
        this.emitTerminalResult(result);

        // A `failed` terminal means the batch was released back to consumed=0. Bump the failure
        // counter and re-arm the idle timer (which reads it for backoff) so the batch re-enters a
        // later pass; any non-failed pass resets it. Guarded by `disposed` so teardown never re-arms.
        if (!this.disposed) {
          if (result.status === 'failed') {
            this.consecutiveConsolidationFailures += 1;
            this.armIdleTimer();
          } else {
            this.consecutiveConsolidationFailures = 0;
          }
        }
      } finally {
        this.consolidating = false;
        this.consolidationInFlight = null;
        this.currentPhaseEvents = [];
        this.broadcastPendingCount();
        this.consolidationBroadcast?.({ type: 'consolidationRunning', running: false });
      }

      const pending = this.pendingConsolidation;
      if (pending) {
        this.pendingConsolidation = null;
        await this.runConsolidation(pending);
      }
    })();

    this.consolidationInFlight = work;
    return work;
  }

  dispose(): void {
    this.disposed = true;
    this.backfillAbort?.abort();
    this.backfillAbort = null;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.startJitterTimer) {
      clearTimeout(this.startJitterTimer);
      this.startJitterTimer = null;
    }
    this.fileChangeTracker?.dispose();
    this.fileChangeTracker = null;
    this.injectionManager?.closeInjectionDatabases();
    clearExpansionCache();

    const closeDb = (): void => {
      if (!this.db) return;
      try {
        this.db.close();
      } catch (err) {
        log('[MemoryService] Database close failed: %O', err);
      } finally {
        this.db = null;
      }
    };

    const writeQueue = this.writeQueue;
    const inFlight = this.consolidationInFlight;
    const settled = inFlight ? inFlight.catch(() => undefined) : Promise.resolve();
    const drained = writeQueue ? settled.then(() => writeQueue.drain()) : settled;
    void drained.finally(closeDb);
    this._initPromise = null;
  }
}
