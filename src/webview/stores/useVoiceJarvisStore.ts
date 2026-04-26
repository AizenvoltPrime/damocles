import type { Ref, ComputedRef } from "vue";
import { ref, computed } from "vue";
import { defineStore } from "pinia";

export type SidecarLifecycleState =
  | "stopped"
  | "loading"
  | "ready"
  | "error"
  | "restarting";

export type SidecarDevice = "cuda" | "cpu";

export type VoiceJarvisIndicatorState =
  | "off"
  | "loading"
  | "listening"
  | "recording"
  | "muted"
  | "cpu-fallback"
  | "error";

export type CpuFallbackReason =
  | "no-cuda"
  | "low-vram"
  | "user-pref"
  | "cuda-oom-fallback"
  | "tts-unloaded";

export type FirstRunReason = "missing-runtime" | "missing-models" | "first-time";

export type WakeAbortReason = "no-speech" | "user-cancel";

export type MicUnavailableReason = "denied" | "stolen" | "no-device";

export type TurnLostReason = "sidecar-crash" | "timeout";

export interface ModelUpgradeInfo {
  modelId: string;
  description: string;
  installedVersion: string;
  newVersion: string;
  bytesDelta: number;
  totalBytes: number;
  licenseUrl: string;
  license: string;
  gated: boolean;
}

export type ModelDownloadStatus = "downloading" | "verifying" | "done" | "error";

export interface ModelDownloadEntry {
  bytesReceived: number;
  bytesTotal: number;
  status: ModelDownloadStatus;
  message?: string;
  licenseUrl?: string;
  licenseName?: string;
  displayName?: string;
}

export interface ModelDownloadProgress {
  modelId: string;
  bytesReceived: number;
  bytesTotal: number;
  status: ModelDownloadStatus;
  message?: string;
  licenseUrl?: string;
  licenseName?: string;
  displayName?: string;
}

export interface VoiceJarvisStoreShape {
  wakeWordActive: Ref<boolean>;
  sidecarState: Ref<SidecarLifecycleState>;
  device: Ref<SidecarDevice | null>;
  vramMbFree: Ref<number | null>;
  modelsLoaded: Ref<string[]>;
  sidecarStatusMessage: Ref<string | null>;
  wakeDetectedAt: Ref<number | null>;
  lastWakeConfidence: Ref<number | null>;
  lastWakeAbortReason: Ref<WakeAbortReason | null>;
  vadActive: Ref<boolean>;
  micUnavailableReason: Ref<MicUnavailableReason | null>;
  cpuFallbackReason: Ref<CpuFallbackReason | null>;
  firstRunRequired: Ref<FirstRunReason | null>;
  modelDownload: Ref<Record<string, ModelDownloadEntry>>;
  modelDownloadsAllDone: Ref<boolean>;
  pendingUpgrades: Ref<ModelUpgradeInfo[]>;
  lastTurnLostReason: Ref<TurnLostReason | null>;
  muted: Ref<boolean>;
  errorMessage: Ref<string | null>;
  voiceFilesBytes: Ref<number>;
  state: ComputedRef<VoiceJarvisIndicatorState>;
  isMuted: ComputedRef<boolean>;
  isReady: ComputedRef<boolean>;
  isJarvisActive: ComputedRef<boolean>;
  hasActiveDownload: ComputedRef<boolean>;
  setWakeWordActive: (active: boolean) => void;
  setSidecarStatus: (
    state: SidecarLifecycleState,
    device?: SidecarDevice,
    vramMbFree?: number,
    modelsLoaded?: string[],
    message?: string,
  ) => void;
  setWakeDetected: (confidence: number) => void;
  setWakeAborted: (reason: WakeAbortReason) => void;
  setVadStarted: () => void;
  setVadEnded: () => void;
  setMicUnavailable: (reason: MicUnavailableReason) => void;
  clearMicUnavailable: () => void;
  setCpuFallback: (reason: CpuFallbackReason | null) => void;
  clearCpuFallback: () => void;
  showFirstRun: (reason: FirstRunReason) => void;
  hideFirstRun: () => void;
  setFirstRunRequired: (reason: FirstRunReason | null) => void;
  updateModelDownload: (progress: ModelDownloadProgress) => void;
  setModelProgress: (modelId: string, entry: ModelDownloadEntry) => void;
  clearDownloads: () => void;
  markModelDownloadsDone: () => void;
  setPendingUpgrades: (upgrades: ModelUpgradeInfo[]) => void;
  clearPendingUpgrades: () => void;
  setTurnLost: (reason: TurnLostReason) => void;
  setMuted: (muted: boolean) => void;
  setError: (message: string | null) => void;
  setVoiceFilesBytes: (bytes: number) => void;
  $reset: () => void;
}

