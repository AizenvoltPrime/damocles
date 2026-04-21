import * as vscode from "vscode";
import type { ClaudeSession } from "../../../claude-session";
import type { PermissionHandler } from "../../../permission-handler";
import type { WebviewHost } from "../../types";
import type { ExtensionSettings, PermissionMode, AutoCompactConfig, EffortLevel } from "../../../../shared/types/settings";
import type { PostMessageFn } from "../types";
import { updateConfigAtEffectiveScope } from "../utils";
import { DEFAULT_MODELS } from "../../../../shared/types/constants";

/**
 * Resolve the effective effort level for a model from the per-model override map.
 * Returns `null` when no entry exists or the stored value is no longer supported
 * by the model (capability regressions can't leak into SDK options).
 */
export function resolveEffortForModel(
  config: vscode.WorkspaceConfiguration,
  activeModel: string,
): EffortLevel | null {
  const map = config.get<Record<string, EffortLevel | null>>("effortByModel", {}) ?? {};
  const raw = map[activeModel] ?? null;
  if (!raw) return null;
  const modelInfo = DEFAULT_MODELS.find(m => m.value === activeModel);
  if (!modelInfo?.supportedEffortLevels?.includes(raw)) return null;
  return raw;
}

export class ConfigManager {
  private readonly postMessage: PostMessageFn;
  private _getFastMode: () => boolean = () => false;

  constructor(postMessage: PostMessageFn) {
    this.postMessage = postMessage;
  }

  setFastModeGetter(getter: () => boolean): void {
    this._getFastMode = getter;
  }

  async sendCurrentSettings(
    host: WebviewHost,
    permissionHandler: PermissionHandler,
    activeModel: string,
  ): Promise<void> {
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
      effort: resolveEffortForModel(config, activeModel),
      permissionMode: permissionHandler.getPermissionMode(),
      defaultPermissionMode: config.get<PermissionMode>("permissionMode", "default"),
      enableFileCheckpointing: config.get<boolean>("enableFileCheckpointing", true),
      sandbox: config.get<{ enabled: boolean }>("sandbox", { enabled: false }),
      autoCompact: config.get<AutoCompactConfig>("autoCompact", defaultAutoCompact),
      dangerouslySkipPermissions: permissionHandler.getDangerouslySkipPermissions(),
      fastMode: this._getFastMode(),
      pinnedHeaderHidden: config.get<boolean>("pinnedHeaderHidden", false),
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

  async handleSetPinnedHeaderHidden(hidden: boolean): Promise<void> {
    await vscode.workspace.getConfiguration("damocles").update(
      "pinnedHeaderHidden",
      hidden,
      vscode.ConfigurationTarget.Global,
    );
  }

  async handleSetEffort(effort: EffortLevel | null, activeModel: string): Promise<void> {
    if (effort !== null) {
      const modelInfo = DEFAULT_MODELS.find(m => m.value === activeModel);
      if (!modelInfo?.supportedEffortLevels?.includes(effort)) {
        throw new Error(`Effort "${effort}" is not supported by model "${activeModel}"`);
      }
    }
    const config = vscode.workspace.getConfiguration("damocles");
    const current = config.get<Record<string, EffortLevel | null>>("effortByModel", {}) ?? {};
    const next: Record<string, EffortLevel | null> = { ...current };
    if (effort === null) {
      delete next[activeModel];
    } else {
      next[activeModel] = effort;
    }
    await updateConfigAtEffectiveScope("damocles", "effortByModel", next);
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
