import type { Disposable } from "../../platform/disposable";
import type { FileWatcher, FileWatcherFactory } from "../../platform/file-watcher";
import * as path from "path";
import * as fs from "fs";
import type { StoredSession } from "../../shared/types/session";
import {
  ensurePiSessionDir,
  piSessionDir,
  listPiSessions,
  getPiSessionMetadata,
  getPiSessionMetadataByFile,
  currentCachedRow,
  readLiveSessionMetadata,
  forgetSessionMetadata,
  piSessionIdFromFile,
  extractPiPromptHistory,
  resolvePiSessionFile,
  type LiveSessionMetaSource,
  type SessionMetaIndex,
} from "../pi-session/session-store";
import { pruneOrphanCheckpointRepos, getCheckpointsBaseDir, getWorkspaceCheckpointDir } from "../pi-session/checkpoints";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import { SESSIONS_PAGE_SIZE, type HostInstance } from "./types";
import type { PanelHost } from "../../platform/window-service";
import type { FolderTarget } from "../workspace-folders/folder-registry";
import { log } from "../logger";
import { perfSpan } from "../perf";
import { folderKey } from "../workspace-folders/folder-key";
import { worktreeSessionFolders } from "../worktrees/personal-config";
import type { WorktreeRegistry } from "../worktrees/registry";

const CHANGE_DEBOUNCE_MS = 300;
const PARSED_ROWS_PUSH_MS = 250;
/** Upserts run after every write during a turn, so only the slow ones log. */
const UPSERT_LOG_MIN_MS = 20;

/**
 * A pi session JSONL — excluding `agent-*.jsonl`, which (mirroring the SDK store) are sub-agent
 * transcripts, not user sessions, and must never be surfaced in the picker as standalone sessions.
 */
function isPiSessionFile(fsPath: string): boolean {
  const base = path.basename(fsPath);
  return base.endsWith(".jsonl") && !base.startsWith("agent-");
}

export interface StorageManagerConfig {
  /** Every open folder; the history lists the sessions of all of them. */
  folders: () => readonly FolderTarget[];
  isMultiRoot: () => boolean;
  postMessage: (host: PanelHost, message: ExtensionToWebviewMessage) => void;
  getPanels: () => Map<string, HostInstance>;
  /** The live session holding `sessionId` in this window, or undefined; must never start pi to answer. */
  liveSession: (sessionId: string) => LiveSessionMetaSource | undefined;
  fileWatchers: FileWatcherFactory;
  /** Owned: closed by `dispose`. */
  metaIndex: SessionMetaIndex;
}

const newestFirst = (a: StoredSession, b: StoredSession): number => b.timestamp - a.timestamp;

/** A change to the stored sessions that a list of them shows; no key when every folder's list reloaded. */
export interface StoredSessionsChange {
  readonly projectKey?: string;
}

/** Whether the fields a session list shows are equal; the timestamp moves on every write, so it is left out. */
function sameListing(a: StoredSession, b: StoredSession): boolean {
  return a.customTitle === b.customTitle
    && a.aiTitle === b.aiTitle
    && a.preview === b.preview
    && a.tag === b.tag
    && a.model?.provider === b.model?.provider
    && a.model?.id === b.model?.id
    && a.worktree?.worktreeId === b.worktree?.worktreeId
    && a.worktree?.place === b.worktree?.place;
}

/**
 * Calls `listener` after a registry change that alters which session directories the projects list (AD12 Listing): a record
 * added, removed or marked deleted. Most writes (usedAt, an Apply's tree, a Merge's base) alter none.
 */
export function onListingChange(registry: Pick<WorktreeRegistry, "records" | "onDidChange">, listener: () => void): Disposable {
  const keyOf = (): string => JSON.stringify(registry.records().map((r) => [r.id, r.kind, r.projectPath ?? null, r.workingFolder, r.deletedAt !== undefined]));
  let last = keyOf();
  return registry.onDidChange(() => {
    const next = keyOf();
    if (next === last) return;
    last = next;
    listener();
  });
}

