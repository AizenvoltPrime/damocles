import { ref, onUnmounted } from "vue";
import type { VoiceStatus } from "@shared/types/voice";
import { useVSCode } from "./useVSCode";

export function useVoiceInput() {
  const status = ref<VoiceStatus>("idle");
  const errorMessage = ref<string | null>(null);
  const { postMessage } = useVSCode();

  function startRecording(): void {
    errorMessage.value = null;
    status.value = "starting";
    postMessage({ type: "startVoiceRecording" });
  }

  function setRecording(): void {
    status.value = "recording";
  }

  function stopRecording(): void {
    if (status.value !== "recording") return;
    status.value = "transcribing";
    postMessage({ type: "stopVoiceRecording" });
  }

  function cancelRecording(): void {
    postMessage({ type: "cancelVoiceRecording" });
    status.value = "idle";
    errorMessage.value = null;
  }

  function setDone(): void {
    status.value = "idle";
    errorMessage.value = null;
  }

  function setError(msg: string): void {
    status.value = "error";
    errorMessage.value = msg;
    setTimeout(() => {
      if (status.value === "error") {
        status.value = "idle";
      }
    }, 5000);
  }

  onUnmounted(() => {
    if (status.value === "recording" || status.value === "starting") {
      cancelRecording();
    }
  });

  return {
    status,
    errorMessage,
    startRecording,
    setRecording,
    stopRecording,
    cancelRecording,
    setDone,
    setError,
  };
}
