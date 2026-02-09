import * as vscode from "vscode";
import type { ContextStrategy } from "../../../../shared/types/settings";
import type { DistillationConfig } from "../../../context-distillation/types";
import { DEFAULT_OBSERVER_MODEL, DEFAULT_TOKEN_BUDGET } from "../../../context-distillation";
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

  getDistillTokenBudget(): number {
    return vscode.workspace
      .getConfiguration("damocles")
      .get<number>("distillTokenBudget", DEFAULT_TOKEN_BUDGET);
  }

  async setDistillTokenBudget(value: number): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "distillTokenBudget", value);
  }

  buildDistillConfig(panelId: string): DistillationConfig {
    const strategy = this.getActiveStrategyForPanel(panelId);
    return {
      enabled: strategy === "distill",
      observerModel: DEFAULT_OBSERVER_MODEL,
      tokenBudget: this.getDistillTokenBudget(),
    };
  }

  sendStrategyForPanel(host: WebviewHost, panelId: string): void {
    this.postMessage(host, {
      type: "contextStrategyUpdate",
      activeStrategy: this.getActiveStrategyForPanel(panelId),
      defaultStrategy: this.defaultStrategy,
      distillTokenBudget: this.getDistillTokenBudget(),
    });
  }
}
