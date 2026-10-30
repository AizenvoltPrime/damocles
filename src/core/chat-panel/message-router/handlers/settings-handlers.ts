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
import { providerAuthStatus, setProviderPreferApiKey } from "../../settings-manager/managers/provider-keys";
import { remoteSignInRefusal } from "../../../pi-session/pi-runtime";
import { memoryJudgeStatus } from "../../settings-manager/managers/memory-judge-status";
import { ACCOUNT_PROVIDER_IDS, isKeyProviderId } from "../../../../shared/settings-sections";
import { log } from "../../../logger";
import { isSwitchableToolGroup, TOOL_GROUP_SETTINGS } from "../../../../shared/types/tools";
import { IMAGE_ENABLED_SETTING, IMAGE_MODEL_SETTING } from "../../../pi-session/tools/image-tool-specs";
import { writeSetting } from "../setting-write";
import { errorTextOf, l } from "../../../l10n";
import { englishText, LocalizedError, type LocalizedText } from "../../../../shared/localized-text";
import { openaiAuthStatusMessage } from "./openai-handlers";
import { postVoiceFilesSize, postVoiceRuntimeStatus } from "./voice-stream-handlers";
import type { McpUserResourcePort } from "../../../pi-session/mcp/tool-source";
import { READ_MCP_RESOURCE } from "../../../permission-handler/mcp-resource-rule";
import { isBinaryMimeType, isDirectoryMimeType } from "../../../../shared/mcp-resource-mime";
import { isMcpAppResource } from "../../../pi-session/tools/mcp-resource-tools";
import { MAX_PENDING_TERMINAL_ATTACHMENTS } from "../../terminal-attachment-manager";
import { directoryChildren, errorText, mimeTypeOf, resourceLabel, resourceRows, templateRows } from "../../mcp-resource-attachments";
import { oneLine } from "../../../pi-session/untrusted-text";
import { bypassAllowed } from "../../../client-snapshots";
import { PERMISSION_MODES } from "../../../../shared/types/settings";
import { MODEL_PICKER_SETTING } from "../../../../shared/model-vendor";

const EXPOSURE_SCOPES: readonly string[] = ["user", "project", "local"] satisfies McpToolExposureScope[];

function exposureScopeLabel(scope: McpToolExposureScope): LocalizedText {
  return scope === "user" ? l("User") : scope === "project" ? l("Project") : l("Local");
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
  if (!port) throw new LocalizedError(l("MCP is not available in this chat yet."));
  return port;
}

/** The image settings and OpenRouter auth are process-wide, so every panel's section and Tools panel change together. */
export function broadcastImageGenerationState({ getPanels, settingsManager }: Pick<HandlerDependencies, "getPanels" | "settingsManager">): void {
  for (const [, instance] of getPanels()) {
    settingsManager.sendImageGenerationSettings(instance.host);
    settingsManager.sendToolStatus(instance.session, instance.host);
  }
}

