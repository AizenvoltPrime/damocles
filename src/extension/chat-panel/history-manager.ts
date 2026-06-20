import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type { RewindHistoryItem } from "../../shared/types/session";
import { log } from "../logger";
import type { WebviewHost } from "./types";
import { loadPiSessionHistory, getPiRewindableUserIds, getPiRewindHistory, getPiFileCheckpointContent } from "../pi-session/session-store";

export interface HistoryManagerConfig {
  workspacePath: string;
  postMessage: (host: WebviewHost, message: ExtensionToWebviewMessage) => void;
}

export class HistoryManager {
  private readonly workspacePath: string;
  private readonly postMessage: HistoryManagerConfig["postMessage"];
  private readonly inflight = new Map<WebviewHost, AbortController>();
  private readonly wiredHosts = new WeakSet<WebviewHost>();

  constructor(config: HistoryManagerConfig) {
    this.workspacePath = config.workspacePath;
    this.postMessage = config.postMessage;
  }

  /**
   * Register a fresh AbortController for `host`, aborting any prior in-flight
   * load on the same host and wiring `onDidDispose` to abort on disposal.
   */
  private beginReplay(host: WebviewHost): AbortController {
    const prior = this.inflight.get(host);
    if (prior) prior.abort();

    const ctrl = new AbortController();
    this.inflight.set(host, ctrl);

    if (!this.wiredHosts.has(host)) {
      this.wiredHosts.add(host);
      host.onDidDispose(() => {
        const c = this.inflight.get(host);
        if (c) {
          c.abort();
          this.inflight.delete(host);
        }
      });
    }

    return ctrl;
  }

  async loadSessionHistory(sessionId: string, host: WebviewHost): Promise<void> {
    const ctrl = this.beginReplay(host);
    const t0 = Date.now();

    // The pi tree-store loader emits sessionCleared itself. The fork-prefix path is unused
    // on pi — a forked panel resumes an already-truncated branched session file (US-013c).
    await loadPiSessionHistory(this.workspacePath, sessionId, (m) => this.postMessage(host, m), ctrl.signal);
    if (this.inflight.get(host) === ctrl) this.inflight.delete(host);
    log(`[history] pi full-load ${sessionId} in ${Date.now() - t0}ms`);
  }

  async extractRewindableUserIds(sessionId: string): Promise<string[]> {
    return getPiRewindableUserIds(this.workspacePath, sessionId);
  }

  async extractRewindHistory(sessionId: string): Promise<RewindHistoryItem[]> {
    return getPiRewindHistory(this.workspacePath, sessionId);
  }

  async getFileCheckpointContent(
    sessionId: string,
    userMessageId: string,
    filePath: string,
  ): Promise<string | null> {
    return getPiFileCheckpointContent(this.workspacePath, sessionId, userMessageId, filePath);
  }
}
