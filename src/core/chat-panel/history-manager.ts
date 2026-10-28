import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type { RestorePoint, RewindHistoryItem, SkippedFile, SkippedFilesTarget } from "../../shared/types/session";
import type { Result } from "../pi-session/checkpoints";
import type { ChatSession } from "../chat-session";
import type { PanelHost } from "../../platform/window-service";
import { loadPiSessionHistory, getPiRewindHistory, getPiFileCheckpointContent, getPiSkippedFiles, replaySessionFileReadOnly } from "../pi-session/session-store";
import { replayContext, replayLiveBranch, type ModelReasonsLookup, type ReplayContext } from "../pi-session/session-store/history-loader";

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
  // by the host replayed to: a panel's own host, or one view's of a panel several views show
  private readonly inflight = new Map<PanelHost, { readonly ctrl: AbortController; readonly done: Promise<void> }>();
  private readonly wiredHosts = new WeakSet<PanelHost>();

  constructor(config: HistoryManagerConfig) {
    this.postMessage = config.postMessage;
    this.maxCheckpointFileSizeBytes = config.maxCheckpointFileSizeBytes;
    this.modelReasons = config.modelReasons;
  }

  /**
   * Register a replay to `host`, aborting the earlier one to it, and, for a replay to a whole panel, every replay to one of
   * its views, which it reaches too; aborted when `host` is disposed. `finish` ends the registration.
   */
  private beginReplay(host: PanelHost): { ctrl: AbortController; finish: () => void } {
    for (const [other, prior] of this.inflight) {
      if (other !== host && other.panelHost !== host) continue;
      prior.ctrl.abort();
      this.inflight.delete(other);
    }

    const ctrl = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const entry = { ctrl, done };
    this.inflight.set(host, entry);

    if (!this.wiredHosts.has(host)) {
      this.wiredHosts.add(host);
      host.onDispose(() => {
        const c = this.inflight.get(host);
        if (c) {
          c.ctrl.abort();
          this.inflight.delete(host);
        }
      });
    }

    return {
      ctrl,
      finish: () => {
        if (this.inflight.get(host) === entry) this.inflight.delete(host);
        finish();
      },
    };
  }

  /** What a live replay reads asynchronously, loaded before the live conversation is captured. */
  liveReplayContext(): Promise<ReplayContext> {
    return replayContext(this.modelReasons?.());
  }

  /**
   * A joining view's replay of the conversation `session` holds, from the branch `liveConversation` captured; posts go to
   * `post`, never through the panel, whose own posts wait while the view joins, each once `host` took the ones before.
   */
  async replayLive(context: ReplayContext, cwd: string, session: ChatSession, host: PanelHost, post: (message: ExtensionToWebviewMessage) => void, live: NonNullable<ReturnType<ChatSession["liveConversation"]>>): Promise<void> {
    const paced = (): Promise<void> => host.drained?.() ?? Promise.resolve();
    await replayLiveBranch(context, cwd, live.sessionId, live.sessionManager, live.branch, post, session.fileCheckpoints, live.snapshot.liveToolCallIds, paced);
    for (const message of live.snapshot.messages) {
      await paced();
      post(message);
    }
    post({ type: "sessionStarted", sessionId: live.sessionId, stored: live.stored });
    // The joining view's store has no account state, and the replay contract carries none.
    session.publishAccountInfo();
  }

  /** Resolves to the session's rewindable user entry ids, read in the same pass as the replay, or null when its file was not read. */
  async loadSessionHistory(cwd: string, sessionId: string, host: PanelHost, session: ChatSession): Promise<string[] | null> {
    // a view's replay starts after its panel's, which posts into that view too, so the two never interleave there
    const panel = host.panelHost;
    if (panel) for (let pending = this.inflight.get(panel); pending; pending = this.inflight.get(panel)) await pending.done;
    const { ctrl, finish } = this.beginReplay(host);

    // The pi tree-store loader emits sessionCleared itself. The fork-prefix path is unused
    // on pi — a forked panel resumes an already-truncated branched session file (US-013c).
    let rewindableIds: string[] | null;
    try {
      rewindableIds = await loadPiSessionHistory(cwd, sessionId, (m) => this.postMessage(host, m), ctrl.signal, this.modelReasons?.(), session.fileCheckpoints, () => host.drained?.() ?? Promise.resolve());
    } finally {
      finish();
    }
    // The replay contract carries no account state, and a restored panel may never run a turn.
    session.publishAccountInfo();
    // A newer replay posts its own, and a replay that read no file rebuilt no card.
    if (rewindableIds !== null && !ctrl.signal.aborted) session.replayLiveAgents(sessionId);
    return rewindableIds;
  }

  /** A mirrored session file's replay for a read-only transcript view; resolves whether the file was read. */
  replayTranscript(filePath: string, sessionId: string, post: (message: ExtensionToWebviewMessage) => void, signal: AbortSignal): Promise<boolean> {
    return replaySessionFileReadOnly(filePath, sessionId, post, signal, this.modelReasons?.());
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
