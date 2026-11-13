import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../logger", () => ({ log: vi.fn() }));

import { createForgeRefusedHandlers, raiseForgeRefusal, type ForgeShellRefused } from "../forge-refused-handlers";
import type { ForgeService } from "../../../../forge";
import type { HandlerContext, HandlerDependencies } from "../../types";
import type { PanelHost } from "../../../../../platform/window-service";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";

const SERVER = "gitlab.indigital.gr";
const ASTEF = `${SERVER}|7`;
const ADMIN = `${SERVER}|9`;
const ELSEWHERE = "gitlab.com|3";

const REFUSED: ForgeShellRefused = {
  type: "forgeShellRefused",
  toolCallId: "call-1",
  serverId: SERVER,
  serverLabel: SERVER,
  project: "damocles",
  canBind: true,
  account: { id: ASTEF, login: "astefanopoulos" },
  reason: "agentShellsOff",
};

function setup(options: { refusal?: { projectKey?: string; serverId: string; accountId?: string }; bound?: boolean; bindFails?: string; settingsInPanel?: boolean; answer?: number } = {}) {
  const sent: ExtensionToWebviewMessage[] = [];
  const reveal = vi.fn(async () => true);
  const host = { id: "panel-1", reveal } as unknown as PanelHost;
  const openAppSettings = vi.fn();
  const warn = vi.fn(async (..._args: unknown[]) => options.answer);
  const platform = { capabilities: { settingsInPanel: options.settingsInPanel ?? false }, window: { openAppSettings }, notifications: { warn } };
  const refusalOf = vi.fn((panelId: string, toolCallId: string) => (panelId === "p1" && toolCallId === "call-1" ? options.refusal : undefined));
  const bindAccount = vi.fn(async () => {
    if (options.bindFails) throw new Error(options.bindFails);
    return options.bound ?? true;
  });
  const state = () => ({ accounts: [{ id: ASTEF, serverId: SERVER }, { id: ADMIN, serverId: SERVER }, { id: ELSEWHERE, serverId: "gitlab.com" }] });
  const forge = { refusalOf, bindAccount, state } as unknown as ForgeService;
  const post = (_to: PanelHost, message: ExtensionToWebviewMessage): void => void sent.push(message);
  const deps = { postMessage: post, platform, forge } as unknown as HandlerDependencies;
  const ctx = { host, reply: host, panelId: "p1" } as unknown as HandlerContext;
  const handlers = createForgeRefusedHandlers(deps);
  const send = async (message: WebviewToExtensionMessage): Promise<void> => {
    await handlers[message.type]!(message, ctx);
  };
  return { sent, send, host, reveal, openAppSettings, warn, bindAccount, platform, post };
}

const PROJECT_REFUSAL = { projectKey: "C:/work/damocles", serverId: SERVER, accountId: ASTEF };

