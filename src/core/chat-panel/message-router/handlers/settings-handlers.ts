import type { HandlerContext, HandlerDependencies, HandlerRegistry } from "../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../shared/types/messages";
import { updateConfigAtEffectiveScope } from "../../settings-manager/utils";
import { parseCacheWarmingMode } from "../../../../shared/types/constants";
import { McpWriteError } from "../../settings-manager/managers/mcp-config-write";
import { MCP_TOOL_EXPOSURE_SETTING, type McpToolExposureScope } from "../../../../shared/types/mcp";
import { isToolExposureSetting, resolveToolExposure, toolExposureLayers, toolExposureMapForScope } from "../../../pi-session/mcp/exposure";
import {
  deleteOpenrouterApiKey,
  deleteTypesafeApiKey,
  openrouterAuthStatus,
  storeOpenrouterApiKey,
  storeTypesafeApiKey,
  typesafeAuthStatus,
} from "../../settings-manager/managers/explore-manager";
import { log } from "../../../logger";
import { t } from "../../../l10n";

const EXPOSURE_SCOPES: readonly string[] = ["user", "project", "local"] satisfies McpToolExposureScope[];

function exposureScopeLabel(scope: McpToolExposureScope): string {
  return scope === "user" ? t("User") : scope === "project" ? t("Project") : t("Local");
}

