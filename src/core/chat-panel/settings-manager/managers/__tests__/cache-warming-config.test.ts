import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigManager } from "../config-manager";
import { createFakePlatform } from "../../../../../__mocks__/fake-platform";
import type { SettingsScope, SettingsStore } from "../../../../../platform/settings-store";
import type { ExtensionSettings } from "../../../../../shared/types/settings";

/**
 * Single mutable record backing the settings stub, as in `team-config.test.ts`.
 * `workspaceScoped` makes `.inspect` report a project value, which is what would steer an
 * effective-scope write away from the user scope.
 */
let workspaceScoped = false;
const record: Record<string, unknown> = {};
const updates: Array<{ key: string; value: unknown; target: SettingsScope }> = [];

const bare = (key: string): string => key.replace(/^damocles\./, "");

const settings = {
  get: <T>(key: string, def?: T): T => {
    return (Object.hasOwn(record, bare(key)) ? record[bare(key)] : def) as T;
  },
  update: (key: string, value: unknown, target: SettingsScope): Promise<void> => {
    record[bare(key)] = value;
    updates.push({ key, value, target });
    return Promise.resolve();
  },
  inspect: () => (workspaceScoped ? { projectValue: "idle" } : {}),
  onDidChange: () => ({ dispose: () => {} }),
  scopeFile: () => undefined,
} as SettingsStore;

const platform = { ...createFakePlatform(), settings };

const permStub = {
  getPermissionMode: () => "default",
  getDangerouslySkipPermissions: () => false,
} as never;

const hostStub = {} as never;

describe("ConfigManager — cacheWarming", () => {
  let manager: ConfigManager;
  const postMessage = vi.fn();

  beforeEach(() => {
    for (const key of Object.keys(record)) delete record[key];
    workspaceScoped = false;
    updates.length = 0;
    postMessage.mockClear();
    manager = new ConfigManager(postMessage, platform);
  });

  async function readBack(): Promise<ExtensionSettings["cacheWarming"]> {
    await manager.sendCurrentSettings(hostStub, permStub);
    const [, msg] = postMessage.mock.calls[0]!;
    return (msg.settings as ExtensionSettings).cacheWarming;
  }

  it("defaults to streaming when the key is unset", async () => {
    expect(await readBack()).toBe("streaming");
  });

  it("reads back idle", async () => {
    record["cacheWarming"] = "idle";
    expect(await readBack()).toBe("idle");
  });

  it("reads back off", async () => {
    record["cacheWarming"] = "off";
    expect(await readBack()).toBe("off");
  });

  // A hand-edited settings.json reaches the panel as whatever string the user typed. pi coerces an
  // unknown mode to "streaming", so the panel has to show the same thing pi will do.
  it("resolves a stored value outside the enum to the default", async () => {
    record["cacheWarming"] = "always";
    expect(await readBack()).toBe("streaming");
  });

  it("resolves a stored non-string to the default", async () => {
    record["cacheWarming"] = { mode: "idle" };
    expect(await readBack()).toBe("streaming");
  });

  // Warming bills the user, so the write goes to the user-level settings file and never to a repo's
  // .vscode/settings.json, whatever the effective scope of the key would otherwise be.
  it("writes the mode to damocles.cacheWarming at the user scope", async () => {
    await manager.handleSetCacheWarming("idle");

    expect(updates).toContainEqual({
      key: "damocles.cacheWarming",
      value: "idle",
      target: "user",
    });
  });

  it("keeps writing globally when the key already has a workspace value", async () => {
    workspaceScoped = true;
    await manager.handleSetCacheWarming("off");

    expect(updates[0]?.target).toBe("user");
  });
});
