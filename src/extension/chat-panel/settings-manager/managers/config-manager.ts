import * as vscode from "vscode";
import type { ClaudeSession } from "../../../claude-session";
import type { PermissionHandler } from "../../../permission-handler";
import type { ExtensionSettings, PermissionMode, ContextStrategy, AutoCompactConfig } from "../../../../shared/types/settings";
import type { PostMessageFn } from "../types";
import { updateConfigAtEffectiveScope, CONTEXT_1M_BETA, modelSupports1MContext } from "../utils";

export class ConfigManager {
  private readonly postMessage: PostMessageFn;

  constructor(postMessage: PostMessageFn) {
    this.postMessage = postMessage;
  }

  async sendCurrentSettings(panel: vscode.WebviewPanel, permissionHandler: PermissionHandler): Promise<void> {
    const config = vscode.workspace.getConfiguration("damocles");
    const model = config.get<string>("model", "");
    const betasEnabled = config.get<string[]>("betasEnabled", []);

    const effectiveBetas = betasEnabled.filter(beta => {
      if (beta === CONTEXT_1M_BETA && !modelSupports1MContext(model)) {
        return false;
      }
      return true;
    });

    const defaultAutoCompact: AutoCompactConfig = {
      enabled: true,
      warningThreshold: 60,
      softThreshold: 70,
      hardThreshold: 75,
    };

    const settings: ExtensionSettings = {
      model,
      maxTurns: config.get<number>("maxTurns", 100),
      maxBudgetUsd: config.get<number | null>("maxBudgetUsd", null),
      maxThinkingTokens: config.get<number | null>("maxThinkingTokens", null),
      betasEnabled: effectiveBetas,
      permissionMode: permissionHandler.getPermissionMode(),
      defaultPermissionMode: config.get<PermissionMode>("permissionMode", "default"),
      enableFileCheckpointing: config.get<boolean>("enableFileCheckpointing", true),
      sandbox: config.get<{ enabled: boolean }>("sandbox", { enabled: false }),
      autoCompact: config.get<AutoCompactConfig>("autoCompact", defaultAutoCompact),
      dangerouslySkipPermissions: permissionHandler.getDangerouslySkipPermissions(),
      contextStrategy: config.get<ContextStrategy>("contextStrategy", "default"),
    };
    this.postMessage(panel, { type: "settingsUpdate", settings });
  }

  async sendAvailableModels(session: ClaudeSession, panel: vscode.WebviewPanel): Promise<void> {
    const models = await session.getSupportedModels();
    if (models && models.length > 0) {
      this.postMessage(panel, { type: "availableModels", models });
    }
  }

  async sendSupportedCommands(session: ClaudeSession, panel: vscode.WebviewPanel): Promise<void> {
    const commands = await session.getSupportedCommands();
    if (commands) {
      this.postMessage(panel, { type: "supportedCommands", commands });
    }
  }

  async handleSetModel(session: ClaudeSession, model: string): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "model", model);

    if (!modelSupports1MContext(model)) {
      const config = vscode.workspace.getConfiguration("damocles");
      const currentBetas = config.get<string[]>("betasEnabled", []);
      if (currentBetas.includes(CONTEXT_1M_BETA)) {
        const newBetas = currentBetas.filter(b => b !== CONTEXT_1M_BETA);
        await updateConfigAtEffectiveScope("damocles", "betasEnabled", newBetas);
      }
    }

    await session.setModel(model);
  }

  async handleSetMaxThinkingTokens(session: ClaudeSession, tokens: number | null): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "maxThinkingTokens", tokens);
    await session.setMaxThinkingTokens(tokens);
  }

  async handleSetBudgetLimit(budgetUsd: number | null): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "maxBudgetUsd", budgetUsd);
  }

  async handleToggleBeta(beta: string, enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration("damocles");
    const currentBetas = config.get<string[]>("betasEnabled", []);

    if (beta === CONTEXT_1M_BETA && enabled) {
      const model = config.get<string>("model", "");
      if (!modelSupports1MContext(model)) {
        return;
      }
    }

    const newBetas = enabled
      ? (currentBetas.includes(beta) ? currentBetas : [...currentBetas, beta])
      : currentBetas.filter((b) => b !== beta);
    await updateConfigAtEffectiveScope("damocles", "betasEnabled", newBetas);
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

  async handleSetContextStrategy(strategy: ContextStrategy): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "contextStrategy", strategy);
  }

  handleSetDangerouslySkipPermissions(permissionHandler: PermissionHandler, enabled: boolean): void {
    permissionHandler.setDangerouslySkipPermissions(enabled);
  }
}
