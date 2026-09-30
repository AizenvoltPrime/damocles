import type { HostInstance } from "../../types";

/**
 * Republish the account chip to every open panel. The chip is derived from the Claude auth mode, the
 * OpenAI auth state and the prefer-API-key flag, all of which are process-wide, so a credential change
 * in one panel restates every panel's billing.
 */
export function republishAccountInfo(getPanels: () => Map<string, HostInstance>): void {
  for (const [, instance] of getPanels()) {
    instance.session.publishAccountInfo();
  }
}
