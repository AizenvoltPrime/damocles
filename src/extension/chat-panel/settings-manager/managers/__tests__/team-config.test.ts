import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigManager } from "../config-manager";
import type { ExtensionSettings } from "../../../../../shared/types/settings";

/**
 * Single mutable record backing the vscode configuration mock. `getConfiguration`
 * always returns the same stub so reads/writes share state within a test. `.inspect`
 * returns `{}` so `updateConfigAtEffectiveScope` targets Global (no workspace folders).
 */
const record: Record<string, unknown> = {};

const configStub = {
  get: <T>(key: string, def?: T): T => {
    return (Object.hasOwn(record, key) ? record[key] : def) as T;
  },
  update: (key: string, value: unknown, _target?: unknown): Promise<void> => {
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
}));

function resetRecord(): void {
  for (const key of Object.keys(record)) delete record[key];
}

const permStub = {
  getPermissionMode: () => "default",
  getDangerouslySkipPermissions: () => false,
} as never;

const hostStub = {} as never;

describe("ConfigManager — team role settings", () => {
  let manager: ConfigManager;
  const postMessage = vi.fn();

  beforeEach(() => {
    resetRecord();
    postMessage.mockClear();
    manager = new ConfigManager(postMessage);
  });

  describe("handleSetTeamRoleModel", () => {
    it("writes the role model key and clears a stale sibling effort", async () => {
      // deepseek-v4-pro supports only ['high','max']; a stored 'xhigh' must be cleared.
      record["team.implementorEffort"] = "xhigh";

      await manager.handleSetTeamRoleModel("implementor", "deepseek-v4-pro");

      expect(record["team.implementorModel"]).toBe("deepseek-v4-pro");
      expect(record["team.implementorEffort"]).toBe("");
    });

    it("preserves a sibling effort the new model still supports", async () => {
      record["team.leadEffort"] = "high";

      await manager.handleSetTeamRoleModel("lead", "deepseek-v4-pro");

      expect(record["team.leadModel"]).toBe("deepseek-v4-pro");
      expect(record["team.leadEffort"]).toBe("high");
    });

    it("throws on an unknown model", async () => {
      await expect(
        manager.handleSetTeamRoleModel("reviewer", "not-a-real-model"),
      ).rejects.toThrow(/not a known model/);
    });

    it("accepts empty string (active panel model) without throwing", async () => {
      await manager.handleSetTeamRoleModel("lead", "");
      expect(record["team.leadModel"]).toBe("");
    });
  });

  describe("handleSetTeamRoleEffort", () => {
    it("throws on an unsupported effort for the effective model", async () => {
      record["team.reviewerModel"] = "deepseek-v4-pro"; // supports only ['high','max']
      await expect(
        manager.handleSetTeamRoleEffort("reviewer", "low"),
      ).rejects.toThrow(/not supported/);
    });

    it("writes empty string for a null effort", async () => {
      record["team.leadModel"] = "gpt-5.6-sol";
      await manager.handleSetTeamRoleEffort("lead", null);
      expect(record["team.leadEffort"]).toBe("");
    });

    it("writes the effort string for a supported (model, effort) pair", async () => {
      record["team.leadModel"] = "gpt-5.6-sol"; // supports xhigh
      await manager.handleSetTeamRoleEffort("lead", "xhigh");
      expect(record["team.leadEffort"]).toBe("xhigh");
    });

    it("falls back to the active panel model when the role model is empty", async () => {
      record["model"] = "gpt-5.6-sol";
      // role model empty → effective model is the active panel model (gpt-5.6-sol, supports high)
      await manager.handleSetTeamRoleEffort("implementor", "high");
      expect(record["team.implementorEffort"]).toBe("high");
    });

    it("fresh install (no workspace model, empty role model) validates against the fallback model", async () => {
      // Regression: with damocles.model unset AND the role model empty, the effective model must fall
      // back to DEFAULT_FALLBACK_MODEL (Opus) instead of "" — validating against "" threw before.
      await manager.handleSetTeamRoleEffort("lead", "ultracode"); // Opus supports ultracode
      expect(record["team.leadEffort"]).toBe("ultracode");
    });

    it("fresh install still rejects an effort the fallback model does not support", async () => {
      // DeepSeek-only 'low' is unsupported by the Opus fallback → must still throw loudly.
      await expect(manager.handleSetTeamRoleEffort("reviewer", "none")).rejects.toThrow(/not supported/);
    });

    it("migrates a stored DeepSeek xhigh to max at read time (parity with runtime resolver)", async () => {
      record["team.reviewerModel"] = "deepseek-v4-pro"; // xhigh renamed to max in pi 0.80.6
      record["team.reviewerEffort"] = "xhigh";

      await manager.sendCurrentSettings(hostStub, permStub);

      const [, msg] = postMessage.mock.calls[0];
      const team = (msg.settings as ExtensionSettings).team;
      expect(team.reviewerEffort).toBe("max");
    });
  });

  describe("sendCurrentSettings", () => {
    it("migrates a legacy stored model and coerces an invalid stored effort to null", async () => {
      record["team.leadModel"] = "gpt-5.5"; // legacy → gpt-5.6-sol
      record["team.leadEffort"] = "ultracode"; // gpt-5.6-sol does NOT support ultracode

      await manager.sendCurrentSettings(hostStub, permStub);

      expect(postMessage).toHaveBeenCalledTimes(1);
      const [, msg] = postMessage.mock.calls[0];
      expect(msg.type).toBe("settingsUpdate");
      const team = (msg.settings as ExtensionSettings).team;
      expect(team.leadModel).toBe("gpt-5.6-sol");
      expect(team.leadEffort).toBeNull();
    });

    it("emits stored role values unchanged when the (model, effort) pair is valid", async () => {
      record["team.reviewerModel"] = "deepseek-v4-pro";
      record["team.reviewerEffort"] = "max";

      await manager.sendCurrentSettings(hostStub, permStub);

      const [, msg] = postMessage.mock.calls[0];
      const team = (msg.settings as ExtensionSettings).team;
      expect(team.reviewerModel).toBe("deepseek-v4-pro");
      expect(team.reviewerEffort).toBe("max");
    });

    it("defaults all roles to empty model + null effort when nothing is stored", async () => {
      await manager.sendCurrentSettings(hostStub, permStub);

      const [, msg] = postMessage.mock.calls[0];
      const team = (msg.settings as ExtensionSettings).team;
      expect(team).toEqual({
        leadModel: "",
        leadEffort: null,
        implementorModel: "",
        implementorEffort: null,
        reviewerModel: "",
        reviewerEffort: null,
      });
    });
  });
});
