import * as vscode from "vscode";
import type { VoiceService } from "./service";
import type { SidecarManagerStatus, SidecarOutbound } from "./sidecar";
import { log } from "../logger";

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
): VoiceStatusBarController {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY);
  item.command = TOGGLE_MUTE_COMMAND;
  item.text = "$(mic)";
  item.tooltip = "Damocles voice (off)";

  let muted = false;
  let lastStatus: SidecarManagerStatus = { kind: "stopped" };
  let lastDevice: "cuda" | "cpu" | null = null;

  function render(): void {
    const mode = vscode.workspace
      .getConfiguration("damocles")
      .get<string>("voice.mode", "push-to-talk");
    if (mode !== "wake-word") {
      item.hide();
      return;
    }

    if (lastStatus.kind === "stopped") {
      item.text = "$(circle-slash) Voice off";
      item.tooltip = "Damocles voice mode is stopped";
      item.show();
      return;
    }
    if (lastStatus.kind === "loading") {
      item.text = "$(loading~spin) Voice loading";
      item.tooltip = lastStatus.message ?? "Loading voice models";
      item.show();
      return;
    }
    if (lastStatus.kind === "restarting") {
      item.text = "$(sync~spin) Voice restarting";
      item.tooltip = `Restart attempt ${lastStatus.attempt}`;
      item.show();
      return;
    }
    if (lastStatus.kind === "error") {
      item.text = "$(error) Voice error";
      item.tooltip = `Voice error: ${lastStatus.message}`;
      item.show();
      return;
    }
    if (muted) {
      item.text = "$(mic) Muted";
      item.tooltip = "Damocles voice muted — click to unmute";
      item.show();
      return;
    }
    if (lastStatus.kind === "ready") {
      const deviceLabel = lastDevice === "cpu" ? " (CPU)" : "";
      item.text = `$(mic-filled) Listening${deviceLabel}`;
      item.tooltip = `Damocles wake-word listening${deviceLabel ? " on CPU" : ""} — click to mute`;
      item.show();
      return;
    }
    item.text = "$(mic)";
    item.tooltip = "Damocles voice";
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
      item.text = "$(circle-filled) Recording";
      item.tooltip = "Wake word detected — recording";
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

  const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("damocles.voice.mode")) {
      render();
    }
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
