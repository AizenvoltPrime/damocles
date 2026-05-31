import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSdkEnv } from "../sdk-env";
import { getAnthropicAccessTokenSync } from "../anthropic-token";

vi.mock("../anthropic-token", () => ({
  getAnthropicAccessTokenSync: vi.fn(),
  hasValidAnthropicGrant: vi.fn(),
}));

const tokenMock = vi.mocked(getAnthropicAccessTokenSync);

const originalPlatform = process.platform;
const SAVED_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_POWERSHELL_TOOL"] as const;
const saved: Record<string, string | undefined> = {};

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

beforeEach(() => {
  tokenMock.mockReset();
  for (const key of SAVED_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  setPlatform(originalPlatform);
  for (const key of SAVED_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("buildSdkEnv — Linux token injection", () => {
  it("injects the manager's access token as CLAUDE_CODE_OAUTH_TOKEN", () => {
    setPlatform("linux");
    tokenMock.mockReturnValue("damocles-owned-token");

    const env = buildSdkEnv();

    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("damocles-owned-token");
    expect(env["CLAUDE_CODE_OAUTH_REFRESH_TOKEN"]).toBeUndefined();
  });

  it("leaves the token var unset when the manager has no token", () => {
    setPlatform("linux");
    tokenMock.mockReturnValue(null);

    expect(buildSdkEnv()["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
  });

  it("injects only the Damocles token, never an inherited shell token", () => {
    setPlatform("linux");
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "inherited-shell-token";
    process.env["ANTHROPIC_API_KEY"] = "inherited-api-key";
    tokenMock.mockReturnValue("damocles-owned-token");

    const env = buildSdkEnv();

    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("damocles-owned-token");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });
});

describe("buildSdkEnv — Windows/macOS unchanged", () => {
  it("never injects a token on win32 and keeps the PowerShell flag", () => {
    setPlatform("win32");
    tokenMock.mockReturnValue("damocles-owned-token");

    const env = buildSdkEnv();

    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
    expect(env["CLAUDE_CODE_USE_POWERSHELL_TOOL"]).toBe("1");
    expect(tokenMock).not.toHaveBeenCalled();
  });

  it("never injects a token on darwin and strips inherited auth", () => {
    setPlatform("darwin");
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "inherited-shell-token";
    tokenMock.mockReturnValue("damocles-owned-token");

    const env = buildSdkEnv();

    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
    expect(env["CLAUDE_CODE_USE_POWERSHELL_TOOL"]).toBeUndefined();
    expect(tokenMock).not.toHaveBeenCalled();
  });
});

describe("buildSdkEnv — invariants on every platform", () => {
  it("pins CLAUDE_CONFIG_DIR and the Damocles client app marker", () => {
    setPlatform("linux");
    tokenMock.mockReturnValue(null);

    const env = buildSdkEnv();

    expect(env["CLAUDE_CONFIG_DIR"]).toMatch(/[\\/]\.damocles[\\/]auth$/);
    expect(env["AI_AGENT"]).toBe("claude-code-damocles");
  });
});
