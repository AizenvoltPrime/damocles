import type { Platform } from "../../../../platform/platform";
import type { SettingsFolder, SettingsStore } from "../../../../platform/settings-store";
import type { ChatSession } from "../../../chat-session";
import type { PermissionHandler } from "../../../permission-handler";
import type { PanelHost } from "../../../../platform/window-service";
import type { ExtensionSettings, PermissionMode, AutoCompactConfig, CacheWarmingMode, EffortLevel, TeamRoleSettings } from "../../../../shared/types/settings";
import type { PostMessageFn } from "../types";
import { updateConfigAtEffectiveScope, assertEffortSupported, coerceEffortForModel, type SettingWrite } from "../utils";
import { migrateLegacyModelValue, migrateLegacyEffortValue, parseEffortLevel, parseCacheWarmingMode, DEFAULT_MODELS, DEFAULT_FALLBACK_MODEL } from "../../../../shared/types/constants";
import type { TeamRole } from "../../../pi-session/team-model-resolution";
import type { SettingSource } from "../../../../shared/types/messages";
import { readContributedConfiguration } from "../../../config/contributed-configuration";
import { CHAT_SETTING_KEYS } from "../../../config/chat-settings";
import { t } from "../../../l10n";

// A hundred years; the bound keeps a typed number from overflowing the retention arithmetic.
const MAX_RETENTION_DAYS = 36500;

export class ConfigManager {
  private readonly postMessage: PostMessageFn;
  private readonly platform: Platform;

  constructor(postMessage: PostMessageFn, platform: Platform) {
    this.postMessage = postMessage;
    this.platform = platform;
  }

  /**
   * The model an unset team role slot validates its effort against: the workspace default model, or
   * `DEFAULT_FALLBACK_MODEL` when that is empty (fresh install). This mirrors the runtime resolver, which
   * fails soft to the active panel model (ultimately the default) — so validating against `''` (which
   * has no `supportedEffortLevels` and makes `assertEffortSupported` throw) is never correct.
   */
  private workspaceFallbackModel(config: SettingsStore): string {
    return migrateLegacyModelValue(config.get<string>("damocles.model", "")) || DEFAULT_FALLBACK_MODEL;
  }

  /** A folder's settings files are written only while it is trusted (D38); a chat with no folder writes user settings. */
  private workspaceWritable(folder: SettingsFolder | undefined): boolean {
    return folder === undefined || this.platform.trust.isTrusted(folder.personalPath ?? folder.path);
  }

  // Workspace section (D37): saved for the chat's folder in its personal file; a chat with no folder saves to user settings.
  private workspaceScope(folder: SettingsFolder | undefined): { home: "local" | "user"; folder: SettingsFolder | undefined } {
    if (!this.workspaceWritable(folder)) throw new Error(t("This folder is not trusted, so its workspace settings cannot be saved. Trust the folder to save them."));
    return { home: folder === undefined ? "user" : "local", folder };
  }