/** Whether the session's shown title or tag, or with `matchFolder` its folder label, contains `query` (lowercased, trimmed). */
export function sessionMatchesQuery(session: StoredSession, query: string, matchFolder: boolean): boolean {
  const displayName = session.customTitle || session.aiTitle || session.preview;
  return displayName.toLowerCase().includes(query)
    || (session.tag?.toLowerCase().includes(query) ?? false)
    || (matchFolder && (session.workspaceFolder?.label.toLowerCase().includes(query) ?? false));
}

function sameRow(a: StoredSession, b: StoredSession): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof StoredSession)[]);
  return [...keys].every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

export class StorageManager {
  private allSessionsCache: StoredSession[] | null = null;
  /** The one list load in flight; every caller that finds the cache empty shares it. */
  private sessionsLoad: Promise<StoredSession[]> | null = null;
  /** Bumped on invalidation, so a load that started before it never fills the cache. */
  private sessionsGeneration = 0;
  private promptHistoryCache: string[] | null = null;
  private pendingPromptEntries: string[] = [];
  /** Folder key to that folder's session-dir watcher. */
  private readonly sessionWatchers = new Map<string, FileWatcher>();
  // registry folders' session dirs by folderKey, each watched for the project that lists them
  private readonly registryWatchers = new Map<string, { readonly projectKey: string; readonly watcher: FileWatcher }>();
  private pendingChangeTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly prunedFolders = new Set<string>();
  /** Session id to the key of the folder whose session dir holds it. */
  private sessionFolder = new Map<string, string>();
  /** Sessions read or deleted since the list loaded; a row the list parsed earlier never replaces theirs. */
  private readonly readSinceList = new Set<string>();
  /** Parsed rows applied to the list and not yet pushed or announced, with the projects whose listing they changed. */
  private parsedRowsPush: { readonly timer: NodeJS.Timeout; readonly changed: Set<string> } | null = null;
  /** Resolves once every row the index parsed for the load of `generation` was applied, or dropped: true when every file yielded its row. */
  private sessionsParsed: { readonly generation: number; readonly done: Promise<boolean> } | null = null;
  private readonly folders: StorageManagerConfig["folders"];
  private readonly isMultiRoot: StorageManagerConfig["isMultiRoot"];
  private readonly postMessage: StorageManagerConfig["postMessage"];
  private readonly getPanels: StorageManagerConfig["getPanels"];
  private readonly liveSession: StorageManagerConfig["liveSession"];
  private readonly fileWatchers: FileWatcherFactory;
  readonly metaIndex: SessionMetaIndex;
  private readonly changeListeners = new Set<(change: StoredSessionsChange) => void>();

  constructor(config: StorageManagerConfig) {
    this.folders = config.folders;
    this.isMultiRoot = config.isMultiRoot;
    this.postMessage = config.postMessage;
    this.getPanels = config.getPanels;
    this.liveSession = config.liveSession;
    this.fileWatchers = config.fileWatchers;
    this.metaIndex = config.metaIndex;
  }

  /** Fires when a session is added or removed, or a field a list shows changes; not for timestamp-only writes. */
  onDidChangeSessions(listener: (change: StoredSessionsChange) => void): Disposable {
    this.changeListeners.add(listener);
    return { dispose: (): void => { this.changeListeners.delete(listener); } };
  }

