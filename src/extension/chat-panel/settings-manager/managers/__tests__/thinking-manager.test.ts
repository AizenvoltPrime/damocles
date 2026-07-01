import { describe, it, expect, vi, beforeEach } from "vitest";
import { ThinkingManager } from "../thinking-manager";
import type { EffortLevel } from "../../../../../shared/types/settings";

vi.mock("vscode", () => ({}));

function makeConfig(overrides: {
  thinkingDisabled?: boolean;
  effortByModel?: Record<string, EffortLevel | null>;
  maxThinkingTokens?: number | null;
}): { get: <T>(key: string, defaultValue?: T) => T } {
  return {
    get: <T>(key: string, defaultValue?: T): T => {
      if (key === "thinkingDisabled") return (overrides.thinkingDisabled ?? defaultValue) as T;
      if (key === "effortByModel") return (overrides.effortByModel ?? defaultValue ?? {}) as T;
      if (key === "maxThinkingTokens") return (overrides.maxThinkingTokens ?? defaultValue ?? null) as T;
      return defaultValue as T;
    },
  };
}

const SONNET = "claude-sonnet-5";
const OPUS = "claude-opus-4-8";

describe("ThinkingManager", () => {
  let manager: ThinkingManager;
  const postMessage = vi.fn();

  beforeEach(() => {
    postMessage.mockClear();
    manager = new ThinkingManager(postMessage);
  });

  describe("resolveDisabled", () => {
    it("returns workspace default when no per-panel override", () => {
      const config = makeConfig({ thinkingDisabled: true });
      expect(manager.resolveDisabled("panel-A", config as never)).toBe(true);
    });

    it("returns false default when nothing configured", () => {
      const config = makeConfig({});
      expect(manager.resolveDisabled("panel-A", config as never)).toBe(false);
    });

    it("per-panel override beats workspace default", () => {
      const config = makeConfig({ thinkingDisabled: true });
      manager.setPanelDisabled("panel-A", false);
      expect(manager.resolveDisabled("panel-A", config as never)).toBe(false);
    });
  });

  describe("resolveEffort", () => {
    it("returns null when neither panel nor workspace has a value", () => {
      const config = makeConfig({});
      expect(manager.resolveEffort("panel-A", SONNET, config as never)).toBeNull();
    });

    it("falls back to workspace default per-model map", () => {
      const config = makeConfig({ effortByModel: { [SONNET]: "high" } });
      expect(manager.resolveEffort("panel-A", SONNET, config as never)).toBe("high");
    });

    it("per-(panel, model) override beats workspace default", () => {
      const config = makeConfig({ effortByModel: { [SONNET]: "low" } });
      manager.setPanelEffort("panel-A", SONNET, "max");
      expect(manager.resolveEffort("panel-A", SONNET, config as never)).toBe("max");
    });

    it("US-002 acceptance: switching models within a panel preserves the matrix", () => {
      const config = makeConfig({});
      manager.setPanelEffort("panel-A", SONNET, "max");
      manager.setPanelEffort("panel-A", OPUS, "high");
      expect(manager.resolveEffort("panel-A", SONNET, config as never)).toBe("max");
      expect(manager.resolveEffort("panel-A", OPUS, config as never)).toBe("high");
    });

    it("returns null when stored value is no longer in supportedEffortLevels (capability regression)", () => {
      const config = makeConfig({ effortByModel: { [SONNET]: "fake-level" as EffortLevel } });
      expect(manager.resolveEffort("panel-A", SONNET, config as never)).toBeNull();
    });

    it("returns null for unknown models", () => {
      const config = makeConfig({ effortByModel: { "unknown-model": "high" } });
      expect(manager.resolveEffort("panel-A", "unknown-model", config as never)).toBeNull();
    });
  });

  describe("resolveMaxTokens", () => {
    it("returns workspace default when no per-panel override", () => {
      const config = makeConfig({ maxThinkingTokens: 32000 });
      expect(manager.resolveMaxTokens("panel-A", SONNET, config as never)).toBe(32000);
    });

    it("per-(panel, model) override beats workspace default", () => {
      const config = makeConfig({ maxThinkingTokens: 32000 });
      manager.setPanelMaxTokens("panel-A", SONNET, 16000);
      expect(manager.resolveMaxTokens("panel-A", SONNET, config as never)).toBe(16000);
    });

    it("returns null when nothing configured", () => {
      const config = makeConfig({});
      expect(manager.resolveMaxTokens("panel-A", SONNET, config as never)).toBeNull();
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
      expect(manager.resolveEffort("panel-A", SONNET, config as never)).toBe("max");
      manager.setPanelEffort("panel-A", SONNET, null);
      expect(manager.resolveEffort("panel-A", SONNET, config as never)).toBe("high");
    });
  });

  describe("setPanelMaxTokens", () => {
    it("null clears the entry and falls through to workspace default", () => {
      const config = makeConfig({ maxThinkingTokens: 32000 });
      manager.setPanelMaxTokens("panel-A", SONNET, 16000);
      expect(manager.resolveMaxTokens("panel-A", SONNET, config as never)).toBe(16000);
      manager.setPanelMaxTokens("panel-A", SONNET, null);
      expect(manager.resolveMaxTokens("panel-A", SONNET, config as never)).toBe(32000);
    });
  });

  describe("copyPanelStateTo (US-002 panel cloning)", () => {
    it("copies disabled, effort matrix, and max-tokens matrix to the target panel", () => {
      const config = makeConfig({});
      manager.setPanelDisabled("panel-A", true);
      manager.setPanelEffort("panel-A", SONNET, "max");
      manager.setPanelEffort("panel-A", OPUS, "high");
      manager.setPanelMaxTokens("panel-A", SONNET, 24000);

      manager.copyPanelStateTo("panel-A", "panel-B");

      expect(manager.resolveDisabled("panel-B", config as never)).toBe(true);
      expect(manager.resolveEffort("panel-B", SONNET, config as never)).toBe("max");
      expect(manager.resolveEffort("panel-B", OPUS, config as never)).toBe("high");
      expect(manager.resolveMaxTokens("panel-B", SONNET, config as never)).toBe(24000);
    });

    it("clone is independent — mutating the source after copy does not affect the target", () => {
      const config = makeConfig({});
      manager.setPanelEffort("panel-A", SONNET, "max");
      manager.copyPanelStateTo("panel-A", "panel-B");
      manager.setPanelEffort("panel-A", SONNET, "low");
      expect(manager.resolveEffort("panel-B", SONNET, config as never)).toBe("max");
    });
  });

  describe("cleanupPanelThinking", () => {
    it("removes all per-panel state", () => {
      const config = makeConfig({ thinkingDisabled: false });
      manager.setPanelDisabled("panel-A", true);
      manager.setPanelEffort("panel-A", SONNET, "max");
      manager.setPanelMaxTokens("panel-A", SONNET, 16000);

      manager.cleanupPanelThinking("panel-A");

      expect(manager.resolveDisabled("panel-A", config as never)).toBe(false);
      expect(manager.resolveEffort("panel-A", SONNET, config as never)).toBeNull();
      expect(manager.resolveMaxTokens("panel-A", SONNET, config as never)).toBeNull();
    });
  });

  describe("sendThinkingForPanel", () => {
    it("posts panelThinkingUpdate with panel resolved at activeModel and defaults at defaultModel", () => {
      const host = { webview: { postMessage: vi.fn() } } as never;
      const config = makeConfig({
        thinkingDisabled: false,
        effortByModel: { [SONNET]: "low", [OPUS]: "max" },
        maxThinkingTokens: 32000,
      });
      manager.setPanelEffort("panel-A", SONNET, "high");

      manager.sendThinkingForPanel(host, "panel-A", SONNET, OPUS, config as never);

      expect(postMessage).toHaveBeenCalledWith(host, {
        type: "panelThinkingUpdate",
        panel: { thinkingDisabled: false, effort: "high", maxThinkingTokens: 32000 },
        panelModel: SONNET,
        defaults: { thinkingDisabled: false, effort: "max", maxThinkingTokens: 32000 },
        defaultsModel: OPUS,
      });
    });

    it("defaults effort tracks the workspace default model independently of activeModel", () => {
      const host = { webview: { postMessage: vi.fn() } } as never;
      const config = makeConfig({
        effortByModel: { [SONNET]: "low", [OPUS]: "max" },
      });

      manager.sendThinkingForPanel(host, "panel-A", SONNET, OPUS, config as never);
      expect(postMessage).toHaveBeenLastCalledWith(host, expect.objectContaining({
        defaults: expect.objectContaining({ effort: "max" }),
        defaultsModel: OPUS,
      }));

      manager.sendThinkingForPanel(host, "panel-A", OPUS, SONNET, config as never);
      expect(postMessage).toHaveBeenLastCalledWith(host, expect.objectContaining({
        defaults: expect.objectContaining({ effort: "low" }),
        defaultsModel: SONNET,
      }));
    });
  });
});
