import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import {
  listSessions,
  getSessionDirSync,
  getSessionMetadata,
  extractPromptHistory,
  type StoredSession,
} from "../session";
import { getEffectiveHarness } from "../pi-session/harness";
import {
  ensurePiSessionDir,
  listPiSessions,
  getPiSessionMetadata,
  getPiSessionMetadataByFile,
  piSessionIdFromFile,
  extractPiPromptHistory,
} from "../pi-session/session-store";
import { pruneOrphanCheckpointRepos, getCheckpointsBaseDir, getWorkspaceCheckpointDir } from "../pi-session/checkpoints";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import { SESSIONS_PAGE_SIZE, type HostInstance, type WebviewHost } from "./types";
import { log } from "../logger";

const CHANGE_DEBOUNCE_MS = 300;

/**
 * A pi session JSONL — excluding `agent-*.jsonl`, which (mirroring the SDK store) are sub-agent
 * transcripts, not user sessions, and must never be surfaced in the picker as standalone sessions.
 */
function isPiSessionFile(fsPath: string): boolean {
  const base = path.basename(fsPath);
  return base.endsWith(".jsonl") && !base.startsWith("agent-");
}

export interface StorageManagerConfig {
  workspacePath: string;
  postMessage: (host: WebviewHost, message: ExtensionToWebviewMessage) => void;
  getPanels: () => Map<string, HostInstance>;
}

export class StorageManager {
  private allSessionsCache: StoredSession[] | null = null;
  private promptHistoryCache: string[] | null = null;
  private pendingPromptEntries: string[] = [];
  private sessionWatcher: vscode.FileSystemWatcher | null = null;
  private pendingChangeTimers: Map<string, NodeJS.Timeout> = new Map();
  private orphanReposPruned = false;
  private readonly workspacePath: string;
  private readonly postMessage: StorageManagerConfig["postMessage"];
  private readonly getPanels: StorageManagerConfig["getPanels"];

  constructor(config: StorageManagerConfig) {
    this.workspacePath = config.workspacePath;
    this.postMessage = config.postMessage;
    this.getPanels = config.getPanels;
  }

  /** Whether session persistence is served by the pi tree store rather than the SDK store (FR-1). */
  private get isPi(): boolean {
    return getEffectiveHarness() === "pi";
  }

  /** Load every stored session from the active harness's store. */
  private loadAllSessions(): Promise<StoredSession[]> {
    if (this.isPi) void this.pruneOrphanCheckpointReposOnce();
    return this.isPi ? listPiSessions(this.workspacePath) : listSessions(this.workspacePath);
  }

