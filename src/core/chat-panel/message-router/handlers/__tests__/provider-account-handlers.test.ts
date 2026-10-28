import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AuthInteraction } from "@earendil-works/pi-ai";

/** The sign-in flow contract of the provider account handlers. `PiRuntime` is stubbed: its own login is covered by the pi-session tests. */
const H = vi.hoisted(() => ({
  runtime: {
    signInProvider: vi.fn(async (_provider: string, _interaction: AuthInteraction): Promise<void> => {}),
    signOutProvider: vi.fn(async (_provider: string): Promise<void> => {}),
  },
  signInDef: { textPrompt: undefined as "enterpriseDomain" | undefined },
}));

vi.mock("../../../../logger", () => ({ log: vi.fn() }));
vi.mock("../../../../pi-session/pi-runtime", () => ({
  PiRuntime: { get: () => H.runtime, exists: true, notifyMemoryJudgeChange: () => {} },
  remoteSignInRefusal: () => "Sign-ins change only in the User tab on your computer.",
}));
vi.mock("../../../../pi-session/custom-providers", () => ({ providerSignInDef: () => H.signInDef }));
vi.mock("../../../settings-manager/managers/provider-keys", () => ({
  storeProviderKey: vi.fn(async () => {}),
  deleteProviderKey: vi.fn(async () => {}),
}));

import { createProviderAccountHandlers } from "../provider-account-handlers";
import { createFakePlatform, type FakePlatform } from "../../../../../__mocks__/fake-platform";
import { log } from "../../../../logger";
import { deleteProviderKey, storeProviderKey } from "../../../settings-manager/managers/provider-keys";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";
import type { ProviderSignInState } from "../../../../../shared/types/settings";

/** `sent` is what the requesting panel got; `otherSent` what a second open panel got. */
function setup(remote = false) {
  const base = createFakePlatform();
  const platform = (remote ? { ...base, remote: {} } : base) as unknown as FakePlatform;
  const sent: ExtensionToWebviewMessage[] = [];
  const otherSent: ExtensionToWebviewMessage[] = [];
  const host = { id: "panel-1" };
  const otherHost = { id: "panel-2" };
  const session = { publishAccountInfo: vi.fn(), publishAvailableModels: vi.fn() };
  const subscriptions: { dispose: () => void }[] = [];
  const deps = {
    postMessage: (to: unknown, msg: ExtensionToWebviewMessage) => { (to === host ? sent : otherSent).push(msg); },
    getPanels: () => new Map([["p1", { host, session }], ["p2", { host: otherHost, session }]]),
    platform,
    subscriptions,
  } as unknown as HandlerDependencies;
  const ctx = { host, reply: host, session } as unknown as HandlerContext;
  const accounts = createProviderAccountHandlers(deps);
  const send = (msg: WebviewToExtensionMessage) => accounts.handlers[msg.type]!(msg as never, ctx);
  const states = (provider = "xai"): ProviderSignInState[] =>
    sent.flatMap((m) => (m.type === "providerSignInState" && m.provider === provider ? [m.state] : []));
  const dispose = (): void => { for (const s of subscriptions) s.dispose(); };
  return { platform: base, host, sent, otherSent, send, states, postState: accounts.postState, dispose };
}

/** The state `postState` re-sends to a settings view that mounts again. */
function remounted(t: ReturnType<typeof setup>, provider: string): ProviderSignInState | undefined {
  const before = t.sent.length;
  t.postState(t.host as never);
  const view = t.sent.splice(before);
  const message = view.find((m) => m.type === "providerSignInState" && m.provider === provider);
  return message?.type === "providerSignInState" ? message.state : undefined;
}

/** A sign-in that shows a device code, then waits until the flow is aborted or `finish` settles it. */
function parkOnDeviceCode(verificationUri = "https://accounts.x.ai/device?code=ABCD") {
  let finish!: (err?: Error) => void;
  let interaction!: AuthInteraction;
  H.runtime.signInProvider.mockImplementationOnce(async (_provider, i) => {
    interaction = i;
    i.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri, expiresInSeconds: 600 });
    await new Promise<void>((resolve, reject) => {
      finish = (err) => (err ? reject(err) : resolve());
      i.signal!.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
    });
  });
  return {
    finish: (err?: Error) => finish(err),
    get interaction() {
      return interaction;
    },
  };
}

