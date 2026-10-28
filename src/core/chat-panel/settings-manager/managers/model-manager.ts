import type { Disposable } from "../../../../platform/disposable";
import type { Platform } from "../../../../platform/platform";
import type { SettingsChange } from "../../../../platform/settings-store";
import type { PanelHost } from "../../../../platform/window-service";
import type { PostMessageFn } from "../types";
import { updateConfigAtEffectiveScope, getContextWindowForModel, type SettingWrite } from "../utils";
import { forEachDevice } from "../../device-hosts";
import { DEFAULT_FALLBACK_MODEL as DEFAULT_MODEL, migrateLegacyModelValue } from "../../../../shared/types/constants";

export class ModelManager {
  // a daemon's core reads the default per call, since each client's user layer holds its own
  private defaultModel: string = "";
  private readonly perPanelModel: Map<string, string> = new Map();
  /** The model the panel's session shows, which differs from the held one only while it shows the factory default it has not committed. */
  private readonly perPanelShownModel: Map<string, string> = new Map();
  private readonly perPanelContextWindow: Map<string, number> = new Map();
  private readonly postMessage: PostMessageFn;
  private readonly configListener: Disposable;
  private readonly platform: Platform;
  private onDefaultModelChanged: ((change: SettingsChange) => void) | null = null;

  constructor(postMessage: PostMessageFn, platform: Platform) {
    this.postMessage = postMessage;
    this.platform = platform;
    this.defaultModel = this.readDefaultModel();
    this.configListener = platform.settings.onDidChange("damocles.model", (change) => {
      if (!this.platform.remote) {
        const next = this.readDefaultModel();
        if (next === this.defaultModel) return;
        this.defaultModel = next;
      }
      this.onDefaultModelChanged?.(change);
    });
  }

  dispose(): void {
    this.configListener.dispose();
  }

  private readDefaultModel(): string {
    return migrateLegacyModelValue(this.platform.settings.get<string>("damocles.model", ""));
  }

  /** The configured default, on a daemon's core the pinned (else acting) client's. */
  private configuredDefault(): string {
    return this.platform.remote ? this.readDefaultModel() : this.defaultModel;
  }

  /** Fires when `damocles.model` is mutated externally (VS Code Settings UI, settings.json edit). */
  setOnDefaultModelChanged(callback: (change: SettingsChange) => void): void {
    this.onDefaultModelChanged = callback;
  }

  initPanelModel(panelId: string): void {
    this.perPanelModel.set(panelId, this.configuredDefault());
  }

  cleanupPanelModel(panelId: string): void {
    this.perPanelModel.delete(panelId);
    this.perPanelShownModel.delete(panelId);
    this.perPanelContextWindow.delete(panelId);
  }

  getActiveModelForPanel(panelId: string): string {
    return this.perPanelShownModel.get(panelId) ?? this.getConfiguredModelForPanel(panelId) ?? DEFAULT_MODEL;
  }

  /** The panel's model or the configured default; undefined while the chat holds none and `damocles.model` is unset. */
  getConfiguredModelForPanel(panelId: string): string | undefined {
    return this.perPanelModel.get(panelId) || this.configuredDefault() || undefined;
  }

  getDefaultModel(): string {
    return this.configuredDefault() || DEFAULT_MODEL;
  }

  /** The adopted model's window; the static table applies only until the session adopts a model. */
  setContextWindowForPanel(panelId: string, contextWindow: number): void {
    this.perPanelContextWindow.set(panelId, contextWindow);
  }

  setActiveModelForPanel(panelId: string, model: string): boolean {
    if (model === this.getActiveModelForPanel(panelId)) {
      return false;
    }
    this.perPanelModel.set(panelId, model);
    return true;
  }

  /** Only a committed model is held, even one equal to the default, so a later session starts on it; a factory default only shown stays unheld. */
  adoptPanelModel(panelId: string, model: string, committed: boolean): void {
    this.perPanelShownModel.set(panelId, model);
    if (committed) this.perPanelModel.set(panelId, model);
  }

  async setDefaultModel(model: string): Promise<SettingWrite> {
    this.defaultModel = model;
    return updateConfigAtEffectiveScope(this.platform, "damocles.model", model);
  }

  sendModelForPanel(host: PanelHost, panelId: string): void {
    forEachDevice(this.platform.remote, host, (target) => {
      const activeModel = this.getActiveModelForPanel(panelId);
      this.postMessage(target, {
        type: "modelUpdate",
        activeModel,
        defaultModel: this.getDefaultModel(),
        contextWindowSize: this.perPanelContextWindow.get(panelId) ?? getContextWindowForModel(activeModel),
      });
    });
  }
}
