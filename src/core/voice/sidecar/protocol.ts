import { z } from "zod";

export const PROTOCOL_VERSION: number = 1;
export const SUBPROTOCOL: string = `damocles-voice.v${PROTOCOL_VERSION}`;

export const SAMPLE_RATE: number = 16_000;
export const FRAME_DURATION_MS: number = 20;
export const FRAME_SAMPLES: number = 320;
export const FRAME_BYTES: number = 640;
export const TTS_SAMPLE_RATE: number = 24_000;

export const ErrorCode = {
  CudaOom: "cuda-oom",
  CudaOomRecovered: "cuda-oom-recovered",
  CudaUnavailable: "cuda-unavailable",
  ModelLoadFailed: "model-load-failed",
  InvalidAudioFrame: "invalid-audio-frame",
  BadToken: "bad-token",
  BadProtocolVersion: "bad-protocol-version",
  TtsFailure: "tts-failure",
  Internal: "internal",
  CrashLoop: "crash-loop",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export type InitMessage = {
  type: "init";
  protocol_version: number;
  wake_word: string;
  wake_sensitivity: number;
  end_of_turn_silence_ms: number;
  max_utterance_ms: number;
  tts_enabled: boolean;
  tts_voice: string;
  diagnostics: boolean;
};

export type TtsRequestMessage = { type: "tts_request"; request_id: string; text: string };
export type CancelTtsMessage = { type: "cancel_tts"; request_id: string | null };
export type SetMutedMessage = { type: "set_muted"; muted: boolean };
export type SetVoiceMessage = { type: "set_voice"; voice_id: string };
export type ShutdownMessage = { type: "shutdown" };
export type PingMessage = { type: "ping"; nonce: number };

export type SidecarInbound =
  | InitMessage
  | TtsRequestMessage
  | CancelTtsMessage
  | SetMutedMessage
  | SetVoiceMessage
  | ShutdownMessage
  | PingMessage;

export type AutoFallbackReason = "no-cuda" | "low-vram" | "user-pref" | "cuda-oom-fallback";

export type SidecarReady = {
  type: "ready";
  protocol_version: number;
  device: "cuda" | "cpu";
  vram_mb_free: number;
  models_loaded: string[];
  auto_fallback_reason?: AutoFallbackReason | undefined;
};

export type WakeDetected = { type: "wake_detected"; confidence: number };
export type WakeAborted = { type: "wake_aborted"; reason: "no-speech" | "user-cancel" };
export type VadStarted = { type: "vad_speech_started" };
export type VadEnded = { type: "vad_speech_ended" };
export type TranscriptFinal = { type: "transcript_final"; text: string; duration_ms: number };
export type TtsAudioChunkHeader = { type: "tts_audio_chunk"; request_id: string; sample_rate: number };
export type TtsDone = { type: "tts_done"; request_id: string };
export type VoiceChanged = { type: "voice_changed"; voice_id: string };
export type SidecarError = {
  type: "error";
  code: string;
  message: string;
  recoverable: boolean;
  recovery?: string | undefined;
};
export type Pong = { type: "pong"; nonce: number };

export type SidecarOutbound =
  | SidecarReady
  | WakeDetected
  | WakeAborted
  | VadStarted
  | VadEnded
  | TranscriptFinal
  | TtsAudioChunkHeader
  | TtsDone
  | VoiceChanged
  | SidecarError
  | Pong;

const inboundSchema: z.ZodType<SidecarInbound> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("init"),
    protocol_version: z.number().int(),
    wake_word: z.string(),
    wake_sensitivity: z.number().min(0.1).max(0.95),
    end_of_turn_silence_ms: z.number().int().min(300).max(3000),
    max_utterance_ms: z.number().int().min(5000).max(120000),
    tts_enabled: z.boolean(),
    tts_voice: z.string(),
    diagnostics: z.boolean(),
  }),
  z.object({ type: z.literal("tts_request"), request_id: z.string(), text: z.string() }),
  z.object({ type: z.literal("cancel_tts"), request_id: z.string().nullable() }),
  z.object({ type: z.literal("set_muted"), muted: z.boolean() }),
  z.object({ type: z.literal("set_voice"), voice_id: z.string().min(1).max(64) }),
  z.object({ type: z.literal("shutdown") }),
  z.object({ type: z.literal("ping"), nonce: z.number().int() }),
]);

const outboundSchema: z.ZodType<SidecarOutbound> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    protocol_version: z.number().int(),
    device: z.enum(["cuda", "cpu"]),
    vram_mb_free: z.number(),
    models_loaded: z.array(z.string()),
    auto_fallback_reason: z.enum(["no-cuda", "low-vram", "user-pref", "cuda-oom-fallback"]).optional(),
  }),
  z.object({ type: z.literal("wake_detected"), confidence: z.number() }),
  z.object({ type: z.literal("wake_aborted"), reason: z.enum(["no-speech", "user-cancel"]) }),
  z.object({ type: z.literal("vad_speech_started") }),
  z.object({ type: z.literal("vad_speech_ended") }),
  z.object({ type: z.literal("transcript_final"), text: z.string(), duration_ms: z.number() }),
  z.object({
    type: z.literal("tts_audio_chunk"),
    request_id: z.string(),
    sample_rate: z.number().int(),
  }),
  z.object({ type: z.literal("tts_done"), request_id: z.string() }),
  z.object({ type: z.literal("voice_changed"), voice_id: z.string() }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
    recoverable: z.boolean(),
    recovery: z.string().optional(),
  }),
  z.object({ type: z.literal("pong"), nonce: z.number().int() }),
]);

export function parseOutbound(raw: string): SidecarOutbound | null {
  try {
    const parsed = JSON.parse(raw);
    return outboundSchema.parse(parsed);
  } catch {
    return null;
  }
}

export function parseOutboundLoose(raw: unknown): SidecarOutbound {
  return outboundSchema.parse(raw);
}

export function encodeInbound(msg: SidecarInbound): string {
  return JSON.stringify(inboundSchema.parse(msg));
}

export function parseInbound(raw: string): SidecarInbound | null {
  try {
    const parsed = JSON.parse(raw);
    return inboundSchema.parse(parsed);
  } catch {
    return null;
  }
}
