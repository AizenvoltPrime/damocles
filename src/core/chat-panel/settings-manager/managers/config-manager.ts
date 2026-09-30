import type { Platform } from "../../../../platform/platform";
import type { SettingsStore } from "../../../../platform/settings-store";
import type { ChatSession } from "../../../chat-session";
import type { PermissionHandler } from "../../../permission-handler";
import type { PanelHost } from "../../../../platform/window-service";
import type { ExtensionSettings, PermissionMode, AutoCompactConfig, CacheWarmingMode, EffortLevel, TeamRoleSettings } from "../../../../shared/types/settings";
import type { PostMessageFn } from "../types";
import { updateConfigAtEffectiveScope, assertEffortSupported, coerceEffortForModel } from "../utils";
import { migrateLegacyModelValue, migrateLegacyEffortValue, parseEffortLevel, parseCacheWarmingMode, DEFAULT_MODELS, DEFAULT_FALLBACK_MODEL } from "../../../../shared/types/constants";
import type { TeamRole } from "../../../pi-session/team-model-resolution";
import type { SettingSource } from "../../../../shared/types/messages";
import { readContributedConfiguration } from "../../../config/contributed-configuration";

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

  async sendCurrentSettings(
    host: PanelHost,
    permissionHandler: PermissionHandler,
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
      const model = migrateLegacyModelValue(config.get<string>(`damocles.team.${role}Model`, ""));
      const parsed = parseEffortLevel(config.get<string>(`damocles.team.${role}Effort`, ""));
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
      maxBudgetUsd: config.get<number | null>("damocles.maxBudgetUsd", null),
      taskBudget: config.get<number | null>("damocles.taskBudget", null),
      permissionMode: permissionHandler.getPermissionMode(),
      defaultPermissionMode: config.get<PermissionMode>("damocles.permissionMode", "default"),
      enableFileCheckpointing: config.get<boolean>("damocles.enableFileCheckpointing", true),
      sandbox: config.get<{ enabled: boolean }>("damocles.sandbox", { enabled: false }),
      autoCompact: config.get<AutoCompactConfig>("damocles.autoCompact", defaultAutoCompact),
      cacheWarming: parseCacheWarmingMode(config.get("damocles.cacheWarming")),
      dangerouslySkipPermissions: permissionHandler.getDangerouslySkipPermissions(),
      defaultDangerouslySkipPermissions: config.get<boolean>("damocles.dangerouslySkipPermissions", false),
      ideContextEnabled: config.get<boolean>("damocles.ideContext.enabled", true),
      pinnedHeaderHidden: config.get<boolean>("damocles.pinnedHeaderHidden", false),
      team,
    };
    this.postMessage(host, {
      type: "settingsUpdate",
      settings,
      ...(this.platform.capabilities.settingsSources ? { settingSources: this.settingSources() } : {}),
    });
  }

  /** Every contributed key whose effective value comes from a project or local file, with that file. */
  private settingSources(): Record<string, SettingSource> {
    const config = this.platform.settings;
    const sources: Record<string, SettingSource> = {};
    for (const key of readContributedConfiguration(this.platform.paths.resourceRoot).keys) {
      const inspection = config.inspect(key);
      const scope = "localValue" in inspection ? "local" : "projectValue" in inspection ? "project" : undefined;
      if (scope === undefined) continue;
      const path = config.scopeFile(scope);
      if (path === undefined) throw new Error(`The settings store reported a ${scope} value for ${key} but no ${scope} file`);
      sources[key] = { scope, path };
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

  async handleSetDefaultMaxThinkingTokens(tokens: number | null): Promise<void> {
    await updateConfigAtEffectiveScope(this.platform, "damocles", "maxThinkingTokens", tokens);
  }

  async handleSetDefaultThinkingDisabled(disabled: boolean): Promise<void> {
    await updateConfigAtEffectiveScope(this.platform, "damocles", "thinkingDisabled", disabled);
  }

  async handleSetPinnedHeaderHidden(hidden: boolean): Promise<void> {
    await this.platform.settings.update("damocles.pinnedHeaderHidden", hidden, "user");
  }

  async handleSetDefaultEffort(effort: EffortLevel | null, model: string): Promise<void> {
    assertEffortSupported(model, effort);
    const config = this.platform.settings;
    const current = config.get<Record<string, EffortLevel | null>>("damocles.effortByModel", {}) ?? {};
    const next: Record<string, EffortLevel | null> = { ...current };
    if (effort === null) {
      delete next[model];
    } else {
      next[model] = effort;
    }
    await updateConfigAtEffectiveScope(this.platform, "damocles", "effortByModel", next);
  }

  async handleSetTeamRoleModel(role: TeamRole, model: string): Promise<void> {
    if (model !== '' && !DEFAULT_MODELS.some(m => m.value === model)) {
      throw new Error(`Model "${model}" is not a known model`);
    }
    await updateConfigAtEffectiveScope(this.platform, "damocles", `team.${role}Model`, model);

    // Reconcile the sibling effort: if the newly-selected model no longer supports
    // the stored effort, clear it so the persisted pair stays valid.
    const config = this.platform.settings;
    const storedEffort = parseEffortLevel(config.get<string>(`damocles.team.${role}Effort`, ""));
    const effectiveModel = model !== "" ? model : this.workspaceFallbackModel(config);
    if (storedEffort !== null && coerceEffortForModel(effectiveModel, storedEffort) === null) {
      await updateConfigAtEffectiveScope(this.platform, "damocles", `team.${role}Effort`, "");
    }
  }

  async handleSetTeamRoleEffort(role: TeamRole, effort: EffortLevel | null): Promise<void> {
    const config = this.platform.settings;
    const roleModel = migrateLegacyModelValue(config.get<string>(`damocles.team.${role}Model`, ""));
    const effectiveModel = roleModel !== "" ? roleModel : this.workspaceFallbackModel(config);
    assertEffortSupported(effectiveModel, effort);
    await updateConfigAtEffectiveScope(this.platform, "damocles", `team.${role}Effort`, effort === null ? "" : effort);
  }

  async handleSetBudgetLimit(budgetUsd: number | null): Promise<void> {
    await updateConfigAtEffectiveScope(this.platform, "damocles", "maxBudgetUsd", budgetUsd);
  }

  async handleSetTaskBudget(budget: number | null): Promise<void> {
    await updateConfigAtEffectiveScope(this.platform, "damocles", "taskBudget", budget);
  }

  async handleSetAutoCompact(config: AutoCompactConfig): Promise<void> {
    await updateConfigAtEffectiveScope(this.platform, "damocles", "autoCompact", config);
  }

  /** Warming spends money, so the mode is user-level only and never follows the effective scope: a repo's
   *  `.vscode/settings.json` must not be able to turn billed background requests on. */
  async handleSetCacheWarming(mode: CacheWarmingMode): Promise<void> {
    await this.platform.settings.update("damocles.cacheWarming", mode, "user");
  }

  async handleSetPermissionMode(
    session: ChatSession,
    permissionHandler: PermissionHandler,
    mode: PermissionMode
  ): Promise<void> {
    permissionHandler.setPermissionMode(mode);
    await session.setPermissionMode(mode);
  }

  async handleSetDefaultPermissionMode(mode: PermissionMode): Promise<void> {
    await updateConfigAtEffectiveScope(this.platform, "damocles", "permissionMode", mode);
  }

  async handleSetDefaultDangerouslySkipPermissions(enabled: boolean): Promise<void> {
    await updateConfigAtEffectiveScope(this.platform, "damocles", "dangerouslySkipPermissions", enabled);
  }

  async handleSetIdeContextEnabled(enabled: boolean): Promise<void> {
    await updateConfigAtEffectiveScope(this.platform, "damocles", "ideContext.enabled", enabled);
  }

  handleSetDangerouslySkipPermissions(permissionHandler: PermissionHandler, enabled: boolean): void {
    permissionHandler.setDangerouslySkipPermissions(enabled);
  }
}
