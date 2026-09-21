import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { ConfigManager } from "../config-manager";
import type { ExtensionSettings } from "../../../../../shared/types/settings";

/**
 * Single mutable record backing the vscode configuration mock, as in `team-config.test.ts`.
 * `workspaceScoped` makes `.inspect` report a workspace value, which is what would steer an
 * effective-scope write away from Global.
 */
let workspaceScoped = false;
const record: Record<string, unknown> = {};
const sections: string[] = [];
const updates: Array<{ key: string; value: unknown; target: unknown }> = [];

const configStub = {
  get: <T>(key: string, def?: T): T => {
    return (Object.hasOwn(record, key) ? record[key] : def) as T;
  },
  update: (key: string, value: unknown, target?: unknown): Promise<void> => {
    record[key] = value;
    updates.push({ key, value, target });
    return Promise.resolve();
  },
  inspect: (_key: string): Record<string, unknown> => (workspaceScoped ? { workspaceValue: "idle" } : {}),
};

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: (section: string) => {
      sections.push(section);
      return configStub;
    },
    workspaceFolders: undefined,
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
}));

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
    sections.length = 0;
    updates.length = 0;
    postMessage.mockClear();
    manager = new ConfigManager(postMessage);
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
  it("writes the mode to damocles.cacheWarming at the global target", async () => {
    await manager.handleSetCacheWarming("idle");

    expect(sections).toContain("damocles");
    expect(updates).toContainEqual({
      key: "cacheWarming",
      value: "idle",
      target: vscode.ConfigurationTarget.Global,
    });
  });

  it("keeps writing globally when the key already has a workspace value", async () => {
    workspaceScoped = true;
    await manager.handleSetCacheWarming("off");

    expect(updates[0]?.target).toBe(vscode.ConfigurationTarget.Global);
  });
});
