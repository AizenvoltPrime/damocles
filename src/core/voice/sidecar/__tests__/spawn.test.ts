import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSidecarEnv, pickEphemeralPort } from "../spawn";

const FAKE_SOURCE_DIR = "/fake/extension/python";

describe("buildSidecarEnv", () => {
  it("strips secret env keys and never mutates process.env", () => {
    const before = { ...process.env };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "leak-this";
    process.env.ANTHROPIC_API_KEY = "leak-that";
    try {
      const env = buildSidecarEnv("token-abc", FAKE_SOURCE_DIR);
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.DAMOCLES_VOICE_TOKEN).toBe("token-abc");
      expect(env.PYTHONUNBUFFERED).toBe("1");
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("leak-this");
    } finally {
      process.env = before;
    }
  });

  it("delivers token via env, not via any visible argv channel", () => {
    const env = buildSidecarEnv("super-secret-token", FAKE_SOURCE_DIR);
    expect(env.DAMOCLES_VOICE_TOKEN).toBe("super-secret-token");
  });

  it("prepends pythonSourceDir to PYTHONPATH so the bundled package resolves first", () => {
    const before = { ...process.env };
    delete process.env.PYTHONPATH;
    try {
      const env = buildSidecarEnv("tok", FAKE_SOURCE_DIR);
      expect(env.PYTHONPATH).toBe(FAKE_SOURCE_DIR);
    } finally {
      process.env = before;
    }
  });

  it("preserves any inherited PYTHONPATH after the bundled source dir", () => {
    const before = { ...process.env };
    process.env.PYTHONPATH = "/some/other/path";
    try {
      const env = buildSidecarEnv("tok", FAKE_SOURCE_DIR);
      expect(env.PYTHONPATH).toBe(`${FAKE_SOURCE_DIR}${delimiter}/some/other/path`);
    } finally {
      process.env = before;
    }
  });
});

describe("pickEphemeralPort", () => {
  it("returns a usable port", async () => {
    const port = await pickEphemeralPort();
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);
  });
});