export const useVoiceJarvisStore = defineStore("voice-jarvis", (): VoiceJarvisStoreShape => {
  const wakeWordActive = ref<boolean>(false);
  const sidecarState = ref<SidecarLifecycleState>("stopped");
  const device = ref<SidecarDevice | null>(null);
  const vramMbFree = ref<number | null>(null);
  const modelsLoaded = ref<string[]>([]);
  const sidecarStatusMessage = ref<string | null>(null);

  const wakeDetectedAt = ref<number | null>(null);
  const lastWakeConfidence = ref<number | null>(null);
  const lastWakeAbortReason = ref<WakeAbortReason | null>(null);
  const vadActive = ref<boolean>(false);
  const micUnavailableReason = ref<MicUnavailableReason | null>(null);
  const cpuFallbackReason = ref<CpuFallbackReason | null>(null);
  const firstRunRequired = ref<FirstRunReason | null>(null);
  const modelDownload = ref<Record<string, ModelDownloadEntry>>({});
  const modelDownloadsAllDone = ref<boolean>(false);
  const pendingUpgrades = ref<ModelUpgradeInfo[]>([]);
  const lastTurnLostReason = ref<TurnLostReason | null>(null);
  const muted = ref<boolean>(false);
  const errorMessage = ref<string | null>(null);
  const voiceFilesBytes = ref<number>(0);

  const isMuted = computed<boolean>(() => muted.value);
  const isReady = computed<boolean>(() => sidecarState.value === "ready");
  const isJarvisActive = computed<boolean>(
    () => wakeWordActive.value && sidecarState.value === "ready",
  );
  const hasActiveDownload = computed<boolean>(
    () => Object.keys(modelDownload.value).length > 0 && !modelDownloadsAllDone.value,
  );

  const state = computed<VoiceJarvisIndicatorState>(() => {
    if (sidecarState.value === "error") return "error";
    if (sidecarState.value === "stopped") return "off";
    if (sidecarState.value === "loading" || sidecarState.value === "restarting") return "loading";
    if (cpuFallbackReason.value !== null) return "cpu-fallback";
    if (muted.value) return "muted";
    if (vadActive.value) return "recording";
    return "listening";
  });

  function setWakeWordActive(active: boolean): void {
    wakeWordActive.value = active;
  }

  function setSidecarStatus(
    nextState: SidecarLifecycleState,
    nextDevice?: SidecarDevice,
    nextVramMbFree?: number,
    nextModelsLoaded?: string[],
    message?: string,
  ): void {
    sidecarState.value = nextState;
    device.value = nextDevice ?? null;
    vramMbFree.value = nextVramMbFree ?? null;
    modelsLoaded.value = nextModelsLoaded ?? [];
    sidecarStatusMessage.value = message ?? null;
    if (nextState === "error") {
      errorMessage.value = message ?? "Voice sidecar error";
    } else {
      errorMessage.value = null;
    }
  }

  function setWakeDetected(confidence: number): void {
    wakeDetectedAt.value = Date.now();
    lastWakeConfidence.value = confidence;
    lastWakeAbortReason.value = null;
  }

  function setWakeAborted(reason: WakeAbortReason): void {
    lastWakeAbortReason.value = reason;
    vadActive.value = false;
  }

  function setVadStarted(): void {
    vadActive.value = true;
  }

  function setVadEnded(): void {
    vadActive.value = false;
  }

  function setMicUnavailable(reason: MicUnavailableReason): void {
    micUnavailableReason.value = reason;
  }

  function clearMicUnavailable(): void {
    micUnavailableReason.value = null;
  }

  function setCpuFallback(reason: CpuFallbackReason | null): void {
    cpuFallbackReason.value = reason;
  }

  function clearCpuFallback(): void {
    cpuFallbackReason.value = null;
  }

  function showFirstRun(reason: FirstRunReason): void {
    firstRunRequired.value = reason;
  }

  function hideFirstRun(): void {
    firstRunRequired.value = null;
  }

  function setFirstRunRequired(reason: FirstRunReason | null): void {
    firstRunRequired.value = reason;
  }

  function updateModelDownload(progress: ModelDownloadProgress): void {
    const next: ModelDownloadEntry = {
      bytesReceived: progress.bytesReceived,
      bytesTotal: progress.bytesTotal,
      status: progress.status,
      ...(progress.message !== undefined ? { message: progress.message } : {}),
      ...(progress.licenseUrl !== undefined ? { licenseUrl: progress.licenseUrl } : {}),
      ...(progress.licenseName !== undefined ? { licenseName: progress.licenseName } : {}),
      ...(progress.displayName !== undefined ? { displayName: progress.displayName } : {}),
    };
    modelDownload.value = { ...modelDownload.value, [progress.modelId]: next };
    if (progress.status !== "done") modelDownloadsAllDone.value = false;
  }

  function setModelProgress(modelId: string, entry: ModelDownloadEntry): void {
    modelDownload.value = { ...modelDownload.value, [modelId]: entry };
    if (entry.status !== "done") modelDownloadsAllDone.value = false;
  }

  function clearDownloads(): void {
    modelDownload.value = {};
    modelDownloadsAllDone.value = false;
  }

  function markModelDownloadsDone(): void {
    modelDownloadsAllDone.value = true;
  }

  function setPendingUpgrades(upgrades: ModelUpgradeInfo[]): void {
    pendingUpgrades.value = [...upgrades];
  }

  function clearPendingUpgrades(): void {
    pendingUpgrades.value = [];
  }

  function setTurnLost(reason: TurnLostReason): void {
    lastTurnLostReason.value = reason;
    vadActive.value = false;
  }

  function setMuted(next: boolean): void {
    muted.value = next;
  }

  function setError(msg: string | null): void {
    errorMessage.value = msg;
    if (msg !== null) sidecarState.value = "error";
  }

  function setVoiceFilesBytes(bytes: number): void {
    voiceFilesBytes.value = bytes;
  }

  function $reset(): void {
    wakeWordActive.value = false;
    sidecarState.value = "stopped";
    device.value = null;
    vramMbFree.value = null;
    modelsLoaded.value = [];
    sidecarStatusMessage.value = null;
    wakeDetectedAt.value = null;
    lastWakeConfidence.value = null;
    lastWakeAbortReason.value = null;
    vadActive.value = false;
    micUnavailableReason.value = null;
    cpuFallbackReason.value = null;
    firstRunRequired.value = null;
    modelDownload.value = {};
    modelDownloadsAllDone.value = false;
    pendingUpgrades.value = [];
    lastTurnLostReason.value = null;
    muted.value = false;
    errorMessage.value = null;
    voiceFilesBytes.value = 0;
  }

  return {
    wakeWordActive,
    sidecarState,
    device,
    vramMbFree,
    modelsLoaded,
    sidecarStatusMessage,
    wakeDetectedAt,
    lastWakeConfidence,
    lastWakeAbortReason,
    vadActive,
    micUnavailableReason,
    cpuFallbackReason,
    firstRunRequired,
    modelDownload,
    modelDownloadsAllDone,
    pendingUpgrades,
    lastTurnLostReason,
    muted,
    errorMessage,
    voiceFilesBytes,
    state,
    isMuted,
    isReady,
    isJarvisActive,
    hasActiveDownload,
    setWakeWordActive,
    setSidecarStatus,
    setWakeDetected,
    setWakeAborted,
    setVadStarted,
    setVadEnded,
    setMicUnavailable,
    clearMicUnavailable,
    setCpuFallback,
    clearCpuFallback,
    showFirstRun,
    hideFirstRun,
    setFirstRunRequired,
    updateModelDownload,
    setModelProgress,
    clearDownloads,
    markModelDownloadsDone,
    setPendingUpgrades,
    clearPendingUpgrades,
    setTurnLost,
    setMuted,
    setError,
    setVoiceFilesBytes,
    $reset,
  };
});
