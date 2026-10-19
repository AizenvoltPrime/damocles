import type { HandlerContext, HandlerDependencies, HandlerRegistry } from "../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../shared/types/messages";
import { updateConfigAtEffectiveScope } from "../../settings-manager/utils";
import { parseCacheWarmingMode } from "../../../../shared/types/constants";
import { McpWriteError } from "../../settings-manager/managers/mcp-config-write";
import { MCP_RESOURCE_EXPOSURE_SETTING, MCP_TOOL_EXPOSURE_SETTING, type McpToolExposureScope } from "../../../../shared/types/mcp";
import {
  isToolExposureSetting,
  resolveResourceExposure,
  resolveToolExposure,
  resourceExposureMapForScope,
  toolExposureLayers,
  toolExposureMapForScope,
} from "../../../pi-session/mcp/exposure";
import {
  deleteOpenrouterApiKey,
  deleteTypesafeApiKey,
  openrouterAuthStatus,
  storeOpenrouterApiKey,
  storeTypesafeApiKey,
  typesafeAuthStatus,
} from "../../settings-manager/managers/explore-manager";
import { log } from "../../../logger";
import { isSwitchableToolGroup, TOOL_GROUP_SETTINGS } from "../../../../shared/types/tools";
import { IMAGE_ENABLED_SETTING, IMAGE_MODEL_SETTING } from "../../../pi-session/tools/image-tool-specs";
import { writeSetting } from "../setting-write";
import { t } from "../../../l10n";
import { openaiAuthStatusMessage } from "./openai-handlers";
import { postVoiceFilesSize } from "./voice-stream-handlers";
import type { McpUserResourcePort } from "../../../pi-session/mcp/tool-source";
import { READ_MCP_RESOURCE } from "../../../permission-handler/mcp-resource-rule";
import { isBinaryMimeType, isDirectoryMimeType } from "../../../../shared/mcp-resource-mime";
import { isMcpAppResource } from "../../../pi-session/tools/mcp-resource-tools";
import { MAX_PENDING_TERMINAL_ATTACHMENTS } from "../../terminal-attachment-manager";
import { directoryChildren, errorText, mimeTypeOf, resourceLabel, resourceRows, templateRows } from "../../mcp-resource-attachments";
import { oneLine } from "../../../pi-session/untrusted-text";

const EXPOSURE_SCOPES: readonly string[] = ["user", "project", "local"] satisfies McpToolExposureScope[];

function exposureScopeLabel(scope: McpToolExposureScope): string {
  return scope === "user" ? t("User") : scope === "project" ? t("Project") : t("Local");
}

const MAX_REQUEST_ID_LENGTH = 128;
// Bounds a string core passes between the webview and an MCP server: a server name, URI, template, argument, cursor or completion value.
export const MAX_RESOURCE_FIELD_LENGTH = 8192;
const MAX_COMPLETION_CONTEXT_ENTRIES = 32;

const isRequestId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH;
const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_RESOURCE_FIELD_LENGTH;
/** A page request's cursor: undefined asks for the first page, null is a cursor core does not forward. */
const pageCursor = (value: unknown): string | undefined | null => (value === undefined ? undefined : isName(value) ? value : null);
// A cursor past the bound could not come back as a valid `pageCursor`, so it ends the listing.
const cursorOf = (value: unknown): { nextCursor?: string } => (isName(value) ? { nextCursor: value } : {});

/** The template's other values for a completion; undefined for anything but a small string record. */
function completionContext(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_COMPLETION_CONTEXT_ENTRIES || !entries.every(([key, entry]) => isName(key) && typeof entry === "string" && entry.length <= MAX_RESOURCE_FIELD_LENGTH)) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function requireUserResources(ctx: HandlerContext): McpUserResourcePort {
  const port = ctx.session.mcpUserResources();
  if (!port) throw new Error(t("MCP is not available in this chat yet."));
  return port;
}

