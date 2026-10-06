import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type { RestorePoint, RewindHistoryItem, SkippedFile, SkippedFilesTarget } from "../../shared/types/session";
import type { Result } from "../pi-session/checkpoints";
import type { ChatSession } from "../chat-session";
import type { PanelHost } from "../../platform/window-service";
import { loadPiSessionHistory, getPiRewindHistory, getPiFileCheckpointContent, getPiSkippedFiles } from "../pi-session/session-store";
import type { ModelReasonsLookup } from "../pi-session/session-store/history-loader";

export interface HistoryManagerConfig {
  postMessage: (host: PanelHost, message: ExtensionToWebviewMessage) => void;
  /** The checkpoint size cap in bytes, so the rewind preview protects the files the restore protects. */
  maxCheckpointFileSizeBytes: () => number;
  /** Resolves the registry lookup a replayed reply's effort is published under, as the live rule does. */
  modelReasons?: () => Promise<ModelReasonsLookup | undefined>;
}

/** Every read takes as `cwd` the folder whose session dir holds the session. */
export class HistoryManager {
  private readonly postMessage: HistoryManagerConfig["postMessage"];
  private readonly maxCheckpointFileSizeBytes: HistoryManagerConfig["maxCheckpointFileSizeBytes"];
  private readonly modelReasons: HistoryManagerConfig["modelReasons"];
  private readonly inflight = new Map<PanelHost, AbortController>();
  private readonly wiredHosts = new WeakSet<PanelHost>();

  constructor(config: HistoryManagerConfig) {
    this.postMessage = config.postMessage;
    this.maxCheckpointFileSizeBytes = config.maxCheckpointFileSizeBytes;
    this.modelReasons = config.modelReasons;
  }

  /**
   * Register a fresh AbortController for `host`, aborting any prior in-flight
   * load on the same host and wiring `onDidDispose` to abort on disposal.
   */
  private beginReplay(host: PanelHost): AbortController {
    const prior = this.inflight.get(host);
    if (prior) prior.abort();

    const ctrl = new AbortController();
    this.inflight.set(host, ctrl);

    if (!this.wiredHosts.has(host)) {
      this.wiredHosts.add(host);
      host.onDispose(() => {
        const c = this.inflight.get(host);
        if (c) {
          c.abort();
          this.inflight.delete(host);
        }
      });
    }

    return ctrl;
  }

  /** Resolves to the session's rewindable user entry ids, read in the same pass as the replay, or null when its file was not read. */
  async loadSessionHistory(cwd: string, sessionId: string, host: PanelHost, session: ChatSession): Promise<string[] | null> {
    const ctrl = this.beginReplay(host);

    // The pi tree-store loader emits sessionCleared itself. The fork-prefix path is unused
    // on pi — a forked panel resumes an already-truncated branched session file (US-013c).
    const rewindableIds = await loadPiSessionHistory(cwd, sessionId, (m) => this.postMessage(host, m), ctrl.signal, this.modelReasons?.(), session.fileCheckpoints);
    if (this.inflight.get(host) === ctrl) this.inflight.delete(host);
    // The replay contract carries no account state, and a restored panel may never run a turn.
    session.publishAccountInfo();
    return rewindableIds;
  }

  async extractRewindHistory(cwd: string, sessionId: string, fileCheckpoints: boolean): Promise<{ items: RewindHistoryItem[]; restorePoints: RestorePoint[] }> {
    return getPiRewindHistory(cwd, sessionId, this.maxCheckpointFileSizeBytes(), fileCheckpoints);
  }

  /** The full list of files a checkpoint or restore point left out, read from its manifest without the folder lock. */
  async readSkippedFiles(cwd: string, sessionId: string, target: SkippedFilesTarget): Promise<Result<SkippedFile[]>> {
    return getPiSkippedFiles(cwd, sessionId, target);
  }

  async getFileCheckpointContent(
    cwd: string,
    sessionId: string,
    userMessageId: string,
    filePath: string,
  ): Promise<string | null> {
    return getPiFileCheckpointContent(cwd, sessionId, userMessageId, filePath);
  }
}
