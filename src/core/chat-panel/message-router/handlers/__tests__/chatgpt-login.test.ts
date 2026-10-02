import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildAuthInteraction } from "../auth-interaction";
import { createFakePlatform, type FakePlatform } from "../../../../../__mocks__/fake-platform";

/** pi's fixed ChatGPT loopback (`pi-ai/dist/auth/oauth/openai-chatgpt.js` CALLBACK_PORT, CALLBACK_PATH). */
const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/auth/callback`;
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const DEVICE_ID = "0b9c2f2e-6a0c-4c5e-9d41-3f1f0e6c2a11";

/** Holds the port; resolves null when it cannot be bound (another process, or a Windows excluded port range). */
function holdPort(port: number): Promise<net.Server | null> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" || err.code === "EACCES" ? resolve(null) : reject(err)));
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function release(server: net.Server | null): Promise<void> {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}

function callbackUrl(platform: FakePlatform): string {
  const state = new URL(platform.shell.openedExternal[0]!).searchParams.get("state");
  return `${REDIRECT_URI}?code=auth-code&state=${state}&client_id=issued-client`;
}

/**
 * The real pi `login('openai', 'oauth')` (Sign in with ChatGPT) through Damocles' interaction bridge, with
 * only the token endpoint mocked: once completed by the loopback callback, once by the pasted redirect URL.
 */
describe("Sign in with ChatGPT through pi's real login", () => {
  let agentDir: string;
  let tokenRequests: Array<Record<string, string>>;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-login-"));
    tokenRequests = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      if (String(url) !== TOKEN_URL) return new Response("not found", { status: 404 });
      tokenRequests.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
      return Response.json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        id_token: "id-1",
        expires_in: 3600,
        scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  async function login(platform: FakePlatform) {
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      refreshOnCreate: false,
    });
    const interaction = buildAuthInteraction({
      signal: new AbortController().signal,
      cancelSentinel: "cancelled",
      logPrefix: "[test]",
      platform,
    });
    const credential = await runtime.login("openai", "oauth", interaction, { getDeviceId: () => DEVICE_ID });
    const stored = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
    return { credential, stored };
  }

  it("completes through the loopback callback and dismisses the paste prompt", async (ctx) => {
    const probe = await holdPort(CALLBACK_PORT);
    if (!probe) ctx.skip(`port ${CALLBACK_PORT} is held by another process`);
    await release(probe);

    const platform = createFakePlatform();
    platform.dialogs.answerInputBox(() => {
      // The paste prompt opens after pi's callback server listens; the browser redirect lands there.
      http.get(callbackUrl(platform), (res) => res.resume());
      return new Promise<undefined>(() => {});
    });

    const { credential, stored } = await login(platform);

    expect(new URL(platform.shell.openedExternal[0]!).searchParams.get("ext_agent_host_id")).toBe(`urn:uuid:${DEVICE_ID}`);
    expect(platform.dialogs.inputBoxCalls).toHaveLength(1);
    expect(platform.dialogs.inputBoxCalls[0]!.signal?.aborted).toBe(true);
    expect(tokenRequests).toEqual([expect.objectContaining({ grant_type: "authorization_code", code: "auth-code", client_id: "issued-client" })]);
    expect(credential).toMatchObject({ type: "oauth", access: "access-1", refresh: "refresh-1" });
    expect(stored["openai"]).toMatchObject({ type: "oauth" });
  });

  it("completes through the pasted redirect URL when the loopback port is busy", async () => {
    const blocker = await holdPort(CALLBACK_PORT);
    try {
      const platform = createFakePlatform();
      platform.dialogs.answerInputBox(() => callbackUrl(platform));

      const { credential, stored } = await login(platform);

      expect(platform.dialogs.inputBoxCalls).toHaveLength(1);
      expect(platform.dialogs.inputBoxCalls[0]!.options.placeholder).toBe(REDIRECT_URI);
      expect(platform.dialogs.inputBoxCalls[0]!.options.password).toBe(false);
      expect(tokenRequests).toEqual([expect.objectContaining({ grant_type: "authorization_code", code: "auth-code" })]);
      expect(credential).toMatchObject({ type: "oauth", access: "access-1" });
      expect(stored["openai"]).toMatchObject({ type: "oauth" });
    } finally {
      await release(blocker);
    }
  });
});