export function createSettingsHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, settingsManager, getPanels, platform } = deps;

  /** Broadcast to every open panel — auth-status changes must propagate cross-panel. */
  function broadcast(message: ExtensionToWebviewMessage): void {
    for (const [, instance] of getPanels()) {
      postMessage(instance.host, message);
    }
  }

  async function broadcastStepfunStatus(): Promise<void> {
    for (const [, instance] of getPanels()) await settingsManager.sendStepfunAuthStatus(instance.host);
  }

  /** The OpenRouter key decides image generation. */
  async function broadcastOpenrouterStatus(): Promise<void> {
    broadcast(await openrouterAuthStatus(platform));
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

  /** An exposure setting's layers in the chat's folder, where `scope` sits among them, and that scope's own map. */
  function exposureLayersAt(setting: string, scope: McpToolExposureScope, ctx: HandlerContext) {
    const inspection = platform.settings.inspect<unknown>(setting);
    const layers = toolExposureLayers(inspection, platform.trust.isTrusted(ctx.folder.fsPath));
    const current = scope === "user" ? inspection.userValue : scope === "project" ? inspection.projectValue : inspection.localValue;
    return { layers, index: layers.findIndex((layer) => layer.scope === scope), current };
  }

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
    if (!tool) throw new Error(t('MCP server "{0}" has no tool "{1}".', resourceLabel(undefined, msg.serverName), resourceLabel(undefined, msg.toolName)));
    const { layers, index, current } = exposureLayersAt(MCP_TOOL_EXPOSURE_SETTING, msg.scope, ctx);
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

  async function writeResourceExposure(
    msg: Extract<WebviewToExtensionMessage, { type: "mcpSetResourceExposure" }>,
    ctx: HandlerContext,
  ): Promise<void> {
    if (!isToolExposureSetting(msg.exposure) || !EXPOSURE_SCOPES.includes(msg.scope)) throw new Error(t("Invalid MCP resource setting."));
    if (!settingsManager.getMcpToolExposureScopes(ctx.folder.key).includes(msg.scope)) {
      throw new Error(t("This folder cannot save MCP resource settings at the {0} scope.", exposureScopeLabel(msg.scope)));
    }
    const server = (await ctx.session.getMcpServerStatus()).find((status) => status.name === msg.serverName);
    if (!server) throw new Error(t('MCP server "{0}" is not available in this folder.', resourceLabel(undefined, msg.serverName)));
    const { layers, index, current } = exposureLayersAt(MCP_RESOURCE_EXPOSURE_SETTING, msg.scope, ctx);
    const next = resourceExposureMapForScope(current, layers.slice(0, index), msg.serverName, msg.exposure, server.configResourceExposure ?? "deferred");
    await platform.settings.update(MCP_RESOURCE_EXPOSURE_SETTING, next, msg.scope);
    const above = resolveResourceExposure(layers.slice(index + 1), msg.serverName, msg.exposure);
    if (above.source !== "config" && above.exposure !== msg.exposure) {
      postMessage(ctx.host, {
        type: "notification",
        notificationType: "info",
        message: t(
          "Saved at the {0} scope, but this server's {1} resource setting takes precedence, so it did not change. Save to {1} to change it.",
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
    // The settings modal sends only this, once per open and per attachment, and renders what it posts plus the changes
    // pushed after; its sections send no requests of their own.
    requestSettingsState: async (_msg, ctx) => {
      // First: the view's handlers read the capabilities (settingsFileAvailability is dropped without monaco).
      postMessage(ctx.host, { type: "hostCapabilities", capabilities: platform.capabilities });
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
      settingsManager.sendModelForPanel(ctx.host, ctx.panelId);
      settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId, ctx.folder);
      deps.postWorkspaceFolderState(ctx.panelId);
      // PiSession judges project scope by its working folder, which is the panel's folder.
      postMessage(ctx.host, { type: "projectTrust", trusted: platform.trust.isTrusted(ctx.folder.fsPath) });
      ctx.session.publishAccountInfo();
      // The view mounts after main attached it, so host prompts redirected to it before then are posted again.
      if (ctx.view) deps.webviewPrompts.repost(ctx.panelId, ctx.view);
      deps.postSettingsFileAvailability?.(ctx);
      deps.postClaudeAuthState?.(ctx.host);
      postMessage(ctx.host, await openaiAuthStatusMessage(platform));
      await settingsManager.sendStepfunAuthStatus(ctx.host);
      await settingsManager.sendDeepseekAuthStatus(ctx.host);
      postMessage(ctx.host, await typesafeAuthStatus(platform));
      postMessage(ctx.host, await openrouterAuthStatus(platform));
      postMessage(ctx.host, { type: "toolStatus", data: ctx.session.getToolStatus() });
      settingsManager.sendImageGenerationSettings(ctx.host);
      await settingsManager.sendVoiceConfig(ctx.host);
      await settingsManager.sendAvailableModels(ctx.session, ctx.host);
      await settingsManager.sendMcpStatus(ctx.session, ctx.host, ctx.folder.key);
      await postVoiceFilesSize(deps, ctx.host);
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
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
      }
    },

    setPanelThinkingDisabled: (msg, ctx) => {
      if (msg.type !== "setPanelThinkingDisabled") return;
      settingsManager.handleSetPanelThinkingDisabled(ctx.panelId, msg.disabled);
      settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId, ctx.folder);
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
      settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId, ctx.folder);
    },

    setDefaultThinkingDisabled: async (msg, ctx) => {
      if (msg.type !== "setDefaultThinkingDisabled") return;
      const saved = await writeSetting(deps, ctx, "damocles.thinkingDisabled", (detail) => t("Failed to save default thinking setting: {0}", detail), () =>
        settingsManager.handleSetDefaultThinkingDisabled(msg.disabled, ctx.folder));
      if (!saved) settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId, ctx.folder);
    },

    setDefaultEffort: async (msg, ctx) => {
      if (msg.type !== "setDefaultEffort") return;
      const saved = await writeSetting(deps, ctx, "damocles.effortByModel", (detail) => t("Failed to save default effort: {0}", detail), () =>
        settingsManager.handleSetDefaultEffort(msg.effort, msg.model, ctx.folder));
      if (!saved) settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId, ctx.folder);
    },

    setTeamRoleModel: async (msg, ctx) => {
      if (msg.type !== "setTeamRoleModel") return;
      await writeSetting(deps, ctx, `damocles.team.${msg.role}Model`, (detail) => t("Failed to save team role model: {0}", detail), () =>
        settingsManager.handleSetTeamRoleModel(msg.role, msg.model, ctx.folder));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setTeamRoleEffort: async (msg, ctx) => {
      if (msg.type !== "setTeamRoleEffort") return;
      await writeSetting(deps, ctx, `damocles.team.${msg.role}Effort`, (detail) => t("Failed to save team role effort: {0}", detail), () =>
        settingsManager.handleSetTeamRoleEffort(msg.role, msg.effort, ctx.folder));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setBackgroundModel: async (msg, ctx) => {
      if (msg.type !== "setBackgroundModel") return;
      await writeSetting(deps, ctx, "damocles.background.model", (detail) => t("Failed to save the background model: {0}", detail), () =>
        settingsManager.handleSetBackgroundModel(msg.model));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setBackgroundEffort: async (msg, ctx) => {
      if (msg.type !== "setBackgroundEffort") return;
      await writeSetting(deps, ctx, "damocles.background.effort", (detail) => t("Failed to save the background effort: {0}", detail), () =>
        settingsManager.handleSetBackgroundEffort(msg.effort));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setMemoryJudge: async (msg, ctx) => {
      if (msg.type !== "setMemoryJudge") return;
      await writeSetting(deps, ctx, "damocles.memory.judge", (detail) => t("Failed to save the memory judge: {0}", detail), () =>
        settingsManager.handleSetMemoryJudge(msg.judge));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setMemoryJudgeEffort: async (msg, ctx) => {
      if (msg.type !== "setMemoryJudgeEffort") return;
      await writeSetting(deps, ctx, "damocles.memory.judgeEffort", (detail) => t("Failed to save the memory judge effort: {0}", detail), () =>
        settingsManager.handleSetMemoryJudgeEffort(msg.effort));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setBudgetLimit: async (msg, ctx) => {
      if (msg.type !== "setBudgetLimit") return;
      const saved = await writeSetting(deps, ctx, "damocles.maxBudgetUsd", (detail) => t("Failed to save budget limit: {0}", detail), () =>
        settingsManager.handleSetBudgetLimit(msg.budgetUsd, ctx.folder));
      if (!saved) await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setTaskBudget: async (msg, ctx) => {
      if (msg.type !== "setTaskBudget") return;
      await writeSetting(deps, ctx, "damocles.taskBudget", (detail) => t("Failed to save task budget: {0}", detail), () =>
        settingsManager.handleSetTaskBudget(msg.budget, ctx.folder));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setAutoCompact: async (msg, ctx) => {
      if (msg.type !== "setAutoCompact") return;
      await writeSetting(deps, ctx, "damocles.autoCompact", (detail) => t("Failed to save auto-compact settings: {0}", detail), () =>
        settingsManager.handleSetAutoCompact(msg.config, ctx.folder));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setCacheWarming: async (msg, ctx) => {
      if (msg.type !== "setCacheWarming") return;
      await writeSetting(deps, ctx, "damocles.cacheWarming", (detail) => t("Failed to save cache warming setting: {0}", detail), () =>
        settingsManager.handleSetCacheWarming(parseCacheWarmingMode(msg.mode)));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setCheckpointRetentionDays: async (msg, ctx) => {
      if (msg.type !== "setCheckpointRetentionDays") return;
      await writeSetting(deps, ctx, "damocles.checkpoints.retentionDays", (detail) => t("Failed to save checkpoint retention: {0}", detail), () =>
        settingsManager.handleSetCheckpointRetentionDays(msg.days));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setPermissionMode: async (msg, ctx) => {
      if (msg.type !== "setPermissionMode") return;
      await settingsManager.handleSetPermissionMode(ctx.session, ctx.permissionHandler, msg.mode);
      // The chat's own composer and an attached settings view both show the mode from this.
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setDefaultPermissionMode: async (msg, ctx) => {
      if (msg.type !== "setDefaultPermissionMode") return;
      const saved = await writeSetting(deps, ctx, "damocles.permissionMode", (detail) => t("Failed to save default permission mode: {0}", detail), () =>
        settingsManager.handleSetDefaultPermissionMode(msg.mode, ctx.folder));
      if (!saved) await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setDangerouslySkipPermissions: async (msg, ctx) => {
      if (msg.type !== "setDangerouslySkipPermissions") return;
      settingsManager.handleSetDangerouslySkipPermissions(ctx.permissionHandler, msg.enabled);
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setDefaultDangerouslySkipPermissions: async (msg, ctx) => {
      if (msg.type !== "setDefaultDangerouslySkipPermissions") return;
      const saved = await writeSetting(deps, ctx, "damocles.dangerouslySkipPermissions", (detail) => t("Failed to save default YOLO mode: {0}", detail), () =>
        settingsManager.handleSetDefaultDangerouslySkipPermissions(msg.enabled, ctx.folder));
      if (!saved) await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setIdeContextEnabled: async (msg, ctx) => {
      if (msg.type !== "setIdeContextEnabled") return;
      const saved = await writeSetting(deps, ctx, "damocles.ideContext.enabled", (detail) => t("Failed to save IDE context setting: {0}", detail), () =>
        settingsManager.handleSetIdeContextEnabled(msg.enabled));
      if (!saved) await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
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
      const saved = await writeSetting(deps, ctx, "damocles.mcp.enabled", (detail) => t("Failed to save MCP setting: {0}", detail), () =>
        updateConfigAtEffectiveScope(platform, "damocles.mcp.enabled", msg.enabled));
      // Feed the master-gated set: disabling returns {} so live connections are torn down, not just
      // hidden; re-enabling re-feeds the enabled servers so they reconnect (M6).
      if (saved) feedMcpScopes();
      await settingsManager.sendMcpStatus(ctx.session, ctx.host, ctx.folder.key);
    },

    /**
     * One tool's Off / On / Always loaded choice, saved at the chosen scope. Only that scope's map is
     * read (from `inspect()`) and written back; a choice equal to what the scopes below and the config
     * already give removes the entry instead. The runtime's listener on the setting re-applies every
     * panel's tools, and the change is declared from each session's next turn.
     */
    mcpSetToolExposure: async (msg, ctx) => {
      if (msg.type !== "mcpSetToolExposure") return;
      try {
        await settingsManager.serializeSettingWrite(() => writeToolExposure(msg, ctx));
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

    /** A server's Resources row: one `damocles.mcp.resourceExposure` entry at one scope, serialized like the tool rows. */
    mcpSetResourceExposure: async (msg, ctx) => {
      if (msg.type !== "mcpSetResourceExposure") return;
      try {
        await settingsManager.serializeSettingWrite(() => writeResourceExposure(msg, ctx));
      } catch (err) {
        log("[MessageRouter] Error setting MCP resource exposure:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: t("Failed to save MCP resource setting: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
      await settingsManager.sendMcpStatus(ctx.session, ctx.host, ctx.folder.key);
    },

    // The MCP panel's resource picker. Each goes through the folder's user port: folder and visible user servers
    // resolve as for tools, a server whose capability is unknown connects, and resource exposure never applies (D13).
    // Every request with a usable id gets its reply, or the picker never leaves loading.
    requestMcpResources: async (msg, ctx) => {
      if (msg.type !== "requestMcpResources" || !isRequestId(msg.requestId)) return;
      const reply = (fields: Omit<Extract<ExtensionToWebviewMessage, { type: "mcpResources" }>, "type" | "requestId">) =>
        postMessage(ctx.host, { type: "mcpResources", requestId: msg.requestId, ...fields });
      const cursor = pageCursor(msg.cursor);
      if (!isName(msg.serverName) || cursor === null) {
        reply({ resources: [], error: t("This MCP request is not valid.") });
        return;
      }
      try {
        const page = await requireUserResources(ctx).listResourcesPage(msg.serverName, cursor);
        const filter = await ctx.permissionHandler.mcpResourceRuleFilter(READ_MCP_RESOURCE);
        reply({ resources: resourceRows(page.resources, msg.serverName, filter), ...cursorOf(page.nextCursor) });
      } catch (err) {
        reply({ resources: [], error: t("Could not list the resources of {0}: {1}", resourceLabel(undefined, msg.serverName), errorText(err)) });
      }
    },

    requestMcpResourceTemplates: async (msg, ctx) => {
      if (msg.type !== "requestMcpResourceTemplates" || !isRequestId(msg.requestId)) return;
      const reply = (fields: Omit<Extract<ExtensionToWebviewMessage, { type: "mcpResourceTemplates" }>, "type" | "requestId">) =>
        postMessage(ctx.host, { type: "mcpResourceTemplates", requestId: msg.requestId, ...fields });
      const cursor = pageCursor(msg.cursor);
      if (!isName(msg.serverName) || cursor === null) {
        reply({ templates: [], error: t("This MCP request is not valid.") });
        return;
      }
      try {
        const page = await requireUserResources(ctx).listResourceTemplatesPage(msg.serverName, cursor);
        reply({ templates: templateRows(page.resourceTemplates), ...cursorOf(page.nextCursor) });
      } catch (err) {
        reply({ templates: [], error: t("Could not list the resource templates of {0}: {1}", resourceLabel(undefined, msg.serverName), errorText(err)) });
      }
    },

    // A directory a deny rule covers still opens: the listing goes to the user, never to the model (D13).
    requestMcpResourceChildren: async (msg, ctx) => {
      if (msg.type !== "requestMcpResourceChildren" || !isRequestId(msg.requestId)) return;
      const reply = (fields: Omit<Extract<ExtensionToWebviewMessage, { type: "mcpResourceChildren" }>, "type" | "requestId">) =>
        postMessage(ctx.host, { type: "mcpResourceChildren", requestId: msg.requestId, ...fields });
      if (!isName(msg.serverName) || !isName(msg.uri)) {
        reply({ children: [], error: t("This MCP request is not valid.") });
        return;
      }
      try {
        const result = await requireUserResources(ctx).readResource(msg.serverName, msg.uri);
        const filter = await ctx.permissionHandler.mcpResourceRuleFilter(READ_MCP_RESOURCE);
        const children = directoryChildren(msg.uri, result, msg.serverName, filter);
        reply(children ? { children } : { children: [], notDirectory: true });
      } catch (err) {
        reply({ children: [], error: t("Could not open {0}: {1}", resourceLabel(undefined, msg.uri), errorText(err)) });
      }
    },

    requestMcpResourceCompletion: async (msg, ctx) => {
      if (msg.type !== "requestMcpResourceCompletion" || !isRequestId(msg.requestId)) return;
      const reply = (values: string[]) => postMessage(ctx.host, { type: "mcpResourceCompletion", requestId: msg.requestId, values });
      const context = completionContext(msg.context);
      const value = msg.value === "" || isName(msg.value) ? msg.value : undefined;
      if (!isName(msg.serverName) || !isName(msg.template) || !isName(msg.argument) || value === undefined || !context) {
        reply([]);
        return;
      }
      try {
        const values = await requireUserResources(ctx).completeResourceArgument(msg.serverName, msg.template, msg.argument, value, context);
        reply(values.flatMap((completion) => oneLine(completion, MAX_RESOURCE_FIELD_LENGTH) ?? []));
      } catch (err) {
        log("[MessageRouter] MCP completion for %s failed: %s", msg.serverName, errorText(err));
        reply([]);
      }
    },

    /** Holds the resource by reference (D12); a deny rule that covers it refuses the attach (D13), and nothing is read now. */
    attachMcpResource: async (msg, ctx) => {
      if (msg.type !== "attachMcpResource" || !isRequestId(msg.requestId)) return;
      const refuse = (refused: string) => postMessage(ctx.host, { type: "mcpResourceAttached", requestId: msg.requestId, refused });
      if (!isName(msg.serverName) || !isName(msg.uri)) {
        refuse(t("This resource cannot be attached."));
        return;
      }
      const name = resourceLabel(msg.name, msg.uri);
      const mimeType = mimeTypeOf(msg.mimeType);
      if (isMcpAppResource({ uri: msg.uri, mimeType: msg.mimeType })) {
        refuse(t("{0} is an MCP App interface, which cannot be sent to the model.", name));
        return;
      }
      // Only a directory MIME type refuses: a URI ending in `/` may be a file, which Open reports and the read at send decides.
      if (isDirectoryMimeType(mimeType)) {
        refuse(t("{0} is a directory. Open it and attach a resource inside it.", name));
        return;
      }
      if (isBinaryMimeType(mimeType)) {
        refuse(t("{0} is binary content ({1}), which cannot be sent to the model.", name, mimeType ?? ""));
        return;
      }
      const serverId = ctx.session.mcpUserResources()?.serverIdOf(msg.serverName);
      if (serverId === undefined) {
        refuse(t("MCP server {0} is not available in this chat.", resourceLabel(undefined, msg.serverName)));
        return;
      }
      const rule = (await ctx.permissionHandler.mcpResourceRuleFilter(READ_MCP_RESOURCE)).resourceDenyRule(msg.serverName, msg.uri);
      if (rule !== undefined) {
        refuse(t("A deny rule covers this resource: {0}", rule));
        return;
      }
      // Checked after the last await: `add` past the bound drops the oldest chip, and a chip may have arrived meanwhile.
      if (ctx.terminalAttachments.displayInfo().length >= MAX_PENDING_TERMINAL_ATTACHMENTS) {
        refuse(t("A message holds at most {0} attachments. Remove one to attach another.", MAX_PENDING_TERMINAL_ATTACHMENTS));
        return;
      }
      ctx.terminalAttachments.add({ kind: "mcpResource", server: msg.serverName, uri: msg.uri, name, ...(mimeType !== undefined ? { mimeType } : {}), serverId });
      postMessage(ctx.host, { type: "mcpResourceAttached", requestId: msg.requestId });
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
      const group = msg.group;
      if (!isSwitchableToolGroup(group)) throw new Error(`The ${String(group)} tool group has no switch`);
      const saved = await writeSetting(deps, ctx, TOOL_GROUP_SETTINGS[group], (detail) => t("Failed to save tool group setting: {0}", detail), () =>
        settingsManager.setToolGroupEnabled(group, msg.enabled));
      if (saved) ctx.session.refreshActiveTools();
      if (msg.group === "image") broadcastImageGenerationState();
      else postMessage(ctx.host, { type: "toolStatus", data: ctx.session.getToolStatus() });
    },

    requestToolStatus: (_msg, ctx) => {
      postMessage(ctx.host, { type: "toolStatus", data: ctx.session.getToolStatus() });
    },

    setImageGenerationEnabled: async (msg, ctx) => {
      if (msg.type !== "setImageGenerationEnabled") return;
      await writeSetting(deps, ctx, IMAGE_ENABLED_SETTING, (detail) => t("Failed to save image generation setting: {0}", detail), () =>
        settingsManager.setImageGenerationEnabled(msg.enabled));
      broadcastImageGenerationState();
    },

    setImageGenerationModel: async (msg, ctx) => {
      if (msg.type !== "setImageGenerationModel") return;
      await writeSetting(deps, ctx, IMAGE_MODEL_SETTING, (detail) => t("Failed to save image generation setting: {0}", detail), () =>
        settingsManager.setImageGenerationModel(msg.model));
      broadcastImageGenerationState();
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

    setExploreModel: async (msg, ctx) => {
      if (msg.type !== "setExploreModel") return;
      await writeSetting(deps, ctx, "damocles.explore.model", (detail) => t("Failed to save the Explore model: {0}", detail), () =>
        settingsManager.setExploreModel(msg.model));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setExploreEffort: async (msg, ctx) => {
      if (msg.type !== "setExploreEffort") return;
      await writeSetting(deps, ctx, "damocles.explore.effort", (detail) => t("Failed to save the Explore effort: {0}", detail), () =>
        settingsManager.setExploreEffort(msg.effort));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
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

  };
}
