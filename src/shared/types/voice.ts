export type VoiceProvider = "openai-whisper" | "deepgram" | "google-cloud-stt";

export type VoiceConfig = {
  provider: VoiceProvider;
  language: string;
};

export type VoiceStatus = "idle" | "starting" | "recording" | "transcribing" | "error";