  /**
   * Once per StorageManager, delete THIS workspace's checkpoint repos whose session file no longer
   * exists (US-013b). `deletePiSession` already removes a repo on explicit delete, so this only
   * reclaims repos orphaned out-of-band (file removed by another process or a prior crash). The sweep
   * is scoped to the workspace's own checkpoint subdir — a global sweep would delete OTHER workspaces'
   * repos, since the live set here is only this workspace's sessions. Runs off the session-list load
   * and never blocks it; the live set is the FULL on-disk session set, so pagination can't mis-prune.
   */
  private pruneOrphanCheckpointReposOnce(): Promise<void> {
    if (this.orphanReposPruned) return Promise.resolve();
    this.orphanReposPruned = true;
    return (async () => {
      try {
        const dir = ensurePiSessionDir(this.workspacePath);
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

  /** Load precise metadata for one session id from the active harness's store. */
  private async loadSessionMetadata(sessionId: string): Promise<StoredSession | null> {
    const meta = this.isPi
      ? await getPiSessionMetadata(this.workspacePath, sessionId)
      : await getSessionMetadata(this.workspacePath, sessionId);
    return meta ?? null;
  }

  async getStoredSessions(
    offset: number = 0,
    limit: number = SESSIONS_PAGE_SIZE,
    selectedSessionId?: string
  ): Promise<{ sessions: StoredSession[]; hasMore: boolean; nextOffset: number }> {
    if (!this.allSessionsCache) {
      this.allSessionsCache = await this.loadAllSessions();
    }

    const total = this.allSessionsCache.length;
    const sessions = this.allSessionsCache.slice(offset, offset + limit);
    const hasMore = offset + limit < total;
    const nextOffset = offset + sessions.length;

    if (selectedSessionId && !sessions.some((s) => s.id === selectedSessionId)) {
      const selectedSession = this.allSessionsCache.find((s) => s.id === selectedSessionId);
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
    if (!this.allSessionsCache) {
      this.allSessionsCache = await this.loadAllSessions();
    }

    if (!query.trim()) {
      return this.getStoredSessions(offset, SESSIONS_PAGE_SIZE, selectedSessionId);
    }

    const normalizedQuery = query.toLowerCase().trim();
    const allMatches = this.allSessionsCache.filter((session) => {
      const displayName = session.customTitle || session.aiTitle || session.preview;
      return displayName.toLowerCase().includes(normalizedQuery)
        || session.tag?.toLowerCase().includes(normalizedQuery);
    });

    const total = allMatches.length;
    const sessions = allMatches.slice(offset, offset + SESSIONS_PAGE_SIZE);
    const hasMore = offset + SESSIONS_PAGE_SIZE < total;
    const nextOffset = offset + sessions.length;

    return { sessions, hasMore, nextOffset };
  }

  invalidateSessionsCache(): void {
    this.allSessionsCache = null;
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

  async addOrUpdateSession(sessionId: string): Promise<void> {
    const metadata = await this.loadSessionMetadata(sessionId);
    if (!metadata) return;
    await this.upsertSessionInCache(metadata);
  }

  async getPromptHistory(
    offset: number = 0
  ): Promise<{ history: string[]; hasMore: boolean }> {
    if (!this.allSessionsCache) {
      this.allSessionsCache = await this.loadAllSessions();
    }

    if (!this.promptHistoryCache) {
      const allHistory = this.isPi
        ? await extractPiPromptHistory(this.workspacePath, this.allSessionsCache)
        : (await extractPromptHistory(this.workspacePath, this.allSessionsCache)).allHistory;
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

  async setupSessionWatcher(): Promise<void> {
    if (this.sessionWatcher) return;

    // pi writes to the Damocles-owned pi tree dir (created here so the watcher attaches even before
    // the first session); the SDK path watches the Claude projects dir and skips when it is absent.
    const sessionDir = this.isPi ? ensurePiSessionDir(this.workspacePath) : getSessionDirSync(this.workspacePath);

    try {
      await fs.promises.access(sessionDir);
    } catch {
      return;
    }

    const pattern = new vscode.RelativePattern(vscode.Uri.file(sessionDir), "*.jsonl");

    this.sessionWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.sessionWatcher.onDidCreate((uri) => this.handleSessionFileCreated(uri));
    this.sessionWatcher.onDidChange((uri) => this.handleSessionFileChanged(uri));
    this.sessionWatcher.onDidDelete((uri) => this.handleSessionFileDeleted(uri));
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
    this.sessionWatcher?.dispose();
    for (const timer of this.pendingChangeTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingChangeTimers.clear();
  }

  private async handleSessionFileCreated(uri: vscode.Uri): Promise<void> {
    if (this.isPi) return this.handlePiSessionFileUpsert(uri);

    const filename = path.basename(uri.fsPath);
    if (!filename.endsWith(".jsonl") || filename.startsWith("agent-")) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));

    const sessionId = filename.replace(".jsonl", "");
    const metadata = await getSessionMetadata(this.workspacePath, sessionId);

    if (!metadata) {
      return;
    }
    await this.upsertSessionInCache(metadata);
  }

  private handleSessionFileChanged(uri: vscode.Uri): void {
    if (this.isPi) return this.handlePiSessionFileChanged(uri);

    const filename = path.basename(uri.fsPath);
    if (!filename.endsWith(".jsonl") || filename.startsWith("agent-")) {
      return;
    }

    const sessionId = filename.replace(".jsonl", "");

    const existingTimer = this.pendingChangeTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.pendingChangeTimers.delete(sessionId);
      void this.processSessionChange(sessionId);
    }, CHANGE_DEBOUNCE_MS);

    this.pendingChangeTimers.set(sessionId, timer);
  }

  private async processSessionChange(sessionId: string): Promise<void> {
    const metadata = await getSessionMetadata(this.workspacePath, sessionId);

    if (!metadata) {
      return;
    }
    await this.upsertSessionInCache(metadata);
  }

  private async upsertSessionInCache(metadata: StoredSession): Promise<void> {
    if (!this.allSessionsCache) {
      this.allSessionsCache = await this.loadAllSessions();
    } else {
      const existingIndex = this.allSessionsCache.findIndex((s) => s.id === metadata.id);
      if (existingIndex >= 0) {
        const existing = this.allSessionsCache[existingIndex];
        if (existing?.isRecall && !metadata.isRecall) {
          log('[StorageManager] upsertSessionInCache: WARNING — overwriting isRecall=true with isRecall=false for %s', metadata.id);
        }
        this.allSessionsCache[existingIndex] = metadata;
      } else {
        this.allSessionsCache.push(metadata);
      }
      this.allSessionsCache.sort((a, b) => b.timestamp - a.timestamp);
    }
    this.pushSessionsToAllPanels();
  }

  private handleSessionFileDeleted(uri: vscode.Uri): void {
    if (this.isPi) return this.handlePiSessionFileDeleted(uri);

    const filename = path.basename(uri.fsPath);
    if (!filename.endsWith(".jsonl") || filename.startsWith("agent-")) {
      return;
    }

    const sessionId = filename.replace(".jsonl", "");

    const existingTimer = this.pendingChangeTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.pendingChangeTimers.delete(sessionId);
    }

    if (this.allSessionsCache) {
      this.allSessionsCache = this.allSessionsCache.filter((s) => s.id !== sessionId);
    }

    this.pushSessionsToAllPanels();
  }

  // ---- pi tree watcher handlers (FR-1) ------------------------------------
  // pi session files are named `<timestamp>_<id>.jsonl`, so the file base is NOT the session id and
  // metadata is read from the file itself; debounce timers are keyed by file path.

  private async handlePiSessionFileUpsert(uri: vscode.Uri): Promise<void> {
    if (!isPiSessionFile(uri.fsPath)) return;
    // Let pi finish writing the header before the first read.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const metadata = await getPiSessionMetadataByFile(uri.fsPath);
    if (!metadata) return;
    await this.upsertSessionInCache(metadata);
  }

  private handlePiSessionFileChanged(uri: vscode.Uri): void {
    if (!isPiSessionFile(uri.fsPath)) return;
    const key = uri.fsPath;
    const existingTimer = this.pendingChangeTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.pendingChangeTimers.delete(key);
      void this.processPiSessionChange(uri.fsPath);
    }, CHANGE_DEBOUNCE_MS);
    this.pendingChangeTimers.set(key, timer);
  }

  private async processPiSessionChange(filePath: string): Promise<void> {
    const metadata = await getPiSessionMetadataByFile(filePath);
    if (!metadata) return;
    await this.upsertSessionInCache(metadata);
  }

  private handlePiSessionFileDeleted(uri: vscode.Uri): void {
    if (!isPiSessionFile(uri.fsPath)) return;
    const key = uri.fsPath;
    const existingTimer = this.pendingChangeTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.pendingChangeTimers.delete(key);
    }
    const sessionId = piSessionIdFromFile(uri.fsPath);
    if (this.allSessionsCache) {
      this.allSessionsCache = this.allSessionsCache.filter((s) => s.id !== sessionId);
    }
    this.pushSessionsToAllPanels();
  }
}
