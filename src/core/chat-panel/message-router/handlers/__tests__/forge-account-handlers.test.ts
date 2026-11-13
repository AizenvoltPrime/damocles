import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../logger", () => ({ log: vi.fn() }));

import { createForgeAccountHandlers, remoteForgeRefusal } from "../forge-account-handlers";
import { createFakePlatform } from "../../../../../__mocks__/fake-platform";
import type { ForgeService, ForgeViewMessage } from "../../../../forge";
import type { HandlerContext, HandlerDependencies } from "../../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";
import { SETTINGS_VIEW_MESSAGE_TYPES, SETTINGS_VIEW_REQUEST_TYPES } from "../../../../../shared/settings-view-messages";
import { MAX_FORGE_FIELD_CHARS, MAX_FORGE_GIT_HOST_CHARS, MAX_FORGE_GIT_HOSTS, MAX_FORGE_TOKEN_CHARS } from "../../../../../shared/forge/accounts";

/** Every request the Git hosting section sends, one of each. */
const REQUESTS: WebviewToExtensionMessage[] = [
  { type: "forgeSignIn", serverId: "gitlab.com", route: "token", token: "glpat-secret-token-000", agentShells: false },
  { type: "forgeSignInCancel", serverId: "gitlab.com" },
  { type: "forgeSignOut", requestId: "a1", accountId: "gitlab.com|2002" },
  { type: "forgeSetAgentShells", requestId: "a2", accountId: "gitlab.com|2002", agentShells: true },
  { type: "forgeAddServer", requestId: "r1", url: "https://gitlab.indigital.gr", kind: "gitlab", gitHosts: [] },
  { type: "forgeEditServer", requestId: "r2", serverId: "gitlab.indigital.gr", gitHosts: [] },
  { type: "forgeRemoveServer", requestId: "r3", serverId: "gitlab.indigital.gr" },
  { type: "forgeConfirmGitHost", requestId: "r5", serverId: "gitlab.indigital.gr", host: "git.indigital.gr" },
  { type: "forgeDismissGitHost", requestId: "r6", serverId: "gitlab.indigital.gr", host: "git.example.com" },
  { type: "forgeRevealAccountsFile", requestId: "a3" },
  { type: "forgeOpenPage", page: "token", serverId: "gitlab.com" },
  { type: "forgeSignInCopyCode", serverId: "gitlab.com" },
  { type: "forgeDismissNotice", noticeId: "revoke-1" },
  { type: "forgeCopyRedirectUri", requestId: "r4", kind: "gitlab" },
];

const ACTIONS = new Set(["signOut", "setAgentShells", "revealBrokenFile"]);