const EXPIRED = { kind: "expired", message: "Code expired. Start the sign-in again." };
const DENIED = { kind: "denied", message: "The sign-in was denied." };
const PROVIDER = { kind: "provider", message: "The provider could not complete the sign-in." };
const providerStatus = (status: number) => ({ kind: "provider", message: `The provider could not complete the sign-in (HTTP ${status}).`, status });

beforeEach(() => {
  vi.clearAllMocks();
  H.signInDef.textPrompt = undefined;
});

describe("provider sign-in flow", () => {
  it("runs one flow per provider: a second sign-in while one runs starts nothing, and Cancel ends it as cancelled", async () => {
    const t = setup();
    parkOnDeviceCode();
    const first = t.send({ type: "providerSignIn", provider: "xai" });
    await vi.waitFor(() => expect(t.states().at(-1)?.phase).toBe("deviceCode"));

    await t.send({ type: "providerSignIn", provider: "xai" });
    expect(H.runtime.signInProvider).toHaveBeenCalledTimes(1);

    await t.send({ type: "providerSignInCancel", provider: "xai" });
    await first;
    expect(t.states()[0]).toEqual({ phase: "starting" });
    expect(t.states().at(-1)).toEqual({ phase: "idle", error: { kind: "cancelled", message: "Sign-in cancelled." } });
    expect(t.sent.some((m) => m.type === "authFailureCleared")).toBe(false);
  });

  it("shows the code and its expiry, moves to finishing on progress only after the code, and ends signed in with the card cleared", async () => {
    const t = setup();
    let release!: () => void;
    H.runtime.signInProvider.mockImplementationOnce(async (_provider, i) => {
      i.notify({ type: "progress", message: "Requesting a code" });
      i.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://accounts.x.ai/device", expiresInSeconds: 600 });
      await new Promise<void>((resolve) => { release = resolve; });
      i.notify({ type: "progress", message: "Waiting for approval" });
    });
    const before = Date.now();
    const run = t.send({ type: "providerSignIn", provider: "xai" });
    await vi.waitFor(() => expect(t.states().at(-1)?.phase).toBe("deviceCode"));
    const shown = t.states().at(-1) as Extract<ProviderSignInState, { phase: "deviceCode" }>;
    expect(shown).toMatchObject({ userCode: "ABCD-1234", verificationUri: "https://accounts.x.ai/device" });
    expect(shown.expiresAt).toBeGreaterThanOrEqual(before + 600_000);
    release();
    await run;

    expect(t.states().map((s) => s.phase)).toEqual(["starting", "deviceCode", "finishing", "idle"]);
    expect(t.states().at(-1)).toEqual({ phase: "idle" });
    expect(t.sent).toContainEqual({ type: "authFailureCleared", account: "xai" });
    // neither pi's progress text nor the user code is logged
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain("Waiting for approval");
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain("ABCD-1234");
  });

  // pi's own texts, pi-ai 1.4.0 dist/auth/oauth
  it.each<[string, string, object]>([
    ["device-code.js:2", "Device flow timed out", EXPIRED],
    ["device-code.js:3", "Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.", EXPIRED],
    ["xai.js:152", "xAI device code expired", EXPIRED],
    ["kimi-coding.js:160", "Kimi Code device authorization expired. Please restart login.", EXPIRED],
    ["meta.js:121", "Meta device authorization expired. Please restart login.", EXPIRED],
    ["xai.js:149", "xAI device authorization was denied", DENIED],
    ["kimi-coding.js:163", "Kimi Code login was denied.", DENIED],
    ["meta.js:119", "Meta login was denied.", DENIED],
    ["callback-server.js:96, OpenRouter has no code", "OpenRouter sign-in timed out", PROVIDER],
    ["openrouter.js:82, OpenRouter has no code", "OpenRouter OAuth token exchange timed out", PROVIDER],
    ["meta.js:147, a session, not a code", "Meta session expired (status 401). Run `/login meta` to sign in again.: Session has expired", providerStatus(401)],
    ["github-copilot.js:150, a leading status", '404 Not Found: {"message":"Not Found","documentation_url":"https://docs.github.com/rest"}', providerStatus(404)],
    ["github-copilot.js:142, a leading status", "403 Forbidden: device code expired, access was denied", providerStatus(403)],
    ["xai.js:81", "xAI OAuth device token polling failed (HTTP 500): server_error: device code expired", providerStatus(500)],
    ["openrouter.js:91", "OpenRouter OAuth key exchange failed (HTTP 409): login was denied", providerStatus(409)],
    ["kimi-coding.js:167, a body naming an expiry", "Kimi Code device token request failed (status 400): expired_token: The device authorization expired", providerStatus(400)],
    ["meta.js:73", "Meta device authorization failed with status 503: authorization was denied (HTTP 500)", providerStatus(503)],
    ["github-copilot.js:232, GitHub's words after pi's", "Device flow failed: access_denied: The user has denied your application access.", PROVIDER],
    ["meta.js:155, a status only in the provider's URL", "Meta did not issue an API key. Complete setup at https://www.meta.ai/setup (500): retry", PROVIDER],
  ])("classifies pi's %s text", async (_source, message, error) => {
    const t = setup();
    H.runtime.signInProvider.mockRejectedValueOnce(new Error(message));
    await t.send({ type: "providerSignIn", provider: "xai" });
    expect(t.states().at(-1)).toEqual({ phase: "idle", error });
  });

  it.each<[string, Error]>([
    ["an unreachable host", Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }) })],
    ["a request timeout", new DOMException("The operation was aborted due to timeout", "TimeoutError")],
  ])("classifies %s as a network failure and logs the error's name", async (_case, err) => {
    const t = setup();
    H.runtime.signInProvider.mockRejectedValueOnce(err);
    await t.send({ type: "providerSignIn", provider: "xai" });
    expect(t.states().at(-1)).toEqual({ phase: "idle", error: { kind: "network", message: "Could not reach the sign-in service. Check the connection and try again." } });
    expect(vi.mocked(log)).toHaveBeenCalledWith("[ProviderSignIn:%s] sign-in ended: %s (%s)%s", "xai", "network", err.name, "");
  });

  it("aborts a running flow before saving a key, then saves it", async () => {
    const t = setup();
    parkOnDeviceCode();
    const run = t.send({ type: "providerSignIn", provider: "xai" });
    await vi.waitFor(() => expect(t.states().at(-1)?.phase).toBe("deviceCode"));

    await t.send({ type: "setProviderApiKey", provider: "xai", key: "xai-key", requestId: "r1" });
    await run;

    const cancelledAt = t.sent.findIndex((m) => m.type === "providerSignInState" && m.state.phase === "idle");
    const ackAt = t.sent.findIndex((m) => m.type === "setProviderApiKeyAck");
    expect(cancelledAt).toBeGreaterThanOrEqual(0);
    expect(cancelledAt).toBeLessThan(ackAt);
    expect(vi.mocked(storeProviderKey)).toHaveBeenCalledWith(expect.anything(), "xai", "xai-key");
    expect(t.sent).toContainEqual({ type: "authFailureCleared", account: "xai" });
  });

  it("answers a daemon's refusal to the asking view only, keeps it out of the provider's state, and calls no runtime", async () => {
    const t = setup(true);
    await t.send({ type: "providerSignIn", provider: "xai" });
    await t.send({ type: "providerSignOut", provider: "xai" });

    const refused = { phase: "idle", error: { kind: "remote", message: "Sign-ins change only in the User tab on your computer." } };
    expect(t.states()).toEqual([refused, refused]);
    expect(t.otherSent).toEqual([]);
    expect(remounted(t, "xai")).toEqual({ phase: "idle" });
    expect(H.runtime.signInProvider).not.toHaveBeenCalled();
    expect(H.runtime.signOutProvider).not.toHaveBeenCalled();
  });

  it("refuses a key save or clear on a daemon's core with the refusal text, before any secret write", async () => {
    const t = setup(true);
    await t.send({ type: "setProviderApiKey", provider: "xai", key: "xai-key", requestId: "r1" });
    await t.send({ type: "clearProviderApiKey", provider: "deepseek", requestId: "r2" });
    expect(t.sent).toEqual([
      { type: "setProviderApiKeyAck", provider: "xai", requestId: "r1", ok: false, error: "Sign-ins change only in the User tab on your computer." },
      { type: "clearProviderApiKeyAck", provider: "deepseek", requestId: "r2", ok: false, error: "Sign-ins change only in the User tab on your computer." },
    ]);
    expect(vi.mocked(storeProviderKey)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteProviderKey)).not.toHaveBeenCalled();
  });

  it("opens only the https page it holds for the flow, and refuses an http one", async () => {
    const t = setup();
    await t.send({ type: "providerSignInOpenPage", provider: "xai" });
    expect(t.platform.shell.openedExternal).toEqual([]);

    const https = parkOnDeviceCode("https://accounts.x.ai/device?code=ABCD");
    const run = t.send({ type: "providerSignIn", provider: "xai" });
    await vi.waitFor(() => expect(t.states().at(-1)?.phase).toBe("deviceCode"));
    await t.send({ type: "providerSignInOpenPage", provider: "xai" });
    expect(t.platform.shell.openedExternal).toEqual(["https://accounts.x.ai/device?code=ABCD"]);
    https.finish();
    await run;

    parkOnDeviceCode("http://auth.example.com/device");
    const plain = t.send({ type: "providerSignIn", provider: "xai" });
    await vi.waitFor(() => expect(t.states().at(-1)?.phase).toBe("deviceCode"));
    await t.send({ type: "providerSignInOpenPage", provider: "xai" });
    expect(t.platform.shell.openedExternal).toEqual(["https://accounts.x.ai/device?code=ABCD"]);
    await t.send({ type: "providerSignInCancel", provider: "xai" });
    await plain;
  });

  it("copies the device code to the clipboard and acks only the asking view, never logging the code", async () => {
    const t = setup();
    const parked = parkOnDeviceCode();
    const run = t.send({ type: "providerSignIn", provider: "xai" });
    await vi.waitFor(() => expect(t.states().at(-1)?.phase).toBe("deviceCode"));
    await t.send({ type: "providerSignInCopyCode", provider: "xai" });

    expect(t.platform.clipboard.writes).toEqual(["ABCD-1234"]);
    expect(t.sent.at(-1)).toEqual({ type: "providerSignInCopyCodeAck", provider: "xai", ok: true });
    expect(t.otherSent.some((m) => m.type === "providerSignInCopyCodeAck")).toBe(false);
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain("ABCD-1234");
    parked.finish();
    await run;
  });

  it("acks a failed copy when the clipboard refuses or no code is shown", async () => {
    const t = setup();
    await t.send({ type: "providerSignInCopyCode", provider: "xai" });
    expect(t.platform.clipboard.writes).toEqual([]);
    expect(t.sent).toEqual([{ type: "providerSignInCopyCodeAck", provider: "xai", ok: false }]);

    const parked = parkOnDeviceCode();
    const run = t.send({ type: "providerSignIn", provider: "xai" });
    await vi.waitFor(() => expect(t.states().at(-1)?.phase).toBe("deviceCode"));
    vi.spyOn(t.platform.clipboard, "writeText").mockRejectedValueOnce(new Error("no clipboard ABCD-1234"));
    await t.send({ type: "providerSignInCopyCode", provider: "xai" });
    expect(t.sent.at(-1)).toEqual({ type: "providerSignInCopyCodeAck", provider: "xai", ok: false });
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain("ABCD-1234");
    parked.finish();
    await run;
  });

  it("refuses a copy on a daemon's core, which would write the target's clipboard", async () => {
    const t = setup(true);
    await t.send({ type: "providerSignInCopyCode", provider: "xai" });
    expect(t.platform.clipboard.writes).toEqual([]);
    expect(t.states()).toEqual([{ phase: "idle", error: { kind: "remote", message: "Sign-ins change only in the User tab on your computer." } }]);
    expect(t.otherSent).toEqual([]);
  });

  it("drops an answer over 8 KB and an invalid enterprise domain, and passes a valid one on", async () => {
    H.signInDef.textPrompt = "enterpriseDomain";
    const t = setup();
    let answered: string | undefined;
    H.runtime.signInProvider.mockImplementationOnce(async (_provider, i) => {
      answered = await i.prompt({ type: "text", message: "GitHub Enterprise URL/domain (blank for github.com)" });
    });
    const run = t.send({ type: "providerSignIn", provider: "xai" });
    await vi.waitFor(() => expect(t.states().at(-1)).toEqual({ phase: "prompt", prompt: "enterpriseDomain" }));

    await t.send({ type: "providerSignInAnswer", provider: "xai", input: "a".repeat(8 * 1024 + 1) });
    await t.send({ type: "providerSignInAnswer", provider: "xai", input: "not a host/path" });
    await t.send({ type: "providerSignInAnswer", provider: "xai", input: `${"a".repeat(60)}.`.repeat(5) + "com" });
    await Promise.resolve();
    expect(answered).toBeUndefined();
    expect(t.states().at(-1)).toEqual({ phase: "prompt", prompt: "enterpriseDomain", invalid: true });

    await t.send({ type: "providerSignInAnswer", provider: "xai", input: " company.ghe.com " });
    await run;
    expect(answered).toBe("company.ghe.com");
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain("company.ghe.com");
  });

  it("takes a pasted code of exactly 8 KB and drops one past 8 KB in bytes, though under it in characters", async () => {
    const t = setup();
    const answers: string[] = [];
    H.runtime.signInProvider.mockImplementationOnce(async (_provider, i) => {
      answers.push(await i.prompt({ type: "manual_code", message: "Paste the code" }));
    });
    const run = t.send({ type: "providerSignIn", provider: "xai" });
    await vi.waitFor(() => expect(t.states().at(-1)).toEqual({ phase: "browser", paste: true }));

    const multiByte = "é".repeat(4097);
    expect(multiByte.length).toBeLessThan(8 * 1024);
    await t.send({ type: "providerSignInAnswer", provider: "xai", input: multiByte });
    await Promise.resolve();
    expect(answers).toEqual([]);
    expect(t.states().at(-1)).toEqual({ phase: "browser", paste: true, invalid: true });

    await t.send({ type: "providerSignInAnswer", provider: "xai", input: "c".repeat(8 * 1024) });
    await run;
    expect(answers).toEqual(["c".repeat(8 * 1024)]);
  });

  it("opens OpenRouter's page, offers it again, and takes a pasted redirect while the loopback waits", async () => {
    const t = setup();
    let pasted: string | undefined;
    H.runtime.signInProvider.mockImplementationOnce(async (_provider, i) => {
      i.notify({ type: "auth_url", url: "https://openrouter.ai/auth?callback_url=http%3A%2F%2Flocalhost%3A3000" });
      pasted = await i.prompt({ type: "manual_code", message: "Paste the redirect URL" });
    });
    const run = t.send({ type: "providerSignIn", provider: "openrouter" });
    await vi.waitFor(() => expect(t.states("openrouter").at(-1)).toEqual({ phase: "browser", paste: true }));
    expect(t.states("openrouter").map((s) => s.phase)).toEqual(["starting", "browser", "browser"]);
    expect(t.platform.shell.openedExternal).toEqual(["https://openrouter.ai/auth?callback_url=http%3A%2F%2Flocalhost%3A3000"]);

    await t.send({ type: "providerSignInOpenPage", provider: "openrouter" });
    expect(t.platform.shell.openedExternal).toHaveLength(2);

    await t.send({ type: "providerSignInAnswer", provider: "openrouter", input: "http://localhost:3000/?code=abc" });
    await run;
    expect(pasted).toBe("http://localhost:3000/?code=abc");
    expect(t.states("openrouter").at(-1)).toEqual({ phase: "idle" });
    expect(t.sent).toContainEqual({ type: "authFailureCleared", account: "openrouter" });
  });

  it("takes an enterprise domain of 253 characters and drops one of 254", async () => {
    H.signInDef.textPrompt = "enterpriseDomain";
    const t = setup();
    let answered: string | undefined;
    H.runtime.signInProvider.mockImplementationOnce(async (_provider, i) => {
      answered = await i.prompt({ type: "text", message: "domain" });
    });
    const run = t.send({ type: "providerSignIn", provider: "xai" });
    await vi.waitFor(() => expect(t.states().at(-1)?.phase).toBe("prompt"));
    const host = (last: number) => `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(last)}`;
    expect(host(62)).toHaveLength(254);

    await t.send({ type: "providerSignInAnswer", provider: "xai", input: host(62) });
    await Promise.resolve();
    expect(answered).toBeUndefined();

    await t.send({ type: "providerSignInAnswer", provider: "xai", input: host(61) });
    await run;
    expect(answered).toBe(host(61));
    expect(answered).toHaveLength(253);
  });

  it("accepts a blank enterprise domain, which means github.com", async () => {
    H.signInDef.textPrompt = "enterpriseDomain";
    const t = setup();
    let answered: string | undefined;
    H.runtime.signInProvider.mockImplementationOnce(async (_provider, i) => {
      answered = await i.prompt({ type: "text", message: "domain" });
    });
    const run = t.send({ type: "providerSignIn", provider: "xai" });
    await vi.waitFor(() => expect(t.states().at(-1)?.phase).toBe("prompt"));
    await t.send({ type: "providerSignInAnswer", provider: "xai", input: "   " });
    await run;
    expect(answered).toBe("");
  });

  // pi-ai 1.4.0 dist/auth/oauth/kimi-coding.js:62 and :103
  it.each<[string, string, object]>([
    ["a status", 'Kimi Code device authorization failed with status 500: {"access_token":"SECRET","refresh_token":"SECRET"}', providerStatus(500)],
    ["no status", 'Kimi Code token poll response missing fields: {"access_token":"SECRET","refresh_token":"SECRET","expires_in":"soon"}', PROVIDER],
  ])("keeps Kimi's error text with %s and a token out of the state and the log", async (_case, text, error) => {
    const t = setup();
    const secret = "sk-live-refresh-0123456789";
    H.runtime.signInProvider.mockRejectedValueOnce(new Error(text.replaceAll("SECRET", secret)));
    await t.send({ type: "providerSignIn", provider: "kimi-coding" });

    expect(t.states("kimi-coding").at(-1)).toEqual({ phase: "idle", error });
    expect(JSON.stringify(t.sent)).not.toContain(secret);
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain(secret);
  });

  it("re-sends each sign-in provider's state to a settings view that mounts again", async () => {
    const t = setup();
    parkOnDeviceCode();
    const run = t.send({ type: "providerSignIn", provider: "xai" });
    await vi.waitFor(() => expect(t.states().at(-1)?.phase).toBe("deviceCode"));
    t.sent.length = 0;
    t.postState(t.host as never);
    expect(t.sent).toEqual([
      { type: "providerSignInState", provider: "xai", state: expect.objectContaining({ phase: "deviceCode", userCode: "ABCD-1234" }) },
      { type: "providerSignInState", provider: "kimi-coding", state: { phase: "idle" } },
      { type: "providerSignInState", provider: "meta", state: { phase: "idle" } },
      { type: "providerSignInState", provider: "openrouter", state: { phase: "idle" } },
      { type: "providerSignInState", provider: "github-copilot", state: { phase: "idle" } },
    ]);
    await t.send({ type: "providerSignInCancel", provider: "xai" });
    await run;
  });

  it("signs out, clearing the card, after aborting a running flow", async () => {
    const t = setup();
    parkOnDeviceCode();
    const run = t.send({ type: "providerSignIn", provider: "xai" });
    await vi.waitFor(() => expect(t.states().at(-1)?.phase).toBe("deviceCode"));
    await t.send({ type: "providerSignOut", provider: "xai" });
    await run;
    expect(H.runtime.signOutProvider).toHaveBeenCalledWith("xai");
    expect(t.states().at(-1)?.phase).toBe("idle");
    expect(t.sent.at(-1)).toEqual({ type: "authFailureCleared", account: "xai" });
  });

  it("clears a failed sign-out's error once a later sign-out succeeds, for open and remounted views", async () => {
    const t = setup();
    H.runtime.signOutProvider.mockRejectedValueOnce(new Error("EBUSY: resource busy or locked"));
    await t.send({ type: "providerSignOut", provider: "xai" });
    const failed = { phase: "idle", error: { kind: "provider", message: "Could not sign out. Try again." } };
    expect(t.states().at(-1)).toEqual(failed);
    expect(remounted(t, "xai")).toEqual(failed);

    await t.send({ type: "providerSignOut", provider: "xai" });
    expect(t.states().at(-1)).toEqual({ phase: "idle" });
    expect(t.otherSent.filter((m) => m.type === "providerSignInState").at(-1)).toEqual({ type: "providerSignInState", provider: "xai", state: { phase: "idle" } });
    expect(remounted(t, "xai")).toEqual({ phase: "idle" });
  });

  it("posts no extra state when a sign-out succeeds with no error to clear", async () => {
    const t = setup();
    await t.send({ type: "providerSignOut", provider: "xai" });
    expect(t.states()).toEqual([]);
  });

  it.each<[string, WebviewToExtensionMessage]>([
    ["saving a key", { type: "setProviderApiKey", provider: "xai", key: "xai-key", requestId: "r1" }],
    ["clearing the key", { type: "clearProviderApiKey", provider: "xai", requestId: "r1" }],
  ])("ends a cancelled flow's error once %s succeeds, which aborts the running flow first", async (_case, message) => {
    const t = setup();
    parkOnDeviceCode();
    const run = t.send({ type: "providerSignIn", provider: "xai" });
    await vi.waitFor(() => expect(t.states().at(-1)?.phase).toBe("deviceCode"));

    await t.send(message);
    await run;

    const phases = t.states();
    expect(phases.at(-2)).toEqual({ phase: "idle", error: { kind: "cancelled", message: "Sign-in cancelled." } });
    expect(phases.at(-1)).toEqual({ phase: "idle" });
    expect(remounted(t, "xai")).toEqual({ phase: "idle" });
    expect(t.sent).toContainEqual({ type: "authFailureCleared", account: "xai" });
  });

  it("keeps a failed key save from clearing the sign-in error", async () => {
    const t = setup();
    H.runtime.signInProvider.mockRejectedValueOnce(new Error("xAI device code expired"));
    await t.send({ type: "providerSignIn", provider: "xai" });
    vi.mocked(storeProviderKey).mockRejectedValueOnce(new Error("keyring locked"));
    await t.send({ type: "setProviderApiKey", provider: "xai", key: "xai-key", requestId: "r1" });
    expect(remounted(t, "xai")).toEqual({ phase: "idle", error: EXPIRED });
  });

  it("runs flows of two providers side by side, each settling on its own", async () => {
    const t = setup();
    parkOnDeviceCode();
    const xaiRun = t.send({ type: "providerSignIn", provider: "xai" });
    await vi.waitFor(() => expect(t.states("xai").at(-1)?.phase).toBe("deviceCode"));
    const meta = parkOnDeviceCode("https://auth.meta.com/device");
    const metaRun = t.send({ type: "providerSignIn", provider: "meta" });
    await vi.waitFor(() => expect(t.states("meta").at(-1)?.phase).toBe("deviceCode"));
    expect(H.runtime.signInProvider.mock.calls.map(([provider]) => provider)).toEqual(["xai", "meta"]);

    meta.finish();
    await metaRun;
    expect(t.states("meta").at(-1)).toEqual({ phase: "idle" });
    expect(t.states("xai").at(-1)?.phase).toBe("deviceCode");

    await t.send({ type: "providerSignInCancel", provider: "xai" });
    await xaiRun;
    expect(t.states("xai").at(-1)).toEqual({ phase: "idle", error: { kind: "cancelled", message: "Sign-in cancelled." } });
    expect(t.states("meta").at(-1)).toEqual({ phase: "idle" });
  });

  it("refuses a text prompt from a provider whose sign-in names none, without asking the user", async () => {
    const t = setup();
    H.runtime.signInProvider.mockImplementationOnce(async (_provider, i) => {
      await i.prompt({ type: "text", message: "Workspace?" });
    });
    await t.send({ type: "providerSignIn", provider: "meta" });
    expect(t.states("meta").map((s) => s.phase)).toEqual(["starting", "idle"]);
    expect(t.states("meta").at(-1)).toEqual({ phase: "idle", error: PROVIDER });
    expect(t.platform.dialogs.inputBoxCalls).toEqual([]);
  });

  it("aborts every running flow when the host disposes the handlers", async () => {
    const t = setup();
    parkOnDeviceCode();
    const run = t.send({ type: "providerSignIn", provider: "xai" });
    await vi.waitFor(() => expect(t.states().at(-1)?.phase).toBe("deviceCode"));
    t.dispose();
    await run;
    expect(t.states().at(-1)).toEqual({ phase: "idle", error: { kind: "cancelled", message: "Sign-in cancelled." } });
  });

  it("refuses an unknown provider", async () => {
    const t = setup();
    await expect(t.send({ type: "providerSignIn", provider: "deepseek" } as never)).rejects.toThrow("Unknown sign-in provider");
    expect(H.runtime.signInProvider).not.toHaveBeenCalled();
  });
});
