import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { WebviewHost } from "../../types";
import type { CpuFallbackEvent, IncomingTtsChunk, SidecarManagerStatus, SidecarOutbound, TtsUnloadedEvent } from "../../../voice/sidecar";
import { log } from "../../../logger";
import {
  cleanupOldVersions,
  compareInstalled,
  downloadModel,
  loadManifest,
} from "../../../voice/models";
import type { VoiceModelManifest, ModelEntry, OutdatedModelEntry } from "../../../voice/models";

const VOICE_PINNED_VERSIONS_KEY = "voice.pinModelVersion";

function getPinnedVersions(): Record<string, string> {
  const cfg = vscode.workspace.getConfiguration("damocles");
  return cfg.get<Record<string, string>>(VOICE_PINNED_VERSIONS_KEY, {}) ?? {};
}

function totalBytes(entry: ModelEntry): number {
  return entry.files.reduce((acc, f) => acc + (f.bytes ?? 0), 0);
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      total += await dirSize(full);
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(full);
        total += stat.size;
      } catch {
        // file disappeared between readdir and stat — fine
      }
    }
  }
  return total;
}

async function emitVoiceFilesSize(
  postMessage: (host: WebviewHost, msg: { type: "voiceFilesSizeUpdate"; bytes: number }) => void,
  host: WebviewHost,
  voiceRoot: string,
): Promise<void> {
  try {
    const bytes = await dirSize(voiceRoot);
    postMessage(host, { type: "voiceFilesSizeUpdate", bytes });
  } catch (err) {
    log("[VoiceStreamHandlers] voiceFilesSizeUpdate emit failed:", err);
  }
}

function buildUpgradeNotification(outdated: OutdatedModelEntry[]): {
  modelId: string;
  description: string;
  installedVersion: string;
  newVersion: string;
  bytesDelta: number;
  totalBytes: number;
  licenseUrl: string;
  license: string;
  gated: boolean;
}[] {
  return outdated.map((entry) => ({
    modelId: entry.id,
    description: entry.description,
    installedVersion: entry.installedVersion,
    newVersion: entry.version,
    bytesDelta: totalBytes(entry),
    totalBytes: totalBytes(entry),
    licenseUrl: entry.license_url,
    license: entry.license,
    gated: entry.gated,
  }));
}

// MUST stay byte-identical to ``WAKE_PREFIX_RE`` in
// python/damocles_voice_sidecar/damocles_voice_sidecar/pipeline.py:45.
// The two-layer FR-11 defense intentionally runs both passes; a silent
// drift between them (e.g. one accepts a prefix the other doesn't)
// would let a wake phrase reach the model. The vitest in
// src/extension/voice/__tests__/wake-prefix-parity.test.ts reads both
// files as text and asserts the literals match — keep that test green.
const WAKE_PREFIX_RE = /^\s*(hey\s+)?jarvis[,.\s]*/i;

type TurnPhase = "idle" | "vad-active";

export type VoiceStreamHandlersResult = {
  handlers: Partial<HandlerRegistry>;
  markUserTypedDuringTurn: () => void;
};

