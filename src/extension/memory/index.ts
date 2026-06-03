import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { log } from '../logger';
import { openDatabaseAsync, initSqlEngineAsync, updateSearchTerms, getUnexpandedMemoryIds } from './database';
import { expandMemoryTerms, clearExpansionCache } from './query-expansion';
import { SessionMemoryManager } from './managers/session-memory-manager';
import { ProjectMemoryManager } from './managers/project-memory-manager';
import { GlobalMemoryManager } from './managers/global-memory-manager';
import { NoteManager } from './managers/note-manager';
import { ObservationManager } from './managers/observation-manager';
import { RetrievalManager } from './managers/retrieval-manager';
import { InjectionManager } from './managers/injection-manager';
import { FileChangeTracker } from './managers/file-change-tracker';
import { FactGraphManager } from './managers/fact-graph-manager';
import { ProfileManager } from './managers/profile-manager';
import { MemoryWriteQueue } from './write-queue';
import { createMemorySubCallRunner, type MemorySubCallRunner } from './subcall-runner';
import { runConsolidation, type ConsolidationReason } from './consolidation';
import type { ConsolidationExtractedMemory, ConsolidationResult, PendingConsolidationCandidate } from '@shared/types/consolidation';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { insertWithDedup, type NewMemoryFields } from './dedup-decay';
import { createMemoryMcpServer } from './mcp-server';
import type { DatabaseInstance, MemoryRow } from './types';
import { rowToEntry } from './types';
import { buildFtsMatchQuery } from '../shared/text-tokenize';
import type { EdgeKind } from './managers/fact-graph-manager';
import type {
  MemoryEntry,
  MemoryScope,
  ObservationInput,
  SearchQuery,
  SearchResult,
  UserProfile,
} from '@shared/types/memory';
import type { MemoryInjectionDisplay } from '@shared/types/context-injection';
import type { SubCallBridgeCtx } from '../auth/sub-call-env';
import type { ExploreProviderConfig } from '../explore';

export class MemoryService {
  private db: DatabaseInstance | null = null;
  private _initFailed = false;
  private _extensionPath: string;
  private _initPromise: Promise<void> | null = null;
  private sessionManager: SessionMemoryManager | null = null;
  private projectManager: ProjectMemoryManager | null = null;
  private globalManager: GlobalMemoryManager | null = null;
  private noteManager: NoteManager | null = null;
  private observationManager: ObservationManager | null = null;
  private retrievalManager: RetrievalManager | null = null;
  private injectionManager: InjectionManager | null = null;
  private fileChangeTracker: FileChangeTracker | null = null;
  private mcpModules: { createSdkMcpServer: typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer; tool: typeof import('@anthropic-ai/claude-agent-sdk').tool; z: typeof import('zod').z } | null = null;
  private backfillAbort: AbortController | null = null;
  private defaultBridgeCtxProvider: (() => SubCallBridgeCtx | null) | null = null;
  private writeQueue: MemoryWriteQueue | null = null;
  private runner: MemorySubCallRunner | null = null;
  private factGraph: FactGraphManager | null = null;
  private profileManager: ProfileManager | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private exploreConfigProvider: (() => ExploreProviderConfig | null | Promise<ExploreProviderConfig | null>) | null = null;
  private consolidating = false;
  private consolidationInFlight: Promise<void> | null = null;
  private pendingConsolidation: { reason: ConsolidationReason; sessionId?: string } | null = null;
  private extractionPausedNotified = false;
  private consolidationBroadcast: ((msg: ExtensionToWebviewMessage) => void) | null = null;
  private lastConsolidationResult: ConsolidationResult | null = null;
  private disposed = false;

  constructor(extensionPath: string) {
    this._extensionPath = extensionPath;
  }

  /**
   * Register a default bridge ctx that Memory's background expansion tasks (backfill,
   * on-store search-term generation) use when no panel ctx is otherwise available.
   * Passes through to expandMemoryTerms so OpenAI-only setups route through the bridge
   * instead of falling back to Anthropic.
   */
  setDefaultBridgeCtxProvider(provider: () => SubCallBridgeCtx | null): void {
    this.defaultBridgeCtxProvider = provider;
  }

