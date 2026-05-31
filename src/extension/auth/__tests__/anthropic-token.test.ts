import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  __resetAnthropicTokenManagerForTests,
  clearAnthropicGrant,
  ensureFreshAnthropicToken,
  getAnthropicAccessTokenSync,
  hasValidAnthropicGrant,
  parseAnthropicGrant,
  setAnthropicGrant,
  type AnthropicGrant,
} from "../anthropic-token";

let tmpDir: string;
let grantPath: string;

function makeGrant(overrides: Partial<AnthropicGrant> = {}): AnthropicGrant {
  return {
    accessToken: "access-original",
    refreshToken: "refresh-original",
    expiresAt: Date.now() + 60 * 60 * 1000,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "pro",
    ...overrides,
  };
}

function readStoreFile(): { claudeAiOauth: AnthropicGrant; organizationUuid?: string } {
  return JSON.parse(fs.readFileSync(grantPath, "utf8"));
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "damocles-token-test-"));
  grantPath = path.join(tmpDir, "anthropic-grant.json");
  __resetAnthropicTokenManagerForTests(grantPath);
});

afterEach(() => {
  __resetAnthropicTokenManagerForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("parseAnthropicGrant", () => {
  it("rejects the {} placeholder the binary leaves on Linux", () => {
    expect(parseAnthropicGrant("{}")).toBeNull();
  });

  it("rejects malformed JSON", () => {
    expect(parseAnthropicGrant("not json")).toBeNull();
  });

  it("rejects a grant missing accessToken", () => {
    expect(parseAnthropicGrant(JSON.stringify({ claudeAiOauth: { refreshToken: "r", expiresAt: 1 } }))).toBeNull();
  });

  it("parses a real grant and surfaces organizationUuid", () => {
    const ms = 2_000_000_000_000;
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: ms },
      organizationUuid: "org-1",
    });
    expect(parseAnthropicGrant(raw)).toEqual({
      grant: { accessToken: "a", refreshToken: "r", expiresAt: ms },
      organizationUuid: "org-1",
    });
  });
});

describe("store load + sync accessor", () => {
  it("getAccessTokenSync returns the cached token after a lazy store read", () => {
    setAnthropicGrant(makeGrant({ accessToken: "tok-1" }));
    __resetAnthropicTokenManagerForTests(grantPath);
    expect(getAnthropicAccessTokenSync()).toBe("tok-1");
  });

  it("returns null when no grant store exists", () => {
    expect(getAnthropicAccessTokenSync()).toBeNull();
    expect(hasValidAnthropicGrant()).toBe(false);
  });

  it("hasValidAnthropicGrant reflects a stored real token", () => {
    setAnthropicGrant(makeGrant());
    expect(hasValidAnthropicGrant()).toBe(true);
  });

  it("persists with the binary's { claudeAiOauth } shape", () => {
    setAnthropicGrant(makeGrant({ accessToken: "a", refreshToken: "r" }), "org-9");
    const file = readStoreFile();
    expect(file.claudeAiOauth.accessToken).toBe("a");
    expect(file.claudeAiOauth.refreshToken).toBe("r");
    expect(file.organizationUuid).toBe("org-9");
  });
});

