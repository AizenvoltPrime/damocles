import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import type { StoredSession } from "../../shared/types/session";
import {
  ensurePiSessionDir,
  listPiSessions,
  getPiSessionMetadata,
  getPiSessionMetadataByFile,
  piSessionIdFromFile,
  extractPiPromptHistory,
  resolvePiSessionFile,
} from "../pi-session/session-store";
import { pruneOrphanCheckpointRepos, getCheckpointsBaseDir, getWorkspaceCheckpointDir } from "../pi-session/checkpoints";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import { SESSIONS_PAGE_SIZE, type HostInstance, type WebviewHost } from "./types";
import type { FolderTarget } from "../workspace-folders/folder-registry";
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
  /** Every open folder; the history lists the sessions of all of them. */
  folders: () => readonly FolderTarget[];
  isMultiRoot: () => boolean;
  postMessage: (host: WebviewHost, message: ExtensionToWebviewMessage) => void;
  getPanels: () => Map<string, HostInstance>;
}

const newestFirst = (a: StoredSession, b: StoredSession): number => b.timestamp - a.timestamp;

export class StorageManager {
  private allSessionsCache: StoredSession[] | null = null;
  private promptHistoryCache: string[] | null = null;
  private pendingPromptEntries: string[] = [];
  /** Folder key to that folder's session-dir watcher. */
  private readonly sessionWatchers = new Map<string, vscode.FileSystemWatcher>();
  private pendingChangeTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly prunedFolders = new Set<string>();
  /** Session id to the key of the folder whose session dir holds it. */
  private sessionFolder = new Map<string, string>();
  private readonly folders: StorageManagerConfig["folders"];
  private readonly isMultiRoot: StorageManagerConfig["isMultiRoot"];
  private readonly postMessage: StorageManagerConfig["postMessage"];
  private readonly getPanels: StorageManagerConfig["getPanels"];

  constructor(config: StorageManagerConfig) {
    this.folders = config.folders;
    this.isMultiRoot = config.isMultiRoot;
    this.postMessage = config.postMessage;
    this.getPanels = config.getPanels;
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
    const all = perFolder.flat();
    this.sessionFolder = new Map(all.map((s) => [s.id, s.workspaceFolder!.key]));
    return all.sort(newestFirst);
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
    // Sessions carry a visible folder label only with two or more folders open; otherwise every one would match.
    const matchFolder = this.isMultiRoot();
    const allMatches = this.allSessionsCache.filter((session) => {
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
    this.allSessionsCache = await this.loadAllSessions();
    this.pushSessionsToAllPanels();
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

  async addOrUpdateSession(sessionId: string, folderKey: string): Promise<void> {
    const folder = this.openFolder(folderKey);
    if (!folder) return;
    const metadata = await getPiSessionMetadata(folder.fsPath, sessionId);
    if (!metadata) return;
    this.sessionFolder.set(sessionId, folder.key);
    await this.upsertSessionInCache(this.stamp(metadata, folder));
  }

  async getPromptHistory(
    offset: number = 0
  ): Promise<{ history: string[]; hasMore: boolean }> {
    if (!this.allSessionsCache) {
      this.allSessionsCache = await this.loadAllSessions();
    }

    if (!this.promptHistoryCache) {
      const allHistory = await extractPiPromptHistory(this.folders().map((t) => t.fsPath), this.allSessionsCache);
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

    const pattern = new vscode.RelativePattern(vscode.Uri.file(sessionDir), "*.jsonl");
    const key = folder.key;
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate((uri) => this.handleSessionFileCreated(uri, key));
    watcher.onDidChange((uri) => this.handleSessionFileChanged(uri, key));
    watcher.onDidDelete((uri) => this.handleSessionFileDeleted(uri));
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
  }

  private async handleSessionFileCreated(uri: vscode.Uri, folderKey: string): Promise<void> {
    return this.handlePiSessionFileUpsert(uri, folderKey);
  }

  private handleSessionFileChanged(uri: vscode.Uri, folderKey: string): void {
    return this.handlePiSessionFileChanged(uri, folderKey);
  }

  private async upsertSessionInCache(metadata: StoredSession): Promise<void> {
    if (!this.allSessionsCache) {
      this.allSessionsCache = await this.loadAllSessions();
    } else {
      const existingIndex = this.allSessionsCache.findIndex((s) => s.id === metadata.id);
      if (existingIndex >= 0) {
        this.allSessionsCache[existingIndex] = metadata;
      } else {
        this.allSessionsCache.push(metadata);
      }
      this.allSessionsCache.sort(newestFirst);
    }
    this.pushSessionsToAllPanels();
  }

  private handleSessionFileDeleted(uri: vscode.Uri): void {
    return this.handlePiSessionFileDeleted(uri);
  }

  // ---- pi tree watcher handlers (FR-1) ------------------------------------
  // pi session files are named `<timestamp>_<id>.jsonl`, so the file base is NOT the session id and
  // metadata is read from the file itself; debounce timers are keyed by file path.

  private async handlePiSessionFileUpsert(uri: vscode.Uri, folderKey: string): Promise<void> {
    if (!isPiSessionFile(uri.fsPath)) return;
    // Let pi finish writing the header before the first read.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await this.upsertFromFile(uri.fsPath, folderKey);
  }

  /** Dropped when the folder left the workspace while the read was pending. */
  private async upsertFromFile(filePath: string, folderKey: string): Promise<void> {
    const metadata = await getPiSessionMetadataByFile(filePath);
    const folder = this.openFolder(folderKey);
    if (!metadata || !folder) return;
    this.sessionFolder.set(metadata.id, folder.key);
    await this.upsertSessionInCache(this.stamp(metadata, folder));
  }

  private handlePiSessionFileChanged(uri: vscode.Uri, folderKey: string): void {
    if (!isPiSessionFile(uri.fsPath)) return;
    const key = uri.fsPath;
    const existingTimer = this.pendingChangeTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.pendingChangeTimers.delete(key);
      void this.upsertFromFile(uri.fsPath, folderKey);
    }, CHANGE_DEBOUNCE_MS);
    this.pendingChangeTimers.set(key, timer);
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
    this.sessionFolder.delete(sessionId);
    if (this.allSessionsCache) {
      this.allSessionsCache = this.allSessionsCache.filter((s) => s.id !== sessionId);
    }
    this.pushSessionsToAllPanels();
  }
}
