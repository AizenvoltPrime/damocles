import * as vscode from "vscode";
import type { WebviewHost } from "../../types";
import type { PostMessageFn } from "../types";
import { updateConfigAtEffectiveScope } from "../utils";

const DEFAULT_MODEL = "claude-opus-4-6";

export class ModelManager {
  private defaultModel: string = "";
  private readonly perPanelModel: Map<string, string> = new Map();
  private readonly postMessage: PostMessageFn;

  constructor(postMessage: PostMessageFn) {
    this.postMessage = postMessage;
    this.defaultModel = vscode.workspace.getConfiguration("damocles").get<string>("model", "");
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
    this.postMessage(host, {
      type: "modelUpdate",
      activeModel: this.getActiveModelForPanel(panelId),
      defaultModel: this.defaultModel || DEFAULT_MODEL,
    });
  }
}