describe("ensureFreshAnthropicToken", () => {
  it("returns the current token without refreshing when far from expiry", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setAnthropicGrant(makeGrant({ accessToken: "still-valid", expiresAt: Date.now() + 60 * 60 * 1000 }));

    expect(await ensureFreshAnthropicToken()).toBe("still-valid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes when within the expiry buffer and persists the rotated refresh token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: "access-new", refresh_token: "refresh-rotated", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    setAnthropicGrant(makeGrant({ accessToken: "access-old", expiresAt: Date.now() + 60 * 1000 }));

    const token = await ensureFreshAnthropicToken();

    expect(token).toBe("access-new");
    expect(fetchMock).toHaveBeenCalledOnce();
    const file = readStoreFile();
    expect(file.claudeAiOauth.accessToken).toBe("access-new");
    expect(file.claudeAiOauth.refreshToken).toBe("refresh-rotated");
    expect(file.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
  });

  it("keeps the previous refresh token when the response omits a new one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: "access-new", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    setAnthropicGrant(makeGrant({ refreshToken: "refresh-keep", expiresAt: Date.now() + 60 * 1000 }));

    await ensureFreshAnthropicToken();
    expect(readStoreFile().claudeAiOauth.refreshToken).toBe("refresh-keep");
  });

  it("sends the SDK-compatible JSON wire format (Content-Type, anthropic-beta, JSON body)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: "a2", refresh_token: "r2", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    setAnthropicGrant(makeGrant({ refreshToken: "refresh-wire", expiresAt: Date.now() + 60 * 1000 }));

    await ensureFreshAnthropicToken();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://platform.claude.com/v1/oauth/token");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(init.headers["User-Agent"]).toBeUndefined();
    expect(JSON.parse(init.body as string)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "refresh-wire",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    });
  });

  it("de-dupes concurrent refreshes into a single token request", async () => {
    let resolveFetch!: (r: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((res) => { resolveFetch = res; }));
    vi.stubGlobal("fetch", fetchMock);
    setAnthropicGrant(makeGrant({ expiresAt: Date.now() + 60 * 1000 }));

    const a = ensureFreshAnthropicToken();
    const b = ensureFreshAnthropicToken();
    resolveFetch(jsonResponse({ access_token: "access-shared", refresh_token: "r2", expires_in: 3600 }));

    expect(await a).toBe("access-shared");
    expect(await b).toBe("access-shared");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("leaves the store intact and returns null on refresh failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "invalid_grant" }, false, 400));
    vi.stubGlobal("fetch", fetchMock);
    setAnthropicGrant(makeGrant({ accessToken: "access-old", refreshToken: "refresh-old", expiresAt: Date.now() + 60 * 1000 }));

    expect(await ensureFreshAnthropicToken()).toBeNull();
    const file = readStoreFile();
    expect(file.claudeAiOauth.accessToken).toBe("access-old");
    expect(file.claudeAiOauth.refreshToken).toBe("refresh-old");
  });
});

describe("proactive refresh timer", () => {
  it("refreshes ~5 min before expiry without an explicit call", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: "access-timer", refresh_token: "r-timer", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    setAnthropicGrant(makeGrant({ accessToken: "access-pre", expiresAt: Date.now() + 10 * 60 * 1000 }));
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(readStoreFile().claudeAiOauth.accessToken).toBe("access-timer");
  });
});

describe("expiresAt normalization", () => {
  it("upconverts a seconds-format expiresAt to milliseconds", () => {
    const seconds = Math.floor((Date.now() + 60 * 60 * 1000) / 1000);
    const parsed = parseAnthropicGrant(
      JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: seconds } }),
    );
    expect(parsed?.grant.expiresAt).toBe(seconds * 1000);
  });

  it("leaves a millisecond expiresAt untouched", () => {
    const ms = Date.now() + 60 * 60 * 1000;
    const parsed = parseAnthropicGrant(
      JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: ms } }),
    );
    expect(parsed?.grant.expiresAt).toBe(ms);
  });

  it("does not treat a seconds-format grant as expired (no refresh storm)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const seconds = Math.floor((Date.now() + 60 * 60 * 1000) / 1000);
    fs.writeFileSync(
      grantPath,
      JSON.stringify({ claudeAiOauth: { accessToken: "tok", refreshToken: "r", expiresAt: seconds } }),
    );
    __resetAnthropicTokenManagerForTests(grantPath);

    expect(getAnthropicAccessTokenSync()).toBe("tok");
    expect(await ensureFreshAnthropicToken()).toBe("tok");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("hard expiry", () => {
  it("getAccessTokenSync returns null past hard expiry instead of a dead bearer", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => { /* never resolves */ })));
    setAnthropicGrant(makeGrant({ accessToken: "dead", expiresAt: Date.now() - 1000 }));

    expect(getAnthropicAccessTokenSync()).toBeNull();
  });

  it("still serves the token inside the refresh buffer (before hard expiry)", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => { /* never resolves */ })));
    setAnthropicGrant(makeGrant({ accessToken: "soon", expiresAt: Date.now() + 60 * 1000 }));

    expect(getAnthropicAccessTokenSync()).toBe("soon");
  });
});

describe("clearAnthropicGrant", () => {
  it("deletes the store and drops the in-memory token", () => {
    setAnthropicGrant(makeGrant());
    expect(hasValidAnthropicGrant()).toBe(true);

    clearAnthropicGrant();

    expect(hasValidAnthropicGrant()).toBe(false);
    expect(getAnthropicAccessTokenSync()).toBeNull();
    expect(fs.existsSync(grantPath)).toBe(false);
  });
});
