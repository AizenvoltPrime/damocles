import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({
  fetchSubscriptionUsage: vi.fn(),
}));

// The handler builds a runtime and delegates fetching; stub both so we test only its fail-soft wiring.
vi.mock("../../../../pi-session/pi-runtime", () => ({
  PiRuntime: { get: vi.fn(() => ({})) },
}));
vi.mock("../../../../pi-session/agent-dir", () => ({ PI_AGENT_DIR: "/fake/agent" }));
vi.mock("../../../../pi-session/subscription-usage", () => ({
  fetchSubscriptionUsage: H.fetchSubscriptionUsage,
}));

import { createUsageHandlers } from "../usage-handlers";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage } from "../../../../../shared/types/messages";

function setup() {
  const posted: ExtensionToWebviewMessage[] = [];
  const deps = {
    workspacePath: "/ws",
    postMessage: vi.fn((_host: unknown, msg: ExtensionToWebviewMessage) => { posted.push(msg); }),
  } as unknown as HandlerDependencies;
  const ctx = { host: {} } as unknown as HandlerContext;
  const handler = createUsageHandlers(deps).requestSubscriptionUsage!;
  return { handler, ctx, posted };
}

const OK_DATA = {
  claude: { status: "ok" as const, bars: [] },
  gpt: { status: "not-connected" as const, bars: [] },
  fetchedAt: 111,
};

describe("createUsageHandlers", () => {
  beforeEach(() => {
    H.fetchSubscriptionUsage.mockReset();
  });

  it("posts exactly one subscriptionUsage reply carrying the fetched data", async () => {
    H.fetchSubscriptionUsage.mockResolvedValue(OK_DATA);
    const { handler, ctx, posted } = setup();

    await handler({ type: "requestSubscriptionUsage" } as never, ctx);

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({ type: "subscriptionUsage", data: OK_DATA });
  });

  it("still posts exactly one reply (both providers errored) when the fetch throws", async () => {
    H.fetchSubscriptionUsage.mockRejectedValue(new Error("boom"));
    const { handler, ctx, posted } = setup();

    await handler({ type: "requestSubscriptionUsage" } as never, ctx);

    expect(posted).toHaveLength(1);
    const msg = posted[0] as Extract<ExtensionToWebviewMessage, { type: "subscriptionUsage" }>;
    expect(msg.type).toBe("subscriptionUsage");
    expect(msg.data.claude).toEqual({ status: "error", bars: [], error: "boom" });
    expect(msg.data.gpt).toEqual({ status: "error", bars: [], error: "boom" });
    expect(typeof msg.data.fetchedAt).toBe("number");
  });

  it("coerces a non-Error throw to a string error without hanging", async () => {
    H.fetchSubscriptionUsage.mockRejectedValue("weird");
    const { handler, ctx, posted } = setup();

    await handler({ type: "requestSubscriptionUsage" } as never, ctx);

    expect(posted).toHaveLength(1);
    const msg = posted[0] as Extract<ExtensionToWebviewMessage, { type: "subscriptionUsage" }>;
    expect(msg.data.claude.error).toBe("weird");
  });
});
