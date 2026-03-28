import * as vscode from "vscode";
import type { ClaudeSession } from "../../../claude-session";
import type { PermissionHandler } from "../../../permission-handler";
import type { WebviewHost } from "../../types";
import type { ExtensionSettings, PermissionMode, AutoCompactConfig, EffortLevel } from "../../../../shared/types/settings";
import type { PostMessageFn } from "../types";
import { updateConfigAtEffectiveScope } from "../utils";

export class ConfigManager {
  private readonly postMessage: PostMessageFn;
  private _getFastMode: () => boolean = () => false;

  constructor(postMessage: PostMessageFn) {
    this.postMessage = postMessage;
  }

  setFastModeGetter(getter: () => boolean): void {
    this._getFastMode = getter;
  }

  async sendCurrentSettings(host: WebviewHost, permissionHandler: PermissionHandler): Promise<void> {
    const config = vscode.workspace.getConfiguration("damocles");

    const defaultAutoCompact: AutoCompactConfig = {
      enabled: true,
      warningThreshold: 60,
      softThreshold: 70,
      hardThreshold: 75,
    };

    const settings: ExtensionSettings = {
      maxTurns: config.get<number>("maxTurns", 100),
      maxBudgetUsd: config.get<number | null>("maxBudgetUsd", null),
      taskBudget: config.get<number | null>("taskBudget", null),
      maxThinkingTokens: config.get<number | null>("maxThinkingTokens", null),
      thinkingDisabled: config.get<boolean>("thinkingDisabled", false),
      effort: config.get<string | null>("effort", null) as EffortLevel | null,
      permissionMode: permissionHandler.getPermissionMode(),
      defaultPermissionMode: config.get<PermissionMode>("permissionMode", "default"),
      enableFileCheckpointing: config.get<boolean>("enableFileCheckpointing", true),
      sandbox: config.get<{ enabled: boolean }>("sandbox", { enabled: false }),
      autoCompact: config.get<AutoCompactConfig>("autoCompact", defaultAutoCompact),
      dangerouslySkipPermissions: permissionHandler.getDangerouslySkipPermissions(),
      fastMode: this._getFastMode(),
    };
    this.postMessage(host, { type: "settingsUpdate", settings });
  }

  async sendAvailableModels(session: ClaudeSession, host: WebviewHost): Promise<void> {
    const models = await session.getSupportedModels();
    if (models && models.length > 0) {
      this.postMessage(host, { type: "availableModels", models });
    }
  }

  async sendSupportedCommands(session: ClaudeSession, host: WebviewHost): Promise<void> {
    const commands = await session.getSupportedCommands();
    if (commands) {
      this.postMessage(host, { type: "supportedCommands", commands });
    }
  }

  async handleSetMaxThinkingTokens(tokens: number | null): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "maxThinkingTokens", tokens);
  }

  async handleSetThinkingDisabled(disabled: boolean): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "thinkingDisabled", disabled);
  }

  async handleSetEffort(effort: EffortLevel | null): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "effort", effort);
  }

  async handleSetBudgetLimit(budgetUsd: number | null): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "maxBudgetUsd", budgetUsd);
  }

  async handleSetTaskBudget(budget: number | null): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "taskBudget", budget);
  }

  async handleSetPermissionMode(
    session: ClaudeSession,
    permissionHandler: PermissionHandler,
    mode: PermissionMode
  ): Promise<void> {
    permissionHandler.setPermissionMode(mode);
    await session.setPermissionMode(mode);
  }

  async handleSetDefaultPermissionMode(mode: PermissionMode): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "permissionMode", mode);
  }

  handleSetDangerouslySkipPermissions(permissionHandler: PermissionHandler, enabled: boolean): void {
    permissionHandler.setDangerouslySkipPermissions(enabled);
  }

  handleSetFastMode(session: ClaudeSession, enabled: boolean): void {
    session.setFastMode(enabled);
  }
}
