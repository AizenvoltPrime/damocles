import { describe, it, expect, vi } from "vitest";

/**
 * The real `ConfigManager` stands in for the settings-manager facade, which delegates
 * `handleSetCacheWarming` straight to it. That makes this a test of the whole route: router case ->
 * config-manager writer -> VS Code config write.
 */
const record: Record<string, unknown> = {};

let updateFails = false;

const configStub = {
  get: <T>(key: string, def?: T): T => (Object.hasOwn(record, key) ? record[key] : def) as T,
  update: (key: string, value: unknown, _target?: unknown): Promise<void> => {
    if (updateFails) return Promise.reject(new Error("boom"));
    record[key] = value;
    return Promise.resolve();
  },
  inspect: (_key: string): Record<string, unknown> => ({}),
};

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => configStub,
    workspaceFolders: undefined,
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  l10n: { t: (message: string) => message },
  // The failure branch logs, and the logger opens an output channel on first use.
  window: { createOutputChannel: () => ({ appendLine: () => {} }) },
}));

import { createSettingsHandlers } from "../settings-handlers";
import { ConfigManager } from "../../../settings-manager/managers/config-manager";
import type { SettingsManager } from "../../../settings-manager";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { WebviewToExtensionMessage } from "../../../../../shared/types/messages";

/** Typing the stub against the real class is what makes a rename or a signature change fail to compile. */
type CacheWarmingRoute = Pick<SettingsManager, "handleSetCacheWarming" | "sendCurrentSettings">;

function route() {
  const configManager = new ConfigManager(vi.fn());
  const settingsManager: CacheWarmingRoute = {
    handleSetCacheWarming: (mode) => configManager.handleSetCacheWarming(mode),
    sendCurrentSettings: vi.fn(async () => {}),
  };
  const postMessage = vi.fn();
  // Only the three fields this route touches are supplied; the cast goes through `Partial` so the
  // fields that ARE supplied stay type-checked against the real dependency types.
  const deps = {
    postMessage,
    settingsManager: settingsManager as SettingsManager,
    getPanels: () => new Map(),
  } as Partial<HandlerDependencies> as HandlerDependencies;
  const ctx = { host: {}, permissionHandler: {} } as unknown as HandlerContext;

  async function run(msg: WebviewToExtensionMessage): Promise<void> {
    await createSettingsHandlers(deps)[msg.type]!(msg, ctx);
  }

  return { settingsManager, postMessage, run };
}

describe("createSettingsHandlers — setCacheWarming", () => {
  it("routes the message to the config-manager writer", async () => {
    updateFails = false;
    const { settingsManager, run } = route();

    await run({ type: "setCacheWarming", mode: "idle" });

    expect(record["cacheWarming"]).toBe("idle");
    expect(settingsManager.sendCurrentSettings).toHaveBeenCalledOnce();
  });

  // The webview posts a plain string, so a stale panel or a hand-crafted message can carry a mode pi
  // does not know. Storing it verbatim would leave the file disagreeing with pi's own coercion.
  it("stores the default rather than a mode outside the enum", async () => {
    updateFails = false;
    delete record["cacheWarming"];
    const { run } = route();

    // Typed through `unknown` on purpose: the point is a payload the union does not admit.
    await run({ type: "setCacheWarming", mode: "always" } as unknown as WebviewToExtensionMessage);

    expect(record["cacheWarming"]).toBe("streaming");
  });

  // App.vue writes the store optimistically before posting, so a failed write has to be undone by a
  // fresh broadcast or the panel keeps showing a mode that was never saved.
  it("notifies and re-broadcasts the saved settings when the write throws", async () => {
    updateFails = true;
    const { settingsManager, postMessage, run } = route();

    await run({ type: "setCacheWarming", mode: "idle" });

    expect(postMessage).toHaveBeenCalledWith({}, {
      type: "notification",
      message: "Failed to save cache warming setting: {0}",
      notificationType: "error",
    });
    expect(settingsManager.sendCurrentSettings).toHaveBeenCalledOnce();
  });
});
