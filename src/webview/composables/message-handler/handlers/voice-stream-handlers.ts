import { toast } from "vue-sonner";
import { i18n } from "@/i18n";
import type { HandlerRegistry } from "../types";
import { getVoiceTtsPlayback } from "@/composables/useVoiceTtsPlayback";

export function createVoiceStreamHandlers(): Partial<HandlerRegistry> {
  const { t } = i18n.global;
  return {
    voiceSidecarStatus: (msg, ctx) => {
      ctx.stores.voiceJarvisStore.setSidecarStatus(
        msg.state,
        msg.device,
        msg.vramMbFree,
        msg.modelsLoaded,
        msg.message,
      );
    },

    voiceWakeDetected: (msg, ctx) => {
      ctx.stores.voiceJarvisStore.setWakeDetected(msg.confidence);
    },

    voiceWakeAborted: (msg, ctx) => {
      ctx.stores.voiceJarvisStore.setWakeAborted(msg.reason);
    },

    voiceVadStarted: (_msg, ctx) => {
      ctx.stores.voiceJarvisStore.setVadStarted();
    },

    voiceVadEnded: (_msg, ctx) => {
      ctx.stores.voiceJarvisStore.setVadEnded();
    },

    voiceTranscriptFinal: (msg, ctx) => {
      const chatInput = ctx.refs.chatInputRef.value;
      if (!chatInput) return;
      chatInput.appendTranscription(msg.text);
      const autoSubmit = ctx.stores.settingsStore.voiceConfig.autoSubmit ?? false;
      if (autoSubmit) {
        chatInput.submit();
      }
    },

    voiceTtsAudioChunk: (msg) => {
      const binary = atob(msg.chunkBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      console.log(`[VoiceTts] chunk received: bytes=${bytes.byteLength} sr=${msg.sampleRate}`);
      const playback = getVoiceTtsPlayback();
      playback.enqueue(bytes, msg.sampleRate);
    },

    voiceTtsDone: () => {
      console.log("[VoiceTts] tts done");
    },

    voiceMicUnavailable: (msg, ctx) => {
      ctx.stores.voiceJarvisStore.setMicUnavailable(msg.reason);
      const messages: Record<typeof msg.reason, string> = {
        denied: t("voiceToast.micDenied"),
        stolen: t("voiceToast.micStolen"),
        "no-device": t("voiceToast.noMic"),
      };
      toast.error(messages[msg.reason]);
    },

    voiceTurnLost: (msg, ctx) => {
      ctx.stores.voiceJarvisStore.setTurnLost(msg.reason);
      toast.warning(t("voiceToast.turnLost"));
    },

    voiceFirstRunRequired: (msg, ctx) => {
      ctx.stores.voiceJarvisStore.showFirstRun(msg.reason);
    },

    voiceCpuFallbackActive: (msg, ctx) => {
      ctx.stores.voiceJarvisStore.setCpuFallback(msg.reason);
    },

    voiceModelDownloadProgress: (msg, ctx) => {
      ctx.stores.voiceJarvisStore.updateModelDownload({
        modelId: msg.modelId,
        bytesReceived: msg.bytesReceived,
        bytesTotal: msg.bytesTotal,
        status: msg.status,
        ...(msg.message !== undefined ? { message: msg.message } : {}),
      });
    },

    voiceModelDownloadAllDone: (_msg, ctx) => {
      ctx.stores.voiceJarvisStore.markModelDownloadsDone();
    },

    voiceModelDownloadCancelled: (_msg, ctx) => {
      ctx.stores.voiceJarvisStore.clearDownloads();
    },

    voiceModelUpgradeAvailable: (msg, ctx) => {
      ctx.stores.voiceJarvisStore.setPendingUpgrades(msg.upgrades);
      const total = msg.upgrades.reduce((acc, u) => acc + u.bytesDelta, 0);
      const mb = (total / 1_000_000).toFixed(0);
      toast.info(t("voiceToast.upgradeAvailable", { mb }));
    },
  };
}