export function createVoiceStreamHandlers(
  deps: HandlerDependencies,
): VoiceStreamHandlersResult {
  const { postMessage, voiceService, context } = deps;
  let attachedClientRelease: (() => void) | null = null;
  let userTypedSinceWake = false;
  let activeHost: WebviewHost | null = null;
  let turnPhase: TurnPhase = "idle";
  let currentDownloadAbort: AbortController | null = null;

  async function runDownloadSession(
    body: (signal: AbortSignal) => Promise<void>,
  ): Promise<{ aborted: boolean }> {
    if (currentDownloadAbort !== null) currentDownloadAbort.abort();
    const controller = new AbortController();
    currentDownloadAbort = controller;
    try {
      await body(controller.signal);
      return { aborted: controller.signal.aborted };
    } catch (err) {
      if (controller.signal.aborted) return { aborted: true };
      throw err;
    } finally {
      if (currentDownloadAbort === controller) currentDownloadAbort = null;
    }
  }

  async function downloadAllMissing(host: WebviewHost): Promise<void> {
    if (voiceService === undefined) {
      postMessage(host, {
        type: "voiceModelDownloadProgress",
        modelId: "*",
        bytesReceived: 0,
        bytesTotal: 0,
        status: "error",
        message: "Voice runtime not configured",
      });
      return;
    }
    const paths = voiceService.getPaths();
    const extensionRoot = context.extensionUri.fsPath;
    let manifest: VoiceModelManifest;
    try {
      manifest = await loadManifest(extensionRoot);
    } catch (err) {
      postMessage(host, {
        type: "voiceModelDownloadProgress",
        modelId: "*",
        bytesReceived: 0,
        bytesTotal: 0,
        status: "error",
        message: err instanceof Error ? err.message : "Failed to load manifest",
      });
      return;
    }
    if (manifest.status === "placeholder-checksums") {
      log("[VoiceStreamHandlers] Manifest declares placeholder-checksums; downloads will still SHA-256 verify against whatever is recorded.");
    }
    const compare = await compareInstalled(paths.modelsDir, manifest);
    const targets: ModelEntry[] = [...compare.missing, ...compare.outdated];
    const session = await runDownloadSession(async (signal) => {
      for (const entry of targets) {
        try {
          const result = await downloadModel({
            entry,
            modelsRoot: paths.modelsDir,
            acceptLicense: !entry.gated,
            signal,
            onProgress: (p) => {
              postMessage(host, {
                type: "voiceModelDownloadProgress",
                modelId: p.modelId,
                bytesReceived: p.bytesReceived,
                bytesTotal: p.bytesTotal,
                status: p.status,
                ...(p.message !== undefined ? { message: p.message } : {}),
              });
            },
          });
          if (result.status === "license-required") {
            postMessage(host, {
              type: "voiceModelDownloadProgress",
              modelId: result.modelId,
              bytesReceived: 0,
              bytesTotal: 0,
              status: "error",
              message: `License acceptance required: ${result.licenseUrl}`,
            });
          }
        } catch (err) {
          if (signal.aborted) return;
          postMessage(host, {
            type: "voiceModelDownloadProgress",
            modelId: entry.id,
            bytesReceived: 0,
            bytesTotal: 0,
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }
    });
    if (!session.aborted) postMessage(host, { type: "voiceModelDownloadAllDone" });
  }

  function broadcastSidecar(host: WebviewHost, msg: SidecarOutbound): void {
    if (msg.type === "wake_detected") {
      userTypedSinceWake = false;
      turnPhase = "idle";
      postMessage(host, { type: "voiceWakeDetected", confidence: msg.confidence });
      return;
    }
    if (msg.type === "wake_aborted") {
      turnPhase = "idle";
      postMessage(host, { type: "voiceWakeAborted", reason: msg.reason });
      return;
    }
    if (msg.type === "vad_speech_started") {
      turnPhase = "vad-active";
      postMessage(host, { type: "voiceVadStarted" });
      return;
    }
    if (msg.type === "vad_speech_ended") {
      postMessage(host, { type: "voiceVadEnded" });
      return;
    }
    if (msg.type === "transcript_final") {
      turnPhase = "idle";
      const cleaned = msg.text.replace(WAKE_PREFIX_RE, "").trim();
      if (userTypedSinceWake) {
        log("[VoiceStreamHandlers] discarding voice transcript — user typed during turn");
        userTypedSinceWake = false;
        return;
      }
      postMessage(host, {
        type: "voiceTranscriptFinal",
        text: cleaned,
        durationMs: msg.duration_ms,
      });
      return;
    }
    if (msg.type === "ready") {
      postMessage(host, {
        type: "voiceSidecarStatus",
        state: "ready",
        device: msg.device,
        vramMbFree: msg.vram_mb_free,
        modelsLoaded: msg.models_loaded,
      });
      return;
    }
    if (msg.type === "tts_done") {
      // Webview's voiceTtsDone handler clears its "speaking" UI;
      // without this bridge the playback indicator stays on after
      // the last chunk and the input mic looks busy until next turn.
      postMessage(host, { type: "voiceTtsDone" });
      return;
    }
    if (msg.type === "error") {
      postMessage(host, {
        type: "voiceSidecarStatus",
        state: "error",
        message: msg.message,
      });
      return;
    }
  }

  // Listeners are lifted into named handles so dispose can detach them.
  // Extension activation/deactivation cycles (HMR, tests, multi-instance
  // workspace reload) would otherwise leak one set per cycle, with each
  // captured `activeHost` keeping a stale postMessage closure alive.
  type FirstRunEvt = { reason: "missing-runtime" | "missing-models" | "first-time" };

  const onStatus = (status: SidecarManagerStatus): void => {
    if (activeHost === null) return;
    if (status.kind === "ready") {
      postMessage(activeHost, {
        type: "voiceSidecarStatus",
        state: "ready",
        device: status.device,
        vramMbFree: status.vramMbFree,
        modelsLoaded: status.modelsLoaded,
      });
    } else if (status.kind === "loading") {
      postMessage(activeHost, {
        type: "voiceSidecarStatus",
        state: "loading",
        message: status.message,
      });
    } else if (status.kind === "stopped") {
      postMessage(activeHost, { type: "voiceSidecarStatus", state: "stopped" });
    } else if (status.kind === "restarting") {
      if (turnPhase === "vad-active") {
        turnPhase = "idle";
        postMessage(activeHost, { type: "voiceTurnLost", reason: "sidecar-crash" });
      }
      postMessage(activeHost, {
        type: "voiceSidecarStatus",
        state: "restarting",
        message: `restart attempt ${status.attempt}`,
      });
    } else if (status.kind === "error") {
      postMessage(activeHost, {
        type: "voiceSidecarStatus",
        state: "error",
        message: status.message,
      });
    } else if (status.kind === "cpu-fallback") {
      if (turnPhase === "vad-active") {
        turnPhase = "idle";
        postMessage(activeHost, { type: "voiceTurnLost", reason: "sidecar-crash" });
      }
      postMessage(activeHost, {
        type: "voiceSidecarStatus",
        state: "restarting",
        message: "switching to CPU after CUDA OOM",
      });
    }
  };
  const onMessage = (msg: SidecarOutbound): void => {
    if (activeHost !== null) broadcastSidecar(activeHost, msg);
  };
  const onTtsChunk = (chunk: IncomingTtsChunk): void => {
    if (activeHost === null) {
      log(`[VoiceStreamHandlers] tts chunk dropped: no active host (req=${chunk.request_id} bytes=${chunk.pcm.byteLength})`);
      return;
    }
    log(`[VoiceStreamHandlers] forwarding tts chunk: req=${chunk.request_id} bytes=${chunk.pcm.byteLength} sr=${chunk.sample_rate}`);
    postMessage(activeHost, {
      type: "voiceTtsAudioChunk",
      chunkBase64: chunk.pcm.toString("base64"),
      sampleRate: chunk.sample_rate,
    });
  };
  const onFirstRunRequired = (info: FirstRunEvt): void => {
    if (activeHost === null) return;
    postMessage(activeHost, { type: "voiceFirstRunRequired", reason: info.reason });
  };
  const onCpuFallback = (event: CpuFallbackEvent): void => {
    if (activeHost === null) return;
    postMessage(activeHost, { type: "voiceCpuFallbackActive", reason: event.reason });
  };
  const onTtsUnloaded = (event: TtsUnloadedEvent): void => {
    if (activeHost === null) return;
    postMessage(activeHost, { type: "voiceCpuFallbackActive", reason: event.reason });
  };

  if (voiceService !== undefined) {
    voiceService.on("status", onStatus);
    voiceService.on("message", onMessage);
    voiceService.on("ttsChunk", onTtsChunk);
    voiceService.on("firstRunRequired", onFirstRunRequired);
    voiceService.on("cpuFallback", onCpuFallback);
    voiceService.on("ttsUnloaded", onTtsUnloaded);
    context.subscriptions.push({
      dispose: (): void => {
        voiceService.off("status", onStatus);
        voiceService.off("message", onMessage);
        voiceService.off("ttsChunk", onTtsChunk);
        voiceService.off("firstRunRequired", onFirstRunRequired);
        voiceService.off("cpuFallback", onCpuFallback);
        voiceService.off("ttsUnloaded", onTtsUnloaded);
        if (attachedClientRelease !== null) {
          attachedClientRelease();
          attachedClientRelease = null;
        }
        if (currentDownloadAbort !== null) {
          currentDownloadAbort.abort();
          currentDownloadAbort = null;
        }
      },
    });
  }

  const handlers: Partial<HandlerRegistry> = {
    voiceStreamEnable: async (_msg, ctx) => {
      activeHost = ctx.host;
      if (voiceService === undefined) {
        log("[VoiceStreamHandlers] voiceService not configured; ignoring enable");
        return;
      }
      attachedClientRelease = voiceService.attachClient();
      if (!voiceService.isReady()) {
        await voiceService.start();
      }
      try {
        const paths = voiceService.getPaths();
        const manifest = await loadManifest(context.extensionUri.fsPath);
        const compare = await compareInstalled(paths.modelsDir, manifest, { pinned: getPinnedVersions() });
        if (compare.outdated.length > 0) {
          postMessage(ctx.host, {
            type: "voiceModelUpgradeAvailable",
            upgrades: buildUpgradeNotification(compare.outdated),
          });
        }
      } catch (err) {
        log("[VoiceStreamHandlers] upgrade check failed:", err);
      }
    },

    voiceStreamDisable: () => {
      if (attachedClientRelease !== null) {
        attachedClientRelease();
        attachedClientRelease = null;
      }
      activeHost = null;
    },

    voiceAcceptFirstRunModal: async (_msg, ctx) => {
      // Webview accepted the privacy disclosure. Trigger the bundle
      // download so the next start() finds runtime + models in place.
      // Mirrors the runtime install path used by the manual
      // "Re-download models" button.
      await downloadAllMissing(ctx.host);
    },

    voiceCancelFirstRunModal: async () => {
      // User declined the disclosure: revert mode to push-to-talk so
      // the panel doesn't keep firing firstRunRequired on every start.
      const cfg = vscode.workspace.getConfiguration("damocles");
      try {
        await cfg.update("voice.mode", "push-to-talk", vscode.ConfigurationTarget.Global);
      } catch (err) {
        log("[VoiceStreamHandlers] revert voice.mode after first-run cancel failed:", err);
      }
    },

    voiceStreamMute: (msg) => {
      if (msg.type !== "voiceStreamMute") return;
      if (voiceService === undefined) return;
      voiceService.setMuted(msg.muted);
    },

    voiceTestVoice: async (_msg, ctx) => {
      if (voiceService === undefined) {
        postMessage(ctx.host, {
          type: "voiceSidecarStatus",
          state: "error",
          message: "Voice runtime not configured",
        });
        return;
      }
      const ttsEnabled = vscode.workspace.getConfiguration("damocles").get<boolean>("voice.tts.enabled", false);
      if (!ttsEnabled) {
        postMessage(ctx.host, {
          type: "voiceSidecarStatus",
          state: "error",
          message: "Enable TTS first to test the voice.",
        });
        return;
      }
      if (!voiceService.isReady()) {
        try {
          await voiceService.start();
        } catch (err) {
          log("[VoiceStreamHandlers] test-voice start failed:", err);
          postMessage(ctx.host, {
            type: "voiceSidecarStatus",
            state: "error",
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }
      if (!voiceService.isReady()) {
        postMessage(ctx.host, {
          type: "voiceSidecarStatus",
          state: "error",
          message: "Voice runtime did not become ready.",
        });
        return;
      }
      const reqId = randomUUID();
      log(`[VoiceStreamHandlers] voiceTestVoice: dispatching ttsRequest req=${reqId}`);
      voiceService.ttsRequest(reqId, "Hello. This is your on-device voice assistant.");
    },

    voiceWebviewMicUnavailable: (msg, ctx) => {
      if (msg.type !== "voiceWebviewMicUnavailable") return;
      log(`[VoiceStreamHandlers] webview mic unavailable: ${msg.reason}`);
      postMessage(ctx.host, { type: "voiceMicUnavailable", reason: msg.reason });
      if (voiceService !== undefined && msg.reason !== "denied") {
        voiceService.stop().catch((err) => log("[VoiceStreamHandlers] stop on mic-unavailable failed:", err));
      }
    },

    setVoiceTtsVoice: async (msg, ctx) => {
      if (msg.type !== "setVoiceTtsVoice") return;
      // Persist the setting first — this is the source of truth the
      // sidecar reads at next __init__ even if hot-swap fails or the
      // sidecar isn't alive.
      await deps.settingsManager.setVoiceTtsVoice(msg.voice);
      await deps.settingsManager.sendVoiceConfig(ctx.host);

      if (voiceService === undefined) return;
      const paths = voiceService.getPaths();

      // Locate the manifest entry for vibevoice and the expected
      // prefill path. If the entry isn't shipped (older manifest) we
      // skip the prefetch — the engine's manifest-validated resolver
      // will catch any mismatch.
      let manifest: VoiceModelManifest;
      try {
        manifest = await loadManifest(context.extensionUri.fsPath);
      } catch (err) {
        log("[VoiceStreamHandlers] setVoiceTtsVoice manifest load failed:", err);
        return;
      }
      const entry = manifest.models.find((m) => m.id === "vibevoice_realtime_0_5b");
      if (entry === undefined) return;
      const versionDir = join(paths.modelsDir, entry.id, `v${entry.version}`);
      const filename = `${msg.voice}.pt`;
      const prefillPath = join(versionDir, filename);

      let needsFetch = false;
      try {
        await fs.access(prefillPath);
      } catch {
        needsFetch = true;
      }

      if (needsFetch) {
        // Idempotent: downloadModel walks every file in entry.files,
        // skips ones already on disk, fetches only the missing voice.
        // ~4 MB per voice; reuses the existing progress message channel.
        await runDownloadSession(async (signal) => {
          await downloadModel({
            entry,
            modelsRoot: paths.modelsDir,
            acceptLicense: !entry.gated,
            signal,
            onProgress: (p) => {
              postMessage(ctx.host, {
                type: "voiceModelDownloadProgress",
                modelId: p.modelId,
                bytesReceived: p.bytesReceived,
                bytesTotal: p.bytesTotal,
                status: p.status,
                ...(p.message !== undefined ? { message: p.message } : {}),
              });
            },
          });
        });
      }

      // Hot-swap if the sidecar is alive; otherwise the persisted
      // setting will be picked up at next start. Either way we never
      // restart the sidecar for a voice change.
      const swapped = voiceService.setTtsVoice(msg.voice);
      log(`[VoiceStreamHandlers] setVoiceTtsVoice: voice=${msg.voice} prefetched=${needsFetch} hotswap=${swapped}`);
    },

    voiceAcceptModelUpgrade: async (msg, ctx) => {
      if (msg.type !== "voiceAcceptModelUpgrade") return;
      if (voiceService === undefined) return;
      const paths = voiceService.getPaths();
      let manifest: VoiceModelManifest;
      try {
        manifest = await loadManifest(context.extensionUri.fsPath);
      } catch (err) {
        log("[VoiceStreamHandlers] upgrade-accept manifest load failed:", err);
        return;
      }
      const allow = new Set(msg.modelIds);
      const targets = manifest.models.filter((entry) => allow.has(entry.id));
      const session = await runDownloadSession(async (signal) => {
        for (const entry of targets) {
          try {
            await downloadModel({
              entry,
              modelsRoot: paths.modelsDir,
              acceptLicense: !entry.gated,
              signal,
              onProgress: (p) => {
                postMessage(ctx.host, {
                  type: "voiceModelDownloadProgress",
                  modelId: p.modelId,
                  bytesReceived: p.bytesReceived,
                  bytesTotal: p.bytesTotal,
                  status: p.status,
                  ...(p.message !== undefined ? { message: p.message } : {}),
                });
              },
            });
          } catch (err) {
            if (signal.aborted) return;
            postMessage(ctx.host, {
              type: "voiceModelDownloadProgress",
              modelId: entry.id,
              bytesReceived: 0,
              bytesTotal: 0,
              status: "error",
              message: err instanceof Error ? err.message : String(err),
            });
            return;
          }
        }
      });
      if (session.aborted) return;
      postMessage(ctx.host, { type: "voiceModelDownloadAllDone" });
      if (voiceService.isReady()) {
        await voiceService.stop();
        await voiceService.start();
      }
    },

    voiceDismissModelUpgrade: () => {
      // Webview-driven; no host-side state to clear.
    },

    voiceCancelModelDownload: (_msg, ctx) => {
      currentDownloadAbort?.abort();
      postMessage(ctx.host, { type: "voiceModelDownloadCancelled" });
    },

    voiceRedownloadModels: async (_msg, ctx) => {
      await downloadAllMissing(ctx.host);
    },

    voiceOpenModelsFolder: async (_msg, ctx) => {
      if (voiceService === undefined) return;
      const modelsDir = voiceService.getPaths().modelsDir;
      try {
        await fs.mkdir(modelsDir, { recursive: true });
        await vscode.env.openExternal(vscode.Uri.file(modelsDir));
      } catch (err) {
        log("[VoiceStreamHandlers] openModelsFolder failed:", err);
        postMessage(ctx.host, {
          type: "voiceSidecarStatus",
          state: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },

    voiceFreeDiskSpace: async (_msg, ctx) => {
      if (voiceService === undefined) return;
      const paths = voiceService.getPaths();
      try {
        const manifest = await loadManifest(context.extensionUri.fsPath);
        const result = await cleanupOldVersions(paths.modelsDir, manifest);
        const mb = (result.bytesFreed / 1024 / 1024).toFixed(1);
        postMessage(ctx.host, {
          type: "voiceSidecarStatus",
          state: "stopped",
          message: `Removed ${result.removed.length} old model directories (${mb} MB freed).`,
        });
        await emitVoiceFilesSize(postMessage, ctx.host, paths.rootDir);
      } catch (err) {
        log("[VoiceStreamHandlers] freeDiskSpace failed:", err);
        postMessage(ctx.host, {
          type: "voiceSidecarStatus",
          state: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },

    voiceRemoveAllFiles: async (_msg, ctx) => {
      if (voiceService === undefined) return;
      const paths = voiceService.getPaths();
      const confirm = await vscode.window.showWarningMessage(
        `This will permanently delete the entire voice runtime and models directory at ${paths.rootDir}. Continue?`,
        { modal: true },
        "Delete",
      );
      if (confirm !== "Delete") return;
      try {
        await voiceService.stop();
        await fs.rm(paths.rootDir, { recursive: true, force: true });
        postMessage(ctx.host, {
          type: "voiceSidecarStatus",
          state: "stopped",
          message: "Voice runtime and models removed.",
        });
        postMessage(ctx.host, { type: "voiceFilesSizeUpdate", bytes: 0 });
      } catch (err) {
        log("[VoiceStreamHandlers] removeAllFiles failed:", err);
        postMessage(ctx.host, {
          type: "voiceSidecarStatus",
          state: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },

    voiceQueryFilesSize: async (_msg, ctx) => {
      if (voiceService === undefined) {
        postMessage(ctx.host, { type: "voiceFilesSizeUpdate", bytes: 0 });
        return;
      }
      await emitVoiceFilesSize(postMessage, ctx.host, voiceService.getPaths().rootDir);
    },
  };

  const markUserTypedDuringTurn = (): void => {
    userTypedSinceWake = true;
  };

  return { handlers, markUserTypedDuringTurn };
}
