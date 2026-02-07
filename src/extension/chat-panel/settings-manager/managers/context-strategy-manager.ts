import * as vscode from "vscode";
import type { ContextStrategy } from "../../../../shared/types/settings";
import type { WebviewHost } from "../../types";
import type { PostMessageFn } from "../types";
import { updateConfigAtEffectiveScope } from "../utils";

export class ContextStrategyManager {
  private defaultStrategy: ContextStrategy;
  private readonly perPanelStrategy: Map<string, ContextStrategy> = new Map();
  private readonly postMessage: PostMessageFn;

  constructor(postMessage: PostMessageFn) {
    this.postMessage = postMessage;
    this.defaultStrategy = vscode.workspace
      .getConfiguration("damocles")
      .get<ContextStrategy>("contextStrategy", "default");
  }

  initPanelStrategy(panelId: string): void {
    this.perPanelStrategy.set(panelId, this.defaultStrategy);
  }

  cleanupPanelStrategy(panelId: string): void {
    this.perPanelStrategy.delete(panelId);
  }

  getActiveStrategyForPanel(panelId: string): ContextStrategy {
    return this.perPanelStrategy.get(panelId) ?? this.defaultStrategy;
  }

  setActiveStrategyForPanel(panelId: string, strategy: ContextStrategy): boolean {
    if (strategy === this.getActiveStrategyForPanel(panelId)) {
      return false;
    }
    this.perPanelStrategy.set(panelId, strategy);
    return true;
  }

  async setDefaultStrategy(strategy: ContextStrategy): Promise<void> {
    this.defaultStrategy = strategy;
    await updateConfigAtEffectiveScope("damocles", "contextStrategy", strategy);
  }

  sendStrategyForPanel(host: WebviewHost, panelId: string): void {
    this.postMessage(host, {
      type: "contextStrategyUpdate",
      activeStrategy: this.getActiveStrategyForPanel(panelId),
      defaultStrategy: this.defaultStrategy,
    });
  }
}
