import type { HandlerDependencies, HandlerRegistry, PostMessageFn, ViewHandlerRegistry } from "../types";
import type { Platform } from "../../../../platform/platform";
import type { PanelHost } from "../../../../platform/window-service";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../shared/types/messages";
import type { LocalizedText } from "../../../../shared/localized-text";
import type { ForgeService, RecordedRefusal } from "../../../forge";
import { openAppSettingsFor } from "../../open-app-settings";
import { l } from "../../../l10n";
import { log } from "../../../logger";

// The refused notice (docs/invariants.md "GitHub and GitLab accounts"). The webview names a refusal by its toolCallId only;
// core binds and opens what it recorded for that panel, so a view never names a project, an account or a page core did not offer.

export type ForgeShellRefused = Extract<ExtensionToWebviewMessage, { type: "forgeShellRefused" }>;

const MAX_ID_CHARS = 1024;
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS;

type SettingsPlatform = Pick<Platform, "capabilities" | "window">;

/** The key a remote chat view's refusals are recorded under, beside this core's own panel ids. */
export function foreignRefusalKey(viewId: string): string {
  return `foreign:${viewId}`;
}

/** Settings › Models & accounts › Git hosting at the refusal's account with Manage open, else at its server's row. */
function openRefusalSettings(platform: SettingsPlatform, postMessage: PostMessageFn, host: PanelHost, serverId: string, accountId: string | undefined): void {
  openAppSettingsFor(platform, postMessage, host, "accounts", undefined, undefined, { server: serverId, ...(accountId !== undefined ? { account: accountId } : {}) });
}

function toastText(refused: ForgeShellRefused): LocalizedText {
  if (refused.reason === "orgAccess" && refused.org && refused.account) {
    return refused.org.kind === "sso"
      ? l("The {0} organization on {1} requires single sign-on, and the token of {2} is not authorized for it.", refused.org.name, refused.serverLabel, refused.account.login)
      : l("The {0} organization on {1} has not approved Damocles, so the token of {2} cannot see its repositories.", refused.org.name, refused.serverLabel, refused.account.login);
  }
  if (refused.tool !== undefined) return l("The agent's {0} call has no account for this project on {1}.", refused.tool, refused.serverLabel);
  return refused.reason === "agentShellsOff" && refused.account
    ? l("The agent's git was refused. The account this project uses on {0}, {1}, does not allow agent shells. Damocles kept its token out of the shell.", refused.serverLabel, refused.account.login)
    : l("The agent's git was refused. Damocles found no account for this project on {0}, so the agent's git got no credentials.", refused.serverLabel);
}

/** The organization action's words: authorize single sign-on, or ask the organization to approve Damocles. */
function orgActionText(org: NonNullable<ForgeShellRefused["org"]>): LocalizedText {
  return org.kind === "sso" ? l("Authorize Damocles for {0}", org.name) : l("Request approval from {0}", org.name);
}

/** The organization page a refusal recorded (SSO authorization, or the app's approval request), opened as the user's click. */
export async function openRefusalOrgPage(forge: ForgeService, refusal: RecordedRefusal): Promise<void> {
  if (refusal.org === undefined || refusal.accountId === undefined) {
    log("[forge] ignored an organization action for a refusal that names no organization");
    return;
  }
  const opened = await forge.openPage({ page: "orgAccess", accountId: refusal.accountId, org: refusal.org });
  if (!opened) log("[forge] the organization page of a refusal could not be opened");
}

/**
 * Called right after the forgeShellRefused post: a toast with the notice's text and actions, shown only while the window is
 * unfocused. Choose account brings the chat forward and opens the notice's menu; a refusal outside a project offers only
 * settings; an organization refusal offers its organization action (openOrg).
 */
export async function raiseForgeRefusal(platform: Pick<Platform, "capabilities" | "window" | "notifications">, postMessage: PostMessageFn, host: PanelHost, refused: ForgeShellRefused, openOrg?: () => Promise<void>): Promise<void> {
  const org = refused.reason === "orgAccess" && openOrg ? refused.org : undefined;
  const canChoose = org === undefined && refused.canBind === true;
  const actions = org ? [orgActionText(org)] : canChoose ? [l("Choose account"), l("Open Git hosting settings")] : [l("Open Git hosting settings")];
  let chosen: number | undefined;
  try {
    chosen = await platform.notifications.warn(toastText(refused), actions, { unlessFocused: true });
  } catch (err) {
    log("[forge] the refused notice's toast failed:", err instanceof Error ? err.message : String(err));
    return;
  }
  if (chosen === undefined) return;
  if (org && openOrg) {
    await openOrg();
    return;
  }
  if (canChoose && chosen === 0) {
    await host.reveal();
    postMessage(host, { type: "forgeRefusedOpenMenu", toolCallId: refused.toolCallId });
    return;
  }
  openRefusalSettings(platform, postMessage, host, refused.serverId, refused.account?.id);
}

