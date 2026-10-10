import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const H = vi.hoisted(() => ({ deviceId: "0b9c2f2e-6a0c-4c5e-9d41-3f1f0e6c2a11" }));

// The real pi ModelRuntime and login; only loading pi and the user settings are replaced.
vi.mock("../../../../pi-session/pi-loader", async () => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const fakePi = {
    ModelRuntime: {
      create: (options: Parameters<typeof ModelRuntime.create>[0]) => ModelRuntime.create({ ...options, refreshOnCreate: false }),
    },
    SettingsManager: { create: () => ({ getOrCreateDeviceId: () => H.deviceId }) },
  };
  return {
    initPiLoader: async () => fakePi,
    getPiCodingAgent: () => fakePi,
    PI_MIN_NODE_MAJOR: 22,
    nodeSupportsPi: () => true,
  };
});

vi.mock("../../../../pi-session/agent-dir", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../pi-session/agent-dir")>()),
  ensurePiAgentDir: (dir: string) => dir,
}));

import { PiRuntime } from "../../../../pi-session/pi-runtime";
import { createOpenAIHandlers } from "../openai-handlers";
import type { HandlerContext, HandlerDependencies } from "../../types";
import type { ExtensionToWebviewMessage } from "../../../../../shared/types/messages";
import { installFakePlatform, type FakePlatform } from "../../../../../__mocks__/fake-platform";

