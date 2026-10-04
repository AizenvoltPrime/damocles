import type { SettingsStore } from '../../../platform/settings-store';
import type { NotificationService } from '../../../platform/notification-service';
import { notifySchemaAhead } from '../../schema-skew';
import type { MemoryEntry } from '@shared/types/memory';
import type {
  CarriedMemory,
  InjectedMemory,
  InjectionReason,
  InjectionTier,
  MemoryInjectionDisplay,
  MemoryNotice,
  MemoryScoreBreakdown,
} from '@shared/types/context-injection';
import type { DatabaseInstance, MemoryRow } from '../types';
import { rowToEntry } from '../types';
import { log } from '../../logger';
import { extractMemoryIds, queryTerms, quoteFtsTerm, stripEnglishClitics } from '../text-tokenize';
import {
  openInjectionDatabase,
  insertMemoryInjection,
  getMemoryInjection as getPersistedMemoryInjection,
  deleteInjectionDatabaseFile,
  renameInjectionDatabaseFile,
  sweepStaleInjectionDatabases,
  injectionDbName,
  injectionDatabaseExists,
  listMemoryInjectionsBelow,
  insertMemoryInjectionRows,
  type InjectionDatabase,
} from '../injection-database';
import { estimateTokens, truncateToChars } from '../token-estimate';
import type { ProfileManager } from './profile-manager';
import type { MemorySubCallRunner } from '../subcall-runner';
import { LLM_RERANK_MIN_MS, RERANK_QUERY_CHARS, classifierRerank } from '../classifier-judges';
import type { ContextInjectionDetailsV1, LiveInjections, LiveMemory } from '../injection/details';
import { QUALITY_AUDIT_FORGET_REASON } from '@shared/types/memory-audit';
import { isStaleMemory } from '@shared/memory-staleness';
import {
  BUDGETS,
  DEFAULT_TIER_LIMITS,
  FILE_PROXIMITY_FULL,
  analyzeTerms,
  assignTiers,
  compareRank,
  fileProximityMatcher,
  normalizeFileFields,
  evaluateLexical,
  splitTypedPaths,
  scoreGatedEntry,
  type LexicalMatch,
  type TierCandidate,
} from '../injection/gate';
import {
  joinInjectionParts,
  noticeText,
  renderCompactLine,
  renderFull,
  renderMemoryBlock,
  renderNotice,
  type NoticeRender,
  type RenderableMemory,
} from '../injection/render';

type RerankRelevance = 'high' | 'medium' | 'low';

const RELEVANCE_RANK: Record<RerankRelevance, number> = { high: 3, medium: 2, low: 1 };

/** Ungraded entries sort between medium and low, so an entry the model skipped keeps its standing. */
const RERANK_SORT_WEIGHT: Record<RerankRelevance, number> = { high: 3, medium: 2, low: 0 };
const UNGRADED_SORT_WEIGHT = 1;
function rerankSortWeight(relevance: RerankRelevance | undefined): number {
  return relevance === undefined ? UNGRADED_SORT_WEIGHT : RERANK_SORT_WEIGHT[relevance];
}

interface InjectRerankResult {
  results: Array<{ id: string; relevance: RerankRelevance; reason?: string }>;
}

/** `reason` comes from the LLM rerank, `classifierScore` (0..1) from Jev. */
interface RerankGrade {
  relevance: RerankRelevance;
  reason?: string;
  classifierScore?: number;
}

/** The runner's `T` is an unvalidated cast; a hallucinated shape would throw at `value.results`. */
function isInjectRerankResult(v: unknown): v is InjectRerankResult {
  return (
    !!v &&
    typeof v === 'object' &&
    Array.isArray((v as { results?: unknown }).results) &&
    (v as { results: unknown[] }).results.every(
      (r) => !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string',
    )
  );
}

const INJECT_RERANK_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          relevance: { enum: ['high', 'medium', 'low'] },
          reason: { type: 'string' },
        },
        required: ['id', 'relevance'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} satisfies Record<string, unknown>;

const INJECT_RERANK_SYSTEM_PROMPT =
  'Grade how relevant each candidate memory is to the user query. ' +
  'Return every candidate id exactly once with a relevance of high, medium, or low ' +
  'and a brief reason. Judge by semantic relevance, not keyword overlap.';

function getConfig<T>(settings: SettingsStore, key: string, fallback: T): T {
  return settings.get<T>(`damocles.memory.${key}`, fallback) ?? fallback;
}

interface InjectionConfig {
  fullLimit: number;
  compactLimit: number;
  tokenBudget: number;
  pinnedTokenBudget: number;
  profileTokenBudget: number;
  profileEnabled: boolean;
  rerankBlocking: boolean;
}

export interface NumberSetting {
  key: string;
  fallback: number;
  min: number;
  max?: number;
  integer?: boolean;
}

/** The ranges `package.json` declares for these `damocles.memory.*` keys; `injection.test.ts` pins them equal. */
export const INJECTION_NUMBER_SETTINGS: Readonly<
  Record<'fullLimit' | 'compactLimit' | 'tokenBudget' | 'pinnedTokenBudget' | 'profileTokenBudget', NumberSetting>
> = {
  fullLimit: { key: 'injection.fullEntryLimit', fallback: DEFAULT_TIER_LIMITS.full, min: 0, max: 10, integer: true },
  compactLimit: { key: 'injection.compactEntryLimit', fallback: DEFAULT_TIER_LIMITS.compact, min: 0, max: 20, integer: true },
  tokenBudget: { key: 'catalogTokenBudget', fallback: DEFAULT_TIER_LIMITS.tokenBudget, min: 500, max: 8000 },
  pinnedTokenBudget: { key: 'pinnedTokenBudget', fallback: 500, min: 100, max: 2000 },
  profileTokenBudget: { key: 'profile.tokenBudget', fallback: 600, min: 50, integer: true },
};

/** VS Code enforces a setting's declared range only in the settings UI, never on a settings.json value. */
function readNumberSetting(settings: SettingsStore, s: NumberSetting): number {
  const raw = getConfig<unknown>(settings, s.key, s.fallback);
  const value = Math.min(s.max ?? Infinity, Math.max(s.min, typeof raw === 'number' && Number.isFinite(raw) ? raw : s.fallback));
  return s.integer ? Math.floor(value) : value;
}

