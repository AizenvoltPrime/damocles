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

  private filterByModelCapability(panelId: string, betas: string[]): string[] {
    const model = this.getActiveModelForPanel(panelId);
    if (!modelSupports1MContext(model)) {
      return betas.filter(b => b !== CONTEXT_1M_BETA);
    }
    return betas;
  }

  initPanelBetas(panelId: string): void {
    this.perPanelBetas.set(panelId, [...this.defaultBetas]);
  }

  cleanupPanelBetas(panelId: string): void {
    this.perPanelBetas.delete(panelId);
  }

  getActiveBetasForPanel(panelId: string): string[] {
    const raw = this.perPanelBetas.get(panelId) ?? [...this.defaultBetas];
    return this.filterByModelCapability(panelId, raw);
  }

  setActiveBetasForPanel(panelId: string, betas: string[]): void {
    this.perPanelBetas.set(panelId, [...betas]);
  }

  async toggleBetaForPanel(panelId: string, beta: string, enabled: boolean): Promise<void> {
    if (beta === CONTEXT_1M_BETA && enabled) {
      const model = this.getActiveModelForPanel(panelId);
      if (!modelSupports1MContext(model)) return;
    }

    const raw = this.perPanelBetas.get(panelId) ?? [...this.defaultBetas];
    const updated = enabled
      ? (raw.includes(beta) ? raw : [...raw, beta])
      : raw.filter((b) => b !== beta);
    this.perPanelBetas.set(panelId, updated);
    await updateConfigAtEffectiveScope("damocles", "betasEnabled", updated);
  }

  sendBetasForPanel(host: WebviewHost, panelId: string): void {
    this.postMessage(host, {
      type: "betaUpdate",
      activeBetas: this.getActiveBetasForPanel(panelId),
    });
  }
}
