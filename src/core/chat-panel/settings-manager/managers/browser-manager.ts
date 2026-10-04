import type { Disposable } from "../../../../platform/disposable";
import type { Platform } from "../../../../platform/platform";
import { updateConfigAtEffectiveScope, type SettingWrite } from "../utils";

export class BrowserManager {
  private enabled = false;
  private configListener: Disposable | null = null;
  private readonly platform: Platform;

  constructor(platform: Platform) {
    this.platform = platform;
  }

  loadState(): void {
    this.enabled = this.platform.settings.get<boolean>("damocles.browser.enabled", false);
    this.configListener ??= this.platform.settings.onDidChange("damocles.browser.enabled", () => {
      this.enabled = this.platform.settings.get<boolean>("damocles.browser.enabled", false);
    });
  }

  dispose(): void {
    this.configListener?.dispose();
    this.configListener = null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async setEnabled(enabled: boolean): Promise<SettingWrite> {
    this.enabled = enabled;
    return updateConfigAtEffectiveScope(this.platform, "damocles.browser.enabled", enabled);
  }
}
