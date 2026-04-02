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
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import { SESSIONS_PAGE_SIZE, type HostInstance, type WebviewHost } from "./types";
import { log } from "../logger";

const CHANGE_DEBOUNCE_MS = 300;

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
  private readonly workspacePath: string;
  private readonly postMessage: StorageManagerConfig["postMessage"];
  private readonly getPanels: StorageManagerConfig["getPanels"];

  constructor(config: StorageManagerConfig) {
    this.workspacePath = config.workspacePath;
    this.postMessage = config.postMessage;
    this.getPanels = config.getPanels;
  }

  async getStoredSessions(
    offset: number = 0,
    limit: number = SESSIONS_PAGE_SIZE,
    selectedSessionId?: string
  ): Promise<{ sessions: StoredSession[]; hasMore: boolean; nextOffset: number }> {
    if (!this.allSessionsCache) {
      this.allSessionsCache = await listSessions(this.workspacePath);
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
      this.allSessionsCache = await listSessions(this.workspacePath);
    }

    if (!query.trim()) {
      return this.getStoredSessions(offset, SESSIONS_PAGE_SIZE, selectedSessionId);
    }

    const normalizedQuery = query.toLowerCase().trim();
    const allMatches = this.allSessionsCache.filter((session) => {
      const displayName = session.customTitle || session.preview;
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
    const metadata = await getSessionMetadata(this.workspacePath, sessionId);
    if (!metadata) return;
    await this.upsertSessionInCache(metadata);
  }

  async getPromptHistory(
    offset: number = 0
  ): Promise<{ history: string[]; hasMore: boolean }> {
    if (!this.allSessionsCache) {
      this.allSessionsCache = await listSessions(this.workspacePath);
    }

    if (!this.promptHistoryCache) {
      const result = await extractPromptHistory(this.workspacePath, this.allSessionsCache);
      const diskSet = new Set(result.allHistory);
      const uniquePending = this.pendingPromptEntries.filter((e) => !diskSet.has(e));
      this.promptHistoryCache = [...uniquePending, ...result.allHistory];
      this.pendingPromptEntries = uniquePending;
    }

    const PROMPT_HISTORY_PAGE_SIZE = 100;
    const pageItems = this.promptHistoryCache.slice(offset, offset + PROMPT_HISTORY_PAGE_SIZE);
    const hasMore = this.promptHistoryCache.length > offset + PROMPT_HISTORY_PAGE_SIZE;

    return { history: pageItems, hasMore };
  }

  async setupSessionWatcher(): Promise<void> {
    if (this.sessionWatcher) return;

    const sessionDir = getSessionDirSync(this.workspacePath);

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
      this.allSessionsCache = await listSessions(this.workspacePath);
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
}
