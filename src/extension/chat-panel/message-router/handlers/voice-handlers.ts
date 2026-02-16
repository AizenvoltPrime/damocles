import type { HandlerDependencies, HandlerRegistry } from "../types";
import {
  startRecording,
  stopRecording,
  cancelRecording,
} from "../../../voice/recorder";
import { transcribe } from "../../../voice/transcription";
import { log } from "../../../logger";

const MAX_RECORDING_MS = 120_000;

export function createVoiceHandlers(
  deps: HandlerDependencies,
): Partial<HandlerRegistry> {
  const { postMessage, settingsManager } = deps;
  let recordingTimeout: ReturnType<typeof setTimeout> | null = null;
  let recordingHost: Parameters<typeof postMessage>[0] | null = null;

  async function handleStopAndTranscribe(
    host: Parameters<typeof postMessage>[0],
  ): Promise<void> {
    if (recordingTimeout) {
      clearTimeout(recordingTimeout);
      recordingTimeout = null;
    }

    try {
      const result = await stopRecording();
      log(
        "[VoiceHandlers] Recording stopped, audio size:",
        result.audioBuffer.length,
      );

      const config = settingsManager.getVoiceConfig();
      const apiKey = await settingsManager.getVoiceApiKey(config.provider);

      if (!apiKey) {
        postMessage(host, {
          type: "transcriptionError",
          message: "No API key configured for " + config.provider,
        });
        return;
      }

      const text = await transcribe({
        audioBuffer: result.audioBuffer,
        mimeType: result.mimeType,
        provider: config.provider,
        apiKey,
        language: config.language,
      });

      log("[VoiceHandlers] Transcription complete, text length:", text.length);
      postMessage(host, { type: "transcriptionResult", text });
    } catch (err) {
      log("[VoiceHandlers] Stop/transcribe failed:", err);
      postMessage(host, {
        type: "transcriptionError",
        message: err instanceof Error ? err.message : "Transcription failed",
      });
    }
  }

  return {
    startVoiceRecording: async (_msg, ctx) => {
      log("[VoiceHandlers] startVoiceRecording received");
      try {
        await startRecording();
        recordingHost = ctx.host;
        log("[VoiceHandlers] Recording started");
        postMessage(ctx.host, { type: "voiceRecordingStarted" });

        recordingTimeout = setTimeout(() => {
          log("[VoiceHandlers] Max recording duration reached, auto-stopping");
          const host = recordingHost ?? ctx.host;
          recordingHost = null;
          handleStopAndTranscribe(host);
        }, MAX_RECORDING_MS);
      } catch (err) {
        log("[VoiceHandlers] Failed to start recording:", err);
        postMessage(ctx.host, {
          type: "transcriptionError",
          message:
            err instanceof Error ? err.message : "Failed to start recording",
        });
      }
    },

    stopVoiceRecording: async (_msg, ctx) => {
      log("[VoiceHandlers] stopVoiceRecording received");
      const host = recordingHost ?? ctx.host;
      recordingHost = null;
      await handleStopAndTranscribe(host);
    },

    cancelVoiceRecording: () => {
      log("[VoiceHandlers] cancelVoiceRecording received");
      if (recordingTimeout) {
        clearTimeout(recordingTimeout);
        recordingTimeout = null;
      }
      recordingHost = null;
      cancelRecording();
    },

    setVoiceProvider: async (msg, ctx) => {
      if (msg.type !== "setVoiceProvider") return;
      await settingsManager.setVoiceProvider(msg.provider);
      await settingsManager.sendVoiceConfig(ctx.host);
    },

    setVoiceLanguage: async (msg, ctx) => {
      if (msg.type !== "setVoiceLanguage") return;
      await settingsManager.setVoiceLanguage(msg.language);
      await settingsManager.sendVoiceConfig(ctx.host);
    },

    setVoiceApiKey: async (msg, ctx) => {
      if (msg.type !== "setVoiceApiKey") return;
      await settingsManager.storeVoiceApiKey(msg.provider, msg.apiKey);
      await settingsManager.sendVoiceConfig(ctx.host);
    },

    deleteVoiceApiKey: async (msg, ctx) => {
      if (msg.type !== "deleteVoiceApiKey") return;
      await settingsManager.deleteVoiceApiKey(msg.provider);
      await settingsManager.sendVoiceConfig(ctx.host);
    },

    requestVoiceConfig: async (_msg, ctx) => {
      log("[VoiceHandlers] requestVoiceConfig received");
      await settingsManager.sendVoiceConfig(ctx.host);
    },
  };
}
