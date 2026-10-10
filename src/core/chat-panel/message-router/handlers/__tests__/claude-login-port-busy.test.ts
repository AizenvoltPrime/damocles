import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { buildAuthInteraction } from "../auth-interaction";
import { createFakePlatform, type FakePlatform } from "../../../../../__mocks__/fake-platform";

/** pi's preferred Anthropic loopback port (`pi-ai/dist/auth/oauth/anthropic.js` CALLBACK_PORT). */
const ANTHROPIC_CALLBACK_PORT = 53692;
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

/**
 * Holds the port; resolves null when the port is already unbindable, which is the same precondition:
 * another process holds it (EADDRINUSE) or Windows reserves it in an excluded port range (EACCES).
 */
function holdPort(port: number): Promise<net.Server | null> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) =>
      err.code === "EADDRINUSE" || err.code === "EACCES" ? resolve(null) : reject(err),
    );
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function authorizeUrl(platform: FakePlatform): URL {
  return new URL(platform.shell.openedExternal[0]!);
}

/**
 * The real pi Anthropic login through Damocles' interaction bridge, with pi's preferred loopback port
 * already taken, so pi's callback server binds another loopback port.
 */
describe("Claude sign-in with the preferred loopback port busy", () => {
  let agentDir: string;
  let blocker: net.Server | null;
  let tokenRequests: Array<Record<string, unknown>>;

  beforeEach(async () => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-port-busy-"));
    blocker = await holdPort(ANTHROPIC_CALLBACK_PORT);
    tokenRequests = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      if (String(url) !== TOKEN_URL) return new Response("not found", { status: 404 });
      tokenRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => (blocker ? blocker.close(() => resolve()) : resolve()));
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  async function login(interaction: AuthInteraction) {
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      refreshOnCreate: false,
    });
    return runtime.login("anthropic", "oauth", interaction);
  }

  function bridge(platform: FakePlatform): AuthInteraction {
    return buildAuthInteraction({ signal: new AbortController().signal, cancelSentinel: "cancelled", logPrefix: "[test]", platform });
  }

  it("completes through the browser callback on the loopback port pi fell back to", async () => {
    const platform = createFakePlatform();
    platform.dialogs.answerInputBox(() => {
      // The paste prompt opens after pi's callback server listens; the browser redirect lands there.
      const callback = new URL(authorizeUrl(platform).searchParams.get("redirect_uri")!);
      callback.hostname = "127.0.0.1";
      callback.searchParams.set("code", "callback-code");
      callback.searchParams.set("state", authorizeUrl(platform).searchParams.get("state")!);
      http.get(callback, (res) => res.resume());
      return new Promise<undefined>(() => {});
    });

    const credential = await login(bridge(platform));

    const redirectUri = new URL(authorizeUrl(platform).searchParams.get("redirect_uri")!);
    expect(redirectUri.hostname).toBe("localhost");
    expect(redirectUri.port).not.toBe(String(ANTHROPIC_CALLBACK_PORT));
    expect(platform.dialogs.inputBoxCalls).toHaveLength(1);
    expect(platform.dialogs.inputBoxCalls[0]!.signal?.aborted).toBe(true);
    expect(tokenRequests).toEqual([
      expect.objectContaining({ grant_type: "authorization_code", code: "callback-code", redirect_uri: redirectUri.href }),
    ]);
    expect(credential).toMatchObject({ type: "oauth", access: "access-1", refresh: "refresh-1" });
  });

  it("answers pi's login-method choice with the browser method, which still accepts a pasted redirect URL", async () => {
    const platform = createFakePlatform();
    platform.dialogs.answerInputBox(() => {
      const redirect = new URL(authorizeUrl(platform).searchParams.get("redirect_uri")!);
      redirect.searchParams.set("code", "pasted-code");
      redirect.searchParams.set("state", authorizeUrl(platform).searchParams.get("state")!);
      return redirect.href;
    });
    const prompts: AuthPrompt[] = [];
    const inner = bridge(platform);
    const interaction: AuthInteraction = {
      ...inner,
      prompt: (prompt) => {
        prompts.push(prompt);
        return inner.prompt(prompt);
      },
    };

    const credential = await login(interaction);

    expect(prompts.map((prompt) => prompt.type)).toEqual(["select", "manual_code"]);
    expect(prompts[0]).toMatchObject({ options: [{ id: "browser" }, { id: "copy_code" }] });
    expect(new URL(authorizeUrl(platform).searchParams.get("redirect_uri")!).origin).toMatch(/^http:\/\/localhost:\d+$/);
    expect(tokenRequests).toEqual([expect.objectContaining({ grant_type: "authorization_code", code: "pasted-code" })]);
    expect(credential).toMatchObject({ type: "oauth", access: "access-1", refresh: "refresh-1" });
  });
});
