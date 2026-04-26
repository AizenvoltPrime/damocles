export { VoiceSidecarManager } from "./manager";
export type {
  SidecarManagerStatus,
  ManagerConfig,
  IncomingTtsChunk,
  CpuFallbackEvent,
  TtsUnloadedEvent,
} from "./manager";
export {
  ErrorCode,
  PROTOCOL_VERSION,
  SUBPROTOCOL,
  FRAME_BYTES,
  FRAME_SAMPLES,
  SAMPLE_RATE,
  TTS_SAMPLE_RATE,
} from "./protocol";
export type {
  SidecarInbound,
  SidecarOutbound,
  ErrorCodeValue,
  SidecarReady,
  TranscriptFinal,
  WakeDetected,
} from "./protocol";