  /** `folder` is the panel's: its per-chat keys and their sources are read for that folder (D38). */
  async sendCurrentSettings(
    host: PanelHost,
    permissionHandler: PermissionHandler,
    folder: SettingsFolder | undefined,
  ): Promise<void> {
    const config = this.platform.settings;

    const defaultAutoCompact: AutoCompactConfig = {
      enabled: false,
      triggerPercent: 80,
    };

    // Team role overrides: for each role read the stored model + effort and coerce
    // the effort against the role's EFFECTIVE model (its own model if set, else the
    // workspace fallback model) so the panel never renders an invalid stored pair.
    const fallbackModel = this.workspaceFallbackModel(config);
    const teamRoles: TeamRole[] = ['lead', 'implementor', 'reviewer'];
    const teamModels = {} as Record<TeamRole, string>;
    const teamEfforts = {} as Record<TeamRole, EffortLevel | null>;
    for (const role of teamRoles) {
      const model = migrateLegacyModelValue(config.get<string>(`damocles.team.${role}Model`, "", folder));
      const parsed = parseEffortLevel(config.get<string>(`damocles.team.${role}Effort`, "", folder));
      const effectiveModel = model !== "" ? model : fallbackModel;
      // Apply the model's pi-metadata effort rename before coercing so a renamed level (e.g. DeepSeek
      // xhigh → max) migrates rather than dropping to null (parity with the runtime resolver).
      const storedEffort = parsed === null ? null : migrateLegacyEffortValue(effectiveModel, parsed);
      teamModels[role] = model;
      teamEfforts[role] = coerceEffortForModel(effectiveModel, storedEffort);
    }
    const team: TeamRoleSettings = {
      leadModel: teamModels.lead,
      leadEffort: teamEfforts.lead,
      implementorModel: teamModels.implementor,
      implementorEffort: teamEfforts.implementor,
      reviewerModel: teamModels.reviewer,
      reviewerEffort: teamEfforts.reviewer,
    };

    const settings: ExtensionSettings = {
      maxTurns: config.get<number>("damocles.maxTurns", 100),
      maxBudgetUsd: config.get<number | null>("damocles.maxBudgetUsd", null, folder),
      taskBudget: config.get<number | null>("damocles.taskBudget", null, folder),
      permissionMode: permissionHandler.getPermissionMode(),
      defaultPermissionMode: config.get<PermissionMode>("damocles.permissionMode", "default", folder),
      enableFileCheckpointing: config.get<boolean>("damocles.enableFileCheckpointing", true),
      sandbox: config.get<{ enabled: boolean }>("damocles.sandbox", { enabled: false }),
      autoCompact: config.get<AutoCompactConfig>("damocles.autoCompact", defaultAutoCompact, folder),
      cacheWarming: parseCacheWarmingMode(config.get("damocles.cacheWarming")),
      checkpointRetentionDays: config.get<number>("damocles.checkpoints.retentionDays", 30),
      dangerouslySkipPermissions: permissionHandler.getDangerouslySkipPermissions(),
      defaultDangerouslySkipPermissions: config.get<boolean>("damocles.dangerouslySkipPermissions", false, folder),
      ideContextEnabled: config.get<boolean>("damocles.ideContext.enabled", true),
      pinnedHeaderHidden: config.get<boolean>("damocles.pinnedHeaderHidden", false),
      team,
    };
    this.postMessage(host, {
      type: "settingsUpdate",
      settings,
      workspaceWritable: this.workspaceWritable(folder),
      ...(this.platform.capabilities.settingsSources ? { settingSources: this.settingSources(folder) } : {}),
    });
  }

  /** Every contributed key whose effective value comes from a project or local file, with that file and its value; per-chat keys for the chat's folder. */
  private settingSources(folder: SettingsFolder | undefined): Record<string, SettingSource> {
    const config = this.platform.settings;
    const sources: Record<string, SettingSource> = {};
    for (const key of readContributedConfiguration(this.platform.paths.resourceRoot).keys) {
      const keyFolder = CHAT_SETTING_KEYS.has(key) ? folder : undefined;
      const inspection = config.inspect(key, keyFolder);
      const scope = "localValue" in inspection ? "local" : "projectValue" in inspection ? "project" : undefined;
      if (scope === undefined) continue;
      const path = config.scopeFile(scope, keyFolder);
      if (path === undefined) throw new Error(`The settings store reported a ${scope} value for ${key} but no ${scope} file`);
      sources[key] = { scope, path, value: scope === "local" ? inspection.localValue : inspection.projectValue };
    }
    return sources;
  }

  async sendAvailableModels(session: ChatSession, host: PanelHost): Promise<void> {
    const models = await session.getSupportedModels();
    if (models && models.length > 0) {
      this.postMessage(host, { type: "availableModels", models });
    }
  }

  async sendSupportedCommands(session: ChatSession, host: PanelHost): Promise<void> {
    const commands = await session.getSupportedCommands();
    if (commands) {
      this.postMessage(host, { type: "supportedCommands", commands });
    }
  }

  async handleSetDefaultMaxThinkingTokens(tokens: number | null, folder: SettingsFolder | undefined): Promise<SettingWrite> {
    return updateConfigAtEffectiveScope(this.platform, "damocles.maxThinkingTokens", tokens, { folder });
  }

  async handleSetDefaultThinkingDisabled(disabled: boolean, folder: SettingsFolder | undefined): Promise<SettingWrite> {
    return updateConfigAtEffectiveScope(this.platform, "damocles.thinkingDisabled", disabled, { folder });
  }

  async handleSetPinnedHeaderHidden(hidden: boolean): Promise<void> {
    await this.platform.settings.update("damocles.pinnedHeaderHidden", hidden, "user");
  }

  async handleSetDefaultEffort(effort: EffortLevel | null, model: string, folder: SettingsFolder | undefined): Promise<SettingWrite> {
    assertEffortSupported(model, effort);
    const config = this.platform.settings;
    const current = config.get<Record<string, EffortLevel | null>>("damocles.effortByModel", {}, folder) ?? {};
    const next: Record<string, EffortLevel | null> = { ...current };
    if (effort === null) {
      delete next[model];
    } else {
      next[model] = effort;
    }
    return updateConfigAtEffectiveScope(this.platform, "damocles.effortByModel", next, { folder });
  }

