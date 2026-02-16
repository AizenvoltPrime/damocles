import { toast } from "vue-sonner";
import type { HandlerRegistry } from "../types";

export function createVoiceHandlers(): Partial<HandlerRegistry> {
  return {
    voiceRecordingStarted: (_msg, ctx) => {
      const chatInput = ctx.refs.chatInputRef.value;
      chatInput?.voiceSetRecording();
    },

    transcriptionResult: (msg, ctx) => {
      if (msg.type !== "transcriptionResult") return;
      const chatInput = ctx.refs.chatInputRef.value;
      if (chatInput) {
        chatInput.appendTranscription(msg.text);
        chatInput.voiceSetDone();
      }
    },

    transcriptionError: (msg, ctx) => {
      if (msg.type !== "transcriptionError") return;
      const chatInput = ctx.refs.chatInputRef.value;
      if (chatInput) {
        chatInput.voiceSetError(msg.message);
      }
      toast.error(msg.message);
    },

    voiceConfigUpdate: (msg, ctx) => {
      if (msg.type !== "voiceConfigUpdate") return;
      ctx.stores.settingsStore.setVoiceConfig(msg.config, msg.hasApiKey);
    },
  };
}