  private emitChange(change: StoredSessionsChange): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener(change);
      } catch (err) {
        log("[StorageManager] stored sessions listener error: %O", err);
      }
    }
  }

  /** Drop the cached list after a write the watcher reports late, and announce the folder's change now. */
  markSessionsChanged(folderKey: string): void {
    this.invalidateSessionsCache();
    this.emitChange({ projectKey: folderKey });
  }

  /** One open folder's stored sessions, newest first; empty for a key that is not open. Rows still being parsed arrive later, announced by `onDidChangeSessions`. */
  async sessionsOf(folderKey: string): Promise<StoredSession[]> {
    const all = await this.ensureSessionsLoaded();
    return all.filter((s) => s.workspaceFolder?.key === folderKey);
  }

  /** `sessionsOf` once the index parsed every file of the list: for a decision a missing row would make wrong, so it rejects when a file yielded no row. */
  async completeSessionsOf(folderKey: string): Promise<StoredSession[]> {
    const { sessions, complete } = await this.completeSessions();
    if (!complete) throw new Error("the session list is incomplete: a session file could not be parsed");
    return sessions.filter((s) => s.workspaceFolder?.key === folderKey);
  }

  /** Puts the session file's current row in the index, so a list loaded after a write finds it valid instead of parsing it. */
  async indexSessionRow(sessionId: string, folderKey: string): Promise<void> {
    const folder = this.openFolder(folderKey);
    if (!folder || this.liveMetadata(sessionId) !== undefined) return;
    await getPiSessionMetadata(this.metaIndex, folder.fsPath, sessionId);
  }

  /** The loaded list once every parsed row of its load was applied, and whether every file yielded one; a load an invalidation overtook is waited out again. */
  private async completeSessions(): Promise<{ sessions: StoredSession[]; complete: boolean }> {
    for (;;) {
      await this.ensureSessionsLoaded();
      const generation = this.sessionsGeneration;
      const parsed = this.sessionsParsed;
      const complete = parsed?.generation === generation ? await parsed.done : true;
      if (generation === this.sessionsGeneration && this.allSessionsCache) return { sessions: this.allSessionsCache, complete };
    }
  }

  private openFolder(key: string): FolderTarget | undefined {
    return this.folders().find((t) => t.key === key);
  }

  /** The open project `key`'s sessions list under: the folder itself, or the project of a registry folder (a chat worktree). */
  private listingOf(key: string): { folder: FolderTarget; listedFrom?: string } | undefined {
    const own = this.openFolder(key);
    if (own) return { folder: own };
    for (const folder of this.folders()) {
      const extra = this.registryFoldersOf(folder).find((candidate) => folderKey(candidate) === key);
      if (extra !== undefined) return { folder, listedFrom: extra };
    }
    return undefined;
  }

  private stamp(session: StoredSession, folder: FolderTarget): StoredSession {
    return { ...session, workspaceFolder: { key: folder.key, label: folder.label } };
  }

  /**
   * Every open folder's stored sessions, newest first, each listed once under its project (AD12 Listing). Resolves with
   * the rows the index still holds; rows of the files the index parses are upserted as they arrive, under this load's
   * generation, so none lands on a list loaded after an invalidation.
   */
  private async loadAllSessions(): Promise<StoredSession[]> {
    const generation = this.sessionsGeneration;
    const parsed: Promise<boolean>[] = [];
    const list = async (folder: FolderTarget, listedFrom?: string): Promise<StoredSession[]> => {
      const applied: Promise<unknown>[] = [];
      const { sessions, parsed: listParsed } = await listPiSessions(this.metaIndex, listedFrom ?? folder.fsPath, (rows) => {
        applied.push(this.upsertSessionsInCache(rows, folder.key, generation, { fromList: { listedFrom } })
          .catch((err) => log("[StorageManager] applying parsed session rows failed for %s: %O", folder.fsPath, err)));
      });
      // Every batch arrives before the list ends, so `applied` is complete by then.
      parsed.push(listParsed.then(async (complete) => {
        await Promise.all(applied);
        return complete;
      }));
      return sessions.map((s) => (listedFrom !== undefined ? { ...this.stamp(s, folder), listedFrom } : this.stamp(s, folder)));
    };
    const perFolder = await Promise.all(this.folders().map(async (folder) => {
      void this.pruneOrphanCheckpointReposOnce(folder);
      const own = await list(folder);
      const extras = this.registryFoldersOf(folder);
      if (extras.length === 0) return own;
      const listed = await Promise.all(extras.map((extra) => list(folder, extra)));
      const unique = new Map<string, StoredSession>();
      for (const session of [...own, ...listed.flat()]) if (!unique.has(session.id)) unique.set(session.id, session);
      return [...unique.values()];
    }));
    if (generation === this.sessionsGeneration) this.sessionsParsed = { generation, done: Promise.all(parsed).then((lists) => lists.every(Boolean)) };
    return perFolder.flat().sort(newestFirst);
  }

  /** The registry folders whose session dirs list under `folder`, less any open as a project itself. */
  private registryFoldersOf(folder: FolderTarget): string[] {
    const open = new Set(this.folders().map((t) => t.key));
    return worktreeSessionFolders(folder.fsPath).filter((extra) => !open.has(folderKey(extra)));
  }

  /** The cached session list, loading it once when empty. A load overtaken by an invalidation is discarded and redone. */
  private async ensureSessionsLoaded(): Promise<StoredSession[]> {
    while (!this.allSessionsCache) {
      const generation = this.sessionsGeneration;
      if (!this.sessionsLoad) {
        const load = this.loadAllSessions().finally(() => {
          if (this.sessionsLoad === load) this.sessionsLoad = null;
        });
        this.sessionsLoad = load;
      }
      let sessions: StoredSession[];
      try {
        sessions = await this.sessionsLoad;
      } catch (err) {
        if (generation !== this.sessionsGeneration) continue;
        throw err;
      }
      if (generation !== this.sessionsGeneration) continue;
      if (!this.allSessionsCache) {
        this.allSessionsCache = sessions;
        this.sessionFolder = new Map(sessions.map((s) => [s.id, s.workspaceFolder!.key]));
      }
    }
    return this.allSessionsCache;
  }

  /**
   * Once per folder, delete THIS workspace's checkpoint repos whose session file no longer
   * exists (US-013b). `deletePiSession` already removes a repo on explicit delete, so this only
   * reclaims repos orphaned out-of-band (file removed by another process or a prior crash). The sweep
   * is scoped to the workspace's own checkpoint subdir — a global sweep would delete OTHER workspaces'
   * repos, since the live set here is only this workspace's sessions. Runs off the session-list load
   * and never blocks it; the live set is the FULL on-disk session set, so pagination can't mis-prune.
   */
  private pruneOrphanCheckpointReposOnce(folder: FolderTarget): Promise<void> {
    if (this.prunedFolders.has(folder.key)) return Promise.resolve();
    this.prunedFolders.add(folder.key);
    return (async () => {
      try {
        const dir = ensurePiSessionDir(folder.fsPath);
        const files = await fs.promises.readdir(dir);
        const liveBases = new Set(files.filter(isPiSessionFile).map((f) => path.basename(f, ".jsonl")));
        const workspaceRepoDir = getWorkspaceCheckpointDir(dir);
        await this.migrateFlatCheckpointRepos(liveBases, workspaceRepoDir);
        await pruneOrphanCheckpointRepos(liveBases, workspaceRepoDir);
      } catch (err) {
        log("[StorageManager] orphan checkpoint repo prune failed: %O", err);
      }
    })();
  }

  /**
   * Move legacy flat checkpoint repos (`<base>/<basename>`, the pre per-workspace layout) for this
   * workspace's live sessions into the workspace subdir (`<base>/<encoded-cwd>/<basename>`), so their
   * rewind history survives the layout change. The repo dir is named after the full session-file
   * basename (`<timestamp>_<uuidv7-id>`), which is globally unique, so matching a flat repo against
   * this workspace's session set unambiguously attributes it here. Skips any already at the new path
   * (e.g. the live session already created it), and the atomic rename keeps it race-safe.
   */
  private async migrateFlatCheckpointRepos(liveBases: ReadonlySet<string>, workspaceRepoDir: string): Promise<void> {
    const flatBase = getCheckpointsBaseDir();
    for (const base of liveBases) {
      const flat = path.join(flatBase, base);
      const scoped = path.join(workspaceRepoDir, base);
      try {
        if (!fs.existsSync(flat) || fs.existsSync(scoped)) continue;
        await fs.promises.mkdir(workspaceRepoDir, { recursive: true });
        await fs.promises.rename(flat, scoped);
      } catch (err) {
        log("[StorageManager] checkpoint repo migration skipped for %s: %O", base, err);
      }
    }
  }

  async getStoredSessions(
    offset: number = 0,
    limit: number = SESSIONS_PAGE_SIZE,
    selectedSessionId?: string
  ): Promise<{ sessions: StoredSession[]; hasMore: boolean; nextOffset: number }> {
    const all = await this.ensureSessionsLoaded();
    const total = all.length;
    const sessions = all.slice(offset, offset + limit);
    const hasMore = offset + limit < total;
    const nextOffset = offset + sessions.length;

    if (selectedSessionId && !sessions.some((s) => s.id === selectedSessionId)) {
      const selectedSession = all.find((s) => s.id === selectedSessionId);
      if (selectedSession) {
        sessions.push(selectedSession);
      }
    }

    return { sessions, hasMore, nextOffset };
  }

  async searchSessions(
    query: string,
    offset: number = 0,
    selectedSessionId?: string
  ): Promise<{ sessions: StoredSession[]; hasMore: boolean; nextOffset: number }> {
    const all = await this.ensureSessionsLoaded();

    if (!query.trim()) {
      return this.getStoredSessions(offset, SESSIONS_PAGE_SIZE, selectedSessionId);
    }

    const normalizedQuery = query.toLowerCase().trim();
    // Sessions carry a visible folder label only with two or more folders open; otherwise every one would match.
    const matchFolder = this.isMultiRoot();
    const allMatches = all.filter((session) => sessionMatchesQuery(session, normalizedQuery, matchFolder));

    const total = allMatches.length;
    const sessions = allMatches.slice(offset, offset + SESSIONS_PAGE_SIZE);
    const hasMore = offset + SESSIONS_PAGE_SIZE < total;
    const nextOffset = offset + sessions.length;

    return { sessions, hasMore, nextOffset };
  }

  /**
   * The open folder whose session dir holds `sessionId`, else undefined. The id is only ever matched
   * against directory entries of open folders, so a webview-supplied id cannot name another path.
   */
  async folderOf(sessionId: string): Promise<FolderTarget | undefined> {
    const indexed = this.sessionFolder.get(sessionId);
    const known = indexed !== undefined ? this.openFolder(indexed) : undefined;
    if (known) return known;
    for (const folder of this.folders()) {
      if ((await resolvePiSessionFile(folder.fsPath, sessionId)) !== null) {
        this.sessionFolder.set(sessionId, folder.key);
        return folder;
      }
    }
    return undefined;
  }

  /** Follow folder adds, removes and relabels: one watcher per open folder, then a fresh list. */
  async reloadFolders(): Promise<void> {
    const open = new Set(this.folders().map((t) => t.key));
    for (const [key, watcher] of this.sessionWatchers) {
      if (open.has(key)) continue;
      watcher.dispose();
      this.sessionWatchers.delete(key);
    }
    // A registry folder's watcher goes with its project, with its record and once the folder opens as a project itself.
    const listed = new Set(this.folders().flatMap((folder) => this.registryFoldersOf(folder).map(folderKey)));
    for (const [dirKey, entry] of this.registryWatchers) {
      if (open.has(entry.projectKey) && listed.has(dirKey)) continue;
      entry.watcher.dispose();
      this.registryWatchers.delete(dirKey);
    }
    // A folder re-added later is pruned again, since its sessions may have changed while it was closed.
    for (const key of this.prunedFolders) if (!open.has(key)) this.prunedFolders.delete(key);
    this.invalidateSessionsCache();
    await this.setupSessionWatcher();
    await this.ensureSessionsLoaded();
    this.pushSessionsToAllPanels();
    this.emitChange({});
  }

  invalidateSessionsCache(): void {
    this.allSessionsCache = null;
    this.sessionsLoad = null;
    this.sessionsGeneration++;
    this.promptHistoryCache = null;
    this.readSinceList.clear();
  }

  /** A list not loaded yet reads the tag from the file, so only a loaded one is updated; the change is announced either way. */
  updateSessionTag(sessionId: string, tag: string | null, folderKey: string): void {
    const session = this.allSessionsCache?.find(s => s.id === sessionId);
    if (session) {
      if (tag) {
        session.tag = tag;
      } else {
        delete session.tag;
      }
      this.pushSessionsToAllPanels();
    }
    this.emitChange({ projectKey: folderKey });
  }

  async addOrUpdateSession(sessionId: string, folderKey: string): Promise<void> {
    const listing = this.listingOf(folderKey);
    if (!listing) return;
    const span = perfSpan("sessions.upsert", { minMs: UPSERT_LOG_MIN_MS });
    const generation = this.sessionsGeneration;
    const live = this.liveMetadata(sessionId);
    const source = live !== undefined ? "live" : "file";
    const metadata = live !== undefined ? live : await getPiSessionMetadata(this.metaIndex, listing.listedFrom ?? listing.folder.fsPath, sessionId);
    const applied = metadata ? await this.upsertSessionsInCache([metadata], listing.folder.key, generation, listing.listedFrom !== undefined ? { listedFrom: listing.listedFrom } : undefined) : false;
    span.end({ source, applied });
  }

  async getPromptHistory(
    offset: number = 0
  ): Promise<{ history: string[]; hasMore: boolean }> {
    // Complete, since nothing rebuilds the history when parsed rows arrive. A file that yielded no row only misses its prompts, so an incomplete list still serves.
    const { sessions: all } = await this.completeSessions();

    if (!this.promptHistoryCache) {
      const allHistory = await extractPiPromptHistory(this.metaIndex, this.folders().map((t) => t.fsPath), all);
      const diskSet = new Set(allHistory);
      const uniquePending = this.pendingPromptEntries.filter((e) => !diskSet.has(e));
      this.promptHistoryCache = [...uniquePending, ...allHistory];
      this.pendingPromptEntries = uniquePending;
    }

    const PROMPT_HISTORY_PAGE_SIZE = 100;
    const pageItems = this.promptHistoryCache.slice(offset, offset + PROMPT_HISTORY_PAGE_SIZE);
    const hasMore = this.promptHistoryCache.length > offset + PROMPT_HISTORY_PAGE_SIZE;

    return { history: pageItems, hasMore };
  }

  /** Watch `folderKey`'s session dir (its project's, for a registry folder), or every open folder's when omitted. Idempotent per folder. */
  async setupSessionWatcher(folderKey?: string): Promise<void> {
    const listed = folderKey !== undefined ? this.listingOf(folderKey)?.folder : undefined;
    const targets = folderKey !== undefined ? (listed ? [listed] : []) : this.folders();
    for (const folder of targets) await this.watchFolder(folder);
  }

  private async watchFolder(folder: FolderTarget): Promise<void> {
    // Rule 1: the project's registry folders' session dirs are watched under the project's key.
    for (const extra of this.registryFoldersOf(folder)) {
      const dirKey = folderKey(extra);
      if (this.registryWatchers.has(dirKey)) continue;
      // Not created here: a watch on a missing directory starts once it appears, and only a session there creates it.
      const watcher = this.fileWatchers.watch(piSessionDir(extra), "*.jsonl");
      const key = folder.key;
      watcher.onDidCreate((filePath) => {
        this.handleSessionFileCreated(filePath, key).catch((err) => log("[StorageManager] session file create upsert failed for %s: %O", filePath, err));
      });
      watcher.onDidChange((filePath) => this.handleSessionFileChanged(filePath, key));
      watcher.onDidDelete((filePath) => this.handleSessionFileDeleted(filePath));
      this.registryWatchers.set(dirKey, { projectKey: key, watcher });
    }
    if (this.sessionWatchers.has(folder.key)) return;

    // pi writes to the Damocles-owned pi tree dir (created here so the watcher attaches even before
    // the first session).
    const sessionDir = ensurePiSessionDir(folder.fsPath);

    try {
      await fs.promises.access(sessionDir);
    } catch {
      return;
    }
    // Re-checked after the await: a concurrent call may have attached one, or the folder may have closed.
    if (this.sessionWatchers.has(folder.key) || !this.openFolder(folder.key)) return;

    const key = folder.key;
    const watcher = this.fileWatchers.watch(sessionDir, "*.jsonl");
    watcher.onDidCreate((filePath) => {
      this.handleSessionFileCreated(filePath, key).catch((err) => log("[StorageManager] session file create upsert failed for %s: %O", filePath, err));
    });
    watcher.onDidChange((filePath) => this.handleSessionFileChanged(filePath, key));
    watcher.onDidDelete((filePath) => this.handleSessionFileDeleted(filePath));
    this.sessionWatchers.set(key, watcher);
  }

  pushSessionsToAllPanels(): void {
    if (!this.allSessionsCache) return;

    const sessions = this.allSessionsCache.slice(0, SESSIONS_PAGE_SIZE);
    const hasMore = this.allSessionsCache.length > SESSIONS_PAGE_SIZE;
    const nextOffset = sessions.length;

    for (const [, instance] of this.getPanels()) {
      this.postMessage(instance.host, {
        type: "storedSessions",
        sessions,
        hasMore,
        nextOffset,
        isFirstPage: true,
      });
    }
  }

  broadcastPromptHistoryEntry(entry: string): void {
    const MAX_PENDING_ENTRIES = 50;
    this.pendingPromptEntries = [entry, ...this.pendingPromptEntries.filter((e) => e !== entry)].slice(0, MAX_PENDING_ENTRIES);
    this.promptHistoryCache = null;

    for (const [, instance] of this.getPanels()) {
      this.postMessage(instance.host, {
        type: "promptHistoryPush",
        entry,
      });
    }
  }

  async dispose(): Promise<void> {
    for (const watcher of this.sessionWatchers.values()) watcher.dispose();
    this.sessionWatchers.clear();
    for (const entry of this.registryWatchers.values()) entry.watcher.dispose();
    this.registryWatchers.clear();
    for (const timer of this.pendingChangeTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingChangeTimers.clear();
    if (this.parsedRowsPush) clearTimeout(this.parsedRowsPush.timer);
    this.parsedRowsPush = null;
    await this.metaIndex.close();
  }

  private async handleSessionFileCreated(filePath: string, folderKey: string): Promise<void> {
    return this.handlePiSessionFileUpsert(filePath, folderKey);
  }

  private handleSessionFileChanged(filePath: string, folderKey: string): void {
    return this.handlePiSessionFileChanged(filePath, folderKey);
  }

  /** A live session's metadata from its in-memory manager, or undefined when no live session here holds the file. */
  private liveMetadata(sessionId: string, filePath?: string): StoredSession | null | undefined {
    const source = this.liveSession(sessionId);
    return source ? readLiveSessionMetadata(this.metaIndex, source, sessionId, filePath) : undefined;
  }

  /**
   * Applied after the load too, because a shared load may have read the file before this change. Dropped
   * when the list was invalidated after `generation` (the list loaded since then read the file after the
   * metadata was) or the folder closed. `fromList` marks rows the list parsed after it loaded, read when it
   * listed: one never replaces a row read since, nor one listed from another dir (`listedFrom`, a registry
   * folder's session dir). Returns whether any row was applied.
   */
  private async upsertSessionsInCache(
    rows: readonly StoredSession[],
    folderKey: string,
    generation: number,
    options?: { ifChanged?: boolean; fromList?: { listedFrom: string | undefined }; listedFrom?: string },
  ): Promise<boolean> {
    if (rows.length === 0 || generation !== this.sessionsGeneration || !this.openFolder(folderKey)) return false;
    const all = await this.ensureSessionsLoaded();
    const folder = this.openFolder(folderKey);
    if (generation !== this.sessionsGeneration || !folder) return false;
    let applied = false;
    let changed = false;
    for (const metadata of rows) {
      const existingIndex = all.findIndex((s) => s.id === metadata.id);
      const existing = existingIndex >= 0 ? all[existingIndex]! : undefined;
      const fromList = options?.fromList;
      if (fromList) {
        // The project's own dir wins over a registry folder's, as in `loadAllSessions`; between registry folders the first listed wins.
        if (this.readSinceList.has(metadata.id) || (existing && existing.listedFrom !== fromList.listedFrom && fromList.listedFrom !== undefined)) continue;
      } else {
        this.readSinceList.add(metadata.id);
      }
      // A file stays in the session dir the list found it in, which its metadata does not name.
      const stamped = this.stamp(metadata, folder);
      const listedFrom = fromList ? fromList.listedFrom : (options?.listedFrom ?? existing?.listedFrom);
      const row = listedFrom !== undefined ? { ...stamped, listedFrom } : stamped;
      this.sessionFolder.set(metadata.id, folder.key);
      if (existing) {
        if (options?.ifChanged && sameRow(existing, row)) continue;
        all[existingIndex] = row;
      } else {
        all.push(row);
      }
      applied = true;
      if (!existing || !sameListing(existing, row)) changed = true;
    }
    if (!applied) return false;
    all.sort(newestFirst);
    if (options?.fromList) {
      this.announceParsedRows(changed ? folder.key : undefined);
      return true;
    }
    this.pushSessionsToAllPanels();
    if (changed) this.emitChange({ projectKey: folder.key });
    return true;
  }

  /** A cold list delivers its parsed rows in many batches, so their pushes and change events go out once per `PARSED_ROWS_PUSH_MS`. */
  private announceParsedRows(changedProject: string | undefined): void {
    this.parsedRowsPush ??= {
      changed: new Set(),
      timer: setTimeout(() => {
        const pending = this.parsedRowsPush;
        this.parsedRowsPush = null;
        if (!pending) return;
        this.pushSessionsToAllPanels();
        for (const projectKey of pending.changed) this.emitChange({ projectKey });
      }, PARSED_ROWS_PUSH_MS),
    };
    if (changedProject !== undefined) this.parsedRowsPush.changed.add(changedProject);
  }

  private handleSessionFileDeleted(filePath: string): void {
    return this.handlePiSessionFileDeleted(filePath);
  }

  // ---- pi tree watcher handlers (FR-1) ------------------------------------
  // pi session files are named `<timestamp>_<id>.jsonl`, so the file base is NOT the session id and
  // metadata is read from the file itself; debounce timers are keyed by file path.

  private async handlePiSessionFileUpsert(filePath: string, folderKey: string): Promise<void> {
    if (!isPiSessionFile(filePath)) return;
    // Let pi finish writing the header before the first read.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await this.upsertFromFile(filePath, folderKey);
  }

  /**
   * When the file's size and mtime match the cached read, the cached row is applied and the file is not
   * read: on Windows, reading a file can update its last-access time, which `fs.watch` reports as a
   * change, so the list's own reads would otherwise re-trigger it.
   */
  private async upsertFromFile(filePath: string, folderKey: string): Promise<void> {
    const generation = this.sessionsGeneration;
    const cached = await currentCachedRow(this.metaIndex, filePath);
    if (cached !== undefined) {
      if (cached) await this.upsertSessionsInCache([cached], folderKey, generation, { ifChanged: true });
      return;
    }
    const span = perfSpan("sessions.upsert", { minMs: UPSERT_LOG_MIN_MS });
    const live = this.liveMetadata(piSessionIdFromFile(filePath), filePath);
    const source = live !== undefined ? "live" : "file";
    const metadata = live !== undefined ? live : await getPiSessionMetadataByFile(this.metaIndex, filePath);
    const applied = metadata ? await this.upsertSessionsInCache([metadata], folderKey, generation) : false;
    span.end({ source, applied });
  }

  private handlePiSessionFileChanged(filePath: string, folderKey: string): void {
    if (!isPiSessionFile(filePath)) return;
    const key = filePath;
    const existingTimer = this.pendingChangeTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.pendingChangeTimers.delete(key);
      this.upsertFromFile(filePath, folderKey).catch((err) => log("[StorageManager] session file change upsert failed for %s: %O", filePath, err));
    }, CHANGE_DEBOUNCE_MS);
    this.pendingChangeTimers.set(key, timer);
  }

  private handlePiSessionFileDeleted(filePath: string): void {
    if (!isPiSessionFile(filePath)) return;
    const key = filePath;
    const existingTimer = this.pendingChangeTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.pendingChangeTimers.delete(key);
    }
    // Another window's delete, too, leaves the index.
    forgetSessionMetadata(this.metaIndex, filePath);
    const sessionId = piSessionIdFromFile(filePath);
    this.readSinceList.add(sessionId);
    const folderKey = this.sessionFolder.get(sessionId);
    this.sessionFolder.delete(sessionId);
    if (this.allSessionsCache) {
      this.allSessionsCache = this.allSessionsCache.filter((s) => s.id !== sessionId);
    } else if (this.sessionsLoad) {
      // The load in flight may have listed the file before it went.
      this.invalidateSessionsCache();
    }
    this.pushSessionsToAllPanels();
    if (folderKey !== undefined) this.emitChange({ projectKey: folderKey });
  }
}
