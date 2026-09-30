import type { FileWatcher, FileWatcherFactory } from "../../platform/file-watcher";
import * as path from "path";
import * as fs from "fs";
import type { StoredSession } from "../../shared/types/session";
import {
  ensurePiSessionDir,
  listPiSessions,
  getPiSessionMetadata,
  getPiSessionMetadataByFile,
  currentCachedRow,
  readLiveSessionMetadata,
  forgetSessionMetadata,
  flushSessionMetaCache,
  piSessionIdFromFile,
  extractPiPromptHistory,
  resolvePiSessionFile,
  type LiveSessionMetaSource,
} from "../pi-session/session-store";
import { pruneOrphanCheckpointRepos, getCheckpointsBaseDir, getWorkspaceCheckpointDir } from "../pi-session/checkpoints";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import { SESSIONS_PAGE_SIZE, type HostInstance } from "./types";
import type { PanelHost } from "../../platform/window-service";
import type { FolderTarget } from "../workspace-folders/folder-registry";
import { log } from "../logger";
import { perfSpan } from "../perf";

const CHANGE_DEBOUNCE_MS = 300;
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
}

const newestFirst = (a: StoredSession, b: StoredSession): number => b.timestamp - a.timestamp;

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
  private pendingChangeTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly prunedFolders = new Set<string>();
  /** Session id to the key of the folder whose session dir holds it. */
  private sessionFolder = new Map<string, string>();
  private readonly folders: StorageManagerConfig["folders"];
  private readonly isMultiRoot: StorageManagerConfig["isMultiRoot"];
  private readonly postMessage: StorageManagerConfig["postMessage"];
  private readonly getPanels: StorageManagerConfig["getPanels"];
  private readonly liveSession: StorageManagerConfig["liveSession"];
  private readonly fileWatchers: FileWatcherFactory;

  constructor(config: StorageManagerConfig) {
    this.folders = config.folders;
    this.isMultiRoot = config.isMultiRoot;
    this.postMessage = config.postMessage;
    this.getPanels = config.getPanels;
    this.liveSession = config.liveSession;
    this.fileWatchers = config.fileWatchers;
  }

  private openFolder(key: string): FolderTarget | undefined {
    return this.folders().find((t) => t.key === key);
  }

  /** A copy, because `listPiSessions` hands out objects its metadata cache still holds. */
  private stamp(session: StoredSession, folder: FolderTarget): StoredSession {
    return { ...session, workspaceFolder: { key: folder.key, label: folder.label } };
  }

  /** Every open folder's stored sessions, newest first. */
  private async loadAllSessions(): Promise<StoredSession[]> {
    const perFolder = await Promise.all(this.folders().map(async (folder) => {
      void this.pruneOrphanCheckpointReposOnce(folder);
      return (await listPiSessions(folder.fsPath)).map((s) => this.stamp(s, folder));
    }));
    return perFolder.flat().sort(newestFirst);
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
    const allMatches = all.filter((session) => {
      const displayName = session.customTitle || session.aiTitle || session.preview;
      return displayName.toLowerCase().includes(normalizedQuery)
        || session.tag?.toLowerCase().includes(normalizedQuery)
        || (matchFolder && session.workspaceFolder?.label.toLowerCase().includes(normalizedQuery));
    });

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
    // A folder re-added later is pruned again, since its sessions may have changed while it was closed.
    for (const key of this.prunedFolders) if (!open.has(key)) this.prunedFolders.delete(key);
    this.invalidateSessionsCache();
    await this.setupSessionWatcher();
    await this.ensureSessionsLoaded();
    this.pushSessionsToAllPanels();
  }

  invalidateSessionsCache(): void {
    this.allSessionsCache = null;
    this.sessionsLoad = null;
    this.sessionsGeneration++;
    this.promptHistoryCache = null;
  }

  updateSessionTagInCache(sessionId: string, tag: string | null): void {
    if (!this.allSessionsCache) return;
    const session = this.allSessionsCache.find(s => s.id === sessionId);
    if (!session) return;
    if (tag) {
      session.tag = tag;
    } else {
      delete session.tag;
    }
    this.pushSessionsToAllPanels();
  }

  async addOrUpdateSession(sessionId: string, folderKey: string): Promise<void> {
    const folder = this.openFolder(folderKey);
    if (!folder) return;
    const span = perfSpan("sessions.upsert", { minMs: UPSERT_LOG_MIN_MS });
    const generation = this.sessionsGeneration;
    const live = this.liveMetadata(sessionId);
    const source = live !== undefined ? "live" : "file";
    const metadata = live !== undefined ? live : await getPiSessionMetadata(folder.fsPath, sessionId);
    const applied = metadata ? await this.upsertSessionInCache(metadata, folderKey, generation) : false;
    span.end({ source, applied });
  }

  async getPromptHistory(
    offset: number = 0
  ): Promise<{ history: string[]; hasMore: boolean }> {
    const all = await this.ensureSessionsLoaded();

    if (!this.promptHistoryCache) {
      const allHistory = await extractPiPromptHistory(this.folders().map((t) => t.fsPath), all);
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

  /** Watch `folderKey`'s session dir, or every open folder's when omitted. Idempotent per folder. */
  async setupSessionWatcher(folderKey?: string): Promise<void> {
    const targets = folderKey !== undefined ? this.folders().filter((t) => t.key === folderKey) : this.folders();
    for (const folder of targets) await this.watchFolder(folder);
  }

  private async watchFolder(folder: FolderTarget): Promise<void> {
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

  dispose(): void {
    for (const watcher of this.sessionWatchers.values()) watcher.dispose();
    this.sessionWatchers.clear();
    for (const timer of this.pendingChangeTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingChangeTimers.clear();
    flushSessionMetaCache();
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
    return source ? readLiveSessionMetadata(source, sessionId, filePath) : undefined;
  }

  /**
   * Applied after the load too, because a shared load may have read the file before this change. Dropped
   * when the list was invalidated after `generation` (the list loaded since then read the file after the
   * metadata was) or the folder closed. Returns whether the row was applied.
   */
  private async upsertSessionInCache(
    metadata: StoredSession,
    folderKey: string,
    generation: number,
    options?: { ifChanged?: boolean },
  ): Promise<boolean> {
    if (generation !== this.sessionsGeneration || !this.openFolder(folderKey)) return false;
    const all = await this.ensureSessionsLoaded();
    const folder = this.openFolder(folderKey);
    if (generation !== this.sessionsGeneration || !folder) return false;
    this.sessionFolder.set(metadata.id, folder.key);
    const row = this.stamp(metadata, folder);
    const existingIndex = all.findIndex((s) => s.id === row.id);
    if (existingIndex >= 0) {
      if (options?.ifChanged && sameRow(all[existingIndex]!, row)) return false;
      all[existingIndex] = row;
    } else {
      all.push(row);
    }
    all.sort(newestFirst);
    this.pushSessionsToAllPanels();
    return true;
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
    const cached = await currentCachedRow(filePath);
    if (cached !== undefined) {
      if (cached) await this.upsertSessionInCache(cached, folderKey, generation, { ifChanged: true });
      return;
    }
    const span = perfSpan("sessions.upsert", { minMs: UPSERT_LOG_MIN_MS });
    const live = this.liveMetadata(piSessionIdFromFile(filePath), filePath);
    const source = live !== undefined ? "live" : "file";
    const metadata = live !== undefined ? live : await getPiSessionMetadataByFile(filePath);
    const applied = metadata ? await this.upsertSessionInCache(metadata, folderKey, generation) : false;
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
    // Another window's delete, too, leaves the disk cache.
    forgetSessionMetadata(filePath);
    const sessionId = piSessionIdFromFile(filePath);
    this.sessionFolder.delete(sessionId);
    if (this.allSessionsCache) {
      this.allSessionsCache = this.allSessionsCache.filter((s) => s.id !== sessionId);
    } else if (this.sessionsLoad) {
      // The load in flight may have listed the file before it went.
      this.invalidateSessionsCache();
    }
    this.pushSessionsToAllPanels();
  }
}
