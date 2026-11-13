import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { PanelHost } from "../../../../platform/window-service";
import type { ForgeActionResult, ForgeService, ForgeViewMessage, ServerFormResult } from "../../../forge";
import {
  FORGE_SIGN_IN_ROUTES,
  MAX_FORGE_FIELD_CHARS,
  MAX_FORGE_GIT_HOST_CHARS,
  MAX_FORGE_GIT_HOSTS,
  MAX_FORGE_TOKEN_CHARS,
  type ForgeKind,
  type ForgeServerFormField,
  type ForgeSignInRoute,
} from "../../../../shared/forge/accounts";
import type { WebviewToExtensionMessage } from "../../../../shared/types/messages";
import type { LocalizedText } from "../../../../shared/localized-text";
import { l } from "../../../l10n";
import { log } from "../../../logger";

// Settings › Models & accounts › Git hosting (docs/invariants.md "GitHub and GitLab accounts"). Only the local desktop core runs
// ForgeService; a daemon's core refuses every message, as provider-account-handlers.ts does. The webview never opens a URL
// or writes the clipboard: core opens the page and copies the text it holds. A request the settings view can send gets an
// answer, a refusal included; only a shape no view sends is dropped.

const MAX_ID_CHARS = 1024;

type Message<T extends WebviewToExtensionMessage["type"]> = Extract<WebviewToExtensionMessage, { type: T }>;
type FieldRefusal = { readonly ok: false; readonly field: ForgeServerFormField; readonly message: LocalizedText };

export interface ForgeAccountHandlers {
  handlers: Partial<HandlerRegistry>;
  /** Posts the accounts state and every running or settled sign-in to a settings view that (re)mounted, and starts the checks Settings opening runs. */
  postState: (host: PanelHost) => void;
}

/** What a daemon's core says to a Git hosting request. */
export function remoteForgeRefusal(): LocalizedText {
  return l("Git hosting accounts change only in the User tab on your computer.");
}

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS;
const isString = (value: unknown): value is string => typeof value === "string";
const isRoute = (value: unknown): value is ForgeSignInRoute => typeof value === "string" && (FORGE_SIGN_IN_ROUTES as readonly string[]).includes(value);
const isKind = (value: unknown): value is ForgeKind => value === "github" || value === "gitlab";
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const isOptionalString = (value: unknown): value is string | undefined => value === undefined || isString(value);

const tooLong = (field: ForgeServerFormField): FieldRefusal => ({ ok: false, field, message: l("Use at most {0} characters.", MAX_FORGE_FIELD_CHARS) });

function gitHostsRefusal(hosts: readonly string[]): FieldRefusal | undefined {
  if (hosts.length > MAX_FORGE_GIT_HOSTS) return { ok: false, field: "gitHosts", message: l("Enter at most {0} git hosts.", MAX_FORGE_GIT_HOSTS) };
  if (hosts.some((host) => host.length > MAX_FORGE_GIT_HOST_CHARS)) return { ok: false, field: "gitHosts", message: l("A git host is at most {0} characters long.", MAX_FORGE_GIT_HOST_CHARS) };
  return undefined;
}

function oauthRefusal(clientId: string | undefined, clientSecret: string | undefined): FieldRefusal | undefined {
  if (clientId !== undefined && clientId.length > MAX_FORGE_FIELD_CHARS) return tooLong("clientId");
  if (clientSecret !== undefined && clientSecret.length > MAX_FORGE_FIELD_CHARS) return tooLong("clientSecret");
  return undefined;
}