/** pi's fixed ChatGPT loopback (`pi-ai/dist/auth/oauth/openai-chatgpt.js` CALLBACK_PORT, CALLBACK_PATH). */
const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/auth/callback`;
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";

/** Holds the port, or reports why it cannot: another process holds it (EADDRINUSE) or Windows reserves it (EACCES). */
function holdPort(port: number): Promise<{ server: net.Server } | { code: "EADDRINUSE" | "EACCES" }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) =>
      err.code === "EADDRINUSE" || err.code === "EACCES" ? resolve({ code: err.code }) : reject(err),
    );
    server.listen(port, "127.0.0.1", () => resolve({ server }));
  });
}

function release(held: { server: net.Server } | { code: string }): Promise<void> {
  return new Promise((resolve) => ("server" in held ? held.server.close(() => resolve()) : resolve()));
}

function authorizeUrl(platform: FakePlatform): URL {
  return new URL(platform.shell.openedExternal[0]!);
}

function callbackUrl(platform: FakePlatform): string {
  return `${REDIRECT_URI}?code=auth-code&state=${authorizeUrl(platform).searchParams.get("state")}&client_id=issued-client`;
}

/**
 * Sign in with ChatGPT from the panel's `startChatGPTOAuth` through PiRuntime, Damocles' interaction bridge
 * and pi's real `openai` login, with only the token endpoint mocked.
 */
describe("Sign in with ChatGPT through pi's real login", () => {
  let agentDir: string;
  let tokenRequests: Array<Record<string, string>>;
  let platform: FakePlatform;
  let sent: ExtensionToWebviewMessage[];
  let handlers: ReturnType<typeof createOpenAIHandlers>;
  let ctx: HandlerContext;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-login-"));
    PiRuntime.get(agentDir);
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
    platform = installFakePlatform();
    sent = [];
    const host = { id: "panel-1" } as unknown as HandlerContext["host"];
    const deps = {
      postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => sent.push(message),
      getPanels: () => new Map([["panel-1", { host, session: { publishAccountInfo: () => {}, openaiSignInEnded: async () => {} } }]]),
      platform,
    } as unknown as HandlerDependencies;
    handlers = createOpenAIHandlers(deps);
    ctx = { host, folder: { fsPath: agentDir } } as unknown as HandlerContext;
  });

  afterEach(async () => {
    await PiRuntime.disposeInstance();
    vi.unstubAllGlobals();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  function storedOpenAI(): unknown {
    return (JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8")) as Record<string, unknown>)["openai"];
  }

  it("names Damocles and this installation on the consent page", async ({ skip }) => {
    const held = await holdPort(CALLBACK_PORT);
    if (!("server" in held)) skip(`port ${CALLBACK_PORT} is unavailable (${held.code})`);
    await release(held);
    platform.dialogs.answerInputBox(() => callbackUrl(platform));

    await handlers.startChatGPTOAuth!({ type: "startChatGPTOAuth" }, ctx);

    expect(authorizeUrl(platform).searchParams.get("agent_name_hint")).toBe("Damocles");
    expect(authorizeUrl(platform).searchParams.get("ext_agent_host_id")).toBe(`urn:uuid:${H.deviceId}`);
  });

  it("completes through the loopback callback and dismisses the paste prompt", async ({ skip }) => {
    const held = await holdPort(CALLBACK_PORT);
    if (!("server" in held)) skip(`port ${CALLBACK_PORT} is unavailable (${held.code})`);
    await release(held);
    platform.dialogs.answerInputBox(() => {
      // The paste prompt opens after pi's callback server listens; the browser redirect lands there.
      http.get(callbackUrl(platform), (res) => res.resume());
      return new Promise<undefined>(() => {});
    });

    await handlers.startChatGPTOAuth!({ type: "startChatGPTOAuth" }, ctx);

    expect(sent.some((m) => m.type === "openaiChatGPTAuthCompleted")).toBe(true);
    expect(platform.dialogs.inputBoxCalls).toHaveLength(1);
    expect(platform.dialogs.inputBoxCalls[0]!.signal?.aborted).toBe(true);
    expect(tokenRequests).toEqual([expect.objectContaining({ grant_type: "authorization_code", code: "auth-code", client_id: "issued-client" })]);
    expect(storedOpenAI()).toMatchObject({ type: "oauth", access: "access-1", refresh: "refresh-1" });
  });

  it("completes through the pasted redirect URL while the loopback port is free", async ({ skip }) => {
    const held = await holdPort(CALLBACK_PORT);
    if (!("server" in held)) skip(`port ${CALLBACK_PORT} is unavailable (${held.code})`);
    await release(held);
    platform.dialogs.answerInputBox(() => callbackUrl(platform));

    await handlers.startChatGPTOAuth!({ type: "startChatGPTOAuth" }, ctx);

    expect(sent.some((m) => m.type === "openaiChatGPTAuthCompleted")).toBe(true);
    expect(platform.dialogs.inputBoxCalls).toHaveLength(1);
    expect(platform.dialogs.inputBoxCalls[0]!.options.placeholder).toBe(REDIRECT_URI);
    expect(platform.dialogs.inputBoxCalls[0]!.options.password).toBe(false);
    expect(tokenRequests).toEqual([expect.objectContaining({ grant_type: "authorization_code", code: "auth-code" })]);
    expect(storedOpenAI()).toMatchObject({ type: "oauth", access: "access-1" });
  });

  it("reports pi's port-in-use error to the panel without a paste prompt when the loopback port is busy", async ({ skip }) => {
    const held = await holdPort(CALLBACK_PORT);
    // pi names only EADDRINUSE as a busy port; a reserved port fails with the raw bind error.
    if ("code" in held && held.code === "EACCES") skip(`port ${CALLBACK_PORT} is reserved (EACCES)`);
    try {
      await handlers.startChatGPTOAuth!({ type: "startChatGPTOAuth" }, ctx);

      expect(sent.find((m) => m.type === "openaiChatGPTAuthFailed")).toEqual({
        type: "openaiChatGPTAuthFailed",
        error: `Port ${CALLBACK_PORT} is in use, probably by an unfinished login in another pi session or by the Codex CLI. Cancel that login and try again.`,
      });
      expect(platform.dialogs.inputBoxCalls).toHaveLength(0);
      expect(platform.shell.openedExternal).toHaveLength(0);
      expect(tokenRequests).toHaveLength(0);
    } finally {
      await release(held);
    }
  });
});
