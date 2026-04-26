import * as vscode from "vscode";
import * as os from "node:os";
import type { VoiceService } from "./service";
import { log } from "../logger";

const SLEEP_POLL_INTERVAL_MS = 30_000;
const SLEEP_DETECTION_THRESHOLD_MS = 35_000;
const CLOCK_DRIFT_TOLERANCE_MS = 5_000;

export interface AutoDisableHooks {
  onPanelsAllClosed: (callback: () => void) => vscode.Disposable;
}

export function setupAutoDisable(
  voiceService: VoiceService,
  context: vscode.ExtensionContext,
  hooks: AutoDisableHooks,
): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];

  function stopForReason(reason: string): void {
    log(`[VoiceAutoDisable] stopping voice service: ${reason}`);
    voiceService.stop().catch((err) => log(`[VoiceAutoDisable] stop error: ${String(err)}`));
  }

  let lastUptimeSec = os.uptime();
  let lastWallClockMs = Date.now();
  const sleepInterval = setInterval(() => {
    const currentUptime = os.uptime();
    const currentWall = Date.now();
    const wallDeltaMs = currentWall - lastWallClockMs;
    const uptimeDeltaSec = currentUptime - lastUptimeSec;
    const driftMs = wallDeltaMs - uptimeDeltaSec * 1000;
    if (wallDeltaMs > SLEEP_DETECTION_THRESHOLD_MS && driftMs > CLOCK_DRIFT_TOLERANCE_MS) {
      stopForReason(`system sleep detected (drift ${driftMs}ms)`);
    }
    lastUptimeSec = currentUptime;
    lastWallClockMs = currentWall;
  }, SLEEP_POLL_INTERVAL_MS);

  disposables.push({ dispose: (): void => clearInterval(sleepInterval) });

  disposables.push(
    hooks.onPanelsAllClosed(() => {
      stopForReason("all chat panels closed");
    }),
  );

  const compositeDisposable: vscode.Disposable = {
    dispose: (): void => {
      for (const d of disposables) {
        try {
          d.dispose();
        } catch (err) {
          log(`[VoiceAutoDisable] dispose error: ${String(err)}`);
        }
      }
    },
  };

  context.subscriptions.push(compositeDisposable);
  return compositeDisposable;
}