export function createSettingsHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, settingsManager, getPanels, platform } = deps;
  // a forged or refused change shows as a calm inline message in the composer, never an error
  const refuseMode = (ctx: HandlerContext, mode: string, reason: "remote-host" | "unknown-mode"): void => {
    log("[SettingsHandlers] refused the permission change to %s: %s", mode, reason);
    postMessage(ctx.reply, { type: "permissionModeRefused", mode, reason });
  };

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
    if (!isToolExposureSetting(msg.exposure) || !EXPOSURE_SCOPES.includes(msg.scope)) throw new LocalizedError(l("Invalid MCP tool setting."));
    if (!settingsManager.getMcpToolExposureScopes(ctx.folder.key).includes(msg.scope)) {
      throw new LocalizedError(l("This folder cannot save MCP tool settings at the {0} scope.", exposureScopeLabel(msg.scope)));
    }
    const server = (await ctx.session.getMcpServerStatus()).find((status) => status.name === msg.serverName);
    const tool = server?.tools?.find((candidate) => candidate.name === msg.toolName);
    if (!tool) throw new LocalizedError(l('MCP server "{0}" has no tool "{1}".', resourceLabel(undefined, msg.serverName), resourceLabel(undefined, msg.toolName)));
    const { layers, index, current } = exposureLayersAt(MCP_TOOL_EXPOSURE_SETTING, msg.scope, ctx);
    const next = toolExposureMapForScope(current, layers.slice(0, index), msg.serverName, msg.toolName, msg.exposure, tool.configExposure ?? "deferred");
    await platform.settings.update(MCP_TOOL_EXPOSURE_SETTING, next, msg.scope);
    const above = resolveToolExposure(layers.slice(index + 1), msg.serverName, msg.toolName, msg.exposure);
    if (above.source !== "config" && above.exposure !== msg.exposure) {
      postMessage(ctx.reply, {
        type: "notification",
        notificationType: "info",
        message: l(
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
    if (!isToolExposureSetting(msg.exposure) || !EXPOSURE_SCOPES.includes(msg.scope)) throw new LocalizedError(l("Invalid MCP resource setting."));
    if (!settingsManager.getMcpToolExposureScopes(ctx.folder.key).includes(msg.scope)) {
      throw new LocalizedError(l("This folder cannot save MCP resource settings at the {0} scope.", exposureScopeLabel(msg.scope)));
    }
    const server = (await ctx.session.getMcpServerStatus()).find((status) => status.name === msg.serverName);
    if (!server) throw new LocalizedError(l('MCP server "{0}" is not available in this folder.', resourceLabel(undefined, msg.serverName)));
    const { layers, index, current } = exposureLayersAt(MCP_RESOURCE_EXPOSURE_SETTING, msg.scope, ctx);
    const next = resourceExposureMapForScope(current, layers.slice(0, index), msg.serverName, msg.exposure, server.configResourceExposure ?? "deferred");
    await platform.settings.update(MCP_RESOURCE_EXPOSURE_SETTING, next, msg.scope);
    const above = resolveResourceExposure(layers.slice(index + 1), msg.serverName, msg.exposure);
    if (above.source !== "config" && above.exposure !== msg.exposure) {
      postMessage(ctx.reply, {
        type: "notification",
        notificationType: "info",
        message: l(
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
      postMessage(ctx.reply, { type: "mcpWriteResult", requestId, ok: true });
    } catch (err) {
      // The server NAME only: `msg.config` may carry an `env` or `headers` map, and this channel is
      // written to disk.
      log("[MessageRouter] Error %s MCP server %s: %s", what, serverName, err instanceof Error ? err.message : String(err));
      const error = err instanceof McpWriteError
        ? err.info
        : { code: "writeFailed" as const, params: { detail: err instanceof Error ? err.message : "Unknown error" } };
      postMessage(ctx.reply, { type: "mcpWriteResult", requestId, ok: false, error });
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
      postMessage(ctx.reply, { type: "hostCapabilities", capabilities: platform.capabilities });
      await settingsManager.sendCurrentSettings(ctx.reply, ctx.permissionHandler, ctx.folder);
      settingsManager.sendModelForPanel(ctx.reply, ctx.panelId);
      settingsManager.sendThinkingForPanel(ctx.reply, ctx.panelId, ctx.folder);
      deps.postWorkspaceFolderState(ctx.panelId);
      // PiSession judges project scope by its working folder, which is the panel's folder.
      postMessage(ctx.reply, { type: "projectTrust", trusted: platform.trust.isTrusted(ctx.folder.fsPath) });
      // Before the awaits below: the voice folder's size walk alone can take many seconds.
      postVoiceRuntimeStatus(deps, ctx.reply);
      ctx.session.publishAccountInfo();
      // The view mounts after main attached it, so host prompts redirected to it before then are posted again.
      if (ctx.view) deps.webviewPrompts.repost(ctx.panelId, ctx.view);
      deps.postSettingsFileAvailability?.(ctx);
      deps.postClaudeAuthState?.(ctx.reply);
      deps.postProviderSignInState?.(ctx.reply);
      postMessage(ctx.reply, await openaiAuthStatusMessage(platform));
      // Read together, each bounded, so one secret store read cannot hold the rest of the reply; posted in order, the judge last.
      const [keyStatuses, judgeStatus] = await Promise.all([
        Promise.all(ACCOUNT_PROVIDER_IDS.map((provider) => providerAuthStatus(platform, provider))),
        memoryJudgeStatus(platform).catch((err: unknown) => {
          log("[SettingsHandlers] reading the memory judge status failed: %s", err instanceof Error ? err.message : String(err));
          return undefined;
        }),
      ]);
      for (const status of keyStatuses) if (status) postMessage(ctx.reply, status);
      if (judgeStatus) postMessage(ctx.reply, judgeStatus);
      postMessage(ctx.reply, { type: "toolStatus", data: ctx.session.getToolStatus() });
      settingsManager.sendImageGenerationSettings(ctx.reply);
      await settingsManager.sendVoiceConfig(ctx.reply);
      await settingsManager.sendAvailableModels(ctx.session, ctx.reply);
      await settingsManager.sendMcpStatus(ctx.session, ctx.reply, ctx.folder.key);
      await postVoiceFilesSize(deps, ctx.reply);
    },

    setPinnedHeaderHidden: async (msg, ctx) => {
      if (msg.type !== "setPinnedHeaderHidden") return;
      try {
        await settingsManager.handleSetPinnedHeaderHidden(msg.hidden);
      } catch (err) {
        log("[MessageRouter] Error setting pinned header visibility:", err);
        postMessage(ctx.reply, {
          type: "notification",
          message: l("Failed to save pinned header setting: {0}", errorTextOf(err)),
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
        postMessage(ctx.reply, {
          type: "notification",
          message: l("Failed to save effort setting: {0}", errorTextOf(err)),
          notificationType: "error",
        });
      }
      settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId, ctx.folder);
    },

    setDefaultThinkingDisabled: async (msg, ctx) => {
      if (msg.type !== "setDefaultThinkingDisabled") return;
      const saved = await writeSetting(deps, ctx, "damocles.thinkingDisabled", (detail) => l("Failed to save default thinking setting: {0}", detail), () =>
        settingsManager.handleSetDefaultThinkingDisabled(msg.disabled, ctx.folder));
      if (!saved) settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId, ctx.folder);
    },

    setDefaultEffort: async (msg, ctx) => {
      if (msg.type !== "setDefaultEffort") return;
      const saved = await writeSetting(deps, ctx, "damocles.effortByModel", (detail) => l("Failed to save default effort: {0}", detail), () =>
        settingsManager.handleSetDefaultEffort(msg.effort, msg.model, ctx.folder));
      if (!saved) settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId, ctx.folder);
    },

    setTeamRoleModel: async (msg, ctx) => {
      if (msg.type !== "setTeamRoleModel") return;
      await writeSetting(deps, ctx, `damocles.team.${msg.role}Model`, (detail) => l("Failed to save team role model: {0}", detail), () =>
        settingsManager.handleSetTeamRoleModel(msg.role, msg.model, ctx.folder));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setTeamRoleEffort: async (msg, ctx) => {
      if (msg.type !== "setTeamRoleEffort") return;
      await writeSetting(deps, ctx, `damocles.team.${msg.role}Effort`, (detail) => l("Failed to save team role effort: {0}", detail), () =>
        settingsManager.handleSetTeamRoleEffort(msg.role, msg.effort, ctx.folder));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setBackgroundModel: async (msg, ctx) => {
      if (msg.type !== "setBackgroundModel") return;
      await writeSetting(deps, ctx, "damocles.background.model", (detail) => l("Failed to save the background model: {0}", detail), () =>
        settingsManager.handleSetBackgroundModel(msg.model));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setBackgroundEffort: async (msg, ctx) => {
      if (msg.type !== "setBackgroundEffort") return;
      await writeSetting(deps, ctx, "damocles.background.effort", (detail) => l("Failed to save the background effort: {0}", detail), () =>
        settingsManager.handleSetBackgroundEffort(msg.effort));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setMemoryJudge: async (msg, ctx) => {
      if (msg.type !== "setMemoryJudge") return;
      await writeSetting(deps, ctx, "damocles.memory.judge", (detail) => l("Failed to save the memory judge: {0}", detail), () =>
        settingsManager.handleSetMemoryJudge(msg.judge));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setMemoryJudgeEffort: async (msg, ctx) => {
      if (msg.type !== "setMemoryJudgeEffort") return;
      await writeSetting(deps, ctx, "damocles.memory.judgeEffort", (detail) => l("Failed to save the memory judge effort: {0}", detail), () =>
        settingsManager.handleSetMemoryJudgeEffort(msg.effort));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setBudgetLimit: async (msg, ctx) => {
      if (msg.type !== "setBudgetLimit") return;
      const saved = await writeSetting(deps, ctx, "damocles.maxBudgetUsd", (detail) => l("Failed to save budget limit: {0}", detail), () =>
        settingsManager.handleSetBudgetLimit(msg.budgetUsd, ctx.folder));
      if (!saved) await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setTaskBudget: async (msg, ctx) => {
      if (msg.type !== "setTaskBudget") return;
      await writeSetting(deps, ctx, "damocles.taskBudget", (detail) => l("Failed to save task budget: {0}", detail), () =>
        settingsManager.handleSetTaskBudget(msg.budget, ctx.folder));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setAutoCompact: async (msg, ctx) => {
      if (msg.type !== "setAutoCompact") return;
      await writeSetting(deps, ctx, "damocles.autoCompact", (detail) => l("Failed to save auto-compact settings: {0}", detail), () =>
        settingsManager.handleSetAutoCompact(msg.config, ctx.folder));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setSubagentsMaxConcurrent: async (msg, ctx) => {
      if (msg.type !== "setSubagentsMaxConcurrent") return;
      await writeSetting(deps, ctx, "damocles.subagents.maxConcurrent", (detail) => l("Failed to save the subagent limit: {0}", detail), () =>
        settingsManager.handleSetSubagentsMaxConcurrent(msg.count, ctx.folder));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setShowCacheMissNotices: async (msg, ctx) => {
      if (msg.type !== "setShowCacheMissNotices") return;
      await writeSetting(deps, ctx, "damocles.showCacheMissNotices", (detail) => l("Failed to save the cost notice setting: {0}", detail), () =>
        settingsManager.handleSetShowCacheMissNotices(msg.enabled, ctx.folder));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setShowThinkingDroppedNotices: async (msg, ctx) => {
      if (msg.type !== "setShowThinkingDroppedNotices") return;
      await writeSetting(deps, ctx, "damocles.showThinkingDroppedNotices", (detail) => l("Failed to save the dropped thinking notice setting: {0}", detail), () =>
        settingsManager.handleSetShowThinkingDroppedNotices(msg.enabled, ctx.folder));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setAssetSourcePrecedence: async (msg, ctx) => {
      if (msg.type !== "setAssetSourcePrecedence") return;
      await writeSetting(deps, ctx, "damocles.assetSourcePrecedence", (detail) => l("Failed to save the skill and command source setting: {0}", detail), () =>
        settingsManager.handleSetAssetSourcePrecedence(msg.precedence));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setMemoryAutoExtract: async (msg, ctx) => {
      if (msg.type !== "setMemoryAutoExtract") return;
      await writeSetting(deps, ctx, "damocles.memory.autoExtract.enabled", (detail) => l("Failed to save the memory extraction setting: {0}", detail), () =>
        settingsManager.handleSetMemoryAutoExtract(msg.enabled));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setMemoryProfile: async (msg, ctx) => {
      if (msg.type !== "setMemoryProfile") return;
      await writeSetting(deps, ctx, "damocles.memory.profile.enabled", (detail) => l("Failed to save the user profile setting: {0}", detail), () =>
        settingsManager.handleSetMemoryProfile(msg.enabled));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setBrowserHeadless: async (msg, ctx) => {
      if (msg.type !== "setBrowserHeadless") return;
      await writeSetting(deps, ctx, "damocles.browser.headless", (detail) => l("Failed to save the headless browser setting: {0}", detail), () =>
        settingsManager.handleSetBrowserHeadless(msg.headless));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setModelPickerProvider: async (msg, ctx) => {
      if (msg.type !== "setModelPickerProvider") return;
      // Both hosts' settings stores fire the change before the write resolves, so ChatPanelProvider's listener, the setting's one
      // publisher, has published every panel before this ack ends the switch's pending state.
      const saved = await writeSetting(deps, ctx, MODEL_PICKER_SETTING, (detail) => l("Failed to save the model picker setting: {0}", detail), () =>
        settingsManager.handleSetModelPickerProvider(msg.provider, msg.shown));
      postMessage(ctx.reply, { type: "setModelPickerProviderAck", provider: msg.provider, requestId: msg.requestId, ok: saved });
    },

    setCacheWarming: async (msg, ctx) => {
      if (msg.type !== "setCacheWarming") return;
      await writeSetting(deps, ctx, "damocles.cacheWarming", (detail) => l("Failed to save cache warming setting: {0}", detail), () =>
        settingsManager.handleSetCacheWarming(parseCacheWarmingMode(msg.mode)));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setCheckpointRetentionDays: async (msg, ctx) => {
      if (msg.type !== "setCheckpointRetentionDays") return;
      await writeSetting(deps, ctx, "damocles.checkpoints.retentionDays", (detail) => l("Failed to save checkpoint retention: {0}", detail), () =>
        settingsManager.handleSetCheckpointRetentionDays(msg.days));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setPermissionMode: async (msg, ctx) => {
      if (msg.type !== "setPermissionMode") return;
      if (!PERMISSION_MODES.includes(msg.mode)) {
        refuseMode(ctx, String(msg.mode), "unknown-mode");
        return;
      }
      await settingsManager.handleSetPermissionMode(ctx.session, ctx.permissionHandler, msg.mode);
      // The chat's own composer and an attached settings view both show the mode from this.
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setDefaultPermissionMode: async (msg, ctx) => {
      if (msg.type !== "setDefaultPermissionMode") return;
      if (!PERMISSION_MODES.includes(msg.mode)) {
        refuseMode(ctx, String(msg.mode), "unknown-mode");
        return;
      }
      const saved = await writeSetting(deps, ctx, "damocles.permissionMode", (detail) => l("Failed to save default permission mode: {0}", detail), () =>
        settingsManager.handleSetDefaultPermissionMode(msg.mode, ctx.folder));
      if (!saved) await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setDangerouslySkipPermissions: async (msg, ctx) => {
      if (msg.type !== "setDangerouslySkipPermissions") return;
      if (!settingsManager.handleSetDangerouslySkipPermissions(ctx.permissionHandler, msg.enabled === true)) refuseMode(ctx, "dangerouslySkipPermissions", "remote-host");
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setDefaultDangerouslySkipPermissions: async (msg, ctx) => {
      if (msg.type !== "setDefaultDangerouslySkipPermissions") return;
      // a daemon's core never takes the default while its client's policy refuses YOLO; the row says why
      if (msg.enabled && !bypassAllowed(deps.platform)) {
        refuseMode(ctx, "dangerouslySkipPermissions", "remote-host");
        postMessage(ctx.reply, { type: "settingWriteResult", key: "damocles.dangerouslySkipPermissions", ok: false, error: l("YOLO is off for your turns on this host.") });
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
        return;
      }
      const saved = await writeSetting(deps, ctx, "damocles.dangerouslySkipPermissions", (detail) => l("Failed to save default YOLO mode: {0}", detail), () =>
        settingsManager.handleSetDefaultDangerouslySkipPermissions(msg.enabled, ctx.folder));
      if (!saved) await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setIdeContextEnabled: async (msg, ctx) => {
      if (msg.type !== "setIdeContextEnabled") return;
      const saved = await writeSetting(deps, ctx, "damocles.ideContext.enabled", (detail) => l("Failed to save IDE context setting: {0}", detail), () =>
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
        postMessage(ctx.reply, {
          type: "notification",
          message: l("Failed to save MCP server setting: {0}", errorTextOf(err)),
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
        postMessage(ctx.reply, {
          type: "notification",
          message: l("Failed to reconnect MCP server"),
          notificationType: "error",
        });
      }
    },

    authenticateMcpServer: async (msg, ctx) => {
      if (msg.type !== "authenticateMcpServer") return;
      const success = await ctx.session.reconnectMcpServerLive(msg.serverName);
      await settingsManager.sendMcpStatus(ctx.session, ctx.host, ctx.folder.key);
      if (!success) {
        postMessage(ctx.reply, {
          type: "notification",
          message: l("Failed to authenticate MCP server"),
          notificationType: "error",
        });
      }
    },

    reauthenticateMcpServer: async (msg, ctx) => {
      if (msg.type !== "reauthenticateMcpServer") return;
      try {
        const success = await ctx.session.reauthenticateMcpServerLive(msg.serverName);
        if (!success) {
          postMessage(ctx.reply, {
            type: "notification",
            message: l("Failed to re-authenticate MCP server"),
            notificationType: "error",
          });
        }
      } catch (err) {
        log("[MessageRouter] Error re-authenticating MCP server:", err);
        postMessage(ctx.reply, {
          type: "notification",
          message: l("Failed to re-authenticate MCP server: {0}", errorTextOf(err)),
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
        postMessage(ctx.reply, {
          type: "notification",
          message: l("Failed to sign out of MCP server: {0}", errorTextOf(err)),
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
      await settingsManager.sendMcpStatus(ctx.session, ctx.reply, ctx.folder.key);
    },

    setMcpEnabled: async (msg, ctx) => {
      if (msg.type !== "setMcpEnabled") return;
      const saved = await writeSetting(deps, ctx, "damocles.mcp.enabled", (detail) => l("Failed to save MCP setting: {0}", detail), () =>
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
        postMessage(ctx.reply, {
          type: "notification",
          message: l("Failed to save MCP tool setting: {0}", errorTextOf(err)),
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
        postMessage(ctx.reply, {
          type: "notification",
          message: l("Failed to save MCP resource setting: {0}", errorTextOf(err)),
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
        postMessage(ctx.reply, { type: "mcpResources", requestId: msg.requestId, ...fields });
      const cursor = pageCursor(msg.cursor);
      if (!isName(msg.serverName) || cursor === null) {
        reply({ resources: [], error: l("This MCP request is not valid.") });
        return;
      }
      try {
        const page = await requireUserResources(ctx).listResourcesPage(msg.serverName, cursor);
        const filter = await ctx.permissionHandler.mcpResourceRuleFilter(READ_MCP_RESOURCE);
        reply({ resources: resourceRows(page.resources, msg.serverName, filter), ...cursorOf(page.nextCursor) });
      } catch (err) {
        reply({ resources: [], error: l("Could not list the resources of {0}: {1}", resourceLabel(undefined, msg.serverName), errorText(err)) });
      }
    },

    requestMcpResourceTemplates: async (msg, ctx) => {
      if (msg.type !== "requestMcpResourceTemplates" || !isRequestId(msg.requestId)) return;
      const reply = (fields: Omit<Extract<ExtensionToWebviewMessage, { type: "mcpResourceTemplates" }>, "type" | "requestId">) =>
        postMessage(ctx.reply, { type: "mcpResourceTemplates", requestId: msg.requestId, ...fields });
      const cursor = pageCursor(msg.cursor);
      if (!isName(msg.serverName) || cursor === null) {
        reply({ templates: [], error: l("This MCP request is not valid.") });
        return;
      }
      try {
        const page = await requireUserResources(ctx).listResourceTemplatesPage(msg.serverName, cursor);
        reply({ templates: templateRows(page.resourceTemplates), ...cursorOf(page.nextCursor) });
      } catch (err) {
        reply({ templates: [], error: l("Could not list the resource templates of {0}: {1}", resourceLabel(undefined, msg.serverName), errorText(err)) });
      }
    },

    // A directory a deny rule covers still opens: the listing goes to the user, never to the model (D13).
    requestMcpResourceChildren: async (msg, ctx) => {
      if (msg.type !== "requestMcpResourceChildren" || !isRequestId(msg.requestId)) return;
      const reply = (fields: Omit<Extract<ExtensionToWebviewMessage, { type: "mcpResourceChildren" }>, "type" | "requestId">) =>
        postMessage(ctx.reply, { type: "mcpResourceChildren", requestId: msg.requestId, ...fields });
      if (!isName(msg.serverName) || !isName(msg.uri)) {
        reply({ children: [], error: l("This MCP request is not valid.") });
        return;
      }
      try {
        const result = await requireUserResources(ctx).readResource(msg.serverName, msg.uri);
        const filter = await ctx.permissionHandler.mcpResourceRuleFilter(READ_MCP_RESOURCE);
        const children = directoryChildren(msg.uri, result, msg.serverName, filter);
        reply(children ? { children } : { children: [], notDirectory: true });
      } catch (err) {
        reply({ children: [], error: l("Could not open {0}: {1}", resourceLabel(undefined, msg.uri), errorText(err)) });
      }
    },

    requestMcpResourceCompletion: async (msg, ctx) => {
      if (msg.type !== "requestMcpResourceCompletion" || !isRequestId(msg.requestId)) return;
      const reply = (values: string[]) => postMessage(ctx.reply, { type: "mcpResourceCompletion", requestId: msg.requestId, values });
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
        log("[MessageRouter] MCP completion for %s failed: %s", msg.serverName, englishText(errorText(err)));
        reply([]);
      }
    },

    /** Holds the resource by reference (D12); a deny rule that covers it refuses the attach (D13), and nothing is read now. */
    attachMcpResource: async (msg, ctx) => {
      if (msg.type !== "attachMcpResource" || !isRequestId(msg.requestId)) return;
      const refuse = (refused: LocalizedText) => postMessage(ctx.reply, { type: "mcpResourceAttached", requestId: msg.requestId, refused });
      if (!isName(msg.serverName) || !isName(msg.uri)) {
        refuse(l("This resource cannot be attached."));
        return;
      }
      const name = resourceLabel(msg.name, msg.uri);
      const mimeType = mimeTypeOf(msg.mimeType);
      if (isMcpAppResource({ uri: msg.uri, mimeType: msg.mimeType })) {
        refuse(l("{0} is an MCP App interface, which cannot be sent to the model.", name));
        return;
      }
      // Only a directory MIME type refuses: a URI ending in `/` may be a file, which Open reports and the read at send decides.
      if (isDirectoryMimeType(mimeType)) {
        refuse(l("{0} is a directory. Open it and attach a resource inside it.", name));
        return;
      }
      if (isBinaryMimeType(mimeType)) {
        refuse(l("{0} is binary content ({1}), which cannot be sent to the model.", name, mimeType ?? ""));
        return;
      }
      const serverId = ctx.session.mcpUserResources()?.serverIdOf(msg.serverName);
      if (serverId === undefined) {
        refuse(l("MCP server {0} is not available in this chat.", resourceLabel(undefined, msg.serverName)));
        return;
      }
      const rule = (await ctx.permissionHandler.mcpResourceRuleFilter(READ_MCP_RESOURCE)).resourceDenyRule(msg.serverName, msg.uri);
      if (rule !== undefined) {
        refuse(l("A deny rule covers this resource: {0}", rule));
        return;
      }
      // Checked after the last await: `add` past the bound drops the oldest chip, and a chip may have arrived meanwhile.
      if (ctx.terminalAttachments.displayInfo().length >= MAX_PENDING_TERMINAL_ATTACHMENTS) {
        refuse(l("A message holds at most {0} attachments. Remove one to attach another.", MAX_PENDING_TERMINAL_ATTACHMENTS));
        return;
      }
      ctx.terminalAttachments.add({ kind: "mcpResource", server: msg.serverName, uri: msg.uri, name, ...(mimeType !== undefined ? { mimeType } : {}), serverId });
      postMessage(ctx.reply, { type: "mcpResourceAttached", requestId: msg.requestId });
    },

    requestSupportedCommands: async (_msg, ctx) => {
      await settingsManager.sendSupportedCommands(ctx.session, ctx.reply);
    },

    toggleTool: async (msg, ctx) => {
      if (msg.type !== "toggleTool") return;
      try {
        await settingsManager.setToolDisabled(msg.toolName, !msg.enabled);
        ctx.session.refreshActiveTools();
      } catch (err) {
        log("[MessageRouter] Error toggling tool:", err);
        postMessage(ctx.reply, {
          type: "notification",
          message: l("Failed to save tool setting: {0}", errorTextOf(err)),
          notificationType: "error",
        });
      }
      settingsManager.sendToolStatus(ctx.session, ctx.host);
    },

    toggleToolGroup: async (msg, ctx) => {
      if (msg.type !== "toggleToolGroup") return;
      const group = msg.group;
      if (!isSwitchableToolGroup(group)) throw new Error(`The ${String(group)} tool group has no switch`);
      const saved = await writeSetting(deps, ctx, TOOL_GROUP_SETTINGS[group], (detail) => l("Failed to save tool group setting: {0}", detail), () =>
        settingsManager.setToolGroupEnabled(group, msg.enabled));
      if (saved) ctx.session.refreshActiveTools();
      if (msg.group === "image") broadcastImageGenerationState(deps);
      else settingsManager.sendToolStatus(ctx.session, ctx.host);
    },

    requestToolStatus: (_msg, ctx) => {
      postMessage(ctx.reply, { type: "toolStatus", data: ctx.session.getToolStatus() });
    },

    setImageGenerationEnabled: async (msg, ctx) => {
      if (msg.type !== "setImageGenerationEnabled") return;
      await writeSetting(deps, ctx, IMAGE_ENABLED_SETTING, (detail) => l("Failed to save image generation setting: {0}", detail), () =>
        settingsManager.setImageGenerationEnabled(msg.enabled));
      broadcastImageGenerationState(deps);
    },

    setImageGenerationModel: async (msg, ctx) => {
      if (msg.type !== "setImageGenerationModel") return;
      await writeSetting(deps, ctx, IMAGE_MODEL_SETTING, (detail) => l("Failed to save image generation setting: {0}", detail), () =>
        settingsManager.setImageGenerationModel(msg.model));
      broadcastImageGenerationState(deps);
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
      await writeSetting(deps, ctx, "damocles.explore.model", (detail) => l("Failed to save the Explore model: {0}", detail), () =>
        settingsManager.setExploreModel(msg.model));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    setExploreEffort: async (msg, ctx) => {
      if (msg.type !== "setExploreEffort") return;
      await writeSetting(deps, ctx, "damocles.explore.effort", (detail) => l("Failed to save the Explore effort: {0}", detail), () =>
        settingsManager.setExploreEffort(msg.effort));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
    },

    // Posts no providerAuthStatusChanged: the custom-provider sync it runs republishes every key status.
    setProviderPreferApiKey: async (msg, ctx) => {
      if (msg.type !== "setProviderPreferApiKey") return;
      const { provider, requestId } = msg;
      if (!isKeyProviderId(provider)) throw new Error("Unknown key provider");
      if (typeof msg.preferApiKey !== "boolean") throw new Error("Malformed preference");
      if (platform.remote) {
        postMessage(ctx.reply, { type: "setProviderPreferApiKeyAck", provider, requestId, ok: false, error: remoteSignInRefusal() });
        return;
      }
      try {
        await setProviderPreferApiKey(provider, msg.preferApiKey);
        postMessage(ctx.reply, { type: "setProviderPreferApiKeyAck", provider, requestId, ok: true });
        // the toggle switches the credential pi sends, so the refusal the card names no longer applies
        for (const [, instance] of getPanels()) postMessage(instance.host, { type: "authFailureCleared", account: provider });
      } catch (err) {
        log("[SettingsHandlers] Failed to apply the %s API key preference:", provider, err);
        postMessage(ctx.reply, { type: "setProviderPreferApiKeyAck", provider, requestId, ok: false, error: l("Failed to apply the preference") });
      }
    },

  };
}