export function createForgeAccountHandlers(deps: HandlerDependencies): ForgeAccountHandlers {
  const { postMessage, getPanels, platform } = deps;
  const forge: ForgeService | undefined = deps.forge;

  const broadcast = (message: ForgeViewMessage): void => {
    for (const [, instance] of getPanels()) postMessage(instance.host, message);
  };
  if (forge) deps.subscriptions.push(forge.onMessage(broadcast));

  /** The local core's service; on a daemon's core the caller refused already. */
  function service(): ForgeService {
    if (!forge) throw new Error("Git hosting accounts run only in this computer's desktop core");
    return forge;
  }

  /** An account action's answer, to the view that sent it; a daemon's core refuses it. */
  async function answerAction(reply: PanelHost, requestId: string, run: () => Promise<ForgeActionResult>): Promise<void> {
    const result: ForgeActionResult = platform.remote ? { ok: false, message: remoteForgeRefusal() } : await run();
    postMessage(reply, { type: "forgeAccountActionResult", requestId, ...result });
  }

  /** A server form's answer, to the view that sent it; a daemon's core refuses it, and a field over its limit never reaches the service. */
  async function answerForm(reply: PanelHost, requestId: string, refusal: FieldRefusal | undefined, run: () => Promise<ServerFormResult>): Promise<void> {
    const result: ServerFormResult = platform.remote ? { ok: false, message: remoteForgeRefusal() } : refusal ?? (await run());
    postMessage(reply, { type: "forgeServerFormResult", requestId, ...result });
  }

  const handlers: Partial<HandlerRegistry> = {
    // carries a token for the token route; never log it
    forgeSignIn: async (msg, ctx) => {
      if (msg.type !== "forgeSignIn" || !isId(msg.serverId) || !isRoute(msg.route) || typeof msg.agentShells !== "boolean" || !isOptionalString(msg.token)) return;
      if (msg.reauthAccountId !== undefined && !isId(msg.reauthAccountId)) return;
      if (platform.remote) {
        postMessage(ctx.reply, { type: "forgeSignInState", serverId: msg.serverId, state: { phase: "idle", error: { kind: "remote", message: remoteForgeRefusal() } } });
        return;
      }
      if (msg.token !== undefined && msg.token.length > MAX_FORGE_TOKEN_CHARS) {
        const message = l("This token is longer than {0} characters. Paste only the token.", MAX_FORGE_TOKEN_CHARS);
        postMessage(ctx.reply, { type: "forgeSignInState", serverId: msg.serverId, state: { phase: "idle", error: { kind: "input", message } } });
        return;
      }
      await service().signIn({
        serverId: msg.serverId,
        route: msg.route,
        agentShells: msg.agentShells,
        ...(msg.route === "token" ? { token: msg.token ?? "" } : {}),
        ...(msg.reauthAccountId !== undefined ? { reauthAccountId: msg.reauthAccountId } : {}),
      });
    },

    forgeSignInCancel: async (msg) => {
      if (msg.type !== "forgeSignInCancel" || !isId(msg.serverId) || platform.remote) return;
      await service().cancelSignIn(msg.serverId);
    },

    forgeSignOut: async (msg, ctx) => {
      if (msg.type !== "forgeSignOut" || !isId(msg.requestId) || !isId(msg.accountId)) return;
      await answerAction(ctx.reply, msg.requestId, () => service().signOut(msg.accountId));
    },

    forgeSetAgentShells: async (msg, ctx) => {
      if (msg.type !== "forgeSetAgentShells" || !isId(msg.requestId) || !isId(msg.accountId) || typeof msg.agentShells !== "boolean") return;
      await answerAction(ctx.reply, msg.requestId, () => service().setAgentShells(msg.accountId, msg.agentShells));
    },

    // carries a client secret for a GHES server; never log it
    forgeAddServer: async (msg, ctx) => {
      if (msg.type !== "forgeAddServer" || !isId(msg.requestId)) return;
      const m: Message<"forgeAddServer"> = msg;
      if (!isString(m.url) || !isKind(m.kind) || !isStrings(m.gitHosts) || !isOptionalString(m.clientId) || !isOptionalString(m.clientSecret)) return;
      const refusal = m.url.length > MAX_FORGE_FIELD_CHARS ? tooLong("url") : oauthRefusal(m.clientId, m.clientSecret) ?? gitHostsRefusal(m.gitHosts);
      await answerForm(ctx.reply, m.requestId, refusal, () => service().addServer({
        url: m.url,
        kind: m.kind,
        gitHosts: m.gitHosts,
        ...(m.clientId !== undefined ? { clientId: m.clientId } : {}),
        ...(m.clientSecret !== undefined ? { clientSecret: m.clientSecret } : {}),
      }));
    },

    forgeEditServer: async (msg, ctx) => {
      if (msg.type !== "forgeEditServer" || !isId(msg.requestId)) return;
      const m: Message<"forgeEditServer"> = msg;
      if (!isId(m.serverId) || !isStrings(m.gitHosts) || !isOptionalString(m.clientId) || !isOptionalString(m.clientSecret)) return;
      await answerForm(ctx.reply, m.requestId, oauthRefusal(m.clientId, m.clientSecret) ?? gitHostsRefusal(m.gitHosts), () => service().editServer(m.serverId, {
        gitHosts: m.gitHosts,
        ...(m.clientId !== undefined ? { clientId: m.clientId } : {}),
        ...(m.clientSecret !== undefined ? { clientSecret: m.clientSecret } : {}),
      }));
    },

    forgeRemoveServer: async (msg, ctx) => {
      if (msg.type !== "forgeRemoveServer" || !isId(msg.requestId) || !isId(msg.serverId)) return;
      await answerForm(ctx.reply, msg.requestId, undefined, () => service().removeServer(msg.serverId));
    },

    forgeConfirmGitHost: async (msg, ctx) => {
      if (msg.type !== "forgeConfirmGitHost" || !isId(msg.requestId) || !isId(msg.serverId) || !isString(msg.host) || msg.host === "") return;
      await answerForm(ctx.reply, msg.requestId, gitHostsRefusal([msg.host]), () => service().confirmGitHost(msg.serverId, msg.host));
    },

    forgeDismissGitHost: async (msg, ctx) => {
      if (msg.type !== "forgeDismissGitHost" || !isId(msg.requestId) || !isId(msg.serverId) || !isString(msg.host) || msg.host === "") return;
      await answerForm(ctx.reply, msg.requestId, gitHostsRefusal([msg.host]), () => service().dismissGitHost(msg.serverId, msg.host));
    },

    forgeRevealAccountsFile: async (msg, ctx) => {
      if (msg.type !== "forgeRevealAccountsFile" || !isId(msg.requestId)) return;
      await answerAction(ctx.reply, msg.requestId, () => service().revealBrokenFile());
    },

    forgeOpenPage: async (msg) => {
      if (msg.type !== "forgeOpenPage") return;
      if (platform.remote) return log("[ForgeAccounts] refused a page open on a remote core");
      switch (msg.page) {
        case "signIn":
        case "token":
          if (isId(msg.serverId)) await service().openPage({ page: msg.page, serverId: msg.serverId });
          return;
        case "orgAccess":
          if (isId(msg.accountId) && isId(msg.org)) await service().openPage({ page: "orgAccess", accountId: msg.accountId, org: msg.org });
          return;
        case "revoke":
          if (isId(msg.noticeId)) await service().openPage({ page: "revoke", noticeId: msg.noticeId });
          return;
      }
    },

    // a desktop settings overlay has no clipboard permission, so core writes the code; it is never logged
    forgeSignInCopyCode: async (msg, ctx) => {
      if (msg.type !== "forgeSignInCopyCode" || !isId(msg.serverId)) return;
      if (platform.remote) return postMessage(ctx.reply, { type: "forgeSignInCopyCodeAck", serverId: msg.serverId, ok: false });
      let ok = false;
      try {
        ok = await service().copySignInCode(msg.serverId);
      } catch (err) {
        log("[ForgeAccounts] could not copy the code: %s", err instanceof Error ? err.name : typeof err);
      }
      postMessage(ctx.reply, { type: "forgeSignInCopyCodeAck", serverId: msg.serverId, ok });
    },

    forgeCopyRedirectUri: async (msg, ctx) => {
      if (msg.type !== "forgeCopyRedirectUri" || !isId(msg.requestId) || !isKind(msg.kind) || (msg.serverId !== undefined && !isId(msg.serverId))) return;
      if (platform.remote) return postMessage(ctx.reply, { type: "forgeCopyRedirectUriAck", requestId: msg.requestId, ok: false });
      let ok = false;
      try {
        ok = await service().copyRedirectUri(msg.kind, msg.serverId);
      } catch (err) {
        log("[ForgeAccounts] could not copy the redirect URI: %s", err instanceof Error ? err.name : typeof err);
      }
      postMessage(ctx.reply, { type: "forgeCopyRedirectUriAck", requestId: msg.requestId, ok });
    },

    forgeDismissNotice: (msg) => {
      if (msg.type !== "forgeDismissNotice" || !isId(msg.noticeId) || platform.remote) return;
      service().dismissNotice(msg.noticeId);
    },
  };

  return {
    handlers,
    postState: (host) => {
      if (!forge || platform.remote) return;
      const toView = (message: ForgeViewMessage): void => postMessage(host, message);
      forge.publish(toView);
      forge.postSignInStates(toView);
      void forge.settingsOpened();
    },
  };
}