function readConfig(settings: SettingsStore): InjectionConfig {
  const n = INJECTION_NUMBER_SETTINGS;
  return {
    fullLimit: readNumberSetting(settings, n.fullLimit),
    compactLimit: readNumberSetting(settings, n.compactLimit),
    tokenBudget: readNumberSetting(settings, n.tokenBudget),
    pinnedTokenBudget: readNumberSetting(settings, n.pinnedTokenBudget),
    profileTokenBudget: readNumberSetting(settings, n.profileTokenBudget),
    profileEnabled: getConfig(settings, 'profile.enabled', true),
    rerankBlocking: getConfig<'off' | 'blocking'>(settings, 'rerank.injectMode', 'off') === 'blocking',
  };
}

const MERGED_FORGET_REASON = 'merged';
/** A direct forget or an applied audit proposal: the only reasons a notice may say the user forgot a memory. */
const USER_FORGET_REASONS: ReadonlySet<string | null> = new Set(['user_forget', QUALITY_AUDIT_FORGET_REASON]);

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const RERANK_CANDIDATE_CAP = 30;
const RERANK_TIMEOUT_MS = 2000;
const RERANK_SNIPPET_CHARS = 160;
const SNIPPET_CHARS = 160;
const MAX_MENTIONED = 10;
const SESSION_CANDIDATE_LIMIT = 50;
const PREFERENCE_CANDIDATE_LIMIT = 100;
const SQL_CHUNK = 500;

/**
 * Sentinel `workspace` bucket for global-scoped retrievals: global memories surface in every
 * workspace, so their counts are recorded here and unioned in when scoring anywhere.
 */
const GLOBAL_RETRIEVAL_WORKSPACE = '__damocles_global_scope__';

/**
 * Column filters for the gate's FTS queries. Lexical matching and its df statistics read only the
 * memory's own text: `search_terms`, `tags` and `summary` are model-generated and would match synonyms
 * the memory never states. The file gate reads the columns `normalizeFileFields` confirms against.
 */
const GATE_COLUMNS = '{content title facts}';
const FILE_COLUMNS = '{content files_read files_modified}';

const LIVE_TAIL = `AND m.kind != 'note' AND (m.forget_after IS NULL OR m.forget_after >= ?)`;

/**
 * Live, non-note rows this session can see, one arm per scope so each uses its own index (`+` keeps
 * the planner off `idx_memories_live` for the global and session arms). Params: workspace, now,
 * now, sessionId, now.
 */
const VISIBLE_SQL = `SELECT m.rowid AS rowid, m.id AS id, m.kind AS kind, m.scope AS scope FROM memories m
  WHERE m.is_latest = 1 AND m.forgotten = 0 AND m.workspace = ? AND m.scope = 'project' ${LIVE_TAIL}
UNION ALL SELECT m.rowid, m.id, m.kind, m.scope FROM memories m
  WHERE m.scope = 'global' AND +m.is_latest = 1 AND +m.forgotten = 0 ${LIVE_TAIL}
UNION ALL SELECT m.rowid, m.id, m.kind, m.scope FROM memories m
  WHERE m.session_id = ? AND m.scope = 'session' AND +m.is_latest = 1 AND +m.forgotten = 0 ${LIVE_TAIL}`;

export interface BuildInjectionArgs {
  sessionId: string | null;
  workspace: string;
  activeFile: string | null;
  prompt: string;
  live: LiveInjections;
  promptIndex: number;
}

export interface InjectionBuildResult {
  /** Profile plus `<damocles_memory>` block; '' when nothing new is sent. */
  text: string;
  /** Null exactly when `text` is ''. `compassKey` is left null for the caller to fill. */
  details: ContextInjectionDetailsV1 | null;
  display: MemoryInjectionDisplay;
  /** Mentioned ids that resolved to a memory; they count as retrievals. */
  mentionedIds: string[];
}

type StoreCounts = MemoryInjectionDisplay['storeCounts'];

interface VisibleRow {
  id: string;
  kind: string;
  scope: string;
}

function storeCountsOf(visible: ReadonlyMap<number, VisibleRow>): StoreCounts {
  const counts: StoreCounts = { session: 0, project: 0, global: 0, observations: 0, total: 0 };
  for (const v of visible.values()) {
    const bucket = v.kind === 'observation' ? 'observations' : v.scope;
    if (bucket === 'session' || bucket === 'project' || bucket === 'global' || bucket === 'observations') {
      counts[bucket]++;
      counts.total++;
    }
  }
  return counts;
}

interface Loaded {
  row: MemoryRow;
  entry: MemoryEntry;
}

interface Selected {
  loaded: Loaded;
  tier: InjectionTier;
  reasons: InjectionReason[];
  score: number | null;
  breakdown: MemoryScoreBreakdown | null;
  upgradedFromCompact: boolean;
  text: string;
  truncated: boolean;
  tokens: number;
  /** A forgotten memory rendered because the prompt names it; not tracked as in context. */
  forgottenMention: boolean;
  rerankRelevance?: RerankRelevance;
  rerankReason?: string;
  rerankClassifierScore?: number;
}

interface GatedCandidate {
  loaded: Loaded;
  lexical: LexicalMatch;
  fileReasons: Array<{ path: string; source: 'editor' | 'prompt' }>;
  liveCompact: boolean;
  score: number;
  breakdown: MemoryScoreBreakdown;
  fullAllowed: boolean;
  rerankRelevance?: RerankRelevance;
  rerankReason?: string;
  rerankClassifierScore?: number;
}

function toLoaded(row: MemoryRow): Loaded {
  return { row, entry: rowToEntry(row) };
}

