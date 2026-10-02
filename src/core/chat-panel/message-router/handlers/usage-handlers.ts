import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { SubscriptionUsageData } from "../../../../shared/types/usage";
import { PiRuntime } from "../../../pi-session/pi-runtime";
import { fetchSubscriptionUsage } from "../../../pi-session/subscription-usage";
import { describeAuthError } from "../../../pi-session/describe-error";
import { log } from "../../../logger";
import { t } from "../../../l10n";

/**
 * Subscription usage overlay. Bypasses ctx.session entirely so the overlay opens mid-stream, and
 * always posts exactly one reply so the webview never hangs in a loading state.
 */
export function createUsageHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  return {
    requestSubscriptionUsage: async (_msg, ctx) => {
      let data: SubscriptionUsageData;
      try {
        data = await fetchSubscriptionUsage(PiRuntime.get());
      } catch (err) {
        log("[UsageHandlers] subscription usage fetch failed: %s", describeAuthError(err));
        const error = t("Could not load subscription usage.");
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