function fakeForge() {
  const listeners = new Set<(message: ForgeViewMessage) => void>();
  const calls: string[] = [];
  const record = (name: string) => vi.fn(async (..._args: unknown[]) => {
    calls.push(name);
    if (name.startsWith("copy")) return true;
    return ACTIONS.has(name) ? { ok: true } : { ok: true, serverId: "s" };
  });
  const forge = {
    onMessage: (listener: (message: ForgeViewMessage) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    signIn: record("signIn"),
    cancelSignIn: record("cancelSignIn"),
    signOut: record("signOut"),
    setAgentShells: record("setAgentShells"),
    addServer: record("addServer"),
    editServer: record("editServer"),
    removeServer: record("removeServer"),
    confirmGitHost: record("confirmGitHost"),
    dismissGitHost: record("dismissGitHost"),
    revealBrokenFile: record("revealBrokenFile"),
    openPage: record("openPage"),
    copySignInCode: record("copySignInCode"),
    copyRedirectUri: record("copyRedirectUri"),
    dismissNotice: vi.fn(() => calls.push("dismissNotice")),
    publish: vi.fn((to?: (message: ForgeViewMessage) => void) => to?.({ type: "forgeAccountsChanged", state: { status: "loading", servers: [], accounts: [], notices: [], redirectUris: { github: "", gitlab: "" }, showAvatars: true } })),
    postSignInStates: vi.fn(),
    settingsOpened: vi.fn(async () => undefined),
  };
  return { forge: forge as unknown as ForgeService, raw: forge, calls, emit: (message: ForgeViewMessage) => listeners.forEach((listener) => listener(message)) };
}

function setup(remote: boolean) {
  const base = createFakePlatform();
  const platform = remote ? { ...base, remote: {} } : base;
  const sent: ExtensionToWebviewMessage[] = [];
  const otherSent: ExtensionToWebviewMessage[] = [];
  const host = { id: "panel-1" };
  const otherHost = { id: "panel-2" };
  const fake = fakeForge();
  const deps = {
    postMessage: (to: unknown, message: ExtensionToWebviewMessage) => (to === host ? sent : otherSent).push(message),
    getPanels: () => new Map([["p1", { host }], ["p2", { host: otherHost }]]),
    platform,
    subscriptions: [],
    ...(remote ? {} : { forge: fake.forge }),
  } as unknown as HandlerDependencies;
  const ctx = { host, reply: host } as unknown as HandlerContext;
  const created = createForgeAccountHandlers(deps);
  const send = async (message: WebviewToExtensionMessage) => created.handlers[message.type]!(message, ctx);
  return { sent, otherSent, send, fake, host, postState: created.postState };
}

describe("forge account handlers", () => {
  it("cover every Git hosting request and are all settings view requests, as their answers are settings view messages", () => {
    const { handlers } = createForgeAccountHandlers({ platform: createFakePlatform(), subscriptions: [], getPanels: () => new Map() } as unknown as HandlerDependencies);
    expect(Object.keys(handlers).sort()).toEqual(REQUESTS.map((request) => request.type).sort());
    for (const request of REQUESTS) expect(SETTINGS_VIEW_REQUEST_TYPES.has(request.type)).toBe(true);
    for (const type of ["forgeAccountsChanged", "forgeSignInState", "forgeSignInCopyCodeAck", "forgeServerFormResult", "forgeAccountActionResult", "forgeCopyRedirectUriAck"]) expect(SETTINGS_VIEW_MESSAGE_TYPES.has(type)).toBe(true);
  });

  it("refuse every request on a daemon's core, answer only the asking view, and never pass a token on", async () => {
    const t = setup(true);
    for (const request of REQUESTS) await t.send(request);
    expect(t.otherSent).toEqual([]);
    expect(t.sent).toEqual([
      { type: "forgeSignInState", serverId: "gitlab.com", state: { phase: "idle", error: { kind: "remote", message: remoteForgeRefusal() } } },
      { type: "forgeAccountActionResult", requestId: "a1", ok: false, message: remoteForgeRefusal() },
      { type: "forgeAccountActionResult", requestId: "a2", ok: false, message: remoteForgeRefusal() },
      { type: "forgeServerFormResult", requestId: "r1", ok: false, message: remoteForgeRefusal() },
      { type: "forgeServerFormResult", requestId: "r2", ok: false, message: remoteForgeRefusal() },
      { type: "forgeServerFormResult", requestId: "r3", ok: false, message: remoteForgeRefusal() },
      { type: "forgeServerFormResult", requestId: "r5", ok: false, message: remoteForgeRefusal() },
      { type: "forgeServerFormResult", requestId: "r6", ok: false, message: remoteForgeRefusal() },
      { type: "forgeAccountActionResult", requestId: "a3", ok: false, message: remoteForgeRefusal() },
      { type: "forgeSignInCopyCodeAck", serverId: "gitlab.com", ok: false },
      { type: "forgeCopyRedirectUriAck", requestId: "r4", ok: false },
    ]);
    expect(JSON.stringify(t.sent)).not.toContain("glpat-secret-token-000");
    expect(remoteForgeRefusal()).toEqual({ message: "Git hosting accounts change only in the User tab on your computer." });
  });

  it("post nothing on a daemon's core when a settings view mounts", () => {
    const t = setup(true);
    t.postState(t.host as never);
    expect(t.sent).toEqual([]);
  });

  it("pass each request to the local core's service, and answer the forms to the asking view", async () => {
    const t = setup(false);
    for (const request of REQUESTS) await t.send(request);
    expect(t.fake.calls).toEqual(["signIn", "cancelSignIn", "signOut", "setAgentShells", "addServer", "editServer", "removeServer", "confirmGitHost", "dismissGitHost", "revealBrokenFile", "openPage", "copySignInCode", "dismissNotice", "copyRedirectUri"]);
    expect(t.fake.raw.signIn).toHaveBeenCalledWith({ serverId: "gitlab.com", route: "token", agentShells: false, token: "glpat-secret-token-000" });
    expect(t.fake.raw.confirmGitHost).toHaveBeenCalledWith("gitlab.indigital.gr", "git.indigital.gr");
    expect(t.fake.raw.dismissGitHost).toHaveBeenCalledWith("gitlab.indigital.gr", "git.example.com");
    expect(t.sent.map((message) => message.type)).toEqual([
      "forgeAccountActionResult", "forgeAccountActionResult",
      "forgeServerFormResult", "forgeServerFormResult", "forgeServerFormResult", "forgeServerFormResult", "forgeServerFormResult",
      "forgeAccountActionResult", "forgeSignInCopyCodeAck", "forgeCopyRedirectUriAck",
    ]);
    expect(t.sent[0]).toEqual({ type: "forgeAccountActionResult", requestId: "a1", ok: true });
    expect(t.otherSent).toEqual([]);
  });

  it("drop only shapes no view sends, before the service sees them", async () => {
    const t = setup(false);
    await t.send({ type: "forgeSignIn", serverId: "gitlab.com", route: "carrier-pigeon", agentShells: false } as never);
    await t.send({ type: "forgeAddServer", requestId: "r", url: "https://x", kind: "bitbucket", gitHosts: [] } as never);
    await t.send({ type: "forgeOpenPage", page: "orgAccess", accountId: "a" } as never);
    await t.send({ type: "forgeConfirmGitHost", requestId: "r", serverId: "gitlab.indigital.gr", host: "" });
    await t.send({ type: "forgeDismissGitHost", requestId: "r", serverId: "gitlab.indigital.gr" } as never);
    await t.send({ type: "forgeSignOut", accountId: "gitlab.com|2002" } as never);
    expect(t.fake.calls).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it("answer a value over its limit with a refusal on its field, never passing it to the service", async () => {
    const t = setup(false);
    await t.send({ type: "forgeSignIn", serverId: "gitlab.com", route: "token", token: "x".repeat(MAX_FORGE_TOKEN_CHARS + 1), agentShells: false });
    await t.send({ type: "forgeAddServer", requestId: "u", url: `https://${"a".repeat(MAX_FORGE_FIELD_CHARS)}`, kind: "gitlab", gitHosts: [] });
    await t.send({ type: "forgeAddServer", requestId: "s", url: "https://ghe.example.com", kind: "github", clientSecret: "s".repeat(MAX_FORGE_FIELD_CHARS + 1), gitHosts: [] });
    await t.send({ type: "forgeEditServer", requestId: "h", serverId: "gitlab.indigital.gr", gitHosts: Array.from({ length: MAX_FORGE_GIT_HOSTS + 1 }, (_, i) => `git${i}.example.com`) });
    await t.send({ type: "forgeConfirmGitHost", requestId: "c", serverId: "gitlab.indigital.gr", host: "h".repeat(MAX_FORGE_GIT_HOST_CHARS + 1) });
    expect(t.fake.calls).toEqual([]);
    expect(t.sent).toEqual([
      { type: "forgeSignInState", serverId: "gitlab.com", state: { phase: "idle", error: { kind: "input", message: { message: "This token is longer than {0} characters. Paste only the token.", args: [MAX_FORGE_TOKEN_CHARS] } } } },
      { type: "forgeServerFormResult", requestId: "u", ok: false, field: "url", message: { message: "Use at most {0} characters.", args: [MAX_FORGE_FIELD_CHARS] } },
      { type: "forgeServerFormResult", requestId: "s", ok: false, field: "clientSecret", message: { message: "Use at most {0} characters.", args: [MAX_FORGE_FIELD_CHARS] } },
      { type: "forgeServerFormResult", requestId: "h", ok: false, field: "gitHosts", message: { message: "Enter at most {0} git hosts.", args: [MAX_FORGE_GIT_HOSTS] } },
      { type: "forgeServerFormResult", requestId: "c", ok: false, field: "gitHosts", message: { message: "A git host is at most {0} characters long.", args: [MAX_FORGE_GIT_HOST_CHARS] } },
    ]);
    expect(JSON.stringify(t.sent)).not.toContain("xxxx");
    expect(JSON.stringify(t.sent)).not.toContain("ssss");
  });

  it("answer each account action's refusal to the asking view alone", async () => {
    const t = setup(false);
    const refusal = { ok: false, message: { message: "Damocles could not save the change because {0} does not parse.", args: ["accounts.json"] } } as const;
    t.fake.raw.setAgentShells.mockResolvedValueOnce(refusal as never);
    t.fake.raw.signOut.mockResolvedValueOnce(refusal as never);
    await t.send({ type: "forgeSetAgentShells", requestId: "s1", accountId: "gitlab.com|2002", agentShells: false });
    await t.send({ type: "forgeSignOut", requestId: "o1", accountId: "gitlab.com|2002" });
    expect(t.sent).toEqual([
      { type: "forgeAccountActionResult", requestId: "s1", ...refusal },
      { type: "forgeAccountActionResult", requestId: "o1", ...refusal },
    ]);
    expect(t.otherSent).toEqual([]);
  });

  it("broadcast the service's messages to every panel, and give a mounting view the state, the sign-ins and the checks", () => {
    const t = setup(false);
    t.fake.emit({ type: "forgeSignInState", serverId: "gitlab.com", state: { phase: "starting" } });
    expect(t.sent).toHaveLength(1);
    expect(t.otherSent).toHaveLength(1);
    t.postState(t.host as never);
    expect(t.sent.at(-1)?.type).toBe("forgeAccountsChanged");
    expect(t.otherSent).toHaveLength(1);
    expect(t.fake.raw.postSignInStates).toHaveBeenCalled();
    expect(t.fake.raw.settingsOpened).toHaveBeenCalled();
  });
});