describe("forge refused handlers (refused notice actions)", () => {
  it("bind the refusal's own project and server to an account core lists there, and answer the asking view", async () => {
    const t = setup({ refusal: PROJECT_REFUSAL });
    await t.send({ type: "forgeRefusedBind", toolCallId: "call-1", accountId: ADMIN });
    expect(t.bindAccount).toHaveBeenCalledWith("C:/work/damocles", SERVER, ADMIN);
    expect(t.sent).toEqual([{ type: "forgeRefusedBindResult", toolCallId: "call-1", accountId: ADMIN, ok: true }]);
  });

  it("answer ok false when core could not save the binding", async () => {
    const t = setup({ refusal: PROJECT_REFUSAL, bound: false });
    await t.send({ type: "forgeRefusedBind", toolCallId: "call-1", accountId: ADMIN });
    expect(t.sent).toEqual([{ type: "forgeRefusedBindResult", toolCallId: "call-1", accountId: ADMIN, ok: false }]);
  });

  it("answer ok false and bind nothing for a shell outside every project", async () => {
    const t = setup({ refusal: { serverId: SERVER } });
    await t.send({ type: "forgeRefusedBind", toolCallId: "call-1", accountId: ADMIN });
    expect(t.bindAccount).not.toHaveBeenCalled();
    expect(t.sent).toEqual([{ type: "forgeRefusedBindResult", toolCallId: "call-1", accountId: ADMIN, ok: false }]);
  });

  it("answer ok false, binding nothing, for a refusal core did not post to this panel, an account on another server or an unknown account", async () => {
    const t = setup({ refusal: PROJECT_REFUSAL });
    await t.send({ type: "forgeRefusedBind", toolCallId: "call-2", accountId: ADMIN });
    await t.send({ type: "forgeRefusedBind", toolCallId: "call-1", accountId: ELSEWHERE });
    await t.send({ type: "forgeRefusedBind", toolCallId: "call-1", accountId: `${SERVER}|404` });
    expect(t.bindAccount).not.toHaveBeenCalled();
    expect(t.sent).toEqual([
      { type: "forgeRefusedBindResult", toolCallId: "call-2", accountId: ADMIN, ok: false },
      { type: "forgeRefusedBindResult", toolCallId: "call-1", accountId: ELSEWHERE, ok: false },
      { type: "forgeRefusedBindResult", toolCallId: "call-1", accountId: `${SERVER}|404`, ok: false },
    ]);
  });

  it("answer nothing to malformed ids, which name no notice", async () => {
    const t = setup({ refusal: PROJECT_REFUSAL });
    await t.send({ type: "forgeRefusedBind", toolCallId: "", accountId: ADMIN });
    await t.send({ type: "forgeRefusedBind", toolCallId: "call-1", accountId: 7 } as unknown as WebviewToExtensionMessage);
    await t.send({ type: "forgeRefusedOpenSettings", toolCallId: "call-2" });
    expect(t.bindAccount).not.toHaveBeenCalled();
    expect(t.openAppSettings).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
  });

  it("answer ok false when the bind throws, so the notice leaves saving", async () => {
    const t = setup({ refusal: PROJECT_REFUSAL, bindFails: "No such account on the server" });
    await t.send({ type: "forgeRefusedBind", toolCallId: "call-1", accountId: ADMIN });
    expect(t.sent).toEqual([{ type: "forgeRefusedBindResult", toolCallId: "call-1", accountId: ADMIN, ok: false }]);
  });

  it("open Settings, Accounts at the refusal's account with Manage open, else at its server", async () => {
    const withAccount = setup({ refusal: PROJECT_REFUSAL });
    await withAccount.send({ type: "forgeRefusedOpenSettings", toolCallId: "call-1" });
    expect(withAccount.openAppSettings).toHaveBeenCalledWith("accounts", undefined, undefined, { server: SERVER, account: ASTEF });
    const noAccount = setup({ refusal: { projectKey: "C:/work/damocles", serverId: SERVER } });
    await noAccount.send({ type: "forgeRefusedOpenSettings", toolCallId: "call-1" });
    expect(noAccount.openAppSettings).toHaveBeenCalledWith("accounts", undefined, undefined, { server: SERVER });
  });
});

describe("raiseForgeRefusal (the toast while the window is unfocused)", () => {
  it("asks for a toast only while unfocused, with the notice's text and both actions", async () => {
    const t = setup();
    await raiseForgeRefusal(t.platform as never, t.post, t.host, REFUSED);
    expect(t.warn).toHaveBeenCalledWith(
      { message: "The agent's git was refused. The account this project uses on {0}, {1}, does not allow agent shells. Damocles kept its token out of the shell.", args: [SERVER, "astefanopoulos"] },
      [{ message: "Choose account" }, { message: "Open Git hosting settings" }],
      { unlessFocused: true },
    );
    // no answer (the window was focused, or the toast was dismissed): nothing happens
    expect(t.sent).toEqual([]);
    expect(t.reveal).not.toHaveBeenCalled();
  });

  it("names the server alone when no account resolved", async () => {
    const t = setup();
    await raiseForgeRefusal(t.platform as never, t.post, t.host, { ...REFUSED, reason: "noAccount", account: null });
    expect(t.warn.mock.calls[0]![0]).toEqual({ message: "The agent's git was refused. Damocles found no account for this project on {0}, so the agent's git got no credentials.", args: [SERVER] });
  });

  it("Choose account brings the chat forward, then asks its notice to open the menu", async () => {
    const t = setup({ answer: 0 });
    await raiseForgeRefusal(t.platform as never, t.post, t.host, REFUSED);
    expect(t.reveal).toHaveBeenCalled();
    expect(t.sent).toEqual([{ type: "forgeRefusedOpenMenu", toolCallId: "call-1" }]);
  });

  it("Open Git hosting settings opens the account's Manage", async () => {
    const t = setup({ answer: 1 });
    await raiseForgeRefusal(t.platform as never, t.post, t.host, REFUSED);
    expect(t.openAppSettings).toHaveBeenCalledWith("accounts", undefined, undefined, { server: SERVER, account: ASTEF });
    expect(t.sent).toEqual([]);
  });

  it("offers only settings when core recorded no project to bind, whose first action is then settings", async () => {
    const t = setup({ answer: 0 });
    await raiseForgeRefusal(t.platform as never, t.post, t.host, { ...REFUSED, project: "", canBind: false });
    expect(t.warn.mock.calls[0]![1]).toEqual([{ message: "Open Git hosting settings" }]);
    expect(t.openAppSettings).toHaveBeenCalledWith("accounts", undefined, undefined, { server: SERVER, account: ASTEF });
    expect(t.sent).toEqual([]);
  });
});
