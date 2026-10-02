import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildAuthInteraction } from "../auth-interaction";
import { createFakePlatform } from "../../../../../__mocks__/fake-platform";

/** pi's fixed Anthropic loopback port (`pi-ai/dist/auth/oauth/anthropic.js` CALLBACK_PORT). */
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

/**
 * The real pi Anthropic login, through Damocles' interaction bridge, with pi's loopback port already
 * taken: pi's callback server cannot bind, so the `manual_code` prompt is the only way in and must
 * complete the sign-in with the pasted redirect URL.
 */
describe("Claude sign-in with the loopback port busy", () => {
  let agentDir: string;
  let blocker: net.Server | null;

  beforeEach(async () => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-port-busy-"));
    blocker = await holdPort(ANTHROPIC_CALLBACK_PORT);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => (blocker ? blocker.close(() => resolve()) : resolve()));
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("completes through the pasted redirect URL", async () => {
    const tokenRequests: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      if (String(url) !== TOKEN_URL) return new Response("not found", { status: 404 });
      tokenRequests.push(JSON.parse(String(init?.body)));
      return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
    });

    const platform = createFakePlatform();
    platform.dialogs.answerInputBox(() => {
      const authorizeUrl = new URL(platform.shell.openedExternal[0]!);
      const state = authorizeUrl.searchParams.get("state");
      return `http://localhost:${ANTHROPIC_CALLBACK_PORT}/callback?code=pasted-code&state=${state}`;
    });
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

    const credential = await runtime.login("anthropic", "oauth", interaction);

    expect(platform.dialogs.inputBoxCalls).toHaveLength(1);
    expect(platform.dialogs.inputBoxCalls[0]!.options.password).toBe(false);
    expect(tokenRequests).toEqual([expect.objectContaining({ grant_type: "authorization_code", code: "pasted-code" })]);
    expect(credential).toMatchObject({ type: "oauth", access: "access-1", refresh: "refresh-1" });
  });
});