function lastSegments(filePath: string, count: number): string {
  const segments = normalizePath(filePath).split('/').filter(Boolean);
  return segments.length >= count ? segments.slice(-count).join('/') : '';
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function relativizeFile(file: string, workspace: string): string {
  const f = normalizePath(file);
  const root = normalizePath(workspace);
  if (root && f.toLowerCase().startsWith(root.toLowerCase() + '/')) return f.slice(root.length + 1);
  return f;
}

function entryFiles(entry: MemoryEntry): string[] {
  return [...new Set([...(entry.filesModified ?? []), ...(entry.filesRead ?? [])])];
}

function renderable(entry: MemoryEntry, workspace: string, forgotten = false): RenderableMemory {
  return {
    id: entry.id,
    kind: entry.kind ?? 'fact',
    scope: entry.scope ?? 'project',
    title: entry.title ?? null,
    content: entry.content,
    facts: entry.facts ?? [],
    files: entryFiles(entry).map(f => relativizeFile(f, workspace)),
    observationType: entry.observationType ?? null,
    isStale: isStaleMemory(entry),
    isPinned: !!entry.pinned,
    ...(forgotten ? { isForgotten: true } : {}),
  };
}

function snippet(entry: MemoryEntry): string {
  const source = (entry.kind === 'observation' && entry.title ? entry.title : entry.content).replace(/\s+/g, ' ').trim();
  return truncateToChars(source, SNIPPET_CHARS);
}

function selectFull(
  loaded: Loaded,
  workspace: string,
  reasons: InjectionReason[],
  extra: Partial<Pick<Selected, 'upgradedFromCompact' | 'forgottenMention'>> & { maxChars?: number } = {},
): Selected {
  const rendered = renderFull(renderable(loaded.entry, workspace, extra.forgottenMention === true), extra.maxChars);
  return {
    loaded,
    tier: 'full',
    reasons,
    score: null,
    breakdown: null,
    upgradedFromCompact: extra.upgradedFromCompact ?? false,
    text: rendered.text,
    truncated: rendered.truncated,
    tokens: estimateTokens(rendered.text),
    forgottenMention: extra.forgottenMention ?? false,
  };
}

function toInjectedMemory(s: Selected): InjectedMemory {
  const e = s.loaded.entry;
  return {
    id: e.id,
    scope: e.scope ?? 'project',
    kind: e.kind ?? 'fact',
    title: e.title ?? null,
    content: e.content,
    facts: e.facts ?? [],
    files: entryFiles(e),
    tier: s.tier,
    truncated: s.truncated,
    upgradedFromCompact: s.upgradedFromCompact,
    tokens: s.tokens,
    reasons: s.reasons,
    score: s.score,
    scoreBreakdown: s.breakdown,
    isStale: isStaleMemory(e),
    isPinned: !!e.pinned,
    sourceCount: e.sourceCount ?? 1,
    ...(s.forgottenMention ? { isForgotten: true } : {}),
    ...(s.rerankRelevance ? { rerankRelevance: s.rerankRelevance } : {}),
    ...(s.rerankReason ? { rerankReason: s.rerankReason } : {}),
    ...(s.rerankClassifierScore !== undefined ? { rerankClassifierScore: s.rerankClassifierScore } : {}),
  };
}

/**
 * Owns per-prompt memory injection: a delta against what the session projection already carries,
 * gated for relevance and tiered by rank (docs/invariants.md "Memory injection"). Queries live rows
 * directly, never the per-scope managers, which leak superseded and forgotten rows. Also persists
 * the per-prompt display records.
 */
export class InjectionManager {
  private db: DatabaseInstance;
  private profileManager: ProfileManager;
  private runner: MemorySubCallRunner;
  private injectionDbs = new Map<string, InjectionDatabase>();
  private pendingDbOpens = new Map<string, Promise<InjectionDatabase | undefined>>();
  private disposed = false;

  private readonly settings: SettingsStore;
  private readonly notifications: NotificationService;

  constructor(
    db: DatabaseInstance,
    profileManager: ProfileManager,
    runner: MemorySubCallRunner,
    settings: SettingsStore,
    notifications: NotificationService,
  ) {
    this.db = db;
    this.profileManager = profileManager;
    this.runner = runner;
    this.settings = settings;
    this.notifications = notifications;
  }

  async persistInjection(sessionId: string, promptIndex: number, display: MemoryInjectionDisplay): Promise<void> {
    try {
      const store = await this.getOrOpenInjectionDb(sessionId);
      if (!store || store.readOnly) return;
      insertMemoryInjection(store.db, promptIndex, display);
    } catch (err) {
      log('[InjectionManager] Failed to persist injection for session %s prompt %d: %O', sessionId, promptIndex, err);
    }
  }

  async getPersistedInjection(sessionId: string, promptIndex: number): Promise<MemoryInjectionDisplay | undefined> {
    try {
      const store = await this.getOrOpenInjectionDb(sessionId);
      if (!store) return undefined;
      return getPersistedMemoryInjection(store.db, promptIndex);
    } catch (err) {
      log('[InjectionManager] Failed to retrieve injection for session %s prompt %d: %O', sessionId, promptIndex, err);
      return undefined;
    }
  }

  private async getOrOpenInjectionDb(sessionId: string): Promise<InjectionDatabase | undefined> {
    const existing = this.injectionDbs.get(sessionId);
    if (existing) return existing;

    const pending = this.pendingDbOpens.get(sessionId);
    if (pending) return pending;

    const openPromise = openInjectionDatabase(sessionId).then(store => {
      this.pendingDbOpens.delete(sessionId);
      // Dispose may have run while this open was in flight; caching now would leak an unclosed handle.
      if (store && this.disposed) { try { store.db.close(); } catch { /* ignore */ } return undefined; }
      if (store?.readOnly) notifySchemaAhead(this.notifications, { kind: 'memoryInjection' });
      if (store) this.injectionDbs.set(sessionId, store);
      return store;
    }, err => {
      this.pendingDbOpens.delete(sessionId);
      throw err;
    });
    this.pendingDbOpens.set(sessionId, openPromise);
    return openPromise;
  }

  closeInjectionDatabases(): void {
    this.disposed = true;
    for (const store of this.injectionDbs.values()) {
      try { store.db.close(); } catch { /* ignore close errors */ }
    }
    this.injectionDbs.clear();
    this.pendingDbOpens.clear();
  }

  // Close and drop the live handle so the OS releases the file lock before any fs op (Windows can't
  // delete/rename an open SQLite file). Awaits an in-flight open so it doesn't reopen post-op.
  private async closeAndEvict(sessionId: string): Promise<void> {
    const pending = this.pendingDbOpens.get(sessionId);
    if (pending) {
      try { await pending; } catch { /* open failure already logged */ }
    }
    const store = this.injectionDbs.get(sessionId);
    if (store) {
      try { store.db.close(); } catch { /* ignore close errors */ }
    }
    this.injectionDbs.delete(sessionId);
    this.pendingDbOpens.delete(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.closeAndEvict(sessionId);
    await deleteInjectionDatabaseFile(sessionId);
  }

  async renameSession(oldId: string, newId: string): Promise<void> {
    await this.closeAndEvict(oldId);
    await this.closeAndEvict(newId);
    await renameInjectionDatabaseFile(oldId, newId);
  }

  /**
   * Copy the source session's records for prompts below `belowPromptIndex` into the target session,
   * verbatim. A source with no database or no such rows creates nothing. Returns the rows added.
   */
  async copySessionInjections(sourceId: string, targetId: string, belowPromptIndex: number): Promise<number> {
    if (sourceId === targetId || belowPromptIndex <= 0) return 0;
    const known = this.injectionDbs.has(sourceId) || this.pendingDbOpens.has(sourceId);
    if (!known && !(await injectionDatabaseExists(sourceId))) return 0;
    const source = await this.getOrOpenInjectionDb(sourceId);
    if (!source) return 0;
    const rows = listMemoryInjectionsBelow(source.db, belowPromptIndex);
    if (rows.length === 0) return 0;
    const target = await this.getOrOpenInjectionDb(targetId);
    if (!target || target.readOnly) return 0;
    return insertMemoryInjectionRows(target.db, rows);
  }

  async sweepStaleDatabases(): Promise<void> {
    const swept = await sweepStaleInjectionDatabases();
    if (swept.length === 0) return;
    const sweptNames = new Set(swept);
    for (const sessionId of [...this.injectionDbs.keys()]) {
      if (sweptNames.has(injectionDbName(sessionId))) void this.closeAndEvict(sessionId);
    }
    log('[InjectionManager] Swept %d stale injection database(s)', swept.length);
  }

  pinMemory(id: string): boolean {
    const result = this.db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run(id);
    return result.changes > 0;
  }

  unpinMemory(id: string): boolean {
    const result = this.db.prepare('UPDATE memories SET pinned = 0 WHERE id = ?').run(id);
    return result.changes > 0;
  }

  recordRetrievals(ids: string[], workspace: string): void {
    if (ids.length === 0) return;
    const now = Date.now();

    const placeholders = ids.map(() => '?').join(',');
    const scopeRows = this.db
      .prepare(`SELECT id, scope FROM memories WHERE id IN (${placeholders})`)
      .all(...ids) as { id: string; scope: string }[];
    const scopeById = new Map(scopeRows.map(r => [r.id, r.scope]));

    const stmt = this.db.prepare('INSERT INTO memory_retrievals (memory_id, workspace, retrieved_at) VALUES (?, ?, ?)');
    for (const id of ids) {
      const bucket = scopeById.get(id) === 'global' ? GLOBAL_RETRIEVAL_WORKSPACE : workspace;
      stmt.run(id, bucket, now);
    }
    const cutoff = now - THIRTY_DAYS_MS;
    this.db.prepare('DELETE FROM memory_retrievals WHERE retrieved_at < ?').run(cutoff);
  }

  getRetrievalCounts(workspace: string): Map<string, number> {
    const cutoff = Date.now() - THIRTY_DAYS_MS;

    const rows = this.db.prepare(
      'SELECT memory_id, COUNT(*) as count FROM memory_retrievals WHERE workspace IN (?, ?) AND retrieved_at > ? GROUP BY memory_id'
    ).all(workspace, GLOBAL_RETRIEVAL_WORKSPACE, cutoff) as { memory_id: string; count: number }[];

    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.memory_id, row.count);
    }
    return counts;
  }

  /**
   * One scan of the rows this session can see, keyed by rowid. Everything else filters it in memory,
   * because per-term joins against `memories` read each large row again.
   */
  private loadVisible(now: number, sessionId: string, workspace: string): Map<number, VisibleRow> {
    const rows = this.db.prepare(VISIBLE_SQL).all(workspace, now, now, sessionId, now) as Array<VisibleRow & { rowid: number }>;
    return new Map(rows.map(r => [r.rowid, { id: r.id, kind: r.kind, scope: r.scope }]));
  }

  private loadRows(ids: readonly string[]): Map<string, Loaded> {
    const out = new Map<string, Loaded>();
    for (let i = 0; i < ids.length; i += SQL_CHUNK) {
      const chunk = ids.slice(i, i + SQL_CHUNK);
      const rows = this.db
        .prepare(`SELECT * FROM memories WHERE id IN (${chunk.map(() => '?').join(',')})`)
        .all(...chunk) as MemoryRow[];
      for (const row of rows) out.set(row.id, toLoaded(row));
    }
    return out;
  }

  /**
   * The OR arms use `idx_memories_root` and the primary key; `COALESCE(root_id, id)` cannot, and without
   * `+` the planner walks every live row through `idx_memories_live` instead.
   */
  private chainHead(row: MemoryRow): Loaded | null {
    const root = row.root_id ?? row.id;
    const head = this.db.prepare(
      `SELECT * FROM memories WHERE (root_id = ? OR (root_id IS NULL AND id = ?)) AND +is_latest = 1 AND +forgotten = 0
        ORDER BY updated_at DESC LIMIT 1`,
    ).get(root, root) as MemoryRow | undefined;
    return head ? toLoaded(head) : null;
  }

  /**
   * The row a dedup merge folded `row` into, following merge `SUPERSEDES` edges through later merges.
   * `undefined` when that row no longer exists; null for a merge recorded without an edge.
   */
  private mergeTarget(row: MemoryRow): MemoryRow | undefined | null {
    const seen = new Set<string>();
    let current = row;
    while (current.forgotten === 1 && current.forget_reason === MERGED_FORGET_REASON) {
      if (seen.has(current.id)) return null;
      seen.add(current.id);
      const edge = this.db.prepare(
        `SELECT source_id FROM memory_edges WHERE kind = 'SUPERSEDES' AND target_id = ? ORDER BY created_at DESC LIMIT 1`,
      ).get(current.id) as { source_id: string } | undefined;
      if (!edge) return null;
      const next = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(edge.source_id) as MemoryRow | undefined;
      if (!next) return undefined;
      current = next;
    }
    return current;
  }

  /** The current row a mentioned id stands for: its merge primary, then that row's chain head. */
  private resolveMention(loaded: Loaded): Loaded {
    const merged = loaded.row.forgotten === 1 && loaded.row.forget_reason === MERGED_FORGET_REASON ? this.mergeTarget(loaded.row) : null;
    const row = merged ?? loaded.row;
    const base = row === loaded.row ? loaded : toLoaded(row);
    return row.is_latest === 1 ? base : this.chainHead(row) ?? base;
  }

  /** Visible ids whose FTS index matches `ftsQuery` (a column filter plus a quoted term or phrase). */
  private matchVisible(ftsQuery: string, visible: ReadonlyMap<number, VisibleRow>): Set<string> {
    try {
      const rows = this.db.prepare('SELECT rowid AS r FROM memories_fts WHERE memories_fts MATCH ?').all(ftsQuery) as Array<{ r: number }>;
      const ids = new Set<string>();
      for (const { r } of rows) {
        const v = visible.get(r);
        if (v) ids.add(v.id);
      }
      return ids;
    } catch (err) {
      log('[InjectionManager] FTS query failed for %s: %O', ftsQuery, err);
      return new Set();
    }
  }

  /**
   * Candidate ids for a path: an FTS phrase over its last two segments, which any full-suffix match
   * must contain. Confirmed afterwards by the proximity matcher.
   */
  private fileCandidateIds(filePath: string, visible: ReadonlyMap<number, VisibleRow>): Set<string> {
    const suffix = lastSegments(filePath, 2);
    return suffix ? this.matchVisible(`${FILE_COLUMNS} : ${quoteFtsTerm(suffix)}`, visible) : new Set();
  }

  private loadPinned(sessionId: string, workspace: string): Loaded[] {
    // A user pin overrides decay, so pinned rows skip the `forget_after` predicate.
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE pinned = 1 AND is_latest = 1 AND forgotten = 0
         AND (workspace = ? OR (session_id = ? AND scope = 'session') OR scope = 'global')
       ORDER BY updated_at DESC`,
    ).all(workspace, sessionId) as MemoryRow[];
    return rows.map(toLoaded);
  }

  private loadVisibleWhere(visible: ReadonlyMap<number, VisibleRow>, keep: (v: VisibleRow) => boolean): Loaded[] {
    const ids: string[] = [];
    for (const v of visible.values()) if (keep(v)) ids.push(v.id);
    return [...this.loadRows(ids).values()];
  }

  private loadSessionMemories(visible: ReadonlyMap<number, VisibleRow>): Loaded[] {
    return this.loadVisibleWhere(visible, v => v.scope === 'session')
      .sort((a, b) => b.row.updated_at - a.row.updated_at)
      .slice(0, SESSION_CANDIDATE_LIMIT);
  }

  /**
   * Pinned first, then project before global, then by evidence: how often the preference was
   * re-extracted (`source_count`), how often it was retrieved, and last how recently it changed.
   */
  private loadPreferences(visible: ReadonlyMap<number, VisibleRow>, retrievalCounts: ReadonlyMap<string, number>): Loaded[] {
    const scopeRank = (l: Loaded): number => (l.row.scope === 'project' ? 0 : 1);
    const retrievals = (l: Loaded): number => retrievalCounts.get(l.row.id) ?? 0;
    return this.loadVisibleWhere(visible, v => v.kind === 'preference' && v.scope !== 'session')
      .sort(
        (a, b) =>
          b.row.pinned - a.row.pinned ||
          scopeRank(a) - scopeRank(b) ||
          b.row.source_count - a.row.source_count ||
          retrievals(b) - retrievals(a) ||
          b.row.updated_at - a.row.updated_at,
      )
      .slice(0, PREFERENCE_CANDIDATE_LIMIT);
  }

  /**
   * Build this prompt's injection as a delta against `live`: notices for changed live memories, then
   * mentioned, pinned, session and preference memories once per context, then gated matches in
   * full or compact tier.
   */
  async buildInjection(args: BuildInjectionArgs): Promise<InjectionBuildResult> {
    const cfg = readConfig(this.settings);
    const now = Date.now();
    const sessionKey = args.sessionId ?? '';
    const { workspace, live } = args;

    const typed = splitTypedPaths(args.prompt);
    const { terms, dropped: droppedIds } = queryTerms(stripEnglishClitics(typed.text));
    const mentionedIds = extractMemoryIds(args.prompt);
    const files: MemoryInjectionDisplay['query']['files'] = [
      ...(args.activeFile ? [{ path: args.activeFile, source: 'editor' as const }] : []),
      ...typed.paths.map(path => ({ path, source: 'prompt' as const })),
    ];

    const visible = this.loadVisible(now, sessionKey, workspace);
    const storeCounts = storeCountsOf(visible);
    const idsByTerm = new Map<string, Set<string>>();
    for (const term of terms) idsByTerm.set(term, this.matchVisible(`${GATE_COLUMNS} : ${quoteFtsTerm(term)}`, visible));
    const analysis = analyzeTerms(terms, new Map([...idsByTerm].map(([t, ids]) => [t, ids.size])), storeCounts.total);
    const retrievalCounts = this.getRetrievalCounts(workspace);

    const taken = new Set<string>();
    const gate: MemoryInjectionDisplay['gate'] = {
      considered: 0, passed: 0, unmatchedSkipped: 0, alreadyInContext: 0, overBudget: 0, preferencesDeferred: 0,
    };

    // Notices run first; the ids they handle are excluded from every other rule this prompt.
    const liveRows = this.loadRows([...live.memories.keys()]);
    const noticeRenders: Array<{ notice: MemoryNotice; line: string; tracked?: Selected }> = [];
    const replacements: Selected[] = [];
    let noticeTokens = 0;
    type PlannedNotice = { render: NoticeRender; tracked?: Selected };
    const retired = (id: string, byUser: boolean): PlannedNotice => ({ render: { kind: 'forgotten', id, byUser } });
    const supersede = (id: string, liveEntry: LiveMemory, head: Loaded): PlannedNotice => {
      const headId = head.row.id;
      const headLive = live.memories.get(headId);
      // A notice carries content only, so an observation's title, facts and files count as sent only when its head is live in full.
      const tier: InjectionTier =
        headLive?.tier === 'full' || (liveEntry.tier === 'full' && head.row.kind !== 'observation') ? 'full' : 'compact';
      const current = headLive?.hash === head.row.content_hash && (headLive.tier === 'full' || tier === 'compact');
      if (current || taken.has(headId)) return { render: { kind: 'superseded', id, replacementId: headId, text: null } };
      const { text, truncated } = noticeText(renderable(head.entry, workspace), tier);
      const replacement = selectFull(head, workspace, [{ kind: 'replacement', replacesId: id }], {
        upgradedFromCompact: headLive?.tier === 'compact' && tier === 'full',
      });
      return {
        render: { kind: 'superseded', id, replacementId: headId, text },
        tracked: { ...replacement, tier, text, truncated, tokens: 0 },
      };
    };
    for (const [id, liveEntry] of live.memories) {
      if (noticeRenders.length >= BUDGETS.maxNotices) break;
      if (taken.has(id)) continue;
      const loaded = liveRows.get(id);
      const row = loaded?.row;
      const target = row?.forgotten === 1 && row.forget_reason === MERGED_FORGET_REASON ? this.mergeTarget(row) : row;
      let planned: PlannedNotice | null = null;
      // A merge recorded without an edge left its fact in a live row this prompt cannot name, so it stays unannounced.
      if (target === null) continue;
      if (!target) planned = retired(id, false);
      else if (target.forgotten === 1) planned = retired(id, USER_FORGET_REASONS.has(target.forget_reason));
      else if (target.is_latest === 0) {
        const head = this.chainHead(target);
        planned = head ? supersede(id, liveEntry, head) : retired(id, false);
      } else if (target.id !== id) planned = supersede(id, liveEntry, toLoaded(target));
      else if (loaded && target.content_hash !== liveEntry.hash) {
        const { text, truncated } = noticeText(renderable(loaded.entry, workspace), liveEntry.tier);
        planned = {
          render: { kind: 'edited', id, text },
          tracked: { ...selectFull(loaded, workspace, []), tier: liveEntry.tier, text, truncated, tokens: 0 },
        };
      }
      if (!planned) continue;
      const { render, tracked } = planned;
      const line = renderNotice(render);
      const cost = estimateTokens(line);
      if (noticeRenders.length > 0 && noticeTokens + cost > BUDGETS.noticeTokens) continue;
      noticeTokens += cost;
      taken.add(id);
      if (tracked) taken.add(tracked.loaded.row.id);
      if (tracked && render.kind === 'superseded') replacements.push(tracked);
      noticeRenders.push({
        notice: {
          kind: render.kind,
          id,
          title: loaded?.entry.title ?? null,
          snippet: loaded ? snippet(loaded.entry) : '',
          replacementId: render.kind === 'superseded' ? render.replacementId : null,
          tokens: cost,
        },
        line,
        ...(tracked ? { tracked } : {}),
      });
    }

    const selected: Selected[] = [];

    // Rule 1: mentioned ids, any kind, across workspaces.
    const mentionedResolved: string[] = [];
    const mentionedRows = this.loadRows(mentionedIds.slice(0, MAX_MENTIONED));
    for (const id of mentionedIds.slice(0, MAX_MENTIONED)) {
      const loaded = mentionedRows.get(id);
      if (!loaded) continue;
      const target = this.resolveMention(loaded);
      const targetId = target.row.id;
      if (target.row.forgotten === 0) mentionedResolved.push(targetId);
      if (taken.has(targetId)) continue;
      const liveEntry = live.memories.get(targetId);
      if (target.row.forgotten === 1) {
        selected.push(selectFull(target, workspace, [{ kind: 'mentioned' }], { forgottenMention: true }));
      } else if (liveEntry?.tier === 'full' && liveEntry.hash === target.row.content_hash) {
        gate.alreadyInContext++;
      } else {
        selected.push(selectFull(target, workspace, [{ kind: 'mentioned' }], { upgradedFromCompact: liveEntry?.tier === 'compact' }));
      }
      taken.add(targetId);
    }

    // Rules 2-4: pinned, session and preference memories once per context, each within a budget
    // shared with what the live context already holds.
    const liveTokens = (predicate: (l: Loaded) => boolean, maxChars?: number): number => {
      let sum = 0;
      for (const [id, entry] of live.memories) {
        const l = liveRows.get(id);
        if (!l || taken.has(id) || !predicate(l)) continue;
        const r = renderable(l.entry, workspace);
        sum += estimateTokens(entry.tier === 'full' ? renderFull(r, maxChars).text : renderCompactLine(r));
      }
      return sum;
    };
    const fillOncePerContext = (
      candidates: Loaded[],
      budget: number,
      reason: InjectionReason,
      isMember: (l: Loaded) => boolean,
      maxChars?: number,
    ): number => {
      let used = liveTokens(isMember, maxChars);
      let deferred = 0;
      for (const loaded of candidates) {
        const id = loaded.row.id;
        if (taken.has(id) || live.memories.has(id)) continue;
        const entry = selectFull(loaded, workspace, [reason], maxChars !== undefined ? { maxChars } : {});
        if (used + entry.tokens > budget) {
          deferred++;
          continue;
        }
        used += entry.tokens;
        taken.add(id);
        selected.push(entry);
      }
      return deferred;
    };
    gate.overBudget += fillOncePerContext(
      this.loadPinned(sessionKey, workspace), cfg.pinnedTokenBudget, { kind: 'pinned' }, l => l.row.pinned === 1,
    );
    gate.overBudget += fillOncePerContext(
      this.loadSessionMemories(visible), BUDGETS.sessionTokens, { kind: 'session' },
      l => l.row.scope === 'session' && l.row.pinned !== 1,
    );
    gate.preferencesDeferred = fillOncePerContext(
      this.loadPreferences(visible, retrievalCounts), BUDGETS.preferenceTokens, { kind: 'preference' },
      l => l.row.kind === 'preference' && l.row.scope !== 'session' && l.row.pinned !== 1, BUDGETS.preferenceChars,
    );

    // Rules 5-6: the lexical gate and the file gate.
    const matchedByCandidate = new Map<string, Set<string>>();
    for (const t of analysis.usable) {
      for (const id of idsByTerm.get(t.term) ?? []) {
        let set = matchedByCandidate.get(id);
        if (!set) matchedByCandidate.set(id, (set = new Set()));
        set.add(t.term);
      }
    }
    const fileCandidateIds = new Set<string>();
    for (const file of files) {
      for (const id of this.fileCandidateIds(file.path, visible)) if (!taken.has(id)) fileCandidateIds.add(id);
    }
    const fileRows = this.loadRows([...fileCandidateIds]);
    const matchers = files.map(f => ({ file: f, match: fileProximityMatcher(f.path) }));
    const fileProximityOf = (loaded: Loaded): number => {
      if (matchers.length === 0) return 0;
      const fields = normalizeFileFields(loaded.entry);
      return Math.max(...matchers.map(m => m.match(fields)));
    };
    const fileReasonsById = new Map<string, GatedCandidate['fileReasons']>();
    for (const [id, loaded] of fileRows) {
      const fields = normalizeFileFields(loaded.entry);
      const reasons = matchers
        .filter(m => m.match(fields) === FILE_PROXIMITY_FULL)
        .map(m => ({ path: m.file.path, source: m.file.source }));
      if (reasons.length > 0) fileReasonsById.set(id, reasons);
    }

    const candidateIds = new Set([...matchedByCandidate.keys(), ...fileReasonsById.keys()]);
    const passingIds: string[] = [];
    const lexicalById = new Map<string, LexicalMatch>();
    for (const id of candidateIds) {
      if (taken.has(id)) continue;
      const liveEntry = live.memories.get(id);
      if (liveEntry?.tier === 'full') {
        gate.alreadyInContext++;
        continue;
      }
      gate.considered++;
      const lexical = evaluateLexical(matchedByCandidate.get(id) ?? new Set(), analysis);
      lexicalById.set(id, lexical);
      if (lexical.passed || fileReasonsById.has(id)) passingIds.push(id);
      else if (!liveEntry) gate.unmatchedSkipped++;
    }

    const passingRows = this.loadRows(passingIds.filter(id => !fileRows.has(id)));
    const gated: GatedCandidate[] = [];
    for (const id of passingIds) {
      const loaded = fileRows.get(id) ?? passingRows.get(id);
      if (!loaded) continue;
      const lexical = lexicalById.get(id)!;
      const { score, breakdown } = scoreGatedEntry({
        lexical,
        fileProximity: fileProximityOf(loaded),
        updatedAt: loaded.row.updated_at,
        now,
        retrievalCount: retrievalCounts.get(id) ?? 0,
        sourceCount: loaded.row.source_count,
        kind: loaded.row.kind,
        fileChangeCount: loaded.row.file_change_count,
      });
      gated.push({
        loaded,
        lexical,
        fileReasons: fileReasonsById.get(id) ?? [],
        liveCompact: live.memories.get(id)?.tier === 'compact',
        score,
        breakdown,
        fullAllowed: lexical.fullAllowed,
      });
    }
    gate.passed = gated.filter(g => !g.liveCompact).length;
    gated.sort((a, b) =>
      compareRank(
        { score: a.score, scope: a.loaded.entry.scope ?? 'project', updatedAt: a.loaded.row.updated_at },
        { score: b.score, scope: b.loaded.entry.scope ?? 'project', updatedAt: b.loaded.row.updated_at },
      ),
    );

    let rerankApplied = false;
    let ranked = gated;
    if (cfg.rerankBlocking && args.prompt && gated.length >= 2) {
      const reranked = await this.rerank(args.prompt, gated);
      if (reranked) {
        ranked = reranked;
        rerankApplied = true;
      }
    }

    const liveCompactCount = ranked.filter(g => g.liveCompact).length;
    const window = ranked.slice(0, cfg.fullLimit + cfg.compactLimit + liveCompactCount);
    gate.overBudget += ranked.length - window.length - ranked.slice(window.length).filter(g => g.liveCompact).length;
    gate.alreadyInContext += ranked.slice(window.length).filter(g => g.liveCompact).length;
    const renders = new Map<string, { full: ReturnType<typeof renderFull>; compact: string }>();
    const tierCandidates: TierCandidate[] = window.map(g => {
      const r = renderable(g.loaded.entry, workspace);
      const full = renderFull(r);
      const compact = renderCompactLine(r);
      renders.set(g.loaded.row.id, { full, compact });
      return {
        id: g.loaded.row.id,
        fullAllowed: g.fullAllowed,
        liveCompact: g.liveCompact,
        tokens: { full: estimateTokens(full.text), compact: estimateTokens(compact) },
      };
    });
    const plan = assignTiers(tierCandidates, { full: cfg.fullLimit, compact: cfg.compactLimit, tokenBudget: cfg.tokenBudget });
    gate.overBudget += plan.overBudget;
    gate.alreadyInContext += plan.alreadyInContext;

    const gatedFull: Selected[] = [];
    const gatedCompact: Selected[] = [];
    for (const g of window) {
      const id = g.loaded.row.id;
      const tier = plan.tiers.get(id);
      if (!tier) continue;
      const r = renders.get(id)!;
      const reasons: InjectionReason[] = [];
      if (g.lexical.matchedTerms.length > 0) reasons.push({ kind: 'matched', terms: g.lexical.matchedTerms });
      for (const f of g.fileReasons) reasons.push({ kind: 'file', path: f.path, source: f.source });
      const entry: Selected = {
        loaded: g.loaded,
        tier,
        reasons,
        score: g.score,
        breakdown: g.breakdown,
        upgradedFromCompact: g.liveCompact,
        text: tier === 'full' ? r.full.text : r.compact,
        truncated: tier === 'full' ? r.full.truncated : false,
        tokens: estimateTokens(tier === 'full' ? r.full.text : r.compact),
        forgottenMention: false,
        ...(g.rerankRelevance ? { rerankRelevance: g.rerankRelevance } : {}),
        ...(g.rerankReason ? { rerankReason: g.rerankReason } : {}),
        ...(g.rerankClassifierScore !== undefined ? { rerankClassifierScore: g.rerankClassifierScore } : {}),
      };
      taken.add(id);
      (tier === 'full' ? gatedFull : gatedCompact).push(entry);
    }

    let profileText = '';
    let profileState: MemoryInjectionDisplay['profile']['state'];
    if (!cfg.profileEnabled) profileState = 'disabled';
    else if (live.profileInContext) profileState = 'inContext';
    else {
      profileText = this.profileManager.buildProfileInjection(workspace, cfg.profileTokenBudget);
      profileState = profileText ? 'injected' : 'empty';
    }

    const fullEntries = [...selected, ...gatedFull];
    const memoryBlock = renderMemoryBlock({
      full: fullEntries.map(s => s.text),
      compact: gatedCompact.map(s => s.text),
      notices: noticeRenders.map(n => n.line),
    });
    const text = joinInjectionParts([profileText, memoryBlock]);

    const added = [...fullEntries, ...gatedCompact, ...replacements];
    const trackedEntries = [
      ...added.filter(s => !s.forgottenMention),
      ...noticeRenders.flatMap(n => (n.tracked && n.notice.kind === 'edited' ? [n.tracked] : [])),
    ];
    const details: ContextInjectionDetailsV1 | null = text
      ? {
          v: 1,
          promptIndex: args.promptIndex,
          memories: trackedEntries.map(s => ({ id: s.loaded.row.id, hash: s.loaded.row.content_hash, tier: s.tier })),
          notices: noticeRenders.map(n => ({ id: n.notice.id, kind: n.notice.kind })),
          profile: profileState === 'injected',
          compassKey: null,
        }
      : null;

    const carried: CarriedMemory[] = [];
    for (const [id, liveEntry] of live.memories) {
      if (taken.has(id)) continue;
      const l = liveRows.get(id);
      if (!l || l.row.forgotten === 1 || l.row.is_latest === 0 || l.row.content_hash !== liveEntry.hash) continue;
      carried.push({
        id,
        scope: l.entry.scope ?? 'project',
        kind: l.entry.kind ?? 'fact',
        title: l.entry.title ?? null,
        snippet: snippet(l.entry),
        tier: liveEntry.tier,
        injectedAtPrompt: liveEntry.promptIndex,
        isPinned: !!l.entry.pinned,
      });
    }

    const memoryTokens = added.reduce((sum, s) => sum + s.tokens, 0);
    const profileTokens = estimateTokens(profileText);
    const display: MemoryInjectionDisplay = {
      version: 3,
      promptIndex: args.promptIndex,
      added: added.map(toInjectedMemory),
      notices: noticeRenders.map(n => n.notice),
      carried,
      profile: { state: profileState, tokens: profileTokens, text: profileText },
      compass: { state: 'disabled', text: '' },
      query: {
        terms,
        dropped: [...droppedIds, ...analysis.common.map(term => ({ term, reason: 'common' as const }))],
        mentionedIds,
        files,
      },
      gate,
      tokens: {
        memories: memoryTokens,
        notices: noticeTokens,
        profile: profileTokens,
        compass: 0,
        total: memoryTokens + noticeTokens + profileTokens,
        budget: cfg.tokenBudget,
      },
      storeCounts,
      rerankApplied,
      exactText: '',
    };

    return { text, details, display, mentionedIds: [...new Set(mentionedResolved)] };
  }

  /**
   * Reorder the gated set with one hard-capped (~2s) blocking rerank over its top entries: Jev when a
   * classifier is configured, else (or when Jev fails) the LLM in the time left. A `low` grade demotes
   * to compact. On timeout, null or failure the lexical order stands.
   */
  private async rerank(userPrompt: string, gated: GatedCandidate[]): Promise<GatedCandidate[] | null> {
    const pool = gated.slice(0, RERANK_CANDIDATE_CAP);
    const items = pool.map(g => ({
      id: g.loaded.row.id,
      title: g.loaded.entry.title ?? null,
      snippet: truncateToChars(g.loaded.entry.content, RERANK_SNIPPET_CHARS),
    }));

    let llmTimeoutMs = RERANK_TIMEOUT_MS;
    if (this.runner.hasClassifier?.()) {
      const started = Date.now();
      const jev = await classifierRerank(this.runner, userPrompt, items, RERANK_TIMEOUT_MS);
      if (jev) {
        const graded = new Map<string, RerankGrade>();
        for (const [id, g] of jev) graded.set(id, { relevance: g.relevance, classifierScore: g.score });
        return this.applyRerankGrades(pool, gated, graded);
      }
      llmTimeoutMs -= Date.now() - started;
      if (llmTimeoutMs < LLM_RERANK_MIN_MS) return null;
    }

    const prompt = `Query: ${truncateToChars(userPrompt, RERANK_QUERY_CHARS)}\n\nCandidates:\n${JSON.stringify(items)}`;
    let value: InjectRerankResult | null;
    try {
      const result = await this.runner.run<InjectRerankResult>({
        purpose: 'rerank',
        systemPrompt: INJECT_RERANK_SYSTEM_PROMPT,
        prompt,
        schema: INJECT_RERANK_SCHEMA,
        timeoutMs: llmTimeoutMs,
      });
      value = result.value;
    } catch (err) {
      log('[InjectionManager] Inject-rerank failed, keeping lexical order: %O', err);
      value = null;
    }
    if (!isInjectRerankResult(value)) return null;

    const graded = new Map<string, RerankGrade>();
    for (const item of value.results) {
      if (!Object.hasOwn(RELEVANCE_RANK, item.relevance)) continue;
      const reason = typeof item.reason === 'string' && item.reason ? item.reason : undefined;
      const existing = graded.get(item.id);
      if (!existing || RELEVANCE_RANK[item.relevance] > RELEVANCE_RANK[existing.relevance]) {
        graded.set(item.id, { relevance: item.relevance, ...(reason ? { reason } : {}) });
      }
    }
    if (graded.size === 0) return null;
    return this.applyRerankGrades(pool, gated, graded);
  }

  private applyRerankGrades(pool: GatedCandidate[], gated: GatedCandidate[], graded: ReadonlyMap<string, RerankGrade>): GatedCandidate[] {
    const reordered = pool
      .map((g, index) => {
        const grade = graded.get(g.loaded.row.id);
        const entry: GatedCandidate = grade
          ? {
              ...g,
              rerankRelevance: grade.relevance,
              ...(grade.reason ? { rerankReason: grade.reason } : {}),
              ...(grade.classifierScore !== undefined ? { rerankClassifierScore: grade.classifierScore } : {}),
              fullAllowed: g.fullAllowed && grade.relevance !== 'low',
            }
          : g;
        return { entry, index };
      })
      .sort((a, b) => rerankSortWeight(b.entry.rerankRelevance) - rerankSortWeight(a.entry.rerankRelevance) || a.index - b.index)
      .map(x => x.entry);
    return [...reordered, ...gated.slice(RERANK_CANDIDATE_CAP)];
  }
}
