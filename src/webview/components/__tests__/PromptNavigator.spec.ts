import { describe, it, expect } from "vitest";
import type { EnrichedPrompt } from "@/composables/useEnrichedPrompts";
import {
  buildVisibleRows,
  canRewindForPrompt,
  countVisibleRows,
  escapeHtml,
  escapeRegex,
  filterPrompts,
  groupByNode,
  highlight,
} from "../promptNavigatorLogic";
import { getToolColorClass } from "../toolBadgeColors";

function makePrompt(overrides: Partial<EnrichedPrompt> = {}): EnrichedPrompt {
  return {
    messageId: overrides.messageId ?? "m1",
    promptIndex: overrides.promptIndex ?? 0,
    nodeId: overrides.nodeId ?? null,
    nodeTitle: overrides.nodeTitle ?? "No node",
    text: overrides.text ?? "",
    hasNonTextAttachments: overrides.hasNonTextAttachments ?? false,
    time: overrides.time ?? "12:00",
    tools: overrides.tools ?? [],
    errored: overrides.errored ?? false,
    sdkMessageId: overrides.sdkMessageId ?? null,
  };
}

describe("promptNavigatorLogic.escapeHtml", () => {
  it("escapes <, >, &, \" and ' so prompt content cannot inject HTML", () => {
    expect(escapeHtml("<script>alert('x')</script>&\"")).toBe(
      "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;&quot;",
    );
  });
});

describe("promptNavigatorLogic.escapeRegex", () => {
  it("escapes regex metacharacters so user input is treated literally", () => {
    expect(escapeRegex(".*+?^${}()|[]\\")).toBe(
      "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\",
    );
  });
});

describe("promptNavigatorLogic.highlight", () => {
  it("returns escaped text only when query is empty", () => {
    expect(highlight("hello <world>", "")).toBe("hello &lt;world&gt;");
  });

  it("wraps case-insensitive matches with <mark>", () => {
    const out = highlight("Hello hello", "hello");
    expect(out).toContain("<mark");
    expect((out.match(/<mark/g) ?? []).length).toBe(2);
  });

  it("escapes HTML before highlighting — typing < does not yield a real tag", () => {
    const out = highlight("<script>alert</script>", "<script");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script");
    expect(out).toContain("<mark");
  });

  it("treats regex metacharacters in the query as literals", () => {
    const out = highlight("a.b a*b", ".");
    expect((out.match(/<mark/g) ?? []).length).toBe(1);
  });
});

describe("promptNavigatorLogic.filterPrompts", () => {
  const prompts = [
    makePrompt({ messageId: "a", text: "fix the build", nodeTitle: "Build", tools: ["Bash"] }),
    makePrompt({ messageId: "b", text: "read the file", nodeTitle: "Read FS", tools: ["Read"] }),
    makePrompt({ messageId: "c", text: "edit and save", nodeTitle: "Editing", tools: ["Edit", "Write"] }),
  ];

  it("returns all prompts on empty query", () => {
    expect(filterPrompts(prompts, "").length).toBe(3);
  });

  it("matches prompt text case-insensitively", () => {
    expect(filterPrompts(prompts, "BUILD").map((p) => p.messageId)).toEqual(["a"]);
  });

  it("matches node title", () => {
    expect(filterPrompts(prompts, "editing").map((p) => p.messageId)).toEqual(["c"]);
  });

  it("matches tool names via the joined tool list", () => {
    expect(filterPrompts(prompts, "write").map((p) => p.messageId)).toEqual(["c"]);
  });
});

describe("promptNavigatorLogic.groupByNode", () => {
  it("groups in the order of the first prompt encountered per node", () => {
    const prompts = [
      makePrompt({ messageId: "a", nodeId: "n2", nodeTitle: "Beta", text: "p1" }),
      makePrompt({ messageId: "b", nodeId: "n1", nodeTitle: "Alpha", text: "p2" }),
      makePrompt({ messageId: "c", nodeId: "n2", nodeTitle: "Beta", text: "p3" }),
    ];
    const groups = groupByNode(prompts, "No node");
    expect(groups.map((g) => g.key)).toEqual(["n2", "n1"]);
    expect(groups[0]!.prompts.map((p) => p.messageId)).toEqual(["a", "c"]);
  });

  it("uses missingNodeTitle for prompts without a nodeId", () => {
    const prompts = [makePrompt({ messageId: "a", nodeId: null })];
    const groups = groupByNode(prompts, "No node");
    expect(groups[0]!.title).toBe("No node");
    expect(groups[0]!.key).toBe("__none");
  });
});

