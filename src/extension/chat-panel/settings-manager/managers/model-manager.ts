import * as vscode from "vscode";
import type { WebviewHost } from "../../types";
import type { PostMessageFn } from "../types";
import { updateConfigAtEffectiveScope, getContextWindowForModel } from "../utils";
import { DEFAULT_FALLBACK_MODEL as DEFAULT_MODEL } from "../../../../shared/types/constants";

export class ModelManager {
  private defaultModel: string = "";
  private readonly perPanelModel: Map<string, string> = new Map();
  private readonly postMessage: PostMessageFn;
  private readonly configListener: vscode.Disposable;
  private getBetasForPanel: ((panelId: string) => string[]) | null = null;
  private onDefaultModelChanged: (() => void) | null = null;

  constructor(postMessage: PostMessageFn) {
    this.postMessage = postMessage;
    this.defaultModel = vscode.workspace.getConfiguration("damocles").get<string>("model", "");
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("damocles.model")) return;
      const next = vscode.workspace.getConfiguration("damocles").get<string>("model", "");
      if (next === this.defaultModel) return;
      this.defaultModel = next;
      this.onDefaultModelChanged?.();
    });
  }

  dispose(): void {
    this.configListener.dispose();
  }

  setBetasGetter(getter: (panelId: string) => string[]): void {
    this.getBetasForPanel = getter;
  }

  /** Fires when `damocles.model` is mutated externally (VS Code Settings UI, settings.json edit). */
  setOnDefaultModelChanged(callback: () => void): void {
    this.onDefaultModelChanged = callback;
  }

  initPanelModel(panelId: string): void {
    this.perPanelModel.set(panelId, this.defaultModel);
  }

  cleanupPanelModel(panelId: string): void {
    this.perPanelModel.delete(panelId);
  }

  getActiveModelForPanel(panelId: string): string {
    return this.perPanelModel.get(panelId) || this.defaultModel || DEFAULT_MODEL;
  }

  getDefaultModel(): string {
    return this.defaultModel || DEFAULT_MODEL;
  }

  setActiveModelForPanel(panelId: string, model: string): boolean {
    if (model === this.getActiveModelForPanel(panelId)) {
      return false;
    }
    this.perPanelModel.set(panelId, model);
    return true;
  }

  async setDefaultModel(model: string): Promise<void> {
    this.defaultModel = model;
    await updateConfigAtEffectiveScope("damocles", "model", model);
  }

  sendModelForPanel(host: WebviewHost, panelId: string): void {
    const activeModel = this.getActiveModelForPanel(panelId);
    const betas = this.getBetasForPanel?.(panelId) ?? [];
    this.postMessage(host, {
      type: "modelUpdate",
      activeModel,
      defaultModel: this.defaultModel || DEFAULT_MODEL,
      contextWindowSize: getContextWindowForModel(activeModel, betas),
    });
  }
}
