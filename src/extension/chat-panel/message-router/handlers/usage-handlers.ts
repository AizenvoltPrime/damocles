import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { SubscriptionUsageData } from "../../../../shared/types/usage";
import { PiRuntime } from "../../../pi-session/pi-runtime";
import { PI_AGENT_DIR } from "../../../pi-session/agent-dir";
import { fetchSubscriptionUsage } from "../../../pi-session/subscription-usage";

/**
 * Subscription usage overlay. Bypasses ctx.session entirely so the overlay opens mid-stream, and
 * always posts exactly one reply so the webview never hangs in a loading state.
 */
export function createUsageHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  return {
    requestSubscriptionUsage: async (_msg, ctx) => {
      let data: SubscriptionUsageData;
      try {
        data = await fetchSubscriptionUsage(PiRuntime.get(deps.workspacePath, PI_AGENT_DIR));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        data = {
          claude: { status: 'error', bars: [], error },
          gpt: { status: 'error', bars: [], error },
          fetchedAt: Date.now(),
        };
      }
      deps.postMessage(ctx.host, { type: "subscriptionUsage", data });
    },
  };
}
