export type VoiceProvider = "openai-whisper" | "deepgram" | "google-cloud-stt";

export type VoiceMode = "off" | "push-to-talk" | "wake-word";

export type GpuPreference = "auto" | "cuda" | "cpu";

export type TtsVoiceId =
  | "en-Carter_man"
  | "en-Davis_man"
  | "en-Emma_woman"
  | "en-Frank_man"
  | "en-Grace_woman"
  | "en-Mike_man";

export const TTS_VOICE_IDS: readonly TtsVoiceId[] = [
  "en-Carter_man",
  "en-Davis_man",
  "en-Emma_woman",
  "en-Frank_man",
  "en-Grace_woman",
  "en-Mike_man",
] as const;

export const DEFAULT_TTS_VOICE: TtsVoiceId = "en-Carter_man";

// Numeric defaults for the wake-word pipeline. Mirror the values
// declared in package.json's contributes.configuration block — the
// schema is the source of truth at the OS-config layer; these
// constants give TS callers a typed handle so settings UI, store
// fallbacks, and protocol validators stay in sync.
export const DEFAULT_WAKE_SENSITIVITY = 0.5;
export const DEFAULT_END_OF_TURN_MS = 800;
export const DEFAULT_MAX_UTTERANCE_MS = 30_000;

export type VoiceConfig = {
  provider: VoiceProvider;
  language: string;
  mode: VoiceMode;
  wakeWord: string;
  wakeWordSensitivity: number;
  ttsEnabled: boolean;
  ttsVoice: TtsVoiceId;
  localGpu: GpuPreference;
  endOfTurnSilenceMs: number;
  maxUtteranceMs: number;
  autoSubmit: boolean;
  diagnostics: boolean;
};

export type VoiceStatus = "idle" | "starting" | "recording" | "transcribing" | "error";

export type WakeWordState =
  | "off"
  | "loading"
  | "listening"
  | "wake-detected"
  | "recording"
  | "transcribing"
  | "muted"
  | "unavailable"
  | "error";

export type SidecarDevice = "cuda" | "cpu";

export type SidecarReadyInfo = {
  device: SidecarDevice;
  vramMbFree: number;
  modelsLoaded: string[];
};

export type WakeEventKind =
  | "wakeDetected"
  | "wakeAborted"
  | "vadStarted"
  | "vadEnded"
  | "transcriptFinal"
  | "ttsAudioChunk"
  | "ttsDone"
  | "sidecarError"
  | "sidecarReady"
  | "sidecarStopped";
