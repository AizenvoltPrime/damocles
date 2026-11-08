import type { HandlerDependencies, HandlerRegistry, PostMessageFn, ViewHandlerRegistry } from "../types";
import type { PanelHost } from "../../../../platform/window-service";
import type { SubscriptionUsageData } from "../../../../shared/types/usage";
import { PiRuntime } from "../../../pi-session/pi-runtime";
import { fetchSubscriptionUsage } from "../../../pi-session/subscription-usage";
import { describeAuthError } from "../../../pi-session/describe-error";
import { log } from "../../../logger";
import { l } from "../../../l10n";

/**
 * Posts exactly one subscriptionUsage reply, so the overlay never hangs in a loading state. It bypasses any chat session,
 * so the overlay opens mid-stream.
 */
async function answerSubscriptionUsage(post: PostMessageFn, host: PanelHost): Promise<void> {
  let data: SubscriptionUsageData;
  try {
    data = await fetchSubscriptionUsage(PiRuntime.get());
  } catch (err) {
    log("[UsageHandlers] subscription usage fetch failed: %s", describeAuthError(err));
    const error = l("Could not load subscription usage.");
    data = {
      claude: { status: 'error', bars: [], error },
      gpt: { status: 'error', bars: [], error },
      fetchedAt: Date.now(),
    };
  }
  post(host, { type: "subscriptionUsage", data });
}

/** The usage overlay of this core's chats, and of a remote chat's page, which main sends to this computer's core. */
export function createUsageHandlers(deps: Pick<HandlerDependencies, "postMessage">): { readonly handlers: Partial<HandlerRegistry>; readonly viewHandlers: ViewHandlerRegistry } {
  return {
    handlers: {
      requestSubscriptionUsage: (_msg, ctx) => answerSubscriptionUsage(deps.postMessage, ctx.reply),
    },
    viewHandlers: {
      requestSubscriptionUsage: (_msg, ctx) => answerSubscriptionUsage(deps.postMessage, ctx.host),
    },
  };
}
