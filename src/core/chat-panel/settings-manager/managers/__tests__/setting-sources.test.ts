import { describe, expect, it } from "vitest";
import { ConfigManager } from "../config-manager";
import { createFakePlatform, type FakePlatformInit } from "../../../../../__mocks__/fake-platform";
import type { ExtensionToWebviewMessage } from "../../../../../shared/types/messages";

const permStub = { getPermissionMode: () => "default", getDangerouslySkipPermissions: () => false } as never;

const settingsInit: NonNullable<FakePlatformInit["settings"]> = {
  user: { "damocles.maxTurns": 5, "damocles.model": "user-model" },
  project: { "damocles.model": "project-model", "damocles.debug": true },
  local: { "damocles.debug": false },
  scopeFiles: { user: "/home/.damocles/settings.json", project: "/ws/.damocles/settings.json", local: "/ws/.damocles/settings.local.json" },
};

async function settingsUpdate(settingsSources: boolean): Promise<Extract<ExtensionToWebviewMessage, { type: "settingsUpdate" }>> {
  const platform = createFakePlatform({ settings: settingsInit, capabilities: { settingsSources } });
  const posted: ExtensionToWebviewMessage[] = [];
  await new ConfigManager((_host, message) => posted.push(message), platform).sendCurrentSettings({} as never, permStub, undefined);
  const found = posted.find((m) => m.type === "settingsUpdate");
  if (found?.type !== "settingsUpdate") throw new Error("no settingsUpdate posted");
  return found;
}

describe("settingsUpdate settingSources", () => {
  it("names the project or local file behind every contributed key that one supplies, with the value that file holds", async () => {
    const message = await settingsUpdate(true);
    expect(message.settingSources).toStrictEqual({
      "damocles.model": { scope: "project", path: "/ws/.damocles/settings.json", value: "project-model" },
      "damocles.debug": { scope: "local", path: "/ws/.damocles/settings.local.json", value: false },
    });
  });

  it("is absent when the host does not show setting sources (VS Code)", async () => {
    const message = await settingsUpdate(false);
    expect("settingSources" in message).toBe(false);
  });
});
