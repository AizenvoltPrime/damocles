import type { Disposable } from "../../../../platform/disposable";
import type { Platform } from "../../../../platform/platform";
import type { PanelHost } from "../../../../platform/window-service";
import type { PostMessageFn } from "../types";
import { updateConfigAtEffectiveScope, getContextWindowForModel } from "../utils";
import { DEFAULT_FALLBACK_MODEL as DEFAULT_MODEL, migrateLegacyModelValue } from "../../../../shared/types/constants";

export class ModelManager {
  private defaultModel: string = "";
  private readonly perPanelModel: Map<string, string> = new Map();
  private readonly postMessage: PostMessageFn;
  private readonly configListener: Disposable;
  private readonly platform: Platform;
  private onDefaultModelChanged: (() => void) | null = null;

  constructor(postMessage: PostMessageFn, platform: Platform) {
    this.postMessage = postMessage;
    this.platform = platform;
    this.defaultModel = migrateLegacyModelValue(this.platform.settings.get<string>("damocles.model", ""));
    this.configListener = platform.settings.onDidChange("damocles.model", () => {
      const next = migrateLegacyModelValue(this.platform.settings.get<string>("damocles.model", ""));
      if (next === this.defaultModel) return;
      this.defaultModel = next;
      this.onDefaultModelChanged?.();
    });
  }

  dispose(): void {
    this.configListener.dispose();
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
    await updateConfigAtEffectiveScope(this.platform, "damocles", "model", model);
  }

  sendModelForPanel(host: PanelHost, panelId: string): void {
    const activeModel = this.getActiveModelForPanel(panelId);
    this.postMessage(host, {
      type: "modelUpdate",
      activeModel,
      defaultModel: this.defaultModel || DEFAULT_MODEL,
      contextWindowSize: getContextWindowForModel(activeModel),
    });
  }
}