  /**
   * Register the provider that resolves the Explore third-party config for memory sub-calls.
   * Mirrors {@link setDefaultBridgeCtxProvider}; consumed by the sub-call runner when the
   * `damocles.memory.subcallEngine` setting selects the Explore engine.
   */
  setExploreConfigProvider(provider: () => ExploreProviderConfig | null | Promise<ExploreProviderConfig | null>): void {
    this.exploreConfigProvider = provider;
  }

  /**
   * Register the sink that broadcasts consolidation activity (live trace events + pending count) to
   * every open panel. Consolidation is global/background, so this goes through `PanelManager.broadcast`.
   */
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
    await this.runConsolidation({ reason: 'manual', forceExtract: true });
  }

  private broadcastPendingCount(): void {
    this.consolidationBroadcast?.({ type: 'consolidationPendingCount', count: this.getPendingCount() });
  }

  private resolveDefaultBridgeCtx(): SubCallBridgeCtx | null {
    return this.defaultBridgeCtxProvider?.() ?? null;
  }

  get isEnabled(): boolean {
    return vscode.workspace.getConfiguration('damocles.memory').get<boolean>('enabled', true);
  }

  get database(): DatabaseInstance | null {
    return this.db;
  }

  async ensureInitialized(): Promise<void> {
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
    const sqlReady = await initSqlEngineAsync(this._extensionPath);
    if (!sqlReady) {
      this._initFailed = true;
      log('[MemoryService] SQL engine failed — disabling memory system');
      return;
    }

    this.db = await openDatabaseAsync();
    if (!this.db) {
      this._initFailed = true;
      log('[MemoryService] Database open failed — disabling memory system');
      return;
    }

    this.reclaimStrandedCandidates();

    this.writeQueue = new MemoryWriteQueue();
    this.runner = createMemorySubCallRunner({
      getBridgeCtx: () => this.resolveDefaultBridgeCtx(),
      getExploreConfig: () => this.exploreConfigProvider?.() ?? null,
      getCwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
    });
    this.factGraph = new FactGraphManager(this.db, this.writeQueue, this.runner);
    this.profileManager = new ProfileManager(this.db, this.writeQueue, this.runner);

    this.sessionManager = new SessionMemoryManager(this.db);
    this.projectManager = new ProjectMemoryManager(this.db);
    this.globalManager = new GlobalMemoryManager(this.db);
    this.noteManager = new NoteManager(this.db);
    this.observationManager = new ObservationManager(this.db);
    this.retrievalManager = new RetrievalManager(this.db, this.runner);
    this.injectionManager = new InjectionManager(this.db, this.profileManager, this.runner);
    this.fileChangeTracker = new FileChangeTracker(this.db);
    this.fileChangeTracker.initialize();

    this.startBackfill();

    void this.runConsolidation({ reason: 'start' });
  }

  /**
   * Releases candidates a previous process claimed (`consumed = 1`) but never committed
   * (`reprocessed = 0`) — i.e. stranded by a crash mid-extraction — so they re-enter the next
   * consolidation pass instead of being pruned unprocessed. Safe at init: no pass is in-flight yet.
   */
  private reclaimStrandedCandidates(): void {
    if (!this.db) return;
    const result = this.db
      .prepare('UPDATE memory_candidates SET consumed = 0 WHERE consumed = 1 AND reprocessed = 0')
      .run();
    if (result.changes > 0) {
      log('[MemoryService] Reclaimed %d stranded extraction candidate(s) from a prior crash', result.changes);
    }
  }

  addSessionMemory(sessionId: string, content: string, tags?: string[]): MemoryEntry | null {
    const result = this.sessionManager?.add(sessionId, content, tags) ?? null;
    if (result) this._expandSearchTerms(result.id, { content, ...(tags ? { tags } : {}) });
    return result;
  }

  addProjectMemory(workspace: string, content: string, tags?: string[]): MemoryEntry | null {
    const result = this.projectManager?.add(workspace, content, tags) ?? null;
    if (result) this._expandSearchTerms(result.id, { content, ...(tags ? { tags } : {}) });
    return result;
  }

  addGlobalMemory(content: string, tags?: string[]): MemoryEntry | null {
    const result = this.globalManager?.add(content, tags) ?? null;
    if (result) this._expandSearchTerms(result.id, { content, ...(tags ? { tags } : {}) });
    return result;
  }

  addNote(content: string, tags?: string[]): MemoryEntry | null {
    const result = this.noteManager?.add(content, tags) ?? null;
    if (result) this._expandSearchTerms(result.id, { content, ...(tags ? { tags } : {}) });
    return result;
  }

  getObservationCount(workspace: string): number {
    return this.observationManager?.countForWorkspace(workspace) ?? 0;
  }

  getObservationPage(workspace: string, offset: number, limit: number = 20): { entries: MemoryEntry[]; hasMore: boolean } {
    if (!this.db || !this.observationManager) return { entries: [], hasMore: false };
    const entries = this.observationManager.getRecentForWorkspace(workspace, limit, offset);
    const total = this.observationManager.countForWorkspace(workspace);
    return { entries, hasMore: offset + entries.length < total };
  }

  /**
   * Explicitly store a durable fact/preference/episode with the correct kind + scope, routed through
   * the same dedup + conflict-resolution path as auto-extraction (so an exact duplicate strengthens
   * source_count, and a contradicting fact/preference supersedes the older version).
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

    const fields: NewMemoryFields = {
      kind: args.kind,
      scope: args.scope,
      content: args.content,
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
        content: args.content,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
      });
    }

    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  /**
   * Live memory-graph rows (fact/preference/episode/note) for the panel — one consistent query that
   * surfaces global preferences and excludes superseded versions. Forgotten rows are included so the
   * panel's "show forgotten" toggle can reveal them client-side. Observations load via the paginated
   * {@link getObservationPage}, so they are excluded here.
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

  updateMemory(id: string, content: string, tags?: string[]): MemoryEntry | null {
    if (!this.db) return null;
    const now = Date.now();
    this.db.prepare(
      'UPDATE memories SET content = ?, tags = ?, updated_at = ? WHERE id = ?'
    ).run(content, JSON.stringify(tags ?? []), now, id);

    this.fileChangeTracker?.resetStaleness(id);

    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    if (!row) return null;
    this._expandSearchTerms(id, { content, ...(tags ? { tags } : {}) });
    return rowToEntry(row);
  }

  resetObservationStaleness(id: string): boolean {
    if (!this.db) return false;
    return this.fileChangeTracker?.resetStaleness(id) ?? false;
  }

  deleteMemory(id: string): boolean {
    if (!this.db) return false;
    const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    if (result.changes > 0) {
      this.fileChangeTracker?.removeObservation(id);
      this.db.prepare('DELETE FROM memory_retrievals WHERE memory_id = ?').run(id);
    }
    return result.changes > 0;
  }

  listNotes(tags?: string[]): MemoryEntry[] {
    return this.noteManager?.list(tags) ?? [];
  }

  /** Manual save: a direct insert (content_hash already set); dedup/conflict resolution apply only on the auto-extraction path. */
  addObservation(sessionId: string, workspace: string, input: ObservationInput): MemoryEntry | null {
    const result = this.observationManager?.addRichObservation(sessionId, workspace, input) ?? null;
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

  getMemoryDetails(ids: string[]): MemoryEntry[] {
    return this.retrievalManager?.getDetails(ids) ?? [];
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
   * Forget a memory by id or by content match. `chain` (default) forgets every version
   * sharing the resolved row's root so an older version cannot resurface; `version` forgets
   * only the resolved row. Resolution: exact id match first, else top FTS hit over live rows.
   */
  forgetMemory(
    idOrContent: string,
    scope: 'version' | 'chain',
  ): Promise<{ forgotten: number; target?: { title: string | null; snippet: string } }> {
    const db = this.db;
    const factGraph = this.factGraph;
    const writeQueue = this.writeQueue;
    if (!db || !factGraph || !writeQueue) return Promise.resolve({ forgotten: 0 });

    return writeQueue.run(() => {
      const targetId = this.resolveForgetTarget(db, idOrContent);
      if (!targetId) return { forgotten: 0 };

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
                "UPDATE memories SET forgotten = 1, forget_reason = 'user_forget' WHERE root_id = (SELECT root_id FROM memories WHERE id = ?)",
              )
              .run(targetId);

      const forgotten = result.changes;
      if (forgotten === 0 || !resolved) return { forgotten };
      return { forgotten, target: { title: resolved.title, snippet: resolved.content.slice(0, 80) } };
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
                'UPDATE memories SET forgotten = 0, forget_reason = NULL WHERE root_id = (SELECT root_id FROM memories WHERE id = ?)',
              )
              .run(id);
      return { restored: result.changes };
    });
  }

  /** Read the user profile (static + dynamic) for the panel's profile editor. */
  getProfile(scope: 'project' | 'global', workspace: string): UserProfile {
    return this.profileManager?.getProfile(scope, workspace) ?? { static: '', dynamic: '' };
  }

  /** Persist an edited profile section from the panel. Resolves once the upsert commits. */
  setProfileSection(scope: 'project' | 'global', workspace: string, section: 'static' | 'dynamic', content: string): Promise<void> {
    return this.profileManager?.setProfileSection(scope, workspace, section, content) ?? Promise.resolve();
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

  migrateSessionId(oldId: string, newId: string): void {
    if (!this.db) return;
    this.db.prepare('UPDATE memories SET session_id = ? WHERE session_id = ?').run(newId, oldId);
    this.db.prepare('UPDATE memory_candidates SET session_id = ? WHERE session_id = ?').run(newId, oldId);
  }

  deleteSessionMemories(sessionId: string): void {
    if (this.db) {
      this.db.prepare(
        "DELETE FROM memory_retrievals WHERE memory_id IN (SELECT id FROM memories WHERE session_id = ? AND scope = 'session')"
      ).run(sessionId);
    }
    this.sessionManager?.deleteBySession(sessionId);
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

  pinMemory(id: string): boolean {
    return this.injectionManager?.pinMemory(id) ?? false;
  }

  unpinMemory(id: string): boolean {
    return this.injectionManager?.unpinMemory(id) ?? false;
  }

  recordRetrievals(ids: string[], workspace: string): void {
    this.injectionManager?.recordRetrievals(ids, workspace);
  }

  async persistMemoryInjection(sessionId: string, promptIndex: number, display: MemoryInjectionDisplay): Promise<void> {
    await this.injectionManager?.persistInjection(sessionId, promptIndex, display);
  }

  async getPersistedMemoryInjection(sessionId: string, promptIndex: number): Promise<MemoryInjectionDisplay | undefined> {
    return await this.injectionManager?.getPersistedInjection(sessionId, promptIndex);
  }

  getMcpServerConfig(getSessionId: () => string, workspace: string): unknown {
    if (!this.isEnabled) return null;

    try {
      if (!this.mcpModules) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sdk = require('@anthropic-ai/claude-agent-sdk') as typeof import('@anthropic-ai/claude-agent-sdk');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const zod = require('zod') as typeof import('zod');
        this.mcpModules = { createSdkMcpServer: sdk.createSdkMcpServer, tool: sdk.tool, z: zod.z };
      }
      const { createSdkMcpServer, tool, z } = this.mcpModules;
      return createMemoryMcpServer(
        this, createSdkMcpServer, tool, z, getSessionId, workspace
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[MemoryService] Failed to create MCP server: ${message}`);
      return null;
    }
  }

  private _expandSearchTerms(id: string, entry: { content: string; title?: string; tags?: string[]; facts?: string[] }): void {
    if (!this.db) return;
    expandMemoryTerms(entry, this.resolveDefaultBridgeCtx()).then(terms => {
      if (terms.length === 0) return;
      return this.writeQueue?.run(() => {
        if (this.db) updateSearchTerms(this.db, id, terms);
      });
    }).catch(err => {
      log('[MemoryService] Search term expansion failed for %s: %O', id, err);
    });
  }

  private startBackfill(): void {
    if (!this.db) return;
    const db = this.db;
    this.backfillAbort = new AbortController();
    const signal = this.backfillAbort.signal;

    const ids = getUnexpandedMemoryIds(db, 100);
    if (ids.length === 0) return;
    log('[MemoryService] Backfilling search terms for %d memories', ids.length);

    const BATCH_SIZE = 5;
    const BATCH_DELAY_MS = 3000;
    const MAX_CONSECUTIVE_FAILURES = 3;
    let consecutiveFailures = 0;

    const processBatch = (startIndex: number) => {
      if (signal.aborted || startIndex >= ids.length) return;

      const batch = ids.slice(startIndex, startIndex + BATCH_SIZE);

      Promise.allSettled(batch.map(id => {
        const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as import('./types').MemoryRow | undefined;
        if (!row) return Promise.resolve();
        const entry = {
          content: row.content,
          ...(row.title ? { title: row.title } : {}),
          tags: JSON.parse(row.tags) as string[],
          ...(row.facts && row.facts !== '[]' ? { facts: JSON.parse(row.facts) as string[] } : {}),
        };
        return expandMemoryTerms(entry, this.resolveDefaultBridgeCtx()).then(terms => {
          if (signal.aborted || terms.length === 0) return;
          return this.writeQueue?.run(() => updateSearchTerms(db, id, terms));
        });
      })).then(results => {
        if (signal.aborted) return;

        const batchFailed = results.every(r => r.status === 'rejected');
        if (batchFailed) {
          consecutiveFailures++;
        } else {
          consecutiveFailures = 0;
        }

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          log('[MemoryService] Backfill stopped after %d consecutive failures', consecutiveFailures);
          return;
        }

        setTimeout(() => processBatch(startIndex + BATCH_SIZE), BATCH_DELAY_MS);
      });
    };

    processBatch(0);
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
   * Persist one completed turn as an extraction candidate (D6 gate first: no DB write when memory
   * or auto-extraction is off). No LLM runs here — the row is enqueued and the idle timer armed so
   * a batch consolidation fires after the conversation goes quiet.
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
      void this.ensureInitialized();
      log('[MemoryService] Turn candidate dropped — DB not yet initialized; init kicked off for subsequent turns');
      return;
    }

    const db = this.db;
    void this.writeQueue
      .run(() => {
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
      })
      .then(() => {
        if (this.disposed) return;
        this.armIdleTimer();
        this.broadcastPendingCount();
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
      void this.runConsolidation({ reason: 'idle' });
    }, Math.max(0, this.idleSeconds) * 1000);
  }

  /**
   * Folds a request that arrived mid-pass into the single pending slot, preserving its
   * `{reason, sessionId}` when it matches what is already queued. When two requests target
   * different sessions a single session-scoped follow-up cannot cover both, so it broadens to a
   * global `idle` pass — which claims ALL unconsumed candidates and thus covers either request.
   */
  private mergePendingConsolidation(
    existing: { reason: ConsolidationReason; sessionId?: string } | null,
    incoming: { reason: ConsolidationReason; sessionId?: string },
  ): { reason: ConsolidationReason; sessionId?: string } {
    if (!existing) return incoming;
    if (existing.sessionId === incoming.sessionId) return existing;
    return { reason: 'idle' };
  }

  private runConsolidation(opts: { reason: ConsolidationReason; sessionId?: string; forceExtract?: boolean }): Promise<void> {
    if (!this.isEnabled || !this.db || !this.writeQueue || !this.runner || !this.factGraph || !this.profileManager) {
      return Promise.resolve();
    }
    if (this.consolidating) {
      this.pendingConsolidation = this.mergePendingConsolidation(this.pendingConsolidation, {
        reason: opts.reason,
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      });
      return this.consolidationInFlight ?? Promise.resolve();
    }

    const db = this.db;
    const writeQueue = this.writeQueue;
    const runner = this.runner;
    const factGraph = this.factGraph;
    const profileManager = this.profileManager;
    this.consolidating = true;

    this.consolidationBroadcast?.({ type: 'consolidationRunning', running: true });

    const work = (async () => {
      try {
        await runConsolidation({
          db,
          writeQueue,
          runner,
          factGraph,
          profileManager,
          reason: opts.reason,
          ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
          workspace: this.currentWorkspace,
          autoExtractEnabled: opts.forceExtract === true || this.autoExtractEnabled,
          onNoModel: () => {
            if (this.extractionPausedNotified) return;
            this.extractionPausedNotified = true;
            void vscode.window.showWarningMessage(
              'Damocles memory: auto-extraction paused — no model available.',
            );
          },
          onResult: (extracted: ConsolidationExtractedMemory[]) => {
            const result: ConsolidationResult = { ranAt: Date.now(), extracted };
            this.lastConsolidationResult = result;
            this.consolidationBroadcast?.({ type: 'consolidationResult', result });
          },
        });
      } finally {
        this.consolidating = false;
        this.consolidationInFlight = null;
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
