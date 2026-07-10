import * as vscode from "vscode";
import type { ChatSession } from "../../../chat-session";
import type { PermissionHandler } from "../../../permission-handler";
import type { WebviewHost } from "../../types";
import type { ExtensionSettings, PermissionMode, AutoCompactConfig, EffortLevel, TeamRoleSettings } from "../../../../shared/types/settings";
import type { PostMessageFn } from "../types";
import { updateConfigAtEffectiveScope, assertEffortSupported, coerceEffortForModel } from "../utils";
import { migrateLegacyModelValue, migrateLegacyEffortValue, parseEffortLevel, DEFAULT_MODELS, DEFAULT_FALLBACK_MODEL } from "../../../../shared/types/constants";
import type { TeamRole } from "../../../pi-session/team-model-resolution";

export class ConfigManager {
  private readonly postMessage: PostMessageFn;

  constructor(postMessage: PostMessageFn) {
    this.postMessage = postMessage;
  }

  /**
   * The model an unset team role slot validates its effort against: the workspace default model, or
   * `DEFAULT_FALLBACK_MODEL` when that is empty (fresh install). This mirrors the runtime resolver, which
   * fails soft to the active panel model (ultimately the default) — so validating against `''` (which
   * has no `supportedEffortLevels` and makes `assertEffortSupported` throw) is never correct.
   */
  private workspaceFallbackModel(config: vscode.WorkspaceConfiguration): string {
    return migrateLegacyModelValue(config.get<string>("model", "")) || DEFAULT_FALLBACK_MODEL;
  }

  async sendCurrentSettings(
    host: WebviewHost,
    permissionHandler: PermissionHandler,
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration("damocles");

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
      const model = migrateLegacyModelValue(config.get<string>(`team.${role}Model`, ""));
      const parsed = parseEffortLevel(config.get<string>(`team.${role}Effort`, ""));
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
      maxTurns: config.get<number>("maxTurns", 100),
      maxBudgetUsd: config.get<number | null>("maxBudgetUsd", null),
      taskBudget: config.get<number | null>("taskBudget", null),
      permissionMode: permissionHandler.getPermissionMode(),
      defaultPermissionMode: config.get<PermissionMode>("permissionMode", "default"),
      enableFileCheckpointing: config.get<boolean>("enableFileCheckpointing", true),
      sandbox: config.get<{ enabled: boolean }>("sandbox", { enabled: false }),
      autoCompact: config.get<AutoCompactConfig>("autoCompact", defaultAutoCompact),
      dangerouslySkipPermissions: permissionHandler.getDangerouslySkipPermissions(),
      defaultDangerouslySkipPermissions: config.get<boolean>("dangerouslySkipPermissions", false),
      ideContextEnabled: config.get<boolean>("ideContext.enabled", true),
      pinnedHeaderHidden: config.get<boolean>("pinnedHeaderHidden", false),
      worktreeBaseRef: config.get<'fresh' | 'head'>("worktreeBaseRef", "head"),
      team,
    };
    this.postMessage(host, { type: "settingsUpdate", settings });
  }

  async sendAvailableModels(session: ChatSession, host: WebviewHost): Promise<void> {
    const models = await session.getSupportedModels();
    if (models && models.length > 0) {
      this.postMessage(host, { type: "availableModels", models });
    }
  }

  async sendSupportedCommands(session: ChatSession, host: WebviewHost): Promise<void> {
    const commands = await session.getSupportedCommands();
    if (commands) {
      this.postMessage(host, { type: "supportedCommands", commands });
    }
  }

  async handleSetDefaultMaxThinkingTokens(tokens: number | null): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "maxThinkingTokens", tokens);
  }

  async handleSetDefaultThinkingDisabled(disabled: boolean): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "thinkingDisabled", disabled);
  }

  async handleSetPinnedHeaderHidden(hidden: boolean): Promise<void> {
    await vscode.workspace.getConfiguration("damocles").update(
      "pinnedHeaderHidden",
      hidden,
      vscode.ConfigurationTarget.Global,
    );
  }

  async handleSetDefaultEffort(effort: EffortLevel | null, model: string): Promise<void> {
    assertEffortSupported(model, effort);
    const config = vscode.workspace.getConfiguration("damocles");
    const current = config.get<Record<string, EffortLevel | null>>("effortByModel", {}) ?? {};
    const next: Record<string, EffortLevel | null> = { ...current };
    if (effort === null) {
      delete next[model];
    } else {
      next[model] = effort;
    }
    await updateConfigAtEffectiveScope("damocles", "effortByModel", next);
  }

  async handleSetTeamRoleModel(role: TeamRole, model: string): Promise<void> {
    if (model !== '' && !DEFAULT_MODELS.some(m => m.value === model)) {
      throw new Error(`Model "${model}" is not a known model`);
    }
    await updateConfigAtEffectiveScope("damocles", `team.${role}Model`, model);

    // Reconcile the sibling effort: if the newly-selected model no longer supports
    // the stored effort, clear it so the persisted pair stays valid.
    const config = vscode.workspace.getConfiguration("damocles");
    const storedEffort = parseEffortLevel(config.get<string>(`team.${role}Effort`, ""));
    const effectiveModel = model !== "" ? model : this.workspaceFallbackModel(config);
    if (storedEffort !== null && coerceEffortForModel(effectiveModel, storedEffort) === null) {
      await updateConfigAtEffectiveScope("damocles", `team.${role}Effort`, "");
    }
  }

  async handleSetTeamRoleEffort(role: TeamRole, effort: EffortLevel | null): Promise<void> {
    const config = vscode.workspace.getConfiguration("damocles");
    const roleModel = migrateLegacyModelValue(config.get<string>(`team.${role}Model`, ""));
    const effectiveModel = roleModel !== "" ? roleModel : this.workspaceFallbackModel(config);
    assertEffortSupported(effectiveModel, effort);
    await updateConfigAtEffectiveScope("damocles", `team.${role}Effort`, effort === null ? "" : effort);
  }

  async handleSetBudgetLimit(budgetUsd: number | null): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "maxBudgetUsd", budgetUsd);
  }

  async handleSetTaskBudget(budget: number | null): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "taskBudget", budget);
  }

  async handleSetAutoCompact(config: AutoCompactConfig): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "autoCompact", config);
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
    await updateConfigAtEffectiveScope("damocles", "permissionMode", mode);
  }

  async handleSetWorktreeBaseRef(baseRef: 'fresh' | 'head'): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "worktreeBaseRef", baseRef);
  }

  async handleSetDefaultDangerouslySkipPermissions(enabled: boolean): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "dangerouslySkipPermissions", enabled);
  }

  async handleSetIdeContextEnabled(enabled: boolean): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "ideContext.enabled", enabled);
  }

  handleSetDangerouslySkipPermissions(permissionHandler: PermissionHandler, enabled: boolean): void {
    permissionHandler.setDangerouslySkipPermissions(enabled);
  }
}