/** Where a notice's action came from: this core's panel, or a remote chat's view through its proxy here. */
interface ActionSource {
  readonly key: string;
  readonly reply: PanelHost;
}

/** A refused notice's actions on the refusal recorded under the source's key. */
function refusalActions(deps: HandlerDependencies) {
  const { postMessage, platform, forge } = deps;
  return {
    bind: async (msg: WebviewToExtensionMessage, source: ActionSource): Promise<void> => {
      if (msg.type !== "forgeRefusedBind" || !isId(msg.toolCallId) || !isId(msg.accountId)) return;
      const { toolCallId, accountId } = msg;
      // the notice waits in "saving" until an answer comes, so every outcome past the id checks answers
      const answer = (ok: boolean): void => postMessage(source.reply, { type: "forgeRefusedBindResult", toolCallId, accountId, ok });
      const refusal = forge?.refusalOf(source.key, toolCallId);
      const account = forge?.state().accounts.find((candidate) => candidate.id === accountId);
      if (!forge || !refusal || account?.serverId !== refusal.serverId) {
        log("[forge] ignored a refused notice's bind for a refusal or account core did not offer");
        answer(false);
        return;
      }
      // a shell outside every project has nothing to bind
      if (refusal.projectKey === undefined) {
        answer(false);
        return;
      }
      try {
        answer(await forge.bindAccount(refusal.projectKey, refusal.serverId, accountId));
      } catch (err) {
        log("[forge] a refused notice's bind failed:", err instanceof Error ? err.message : String(err));
        answer(false);
      }
    },
    openSettings: (msg: WebviewToExtensionMessage, source: ActionSource): void => {
      if (msg.type !== "forgeRefusedOpenSettings" || !isId(msg.toolCallId)) return;
      const refusal = forge?.refusalOf(source.key, msg.toolCallId);
      if (!refusal) {
        log("[forge] ignored a refused notice's settings action for a refusal core did not post");
        return;
      }
      openRefusalSettings(platform, postMessage, source.reply, refusal.serverId, refusal.accountId);
    },
    orgAction: async (msg: WebviewToExtensionMessage, source: ActionSource): Promise<void> => {
      if (msg.type !== "forgeRefusedOrgAction" || !isId(msg.toolCallId)) return;
      const refusal = forge?.refusalOf(source.key, msg.toolCallId);
      if (!forge || !refusal) {
        log("[forge] ignored a refused notice's organization action for a refusal core did not post");
        return;
      }
      await openRefusalOrgPage(forge, refusal);
    },
  };
}

export function createForgeRefusedHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const actions = refusalActions(deps);
  return {
    forgeRefusedBind: (msg, ctx) => actions.bind(msg, { key: ctx.panelId, reply: ctx.reply }),
    forgeRefusedOpenSettings: (msg, ctx) => actions.openSettings(msg, { key: ctx.panelId, reply: ctx.reply }),
    forgeRefusedOrgAction: (msg, ctx) => actions.orgAction(msg, { key: ctx.panelId, reply: ctx.reply }),
  };
}

/** The same actions from a remote chat's view, on the refusals this core recorded for that view (user.forge.*). */
export function createForgeRefusedViewHandlers(deps: HandlerDependencies): ViewHandlerRegistry {
  const actions = refusalActions(deps);
  const sourceOf = (ctx: { readonly host: PanelHost; readonly viewId?: string }): ActionSource | undefined =>
    ctx.viewId !== undefined ? { key: foreignRefusalKey(ctx.viewId), reply: ctx.host } : undefined;
  const run = <T>(ctx: { readonly host: PanelHost; readonly viewId?: string }, act: (source: ActionSource) => T): T | undefined => {
    const source = sourceOf(ctx);
    if (source) return act(source);
    log("[forge] ignored a refused notice's action that names no remote chat view");
    return undefined;
  };
  return {
    forgeRefusedBind: (msg, ctx) => run(ctx, (source) => actions.bind(msg, source)),
    forgeRefusedOpenSettings: (msg, ctx) => run(ctx, (source) => actions.openSettings(msg, source)),
    forgeRefusedOrgAction: (msg, ctx) => run(ctx, (source) => actions.orgAction(msg, source)),
  };
}