export function createSettingsHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, settingsManager, getPanels, platform } = deps;

  /** Broadcast to every open panel — auth-status changes must propagate cross-panel (and, for the
   *  shared StepFun key, between the Explore field and the dedicated StepFun panel). */
  function broadcast(message: ExtensionToWebviewMessage): void {
    for (const [, instance] of getPanels()) {
      postMessage(instance.host, message);
    }
  }

  /** Re-broadcast StepFun + Explore status to all panels so both indicators stay in sync (they share
   *  one SecretStorage entry). */
  async function broadcastStepfunStatus(): Promise<void> {
    for (const [, instance] of getPanels()) {
      await settingsManager.sendStepfunAuthStatus(instance.host);
      await settingsManager.sendExploreKeyStatus(instance.host);
    }
  }

  /** The OpenRouter key is also the Explore key when Explore uses OpenRouter, and it decides image generation. */
  async function broadcastOpenrouterStatus(): Promise<void> {
    broadcast(await openrouterAuthStatus(platform));
    if (settingsManager.selectedExploreProvider() === "openrouter") {
      for (const [, instance] of getPanels()) await settingsManager.sendExploreKeyStatus(instance.host);
    }
    broadcastImageGenerationState();
  }

  /** The image settings and OpenRouter auth are process-wide, so every panel's section and Tools panel change together. */
  function broadcastImageGenerationState(): void {
    for (const [, instance] of getPanels()) {
      settingsManager.sendImageGenerationSettings(instance.host);
      postMessage(instance.host, { type: "toolStatus", data: instance.session.getToolStatus() });
    }
  }

  /**
   * Feed every panel its own folder's MCP scope. Every panel, not the acting one: a user-scope toggle,
   * a write or the master switch changes every folder's scope, and each folder has its own client.
   */
  function feedMcpScopes(): void {
    for (const [, instance] of getPanels()) {
      instance.session.setMcpServers(settingsManager.getEnabledMcpServers(instance.folder.key));
    }
  }

  /** Each write reads its scope's map only after the previous write landed, so quick changes never overwrite each other. */
  let toolExposureWrites: Promise<void> = Promise.resolve();

  async function writeToolExposure(
    msg: Extract<WebviewToExtensionMessage, { type: "mcpSetToolExposure" }>,
    ctx: HandlerContext,
  ): Promise<void> {
    if (!isToolExposureSetting(msg.exposure) || !EXPOSURE_SCOPES.includes(msg.scope)) throw new Error(t("Invalid MCP tool setting."));
    if (!settingsManager.getMcpToolExposureScopes(ctx.folder.key).includes(msg.scope)) {
      throw new Error(t("This folder cannot save MCP tool settings at the {0} scope.", exposureScopeLabel(msg.scope)));
    }
    const server = (await ctx.session.getMcpServerStatus()).find((status) => status.name === msg.serverName);
    const tool = server?.tools?.find((candidate) => candidate.name === msg.toolName);
    if (!tool) throw new Error(t('MCP server "{0}" has no tool "{1}".', msg.serverName, msg.toolName));
    const inspection = platform.settings.inspect<unknown>(MCP_TOOL_EXPOSURE_SETTING);
    const layers = toolExposureLayers(inspection, platform.trust.isTrusted(ctx.folder.fsPath));
    const index = layers.findIndex((layer) => layer.scope === msg.scope);
    const current = msg.scope === "user" ? inspection.userValue : msg.scope === "project" ? inspection.projectValue : inspection.localValue;
    const next = toolExposureMapForScope(current, layers.slice(0, index), msg.serverName, msg.toolName, msg.exposure, tool.configExposure ?? "deferred");
    await platform.settings.update(MCP_TOOL_EXPOSURE_SETTING, next, msg.scope);
    const above = resolveToolExposure(layers.slice(index + 1), msg.serverName, msg.toolName, msg.exposure);
    if (above.source !== "config" && above.exposure !== msg.exposure) {
      postMessage(ctx.host, {
        type: "notification",
        notificationType: "info",
        message: t(
          "Saved at the {0} scope, but this tool's {1} setting takes precedence, so it did not change. Save to {1} to change it.",
          exposureScopeLabel(msg.scope),
          exposureScopeLabel(above.source),
        ),
      });
    }
  }

  /** Each panel gets its own folder's server list, config errors and leak warning, never another folder's. */
  function sendMcpConfigToPanels(): void {
    for (const [, instance] of getPanels()) {
      postMessage(instance.host, settingsManager.buildMcpConfigUpdate(instance.folder.key));
    }
  }

  /**
   * Re-read the merged sources after a write, re-feed the live MCP clients, and refresh every panel.
   *
   * Every panel rather than the acting one: the watcher covers `path.dirname(...)` of the user-global
   * files, and a non-recursive watcher over a directory that did not exist when it was created never
   * fires, leaving a second panel offering Edit for something already deleted.
   */
  async function applyMcpConfigChange(ctx: HandlerContext): Promise<void> {
    try {
      await settingsManager.loadMcpConfig();
      feedMcpScopes();
    } finally {
      // In a `finally` so a failed reload still answers the panel: the Reload button's in-flight state
      // ends on `mcpConfigUpdate`, and the error alone would leave it spinning until its lost-ack
      // timeout. Rethrown, so a failed write is still acknowledged as one.
      sendMcpConfigToPanels();
      await settingsManager.sendMcpStatus(ctx.session, ctx.host, ctx.folder.key);
    }
  }

  /**
   * Run one `~/.damocles/mcp.json` mutation and acknowledge it, always. The form holds the user's
   * typed definition until the ack lands, so a missing one strands the dialog — every path through
   * here must end in exactly one `mcpWriteResult`.
   */
  async function runMcpWrite(
    ctx: HandlerContext,
    requestId: string,
    serverName: string,
    what: string,
    apply: () => Promise<void>,
  ): Promise<void> {
    try {
      await apply();
      await applyMcpConfigChange(ctx);
      postMessage(ctx.host, { type: "mcpWriteResult", requestId, ok: true });
    } catch (err) {
      // The server NAME only: `msg.config` may carry an `env` or `headers` map, and this channel is
      // written to disk.
      log("[MessageRouter] Error %s MCP server %s:", what, serverName, err instanceof Error ? err.message : "Unknown error");
      const error = err instanceof McpWriteError
        ? err.info
        : { code: "writeFailed" as const, params: { detail: err instanceof Error ? err.message : "Unknown error" } };
      postMessage(ctx.host, { type: "mcpWriteResult", requestId, ok: false, error });
      // The panel renders the reason inline against the still-open form, so no notification here — a
      // toast as well would say the same thing twice.
      await settingsManager.sendMcpStatus(ctx.session, ctx.host, ctx.folder.key);
    }
  }

  return {
    requestModels: async (_msg, ctx) => {
      await settingsManager.sendAvailableModels(ctx.session, ctx.host);
    },

    setPinnedHeaderHidden: async (msg, ctx) => {
      if (msg.type !== "setPinnedHeaderHidden") return;
      try {
        await settingsManager.handleSetPinnedHeaderHidden(msg.hidden);
      } catch (err) {
        log("[MessageRouter] Error setting pinned header visibility:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save pinned header setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      }
    },

    setPanelThinkingDisabled: (msg, ctx) => {
      if (msg.type !== "setPanelThinkingDisabled") return;
      settingsManager.handleSetPanelThinkingDisabled(ctx.panelId, msg.disabled);
      settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId);
    },

    setPanelEffort: (msg, ctx) => {
      if (msg.type !== "setPanelEffort") return;
      try {
        settingsManager.handleSetPanelEffort(ctx.panelId, msg.model, msg.effort);
      } catch (err) {
        log("[MessageRouter] Error setting panel effort:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save effort setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
      settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId);
    },

    setPanelMaxThinkingTokens: (msg, ctx) => {
      if (msg.type !== "setPanelMaxThinkingTokens") return;
      settingsManager.handleSetPanelMaxThinkingTokens(ctx.panelId, msg.model, msg.tokens);
      settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId);
    },

    setDefaultThinkingDisabled: async (msg, ctx) => {
      if (msg.type !== "setDefaultThinkingDisabled") return;
      try {
        await settingsManager.handleSetDefaultThinkingDisabled(msg.disabled);
      } catch (err) {
        log("[MessageRouter] Error setting default thinking disabled:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save default thinking setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId);
      }
    },

    setDefaultEffort: async (msg, ctx) => {
      if (msg.type !== "setDefaultEffort") return;
      try {
        await settingsManager.handleSetDefaultEffort(msg.effort, msg.model);
      } catch (err) {
        log("[MessageRouter] Error setting default effort:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save default effort: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId);
      }
    },

    setTeamRoleModel: async (msg, ctx) => {
      if (msg.type !== "setTeamRoleModel") return;
      try {
        await settingsManager.handleSetTeamRoleModel(msg.role, msg.model);
      } catch (err) {
        log("[MessageRouter] Error setting team role model:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save team role model: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
    },

    setTeamRoleEffort: async (msg, ctx) => {
      if (msg.type !== "setTeamRoleEffort") return;
      try {
        await settingsManager.handleSetTeamRoleEffort(msg.role, msg.effort);
      } catch (err) {
        log("[MessageRouter] Error setting team role effort:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save team role effort: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
    },

    setDefaultMaxThinkingTokens: async (msg, ctx) => {
      if (msg.type !== "setDefaultMaxThinkingTokens") return;
      try {
        await settingsManager.handleSetDefaultMaxThinkingTokens(msg.tokens);
      } catch (err) {
        log("[MessageRouter] Error setting default max thinking tokens:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save default thinking tokens: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId);
      }
    },

    setBudgetLimit: async (msg, ctx) => {
      if (msg.type !== "setBudgetLimit") return;
      try {
        await settingsManager.handleSetBudgetLimit(msg.budgetUsd);
      } catch (err) {
        log("[MessageRouter] Error setting budget limit:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save budget limit: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      }
    },

    setTaskBudget: async (msg, ctx) => {
      if (msg.type !== "setTaskBudget") return;
      try {
        await settingsManager.handleSetTaskBudget(msg.budget);
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      } catch (err) {
        log("[MessageRouter] Error setting task budget:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save task budget: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      }
    },

    setAutoCompact: async (msg, ctx) => {
      if (msg.type !== "setAutoCompact") return;
      try {
        await settingsManager.handleSetAutoCompact(msg.config);
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      } catch (err) {
        log("[MessageRouter] Error setting auto-compact:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save auto-compact settings: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      }
    },

    setCacheWarming: async (msg, ctx) => {
      if (msg.type !== "setCacheWarming") return;
      try {
        await settingsManager.handleSetCacheWarming(parseCacheWarmingMode(msg.mode));
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      } catch (err) {
        log("[MessageRouter] Error setting cache warming:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save cache warming setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      }
    },

    setPermissionMode: async (msg, ctx) => {
      if (msg.type !== "setPermissionMode") return;
      await settingsManager.handleSetPermissionMode(ctx.session, ctx.permissionHandler, msg.mode);
    },

    setDefaultPermissionMode: async (msg, ctx) => {
      if (msg.type !== "setDefaultPermissionMode") return;
      try {
        await settingsManager.handleSetDefaultPermissionMode(msg.mode);
      } catch (err) {
        log("[MessageRouter] Error setting default permission mode:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save default permission mode: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      }
    },

    setDangerouslySkipPermissions: async (msg, ctx) => {
      if (msg.type !== "setDangerouslySkipPermissions") return;
      settingsManager.handleSetDangerouslySkipPermissions(ctx.permissionHandler, msg.enabled);
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
    },

    setDefaultDangerouslySkipPermissions: async (msg, ctx) => {
      if (msg.type !== "setDefaultDangerouslySkipPermissions") return;
      try {
        await settingsManager.handleSetDefaultDangerouslySkipPermissions(msg.enabled);
      } catch (err) {
        log("[MessageRouter] Error setting default YOLO mode:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save default YOLO mode: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      }
    },

    setIdeContextEnabled: async (msg, ctx) => {
      if (msg.type !== "setIdeContextEnabled") return;
      try {
        await settingsManager.handleSetIdeContextEnabled(msg.enabled);
      } catch (err) {
        log("[MessageRouter] Error setting IDE context default:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save IDE context setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      }
    },

    toggleMcpServer: async (msg, ctx) => {
      if (msg.type !== "toggleMcpServer") return;
      try {
        await settingsManager.setServerEnabled(ctx.folder.key, msg.serverName, msg.enabled);
        feedMcpScopes();
        // Push live status now (shows "connecting"); the MCP status listener auto-pushes "connected"
        // once the background connect settles.
        await settingsManager.sendMcpStatus(ctx.session, ctx.host, ctx.folder.key);
      } catch (err) {
        log("[MessageRouter] Error toggling MCP server:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save MCP server setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendMcpStatus(ctx.session, ctx.host, ctx.folder.key);
      }
    },

    /**
     * The three `~/.damocles/mcp.json` mutations. Each applies the change, reloads the merged config,
     * re-feeds the live session so it takes effect with no window reload, refreshes every panel, and
     * acknowledges. On failure nothing has been written, and the reason travels back as a code the
     * panel translates against the still-open form.
     */
    mcpAddServer: async (msg, ctx) => {
      if (msg.type !== "mcpAddServer") return;
      await runMcpWrite(ctx, msg.requestId, msg.serverName, "adding", async () => {
        await settingsManager.addMcpServer(ctx.folder.key, msg.serverName, msg.config);
      });
    },

    mcpUpdateServer: async (msg, ctx) => {
      if (msg.type !== "mcpUpdateServer") return;
      await runMcpWrite(ctx, msg.requestId, msg.serverName, "updating", async () => {
        await settingsManager.updateMcpServer(ctx.folder.key, msg.serverName, msg.newServerName, msg.config);
      });
    },

    mcpDeleteServer: async (msg, ctx) => {
      if (msg.type !== "mcpDeleteServer") return;
      await runMcpWrite(ctx, msg.requestId, msg.serverName, "removing", async () => {
        await settingsManager.deleteMcpServer(msg.serverName);
      });
    },

    reconnectMcpServer: async (msg, ctx) => {
      if (msg.type !== "reconnectMcpServer") return;
      const success = await ctx.session.reconnectMcpServerLive(msg.serverName);
      await settingsManager.sendMcpStatus(ctx.session, ctx.host, ctx.folder.key);
      if (!success) {
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to reconnect MCP server"),
          notificationType: "error",
        });
      }
    },

    authenticateMcpServer: async (msg, ctx) => {
      if (msg.type !== "authenticateMcpServer") return;
      const success = await ctx.session.reconnectMcpServerLive(msg.serverName);
      await settingsManager.sendMcpStatus(ctx.session, ctx.host, ctx.folder.key);
      if (!success) {
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to authenticate MCP server"),
          notificationType: "error",
        });
      }
    },

    reauthenticateMcpServer: async (msg, ctx) => {
      if (msg.type !== "reauthenticateMcpServer") return;
      try {
        const success = await ctx.session.reauthenticateMcpServerLive(msg.serverName);
        if (!success) {
          postMessage(ctx.host, {
            type: "notification",
            message: t("Failed to re-authenticate MCP server"),
            notificationType: "error",
          });
        }
      } catch (err) {
        log("[MessageRouter] Error re-authenticating MCP server:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to re-authenticate MCP server: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      } finally {
        await settingsManager.sendMcpStatus(ctx.session, ctx.host, ctx.folder.key);
      }
    },

    signOutMcpServer: async (msg, ctx) => {
      if (msg.type !== "signOutMcpServer") return;
      try {
        await ctx.session.signOutMcpServerLive(msg.serverName);
      } catch (err) {
        log("[MessageRouter] Error signing out of MCP server:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to sign out of MCP server: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      } finally {
        await settingsManager.sendMcpStatus(ctx.session, ctx.host, ctx.folder.key);
      }
    },

    mcpReloadConfig: async (_msg, ctx) => {
      await applyMcpConfigChange(ctx);
    },

    requestMcpStatus: async (_msg, ctx) => {
      await settingsManager.sendMcpStatus(ctx.session, ctx.host, ctx.folder.key);
    },

    setMcpEnabled: async (msg, ctx) => {
      if (msg.type !== "setMcpEnabled") return;
      try {
        await updateConfigAtEffectiveScope(platform, "damocles", "mcp.enabled", msg.enabled);
        // Feed the master-gated set: disabling returns {} so live connections are torn down, not just
        // hidden; re-enabling re-feeds the enabled servers so they reconnect (M6).
        feedMcpScopes();
        await settingsManager.sendMcpStatus(ctx.session, ctx.host, ctx.folder.key);
      } catch (err) {
        log("[MessageRouter] Error setting MCP enabled:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save MCP setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
        await settingsManager.sendMcpStatus(ctx.session, ctx.host, ctx.folder.key);
      }
    },

    /**
     * One tool's Off / On / Always loaded choice, saved at the chosen scope. Only that scope's map is
     * read (from `inspect()`) and written back; a choice equal to what the scopes below and the config
     * already give removes the entry instead. The runtime's listener on the setting re-applies every
     * panel's tools, and the change is declared from each session's next turn.
     */
    mcpSetToolExposure: async (msg, ctx) => {
      if (msg.type !== "mcpSetToolExposure") return;
      const write = toolExposureWrites.then(() => writeToolExposure(msg, ctx));
      // The chain only orders writes; this handler reports the failure.
      toolExposureWrites = write.catch(() => undefined);
      try {
        await write;
      } catch (err) {
        log("[MessageRouter] Error setting MCP tool exposure:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save MCP tool setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
      // The setting listener updates every panel on a change; a failed or unchanged write fires none, so the requester gets the outcome here.
      await settingsManager.sendMcpStatus(ctx.session, ctx.host, ctx.folder.key);
    },

    requestSupportedCommands: async (_msg, ctx) => {
      await settingsManager.sendSupportedCommands(ctx.session, ctx.host);
    },

    toggleTool: async (msg, ctx) => {
      if (msg.type !== "toggleTool") return;
      try {
        await settingsManager.setToolDisabled(msg.toolName, !msg.enabled);
        ctx.session.refreshActiveTools();
      } catch (err) {
        log("[MessageRouter] Error toggling tool:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save tool setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
      postMessage(ctx.host, { type: "toolStatus", data: ctx.session.getToolStatus() });
    },

    toggleToolGroup: async (msg, ctx) => {
      if (msg.type !== "toggleToolGroup") return;
      try {
        await settingsManager.setToolGroupEnabled(msg.group, msg.enabled);
        ctx.session.refreshActiveTools();
      } catch (err) {
        log("[MessageRouter] Error toggling tool group:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save tool group setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
      if (msg.group === "image") broadcastImageGenerationState();
      else postMessage(ctx.host, { type: "toolStatus", data: ctx.session.getToolStatus() });
    },

    requestToolStatus: (_msg, ctx) => {
      postMessage(ctx.host, { type: "toolStatus", data: ctx.session.getToolStatus() });
    },

    setImageGenerationEnabled: async (msg, ctx) => {
      if (msg.type !== "setImageGenerationEnabled") return;
      try {
        await settingsManager.setImageGenerationEnabled(msg.enabled);
      } catch (err) {
        log("[MessageRouter] Error setting image generation:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save image generation setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
      broadcastImageGenerationState();
    },

    setImageGenerationModel: async (msg, ctx) => {
      if (msg.type !== "setImageGenerationModel") return;
      try {
        await settingsManager.setImageGenerationModel(msg.model);
      } catch (err) {
        log("[MessageRouter] Error setting image generation model:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save image generation setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
      broadcastImageGenerationState();
    },

    requestImageGenerationSettings: (_msg, ctx) => {
      settingsManager.sendImageGenerationSettings(ctx.host);
    },

    setProjectTrusted: async (_msg, ctx) => {
      // Trust is the user's decision, so this only asks the host to show its trust prompt. On grant, the
      // workspace agent registry's TrustService listener reloads project agents and PiSession re-emits
      // `projectTrust` (US-022).
      try {
        await platform.trust.requestTrust(ctx.folder.fsPath);
      } catch (err) {
        log("[MessageRouter] Failed to open workspace-trust editor:", err);
      }
    },

    setExploreApiKey: async (msg, ctx) => {
      if (msg.type !== "setExploreApiKey") return;
      await settingsManager.storeExploreApiKey(msg.apiKey);
      await settingsManager.sendExploreKeyStatus(ctx.host);
      // The Explore StepFun field and the dedicated StepFun panel share one key — keep the panel's dot
      // in sync when stepfun is the selected explore provider. Mirror the storage boundary's trim so
      // a whitespace-only key reports the same "configured" state through both entry points.
      if (settingsManager.selectedExploreProvider() === "stepfun") {
        broadcast({ type: "stepfunAuthStatusChanged", configured: msg.apiKey.trim().length > 0 });
      }
      if (settingsManager.selectedExploreProvider() === "openrouter") broadcast(await openrouterAuthStatus(platform));
      broadcastImageGenerationState();
    },

    deleteExploreApiKey: async (_msg, ctx) => {
      const deleted = settingsManager.selectedExploreProvider();
      await settingsManager.deleteExploreApiKey();
      await settingsManager.sendExploreKeyStatus(ctx.host);
      if (deleted === "stepfun") {
        broadcast({ type: "stepfunAuthStatusChanged", configured: false });
      }
      if (deleted === "openrouter") broadcast(await openrouterAuthStatus(platform));
      broadcastImageGenerationState();
    },

    requestExploreKeyStatus: async (_msg, ctx) => {
      await settingsManager.sendExploreKeyStatus(ctx.host);
    },

    setExploreProvider: async (msg, ctx) => {
      if (msg.type !== "setExploreProvider") return;
      await settingsManager.setExploreProvider(msg.provider);
      settingsManager.sendExploreConfig(ctx.host);
      await settingsManager.sendExploreKeyStatus(ctx.host);
    },

    setExploreModel: async (msg, ctx) => {
      if (msg.type !== "setExploreModel") return;
      await settingsManager.setExploreModel(msg.model);
      settingsManager.sendExploreConfig(ctx.host);
    },

    setExploreEffort: async (msg, ctx) => {
      if (msg.type !== "setExploreEffort") return;
      await settingsManager.setExploreEffort(msg.effort);
      settingsManager.sendExploreConfig(ctx.host);
    },

    requestExploreConfig: (_msg, ctx) => {
      settingsManager.sendExploreConfig(ctx.host);
    },

    setStepfunApiKey: async (msg, ctx) => {
      if (msg.type !== "setStepfunApiKey") return;
      const key = msg.key.trim();
      if (!key) {
        postMessage(ctx.host, { type: "setStepfunApiKeyAck", requestId: msg.requestId, ok: false, error: t("API key cannot be empty") });
        return;
      }
      try {
        await settingsManager.storeStepfunApiKey(key);
        postMessage(ctx.host, { type: "setStepfunApiKeyAck", requestId: msg.requestId, ok: true });
        await broadcastStepfunStatus();
      } catch (err) {
        log("[SettingsHandlers] Failed to store StepFun key:", err);
        postMessage(ctx.host, { type: "setStepfunApiKeyAck", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : "Failed to store API key" });
      }
    },

    clearStepfunApiKey: async (msg, ctx) => {
      if (msg.type !== "clearStepfunApiKey") return;
      try {
        await settingsManager.deleteStepfunApiKey();
        postMessage(ctx.host, { type: "clearStepfunApiKeyAck", requestId: msg.requestId, ok: true });
        await broadcastStepfunStatus();
      } catch (err) {
        log("[SettingsHandlers] Failed to clear StepFun key:", err);
        postMessage(ctx.host, { type: "clearStepfunApiKeyAck", requestId: msg.requestId, ok: false, error: t("Failed to clear API key") });
      }
    },

    getStepfunAuthStatus: async (_msg, ctx) => {
      await settingsManager.sendStepfunAuthStatus(ctx.host);
    },

    setDeepseekApiKey: async (msg, ctx) => {
      if (msg.type !== "setDeepseekApiKey") return;
      const key = msg.key.trim();
      if (!key) {
        postMessage(ctx.host, { type: "setDeepseekApiKeyAck", requestId: msg.requestId, ok: false, error: t("API key cannot be empty") });
        return;
      }
      try {
        await settingsManager.storeDeepseekApiKey(key);
        postMessage(ctx.host, { type: "setDeepseekApiKeyAck", requestId: msg.requestId, ok: true });
        broadcast({ type: "deepseekAuthStatusChanged", configured: true });
      } catch (err) {
        log("[SettingsHandlers] Failed to store DeepSeek key:", err);
        postMessage(ctx.host, { type: "setDeepseekApiKeyAck", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : "Failed to store API key" });
      }
    },

    clearDeepseekApiKey: async (msg, ctx) => {
      if (msg.type !== "clearDeepseekApiKey") return;
      try {
        await settingsManager.deleteDeepseekApiKey();
        postMessage(ctx.host, { type: "clearDeepseekApiKeyAck", requestId: msg.requestId, ok: true });
        broadcast({ type: "deepseekAuthStatusChanged", configured: false });
      } catch (err) {
        log("[SettingsHandlers] Failed to clear DeepSeek key:", err);
        postMessage(ctx.host, { type: "clearDeepseekApiKeyAck", requestId: msg.requestId, ok: false, error: t("Failed to clear API key") });
      }
    },

    getDeepseekAuthStatus: async (_msg, ctx) => {
      await settingsManager.sendDeepseekAuthStatus(ctx.host);
    },

    setTypesafeApiKey: async (msg, ctx) => {
      if (msg.type !== "setTypesafeApiKey") return;
      const key = msg.key.trim();
      if (!key) {
        postMessage(ctx.host, { type: "setTypesafeApiKeyAck", requestId: msg.requestId, ok: false, error: t("API key cannot be empty") });
        return;
      }
      try {
        await storeTypesafeApiKey(platform, key);
        postMessage(ctx.host, { type: "setTypesafeApiKeyAck", requestId: msg.requestId, ok: true });
      } catch (err) {
        log("[SettingsHandlers] Failed to store TypeSafe key:", err);
        postMessage(ctx.host, { type: "setTypesafeApiKeyAck", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : "Failed to store API key" });
      }
    },

    clearTypesafeApiKey: async (msg, ctx) => {
      if (msg.type !== "clearTypesafeApiKey") return;
      try {
        await deleteTypesafeApiKey(platform);
        postMessage(ctx.host, { type: "clearTypesafeApiKeyAck", requestId: msg.requestId, ok: true });
      } catch (err) {
        log("[SettingsHandlers] Failed to clear TypeSafe key:", err);
        postMessage(ctx.host, { type: "clearTypesafeApiKeyAck", requestId: msg.requestId, ok: false, error: t("Failed to clear API key") });
      }
    },

    getTypesafeAuthStatus: async (_msg, ctx) => {
      postMessage(ctx.host, await typesafeAuthStatus(platform));
    },

    setOpenrouterApiKey: async (msg, ctx) => {
      if (msg.type !== "setOpenrouterApiKey") return;
      const key = msg.key.trim();
      if (!key) {
        postMessage(ctx.host, { type: "setOpenrouterApiKeyAck", requestId: msg.requestId, ok: false, error: t("API key cannot be empty") });
        return;
      }
      try {
        await storeOpenrouterApiKey(platform, key);
        postMessage(ctx.host, { type: "setOpenrouterApiKeyAck", requestId: msg.requestId, ok: true });
      } catch (err) {
        log("[SettingsHandlers] Failed to store OpenRouter key:", err);
        postMessage(ctx.host, { type: "setOpenrouterApiKeyAck", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : "Failed to store API key" });
        return;
      }
      await broadcastOpenrouterStatus();
    },

    clearOpenrouterApiKey: async (msg, ctx) => {
      if (msg.type !== "clearOpenrouterApiKey") return;
      try {
        await deleteOpenrouterApiKey(platform);
        postMessage(ctx.host, { type: "clearOpenrouterApiKeyAck", requestId: msg.requestId, ok: true });
      } catch (err) {
        log("[SettingsHandlers] Failed to clear OpenRouter key:", err);
        postMessage(ctx.host, { type: "clearOpenrouterApiKeyAck", requestId: msg.requestId, ok: false, error: t("Failed to clear API key") });
        return;
      }
      await broadcastOpenrouterStatus();
    },

    getOpenrouterAuthStatus: async (_msg, ctx) => {
      postMessage(ctx.host, await openrouterAuthStatus(platform));
    },

  };
}