describe("promptNavigatorLogic.buildVisibleRows", () => {
  const prompts = [
    makePrompt({ messageId: "a", nodeId: "n1", nodeTitle: "A" }),
    makePrompt({ messageId: "b", nodeId: "n1", nodeTitle: "A" }),
    makePrompt({ messageId: "c", nodeId: "n2", nodeTitle: "B" }),
    makePrompt({ messageId: "d", nodeId: "n2", nodeTitle: "B" }),
  ];
  const groups = groupByNode(prompts, "No node");

  it("emits a header per group followed by rows when not collapsed", () => {
    const rows = buildVisibleRows(groups, new Set());
    const headers = rows.filter((r) => r.kind === "header");
    const dataRows = rows.filter((r) => r.kind === "row");
    expect(headers.length).toBe(2);
    expect(dataRows.length).toBe(4);
  });

  it("assigns flatIndex over rows only (headers excluded)", () => {
    const rows = buildVisibleRows(groups, new Set());
    const dataRows = rows.flatMap((r) => (r.kind === "row" ? [r] : []));
    expect(dataRows.map((r) => r.flatIndex)).toEqual([0, 1, 2, 3]);
  });

  it("hides rows of a collapsed group but keeps the header", () => {
    const rows = buildVisibleRows(groups, new Set(["n1"]));
    const headers = rows.filter((r) => r.kind === "header");
    const dataRows = rows.filter((r) => r.kind === "row");
    expect(headers.length).toBe(2);
    expect(dataRows.length).toBe(2);
    expect(dataRows.every((r) => r.kind === "row" && r.prompt.nodeId === "n2")).toBe(true);
  });

  it("countVisibleRows counts only data rows", () => {
    const rows = buildVisibleRows(groups, new Set(["n1"]));
    expect(countVisibleRows(rows)).toBe(2);
  });

  it("ArrowDown navigation skips collapsed-group prompts because flatIndex is contiguous over visible rows only", () => {
    const rows = buildVisibleRows(groups, new Set(["n1"]));
    const dataRows = rows.flatMap((r) => (r.kind === "row" ? [r] : []));
    expect(dataRows.map((r) => r.prompt.messageId)).toEqual(["c", "d"]);
    expect(dataRows.map((r) => r.flatIndex)).toEqual([0, 1]);
  });
});

describe("promptNavigatorLogic.canRewindForPrompt", () => {
  it("returns true when sdkMessageId is present in the checkpoint set", () => {
    const prompt = makePrompt({ sdkMessageId: "sdk-1" });
    const set = new Set(["sdk-1", "sdk-2"]);
    expect(canRewindForPrompt(prompt, set)).toBe(true);
  });

  it("returns false when sdkMessageId is not in the checkpoint set", () => {
    const prompt = makePrompt({ sdkMessageId: "sdk-3" });
    const set = new Set(["sdk-1", "sdk-2"]);
    expect(canRewindForPrompt(prompt, set)).toBe(false);
  });

  it("returns false when sdkMessageId is null even if the set is non-empty", () => {
    const prompt = makePrompt({ sdkMessageId: null });
    const set = new Set(["sdk-1"]);
    expect(canRewindForPrompt(prompt, set)).toBe(false);
  });

  it("returns false when the checkpoint set is null or undefined", () => {
    const prompt = makePrompt({ sdkMessageId: "sdk-1" });
    expect(canRewindForPrompt(prompt, null)).toBe(false);
    expect(canRewindForPrompt(prompt, undefined)).toBe(false);
  });

  it("returns false when the checkpoint set is empty", () => {
    const prompt = makePrompt({ sdkMessageId: "sdk-1" });
    expect(canRewindForPrompt(prompt, new Set())).toBe(false);
  });
});

describe("getToolColorClass", () => {
  it("maps Bash and PowerShell to emerald", () => {
    expect(getToolColorClass("Bash")).toContain("emerald");
    expect(getToolColorClass("PowerShell")).toContain("emerald");
  });

  it("maps Write/Edit/MultiEdit to amber", () => {
    expect(getToolColorClass("Write")).toContain("amber");
    expect(getToolColorClass("Edit")).toContain("amber");
    expect(getToolColorClass("MultiEdit")).toContain("amber");
  });

  it("maps Read/Grep/Glob to sky", () => {
    expect(getToolColorClass("Read")).toContain("sky");
    expect(getToolColorClass("Grep")).toContain("sky");
    expect(getToolColorClass("Glob")).toContain("sky");
  });

  it("falls back to muted for unknown tool names — used by the +N overflow chip", () => {
    expect(getToolColorClass("UnknownTool")).toContain("muted");
    expect(getToolColorClass("__overflow__")).toContain("muted");
  });
});
