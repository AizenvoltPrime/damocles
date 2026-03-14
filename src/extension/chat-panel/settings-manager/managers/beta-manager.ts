import * as vscode from "vscode";
import type { WebviewHost } from "../../types";
import type { PostMessageFn } from "../types";
import { CONTEXT_1M_BETA, modelSupports1MContext, updateConfigAtEffectiveScope } from "../utils";

export class BetaManager {
  private readonly perPanelBetas: Map<string, string[]> = new Map();
  private readonly postMessage: PostMessageFn;
  private readonly getActiveModelForPanel: (panelId: string) => string;

  constructor(postMessage: PostMessageFn, getActiveModelForPanel: (panelId: string) => string) {
    this.postMessage = postMessage;
    this.getActiveModelForPanel = getActiveModelForPanel;
  }

  private get defaultBetas(): string[] {
    return vscode.workspace.getConfiguration("damocles").get<string[]>("betasEnabled", []);
  }

  initPanelBetas(panelId: string): void {
    this.perPanelBetas.set(panelId, [...this.defaultBetas]);
  }

  cleanupPanelBetas(panelId: string): void {
    this.perPanelBetas.delete(panelId);
  }

  getActiveBetasForPanel(panelId: string): string[] {
    return this.perPanelBetas.get(panelId) ?? [...this.defaultBetas];
  }

  async toggleBetaForPanel(panelId: string, beta: string, enabled: boolean): Promise<void> {
    if (beta === CONTEXT_1M_BETA && enabled) {
      const model = this.getActiveModelForPanel(panelId);
      if (!modelSupports1MContext(model)) return;
    }

    const current = this.getActiveBetasForPanel(panelId);
    const updated = enabled
      ? (current.includes(beta) ? current : [...current, beta])
      : current.filter((b) => b !== beta);
    this.perPanelBetas.set(panelId, updated);
    await updateConfigAtEffectiveScope("damocles", "betasEnabled", updated);
  }

  sendBetasForPanel(host: WebviewHost, panelId: string): void {
    this.postMessage(host, {
      type: "betaUpdate",
      activeBetas: this.getActiveBetasForPanel(panelId),
    });
  }

  async handleModelBetaCleanupForPanel(panelId: string): Promise<void> {
    const model = this.getActiveModelForPanel(panelId);
    if (modelSupports1MContext(model)) return;

    const current = this.perPanelBetas.get(panelId);
    if (current?.includes(CONTEXT_1M_BETA)) {
      const updated = current.filter((b) => b !== CONTEXT_1M_BETA);
      this.perPanelBetas.set(panelId, updated);
      await updateConfigAtEffectiveScope("damocles", "betasEnabled", updated);
    }
  }
}
