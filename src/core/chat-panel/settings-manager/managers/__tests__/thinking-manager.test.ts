import { describe, it, expect, vi, beforeEach } from "vitest";
import { ThinkingManager } from "../thinking-manager";
import type { EffortLevel } from "../../../../../shared/types/settings";

function makeConfig(overrides: {
  thinkingDisabled?: boolean;
  effortByModel?: Record<string, EffortLevel | null>;
}): { get: <T>(key: string, defaultValue?: T) => T } {
  return {
    get: <T>(key: string, defaultValue?: T): T => {
      if (key === "damocles.thinkingDisabled") return (overrides.thinkingDisabled ?? defaultValue) as T;
      if (key === "damocles.effortByModel") return (overrides.effortByModel ?? defaultValue ?? {}) as T;
      return defaultValue as T;
    },
  };
}

const SONNET = "claude-sonnet-5-5";
// Opus 5.5 is a catalog `thinkingAlwaysOn` + `defaultEffort: high` entry; DeepSeek V4.1 Flash has neither.
const OPUS = "claude-opus-5-5";
const TOGGLE = "deepseek-flash";
const GPT = "gpt-6.1-sol";

describe("ThinkingManager", () => {
  let manager: ThinkingManager;
  const postMessage = vi.fn();

  beforeEach(() => {
    postMessage.mockClear();
    manager = new ThinkingManager(postMessage);
  });

  describe("restoreRecordedLevel", () => {
    it("takes the effort a resumed conversation's recorded pi level maps to, for that model only", () => {
      const config = makeConfig({ effortByModel: { [SONNET]: "low" } });
      manager.restoreRecordedLevel("panel-A", SONNET, "xhigh");
      expect(manager.resolveEffort("panel-A", SONNET, config as never, undefined)).toBe("xhigh");
      expect(manager.resolveEffort("panel-A", OPUS, config as never, undefined)).toBe("high");
      expect(manager.resolveEffort("panel-B", SONNET, config as never, undefined)).toBe("low");
      // pi's max is both max and ultracode, which run identically; max is the level the model lists first.
      manager.restoreRecordedLevel("panel-A", SONNET, "max");
      expect(manager.resolveEffort("panel-A", SONNET, config as never, undefined)).toBe("max");
    });

    it("turns thinking off or on where the model offers the switch, and keeps the panel's effort for a level the model lists no effort for", () => {
      const config = makeConfig({ thinkingDisabled: false, effortByModel: { [TOGGLE]: "high" } });
      manager.restoreRecordedLevel("panel-A", TOGGLE, "off");
      expect(manager.resolveDisabled("panel-A", TOGGLE, config as never, undefined)).toBe(true);
      expect(manager.resolveEffort("panel-A", TOGGLE, config as never, undefined)).toBe("high");
      const disabledByDefault = makeConfig({ thinkingDisabled: true });
      manager.restoreRecordedLevel("panel-B", TOGGLE, "low");
      expect(manager.resolveDisabled("panel-B", TOGGLE, disabledByDefault as never, undefined)).toBe(false);
      expect(manager.resolveEffort("panel-B", TOGGLE, disabledByDefault as never, undefined)).toBe("low");
      manager.restoreRecordedLevel("panel-C", GPT, "off");
      expect(manager.resolveDisabled("panel-C", GPT, disabledByDefault as never, undefined)).toBe(false);
    });
  });

  describe("resolveDisabled", () => {
    it("returns workspace default when no per-panel override", () => {
      const config = makeConfig({ thinkingDisabled: true });
      expect(manager.resolveDisabled("panel-A", TOGGLE, config as never, undefined)).toBe(true);
    });

    it("returns false default when nothing configured", () => {
      const config = makeConfig({});
      expect(manager.resolveDisabled("panel-A", TOGGLE, config as never, undefined)).toBe(false);
    });

    it("per-panel override beats workspace default", () => {
      const config = makeConfig({ thinkingDisabled: true });
      manager.setPanelDisabled("panel-A", false);
      expect(manager.resolveDisabled("panel-A", TOGGLE, config as never, undefined)).toBe(false);
    });

    it("stays false on a model that always thinks, whatever is stored", () => {
      const config = makeConfig({ thinkingDisabled: true });
      manager.setPanelDisabled("panel-A", true);
      expect(manager.resolveDisabled("panel-A", OPUS, config as never, undefined)).toBe(false);
    });

    // The settings panel shows no disable switch for OpenAI models, so a value stored on Sonnet must not reach them.
    it("stays false on an OpenAI model, whatever is stored", () => {
      const config = makeConfig({ thinkingDisabled: true });
      manager.setPanelDisabled("panel-A", true);
      expect(manager.resolveDisabled("panel-A", GPT, config as never, undefined)).toBe(false);
    });
  });

  describe("resolveEffort", () => {
    it("returns the level an unset effort runs at when neither panel nor workspace has a value and the model has no catalog default", () => {
      const config = makeConfig({});
      expect(manager.resolveEffort("panel-A", TOGGLE, config as never, undefined)).toBe("high");
      expect(manager.resolveEffort("panel-A", GPT, config as never, undefined)).toBe("medium");
    });

    it("falls back to the model's catalog defaultEffort when nothing is stored", () => {
      const config = makeConfig({});
      expect(manager.resolveEffort("panel-A", OPUS, config as never, undefined)).toBe("high");
    });

    it("a stored level still beats the catalog default", () => {
      const config = makeConfig({ effortByModel: { [OPUS]: "low" } });
      expect(manager.resolveEffort("panel-A", OPUS, config as never, undefined)).toBe("low");
      manager.setPanelEffort("panel-A", OPUS, "max");
      expect(manager.resolveEffort("panel-A", OPUS, config as never, undefined)).toBe("max");
    });

    it("falls back to workspace default per-model map", () => {
      const config = makeConfig({ effortByModel: { [SONNET]: "high" } });
      expect(manager.resolveEffort("panel-A", SONNET, config as never, undefined)).toBe("high");
    });

    it("per-(panel, model) override beats workspace default", () => {
      const config = makeConfig({ effortByModel: { [SONNET]: "low" } });
      manager.setPanelEffort("panel-A", SONNET, "max");
      expect(manager.resolveEffort("panel-A", SONNET, config as never, undefined)).toBe("max");
    });

    it("US-002 acceptance: switching models within a panel preserves the matrix", () => {
      const config = makeConfig({});
      manager.setPanelEffort("panel-A", SONNET, "max");
      manager.setPanelEffort("panel-A", OPUS, "high");
      expect(manager.resolveEffort("panel-A", SONNET, config as never, undefined)).toBe("max");
      expect(manager.resolveEffort("panel-A", OPUS, config as never, undefined)).toBe("high");
    });

    it("ignores a stored value no longer in supportedEffortLevels (capability regression)", () => {
      const config = makeConfig({ effortByModel: { [TOGGLE]: "fake-level" as EffortLevel } });
      expect(manager.resolveEffort("panel-A", TOGGLE, config as never, undefined)).toBe("high");
    });

    it("returns null for unknown models", () => {
      const config = makeConfig({ effortByModel: { "unknown-model": "high" } });
      expect(manager.resolveEffort("panel-A", "unknown-model", config as never, undefined)).toBeNull();
    });

    // A settings file the startup migrations never visit still holds entries under retired ids.
    it("reads an entry stored under a retired id that maps to the model, renamed before the clamp", () => {
      const config = makeConfig({
        effortByModel: { "deepseek-v4-flash": "xhigh", "claude-haiku-4-5-20251001": "low", "step-3.7-flash": "none" },
      });
      expect(manager.resolveEffort("panel-A", "deepseek-flash", config as never, undefined)).toBe("max");
      expect(manager.resolveEffort("panel-A", "claude-haiku-5-5", config as never, undefined)).toBe("low");
      expect(manager.resolveEffort("panel-A", "step-5-preview", config as never, undefined)).toBe("low");
    });

    it("prefers the model's own entry over one stored under a retired id", () => {
      const config = makeConfig({ effortByModel: { "step-3.7-flash": "high", "step-5-preview": "medium" } });
      expect(manager.resolveEffort("panel-A", "step-5-preview", config as never, undefined)).toBe("medium");
    });
  });

  describe("setPanelEffort", () => {
    it("throws when effort is not in supportedEffortLevels for the model", () => {
      expect(() => manager.setPanelEffort("panel-A", SONNET, "fake" as EffortLevel)).toThrow(
        /not supported/,
      );
    });

    it("null clears the entry and falls through to workspace default", () => {
      const config = makeConfig({ effortByModel: { [SONNET]: "high" } });
      manager.setPanelEffort("panel-A", SONNET, "max");
      expect(manager.resolveEffort("panel-A", SONNET, config as never, undefined)).toBe("max");
      manager.setPanelEffort("panel-A", SONNET, null);
      expect(manager.resolveEffort("panel-A", SONNET, config as never, undefined)).toBe("high");
    });
  });

  describe("copyPanelStateTo (US-002 panel cloning)", () => {
    it("copies disabled and the effort matrix to the target panel", () => {
      const config = makeConfig({});
      manager.setPanelDisabled("panel-A", true);
      manager.setPanelEffort("panel-A", SONNET, "max");
      manager.setPanelEffort("panel-A", OPUS, "high");

      manager.copyPanelStateTo("panel-A", "panel-B");

      expect(manager.resolveDisabled("panel-B", TOGGLE, config as never, undefined)).toBe(true);
      expect(manager.resolveEffort("panel-B", SONNET, config as never, undefined)).toBe("max");
      expect(manager.resolveEffort("panel-B", OPUS, config as never, undefined)).toBe("high");
    });

    it("clone is independent — mutating the source after copy does not affect the target", () => {
      const config = makeConfig({});
      manager.setPanelEffort("panel-A", SONNET, "max");
      manager.copyPanelStateTo("panel-A", "panel-B");
      manager.setPanelEffort("panel-A", SONNET, "low");
      expect(manager.resolveEffort("panel-B", SONNET, config as never, undefined)).toBe("max");
    });
  });

  describe("cleanupPanelThinking", () => {
    it("removes all per-panel state", () => {
      const config = makeConfig({ thinkingDisabled: false });
      manager.setPanelDisabled("panel-A", true);
      manager.setPanelEffort("panel-A", TOGGLE, "low");

      manager.cleanupPanelThinking("panel-A");

      expect(manager.resolveDisabled("panel-A", TOGGLE, config as never, undefined)).toBe(false);
      expect(manager.resolveEffort("panel-A", TOGGLE, config as never, undefined)).toBe("high");
    });
  });

  describe("sendThinkingForPanel", () => {
    it("posts panelThinkingUpdate with panel resolved at activeModel and defaults at defaultModel", () => {
      const host = { webview: { postMessage: vi.fn() } } as never;
      const config = makeConfig({
        thinkingDisabled: false,
        effortByModel: { [SONNET]: "low", [OPUS]: "max" },
      });
      manager.setPanelEffort("panel-A", SONNET, "high");

      manager.sendThinkingForPanel(host, "panel-A", SONNET, OPUS, config as never, undefined);

      expect(postMessage).toHaveBeenCalledWith(host, {
        type: "panelThinkingUpdate",
        panel: { thinkingDisabled: false, effort: "high" },
        panelModel: SONNET,
        defaults: { thinkingDisabled: false, effort: "max" },
        defaultsModel: OPUS,
      });
    });

    it("defaults column applies the disable gate and the catalog default for the default model", () => {
      const host = { webview: { postMessage: vi.fn() } } as never;
      const config = makeConfig({ thinkingDisabled: true, effortByModel: {} });

      manager.sendThinkingForPanel(host, "panel-A", SONNET, OPUS, config as never, undefined);
      expect(postMessage).toHaveBeenLastCalledWith(host, expect.objectContaining({
        defaults: { thinkingDisabled: false, effort: "high" },
      }));

      manager.sendThinkingForPanel(host, "panel-A", OPUS, TOGGLE, config as never, undefined);
      expect(postMessage).toHaveBeenLastCalledWith(host, expect.objectContaining({
        defaults: { thinkingDisabled: true, effort: "high" },
      }));
    });

    it("defaults column reads an entry stored under a retired id of the default model", () => {
      const host = { webview: { postMessage: vi.fn() } } as never;
      const config = makeConfig({ effortByModel: { "claude-haiku-4-5-20251001": "low" } });

      manager.sendThinkingForPanel(host, "panel-A", SONNET, "claude-haiku-5-5", config as never, undefined);
      expect(postMessage).toHaveBeenLastCalledWith(host, expect.objectContaining({
        defaults: expect.objectContaining({ effort: "low" }),
      }));
    });

    it("defaults column falls back to the catalog default when the stored level is unsupported", () => {
      const host = { webview: { postMessage: vi.fn() } } as never;
      const config = makeConfig({ effortByModel: { [OPUS]: "none" } });

      manager.sendThinkingForPanel(host, "panel-A", SONNET, OPUS, config as never, undefined);
      expect(postMessage).toHaveBeenLastCalledWith(host, expect.objectContaining({
        defaults: expect.objectContaining({ effort: "high" }),
      }));
    });

    it("defaults effort tracks the workspace default model independently of activeModel", () => {
      const host = { webview: { postMessage: vi.fn() } } as never;
      const config = makeConfig({
        effortByModel: { [SONNET]: "low", [OPUS]: "max" },
      });

      manager.sendThinkingForPanel(host, "panel-A", SONNET, OPUS, config as never, undefined);
      expect(postMessage).toHaveBeenLastCalledWith(host, expect.objectContaining({
        defaults: expect.objectContaining({ effort: "max" }),
        defaultsModel: OPUS,
      }));

      manager.sendThinkingForPanel(host, "panel-A", OPUS, SONNET, config as never, undefined);
      expect(postMessage).toHaveBeenLastCalledWith(host, expect.objectContaining({
        defaults: expect.objectContaining({ effort: "low" }),
        defaultsModel: SONNET,
      }));
    });
  });
});
