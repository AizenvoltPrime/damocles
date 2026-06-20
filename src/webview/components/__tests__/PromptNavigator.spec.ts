import { describe, it, expect } from "vitest";
import type { EnrichedPrompt } from "@/composables/useEnrichedPrompts";
import {
  buildVisibleRows,
  canRewindForPrompt,
  countVisibleRows,
  escapeHtml,
  escapeRegex,
  filterPrompts,
  highlight,
} from "../promptNavigatorLogic";
import { getToolColorClass } from "../toolBadgeColors";

function makePrompt(overrides: Partial<EnrichedPrompt> = {}): EnrichedPrompt {
  return {
    messageId: overrides.messageId ?? "m1",
    promptIndex: overrides.promptIndex ?? 0,
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
    makePrompt({ messageId: "a", text: "fix the build", tools: ["Bash"] }),
    makePrompt({ messageId: "b", text: "read the file", tools: ["Read"] }),
    makePrompt({ messageId: "c", text: "edit and save", tools: ["Edit", "Write"] }),
  ];

  it("returns all prompts on empty query", () => {
    expect(filterPrompts(prompts, "").length).toBe(3);
  });

  it("matches prompt text case-insensitively", () => {
    expect(filterPrompts(prompts, "BUILD").map((p) => p.messageId)).toEqual(["a"]);
  });

  it("matches tool names via the joined tool list", () => {
    expect(filterPrompts(prompts, "write").map((p) => p.messageId)).toEqual(["c"]);
  });
});

describe("promptNavigatorLogic.buildVisibleRows", () => {
  const prompts = [
    makePrompt({ messageId: "a" }),
    makePrompt({ messageId: "b" }),
    makePrompt({ messageId: "c" }),
    makePrompt({ messageId: "d" }),
  ];

  it("emits one row per prompt", () => {
    const rows = buildVisibleRows(prompts);
    expect(rows.length).toBe(4);
    expect(rows.every((r) => r.kind === "row")).toBe(true);
  });

  it("assigns a contiguous flatIndex over rows", () => {
    const rows = buildVisibleRows(prompts);
    expect(rows.map((r) => r.flatIndex)).toEqual([0, 1, 2, 3]);
  });

  it("preserves prompt order", () => {
    const rows = buildVisibleRows(prompts);
    expect(rows.map((r) => r.prompt.messageId)).toEqual(["a", "b", "c", "d"]);
  });

  it("countVisibleRows counts all rows", () => {
    const rows = buildVisibleRows(prompts);
    expect(countVisibleRows(rows)).toBe(4);
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