  async handleSetTeamRoleModel(role: TeamRole, model: string, folder: SettingsFolder | undefined): Promise<SettingWrite> {
    if (model !== '' && !DEFAULT_MODELS.some(m => m.value === model)) {
      throw new Error(`Model "${model}" is not a known model`);
    }
    const written = await updateConfigAtEffectiveScope(this.platform, `damocles.team.${role}Model`, model, { folder });

    // Reconcile the sibling effort: if the newly-selected model no longer supports
    // the stored effort, clear it so the persisted pair stays valid.
    const config = this.platform.settings;
    const storedEffort = parseEffortLevel(config.get<string>(`damocles.team.${role}Effort`, "", folder));
    const effectiveModel = model !== "" ? model : this.workspaceFallbackModel(config);
    if (storedEffort !== null && coerceEffortForModel(effectiveModel, storedEffort) === null) {
      await updateConfigAtEffectiveScope(this.platform, `damocles.team.${role}Effort`, "", { folder });
    }
    return written;
  }

  async handleSetTeamRoleEffort(role: TeamRole, effort: EffortLevel | null, folder: SettingsFolder | undefined): Promise<SettingWrite> {
    const config = this.platform.settings;
    const roleModel = migrateLegacyModelValue(config.get<string>(`damocles.team.${role}Model`, "", folder));
    const effectiveModel = roleModel !== "" ? roleModel : this.workspaceFallbackModel(config);
    assertEffortSupported(effectiveModel, effort);
    return updateConfigAtEffectiveScope(this.platform, `damocles.team.${role}Effort`, effort === null ? "" : effort, { folder });
  }

  async handleSetBudgetLimit(budgetUsd: number | null, folder: SettingsFolder | undefined): Promise<SettingWrite> {
    return updateConfigAtEffectiveScope(this.platform, "damocles.maxBudgetUsd", budgetUsd, this.workspaceScope(folder));
  }

  async handleSetTaskBudget(budget: number | null, folder: SettingsFolder | undefined): Promise<SettingWrite> {
    return updateConfigAtEffectiveScope(this.platform, "damocles.taskBudget", budget, this.workspaceScope(folder));
  }

  async handleSetAutoCompact(config: AutoCompactConfig, folder: SettingsFolder | undefined): Promise<SettingWrite> {
    return updateConfigAtEffectiveScope(this.platform, "damocles.autoCompact", config, this.workspaceScope(folder));
  }

  async handleSetCheckpointRetentionDays(days: number): Promise<SettingWrite> {
    if (!Number.isInteger(days) || days < 0 || days > MAX_RETENTION_DAYS) {
      throw new Error(`Checkpoint retention must be a whole number of days from 0 to ${MAX_RETENTION_DAYS}`);
    }
    return updateConfigAtEffectiveScope(this.platform, "damocles.checkpoints.retentionDays", days);
  }

  /** Warming spends money, so the mode is user-level only and never follows the effective scope: a repo's
   *  `.vscode/settings.json` must not be able to turn billed background requests on. */
  async handleSetCacheWarming(mode: CacheWarmingMode): Promise<SettingWrite> {
    await this.platform.settings.update("damocles.cacheWarming", mode, "user");
    return { key: "damocles.cacheWarming", home: "user" };
  }

  async handleSetPermissionMode(
    session: ChatSession,
    permissionHandler: PermissionHandler,
    mode: PermissionMode
  ): Promise<void> {
    permissionHandler.setPermissionMode(mode);
    await session.setPermissionMode(mode);
  }

  async handleSetDefaultPermissionMode(mode: PermissionMode, folder: SettingsFolder | undefined): Promise<SettingWrite> {
    return updateConfigAtEffectiveScope(this.platform, "damocles.permissionMode", mode, { folder });
  }

  async handleSetDefaultDangerouslySkipPermissions(enabled: boolean, folder: SettingsFolder | undefined): Promise<SettingWrite> {
    return updateConfigAtEffectiveScope(this.platform, "damocles.dangerouslySkipPermissions", enabled, { folder });
  }

  async handleSetIdeContextEnabled(enabled: boolean): Promise<SettingWrite> {
    return updateConfigAtEffectiveScope(this.platform, "damocles.ideContext.enabled", enabled);
  }

  handleSetDangerouslySkipPermissions(permissionHandler: PermissionHandler, enabled: boolean): void {
    permissionHandler.setDangerouslySkipPermissions(enabled);
  }
}
