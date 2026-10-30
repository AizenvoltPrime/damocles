import type { HostInstance } from "../../types";
import { PiRuntime } from "../../../pi-session/pi-runtime";

/**
 * Every open panel's account state, for a change the runtime does not publish itself (docs/invariants.md "Account state has
 * exactly one publisher"). clientId: on a daemon's core, the one device whose views alone need it.
 */
export function publishPanelsAccountInfo(getPanels: () => Map<string, HostInstance>, clientId?: string): void {
  for (const [, instance] of getPanels()) {
    instance.session.publishAccountInfo(clientId);
  }
}

/** The panels a key sync's end leaves out: it publishes each session the runtime holds (`PiRuntime.publishesAccountInfoOf`). */
export function publishUnstartedPanelsAccountInfo(getPanels: () => Map<string, HostInstance>): void {
  const runtime = PiRuntime.exists ? PiRuntime.get() : null;
  for (const [, instance] of getPanels()) {
    if (!runtime?.publishesAccountInfoOf(instance.session)) instance.session.publishAccountInfo();
  }
}

/**
 * `publishPanelsAccountInfo` and the judge status, for a credential the judge reads; a key sync's end tells the judge itself, so its
 * listeners use `publishUnstartedPanelsAccountInfo`, or the judge status posts twice (docs/invariants.md "Memory judges").
 */
export function republishAccountInfo(getPanels: () => Map<string, HostInstance>, clientId?: string): void {
  publishPanelsAccountInfo(getPanels, clientId);
  PiRuntime.notifyMemoryJudgeChange(clientId);
}
