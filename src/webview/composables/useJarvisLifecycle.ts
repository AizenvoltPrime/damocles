import { watch, onScopeDispose } from "vue";
import { storeToRefs } from "pinia";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useVoiceJarvisStore } from "@/stores/useVoiceJarvisStore";
import { useVSCode } from "./useVSCode";

/**
 * Bridge between voice settings and the sidecar lifecycle. Mounted once
 * in App.vue. The sidecar captures audio natively via sounddevice (the
 * same way src/extension/voice/recorder.ts captures for push-to-talk —
 * OS-level mic access bypasses the VS Code webview permission boundary
 * that denies getUserMedia by default).
 *
 * On wake-mode transition, the webview just signals enable/disable to
 * the extension; no audio crosses the webview iframe boundary.
 */
export function useJarvisLifecycle(): void {
  const { voiceConfig } = storeToRefs(useSettingsStore());
  const jarvisStore = useVoiceJarvisStore();
  const { postMessage } = useVSCode();
  let enabled = false;

  watch(
    () => voiceConfig.value.mode,
    (mode, prevMode) => {
      const wantWake = mode === "wake-word";
      jarvisStore.setWakeWordActive(wantWake);
      if (wantWake && prevMode !== "wake-word") {
        enabled = true;
        postMessage({ type: "voiceStreamEnable" });
        return;
      }
      if (!wantWake && prevMode === "wake-word") {
        enabled = false;
        postMessage({ type: "voiceStreamDisable" });
      }
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    if (enabled) {
      try {
        postMessage({ type: "voiceStreamDisable" });
      } catch {
        // postMessage may throw if VS Code API unavailable in dispose
      }
    }
  });
}
