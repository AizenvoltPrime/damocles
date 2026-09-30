import { watch, onScopeDispose } from "vue";
import { storeToRefs } from "pinia";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useVoiceJarvisStore } from "@/stores/useVoiceJarvisStore";
import { usePlatformBridge } from "./usePlatformBridge";

/**
 * Bridge between voice settings and the sidecar lifecycle. Mounted once
 * in App.vue. The sidecar captures audio natively via sounddevice (the
 * same way src/core/voice/recorder.ts captures for push-to-talk —
 * OS-level mic access bypasses the VS Code webview permission boundary
 * that denies getUserMedia by default).
 *
 * On wake-mode transition, the webview just signals enable/disable to
 * the extension; no audio crosses the webview iframe boundary.
 */
export function useJarvisLifecycle(): void {
  const { voiceConfig, voiceControlsAvailable } = storeToRefs(useSettingsStore());
  const jarvisStore = useVoiceJarvisStore();
  const { postMessage } = usePlatformBridge();
  let enabled = false;

  // A host without voice (macOS desktop) never starts the stream, whatever the stored mode says.
  watch(
    () => voiceConfig.value.mode === "wake-word" && voiceControlsAvailable.value,
    (wantWake, wantedWake) => {
      jarvisStore.setWakeWordActive(wantWake);
      if (wantWake && !wantedWake) {
        enabled = true;
        postMessage({ type: "voiceStreamEnable" });
        return;
      }
      if (!wantWake && wantedWake) {
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
