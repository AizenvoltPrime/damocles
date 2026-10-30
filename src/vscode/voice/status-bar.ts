import * as vscode from "vscode";
import type { SettingsStore } from "../../platform/settings-store";
import type { VoiceService } from "../../core/voice/service";
import type { SidecarManagerStatus, SidecarOutbound } from "../../core/voice/sidecar";
import { log } from "../../core/logger";
import { renderVsCode } from "../platform/localization-service";

const TOGGLE_MUTE_COMMAND = "damocles.voice.toggleMute";
const STATUS_BAR_PRIORITY = 100;

export interface VoiceStatusBarController {
  item: vscode.StatusBarItem;
  setMuted: (muted: boolean) => void;
  getMuted: () => boolean;
  dispose: () => void;
}

export function createVoiceStatusBarItem(
  context: vscode.ExtensionContext,
  voiceService: VoiceService,
  settings: SettingsStore,
): VoiceStatusBarController {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY);
  item.command = TOGGLE_MUTE_COMMAND;

  let muted = false;
  let lastStatus: SidecarManagerStatus = { kind: "stopped" };
  let lastDevice: "cuda" | "cpu" | null = null;

  function render(): void {
    const mode = settings.get<string>("damocles.voice.mode", "push-to-talk");
    if (mode !== "wake-word") {
      item.hide();
      return;
    }

    if (lastStatus.kind === "stopped") {
      item.text = `$(circle-slash) ${vscode.l10n.t("Voice off")}`;
      item.tooltip = vscode.l10n.t("Damocles voice mode is stopped");
      item.show();
      return;
    }
    if (lastStatus.kind === "loading") {
      item.text = `$(loading~spin) ${vscode.l10n.t("Voice loading")}`;
      item.tooltip = renderVsCode(lastStatus.message);
      item.show();
      return;
    }
    if (lastStatus.kind === "restarting") {
      item.text = `$(sync~spin) ${vscode.l10n.t("Voice restarting")}`;
      item.tooltip = vscode.l10n.t("Restart attempt {0}", lastStatus.attempt);
      item.show();
      return;
    }
    if (lastStatus.kind === "error") {
      item.text = `$(error) ${vscode.l10n.t("Voice error")}`;
      item.tooltip = vscode.l10n.t("Voice error: {0}", renderVsCode(lastStatus.message));
      item.show();
      return;
    }
    if (muted) {
      item.text = `$(mic) ${vscode.l10n.t("Muted")}`;
      item.tooltip = vscode.l10n.t("Damocles voice is muted. Click to unmute.");
      item.show();
      return;
    }
    if (lastStatus.kind === "ready") {
      const onCpu = lastDevice === "cpu";
      item.text = `$(mic-filled) ${onCpu ? vscode.l10n.t("Listening (CPU)") : vscode.l10n.t("Listening")}`;
      item.tooltip = onCpu ? vscode.l10n.t("Damocles is listening for the wake word on the CPU. Click to mute.") : vscode.l10n.t("Damocles is listening for the wake word. Click to mute.");
      item.show();
      return;
    }
    item.text = "$(mic)";
    item.tooltip = vscode.l10n.t("Damocles voice");
    item.show();
  }

  function onStatus(status: SidecarManagerStatus): void {
    lastStatus = status;
    if (status.kind === "ready") {
      lastDevice = status.device;
    } else if (status.kind === "stopped") {
      lastDevice = null;
    }
    render();
  }

  let recordingResetTimer: NodeJS.Timeout | null = null;

  function onMessage(msg: SidecarOutbound): void {
    if (msg.type === "wake_detected") {
      item.text = `$(circle-filled) ${vscode.l10n.t("Recording")}`;
      item.tooltip = vscode.l10n.t("Wake word detected, recording");
      item.show();
      if (recordingResetTimer !== null) clearTimeout(recordingResetTimer);
      recordingResetTimer = setTimeout(() => {
        recordingResetTimer = null;
        render();
      }, 4000);
      return;
    }
    if (msg.type === "wake_aborted" || msg.type === "transcript_final") {
      if (recordingResetTimer !== null) {
        clearTimeout(recordingResetTimer);
        recordingResetTimer = null;
      }
      render();
      return;
    }
  }

  voiceService.on("status", onStatus);
  voiceService.on("message", onMessage);

  const command = vscode.commands.registerCommand(TOGGLE_MUTE_COMMAND, () => {
    muted = !muted;
    log(`[VoiceStatusBar] toggle mute -> ${muted}`);
    render();
  });

  const configWatcher = settings.onDidChange("damocles.voice.mode", () => {
    render();
  });

  render();

  context.subscriptions.push(item, command, configWatcher);

  return {
    item,
    setMuted: (m: boolean): void => {
      muted = m;
      render();
    },
    getMuted: (): boolean => muted,
    dispose: (): void => {
      if (recordingResetTimer !== null) {
        clearTimeout(recordingResetTimer);
        recordingResetTimer = null;
      }
      item.dispose();
      command.dispose();
      configWatcher.dispose();
    },
  };
}
