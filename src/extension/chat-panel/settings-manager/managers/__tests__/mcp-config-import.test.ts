import { describe, it, expect } from "vitest";
import { mergeMcpEntries, coerceServerMap } from "../mcp-config-import";
import type { McpServerConfig } from "../../../../../shared/types/mcp";

const ws: Record<string, McpServerConfig> = {
  shared: { command: "workspace-cmd" },
  wsOnly: { command: "ws-only" },
};
const imported: Record<string, McpServerConfig> = {
  shared: { command: "claude-cmd" },
  ccOnly: { command: "cc-only" },
};

describe("mergeMcpEntries", () => {
  it("lets the workspace entry win on a name collision and tags provenance", () => {
    const entries = mergeMcpEntries(ws, imported, new Set());
    const shared = entries.find(e => e.name === "shared");
    expect((shared?.config as { command?: string }).command).toBe("workspace-cmd");
    expect(shared?.source).toBe("workspace");
    expect(shared?.readonly).toBe(false);
  });

  it("flags imported-only entries as readonly claude imports", () => {
    const entries = mergeMcpEntries(ws, imported, new Set());
    const ccOnly = entries.find(e => e.name === "ccOnly");
    expect(ccOnly?.source).toBe("claude");
    expect(ccOnly?.readonly).toBe(true);
  });

  it("applies the Damocles disabled set to workspace and imported names alike", () => {
    const entries = mergeMcpEntries(ws, imported, new Set(["wsOnly", "ccOnly"]));
    const byName = Object.fromEntries(entries.map(e => [e.name, e.enabled]));
    expect(byName["wsOnly"]).toBe(false);
    expect(byName["ccOnly"]).toBe(false);
    expect(byName["shared"]).toBe(true);
  });

  it("includes every distinct server exactly once", () => {
    const entries = mergeMcpEntries(ws, imported, new Set());
    const names = entries.map(e => e.name).sort();
    expect(names).toEqual(["ccOnly", "shared", "wsOnly"]);
  });
});

describe("coerceServerMap (M8/M9)", () => {
  it("keeps only entries that are real stdio/remote server configs", () => {
    const out = coerceServerMap({
      good: { command: "x", args: ["--y"] },
      remote: { url: "https://srv" },
      $schema: "https://example.com/mcp.schema.json",
      junk: { notACommand: true },
      nullish: null,
    });
    expect(Object.keys(out).sort()).toEqual(["good", "remote"]);
  });

  it("returns an empty map for a non-object or missing server map (no whole-object fallback)", () => {
    expect(coerceServerMap(undefined)).toEqual({});
    expect(coerceServerMap(null)).toEqual({});
    expect(coerceServerMap("nope")).toEqual({});
    expect(coerceServerMap([{ command: "x" }])).toEqual({});
  });
});
