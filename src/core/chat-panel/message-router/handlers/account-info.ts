import type { HostInstance } from "../../types";
import { PiRuntime } from "../../../pi-session/pi-runtime";

/**
 * Republish the account state to every open panel. It is derived from the Claude auth mode, the
 * OpenAI auth state and the prefer-API-key flag, all of which are process-wide, so a credential change
 * in one panel restates every panel's billing. They also decide whether the `damocles.memory.judge` choice can run
 * (`PiRuntime.resolveMemoryJudge`), so the judge status is told too.
 */
export function republishAccountInfo(getPanels: () => Map<string, HostInstance>): void {
  for (const [, instance] of getPanels()) {
    instance.session.publishAccountInfo();
  }
  PiRuntime.notifyMemoryJudgeChange();
}
