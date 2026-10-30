import { describe, expect, it, vi } from "vitest";
import { createSettingsHandlers } from "../settings-handlers";
import { createFakePlatform } from "../../../../../__mocks__/fake-platform";
import type { RemoteHost } from "../../../../../platform/remote-host";
import type { ExtensionToWebviewMessage } from "../../../../../shared/types/messages";
import type { HandlerContext, HandlerDependencies } from "../../types";

// A daemon's core with no attached client has no policy, so YOLO is refused.
const refusingRemote = { clients: { acting: () => undefined } } as unknown as RemoteHost;

describe("the default YOLO switch on a host whose policy refuses YOLO", () => {
  it("answers the settings row with a failed write that says why, and writes nothing", async () => {
    const posted: ExtensionToWebviewMessage[] = [];
    const platform = { ...createFakePlatform(), remote: refusingRemote };
    const update = vi.spyOn(platform.settings, "update");
    const deps = {
      postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => posted.push(message),
      platform,
      settingsManager: { sendCurrentSettings: vi.fn(async () => undefined) },
    } as unknown as HandlerDependencies;
    const ctx = { host: {}, panelId: "p1" } as unknown as HandlerContext;
    await createSettingsHandlers(deps).setDefaultDangerouslySkipPermissions!({ type: "setDefaultDangerouslySkipPermissions", enabled: true }, ctx);
    expect(posted).toContainEqual({ type: "permissionModeRefused", mode: "dangerouslySkipPermissions", reason: "remote-host" });
    expect(posted).toContainEqual({ type: "settingWriteResult", key: "damocles.dangerouslySkipPermissions", ok: false, error: { message: "YOLO is off for your turns on this host." } });
    expect(update).not.toHaveBeenCalled();
  });
});
